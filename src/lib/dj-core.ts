import SpotifyWebApi from 'spotify-web-api-js';
import { AIService } from './ai';
import { STORAGE_KEYS, PLAYBACK_CONSTANTS, DEFAULTS } from './constants';
import {
    AIProvider,
    DJConfig,
    DJErrorListener,
    DJLogListener,
    DJStateListener,
    DJStateSnapshot,
    ScheduleItem,
    SearchPipelineContext,
    SpotifyApiErrorInfo,
    SpotifyControlResult,
    Track,
} from './types';
import { getStorageItem, setStorageItem, removeStorageItem, getStoredJSON, setStoredJSON } from './storage';
import {
    generateTrackKey,
    isScheduleItemActive,
    getScheduleItemSignature,
    getScheduleItemQueries,
    parseTimeToMinutes,
    findActiveScheduleItem,
    findStrictlyActiveScheduleItem,
    isWaitingForScheduleStart,
    resolveEffectiveScheduleItem,
} from './dj-utils';
import { TrackSessionCache } from './track-session-cache';
import { SpotifyPlayerClient } from './spotify-player-client';
import { TrackSearchPipeline } from './track-search-pipeline';

export type { Track };

function isExplicitFutureScheduleRequest(instruction: string, normalizedStart: string, forwardDiff: number): boolean {
    const mins = parseTimeToMinutes(normalizedStart);
    const h24 = Math.floor(mins / 60);
    const m = mins % 60;
    const h12 = h24 % 12 || 12;
    const mm = String(m).padStart(2, '0');

    const normalizedInput = instruction
        .replace(/[０-９：]/g, (ch) =>
            ch === '：' ? ':' : String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
        )
        .toLowerCase();

    const patterns = [
        normalizedStart.toLowerCase(),
        `${h24}:${mm}`,
        `${h12}:${mm}`,
        `${h24}時`,
        `${h12}時`,
        `${h12}pm`,
        `${h12} pm`,
        `${h12}am`,
        `${h12} am`,
    ];
    if (patterns.some(p => normalizedInput.includes(p))) {
        return true;
    }

    if (forwardDiff > 15) {
        if (/(?:今夜|今晩|深夜|夜遅く|明日|あとで|後で)/.test(normalizedInput)) {
            return true;
        }
        if (/\b(?:tonight|this evening|late night|tomorrow|later)\b/i.test(normalizedInput)) {
            return true;
        }
    }

    return false;
}

export class DJCore {
    private spotify: SpotifyWebApi.SpotifyWebApiJs;
    private playerClient: SpotifyPlayerClient;
    private sessionCache: TrackSessionCache;
    private searchPipeline: TrackSearchPipeline;
    private ai?: AIService;
    private schedule: ScheduleItem[] = [];
    private processLog: string[] = [];
    private statusText: string = 'Ready';
    private lastError: string | null = null;
    private lastQuery: string | null = null;
    private config: DJConfig = {
        minPopularity: PLAYBACK_CONSTANTS.PREFERRED_TRACK_POPULARITY,
        trackSearchLimit: PLAYBACK_CONSTANTS.TRACK_SEARCH_LIMIT,
        onlyOfficial: false,
        aiFiltering: true
    };
    private onStatusUpdate?: (status: string) => void;
    private onTracksPlayed?: (tracks: Track[]) => void;
    private onErrorUpdate?: DJErrorListener;
    private stateListeners = new Set<DJStateListener>();
    private logListeners = new Set<DJLogListener>();
    private errorListeners = new Set<DJErrorListener>();

    private activeLoopCount = 0;
    private playbackGeneration = 0;
    private isRefilling = false;
    private lastRefillAttemptTime = 0;
    private preloadedResult: { signature: string; tracks: Track[] } | null = null;
    private inFlightPreload: { signature: string; generation: number; promise: Promise<Track[]> } | null = null;
    private preloadGeneration = 0;
    private lastStartFailure: {
        signature: string;
        timestamp: number;
        category?: SpotifyApiErrorInfo['category'];
        retryAfterMs: number;
        cachedTracks: Track[];
    } | null = null;
    private lastKnownIsPlaying: boolean | null = null;

    constructor(accessToken: string) {
        this.spotify = new SpotifyWebApi();
        this.spotify.setAccessToken(accessToken);
        this.sessionCache = new TrackSessionCache();
        this.playerClient = new SpotifyPlayerClient(this.spotify, (errInfo) => {
            this.handleSpotifyApiError(errInfo);
        });
        this.searchPipeline = new TrackSearchPipeline({
            getSpotify: () => this.spotify,
            getAI: () => this.ai,
            getConfig: () => this.config,
            sessionCache: this.sessionCache,
            addLog: (msg) => this.addLog(msg),
            updateStatus: (s) => this.updateStatus(s),
            onSpotifyError: (err, op) => {
                this.playerClient.reportThrownError(err, op);
            },
        });

        // Restore persisted state
        this.lastQuery = getStorageItem(STORAGE_KEYS.DJ_LAST_QUERY, '') || null;
        const savedFiltering = getStorageItem(STORAGE_KEYS.AI_FILTERING_ENABLED, '');
        this.config.aiFiltering = savedFiltering === '' ? DEFAULTS.AI_FILTERING_ENABLED : savedFiltering === 'true';
        const savedSchedule = getStoredJSON<ScheduleItem[]>(STORAGE_KEYS.DJ_SCHEDULE, []);
        if (Array.isArray(savedSchedule) && savedSchedule.length > 0) {
            this.schedule = savedSchedule;
        }
    }

    // --- Session State Delegates (Consolidated in TrackSessionCache) ---

    private get currentSessionTracks(): Track[] {
        return this.sessionCache.getSessionTracks();
    }

    private set currentSessionTracks(tracks: Track[]) {
        this.sessionCache.setSessionTracks(tracks, false);
    }

    private get lastPlayTime(): number {
        return this.sessionCache.getLastPlayTime();
    }

    private set lastPlayTime(time: number) {
        this.sessionCache.setLastPlayTime(time);
    }

    private get lastPlayingTrack(): Track | null {
        return this.sessionCache.getLastPlayingTrack();
    }

    private set lastPlayingTrack(track: Track | null) {
        this.sessionCache.setLastPlayingTrack(track, false);
    }

    private get hasConfirmedSessionPlayback(): boolean {
        return this.sessionCache.getHasConfirmedSessionPlayback();
    }

    private set hasConfirmedSessionPlayback(confirmed: boolean) {
        this.sessionCache.setHasConfirmedSessionPlayback(confirmed);
    }

    private get isExternalContextActive(): boolean {
        return this.sessionCache.getIsExternalContextActive();
    }

    private set isExternalContextActive(external: boolean) {
        this.sessionCache.setIsExternalContextActive(external);
    }

    isSessionPlaybackActive(): boolean {
        return this.sessionCache.isSessionPlaybackActive();
    }

    getSessionCache(): TrackSessionCache {
        return this.sessionCache;
    }

    private handleExternalPlaybackDetected(externalTrack: { name?: string; artists?: { name?: string }[] }) {
        const hadSessionTracks = this.sessionCache.getSessionTracks().length > 0;
        this.sessionCache.activateExternalContext(true, true);
        if (!hadSessionTracks) return;
        const artistName = externalTrack.artists?.[0]?.name || 'Unknown';
        const trackName = externalTrack.name || 'Unknown Track';
        this.addLog(`🔄 External playback detected on Spotify: ${trackName} (${artistName}). Prioritizing Spotify queue.`);
    }

    private handleSpotifyApiError(errInfo: SpotifyApiErrorInfo) {
        this.lastError = errInfo.message;
        this.addLog(`⚠️ Spotify API [${errInfo.status || 'ERR'}] (${errInfo.operation}): ${errInfo.message}`);
        if (this.onErrorUpdate) {
            this.onErrorUpdate(errInfo.message, errInfo);
        }
        this.errorListeners.forEach(listener => {
            try {
                listener(errInfo.message, errInfo);
            } catch (e) {
                console.error('Error in DJErrorListener:', e);
            }
        });
    }

    enrichTrackWithCachedMetadata(track: Track): Track {
        return this.sessionCache.enrichTrackWithCachedMetadata(track);
    }

    findTrackIndexInSession(track: Track | SpotifyApi.TrackObjectFull): number {
        return this.sessionCache.findTrackIndexInSession(track);
    }

    updateConfig(config: Partial<DJConfig>) {
        this.config = { ...this.config, ...config };
    }

    updateAccessToken(token: string) {
        this.spotify.setAccessToken(token);
    }

    initAI(backend: AIProvider, apiKey: string, modelName?: string) {
        this.ai = new AIService(backend, apiKey, modelName);
    }

    clearAI() {
        this.ai = undefined;
    }

    async analyzeImage(base64Image: string, mimeType: string): Promise<string> {
        if (!this.ai) throw new Error("AI service not initialized (AIサービスが初期化されていません)");
        return this.ai.analyzeImage(base64Image, mimeType);
    }

    // --- Event / Subscription Model ---

    getStateSnapshot(): DJStateSnapshot {
        const currentItem = this.getCurrentItem() ?? this.getEffectiveItemForPlayback();
        return {
            status: this.statusText,
            schedule: [...this.schedule],
            currentQuery: this.lastQuery,
            currentThought: currentItem?.thought || (this.schedule[0]?.thought ?? null),
            logs: [...this.processLog],
            lastError: this.lastError,
        };
    }

    subscribe(listener: DJStateListener): () => void {
        this.stateListeners.add(listener);
        return () => {
            this.stateListeners.delete(listener);
        };
    }

    subscribeLogs(listener: DJLogListener): () => void {
        this.logListeners.add(listener);
        return () => {
            this.logListeners.delete(listener);
        };
    }

    subscribeErrors(listener: DJErrorListener): () => void {
        this.errorListeners.add(listener);
        return () => {
            this.errorListeners.delete(listener);
        };
    }

    private notifyStateListeners() {
        if (this.stateListeners.size === 0) return;
        const snapshot = this.getStateSnapshot();
        this.stateListeners.forEach(listener => {
            try {
                listener(snapshot);
            } catch (e) {
                console.error('Error in DJStateListener:', e);
            }
        });
    }

    private notifyLogListeners() {
        if (this.logListeners.size === 0) return;
        const logsCopy = [...this.processLog];
        this.logListeners.forEach(listener => {
            try {
                listener(logsCopy);
            } catch (e) {
                console.error('Error in DJLogListener:', e);
            }
        });
    }

    getProcessLog(): string[] {
        return this.processLog;
    }

    private addLog(message: string) {
        const timestamp = new Date().toLocaleTimeString();
        const msg = `[${timestamp}] ${message}`;
        console.log(msg);
        this.processLog.unshift(msg);
        if (this.processLog.length > 100) this.processLog.pop();
        this.notifyLogListeners();
    }

    setStatusCallback(cb: (status: string) => void) {
        this.onStatusUpdate = cb;
    }

    setOnTracksPlayedCallback(cb: (tracks: Track[]) => void) {
        this.onTracksPlayed = cb;
    }

    setErrorCallback(cb: DJErrorListener) {
        this.onErrorUpdate = cb;
    }

    private updateStatus(status: string) {
        this.statusText = status;
        if (this.onStatusUpdate) {
            this.onStatusUpdate(status);
        }
        this.notifyStateListeners();
    }

    // --- Search & Filtering (Delegated to TrackSearchPipeline) ---

    async searchTracks(
        queriesInput: string | string[],
        priorityQuery?: string,
        context?: SearchPipelineContext
    ): Promise<Track[]> {
        return this.searchPipeline.searchTracks(queriesInput, priorityQuery, context);
    }

    // --- Device & Playback Control ---

    async getDevices(): Promise<SpotifyApi.UserDevice[]> {
        return this.playerClient.getDevices();
    }

    hasPendingStartRetry(): boolean {
        return Boolean(this.lastStartFailure && this.lastStartFailure.cachedTracks.length > 0);
    }

    async setActiveDevice(deviceId: string) {
        const res = await this.playerClient.setActiveDevice(deviceId);
        if (res.ok && this.lastStartFailure) {
            // Allow immediate retry on newly selected device while keeping cached curated tracks
            this.lastStartFailure.timestamp = 0;
        }
        return res;
    }

    async playTracks(
        tracks: Track[],
        options?: { isDJSession?: boolean; fullSessionTracks?: Track[]; sessionStartIndex?: number }
    ) {
        if (tracks.length === 0) return;

        const isDJSession = options?.isDJSession ?? true;
        const uris = tracks.map(t => t.uri);
        const playGen = ++this.playbackGeneration;

        const prevTracks = [...this.sessionCache.getSessionTracks()];
        const prevStartIndex = this.sessionCache.getSessionStartIndex();
        const prevPlayTime = this.sessionCache.getLastPlayTime();
        const prevPlayingTrack = this.sessionCache.getLastPlayingTrack();
        const prevConfirmed = this.sessionCache.getHasConfirmedSessionPlayback();
        const prevExternal = this.sessionCache.getIsExternalContextActive();
        const prevKnownPlaying = this.lastKnownIsPlaying;

        const sessionList = options?.fullSessionTracks ?? tracks;
        const startIdx = options?.sessionStartIndex ?? 0;

        if (isDJSession) {
            this.sessionCache.activateDJSession(sessionList, false, startIdx);
        }

        try {
            const deviceId = await this.playerClient.resolveTargetDevice();
            if (playGen !== this.playbackGeneration) {
                return;
            }
            console.log(`▶️ Playing ${uris.length} tracks on device ${deviceId}`);

            await this.playerClient.startPlaybackOnDevice(deviceId, uris);
            if (playGen !== this.playbackGeneration) {
                return;
            }
            this.lastKnownIsPlaying = true;

            if (isDJSession) {
                this.sessionCache.activateDJSession(sessionList, true, startIdx);
            } else {
                this.sessionCache.activateExternalContext(true, true);
            }
            if (this.onTracksPlayed) {
                this.onTracksPlayed(tracks);
            }
        } catch (error) {
            if (playGen === this.playbackGeneration && isDJSession) {
                this.sessionCache.setSessionTracks(prevTracks, false, prevStartIndex);
                this.sessionCache.setLastPlayTime(prevPlayTime);
                this.sessionCache.setLastPlayingTrack(prevPlayingTrack, false);
                this.sessionCache.setHasConfirmedSessionPlayback(prevConfirmed);
                this.sessionCache.setIsExternalContextActive(prevExternal);
                this.lastKnownIsPlaying = prevKnownPlaying;
            }
            console.error('Playback error:', error);
            throw error;
        }
    }

    async playFromQueueIndex(index: number, displayedQueue: Track[]) {
        if (index < 0 || index >= displayedQueue.length) return;

        const targetTrack = displayedQueue[index];
        const sessionTracks = this.sessionCache.getSessionTracks();
        const sessionIdx = this.sessionCache.findTrackIndexInSession(targetTrack);

        if (sessionIdx >= 0) {
            const tracksToPlay = sessionTracks.slice(sessionIdx);
            await this.playTracks(tracksToPlay, {
                isDJSession: true,
                fullSessionTracks: sessionTracks,
                sessionStartIndex: sessionIdx,
            });
            return;
        }

        const isDJCuratedTrack = Boolean(
            this.isSessionPlaybackActive() ||
            this.sessionCache.isTrackPlayedInSession(targetTrack) ||
            targetTrack.selectionReason ||
            targetTrack.vibeTag ||
            targetTrack.stage ||
            targetTrack.score !== undefined ||
            targetTrack.contextName
        );

        if (isDJCuratedTrack) {
            const baseTracks = sessionTracks.length > 0 ? [...sessionTracks] : [];
            for (const t of displayedQueue) {
                if (this.sessionCache.findTrackIndexInSession(t) === -1 && !baseTracks.some(b => b.uri === t.uri)) {
                    baseTracks.push(t);
                }
            }
            const fullTracks = baseTracks.length >= displayedQueue.length ? baseTracks : displayedQueue;
            const resolvedIdx = fullTracks.findIndex(t => t.uri === targetTrack.uri || t.id === targetTrack.id);
            const effectiveIdx = resolvedIdx >= 0 ? resolvedIdx : index;
            const tracksToPlay = fullTracks.slice(effectiveIdx);
            await this.playTracks(tracksToPlay, {
                isDJSession: true,
                fullSessionTracks: fullTracks,
                sessionStartIndex: effectiveIdx,
            });
        } else {
            await this.playTracks(displayedQueue.slice(index), { isDJSession: false });
        }
    }

    // --- Schedule Management ---

    getSchedule(): ScheduleItem[] {
        return this.schedule;
    }

    async createSchedule(instruction: string, personalContext?: string) {
        if (!this.ai) throw new Error("AI not initialized. Please configure your AI API Key in Settings. (AIが初期化されていません。設定画面でAPIキーを設定してください)");

        const schedule = await this.ai.generateSchedule(instruction, this.schedule, personalContext);

        // Snap LLM clock-rounding drift (<= 60m ahead) to current time unless user explicitly requested a future time
        if (schedule.length > 0) {
            const now = new Date();
            if (!isScheduleItemActive(schedule[0], now)) {
                const nowStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
                const firstStartMins = parseTimeToMinutes(schedule[0].start);
                const nowMins = now.getHours() * 60 + now.getMinutes();
                const forwardDiff = (firstStartMins - nowMins + 1440) % 1440;

                if (
                    forwardDiff > 0 &&
                    forwardDiff <= 60 &&
                    !isExplicitFutureScheduleRequest(instruction, schedule[0].start, forwardDiff)
                ) {
                    schedule[0].start = nowStr;
                }
            }
        }

        this.setSchedule(schedule, true);
        return schedule;
    }

    private invalidatePreload() {
        this.preloadGeneration++;
        this.preloadedResult = null;
        this.inFlightPreload = null;
    }

    private triggerSilentPreload(nextItem: ScheduleItem) {
        const nextSignature = getScheduleItemSignature(nextItem);
        const queries = getScheduleItemQueries(nextItem);

        if (
            !nextSignature ||
            queries.length === 0 ||
            nextSignature === this.lastQuery ||
            (this.preloadedResult && this.preloadedResult.signature === nextSignature) ||
            (this.inFlightPreload && this.inFlightPreload.signature === nextSignature)
        ) {
            return;
        }

        const preloadGen = ++this.preloadGeneration;
        console.log(`⏳ Preloading tracks for upcoming schedule: ${nextSignature}`);
        this.addLog(`⏳ Preloading upcoming block: ${nextSignature}`);

        const preloadPromise = this.searchTracks(queries, nextItem.priorityTrack, {
            userRequest: nextItem.userRequest,
            thought: nextItem.thought,
            anchorTracks: nextItem.anchorTracks,
            silent: true,
        }).then(tracks => {
            if (preloadGen === this.preloadGeneration && tracks.length > 0) {
                console.log(`✅ Preloaded ${tracks.length} tracks for "${nextSignature}"`);
                this.preloadedResult = {
                    signature: nextSignature,
                    tracks
                };
                this.addLog(`✅ Preloaded ${tracks.length} tracks for upcoming block`);
            }
            if (this.inFlightPreload?.generation === preloadGen) {
                this.inFlightPreload = null;
            }
            return tracks;
        }).catch(err => {
            console.error("Failed to preload:", err);
            if (this.inFlightPreload?.generation === preloadGen) {
                this.inFlightPreload = null;
            }
            return [] as Track[];
        });

        this.inFlightPreload = {
            signature: nextSignature,
            generation: preloadGen,
            promise: preloadPromise,
        };
    }

    setSchedule(schedule: ScheduleItem[], persist: boolean = false) {
        this.schedule = [...schedule];
        this.invalidatePreload();
        this.lastStartFailure = null;
        if (this.schedule.length === 0) {
            this.lastQuery = null;
            removeStorageItem(STORAGE_KEYS.DJ_LAST_QUERY);
        } else if (
            isWaitingForScheduleStart(this.schedule) &&
            this.lastQuery &&
            !this.schedule.some(s => getScheduleItemSignature(s) === this.lastQuery)
        ) {
            this.lastQuery = null;
            removeStorageItem(STORAGE_KEYS.DJ_LAST_QUERY);
        }
        if (persist) {
            setStoredJSON(STORAGE_KEYS.DJ_SCHEDULE, this.schedule);
        }
        this.notifyStateListeners();
    }

    removeScheduleItem(index: number, persist: boolean = false) {
        if (index >= 0 && index < this.schedule.length) {
            this.schedule = this.schedule.filter((_, idx) => idx !== index);
            this.invalidatePreload();
            this.lastStartFailure = null;
            if (this.schedule.length === 0) {
                this.lastQuery = null;
                removeStorageItem(STORAGE_KEYS.DJ_LAST_QUERY);
            }
            if (persist) {
                setStoredJSON(STORAGE_KEYS.DJ_SCHEDULE, this.schedule);
            }
            this.notifyStateListeners();
            return this.schedule;
        }
        return this.schedule;
    }

    getItemForDate(date: Date): ScheduleItem | null {
        return findActiveScheduleItem(this.schedule, date);
    }

    /**
     * Resolves the effective schedule item to play right now.
     * Guarantees the DJ will not stall silently if a schedule exists.
     */
    getEffectiveItemForPlayback(date: Date = new Date()): ScheduleItem | null {
        return resolveEffectiveScheduleItem(this.schedule, date);
    }

    getCurrentItem(): ScheduleItem | null {
        return this.getItemForDate(new Date());
    }

    // --- Main DJ Loop & Preloading ---

    async processDJLoop(silentWait: boolean = true, force: boolean = false) {
        if (this.activeLoopCount > 0 && !force) {
            return;
        }
        this.activeLoopCount++;

        try {
            const now = new Date();
            if (this.schedule.length === 0) {
                if (!silentWait) {
                    throw new Error('No active schedule item to play. (再生可能なスケジュールがありません)');
                }
                return;
            }

            const PRELOAD_MS = 60 * 1000;

            // 0. If the first scheduled block is explicitly in the future, stand by until its start time
            //    (and preload silently 60 seconds before it begins) instead of playing prematurely.
            if (isWaitingForScheduleStart(this.schedule, now)) {
                const firstItem = this.schedule[0];
                const futureDate = new Date(now.getTime() + PRELOAD_MS);
                const upcomingActive = findStrictlyActiveScheduleItem(this.schedule, futureDate);
                if (upcomingActive) {
                    this.triggerSilentPreload(upcomingActive);
                }

                const waitStatus = `⏰ Waiting for ${firstItem.start}... (${firstItem.start}の開始を待機中...)`;
                if (this.statusText !== waitStatus) {
                    this.addLog(`⏰ Scheduled to start at ${firstItem.start}. Standing by...`);
                    this.updateStatus(waitStatus);
                }
                return;
            }

            const currentItem = this.getEffectiveItemForPlayback(now);

            if (!currentItem) {
                if (!silentWait) {
                    throw new Error('No active schedule item to play. (再生可能なスケジュールがありません)');
                }
                return;
            }

            const queriesToUse = getScheduleItemQueries(currentItem);
            if (queriesToUse.length === 0) {
                if (!silentWait) {
                    throw new Error('Schedule block contains no search queries. Try rephrasing your request. (スケジュールに検索キーワードが含まれていません)');
                }
                return;
            }

            const querySignature = getScheduleItemSignature(currentItem);

            // 1. Check if we need to PRELOAD for upcoming schedule (60 seconds ahead) while current block is active
            if (!force && querySignature === this.lastQuery && this.schedule.length > 1) {
                const futureDate = new Date(now.getTime() + PRELOAD_MS);
                const nextItem = findStrictlyActiveScheduleItem(this.schedule, futureDate);
                if (nextItem) {
                    this.triggerSilentPreload(nextItem);
                }
            }

            // 2. Check if we need to change music (or start session if no active/external session exists)
            const hasNoActiveOrExternalSession = !this.isExternalContextActive && this.sessionCache.getSessionTracks().length === 0;
            if (force || querySignature !== this.lastQuery || hasNoActiveOrExternalSession) {
                if (force) {
                    this.invalidatePreload();
                    this.lastStartFailure = null;
                } else if (
                    this.lastStartFailure &&
                    this.lastStartFailure.signature === querySignature &&
                    Date.now() - this.lastStartFailure.timestamp < this.lastStartFailure.retryAfterMs
                ) {
                    return;
                }

                const currentGen = ++this.playbackGeneration;
                this.playerClient.clearLastError();
                const devices = await this.getDevices();
                if (devices.length === 0) {
                    this.lastQuery = null;
                    removeStorageItem(STORAGE_KEYS.DJ_LAST_QUERY);
                    const apiErr = this.playerClient.getLastError();
                    if (apiErr) {
                        this.updateStatus(`⚠️ ${apiErr.message}`);
                        if (!silentWait) {
                            throw new Error(apiErr.message);
                        }
                        return;
                    }
                    const msg = "No active Spotify device found. Please open Spotify on your device. (再生デバイスが見つかりません。Spotifyを開いてください)";
                    const noDeviceStatus = '⚠️ Please open Spotify (Spotifyを開いてください)';
                    console.log(`⚠️ DJ Search skipped: ${msg}`);
                    if (!silentWait || this.statusText !== noDeviceStatus) {
                        this.addLog(`⚠️ ${msg}`);
                    }
                    this.updateStatus(noDeviceStatus);
                    if (!silentWait) {
                        throw new Error(msg);
                    }
                    return;
                }

                console.log(`🎧 DJ Change${force ? ' (Forced)' : ''}: ${querySignature} `);
                this.lastQuery = querySignature;
                setStorageItem(STORAGE_KEYS.DJ_LAST_QUERY, querySignature);
                this.notifyStateListeners();

                this.addLog("──────── New Session Started ────────");
                this.sessionCache.resetSessionPlayedHistory();

                let tracks: Track[] = [];

                if (
                    this.preloadedResult &&
                    this.preloadedResult.signature === querySignature &&
                    this.preloadedResult.tracks.length > 0
                ) {
                    console.log(`🚀 Using Preloaded Tracks for ${querySignature}`);
                    this.addLog(`🚀 Transitioning seamlessly with ${this.preloadedResult.tracks.length} preloaded tracks`);
                    tracks = this.preloadedResult.tracks;
                    this.preloadedResult = null;
                } else if (
                    !force &&
                    this.inFlightPreload &&
                    this.inFlightPreload.signature === querySignature
                ) {
                    this.updateStatus(`🔎 Finishing preload: ${queriesToUse[0]}... (選曲仕上げ中...)`);
                    tracks = await this.inFlightPreload.promise;
                    this.preloadedResult = null;
                    if (tracks.length === 0 && currentGen === this.playbackGeneration) {
                        this.updateStatus(`🔎 Searching: ${queriesToUse[0]}... (選曲中...)`);
                        tracks = await this.searchTracks(queriesToUse, currentItem.priorityTrack, {
                            userRequest: currentItem.userRequest,
                            thought: currentItem.thought,
                            anchorTracks: currentItem.anchorTracks
                        });
                    }
                } else if (
                    !force &&
                    this.lastStartFailure &&
                    this.lastStartFailure.signature === querySignature &&
                    this.lastStartFailure.cachedTracks.length > 0
                ) {
                    console.log(`♻️ Reusing cached curated tracks after playback retry cooldown for ${querySignature}`);
                    this.addLog(`♻️ Retrying playback with ${this.lastStartFailure.cachedTracks.length} curated tracks`);
                    tracks = this.lastStartFailure.cachedTracks;
                } else {
                    this.updateStatus(`🔎 Searching: ${queriesToUse[0]}... (選曲中...)`);
                    console.log(`🔎 Performing immediate search for ${querySignature}`);
                    tracks = await this.searchTracks(queriesToUse, currentItem.priorityTrack, {
                        userRequest: currentItem.userRequest,
                        thought: currentItem.thought,
                        anchorTracks: currentItem.anchorTracks
                    });
                }

                if (currentGen !== this.playbackGeneration) {
                    return;
                }

                if (tracks.length === 0) {
                    const searchErr = this.playerClient.getLastError();
                    const retryAfterMs =
                        searchErr?.category === 'rate_limited'
                            ? Math.max((searchErr.retryAfterSeconds ?? 60) * 1000, 60 * 1000)
                            : 60 * 1000;
                    this.lastStartFailure = {
                        signature: querySignature,
                        timestamp: Date.now(),
                        category: searchErr?.category,
                        retryAfterMs,
                        cachedTracks: [],
                    };
                    this.lastQuery = null;
                    removeStorageItem(STORAGE_KEYS.DJ_LAST_QUERY);
                    this.notifyStateListeners();
                    const noTracksMsg = searchErr
                        ? searchErr.message
                        : 'No matching tracks found on Spotify. Try a different prompt. (条件に合う楽曲が見つかりませんでした)';
                    this.updateStatus(`⚠️ ${noTracksMsg}`);
                    if (!silentWait) {
                        throw new Error(noTracksMsg);
                    }
                    return;
                }

                try {
                    this.sessionCache.markTracksPlayed(tracks);

                    this.updateStatus('▶️ Starting playback... (再生開始中...)');
                    await this.playTracks(tracks);
                    this.lastStartFailure = null;
                    this.updateStatus('Ready');
                } catch (e) {
                    console.error("Playback failed, scheduling backoff before retry:", e);
                    const playErr = this.playerClient.getLastError();
                    const retryAfterMs =
                        playErr?.category === 'forbidden'
                            ? 5 * 60 * 1000
                            : playErr?.category === 'rate_limited'
                                ? Math.max((playErr.retryAfterSeconds ?? 60) * 1000, 60 * 1000)
                                : 60 * 1000;
                    this.lastStartFailure = {
                        signature: querySignature,
                        timestamp: Date.now(),
                        category: playErr?.category,
                        retryAfterMs,
                        cachedTracks: tracks,
                    };
                    this.lastQuery = null;
                    removeStorageItem(STORAGE_KEYS.DJ_LAST_QUERY);
                    const failMsg = playErr?.message || (e instanceof Error ? e.message : String(e));
                    this.updateStatus(`⚠️ ${failMsg}`);
                    throw e;
                }
            } else {
                // Same context: Check for Auto-Refill (Okawari)
                await this.checkAndRefillQueue(queriesToUse, currentItem);
            }
        } finally {
            this.activeLoopCount = Math.max(0, this.activeLoopCount - 1);
        }
    }

    // --- Auto-Refill Logic ---

    private async checkAndRefillQueue(queries: string[], currentItem: ScheduleItem) {
        if (this.isRefilling) return;

        // Do not auto-refill if there is no active ContextDJ session (e.g. external Spotify playback took over)
        if (!this.isSessionPlaybackActive()) {
            return;
        }

        const now = Date.now();
        const REFILL_COOLDOWN_MS = 60 * 1000;
        if (now - this.lastRefillAttemptTime < REFILL_COOLDOWN_MS) {
            return;
        }

        const refillGen = this.playbackGeneration;
        const hadConfirmedBeforeCheck = this.hasConfirmedSessionPlayback;
        const lastPlayTimeBeforeCheck = this.lastPlayTime;
        const playback = await this.getPlaybackState();

        // Re-verify session and generation are still active after getPlaybackState()
        if (refillGen !== this.playbackGeneration || !this.isSessionPlaybackActive()) {
            return;
        }

        if (!playback || !playback.is_playing) {
            // If session tracks were restored from storage (never started or confirmed in this runtime)
            // and Spotify is idle or paused on a non-session track, start playing the restored session tracks
            if (!hadConfirmedBeforeCheck && lastPlayTimeBeforeCheck === 0) {
                const isPausedOnSessionTrack = Boolean(
                    playback?.item &&
                    playback.item.type === 'track' &&
                    !playback.context?.uri &&
                    this.sessionCache.findTrackIndexInSession(playback.item as Track) >= 0
                );
                if (!isPausedOnSessionTrack) {
                    const devices = await this.getDevices();
                    if (devices.length > 0 && refillGen === this.playbackGeneration && this.isSessionPlaybackActive()) {
                        const sessionTracks = this.sessionCache.getSessionTracks();
                        const startIdx = this.sessionCache.getSessionStartIndex();
                        const tracksToPlay = sessionTracks.slice(startIdx);
                        if (tracksToPlay.length > 0) {
                            this.lastRefillAttemptTime = Date.now();
                            this.sessionCache.markTracksPlayed(sessionTracks);
                            try {
                                await this.playTracks(tracksToPlay, {
                                    isDJSession: true,
                                    fullSessionTracks: sessionTracks,
                                    sessionStartIndex: startIdx,
                                });
                            } catch (restoreErr) {
                                console.warn("Restored session auto-start failed (will retry after cooldown):", restoreErr);
                            }
                        }
                    }
                }
            }
            return;
        }

        if (playback.__optimisticFallback || !playback.device || !playback.device.is_active) {
            return;
        }

        try {
            const activeItem = (playback.item && playback.item.type === 'track') ? (playback.item as Track) : null;
            const queue = await this.getQueue(activeItem);
            if (refillGen !== this.playbackGeneration || !this.isSessionPlaybackActive()) {
                return;
            }
            if (queue.length < PLAYBACK_CONSTANTS.MIN_QUEUE_SIZE_FOR_REFILL) {
                this.isRefilling = true;
                this.lastRefillAttemptTime = Date.now();
                this.addLog("🥣 Queue running low. Auto-Refill (Okawari) started...");

                const newTracks = await this.searchTracks(queries, undefined, {
                    userRequest: currentItem.userRequest,
                    thought: currentItem.thought,
                    anchorTracks: currentItem.anchorTracks
                });

                if (refillGen !== this.playbackGeneration || !this.isSessionPlaybackActive()) {
                    this.isRefilling = false;
                    return;
                }

                const queueKeys = new Set(queue.map(item => generateTrackKey(item as Track)));

                const candidates = newTracks.filter(t => {
                    const key = generateTrackKey(t);
                    return !this.sessionCache.isTrackPlayedInSession(t) && !queueKeys.has(key);
                });

                const REFILL_COUNT = 5;
                const toAdd = candidates.slice(0, REFILL_COUNT);

                if (toAdd.length > 0) {
                    this.addLog(`🥣 Adding ${toAdd.length} fresh tracks to queue...`);

                    const addedTracks: Track[] = [];
                    for (const track of toAdd) {
                        if (refillGen !== this.playbackGeneration || !this.isSessionPlaybackActive()) {
                            break;
                        }
                        const res = await this.playerClient.addToQueue(track.uri);
                        if (!res.ok) {
                            this.addLog(`⚠️ Queue refill interrupted (${res.status || 'ERR'}).`);
                            break;
                        }
                        this.sessionCache.markTrackPlayed(track);
                        addedTracks.push(track);
                        await new Promise(r => setTimeout(r, 200));
                    }
                    if (addedTracks.length > 0 && refillGen === this.playbackGeneration && this.isSessionPlaybackActive()) {
                        this.sessionCache.appendSessionTracks(addedTracks);
                        this.addLog(`✅ Refill complete.`);
                        this.notifyStateListeners();
                    }
                } else {
                    this.addLog(`⚠️ Refill found no new unique tracks.`);
                    this.lastRefillAttemptTime = Date.now() + 120 * 1000;
                }

                this.isRefilling = false;
            }
        } catch (e) {
            console.warn("Auto-refill failed:", e);
            this.isRefilling = false;
        }
    }

    // --- Queue & Playback State ---

    async getQueue(currentTrackOverride?: Track | null): Promise<Track[]> {
        const activeTrack = currentTrackOverride !== undefined ? currentTrackOverride : this.lastPlayingTrack;
        const sessionTracks = this.sessionCache.getSessionTracks();
        const sessionStartIndex = this.sessionCache.getSessionStartIndex();
        const now = Date.now();

        if (sessionTracks.length > 0 && !this.isExternalContextActive) {
            const isInStartupGrace = !this.hasConfirmedSessionPlayback &&
                this.lastPlayTime > 0 &&
                (now - this.lastPlayTime < 15000);

            if (activeTrack) {
                const foundIndex = this.sessionCache.findTrackIndexInSession(activeTrack);
                if (foundIndex >= 0) {
                    const effectiveIndex = (isInStartupGrace && foundIndex !== sessionStartIndex)
                        ? sessionStartIndex
                        : foundIndex;
                    return sessionTracks
                        .slice(effectiveIndex + 1)
                        .map(t => this.sessionCache.enrichTrackWithCachedMetadata(t));
                }

                if (isInStartupGrace || this.lastKnownIsPlaying === false) {
                    return sessionTracks
                        .slice(sessionStartIndex + 1)
                        .map(t => this.sessionCache.enrichTrackWithCachedMetadata(t));
                }

                // Active track is not in sessionTracks, Spotify is actively playing, and startup grace has passed:
                // User switched playback externally in the Spotify app -> prioritize Spotify's live queue.
                this.handleExternalPlaybackDetected(activeTrack);
            } else if (isInStartupGrace || this.lastKnownIsPlaying === false) {
                return sessionTracks
                    .slice(sessionStartIndex + 1)
                    .map(t => this.sessionCache.enrichTrackWithCachedMetadata(t));
            }
        }

        try {
            const { currently_playing: currentlyPlaying, queue: tracks } = await this.playerClient.getUserQueue();
            let enriched = tracks.map(t => this.sessionCache.enrichTrackWithCachedMetadata(t));

            const effectiveActive = activeTrack || currentlyPlaying;
            if (effectiveActive && enriched.length > 0) {
                const activeKey = generateTrackKey(effectiveActive);
                const activeUri = effectiveActive.uri;
                const activeLinkedUri = (effectiveActive as { linked_from?: { uri?: string } }).linked_from?.uri;
                while (enriched.length > 0) {
                    const first = enriched[0];
                    const firstLinkedUri = (first as { linked_from?: { uri?: string } }).linked_from?.uri;
                    if (
                        first.uri === activeUri ||
                        (activeLinkedUri && (first.uri === activeLinkedUri || firstLinkedUri === activeLinkedUri)) ||
                        (firstLinkedUri && firstLinkedUri === activeUri) ||
                        (activeKey && generateTrackKey(first) === activeKey)
                    ) {
                        enriched = enriched.slice(1);
                    } else {
                        break;
                    }
                }
            }

            if (enriched.length > 0) {
                return enriched;
            }

            if (!activeTrack && !this.isExternalContextActive && this.sessionCache.getSessionTracks().length > 0) {
                return this.sessionCache.getSessionTracksFromCurrent(null);
            }

            return [];
        } catch (e) {
            console.warn('Failed to fetch queue:', e);
            if (!activeTrack && !this.isExternalContextActive && this.sessionCache.getSessionTracks().length > 0) {
                return this.sessionCache.getSessionTracksFromCurrent(null);
            }
            return [];
        }
    }

    async getPlaybackState(): Promise<SpotifyApi.CurrentPlaybackResponse | null> {
        try {
            const state = await this.spotify.getMyCurrentPlaybackState();
            const now = Date.now();
            const sessionTracks = this.sessionCache.getSessionTracks();
            const sessionStartIndex = this.sessionCache.getSessionStartIndex();
            const isSpotifyPlaying = Boolean(state?.is_playing);
            this.lastKnownIsPlaying = isSpotifyPlaying;

            if (state?.device?.is_active && state.device.id) {
                this.playerClient.syncActiveDeviceId(state.device.id);
            }

            // ContextDJ always initiates playback via `{ uris }` (context === null).
            // Any non-null context URI (album, playlist, artist, collection) means playback came from Spotify externally.
            const hasExternalContextUri = Boolean(state?.context?.uri);
            const sessionIndex = (
                !hasExternalContextUri &&
                state?.item &&
                state.item.type === 'track'
            )
                ? this.sessionCache.findTrackIndexInSession(state.item as Track)
                : -1;
            const isCurrentItemInSession = sessionIndex >= 0;
            const isWaitingForStartupSwitch = !this.hasConfirmedSessionPlayback &&
                this.lastPlayTime > 0 &&
                (now - this.lastPlayTime < 6000);
            const hasReachedStartTrack = isCurrentItemInSession && (
                this.hasConfirmedSessionPlayback ||
                !isWaitingForStartupSwitch ||
                sessionIndex === sessionStartIndex
            );

            if (hasReachedStartTrack && isSpotifyPlaying) {
                this.sessionCache.confirmSessionPlayback();
                this.sessionCache.setSessionStartIndex(sessionIndex);
            } else if (this.hasConfirmedSessionPlayback && isCurrentItemInSession) {
                this.sessionCache.setSessionStartIndex(sessionIndex);
            }

            const isInStartupGrace = isWaitingForStartupSwitch;

            if (isInStartupGrace && sessionTracks.length > 0) {
                const startTrack = sessionTracks[sessionStartIndex] || sessionTracks[0];
                const isPlayingOldTrack = Boolean((state?.item && !hasReachedStartTrack) || hasExternalContextUri || !isSpotifyPlaying);
                const isNoTrack = !state || !state.item;

                if (isNoTrack || isPlayingOldTrack) {
                    const enriched = this.sessionCache.enrichTrackWithCachedMetadata(startTrack);
                    const fallbackDevice: SpotifyApi.UserDevice = (state && state.device) || {
                        id: this.playerClient.getActiveDeviceId() || 'unknown',
                        is_active: true,
                        is_private_session: false,
                        is_restricted: false,
                        name: 'Connecting...',
                        type: 'Computer',
                        volume_percent: 100
                    };
                    return {
                        ...(state || {}),
                        is_playing: true,
                        item: enriched,
                        device: fallbackDevice,
                        __optimisticFallback: true,
                    } as SpotifyApi.CurrentPlaybackResponse;
                }
            }

            if (state && state.item && state.item.type === 'track') {
                const trackItem = state.item as Track;
                if (
                    isSpotifyPlaying &&
                    sessionTracks.length > 0 &&
                    !isCurrentItemInSession &&
                    (this.hasConfirmedSessionPlayback || !this.lastPlayTime || now - this.lastPlayTime >= 15000)
                ) {
                    this.handleExternalPlaybackDetected(trackItem);
                }
                const enriched = this.sessionCache.enrichTrackWithCachedMetadata(trackItem);
                state.item = enriched;
                if (isSpotifyPlaying || isCurrentItemInSession || this.isExternalContextActive || sessionTracks.length === 0) {
                    this.lastPlayingTrack = enriched;
                }
                return state;
            }

            const isNonTrackExternal = Boolean(
                state &&
                ((state.item && state.item.type !== 'track') ||
                    (state.currently_playing_type && state.currently_playing_type !== 'track' && state.currently_playing_type !== 'unknown'))
            );

            if (
                isSpotifyPlaying &&
                isNonTrackExternal &&
                sessionTracks.length > 0 &&
                (this.hasConfirmedSessionPlayback || !this.lastPlayTime || now - this.lastPlayTime >= 15000)
            ) {
                this.handleExternalPlaybackDetected({
                    name: state?.item?.name || state?.currently_playing_type || 'External Media',
                    artists: [{ name: 'Spotify' }]
                });
            }

            if ((!state || !state.item) && (this.isExternalContextActive || sessionTracks.length === 0)) {
                this.lastPlayingTrack = null;
            }

            return state;
        } catch (e) {
            this.playerClient.reportThrownError(e, 'get_playback_state', { throttleMs: 10000 });
            console.warn('Failed to fetch playback state:', e);
            return null;
        }
    }

    // --- Status Inspection & Transport Controls ---

    getLastPlayTime(): number {
        return this.sessionCache.getLastPlayTime();
    }

    getDJStatus() {
        const currentItem = this.getCurrentItem() ?? this.getEffectiveItemForPlayback();
        return {
            currentScheduleItem: currentItem,
            currentQuery: this.lastQuery,
            currentThought: currentItem?.thought || null,
            config: this.config
        };
    }

    async next() {
        const sessionTracks = this.sessionCache.getSessionTracks();
        const prevStartIndex = this.sessionCache.getSessionStartIndex();
        const prevPlayingTrack = this.lastPlayingTrack;
        let didAdvanceSession = false;

        if (sessionTracks.length > 0 && !this.isExternalContextActive) {
            const lastPlaying = this.lastPlayingTrack;
            const currentIdx = lastPlaying ? this.sessionCache.findTrackIndexInSession(lastPlaying) : -1;
            const baseIdx = currentIdx >= 0 ? currentIdx : prevStartIndex;
            if (baseIdx + 1 < sessionTracks.length) {
                const nextIdx = baseIdx + 1;
                this.sessionCache.setSessionStartIndex(nextIdx);
                this.lastPlayingTrack = sessionTracks[nextIdx];
                didAdvanceSession = true;
            }
        }
        const res = await this.playerClient.next();
        if (!res.ok && didAdvanceSession) {
            this.sessionCache.setSessionStartIndex(prevStartIndex);
            this.lastPlayingTrack = prevPlayingTrack;
        }
        return res;
    }

    async previous() {
        const sessionTracks = this.sessionCache.getSessionTracks();
        const prevStartIndex = this.sessionCache.getSessionStartIndex();
        const prevPlayingTrack = this.lastPlayingTrack;
        const prevPlayTime = this.sessionCache.getLastPlayTime();
        let didMutateSession = false;

        if (sessionTracks.length > 0 && !this.isExternalContextActive) {
            const lastPlaying = this.lastPlayingTrack;
            const currentIdx = lastPlaying ? this.sessionCache.findTrackIndexInSession(lastPlaying) : -1;
            const baseIdx = currentIdx >= 0 ? currentIdx : prevStartIndex;
            if (baseIdx > 0) {
                const targetIdx = baseIdx - 1;
                this.sessionCache.setSessionStartIndex(targetIdx);
                this.lastPlayingTrack = sessionTracks[targetIdx];
                didMutateSession = true;
            }
            if (!this.hasConfirmedSessionPlayback) {
                this.sessionCache.setLastPlayTime(0);
                didMutateSession = true;
            }
        }
        const res = await this.playerClient.previous();
        if (!res.ok && didMutateSession) {
            this.sessionCache.setSessionStartIndex(prevStartIndex);
            this.lastPlayingTrack = prevPlayingTrack;
            this.sessionCache.setLastPlayTime(prevPlayTime);
        }
        return res;
    }

    async pause() {
        const res = await this.playerClient.pause();
        if (res.ok) {
            this.lastKnownIsPlaying = false;
        }
        return res;
    }

    async resume(): Promise<SpotifyControlResult> {
        const sessionTracks = this.sessionCache.getSessionTracks();
        if (sessionTracks.length > 0 && !this.isExternalContextActive) {
            let shouldStartSessionTracks = !this.hasConfirmedSessionPlayback;

            // Verify whether Spotify is currently on one of our session tracks on an active device
            try {
                const state = await this.spotify.getMyCurrentPlaybackState();
                const hasExternalContextUri = Boolean(state?.context?.uri);
                const isCurrentInSession = Boolean(
                    !hasExternalContextUri &&
                    state?.device?.is_active &&
                    state?.item &&
                    state.item.type === 'track' &&
                    this.sessionCache.findTrackIndexInSession(state.item as Track) >= 0
                );
                if (isCurrentInSession) {
                    const res = await this.playerClient.resume(
                        state?.device?.id || this.playerClient.getActiveDeviceId() || undefined
                    );
                    if (res.ok) {
                        this.sessionCache.confirmSessionPlayback();
                        this.lastKnownIsPlaying = true;
                        return res;
                    }
                }
                shouldStartSessionTracks = true;
            } catch {
                // If state inspection fails and session playback was previously confirmed, try bare resume first
                if (!shouldStartSessionTracks) {
                    const res = await this.playerClient.resume(this.playerClient.getActiveDeviceId() || undefined);
                    if (res.ok) {
                        this.lastKnownIsPlaying = true;
                        return res;
                    }
                }
                shouldStartSessionTracks = true;
            }

            if (shouldStartSessionTracks) {
                try {
                    const lastPlaying = this.lastPlayingTrack;
                    const currentIdx = lastPlaying
                        ? this.sessionCache.findTrackIndexInSession(lastPlaying)
                        : -1;
                    const startIdx = currentIdx >= 0
                        ? currentIdx
                        : this.sessionCache.getSessionStartIndex();
                    const tracksToPlay = sessionTracks.slice(startIdx);
                    if (tracksToPlay.length > 0) {
                        await this.playTracks(tracksToPlay, {
                            isDJSession: true,
                            fullSessionTracks: sessionTracks,
                            sessionStartIndex: startIdx,
                        });
                        return { ok: true, status: 204 };
                    }
                } catch (e) {
                    const classified = this.playerClient.reportThrownError(e, 'play');
                    return { ok: false, status: classified?.status, error: classified ?? undefined };
                }
            }
        }

        const res = await this.playerClient.resume(this.playerClient.getActiveDeviceId() || undefined);
        if (res.ok) {
            this.lastKnownIsPlaying = true;
        }
        return res;
    }
}
