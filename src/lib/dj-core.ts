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
    Track,
} from './types';
import { getStorageItem, setStorageItem, removeStorageItem, getStoredJSON, setStoredJSON } from './storage';
import {
    generateTrackKey,
    isScheduleItemActive,
    getScheduleItemSignature,
    getScheduleItemQueries,
    parseTimeToMinutes,
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

    private isProcessingLoop = false;
    private playbackGeneration = 0;
    private isRefilling = false;
    private lastRefillAttemptTime = 0;
    private preloadedResult: { signature: string, tracks: Track[] } | null = null;
    private isPreloading = false;

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
        this.notifyStateListeners();
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

    async setActiveDevice(deviceId: string) {
        return this.playerClient.setActiveDevice(deviceId);
    }

    async playTracks(tracks: Track[], options?: { isDJSession?: boolean }) {
        if (tracks.length === 0) return;

        const isDJSession = options?.isDJSession ?? true;
        const uris = tracks.map(t => t.uri);

        try {
            const deviceId = await this.playerClient.resolveTargetDevice();
            console.log(`▶️ Playing ${uris.length} tracks on device ${deviceId}`);

            await this.playerClient.startPlaybackOnDevice(deviceId, uris);

            if (isDJSession) {
                this.sessionCache.activateDJSession(tracks, true);
            } else {
                this.sessionCache.activateExternalContext(true, true);
            }
            if (this.onTracksPlayed) {
                this.onTracksPlayed(tracks);
            }
        } catch (error) {
            console.error('Playback error:', error);
            throw error;
        }
    }

    async playFromQueueIndex(index: number, displayedQueue: Track[]) {
        if (index < 0 || index >= displayedQueue.length) return;

        if (this.isSessionPlaybackActive()) {
            const targetTrack = displayedQueue[index];
            const sessionTracks = this.sessionCache.getSessionTracks();
            const sessionIdx = this.sessionCache.findTrackIndexInSession(targetTrack);
            const tracksToPlay = sessionIdx >= 0
                ? sessionTracks.slice(sessionIdx)
                : displayedQueue.slice(index);
            await this.playTracks(tracksToPlay, { isDJSession: true });
        } else {
            await this.playTracks(displayedQueue.slice(index), { isDJSession: false });
        }
    }

    // --- Schedule Management ---

    getSchedule(): ScheduleItem[] {
        return this.schedule;
    }

    async createSchedule(instruction: string, personalContext?: string) {
        if (!this.ai) throw new Error("AI not initialized (AIが初期化されていません)");

        const schedule = await this.ai.generateSchedule(instruction, this.schedule, personalContext);

        // If first item starts slightly in the future (within 3 hours), align with now so playback starts immediately
        if (schedule.length > 0) {
            const now = new Date();
            const nowStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
            const firstStartMins = parseTimeToMinutes(schedule[0].start);
            const nowMins = now.getHours() * 60 + now.getMinutes();

            if (firstStartMins > nowMins && (firstStartMins - nowMins <= 180)) {
                schedule[0].start = nowStr;
            }
        }

        this.setSchedule(schedule, true);
        return schedule;
    }

    setSchedule(schedule: ScheduleItem[], persist: boolean = false) {
        this.schedule = schedule;
        if (persist) {
            setStoredJSON(STORAGE_KEYS.DJ_SCHEDULE, schedule);
        }
        this.notifyStateListeners();
    }

    removeScheduleItem(index: number, persist: boolean = false) {
        if (index >= 0 && index < this.schedule.length) {
            this.schedule.splice(index, 1);
            if (persist) {
                setStoredJSON(STORAGE_KEYS.DJ_SCHEDULE, this.schedule);
            }
            this.notifyStateListeners();
            return this.schedule;
        }
        return this.schedule;
    }

    getItemForDate(date: Date): ScheduleItem | null {
        for (const item of this.schedule) {
            if (isScheduleItemActive(item, date)) {
                return item;
            }
        }

        if (this.schedule.length === 1) {
            return this.schedule[0];
        }

        return null;
    }

    /**
     * Resolves the effective schedule item to play right now.
     * Guarantees the DJ will not stall silently if a schedule exists.
     */
    getEffectiveItemForPlayback(date: Date = new Date()): ScheduleItem | null {
        if (!this.schedule || this.schedule.length === 0) return null;

        const activeItem = this.getItemForDate(date);
        if (activeItem) return activeItem;

        const currentMins = date.getHours() * 60 + date.getMinutes();
        const firstItem = this.schedule[0];
        const firstStartMins = parseTimeToMinutes(firstItem.start);

        if (currentMins < firstStartMins) {
            return firstItem;
        }

        let bestItem: ScheduleItem = this.schedule[0];
        for (const item of this.schedule) {
            const startMins = parseTimeToMinutes(item.start);
            if (startMins <= currentMins) {
                bestItem = item;
            }
        }
        return bestItem;
    }

    getCurrentItem(): ScheduleItem | null {
        return this.getItemForDate(new Date());
    }

    // --- Main DJ Loop & Preloading ---

    async processDJLoop(silentWait: boolean = true, force: boolean = false) {
        if (this.isProcessingLoop && !force) {
            return;
        }
        this.isProcessingLoop = true;

        try {
            const now = new Date();
            const currentItem = this.getEffectiveItemForPlayback(now);

            // 1. Check if we need to PRELOAD for upcoming schedule (60 seconds ahead)
            if (this.schedule.length > 1) {
                const PRELOAD_MS = 60 * 1000;
                const futureDate = new Date(now.getTime() + PRELOAD_MS);
                const nextItem = this.getItemForDate(futureDate);

                if (nextItem) {
                    const nextSignature = getScheduleItemSignature(nextItem);
                    const queries = getScheduleItemQueries(nextItem);

                    if (nextSignature && nextSignature !== this.lastQuery &&
                        (!this.preloadedResult || this.preloadedResult.signature !== nextSignature)) {

                        if (!this.isPreloading) {
                            console.log(`⏳ Preloading tracks for upcoming schedule: ${nextSignature} `);
                            this.isPreloading = true;

                            this.searchTracks(queries, nextItem.priorityTrack, {
                                userRequest: nextItem.userRequest,
                                thought: nextItem.thought,
                                anchorTracks: nextItem.anchorTracks
                            }).then(tracks => {
                                console.log(`✅ Preloaded ${tracks.length} tracks for "${nextSignature}"`);
                                this.preloadedResult = {
                                    signature: nextSignature,
                                    tracks
                                };
                                this.isPreloading = false;
                            }).catch(err => {
                                console.error("Failed to preload:", err);
                                this.isPreloading = false;
                            });
                        }
                    }
                }
            }

            if (!currentItem) return;

            const queriesToUse = getScheduleItemQueries(currentItem);
            if (queriesToUse.length === 0) return;

            const querySignature = getScheduleItemSignature(currentItem);

            // 2. Check if we need to change music
            if (force || querySignature !== this.lastQuery) {
                const currentGen = ++this.playbackGeneration;
                console.log(`🎧 DJ Change${force ? ' (Forced)' : ''}: ${querySignature} `);
                this.lastQuery = querySignature;
                setStorageItem(STORAGE_KEYS.DJ_LAST_QUERY, querySignature);
                this.notifyStateListeners();

                this.addLog("──────── New Session Started ────────");
                this.sessionCache.resetSessionPlayedHistory();

                let tracks: Track[] = [];

                this.playerClient.clearLastError();
                const devices = await this.getDevices();
                if (devices.length === 0) {
                    const apiErr = this.playerClient.getLastError();
                    if (apiErr) {
                        this.lastQuery = null;
                        removeStorageItem(STORAGE_KEYS.DJ_LAST_QUERY);
                        this.updateStatus(`⚠️ ${apiErr.message}`);
                        if (!silentWait) {
                            throw new Error(apiErr.message);
                        }
                        return;
                    }
                    const msg = "No active Spotify device found. Please open Spotify on your device. (再生デバイスが見つかりません。Spotifyを開いてください)";
                    console.log(`⚠️ DJ Search skipped: ${msg}`);
                    this.updateStatus('⚠️ Please open Spotify (Spotifyを開いてください)');
                    this.addLog(`⚠️ ${msg}`);
                    if (!silentWait) {
                        throw new Error(msg);
                    }
                    return;
                }

                if (this.preloadedResult && this.preloadedResult.signature === querySignature) {
                    console.log(`🚀 Using Preloaded Tracks for ${querySignature}`);
                    tracks = this.preloadedResult.tracks;
                    this.preloadedResult = null;
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

                try {
                    this.sessionCache.markTracksPlayed(tracks);

                    this.updateStatus('▶️ Starting playback... (再生開始中...)');
                    await this.playTracks(tracks);
                    this.updateStatus('Ready');
                } catch (e) {
                    console.error("Playback failed, reverting DJ state to allow retry on next tick:", e);
                    this.lastQuery = null;
                    removeStorageItem(STORAGE_KEYS.DJ_LAST_QUERY);
                    this.notifyStateListeners();
                    throw e;
                }
            } else {
                // Same context: Check for Auto-Refill (Okawari)
                await this.checkAndRefillQueue(queriesToUse, currentItem);
            }
        } finally {
            this.isProcessingLoop = false;
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

        const playback = await this.getPlaybackState();
        if (!playback || !playback.device || !playback.device.is_active || !playback.is_playing) {
            return;
        }

        // Re-verify session is still active after getPlaybackState() checks for external playback takeover
        if (!this.isSessionPlaybackActive()) {
            return;
        }

        try {
            const activeItem = (playback.item && playback.item.type === 'track') ? (playback.item as Track) : null;
            const queue = await this.getQueue(activeItem);
            if (queue.length < PLAYBACK_CONSTANTS.MIN_QUEUE_SIZE_FOR_REFILL) {
                this.isRefilling = true;
                this.lastRefillAttemptTime = Date.now();
                this.addLog("🥣 Queue running low. Auto-Refill (Okawari) started...");

                const newTracks = await this.searchTracks(queries, undefined, {
                    userRequest: currentItem.userRequest,
                    thought: currentItem.thought,
                    anchorTracks: currentItem.anchorTracks
                });

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
                        const res = await this.playerClient.addToQueue(track.uri);
                        if (!res.ok) {
                            this.addLog(`⚠️ Queue refill interrupted (${res.status || 'ERR'}).`);
                            break;
                        }
                        this.sessionCache.markTrackPlayed(track);
                        addedTracks.push(track);
                        await new Promise(r => setTimeout(r, 200));
                    }
                    if (addedTracks.length > 0) {
                        this.sessionCache.appendSessionTracks(addedTracks);
                        this.addLog(`✅ Refill complete.`);
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
        const activeTrack = currentTrackOverride ?? this.lastPlayingTrack;
        const sessionTracks = this.sessionCache.getSessionTracks();
        const now = Date.now();

        if (sessionTracks.length > 0 && !this.isExternalContextActive) {
            if (activeTrack) {
                const foundIndex = this.sessionCache.findTrackIndexInSession(activeTrack);
                if (foundIndex >= 0) {
                    this.hasConfirmedSessionPlayback = true;
                    return sessionTracks
                        .slice(foundIndex + 1)
                        .map(t => this.sessionCache.enrichTrackWithCachedMetadata(t));
                }

                const isInStartupGrace = !this.hasConfirmedSessionPlayback &&
                    this.lastPlayTime > 0 &&
                    (now - this.lastPlayTime < 15000);

                if (isInStartupGrace) {
                    return sessionTracks
                        .slice(1)
                        .map(t => this.sessionCache.enrichTrackWithCachedMetadata(t));
                }

                // Active track is not in sessionTracks and startup grace has passed (or session already started):
                // User switched playback externally in the Spotify app -> prioritize Spotify's live queue.
                this.handleExternalPlaybackDetected(activeTrack);
            } else if (this.lastPlayTime > 0 && now - this.lastPlayTime < 15000) {
                return sessionTracks
                    .slice(1)
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
                while (enriched.length > 0) {
                    const first = enriched[0];
                    if (first.uri === activeUri || (activeKey && generateTrackKey(first) === activeKey)) {
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

            if (state?.device?.is_active && state.device.id) {
                this.playerClient.syncActiveDeviceId(state.device.id);
            }

            // ContextDJ always initiates playback via `{ uris }` (context === null).
            // Any non-null context URI (album, playlist, artist, collection) means playback came from Spotify externally.
            const hasExternalContextUri = Boolean(state?.context?.uri);
            const isCurrentItemInSession = Boolean(
                !hasExternalContextUri &&
                state?.item &&
                state.item.type === 'track' &&
                this.sessionCache.findTrackIndexInSession(state.item as Track) >= 0
            );

            if (isCurrentItemInSession) {
                this.sessionCache.confirmSessionPlayback();
            }

            const isInStartupGrace = !this.hasConfirmedSessionPlayback &&
                this.lastPlayTime > 0 &&
                (now - this.lastPlayTime < 6000);

            if (isInStartupGrace && sessionTracks.length > 0) {
                const firstSessionTrack = sessionTracks[0];
                const isPlayingOldTrack = Boolean((state?.item && !isCurrentItemInSession) || hasExternalContextUri);
                const isNoTrack = !state || !state.item;

                if (isNoTrack || isPlayingOldTrack) {
                    const enriched = this.sessionCache.enrichTrackWithCachedMetadata(firstSessionTrack);
                    this.lastPlayingTrack = enriched;
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
                    sessionTracks.length > 0 &&
                    !isCurrentItemInSession &&
                    (this.hasConfirmedSessionPlayback || !this.lastPlayTime || now - this.lastPlayTime >= 15000)
                ) {
                    this.handleExternalPlaybackDetected(trackItem);
                }
                const enriched = this.sessionCache.enrichTrackWithCachedMetadata(trackItem);
                state.item = enriched;
                this.lastPlayingTrack = enriched;
                return state;
            }

            const isNonTrackExternal = Boolean(
                state &&
                ((state.item && state.item.type !== 'track') ||
                    (state.currently_playing_type && state.currently_playing_type !== 'track' && state.currently_playing_type !== 'unknown'))
            );

            if (
                isNonTrackExternal &&
                sessionTracks.length > 0 &&
                (this.hasConfirmedSessionPlayback || !this.lastPlayTime || now - this.lastPlayTime >= 15000)
            ) {
                this.handleExternalPlaybackDetected({
                    name: state?.item?.name || state?.currently_playing_type || 'External Media',
                    artists: [{ name: 'Spotify' }]
                });
            }

            if (!state || !state.item) {
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

    async next() { return this.playerClient.next(); }
    async previous() { return this.playerClient.previous(); }
    async pause() { return this.playerClient.pause(); }
    async resume() { return this.playerClient.resume(); }
}
