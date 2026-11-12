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
    POST_OVERNIGHT_END_WINDOW_MINS,
    attachScheduleTimestamps,
    filterActiveOrUpcomingSchedule,
    generateTrackKey,
    hasImmediateCueInPrompt,
    isExplicitFutureScheduleRequest,
    isScheduleItemActive,
    isTomorrowFirstBlockRequest,
    getScheduleItemSignature,
    getScheduleItemQueries,
    normalizeTimeString,
    parseTimeToMinutes,
    findActiveScheduleItem,
    findStrictlyActiveScheduleItem,
    isWaitingForScheduleStart,
    resolveEffectiveScheduleItem,
    resolveScheduleThought,
    shouldPreserveActivePlaybackOnScheduleUpdate,
} from './dj-utils';
import { TrackSessionCache } from './track-session-cache';
import { SpotifyPlayerClient } from './spotify-player-client';
import { TrackSearchPipeline } from './track-search-pipeline';

export type { Track };

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
    private loggedStandbyStart: string | null = null;
    private userExplicitlyPaused = false;
    private pendingForegroundRecovery = false;

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
            this.clearCollidingLastQueryWhenWaiting();
            this.syncStandbyStatusAfterScheduleChange();
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
        return {
            status: this.statusText,
            schedule: [...this.schedule],
            currentQuery: this.lastQuery,
            currentThought: resolveScheduleThought(this.schedule, this.lastQuery),
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

    hasConfirmedPlayback(): boolean {
        return this.hasConfirmedSessionPlayback;
    }

    getPreferredDeviceId(): string | null {
        return typeof this.playerClient.getPreferredDeviceId === 'function'
            ? this.playerClient.getPreferredDeviceId()
            : null;
    }

    hasPendingStartRetry(): boolean {
        return Boolean(this.lastStartFailure && this.lastStartFailure.cachedTracks.length > 0);
    }

    notifyForegrounded() {
        this.pendingForegroundRecovery = true;
        if (
            this.lastStartFailure &&
            this.lastStartFailure.category !== 'forbidden' &&
            this.lastStartFailure.category !== 'rate_limited'
        ) {
            this.lastStartFailure.timestamp = 0;
        }
        if (!this.hasConfirmedSessionPlayback && !this.userExplicitlyPaused) {
            this.lastRefillAttemptTime = 0;
        }
    }

    private reconcilePendingStartFailureAfterManualPlay() {
        if (!this.lastStartFailure) return;
        const failedSig = this.lastStartFailure.signature;
        this.lastStartFailure = null;
        if (this.schedule.length > 0 && !isWaitingForScheduleStart(this.schedule)) {
            const activeItem = this.getEffectiveItemForPlayback();
            const activeSig = activeItem ? getScheduleItemSignature(activeItem) : null;
            if (activeSig && activeSig === failedSig && !this.lastQuery) {
                this.lastQuery = activeSig;
                setStorageItem(STORAGE_KEYS.DJ_LAST_QUERY, activeSig);
            }
        }
        if (this.statusText.startsWith('⚠️')) {
            this.updateStatus('Ready');
        } else {
            this.notifyStateListeners();
        }
    }

    async setActiveDevice(deviceId: string) {
        const res = await this.playerClient.setActiveDevice(deviceId);
        if (res.ok) {
            if (this.lastStartFailure) {
                // Allow immediate retry on newly selected device while keeping cached curated tracks
                this.lastStartFailure.timestamp = 0;
            }
            if (!this.hasConfirmedSessionPlayback && !this.userExplicitlyPaused && this.isSessionPlaybackActive()) {
                this.lastRefillAttemptTime = 0;
                this.pendingForegroundRecovery = true;
                this.sessionCache.setLastPlayTime(0);
            }
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
        const prevInitiated = this.sessionCache.getHasInitiatedSessionInRuntime();
        const prevExternal = this.sessionCache.getIsExternalContextActive();
        const prevKnownPlaying = this.lastKnownIsPlaying;

        const sessionList = options?.fullSessionTracks ?? tracks;
        const startIdx = options?.sessionStartIndex ?? 0;

        if (isDJSession) {
            this.userExplicitlyPaused = false;
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
                this.reconcilePendingStartFailureAfterManualPlay();
            } else {
                this.sessionCache.activateExternalContext(true, true);
            }
            if (this.onTracksPlayed) {
                this.onTracksPlayed(tracks);
            }
        } catch (error) {
            if (playGen === this.playbackGeneration && isDJSession) {
                const isMidSessionJump = Boolean(prevConfirmed && prevTracks.length > 0 && options?.fullSessionTracks);
                if (isMidSessionJump) {
                    this.sessionCache.setSessionTracks(prevTracks, false, prevStartIndex);
                    this.sessionCache.setLastPlayTime(prevPlayTime);
                    this.sessionCache.setLastPlayingTrack(prevPlayingTrack, false);
                    this.sessionCache.setHasConfirmedSessionPlayback(prevConfirmed);
                    this.sessionCache.setHasInitiatedSessionInRuntime(prevInitiated);
                    this.sessionCache.setIsExternalContextActive(prevExternal);
                    this.lastKnownIsPlaying = prevKnownPlaying;
                } else {
                    // Preserve newly curated session tracks (e.g. on 404 asleep device) so UI keeps the list
                    // and pressing Play or returning to the browser starts Track 1 immediately without re-searching.
                    this.sessionCache.setSessionTracks(sessionList, true, startIdx);
                    this.sessionCache.setHasInitiatedSessionInRuntime(sessionList.length > 0);
                    this.sessionCache.setLastPlayTime(0);
                    this.sessionCache.setLastPlayingTrack(sessionList[startIdx] ?? null, true);
                    this.sessionCache.setHasConfirmedSessionPlayback(false);
                    this.sessionCache.setIsExternalContextActive(false);
                    this.lastKnownIsPlaying = false;
                }
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

        const activePrevSchedule = filterActiveOrUpcomingSchedule(this.schedule, new Date());
        const schedule = await this.ai.generateSchedule(instruction, activePrevSchedule, personalContext);
        const now = new Date();

        if (schedule.length === 0) {
            this.setSchedule([], true);
            return this.schedule;
        }

        const hasImmediateCue = hasImmediateCueInPrompt(instruction, schedule.length);
        const prevFirstPreserved = Boolean(
            !hasImmediateCue &&
            activePrevSchedule.length > 0 &&
            normalizeTimeString(activePrevSchedule[0].start) === normalizeTimeString(schedule[0].start) &&
            getScheduleItemSignature(activePrevSchedule[0]) === getScheduleItemSignature(schedule[0])
        );
        const forceFutureDay =
            !prevFirstPreserved &&
            isTomorrowFirstBlockRequest(instruction, schedule[0].start, schedule.length);

        const nowStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const firstStartMins = parseTimeToMinutes(schedule[0].start);
        const nowMins = now.getHours() * 60 + now.getMinutes();
        const forwardDiff = (firstStartMins - nowMins + 1440) % 1440;
        const relNow = (nowMins - firstStartMins + 1440) % 1440;
        const explicitFutureStart = isExplicitFutureScheduleRequest(
            instruction,
            schedule[0].start,
            forwardDiff || 1440,
            schedule.length
        );
        const forceFutureStart =
            !forceFutureDay &&
            !prevFirstPreserved &&
            explicitFutureStart &&
            forwardDiff > 0 &&
            relNow > POST_OVERNIGHT_END_WINDOW_MINS;

        // Snap LLM clock-rounding drift (<= 60m ahead) to current time unless user explicitly requested a future time
        if (
            !forceFutureDay &&
            !forceFutureStart &&
            !prevFirstPreserved &&
            !isScheduleItemActive(schedule[0], now) &&
            forwardDiff > 0 &&
            forwardDiff <= 60 &&
            !explicitFutureStart
        ) {
            schedule[0].start = nowStr;
        }

        const anchoredSchedule = attachScheduleTimestamps(schedule, now, activePrevSchedule, {
            forceFutureDay,
            forceFutureStart,
            hasImmediateCue,
        });
        this.setSchedule(anchoredSchedule, true);
        return this.schedule;
    }

    shouldPreservePlaybackAfterScheduleChange(
        prevSchedule: ScheduleItem[],
        prevCurrentQuery: string | null,
        wasSessionActive: boolean
    ): boolean {
        return shouldPreserveActivePlaybackOnScheduleUpdate({
            prevSchedule,
            nextSchedule: this.schedule,
            prevCurrentQuery,
            isSessionActive: wasSessionActive,
        });
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

    private syncStandbyStatusAfterScheduleChange() {
        if (this.schedule.length === 0) {
            this.loggedStandbyStart = null;
            if (this.statusText.startsWith('⏰')) {
                this.statusText = 'Ready';
            }
            return;
        }
        if (isWaitingForScheduleStart(this.schedule)) {
            const firstStart = this.schedule[0].start;
            if (this.loggedStandbyStart !== firstStart) {
                this.loggedStandbyStart = null;
            }
            if (this.statusText === 'Ready' || this.statusText.startsWith('⏰')) {
                this.statusText = `⏰ Waiting for ${firstStart}... (${firstStart}の開始を待機中...)`;
            }
        } else {
            this.loggedStandbyStart = null;
            if (this.statusText.startsWith('⏰')) {
                this.statusText = 'Ready';
            }
        }
    }

    private clearCollidingLastQueryWhenWaiting() {
        if (this.schedule.length === 0) {
            this.lastQuery = null;
            removeStorageItem(STORAGE_KEYS.DJ_LAST_QUERY);
            return;
        }
        if (
            this.lastQuery &&
            isWaitingForScheduleStart(this.schedule) &&
            this.schedule.some(item => getScheduleItemSignature(item) === this.lastQuery)
        ) {
            this.lastQuery = null;
            removeStorageItem(STORAGE_KEYS.DJ_LAST_QUERY);
        }
    }

    setSchedule(schedule: ScheduleItem[], persist: boolean = false) {
        this.schedule = [...schedule];
        this.invalidatePreload();
        this.lastStartFailure = null;
        this.clearCollidingLastQueryWhenWaiting();
        this.syncStandbyStatusAfterScheduleChange();
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
            this.clearCollidingLastQueryWhenWaiting();
            this.syncStandbyStatusAfterScheduleChange();
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
        const isForegroundRecovery = this.pendingForegroundRecovery;
        this.pendingForegroundRecovery = false;
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
                if (this.loggedStandbyStart !== firstItem.start) {
                    this.loggedStandbyStart = firstItem.start;
                    this.addLog(`⏰ Scheduled to start at ${firstItem.start}. Standing by...`);
                }
                if (this.statusText !== waitStatus) {
                    this.updateStatus(waitStatus);
                }
                return;
            }
            this.loggedStandbyStart = null;

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
                } else {
                    const bypassFailureBackoff =
                        isForegroundRecovery &&
                        this.lastStartFailure?.category !== 'forbidden' &&
                        this.lastStartFailure?.category !== 'rate_limited';
                    if (
                        !bypassFailureBackoff &&
                        this.lastStartFailure &&
                        this.lastStartFailure.signature === querySignature &&
                        Date.now() - this.lastStartFailure.timestamp < this.lastStartFailure.retryAfterMs
                    ) {
                        return;
                    }
                }

                const currentGen = ++this.playbackGeneration;
                this.playerClient.clearLastError();
                const rawDevices = await this.getDevices();
                const devices = rawDevices.filter(d => !d.is_restricted);
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
                this.userExplicitlyPaused = false;
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
                // Same context: Check for Auto-Refill (Okawari) or unconfirmed-session recovery
                await this.checkAndRefillQueue(queriesToUse, currentItem, isForegroundRecovery);
            }
        } finally {
            this.activeLoopCount = Math.max(0, this.activeLoopCount - 1);
        }
    }

    // --- Auto-Refill & Unconfirmed Session Recovery Logic ---

    private async tryStartPendingSessionTracks(expectedGen: number) {
        const rawDevices = await this.getDevices();
        const devices = rawDevices.filter(d => !d.is_restricted);
        if (devices.length === 0 || expectedGen !== this.playbackGeneration || !this.isSessionPlaybackActive()) {
            return;
        }
        const sessionTracks = this.sessionCache.getSessionTracks();
        const startIdx = this.sessionCache.getSessionStartIndex();
        const tracksToPlay = sessionTracks.slice(startIdx);
        if (tracksToPlay.length === 0) {
            return;
        }
        this.lastRefillAttemptTime = Date.now();
        this.sessionCache.markTracksPlayed(sessionTracks);
        try {
            await this.playTracks(tracksToPlay, {
                isDJSession: true,
                fullSessionTracks: sessionTracks,
                sessionStartIndex: startIdx,
            });
        } catch (restoreErr) {
            console.warn("Unconfirmed session auto-start failed (will retry after cooldown or foreground):", restoreErr);
        }
    }

    private async checkAndRefillQueue(
        queries: string[],
        currentItem: ScheduleItem,
        isForegroundRecovery: boolean = false
    ) {
        if (this.isRefilling) return;

        // Do not auto-refill if there is no active ContextDJ session (e.g. external Spotify playback took over)
        if (!this.isSessionPlaybackActive()) {
            return;
        }

        const now = Date.now();
        const REFILL_COOLDOWN_MS = 60 * 1000;
        const bypassCooldownForUnconfirmedForeground =
            isForegroundRecovery && !this.hasConfirmedSessionPlayback && !this.userExplicitlyPaused;
        if (!bypassCooldownForUnconfirmedForeground && now - this.lastRefillAttemptTime < REFILL_COOLDOWN_MS) {
            return;
        }

        const refillGen = this.playbackGeneration;
        const playback = await this.getPlaybackState();

        // Re-verify session and generation are still active after getPlaybackState()
        if (refillGen !== this.playbackGeneration || !this.isSessionPlaybackActive()) {
            return;
        }

        // Never run Okawari refill before Track 1 of the session has ever been confirmed playing;
        // instead, recover unconfirmed sessions (restored from storage or missed initial mobile wake-up).
        if (!this.hasConfirmedSessionPlayback) {
            if (this.userExplicitlyPaused) {
                return;
            }

            const initiatedInRuntime = this.sessionCache.getHasInitiatedSessionInRuntime();
            const currentLastPlayTime = this.lastPlayTime;
            const elapsedSincePlay = currentLastPlayTime > 0 ? Date.now() - currentLastPlayTime : Infinity;

            if (!initiatedInRuntime) {
                if (!playback || !playback.is_playing) {
                    const isPausedOnSessionTrack = Boolean(
                        playback?.item &&
                        playback.item.type === 'track' &&
                        !playback.context?.uri &&
                        this.sessionCache.findTrackIndexInSession(playback.item as Track) >= 0
                    );
                    if (!isPausedOnSessionTrack) {
                        await this.tryStartPendingSessionTracks(refillGen);
                    }
                }
                return;
            }

            const canRecoverNow = isForegroundRecovery
                ? elapsedSincePlay >= 1500
                : (!playback?.__optimisticFallback && elapsedSincePlay >= PLAYBACK_CONSTANTS.STARTUP_GRACE_MS);

            const shouldRecoverEmptySwing =
                canRecoverNow &&
                (
                    !playback ||
                    Boolean(playback.__optimisticFallback) ||
                    !playback.is_playing ||
                    (currentLastPlayTime > 0 && elapsedSincePlay < 10 * 60 * 1000)
                );

            if (shouldRecoverEmptySwing) {
                await this.tryStartPendingSessionTracks(refillGen);
            }
            return;
        }

        if (!playback || !playback.is_playing) {
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
            const isUnconfirmedRuntimeSession =
                !this.hasConfirmedSessionPlayback &&
                this.sessionCache.getHasInitiatedSessionInRuntime();
            const isInStartupGrace =
                isUnconfirmedRuntimeSession &&
                this.lastPlayTime > 0 &&
                (now - this.lastPlayTime < PLAYBACK_CONSTANTS.STARTUP_GRACE_MS);

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

                if (isUnconfirmedRuntimeSession || this.lastKnownIsPlaying === false) {
                    return sessionTracks
                        .slice(sessionStartIndex + 1)
                        .map(t => this.sessionCache.enrichTrackWithCachedMetadata(t));
                }

                // Active track is not in sessionTracks, Spotify is actively playing, and session was already confirmed (or restored from storage):
                // User switched playback externally in the Spotify app -> prioritize Spotify's live queue.
                this.handleExternalPlaybackDetected(activeTrack);
            } else if (isUnconfirmedRuntimeSession || this.lastKnownIsPlaying === false) {
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
            const isUnconfirmedRuntimeSession =
                !this.hasConfirmedSessionPlayback &&
                this.sessionCache.getHasInitiatedSessionInRuntime();
            const isWaitingForStartupSwitch =
                isUnconfirmedRuntimeSession &&
                !this.userExplicitlyPaused &&
                this.lastPlayTime > 0 &&
                (now - this.lastPlayTime < PLAYBACK_CONSTANTS.STARTUP_GRACE_MS);
            const hasReachedStartTrack = isCurrentItemInSession && (
                this.hasConfirmedSessionPlayback ||
                !isWaitingForStartupSwitch ||
                sessionIndex === sessionStartIndex
            );
            // Guard against transient cloud-side progress_ms === 0 responses in the first 1.2s
            // before the mobile OS has actually granted audio focus and started advancing audio.
            const isPrematureZeroProgressMirage = Boolean(
                isUnconfirmedRuntimeSession &&
                typeof state?.progress_ms === 'number' &&
                state.progress_ms === 0 &&
                this.lastPlayTime > 0 &&
                (now - this.lastPlayTime < 1200)
            );

            if (hasReachedStartTrack && isSpotifyPlaying && !isPrematureZeroProgressMirage) {
                this.userExplicitlyPaused = false;
                this.sessionCache.confirmSessionPlayback();
                this.sessionCache.setSessionStartIndex(sessionIndex);
            } else if (this.hasConfirmedSessionPlayback && isCurrentItemInSession) {
                this.sessionCache.setSessionStartIndex(sessionIndex);
            }

            // Normalize shuffle=false / repeat=off only after playback is confirmed AND settled
            // (>= 1.5s since play or >= 1s into track progress) so mobile stream setup is never interrupted.
            if (
                this.hasConfirmedSessionPlayback &&
                isCurrentItemInSession &&
                isSpotifyPlaying &&
                !this.sessionCache.getHasNormalizedSessionModes() &&
                (
                    this.lastPlayTime === 0 ||
                    now - this.lastPlayTime >= 1500 ||
                    (typeof state?.progress_ms === 'number' && state.progress_ms >= 1000)
                )
            ) {
                this.sessionCache.setHasNormalizedSessionModes(true);
                if (typeof this.playerClient.ensurePlaybackModes === 'function') {
                    void this.playerClient.ensurePlaybackModes(state);
                }
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

            // Never wipe unconfirmed runtime sessionTracks on external-playback false positives
            // before Track 1 of the session has ever been confirmed playing on the device.
            const canDetectExternalTakeover =
                this.hasConfirmedSessionPlayback ||
                !this.sessionCache.getHasInitiatedSessionInRuntime();

            if (state && state.item && state.item.type === 'track') {
                const trackItem = state.item as Track;
                if (
                    isSpotifyPlaying &&
                    sessionTracks.length > 0 &&
                    !isCurrentItemInSession &&
                    canDetectExternalTakeover
                ) {
                    this.handleExternalPlaybackDetected(trackItem);
                }
                const enriched = this.sessionCache.enrichTrackWithCachedMetadata(trackItem);
                state.item = enriched;
                if (
                    isCurrentItemInSession ||
                    this.isExternalContextActive ||
                    sessionTracks.length === 0 ||
                    (isSpotifyPlaying && canDetectExternalTakeover)
                ) {
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
                canDetectExternalTakeover
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
        const currentItem = isWaitingForScheduleStart(this.schedule)
            ? null
            : (this.getCurrentItem() ?? this.getEffectiveItemForPlayback());
        return {
            currentScheduleItem: currentItem,
            currentQuery: this.lastQuery,
            currentThought: resolveScheduleThought(this.schedule, this.lastQuery),
            config: this.config
        };
    }

    private async shouldStartUnconfirmedSessionViaPlayTracks(): Promise<boolean> {
        const isUnconfirmedRuntimeSession =
            !this.hasConfirmedSessionPlayback &&
            this.sessionCache.getHasInitiatedSessionInRuntime();
        if (!isUnconfirmedRuntimeSession) {
            return false;
        }
        // If playTracks failed (lastPlayTime === 0, e.g. 404), { uris } never reached Spotify at all.
        if (this.lastPlayTime === 0) {
            return true;
        }
        // Otherwise playTracks returned 204; inspect whether Spotify actually loaded a session track
        // or empty-swung and stayed on the previous/external context.
        try {
            const state = await this.spotify.getMyCurrentPlaybackState();
            const hasExternalContextUri = Boolean(state?.context?.uri);
            const isLoadedInSession = Boolean(
                !hasExternalContextUri &&
                state?.device?.is_active &&
                state?.item &&
                state.item.type === 'track' &&
                this.sessionCache.findTrackIndexInSession(state.item as Track) >= 0
            );
            return !isLoadedInSession;
        } catch {
            return false;
        }
    }

    async next(): Promise<SpotifyControlResult> {
        const sessionTracks = this.sessionCache.getSessionTracks();
        const prevStartIndex = this.sessionCache.getSessionStartIndex();
        const prevPlayingTrack = this.lastPlayingTrack;
        let targetIdx = prevStartIndex;
        let didAdvanceSession = false;

        if (sessionTracks.length > 0 && !this.isExternalContextActive) {
            const lastPlaying = this.lastPlayingTrack;
            const currentIdx = lastPlaying ? this.sessionCache.findTrackIndexInSession(lastPlaying) : -1;
            const baseIdx = currentIdx >= 0 ? currentIdx : prevStartIndex;
            targetIdx = baseIdx;
            if (baseIdx + 1 < sessionTracks.length) {
                targetIdx = baseIdx + 1;
                this.sessionCache.setSessionStartIndex(targetIdx);
                this.lastPlayingTrack = sessionTracks[targetIdx];
                didAdvanceSession = true;
            }

            // When Track 1 of a newly curated runtime session has never been loaded onto Spotify,
            // Spotify's server queue still holds the user's old context; start sessionTracks from targetIdx cleanly.
            if (await this.shouldStartUnconfirmedSessionViaPlayTracks()) {
                try {
                    if (typeof this.playerClient.clearLastError === 'function') {
                        this.playerClient.clearLastError();
                    }
                    const tracksToPlay = sessionTracks.slice(targetIdx);
                    await this.playTracks(tracksToPlay, {
                        isDJSession: true,
                        fullSessionTracks: sessionTracks,
                        sessionStartIndex: targetIdx,
                    });
                    return { ok: true, status: 204 };
                } catch (e) {
                    if (didAdvanceSession) {
                        this.sessionCache.setSessionStartIndex(prevStartIndex);
                        this.sessionCache.setLastPlayingTrack(prevPlayingTrack, true);
                    }
                    const classified =
                        this.playerClient.reportThrownError(e, 'play') ??
                        (typeof this.playerClient.getLastError === 'function' ? this.playerClient.getLastError() : null);
                    return { ok: false, status: classified?.status, error: classified ?? undefined };
                }
            }
        }
        const res = await this.playerClient.next();
        if (!res.ok && didAdvanceSession) {
            this.sessionCache.setSessionStartIndex(prevStartIndex);
            this.lastPlayingTrack = prevPlayingTrack;
        }
        return res;
    }

    async previous(): Promise<SpotifyControlResult> {
        const sessionTracks = this.sessionCache.getSessionTracks();
        const prevStartIndex = this.sessionCache.getSessionStartIndex();
        const prevPlayingTrack = this.lastPlayingTrack;
        const prevPlayTime = this.sessionCache.getLastPlayTime();
        let targetIdx = prevStartIndex;
        let didMutateSession = false;

        if (sessionTracks.length > 0 && !this.isExternalContextActive) {
            const lastPlaying = this.lastPlayingTrack;
            const currentIdx = lastPlaying ? this.sessionCache.findTrackIndexInSession(lastPlaying) : -1;
            const baseIdx = currentIdx >= 0 ? currentIdx : prevStartIndex;
            targetIdx = baseIdx;
            if (baseIdx > 0) {
                targetIdx = baseIdx - 1;
                this.sessionCache.setSessionStartIndex(targetIdx);
                this.lastPlayingTrack = sessionTracks[targetIdx];
                didMutateSession = true;
            }

            if (await this.shouldStartUnconfirmedSessionViaPlayTracks()) {
                try {
                    if (typeof this.playerClient.clearLastError === 'function') {
                        this.playerClient.clearLastError();
                    }
                    const tracksToPlay = sessionTracks.slice(targetIdx);
                    await this.playTracks(tracksToPlay, {
                        isDJSession: true,
                        fullSessionTracks: sessionTracks,
                        sessionStartIndex: targetIdx,
                    });
                    return { ok: true, status: 204 };
                } catch (e) {
                    this.sessionCache.setSessionStartIndex(prevStartIndex);
                    this.sessionCache.setLastPlayingTrack(prevPlayingTrack, true);
                    this.sessionCache.setLastPlayTime(prevPlayTime);
                    const classified =
                        this.playerClient.reportThrownError(e, 'play') ??
                        (typeof this.playerClient.getLastError === 'function' ? this.playerClient.getLastError() : null);
                    return { ok: false, status: classified?.status, error: classified ?? undefined };
                }
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
            this.userExplicitlyPaused = true;
            if (!this.hasConfirmedSessionPlayback) {
                this.sessionCache.setLastPlayTime(0);
            }
        }
        return res;
    }

    async resume(): Promise<SpotifyControlResult> {
        this.userExplicitlyPaused = false;
        const sessionTracks = this.sessionCache.getSessionTracks();
        if (
            sessionTracks.length === 0 &&
            !this.isExternalContextActive &&
            this.schedule.length > 0 &&
            !isWaitingForScheduleStart(this.schedule)
        ) {
            try {
                if (typeof this.playerClient.clearLastError === 'function') {
                    this.playerClient.clearLastError();
                }
                await this.processDJLoop(false, true);
                return { ok: true, status: 204 };
            } catch (e) {
                const classified =
                    this.playerClient.reportThrownError(e, 'play') ??
                    (typeof this.playerClient.getLastError === 'function' ? this.playerClient.getLastError() : null);
                return { ok: false, status: classified?.status, error: classified ?? undefined };
            }
        }
        if (sessionTracks.length > 0 && !this.isExternalContextActive) {
            const isUnconfirmedRuntimeSession =
                !this.hasConfirmedSessionPlayback &&
                this.sessionCache.getHasInitiatedSessionInRuntime();
            let shouldStartSessionTracks = !this.hasConfirmedSessionPlayback;

            // Verify whether Spotify is currently on one of our session tracks on an active device
            // (skipped for unconfirmed runtime sessions so Track 1 always loads the full `{ uris }` queue cleanly).
            if (!isUnconfirmedRuntimeSession) {
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
            }

            if (shouldStartSessionTracks) {
                try {
                    if (typeof this.playerClient.clearLastError === 'function') {
                        this.playerClient.clearLastError();
                    }
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
                    const classified =
                        this.playerClient.reportThrownError(e, 'play') ??
                        (typeof this.playerClient.getLastError === 'function' ? this.playerClient.getLastError() : null);
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
