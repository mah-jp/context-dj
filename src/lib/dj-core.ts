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
    DJTracksPlayedMeta,
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
    computeTargetTrackCountForSlot,
    filterActiveOrUpcomingSchedule,
    generateTrackKey,
    getRemainingSlotMinutes,
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
import {
    SpotifyPlayerClient,
    isMobileSpotifyDevice,
    selectTargetSpotifyDevice,
} from './spotify-player-client';
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
        aiFiltering: true,
        personalPreference: '',
    };
    private onStatusUpdate?: (status: string) => void;
    private onTracksPlayed?: (tracks: Track[], meta?: DJTracksPlayedMeta) => void;
    private onErrorUpdate?: DJErrorListener;
    private onDevicesUpdated?: (devices: SpotifyApi.UserDevice[]) => void;
    private stateListeners = new Set<DJStateListener>();
    private logListeners = new Set<DJLogListener>();
    private errorListeners = new Set<DJErrorListener>();

    private activeLoopCount = 0;
    private playbackGeneration = 0;
    private isRefilling = false;
    private lastRefillAttemptTime = 0;
    private lastBatchContinuationAttemptTime = 0;
    private inFlightBatchContinuationPromise: Promise<void> | null = null;
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
    private startupResumeKickCount = 0;
    private lastStartupResumeKickTime = 0;
    private lastSuccessfulStartupKickTime = 0;
    private isStartupKickInFlight = false;
    private manualBareResumeAttempted = false;
    private inFlightPlayGeneration: number | null = null;
    private inFlightPlayPromise: Promise<void> | null = null;
    private inFlightResumeCount = 0;
    private transportCommandSeq = 0;
    private devicesResolvedSeq = 0;
    private mobileWakeRequired = false;
    private mobileWakeInProgress = false;
    private activePlaybackSwitchBlocked = false;
    private lastKnownDevices: SpotifyApi.UserDevice[] = [];
    private mobileResumeVerifyDelayMs = 550;
    private mobileResumeRetryDelayMs = 400;
    private lastRawSessionTrackState: {
        inSession: boolean;
        loadedIndex: number;
        isPlaying: boolean;
        deviceId?: string;
        hasControllableDevice: boolean;
    } | null = null;

    constructor(accessToken: string) {
        this.spotify = new SpotifyWebApi();
        this.spotify.setAccessToken(accessToken);
        this.sessionCache = new TrackSessionCache();
        this.playerClient = new SpotifyPlayerClient(
            this.spotify,
            (errInfo) => {
                this.handleSpotifyApiError(errInfo);
            },
            {
                onDevicesResolved: (devices) => {
                    this.devicesResolvedSeq++;
                    this.lastKnownDevices = Array.isArray(devices) ? devices : [];
                    this.maybeArmMobileWakeOnEmptyDevices(this.lastKnownDevices);
                    this.onDevicesUpdated?.(devices);
                },
            }
        );
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
        this.config.personalPreference = getStorageItem(STORAGE_KEYS.PERSONAL_PREFERENCE, '');
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
        const isCriticalCategory =
            errInfo.category === 'auth_expired' ||
            errInfo.category === 'forbidden' ||
            errInfo.category === 'rate_limited';
        const suppressMobileAsleepToast =
            !isCriticalCategory &&
            (this.mobileWakeInProgress ||
                (errInfo.category === 'device_not_found' && this.canWakeLocalMobileSpotify()));
        if (suppressMobileAsleepToast) {
            return;
        }
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
            mobileWakeRequired: this.mobileWakeRequired,
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

    setOnTracksPlayedCallback(cb: (tracks: Track[], meta?: DJTracksPlayedMeta) => void) {
        this.onTracksPlayed = cb;
    }

    setErrorCallback(cb: DJErrorListener) {
        this.onErrorUpdate = cb;
    }

    setOnDevicesUpdatedCallback(cb?: (devices: SpotifyApi.UserDevice[]) => void) {
        this.onDevicesUpdated = cb;
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
        const seqBefore = this.devicesResolvedSeq;
        const usesNativeClientGetDevices =
            this.playerClient.getDevices === SpotifyPlayerClient.prototype.getDevices;
        const devices = await this.playerClient.getDevices();
        this.lastKnownDevices = Array.isArray(devices) ? devices : [];
        if (!usesNativeClientGetDevices && this.devicesResolvedSeq === seqBefore) {
            this.maybeArmMobileWakeOnEmptyDevices(this.lastKnownDevices);
            this.onDevicesUpdated?.(devices);
        }
        return devices;
    }

    private maybeArmMobileWakeOnEmptyDevices(devices: SpotifyApi.UserDevice[]) {
        const unrestricted = devices.filter(d => Boolean(d && d.id && !d.is_restricted));
        if (unrestricted.length > 0) {
            return;
        }
        const apiErr = typeof this.playerClient.getLastError === 'function'
            ? this.playerClient.getLastError()
            : null;
        if (
            !apiErr &&
            !this.userExplicitlyPaused &&
            this.lastKnownIsPlaying === false &&
            this.isSessionPlaybackActive() &&
            !this.isPlayTracksInFlight() &&
            !this.isResumeInFlight() &&
            !this.mobileWakeInProgress &&
            this.canWakeLocalMobileSpotify(devices)
        ) {
            this.setMobileWakeRequiredState(true);
            if (!this.statusText.startsWith('📱')) {
                this.updateStatus(
                    '📱 Tap "Wake Spotify & Play" to resume backgrounded Spotify (Spotifyを起動して再生を開始してください)'
                );
            }
        }
    }

    isMobileWakeRequired(): boolean {
        return this.mobileWakeRequired;
    }

    clearMobileWakeRequired() {
        this.setMobileWakeRequiredState(false);
    }

    setMobileWakeInProgress(active: boolean) {
        this.mobileWakeInProgress = active;
    }

    isMobileWakeInProgress(): boolean {
        return this.mobileWakeInProgress;
    }

    isResumeInFlight(): boolean {
        return this.inFlightResumeCount > 0;
    }

    private isKnownInactiveMobileDevice(deviceId?: string): boolean {
        if (!deviceId) return false;
        const fromClient =
            typeof this.playerClient.getKnownDevice === 'function'
                ? this.playerClient.getKnownDevice(deviceId)
                : null;
        const known = fromClient ?? this.lastKnownDevices.find(d => d.id === deviceId) ?? null;
        return Boolean(known && isMobileSpotifyDevice(known) && !known.is_active);
    }

    private setMobileWakeRequiredState(required: boolean) {
        if (this.mobileWakeRequired !== required) {
            this.mobileWakeRequired = required;
            this.notifyStateListeners();
        }
    }

    /**
     * Determines whether waking the local mobile Spotify app (`spotify:` URI intent) is
     * applicable for the current browser runtime and resolved/preferred Connect device.
     */
    canWakeLocalMobileSpotify(devicesOverride?: SpotifyApi.UserDevice[]): boolean {
        const isMobile = typeof this.playerClient.isMobileRuntime === 'function'
            ? this.playerClient.isMobileRuntime()
            : false;
        if (!isMobile) {
            return false;
        }
        const known = Array.isArray(devicesOverride) ? devicesOverride : this.lastKnownDevices;
        const preferredId = this.getPreferredDeviceId();
        if (preferredId) {
            const preferredDevice = known.find(d => d.id === preferredId && !d.is_restricted);
            if (preferredDevice) {
                return isMobileSpotifyDevice(preferredDevice);
            }
        }
        const unrestricted = known.filter(d => Boolean(d && d.id && !d.is_restricted));
        if (unrestricted.length === 0) {
            return true;
        }
        const chosen = selectTargetSpotifyDevice(unrestricted, {
            preferredDeviceId: preferredId,
            cachedActiveDeviceId:
                typeof this.playerClient.getActiveDeviceId === 'function'
                    ? this.playerClient.getActiveDeviceId()
                    : null,
            isMobile: true,
        });
        return chosen ? isMobileSpotifyDevice(chosen) : true;
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
            if (this.mobileWakeRequired) {
                this.lastStartupResumeKickTime = 0;
            }
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

    async setActiveDevice(deviceId: string, options?: { play?: boolean; deferTransfer?: boolean }) {
        const res = await this.playerClient.setActiveDevice(deviceId, options);
        if (res.ok) {
            if (!this.canWakeLocalMobileSpotify()) {
                this.setMobileWakeRequiredState(false);
            }
            if (this.lastStartFailure) {
                // Allow immediate retry on newly selected device while keeping cached curated tracks
                this.lastStartFailure.timestamp = 0;
            }
            if (!this.hasConfirmedSessionPlayback && !this.userExplicitlyPaused && this.isSessionPlaybackActive()) {
                this.activePlaybackSwitchBlocked = false;
                this.lastRefillAttemptTime = 0;
                this.pendingForegroundRecovery = true;
                this.sessionCache.setLastPlayTime(0);
            }
        }
        return res;
    }

    private isPlayTracksInFlight(): boolean {
        return (
            this.inFlightPlayGeneration !== null &&
            this.inFlightPlayGeneration === this.playbackGeneration
        );
    }

    private resetStartupResumeKicks() {
        this.startupResumeKickCount = 0;
        this.lastStartupResumeKickTime = 0;
        this.lastSuccessfulStartupKickTime = 0;
        this.manualBareResumeAttempted = false;
        this.lastRawSessionTrackState = null;
    }

    private triggerStartupPausedSessionKick(deviceId: string | undefined, expectedGen: number) {
        if (
            this.isPlayTracksInFlight() ||
            this.isResumeInFlight() ||
            this.mobileWakeRequired ||
            this.mobileWakeInProgress ||
            this.isStartupKickInFlight ||
            this.startupResumeKickCount >= 2 ||
            this.userExplicitlyPaused
        ) {
            return;
        }
        if (typeof this.playerClient.resume !== 'function') {
            return;
        }
        const now = Date.now();
        if (this.lastStartupResumeKickTime > 0 && now - this.lastStartupResumeKickTime < 1500) {
            return;
        }
        this.isStartupKickInFlight = true;
        this.startupResumeKickCount++;
        this.lastStartupResumeKickTime = now;
        const wakeCapableMobile = this.canWakeLocalMobileSpotify();
        const useForceTransfer = Boolean(deviceId && this.startupResumeKickCount >= 2);
        this.addLog('⚡ Session track loaded in paused state on Spotify; sending resume kick...');

        void this.playerClient
            .resume(deviceId, useForceTransfer ? { silent: true, forcePlayTransfer: true } : { silent: true })
            .then((res) => {
                if (expectedGen !== this.playbackGeneration || this.userExplicitlyPaused) {
                    return;
                }
                if (!wakeCapableMobile) {
                    if (res.ok) {
                        this.lastKnownIsPlaying = true;
                        this.lastSuccessfulStartupKickTime = Date.now();
                    }
                    return;
                }

                const minExpectedIdx = this.sessionCache.getSessionStartIndex();
                if (!res.ok) {
                    if (
                        !this.hasConfirmedSessionPlayback &&
                        (res.status === 404 || res.error?.category === 'device_not_found')
                    ) {
                        this.lastKnownIsPlaying = false;
                        this.lastSuccessfulStartupKickTime = 0;
                        this.sessionCache.setLastPlayTime(0);
                        this.setMobileWakeRequiredState(true);
                        this.addLog('📱 Startup resume kick hit asleep mobile Spotify (404). Staged for 1-tap wake.');
                        this.updateStatus(
                            '📱 Tap "Wake Spotify & Play" to resume backgrounded Spotify (Spotifyを起動して再生を開始してください)'
                        );
                    }
                    return;
                }

                return this.verifyMobileResumeStarted(deviceId, {
                    skipForceTransferRetry: useForceTransfer,
                    expectedGen,
                    minExpectedSessionIndex: minExpectedIdx,
                    shouldAbort: () =>
                        this.isPlayTracksInFlight() ||
                        this.isResumeInFlight() ||
                        this.mobileWakeInProgress,
                }).then((verifyResult) => {
                    if (
                        verifyResult === 'aborted' ||
                        expectedGen !== this.playbackGeneration ||
                        this.userExplicitlyPaused ||
                        this.hasConfirmedSessionPlayback
                    ) {
                        return;
                    }
                    if (verifyResult === 'blocked') {
                        this.lastKnownIsPlaying = false;
                        this.lastSuccessfulStartupKickTime = 0;
                        this.sessionCache.setLastPlayTime(0);
                        this.setMobileWakeRequiredState(true);
                        this.addLog('📱 Mobile Spotify remained paused in background after startup kick. Staged for 1-tap wake.');
                        this.updateStatus(
                            '📱 Tap "Wake Spotify & Play" to resume backgrounded Spotify (Spotifyを起動して再生を開始してください)'
                        );
                        return;
                    }
                    if (verifyResult === 'wrong_track') {
                        const sessionTracks = this.sessionCache.getSessionTracks();
                        const startIdx = this.sessionCache.getSessionStartIndex();
                        const slice = sessionTracks.slice(startIdx);
                        if (slice.length > 0) {
                            void this.playTracks(slice, {
                                isDJSession: true,
                                fullSessionTracks: sessionTracks,
                                sessionStartIndex: startIdx,
                            }).catch((err) => {
                                console.warn('Startup wrong-track escalation playTracks failed:', err);
                            });
                        }
                        return;
                    }
                    this.lastKnownIsPlaying = true;
                    this.lastSuccessfulStartupKickTime = Date.now();
                });
            })
            .catch((err) => {
                console.warn('Startup paused session resume kick failed:', err);
            })
            .finally(() => {
                this.isStartupKickInFlight = false;
            });
    }

    async playTracks(
        tracks: Track[],
        options?: {
            isDJSession?: boolean;
            fullSessionTracks?: Track[];
            sessionStartIndex?: number;
            fastFailForUserGesture?: boolean;
            fastFailOnEmpty?: boolean;
        }
    ) {
        if (tracks.length === 0) return;

        const isDJSession = options?.isDJSession ?? true;
        const fastFailGesture = options?.fastFailForUserGesture ?? false;
        const fastFailOnEmpty = options?.fastFailOnEmpty ?? false;
        const uris = tracks.map(t => t.uri);
        this.transportCommandSeq++;
        const playGen = ++this.playbackGeneration;
        this.inFlightPlayGeneration = playGen;

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
        let didSendInitialKick = false;

        // Stage session tracks with lastPlayTime = 0 while device discovery & startPlaybackOnDevice
        // are in flight so concurrent polls never fire premature startup kicks or wipe sessionTracks.
        if (isDJSession) {
            this.userExplicitlyPaused = false;
            this.activePlaybackSwitchBlocked = false;
            this.resetStartupResumeKicks();
            this.sessionCache.setSessionTracks(sessionList, false, startIdx);
            this.sessionCache.setLastPlayTime(0);
            this.sessionCache.setLastPlayingTrack(sessionList[startIdx] ?? null, false);
            this.sessionCache.setHasInitiatedSessionInRuntime(sessionList.length > 0);
        }

        const priorSessionUriSet = new Set<string>();
        const priorSessionKeySet = new Set<string>();
        const registerPriorTrack = (t: Track | null | undefined) => {
            if (!t) return;
            if (t.uri) priorSessionUriSet.add(t.uri);
            const linked = (t as { linked_from?: { uri?: string } }).linked_from?.uri;
            if (linked) priorSessionUriSet.add(linked);
            const k = generateTrackKey(t);
            if (k && k !== '|') priorSessionKeySet.add(k);
        };
        for (const t of prevTracks) {
            registerPriorTrack(t);
        }
        for (let i = 0; i < startIdx && i < sessionList.length; i++) {
            registerPriorTrack(sessionList[i]);
        }

        const runPlay = async () => {
            const deviceId = await this.playerClient.resolveTargetDevice(
                fastFailGesture
                    ? { maxAttempts: 2, pollDelayMs: 450, fastFailOnEmpty: true }
                    : fastFailOnEmpty
                        ? { fastFailOnEmpty: true }
                        : undefined
            );
            if (playGen !== this.playbackGeneration || this.userExplicitlyPaused) {
                if (playGen === this.playbackGeneration && isDJSession && this.userExplicitlyPaused) {
                    this.sessionCache.setSessionTracks(sessionList, true, startIdx);
                    this.sessionCache.setHasInitiatedSessionInRuntime(sessionList.length > 0);
                    this.sessionCache.setLastPlayTime(0);
                    this.sessionCache.setLastPlayingTrack(sessionList[startIdx] ?? null, true);
                    this.sessionCache.setHasConfirmedSessionPlayback(false);
                    this.sessionCache.setIsExternalContextActive(false);
                    this.lastKnownIsPlaying = false;
                }
                return;
            }
            console.log(`▶️ Playing ${uris.length} tracks on device ${deviceId}`);

            const expectedTrackKeys = tracks
                .map(t => generateTrackKey(t))
                .filter(k => Boolean(k && k !== '|'));
            const startResult = await this.playerClient.startPlaybackOnDevice(deviceId, uris, {
                shouldAbort: () => playGen !== this.playbackGeneration || this.userExplicitlyPaused,
                expectedTrackKeys,
                isSkippablePriorTrack: (track) => {
                    if (track.uri && priorSessionUriSet.has(track.uri)) {
                        return true;
                    }
                    const linked = (track as { linked_from?: { uri?: string } }).linked_from?.uri;
                    if (linked && priorSessionUriSet.has(linked)) {
                        return true;
                    }
                    const key = generateTrackKey(track);
                    if (key && key !== '|' && priorSessionKeySet.has(key)) {
                        return true;
                    }
                    return this.sessionCache.isKnownRefillCarryoverTrack(track);
                },
                fastFailForUserGesture: fastFailGesture,
                onResumeKickSent: () => {
                    didSendInitialKick = true;
                    const kickNow = Date.now();
                    this.lastStartupResumeKickTime = kickNow;
                    this.lastSuccessfulStartupKickTime = kickNow;
                },
            });
            if (playGen !== this.playbackGeneration) {
                return;
            }
            if (this.inFlightPlayGeneration === playGen) {
                this.inFlightPlayGeneration = null;
            }
            if ((isDJSession && this.userExplicitlyPaused) || startResult?.aborted) {
                if (isDJSession) {
                    this.sessionCache.setSessionTracks(sessionList, true, startIdx);
                    this.sessionCache.setHasInitiatedSessionInRuntime(sessionList.length > 0);
                    this.sessionCache.setLastPlayTime(0);
                    this.sessionCache.setLastPlayingTrack(sessionList[startIdx] ?? null, true);
                    this.sessionCache.setHasConfirmedSessionPlayback(false);
                    this.sessionCache.setIsExternalContextActive(false);
                    this.lastKnownIsPlaying = false;
                }
                return;
            }

            // When post-play verification proves Spotify did NOT start audio playback (e.g. Android 14+
            // Cached App Freezer or Background-FGS restrictions kept `com.spotify.music` frozen/paused
            // despite Spotify Cloud returning HTTP 204), NEVER stamp `lastPlayTime > 0` or
            // `lastKnownIsPlaying = true` (which would emit fake `__optimisticFallback` for ~8s).
            if (startResult && startResult.confirmedPlaying === false) {
                const isDeviceActivelyPlaying = Boolean(startResult.deviceActivelyPlaying);
                const isBufferingTargetOnAwakeDevice = Boolean(
                    isDeviceActivelyPlaying && startResult.targetTrackLoaded
                );
                const isActivelyPlayingOtherTrack = Boolean(
                    isDeviceActivelyPlaying && !startResult.targetTrackLoaded
                );
                const wakeLocalMobile = Boolean(
                    !isDeviceActivelyPlaying &&
                    startResult.isMobileTarget &&
                    this.canWakeLocalMobileSpotify()
                );
                this.lastKnownIsPlaying = false;
                this.lastSuccessfulStartupKickTime = 0;
                this.activePlaybackSwitchBlocked = isActivelyPlayingOtherTrack;
                if (wakeLocalMobile) {
                    this.lastStartupResumeKickTime = 0;
                } else {
                    this.lastRefillAttemptTime = Date.now();
                }
                if (isDJSession) {
                    this.sessionCache.setSessionTracks(sessionList, true, startIdx);
                    this.sessionCache.setHasInitiatedSessionInRuntime(sessionList.length > 0);
                    this.sessionCache.setLastPlayTime(0);
                    this.sessionCache.setLastPlayingTrack(sessionList[startIdx] ?? null, true);
                    this.sessionCache.setHasConfirmedSessionPlayback(false);
                    this.sessionCache.setIsExternalContextActive(false);
                    this.reconcilePendingStartFailureAfterManualPlay();
                } else {
                    this.sessionCache.activateExternalContext(false, true);
                }
                this.setMobileWakeRequiredState(wakeLocalMobile);
                if (wakeLocalMobile) {
                    const wakeMsg = '📱 Tap "Wake Spotify & Play" to resume backgrounded Spotify (Spotifyを起動して再生を開始してください)';
                    this.addLog('📱 Mobile Spotify is asleep or restricted in background. Staged tracks for 1-tap wake.');
                    this.updateStatus(wakeMsg);
                } else if (isBufferingTargetOnAwakeDevice) {
                    const bufferingMsg = '⏳ Selected track loaded on Spotify, buffering audio... (楽曲を読み込み中です...)';
                    this.addLog('⏳ Target track loaded on active Spotify device; waiting for stream progress.');
                    this.updateStatus(bufferingMsg);
                } else if (isActivelyPlayingOtherTrack) {
                    const switchFailMsg = '⚠️ Spotify is playing another track and did not switch yet. Tap Play or Next to retry. (別の楽曲が再生中のため切り替わりませんでした。再生または次へボタンで再試行してください)';
                    this.addLog('⚠️ Spotify device is actively playing another track and did not switch to the selected tracks yet.');
                    this.updateStatus(switchFailMsg);
                } else {
                    const pausedMsg = '⚠️ Spotify device remained paused. Tap Play or check Spotify. (再生が開始されませんでした。再生ボタンを押すかSpotifyを確認してください)';
                    this.addLog('⚠️ Spotify device accepted play request (204) but remained paused.');
                    this.updateStatus(pausedMsg);
                }
                if (this.onTracksPlayed) {
                    this.onTracksPlayed(tracks, {
                        confirmedPlaying: false,
                        mobileWakeRequired: wakeLocalMobile,
                    });
                }
                return;
            }

            this.activePlaybackSwitchBlocked = false;
            this.setMobileWakeRequiredState(false);
            if (
                this.statusText.startsWith('📱') ||
                this.statusText.startsWith('⚠️') ||
                this.statusText.startsWith('⏳')
            ) {
                this.updateStatus('Ready');
            }
            this.lastKnownIsPlaying = true;

            if (isDJSession) {
                this.sessionCache.activateDJSession(sessionList, true, startIdx);
                if (didSendInitialKick) {
                    const readyNow = this.sessionCache.getLastPlayTime();
                    this.lastStartupResumeKickTime = readyNow;
                    this.lastSuccessfulStartupKickTime = readyNow;
                }
                this.reconcilePendingStartFailureAfterManualPlay();
            } else {
                this.sessionCache.activateExternalContext(true, true);
            }
            if (this.onTracksPlayed) {
                this.onTracksPlayed(tracks, {
                    confirmedPlaying: true,
                    mobileWakeRequired: false,
                });
            }
        };

        const activePromise = runPlay();
        this.inFlightPlayPromise = activePromise;

        try {
            await activePromise;
        } catch (error) {
            if (playGen === this.playbackGeneration && isDJSession) {
                const isMidSessionJump = Boolean(prevConfirmed && prevTracks.length > 0 && options?.fullSessionTracks);
                const lastErr = typeof this.playerClient.getLastError === 'function'
                    ? this.playerClient.getLastError()
                    : null;
                const errMsg = error instanceof Error ? error.message : String(error);
                const isDeviceAsleepError =
                    lastErr?.category === 'device_not_found' ||
                    /No active device|device not found|404/i.test(errMsg);
                const shouldStageForMobileWake = isDeviceAsleepError && this.canWakeLocalMobileSpotify();

                if (isMidSessionJump && !shouldStageForMobileWake) {
                    this.sessionCache.setSessionTracks(prevTracks, false, prevStartIndex);
                    this.sessionCache.setLastPlayTime(prevPlayTime);
                    this.sessionCache.setLastPlayingTrack(prevPlayingTrack, false);
                    this.sessionCache.setHasConfirmedSessionPlayback(prevConfirmed);
                    this.sessionCache.setHasInitiatedSessionInRuntime(prevInitiated);
                    this.sessionCache.setIsExternalContextActive(prevExternal);
                    this.lastKnownIsPlaying = prevKnownPlaying;
                } else {
                    // Preserve newly curated or jumped session tracks (e.g. on 404 asleep device) so UI keeps the list
                    // and pressing Play / Wake Spotify or returning to the browser starts `startIdx` immediately without re-searching.
                    this.sessionCache.setSessionTracks(sessionList, true, startIdx);
                    this.sessionCache.setHasInitiatedSessionInRuntime(sessionList.length > 0);
                    this.sessionCache.setLastPlayTime(0);
                    this.sessionCache.setLastPlayingTrack(sessionList[startIdx] ?? null, true);
                    this.sessionCache.setHasConfirmedSessionPlayback(false);
                    this.sessionCache.setIsExternalContextActive(false);
                    this.lastKnownIsPlaying = false;

                    if (shouldStageForMobileWake) {
                        this.setMobileWakeRequiredState(true);
                        this.updateStatus(
                            '📱 Tap "Wake Spotify & Play" to resume backgrounded Spotify (Spotifyを起動して再生を開始してください)'
                        );
                        if (this.onTracksPlayed) {
                            this.onTracksPlayed(tracks, {
                                confirmedPlaying: false,
                                mobileWakeRequired: true,
                            });
                        }
                    }
                }
            }
            console.error('Playback error:', error);
            throw error;
        } finally {
            if (this.inFlightPlayGeneration === playGen) {
                this.inFlightPlayGeneration = null;
            }
            if (this.inFlightPlayPromise === activePromise) {
                this.inFlightPlayPromise = null;
            }
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
                fastFailOnEmpty: this.canWakeLocalMobileSpotify(),
            });
        } else {
            await this.playTracks(displayedQueue.slice(index), {
                isDJSession: false,
                fastFailOnEmpty: this.canWakeLocalMobileSpotify(),
            });
        }
    }

    /**
     * Synchronously stages a Next / Previous / Queue target track in `sessionCache` at `t = 0ms`
     * when `mobileWakeRequired` is already active so the caller can immediately launch `spotify:`
     * inside the synchronous user-gesture turn without awaiting network calls first.
     */
    stageNavigationForMobileWake(
        action:
            | { type: 'next' }
            | { type: 'previous' }
            | { type: 'queue'; index: number; displayedQueue: Track[] }
    ): Track | null {
        const sessionTracks = this.sessionCache.getSessionTracks();
        if (action.type === 'queue') {
            const { index, displayedQueue } = action;
            if (index < 0 || index >= displayedQueue.length) {
                return null;
            }
            const targetTrack = displayedQueue[index];
            const existingIdx = this.sessionCache.findTrackIndexInSession(targetTrack);
            if (existingIdx >= 0) {
                this.sessionCache.setSessionTracks(sessionTracks, true, existingIdx);
                this.sessionCache.setHasInitiatedSessionInRuntime(sessionTracks.length > 0);
                this.sessionCache.setLastPlayTime(0);
                this.sessionCache.setLastPlayingTrack(sessionTracks[existingIdx] ?? null, true);
                this.sessionCache.setHasConfirmedSessionPlayback(false);
                this.sessionCache.setIsExternalContextActive(false);
                this.lastKnownIsPlaying = false;
                if (this.onTracksPlayed) {
                    this.onTracksPlayed(sessionTracks.slice(existingIdx), {
                        confirmedPlaying: false,
                        mobileWakeRequired: true,
                    });
                }
                return sessionTracks[existingIdx] ?? null;
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
                this.sessionCache.setSessionTracks(fullTracks, true, effectiveIdx);
                this.sessionCache.setHasInitiatedSessionInRuntime(fullTracks.length > 0);
                this.sessionCache.setLastPlayTime(0);
                this.sessionCache.setLastPlayingTrack(fullTracks[effectiveIdx] ?? null, true);
                this.sessionCache.setHasConfirmedSessionPlayback(false);
                this.sessionCache.setIsExternalContextActive(false);
                this.lastKnownIsPlaying = false;
                if (this.onTracksPlayed) {
                    this.onTracksPlayed(fullTracks.slice(effectiveIdx), {
                        confirmedPlaying: false,
                        mobileWakeRequired: true,
                    });
                }
                return fullTracks[effectiveIdx] ?? null;
            }
            return null;
        }

        if (sessionTracks.length === 0 || this.isExternalContextActive) {
            return null;
        }
        if (action.type === 'next' && this.sessionCache.isBatchExhausted()) {
            // Preserve `batchExhausted = true` so `dj.resume({ fromMobileWake: true })` curates
            // and starts the next fresh DJ set instead of replaying the final track of Batch 1.
            this.lastKnownIsPlaying = false;
            return this.lastPlayingTrack;
        }
        const prevStartIndex = this.sessionCache.getSessionStartIndex();
        const lastPlaying = this.lastPlayingTrack;
        const currentIdx = lastPlaying ? this.sessionCache.findTrackIndexInSession(lastPlaying) : -1;
        const baseIdx = currentIdx >= 0 ? currentIdx : prevStartIndex;
        const targetIdx =
            action.type === 'next'
                ? (baseIdx + 1 < sessionTracks.length ? baseIdx + 1 : baseIdx)
                : (baseIdx > 0 ? baseIdx - 1 : baseIdx);

        this.sessionCache.setSessionTracks(sessionTracks, true, targetIdx);
        this.sessionCache.setHasInitiatedSessionInRuntime(sessionTracks.length > 0);
        this.sessionCache.setLastPlayTime(0);
        this.sessionCache.setLastPlayingTrack(sessionTracks[targetIdx] ?? null, true);
        this.sessionCache.setHasConfirmedSessionPlayback(false);
        this.sessionCache.setIsExternalContextActive(false);
        this.lastKnownIsPlaying = false;
        if (this.onTracksPlayed) {
            this.onTracksPlayed(sessionTracks.slice(targetIdx), {
                confirmedPlaying: false,
                mobileWakeRequired: true,
            });
        }
        return sessionTracks[targetIdx] ?? null;
    }

    // --- Schedule Management ---

    getSchedule(): ScheduleItem[] {
        return this.schedule;
    }

    async createSchedule(instruction: string, personalContext?: string) {
        if (!this.ai) throw new Error("AI not initialized. Please configure your AI API Key in Settings. (AIが初期化されていません。設定画面でAPIキーを設定してください)");

        if (personalContext !== undefined) {
            this.config.personalPreference = personalContext;
        }
        const effectivePersonalContext = personalContext ?? (this.config.personalPreference || undefined);
        const activePrevSchedule = filterActiveOrUpcomingSchedule(this.schedule, new Date());
        const schedule = await this.ai.generateSchedule(instruction, activePrevSchedule, effectivePersonalContext);
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
        const firstEndMins = parseTimeToMinutes(schedule[0].end);
        const nowMins = now.getHours() * 60 + now.getMinutes();
        const forwardDiff = (firstStartMins - nowMins + 1440) % 1440;
        const relNow = (nowMins - firstStartMins + 1440) % 1440;
        const isAlreadyActiveAllDaySlot =
            firstStartMins < firstEndMins &&
            firstStartMins <= nowMins &&
            nowMins < firstEndMins;
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
            !isAlreadyActiveAllDaySlot &&
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

        const preloadApproxDate = new Date(Date.now() + 60_000);
        const preloadTargetCount = computeTargetTrackCountForSlot(nextItem, preloadApproxDate);

        const preloadPromise = this.searchTracks(queries, nextItem.priorityTrack, {
            userRequest: nextItem.userRequest,
            thought: nextItem.thought,
            anchorTracks: nextItem.anchorTracks,
            targetTrackCount: preloadTargetCount,
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
                const apiErr = this.playerClient.getLastError();
                if (devices.length === 0 && apiErr) {
                    this.lastQuery = null;
                    removeStorageItem(STORAGE_KEYS.DJ_LAST_QUERY);
                    this.updateStatus(`⚠️ ${apiErr.message}`);
                    if (!silentWait) {
                        throw new Error(apiErr.message);
                    }
                    return;
                }
                const canStageForMobileWakeWithoutDevices =
                    devices.length === 0 && !apiErr && this.canWakeLocalMobileSpotify(rawDevices);
                if (devices.length === 0 && !canStageForMobileWakeWithoutDevices) {
                    this.lastQuery = null;
                    removeStorageItem(STORAGE_KEYS.DJ_LAST_QUERY);
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
                this.lastRefillAttemptTime = 0;
                this.lastBatchContinuationAttemptTime = 0;
                this.resetStartupResumeKicks();
                this.sessionCache.resetSessionPlayedHistory();

                const targetTrackCount = computeTargetTrackCountForSlot(currentItem, now);
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
                            anchorTracks: currentItem.anchorTracks,
                            targetTrackCount,
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
                        anchorTracks: currentItem.anchorTracks,
                        targetTrackCount,
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

                if (canStageForMobileWakeWithoutDevices) {
                    this.sessionCache.markTracksPlayed(tracks);
                    this.sessionCache.setSessionTracks(tracks, true, 0);
                    this.sessionCache.setHasInitiatedSessionInRuntime(tracks.length > 0);
                    this.sessionCache.setLastPlayTime(0);
                    this.sessionCache.setLastPlayingTrack(tracks[0] ?? null, true);
                    this.sessionCache.setHasConfirmedSessionPlayback(false);
                    this.sessionCache.setIsExternalContextActive(false);
                    this.lastKnownIsPlaying = false;
                    this.lastStartFailure = null;
                    this.setMobileWakeRequiredState(true);
                    const wakeMsg = '📱 Tap "Wake Spotify & Play" to resume backgrounded Spotify (Spotifyを起動して再生を開始してください)';
                    this.addLog('📱 Mobile Spotify is asleep (no active Connect device). Curated and staged tracks for 1-tap wake.');
                    this.updateStatus(wakeMsg);
                    if (this.onTracksPlayed) {
                        this.onTracksPlayed(tracks, {
                            confirmedPlaying: false,
                            mobileWakeRequired: true,
                        });
                    }
                    return;
                }

                try {
                    this.sessionCache.markTracksPlayed(tracks);

                    this.updateStatus('▶️ Starting playback... (再生開始中...)');
                    await this.playTracks(tracks, { fastFailForUserGesture: false });
                    this.lastStartFailure = null;
                    if (!this.mobileWakeRequired && !this.statusText.startsWith('⚠️')) {
                        this.updateStatus('Ready');
                    }
                } catch (e) {
                    if (this.mobileWakeRequired) {
                        // Mobile Spotify froze or went asleep during AI curation (HTTP 404).
                        // `playTracks` already staged `sessionTracks` + `mobileWakeRequired = true`.
                        // Keep `lastQuery` intact and return cleanly so UI shows the 1-tap Wake prompt without an error toast.
                        this.lastStartFailure = null;
                        return;
                    }
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
            if (
                devices.length === 0 &&
                expectedGen === this.playbackGeneration &&
                this.isSessionPlaybackActive() &&
                !this.userExplicitlyPaused &&
                !this.playerClient.getLastError() &&
                this.canWakeLocalMobileSpotify(rawDevices)
            ) {
                this.lastKnownIsPlaying = false;
                this.sessionCache.setLastPlayTime(0);
                this.setMobileWakeRequiredState(true);
                if (!this.statusText.startsWith('📱')) {
                    this.updateStatus(
                        '📱 Tap "Wake Spotify & Play" to resume backgrounded Spotify (Spotifyを起動して再生を開始してください)'
                    );
                }
            }
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
        if (this.isRefilling || this.isPlayTracksInFlight() || this.isResumeInFlight() || this.mobileWakeInProgress) {
            return;
        }

        // Do not auto-refill if there is no active ContextDJ session (e.g. external Spotify playback took over)
        if (!this.isSessionPlaybackActive()) {
            return;
        }

        const now = Date.now();
        const REFILL_COOLDOWN_MS = 60 * 1000;
        const bypassCooldownForUnconfirmedForeground =
            isForegroundRecovery && !this.hasConfirmedSessionPlayback && !this.userExplicitlyPaused;
        const bypassCooldownForBatchExhaustion =
            this.sessionCache.isBatchExhausted() &&
            !this.userExplicitlyPaused &&
            now - this.lastBatchContinuationAttemptTime >= 15_000;
        if (
            !bypassCooldownForUnconfirmedForeground &&
            !bypassCooldownForBatchExhaustion &&
            now - this.lastRefillAttemptTime < REFILL_COOLDOWN_MS
        ) {
            return;
        }

        const refillGen = this.playbackGeneration;
        const playback = await this.getPlaybackState();

        // Re-verify session and generation are still active after getPlaybackState()
        if (
            refillGen !== this.playbackGeneration ||
            this.isPlayTracksInFlight() ||
            this.isResumeInFlight() ||
            this.mobileWakeInProgress ||
            !this.isSessionPlaybackActive()
        ) {
            return;
        }

        // If the active session's curated `{ uris }` batch finished naturally (Trap 2A: paused at 0ms on Track 0,
        // or Trap 2B: Spotify Autoplay kicked in after the final track), curate & play/stage the next fresh set!
        if (this.sessionCache.isBatchExhausted() && !this.userExplicitlyPaused) {
            if (Date.now() - this.lastBatchContinuationAttemptTime >= 15_000) {
                await this.continueExhaustedSessionBatch(queries, currentItem, refillGen);
            }
            return;
        }

        // Never run Okawari refill before Track 1 of the session has ever been confirmed playing;
        // instead, recover unconfirmed sessions (restored from storage or missed initial mobile wake-up).
        if (!this.hasConfirmedSessionPlayback) {
            if (this.userExplicitlyPaused) {
                return;
            }
            // While waiting for a 1-tap mobile Spotify wake (`spotify:` URI intent), suppress background
            // auto-retry loops that cannot bypass Android BFGS; recover immediately upon foreground return.
            if (this.mobileWakeRequired && !isForegroundRecovery) {
                return;
            }
            // If `playTracks` already tried all switch strategies against an actively playing device and Spotify
            // remained locked on another track (e.g. Spotify Jam / restricted external context), do NOT hammer
            // `PUT /play` every 60s in the background (which repeatedly rewinds the user's playing song to 0:00).
            if (this.activePlaybackSwitchBlocked && playback?.is_playing) {
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
                    !this.lastRawSessionTrackState?.inSession ||
                    (currentLastPlayTime > 0 && elapsedSincePlay < 10 * 60 * 1000)
                );

            if (shouldRecoverEmptySwing) {
                if (playback?.__optimisticFallback && this.lastRawSessionTrackState?.inSession) {
                    if (this.lastRawSessionTrackState.isPlaying) {
                        return;
                    }
                }
                const postInspectNow = Date.now();
                if (
                    this.isStartupKickInFlight ||
                    (this.lastStartupResumeKickTime > 0 && postInspectNow - this.lastStartupResumeKickTime < 1500)
                ) {
                    return;
                }
                const rawFallbackSessionState =
                    playback?.__optimisticFallback && this.lastRawSessionTrackState?.inSession
                        ? this.lastRawSessionTrackState
                        : null;
                const loadedIdx = rawFallbackSessionState
                    ? rawFallbackSessionState.loadedIndex
                    : playback?.item && playback.item.type === 'track'
                        ? this.sessionCache.findTrackIndexInSession(playback.item as Track)
                        : -1;
                const minExpectedIdx = this.sessionCache.getHasInitiatedSessionInRuntime()
                    ? this.sessionCache.getSessionStartIndex()
                    : 0;
                const isLoadedPausedSessionTrack = rawFallbackSessionState
                    ? Boolean(
                        !rawFallbackSessionState.isPlaying &&
                        rawFallbackSessionState.hasControllableDevice &&
                        loadedIdx >= minExpectedIdx
                    )
                    : Boolean(
                        !playback?.__optimisticFallback &&
                        !playback?.is_playing &&
                        !playback?.context?.uri &&
                        (playback?.device?.is_active || playback?.device?.id) &&
                        !playback?.device?.is_restricted &&
                        loadedIdx >= minExpectedIdx
                    );
                const wakeCapableMobile = this.canWakeLocalMobileSpotify();
                const refillCmdSeq = this.transportCommandSeq;
                let resumedLoadedTrack = false;
                let suppressPendingSessionRetry = false;
                if (
                    isLoadedPausedSessionTrack &&
                    (this.startupResumeKickCount < 2 || (isForegroundRecovery && this.mobileWakeRequired)) &&
                    typeof this.playerClient.resume === 'function'
                ) {
                    const wasMobileWakeRequired = this.mobileWakeRequired;
                    this.startupResumeKickCount++;
                    this.lastRefillAttemptTime = postInspectNow;
                    this.lastStartupResumeKickTime = postInspectNow;
                    this.addLog('⚡ Resuming paused session track loaded on Spotify device...');
                    const resumeDeviceId =
                        rawFallbackSessionState?.deviceId ||
                        playback?.device?.id ||
                        (typeof this.playerClient.getActiveDeviceId === 'function'
                            ? this.playerClient.getActiveDeviceId() || undefined
                            : undefined);
                    const isInactiveMobileLoadedDevice = Boolean(
                        wakeCapableMobile &&
                        ((playback?.device && !playback.device.is_active && isMobileSpotifyDevice(playback.device)) ||
                            this.isKnownInactiveMobileDevice(resumeDeviceId))
                    );
                    const useForceTransfer = Boolean(
                        resumeDeviceId && (this.startupResumeKickCount >= 2 || isInactiveMobileLoadedDevice)
                    );
                    const res = await this.playerClient.resume(
                        resumeDeviceId,
                        useForceTransfer ? { silent: true, forcePlayTransfer: true } : { silent: true }
                    );
                    if (
                        refillGen !== this.playbackGeneration ||
                        refillCmdSeq !== this.transportCommandSeq ||
                        this.userExplicitlyPaused ||
                        this.isPlayTracksInFlight() ||
                        this.isResumeInFlight() ||
                        this.mobileWakeInProgress
                    ) {
                        return;
                    }
                    if (res.ok) {
                        if (wakeCapableMobile) {
                            const verifyResult = await this.verifyMobileResumeStarted(resumeDeviceId, {
                                skipForceTransferRetry: useForceTransfer,
                                expectedGen: refillGen,
                                expectedTransportSeq: refillCmdSeq,
                                minExpectedSessionIndex: minExpectedIdx,
                                shouldAbort: () =>
                                    this.isPlayTracksInFlight() ||
                                    this.isResumeInFlight() ||
                                    this.mobileWakeInProgress,
                            });
                            if (
                                verifyResult === 'aborted' ||
                                refillGen !== this.playbackGeneration ||
                                refillCmdSeq !== this.transportCommandSeq ||
                                this.userExplicitlyPaused ||
                                this.isPlayTracksInFlight() ||
                                this.isResumeInFlight() ||
                                this.mobileWakeInProgress
                            ) {
                                return;
                            }
                            if (verifyResult === 'blocked') {
                                this.lastKnownIsPlaying = false;
                                this.lastSuccessfulStartupKickTime = 0;
                                this.sessionCache.setSessionStartIndex(loadedIdx);
                                this.sessionCache.setLastPlayTime(0);
                                if (wasMobileWakeRequired || this.mobileWakeRequired) {
                                    this.setMobileWakeRequiredState(true);
                                    suppressPendingSessionRetry = true;
                                }
                            } else if (verifyResult === 'wrong_track') {
                                // `forcePlayTransfer` woke the mobile device onto a leftover external/older track;
                                // keep `resumedLoadedTrack = false` so we escalate to `tryStartPendingSessionTracks`.
                                this.sessionCache.setSessionStartIndex(loadedIdx);
                            } else {
                                resumedLoadedTrack = true;
                                const resumedSessionTracks = this.sessionCache.getSessionTracks();
                                this.setMobileWakeRequiredState(false);
                                if (this.statusText.startsWith('📱') || this.statusText.startsWith('⚠️')) {
                                    this.updateStatus('Ready');
                                }
                                this.lastKnownIsPlaying = true;
                                const verifiedNow = Date.now();
                                this.lastSuccessfulStartupKickTime = verifiedNow;
                                this.sessionCache.setSessionStartIndex(loadedIdx);
                                if (resumedSessionTracks[loadedIdx]) {
                                    this.lastPlayingTrack = resumedSessionTracks[loadedIdx];
                                }
                                this.sessionCache.setLastPlayTime(verifiedNow);
                                this.reconcilePendingStartFailureAfterManualPlay();
                            }
                        } else {
                            resumedLoadedTrack = true;
                            if (refillGen === this.playbackGeneration && !this.userExplicitlyPaused) {
                                this.lastKnownIsPlaying = true;
                                this.lastSuccessfulStartupKickTime = Date.now();
                                this.sessionCache.setSessionStartIndex(loadedIdx);
                                if (this.lastPlayTime === 0) {
                                    this.sessionCache.setLastPlayTime(Date.now());
                                }
                            }
                        }
                    } else if (
                        wakeCapableMobile &&
                        (wasMobileWakeRequired || this.mobileWakeRequired) &&
                        (res.status === 404 || res.error?.category === 'device_not_found')
                    ) {
                        this.lastKnownIsPlaying = false;
                        this.lastSuccessfulStartupKickTime = 0;
                        this.sessionCache.setLastPlayTime(0);
                        this.setMobileWakeRequiredState(true);
                        suppressPendingSessionRetry = true;
                    }
                }
                if (
                    !resumedLoadedTrack &&
                    !suppressPendingSessionRetry &&
                    refillGen === this.playbackGeneration &&
                    refillCmdSeq === this.transportCommandSeq &&
                    !this.userExplicitlyPaused &&
                    !this.isPlayTracksInFlight() &&
                    !this.isResumeInFlight() &&
                    !this.mobileWakeInProgress
                ) {
                    await this.tryStartPendingSessionTracks(refillGen);
                }
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
                // Avoid dumping tracks into Spotify's persistent User Queue right before a scheduled block boundary,
                // because User Queue items survive `PUT /v1/me/player/play { uris }` into the next block.
                let maxRefillCount = 5;
                if (this.schedule.length > 1) {
                    const checkNow = new Date();
                    if (isScheduleItemActive(currentItem, checkNow)) {
                        const remSlotMins = getRemainingSlotMinutes(currentItem, checkNow);
                        const afterSlotDate = new Date(checkNow.getTime() + (remSlotMins + 1) * 60_000);
                        const nextBlock = findStrictlyActiveScheduleItem(this.schedule, afterSlotDate);
                        const hasUpcomingTransition = Boolean(
                            nextBlock && getScheduleItemSignature(nextBlock) !== getScheduleItemSignature(currentItem)
                        );
                        if (hasUpcomingTransition) {
                            const currentTrackRemMs =
                                activeItem && typeof activeItem.duration_ms === 'number' && typeof playback.progress_ms === 'number'
                                    ? Math.max(0, activeItem.duration_ms - playback.progress_ms)
                                    : 120_000;
                            const queueDurationMs = queue.reduce(
                                (sum, t) => sum + ((t as Track).duration_ms || 210_000),
                                0
                            );
                            const coveredMs = currentTrackRemMs + queueDurationMs;
                            const neededMs = remSlotMins * 60_000 - coveredMs;
                            if (neededMs <= 60_000) {
                                return;
                            }
                            maxRefillCount = Math.max(1, Math.min(5, Math.ceil(neededMs / 180_000)));
                        }
                    }
                }

                this.isRefilling = true;
                this.lastRefillAttemptTime = Date.now();
                this.addLog("🥣 Queue running low. Auto-Refill (Okawari) started...");

                const newTracks = await this.searchTracks(queries, undefined, {
                    userRequest: currentItem.userRequest,
                    thought: currentItem.thought,
                    anchorTracks: currentItem.anchorTracks,
                    targetTrackCount: 10,
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

                const toAdd = candidates.slice(0, maxRefillCount);

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
                        this.sessionCache.recordRefillQueuedTrack(track);
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

    private async continueExhaustedSessionBatch(
        queries: string[],
        currentItem: ScheduleItem,
        expectedGen: number,
        options?: { fastFailOnEmpty?: boolean }
    ): Promise<void> {
        if (this.inFlightBatchContinuationPromise) {
            await this.inFlightBatchContinuationPromise;
            return;
        }
        if (this.isRefilling) return;
        this.isRefilling = true;
        const attemptAt = Date.now();
        this.lastBatchContinuationAttemptTime = attemptAt;
        this.lastRefillAttemptTime = attemptAt;
        this.addLog("🔄 Session set finished. Curating next fresh DJ batch...");

        const runContinuation = async () => {
            const now = new Date();
            const targetTrackCount = computeTargetTrackCountForSlot(currentItem, now);
            let nextTracks = await this.searchTracks(queries, undefined, {
                userRequest: currentItem.userRequest,
                thought: currentItem.thought,
                anchorTracks: currentItem.anchorTracks,
                targetTrackCount,
            });
            let candidates = nextTracks.filter(t => !this.sessionCache.isTrackPlayedInSession(t));

            // If a small/niche catalog has played through every available track across multiple sets,
            // reset session played history (excluding the last played track) so continuous DJ radio keeps flowing.
            if (candidates.length === 0 && expectedGen === this.playbackGeneration && !this.userExplicitlyPaused) {
                const prevFinalTrack = this.sessionCache.getSessionTracks().slice(-1)[0] ?? null;
                this.sessionCache.resetSessionPlayedHistory();
                if (prevFinalTrack) {
                    this.sessionCache.markTrackPlayed(prevFinalTrack);
                }
                nextTracks = await this.searchTracks(queries, undefined, {
                    userRequest: currentItem.userRequest,
                    thought: currentItem.thought,
                    anchorTracks: currentItem.anchorTracks,
                    targetTrackCount,
                });
                candidates = nextTracks.filter(t => !this.sessionCache.isTrackPlayedInSession(t));
            }

            if (
                expectedGen !== this.playbackGeneration ||
                this.userExplicitlyPaused ||
                !this.isSessionPlaybackActive()
            ) {
                return;
            }

            if (candidates.length === 0) {
                this.addLog("⚠️ Could not find fresh tracks for next DJ batch.");
                return;
            }

            this.playerClient.clearLastError?.();
            const rawDevices = await this.getDevices();
            const devices = rawDevices.filter(d => !d.is_restricted);
            const apiErr = this.playerClient.getLastError?.() ?? null;

            if (
                expectedGen !== this.playbackGeneration ||
                this.userExplicitlyPaused ||
                !this.isSessionPlaybackActive()
            ) {
                return;
            }

            this.sessionCache.markTracksPlayed(candidates);

            if (devices.length === 0 && !apiErr && this.canWakeLocalMobileSpotify(rawDevices)) {
                this.sessionCache.setSessionTracks(candidates, true, 0);
                this.sessionCache.setHasInitiatedSessionInRuntime(candidates.length > 0);
                this.sessionCache.setLastPlayTime(0);
                this.sessionCache.setLastPlayingTrack(candidates[0] ?? null, true);
                this.sessionCache.setHasConfirmedSessionPlayback(false);
                this.sessionCache.setIsExternalContextActive(false);
                this.lastKnownIsPlaying = false;
                this.setMobileWakeRequiredState(true);
                const wakeMsg = '📱 Tap "Wake Spotify & Play" to resume backgrounded Spotify (Spotifyを起動して再生を開始してください)';
                this.addLog(`📱 Staged ${candidates.length} fresh tracks for next DJ set (tap Wake Spotify & Play).`);
                this.updateStatus(wakeMsg);
                if (this.onTracksPlayed) {
                    this.onTracksPlayed(candidates, {
                        confirmedPlaying: false,
                        mobileWakeRequired: true,
                    });
                }
                return;
            }

            try {
                this.updateStatus('▶️ Starting next curated set... (次の選曲セットを再生開始中...)');
                await this.playTracks(candidates, {
                    isDJSession: true,
                    fastFailForUserGesture: false,
                    fastFailOnEmpty: options?.fastFailOnEmpty ?? false,
                });
                if (!this.mobileWakeRequired && !this.statusText.startsWith('⚠️')) {
                    this.updateStatus('Ready');
                }
            } catch (playErr) {
                if (this.mobileWakeRequired) {
                    return;
                }
                console.warn("Next batch playback start failed:", playErr);
            }
        };

        const promise = runContinuation();
        this.inFlightBatchContinuationPromise = promise;
        try {
            await promise;
        } finally {
            if (this.inFlightBatchContinuationPromise === promise) {
                this.inFlightBatchContinuationPromise = null;
            }
            this.isRefilling = false;
        }
    }

    // --- Queue & Playback State ---

    private isNaturalBatchExhaustionAtTrackZero(
        sessionIndex: number,
        isSpotifyPlaying: boolean,
        progressMs: number | null | undefined,
        now: number
    ): boolean {
        const originIdx = this.sessionCache.getBatchOriginSessionIndex();
        if (
            !this.hasConfirmedSessionPlayback ||
            this.userExplicitlyPaused ||
            isSpotifyPlaying ||
            sessionIndex !== originIdx ||
            (progressMs ?? 0) !== 0
        ) {
            return false;
        }
        const remainingCountFromOrigin = this.sessionCache.getSessionTracks().length - originIdx;
        return (
            this.sessionCache.getMaxConfirmedSessionIndex() > originIdx ||
            this.sessionCache.getSessionStartIndex() > originIdx ||
            (remainingCountFromOrigin === 1 && this.sessionCache.getLastConfirmedProgressMs() >= 3000) ||
            this.sessionCache.hasElapsedExpectedBatchDuration(now)
        );
    }

    private isAutoplayAfterBatchExhaustion(
        hasExternalContextUri: boolean,
        isSpotifyPlaying: boolean,
        isCurrentItemInSession: boolean,
        isCarryoverRefill: boolean,
        now: number
    ): boolean {
        const total = this.sessionCache.getSessionTracks().length;
        if (
            total === 0 ||
            !this.hasConfirmedSessionPlayback ||
            this.userExplicitlyPaused ||
            !isSpotifyPlaying ||
            hasExternalContextUri ||
            isCurrentItemInSession ||
            isCarryoverRefill
        ) {
            return false;
        }
        if (total === 1) {
            return this.sessionCache.hasElapsedExpectedBatchDuration(now);
        }
        return (
            this.sessionCache.getMaxConfirmedSessionIndex() >= total - 1 ||
            this.sessionCache.getSessionStartIndex() >= total - 1 ||
            this.sessionCache.hasElapsedExpectedBatchDuration(now)
        );
    }

    async getQueue(currentTrackOverride?: Track | null): Promise<Track[]> {
        const activeTrack = currentTrackOverride !== undefined ? currentTrackOverride : this.lastPlayingTrack;
        const sessionTracks = this.sessionCache.getSessionTracks();
        const sessionStartIndex = this.sessionCache.getSessionStartIndex();
        const now = Date.now();

        if (sessionTracks.length > 0 && !this.isExternalContextActive) {
            if (this.sessionCache.isBatchExhausted()) {
                return [];
            }

            const isUnconfirmedRuntimeSession =
                !this.hasConfirmedSessionPlayback &&
                this.sessionCache.getHasInitiatedSessionInRuntime();
            const isInStartupGrace =
                isUnconfirmedRuntimeSession &&
                (
                    this.isPlayTracksInFlight() ||
                    (this.lastPlayTime > 0 && (now - this.lastPlayTime < PLAYBACK_CONSTANTS.STARTUP_GRACE_MS))
                );

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

                if (
                    isUnconfirmedRuntimeSession ||
                    this.lastKnownIsPlaying === false ||
                    this.sessionCache.isKnownRefillCarryoverTrack(activeTrack, now)
                ) {
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
            const state = await this.spotify.getMyCurrentPlaybackState({ market: 'from_token' });
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
            const playInFlight = this.isPlayTracksInFlight();
            const isUnconfirmedRuntimeSession =
                !this.hasConfirmedSessionPlayback &&
                this.sessionCache.getHasInitiatedSessionInRuntime();
            const isWithinRecentKickGrace =
                isUnconfirmedRuntimeSession &&
                !this.userExplicitlyPaused &&
                this.lastPlayTime > 0 &&
                now - this.lastPlayTime < 6500 &&
                this.lastSuccessfulStartupKickTime > 0 &&
                now - this.lastSuccessfulStartupKickTime < 2200;
            const hasStartupGraceWindow =
                this.lastPlayTime > 0 &&
                ((now - this.lastPlayTime < PLAYBACK_CONSTANTS.STARTUP_GRACE_MS) || isWithinRecentKickGrace);
            const isWaitingForStartupSwitch =
                isUnconfirmedRuntimeSession &&
                !this.userExplicitlyPaused &&
                (playInFlight || hasStartupGraceWindow);
            const hasReachedStartTrack = isCurrentItemInSession && (
                this.hasConfirmedSessionPlayback ||
                !isUnconfirmedRuntimeSession ||
                (
                    sessionIndex >= sessionStartIndex &&
                    (!isWaitingForStartupSwitch || sessionIndex === sessionStartIndex)
                )
            );
            this.lastRawSessionTrackState = {
                inSession: hasReachedStartTrack,
                loadedIndex: hasReachedStartTrack ? sessionIndex : -1,
                isPlaying: isSpotifyPlaying,
                deviceId: state?.device?.id || undefined,
                hasControllableDevice: Boolean(
                    (state?.device?.is_active || state?.device?.id) && !state?.device?.is_restricted
                ),
            };
            // Guard against transient cloud-side progress_ms === 0 responses during startup / post-kick grace
            // before the mobile OS has actually granted audio focus and started advancing audio.
            const isPrematureZeroProgressMirage = Boolean(
                isUnconfirmedRuntimeSession &&
                !this.userExplicitlyPaused &&
                typeof state?.progress_ms === 'number' &&
                state.progress_ms === 0 &&
                (playInFlight || hasStartupGraceWindow || this.mobileWakeRequired)
            );

            const isOnWakeTargetDevice =
                !state?.device ||
                !state.device.type ||
                isMobileSpotifyDevice(state.device) ||
                state.device.id === this.getPreferredDeviceId() ||
                !this.canWakeLocalMobileSpotify();

            if (!playInFlight && !isSpotifyPlaying && this.activePlaybackSwitchBlocked) {
                this.activePlaybackSwitchBlocked = false;
            }

            const hasConfirmedLiveProgress =
                typeof state?.progress_ms === 'number' && state.progress_ms > 0;
            if (
                !playInFlight &&
                this.mobileWakeRequired &&
                isSpotifyPlaying &&
                isOnWakeTargetDevice &&
                (hasReachedStartTrack || !isUnconfirmedRuntimeSession || hasConfirmedLiveProgress) &&
                !isPrematureZeroProgressMirage &&
                (typeof state?.progress_ms !== 'number' || state.progress_ms > 0)
            ) {
                this.setMobileWakeRequiredState(false);
                this.activePlaybackSwitchBlocked = false;
                if (isUnconfirmedRuntimeSession && !hasReachedStartTrack) {
                    this.lastRefillAttemptTime = 0;
                }
                if (this.statusText.startsWith('📱')) {
                    this.updateStatus('Ready');
                }
            }

            if (
                !playInFlight &&
                hasReachedStartTrack &&
                isSpotifyPlaying &&
                (!this.mobileWakeRequired || isOnWakeTargetDevice) &&
                !isPrematureZeroProgressMirage
            ) {
                this.userExplicitlyPaused = false;
                this.activePlaybackSwitchBlocked = false;
                this.setMobileWakeRequiredState(false);
                if (
                    this.statusText.startsWith('📱') ||
                    this.statusText.startsWith('⚠️') ||
                    this.statusText.startsWith('⏳')
                ) {
                    this.updateStatus('Ready');
                }
                this.resetStartupResumeKicks();
                this.reconcilePendingStartFailureAfterManualPlay();
                this.sessionCache.recordConfirmedPlaybackProgress(
                    sessionIndex,
                    typeof state?.progress_ms === 'number' ? state.progress_ms : 0,
                    now
                );
            } else if (!playInFlight && this.hasConfirmedSessionPlayback && isCurrentItemInSession) {
                if (this.isNaturalBatchExhaustionAtTrackZero(sessionIndex, isSpotifyPlaying, state?.progress_ms, now)) {
                    if (!this.sessionCache.isBatchExhausted()) {
                        this.sessionCache.markTracksPlayed(sessionTracks);
                        this.sessionCache.setSessionStartIndex(sessionTracks.length - 1);
                        this.sessionCache.setBatchExhausted(true);
                        this.addLog('🔄 Curated batch finished playing. Preparing next fresh DJ set...');
                    }
                } else {
                    if (isSpotifyPlaying) {
                        this.manualBareResumeAttempted = false;
                        this.sessionCache.recordConfirmedPlaybackProgress(
                            sessionIndex,
                            typeof state?.progress_ms === 'number' ? state.progress_ms : 0,
                            now
                        );
                    } else {
                        this.sessionCache.setSessionStartIndex(sessionIndex);
                    }
                }
            } else if (
                !playInFlight &&
                isUnconfirmedRuntimeSession &&
                !this.userExplicitlyPaused &&
                hasReachedStartTrack &&
                !isSpotifyPlaying &&
                (state?.device?.is_active || state?.device?.id) &&
                !state?.device?.is_restricted &&
                this.lastPlayTime > 0 &&
                now - this.lastPlayTime < 30_000
            ) {
                this.triggerStartupPausedSessionKick(state?.device?.id || undefined, this.playbackGeneration);
            }

            // Normalize shuffle=false / repeat=off only after playback is confirmed AND settled
            // (>= 1.5s since play or >= 1s into track progress) so mobile stream setup is never interrupted.
            if (
                !playInFlight &&
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

            const postKickStartupGrace =
                !this.hasConfirmedSessionPlayback &&
                !this.mobileWakeRequired &&
                !this.userExplicitlyPaused &&
                this.lastPlayTime > 0 &&
                now - this.lastPlayTime < 6500 &&
                this.lastSuccessfulStartupKickTime > 0 &&
                now - this.lastSuccessfulStartupKickTime < 2200;
            const isInStartupGrace =
                !this.hasConfirmedSessionPlayback &&
                !this.mobileWakeRequired &&
                (
                    (playInFlight && !this.canWakeLocalMobileSpotify() && isUnconfirmedRuntimeSession && !this.userExplicitlyPaused) ||
                    (!playInFlight && (hasStartupGraceWindow || postKickStartupGrace))
                );

            if (isInStartupGrace && sessionTracks.length > 0) {
                const startTrack = sessionTracks[sessionStartIndex] || sessionTracks[0];
                const isPlayingOldTrack = Boolean(
                    (state?.item && !hasReachedStartTrack) ||
                    hasExternalContextUri ||
                    !isSpotifyPlaying ||
                    isPrematureZeroProgressMirage
                );
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
            // before Track 1 of the session has ever been confirmed playing on the device,
            // or while a ContextDJ play/resume command is actively transitioning the device.
            const canDetectExternalTakeover =
                !playInFlight &&
                !this.isResumeInFlight() &&
                (this.hasConfirmedSessionPlayback ||
                    !this.sessionCache.getHasInitiatedSessionInRuntime());

            if (state && state.item && state.item.type === 'track') {
                const trackItem = state.item as Track;
                const isCarryoverRefill =
                    !hasExternalContextUri &&
                    !isCurrentItemInSession &&
                    this.sessionCache.isKnownRefillCarryoverTrack(trackItem, now);
                if (
                    isSpotifyPlaying &&
                    sessionTracks.length > 0 &&
                    !isCurrentItemInSession &&
                    canDetectExternalTakeover
                ) {
                    if (isCarryoverRefill) {
                        // Leftover track from an earlier ContextDJ `POST /v1/me/player/queue` refill:
                        // preserve the active DJ session instead of false-triggering external takeover.
                    } else if (
                        this.isAutoplayAfterBatchExhaustion(
                            hasExternalContextUri,
                            isSpotifyPlaying,
                            isCurrentItemInSession,
                            isCarryoverRefill,
                            now
                        )
                    ) {
                        if (!this.sessionCache.isBatchExhausted()) {
                            this.sessionCache.markTracksPlayed(sessionTracks);
                            this.sessionCache.setSessionStartIndex(sessionTracks.length - 1);
                            this.sessionCache.setBatchExhausted(true);
                            this.addLog('🔄 Session batch finished (Spotify Autoplay active). Preparing next curated DJ set...');
                        }
                    } else {
                        this.handleExternalPlaybackDetected(trackItem);
                    }
                }
                const enriched = this.sessionCache.enrichTrackWithCachedMetadata(trackItem);
                state.item = enriched;
                if (
                    !this.sessionCache.isBatchExhausted() &&
                    (hasReachedStartTrack ||
                        this.isExternalContextActive ||
                        sessionTracks.length === 0 ||
                        (isSpotifyPlaying && canDetectExternalTakeover && !isCarryoverRefill))
                ) {
                    this.lastPlayingTrack = enriched;
                }
                if (this.mobileWakeRequired && state.is_playing) {
                    this.lastKnownIsPlaying = false;
                    return {
                        ...state,
                        is_playing: false,
                    };
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

            if (this.mobileWakeRequired && state?.is_playing) {
                this.lastKnownIsPlaying = false;
                return {
                    ...state,
                    is_playing: false,
                };
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

    private async shouldStartUnconfirmedSessionViaPlayTracks(minExpectedIdx: number = 0): Promise<boolean> {
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
        // or empty-swung (or settled paused on an older pre-jump track after startup grace).
        try {
            const state = await this.spotify.getMyCurrentPlaybackState({ market: 'from_token' });
            const hasExternalContextUri = Boolean(state?.context?.uri);
            const loadedIdx =
                !hasExternalContextUri &&
                state?.device?.is_active &&
                state?.item &&
                state.item.type === 'track'
                    ? this.sessionCache.findTrackIndexInSession(state.item as Track)
                    : -1;
            if (loadedIdx < 0) {
                return true;
            }
            return (
                loadedIdx < minExpectedIdx &&
                !state?.is_playing &&
                Date.now() - this.lastPlayTime >= PLAYBACK_CONSTANTS.STARTUP_GRACE_MS
            );
        } catch {
            return false;
        }
    }

    async next(): Promise<SpotifyControlResult> {
        const sessionTracks = this.sessionCache.getSessionTracks();
        if (
            sessionTracks.length > 0 &&
            !this.isExternalContextActive &&
            this.sessionCache.isBatchExhausted() &&
            this.schedule.length > 0 &&
            !isWaitingForScheduleStart(this.schedule)
        ) {
            return await this.resumeOrContinueExhaustedBatch();
        }
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
            if (await this.shouldStartUnconfirmedSessionViaPlayTracks(prevStartIndex)) {
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
                    if (this.mobileWakeRequired) {
                        return { ok: false, mobileWakeRequired: true };
                    }
                    if (this.lastKnownIsPlaying === false && !this.hasConfirmedSessionPlayback) {
                        if (didAdvanceSession) {
                            this.sessionCache.setSessionStartIndex(prevStartIndex);
                            this.sessionCache.setLastPlayingTrack(prevPlayingTrack, true);
                            if (this.onTracksPlayed) {
                                this.onTracksPlayed(sessionTracks.slice(prevStartIndex), {
                                    confirmedPlaying: false,
                                    mobileWakeRequired: false,
                                });
                            }
                        }
                        return { ok: false };
                    }
                    return { ok: true, status: 204 };
                } catch (e) {
                    if (didAdvanceSession && !this.mobileWakeRequired) {
                        this.sessionCache.setSessionStartIndex(prevStartIndex);
                        this.sessionCache.setLastPlayingTrack(prevPlayingTrack, true);
                    }
                    const classified = this.mobileWakeRequired
                        ? (typeof this.playerClient.getLastError === 'function' ? this.playerClient.getLastError() : null)
                        : (this.playerClient.reportThrownError(e, 'play') ??
                            (typeof this.playerClient.getLastError === 'function' ? this.playerClient.getLastError() : null));
                    return {
                        ok: false,
                        status: classified?.status,
                        error: classified ?? undefined,
                        ...(this.mobileWakeRequired ? { mobileWakeRequired: true } : {}),
                    };
                }
            }
        }
        const wasPlayingBeforeNext = this.lastKnownIsPlaying === true;
        const nextCmdSeq = ++this.transportCommandSeq;
        const res = await this.playerClient.next();
        if (nextCmdSeq !== this.transportCommandSeq || this.userExplicitlyPaused) {
            return { ok: false };
        }
        if (!res.ok) {
            const isAsleep404 = res.status === 404 || res.error?.category === 'device_not_found';
            if (isAsleep404 && this.canWakeLocalMobileSpotify()) {
                this.lastKnownIsPlaying = false;
                if (sessionTracks.length > 0 && !this.isExternalContextActive) {
                    this.sessionCache.setHasConfirmedSessionPlayback(false);
                    this.sessionCache.setLastPlayTime(0);
                    this.sessionCache.setHasInitiatedSessionInRuntime(true);
                }
                this.setMobileWakeRequiredState(true);
                this.updateStatus(
                    '📱 Tap "Wake Spotify & Play" to resume backgrounded Spotify (Spotifyを起動して再生を開始してください)'
                );
                return { ...res, mobileWakeRequired: true };
            }
            if (didAdvanceSession) {
                this.sessionCache.setSessionStartIndex(prevStartIndex);
                this.lastPlayingTrack = prevPlayingTrack;
            }
            return res;
        }
        if (!wasPlayingBeforeNext && this.canWakeLocalMobileSpotify()) {
            const activeId =
                typeof this.playerClient.getActiveDeviceId === 'function'
                    ? this.playerClient.getActiveDeviceId() || undefined
                    : undefined;
            const verifyResult = await this.verifyMobileResumeStarted(activeId, {
                skipForceTransferRetry: false,
                expectedTransportSeq: nextCmdSeq,
                minExpectedSessionIndex:
                    sessionTracks.length > 0 && !this.isExternalContextActive ? 0 : undefined,
            });
            if (verifyResult === 'aborted') {
                return { ok: false };
            }
            if (verifyResult === 'wrong_track' && sessionTracks.length > 0 && !this.isExternalContextActive) {
                try {
                    await this.playTracks(sessionTracks.slice(targetIdx), {
                        isDJSession: true,
                        fullSessionTracks: sessionTracks,
                        sessionStartIndex: targetIdx,
                    });
                    if (this.mobileWakeRequired) {
                        return { ok: false, mobileWakeRequired: true };
                    }
                    if (this.lastKnownIsPlaying === false && !this.hasConfirmedSessionPlayback) {
                        if (didAdvanceSession) {
                            this.sessionCache.setSessionStartIndex(prevStartIndex);
                            this.sessionCache.setLastPlayingTrack(prevPlayingTrack, true);
                            if (this.onTracksPlayed) {
                                this.onTracksPlayed(sessionTracks.slice(prevStartIndex), {
                                    confirmedPlaying: false,
                                    mobileWakeRequired: false,
                                });
                            }
                        }
                        return { ok: false };
                    }
                    return { ok: true, status: 204 };
                } catch (e) {
                    if (didAdvanceSession && !this.mobileWakeRequired) {
                        this.sessionCache.setSessionStartIndex(prevStartIndex);
                        this.sessionCache.setLastPlayingTrack(prevPlayingTrack, true);
                    }
                    const classified = this.mobileWakeRequired
                        ? (typeof this.playerClient.getLastError === 'function' ? this.playerClient.getLastError() : null)
                        : (this.playerClient.reportThrownError(e, 'play') ??
                            (typeof this.playerClient.getLastError === 'function' ? this.playerClient.getLastError() : null));
                    return {
                        ok: false,
                        status: classified?.status,
                        error: classified ?? undefined,
                        ...(this.mobileWakeRequired ? { mobileWakeRequired: true } : {}),
                    };
                }
            }
            if (verifyResult === 'blocked') {
                this.lastKnownIsPlaying = false;
                if (sessionTracks.length > 0 && !this.isExternalContextActive) {
                    this.sessionCache.setHasConfirmedSessionPlayback(false);
                    this.sessionCache.setLastPlayTime(0);
                    this.sessionCache.setHasInitiatedSessionInRuntime(true);
                }
                this.setMobileWakeRequiredState(true);
                this.updateStatus(
                    '📱 Tap "Wake Spotify & Play" to resume backgrounded Spotify (Spotifyを起動して再生を開始してください)'
                );
                return { ok: false, status: res.status, mobileWakeRequired: true };
            }
            this.setMobileWakeRequiredState(false);
            if (this.statusText.startsWith('📱')) {
                this.updateStatus('Ready');
            }
            this.lastKnownIsPlaying = true;
        }
        if (!this.hasConfirmedSessionPlayback && !this.userExplicitlyPaused && sessionTracks.length > 0 && !this.isExternalContextActive) {
            this.resetStartupResumeKicks();
            this.sessionCache.setLastPlayTime(Date.now());
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
            const wasBatchExhausted = this.sessionCache.isBatchExhausted();
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

            if (wasBatchExhausted || await this.shouldStartUnconfirmedSessionViaPlayTracks(prevStartIndex)) {
                try {
                    if (typeof this.playerClient.clearLastError === 'function') {
                        this.playerClient.clearLastError();
                    }
                    const tracksToPlay = sessionTracks.slice(targetIdx);
                    await this.playTracks(tracksToPlay, {
                        isDJSession: true,
                        fullSessionTracks: sessionTracks,
                        sessionStartIndex: targetIdx,
                        fastFailOnEmpty: this.canWakeLocalMobileSpotify(),
                    });
                    if (this.mobileWakeRequired) {
                        return { ok: false, mobileWakeRequired: true };
                    }
                    if (this.lastKnownIsPlaying === false && !this.hasConfirmedSessionPlayback) {
                        this.sessionCache.setSessionStartIndex(prevStartIndex);
                        this.sessionCache.setLastPlayingTrack(prevPlayingTrack, true);
                        this.sessionCache.setLastPlayTime(prevPlayTime);
                        this.sessionCache.setBatchExhausted(wasBatchExhausted);
                        if (didMutateSession && this.onTracksPlayed) {
                            this.onTracksPlayed(sessionTracks.slice(prevStartIndex), {
                                confirmedPlaying: false,
                                mobileWakeRequired: false,
                            });
                        }
                        return { ok: false };
                    }
                    return { ok: true, status: 204 };
                } catch (e) {
                    if (!this.mobileWakeRequired) {
                        this.sessionCache.setSessionStartIndex(prevStartIndex);
                        this.sessionCache.setLastPlayingTrack(prevPlayingTrack, true);
                        this.sessionCache.setLastPlayTime(prevPlayTime);
                        this.sessionCache.setBatchExhausted(wasBatchExhausted);
                    }
                    const classified = this.mobileWakeRequired
                        ? (typeof this.playerClient.getLastError === 'function' ? this.playerClient.getLastError() : null)
                        : (this.playerClient.reportThrownError(e, 'play') ??
                            (typeof this.playerClient.getLastError === 'function' ? this.playerClient.getLastError() : null));
                    return {
                        ok: false,
                        status: classified?.status,
                        error: classified ?? undefined,
                        ...(this.mobileWakeRequired ? { mobileWakeRequired: true } : {}),
                    };
                }
            }

            if (!this.hasConfirmedSessionPlayback) {
                this.sessionCache.setLastPlayTime(0);
                didMutateSession = true;
            }
        }
        const wasPlayingBeforePrev = this.lastKnownIsPlaying === true;
        const prevCmdSeq = ++this.transportCommandSeq;
        const res = await this.playerClient.previous();
        if (prevCmdSeq !== this.transportCommandSeq || this.userExplicitlyPaused) {
            return { ok: false };
        }
        if (!res.ok) {
            const isAsleep404 = res.status === 404 || res.error?.category === 'device_not_found';
            if (isAsleep404 && this.canWakeLocalMobileSpotify()) {
                this.lastKnownIsPlaying = false;
                if (sessionTracks.length > 0 && !this.isExternalContextActive) {
                    this.sessionCache.setHasConfirmedSessionPlayback(false);
                    this.sessionCache.setLastPlayTime(0);
                    this.sessionCache.setHasInitiatedSessionInRuntime(true);
                }
                this.setMobileWakeRequiredState(true);
                this.updateStatus(
                    '📱 Tap "Wake Spotify & Play" to resume backgrounded Spotify (Spotifyを起動して再生を開始してください)'
                );
                return { ...res, mobileWakeRequired: true };
            }
            if (didMutateSession) {
                this.sessionCache.setSessionStartIndex(prevStartIndex);
                this.lastPlayingTrack = prevPlayingTrack;
                this.sessionCache.setLastPlayTime(prevPlayTime);
            }
            return res;
        }
        if (!wasPlayingBeforePrev && this.canWakeLocalMobileSpotify()) {
            const activeId =
                typeof this.playerClient.getActiveDeviceId === 'function'
                    ? this.playerClient.getActiveDeviceId() || undefined
                    : undefined;
            const verifyResult = await this.verifyMobileResumeStarted(activeId, {
                skipForceTransferRetry: false,
                expectedTransportSeq: prevCmdSeq,
                minExpectedSessionIndex:
                    sessionTracks.length > 0 && !this.isExternalContextActive ? 0 : undefined,
            });
            if (verifyResult === 'aborted') {
                return { ok: false };
            }
            if (verifyResult === 'wrong_track' && sessionTracks.length > 0 && !this.isExternalContextActive) {
                try {
                    await this.playTracks(sessionTracks.slice(targetIdx), {
                        isDJSession: true,
                        fullSessionTracks: sessionTracks,
                        sessionStartIndex: targetIdx,
                    });
                    if (this.mobileWakeRequired) {
                        return { ok: false, mobileWakeRequired: true };
                    }
                    if (this.lastKnownIsPlaying === false && !this.hasConfirmedSessionPlayback) {
                        if (didMutateSession) {
                            this.sessionCache.setSessionStartIndex(prevStartIndex);
                            this.sessionCache.setLastPlayingTrack(prevPlayingTrack, true);
                            this.sessionCache.setLastPlayTime(prevPlayTime);
                            if (this.onTracksPlayed) {
                                this.onTracksPlayed(sessionTracks.slice(prevStartIndex), {
                                    confirmedPlaying: false,
                                    mobileWakeRequired: false,
                                });
                            }
                        }
                        return { ok: false };
                    }
                    return { ok: true, status: 204 };
                } catch (e) {
                    if (didMutateSession && !this.mobileWakeRequired) {
                        this.sessionCache.setSessionStartIndex(prevStartIndex);
                        this.sessionCache.setLastPlayingTrack(prevPlayingTrack, true);
                        this.sessionCache.setLastPlayTime(prevPlayTime);
                    }
                    const classified = this.mobileWakeRequired
                        ? (typeof this.playerClient.getLastError === 'function' ? this.playerClient.getLastError() : null)
                        : (this.playerClient.reportThrownError(e, 'play') ??
                            (typeof this.playerClient.getLastError === 'function' ? this.playerClient.getLastError() : null));
                    return {
                        ok: false,
                        status: classified?.status,
                        error: classified ?? undefined,
                        ...(this.mobileWakeRequired ? { mobileWakeRequired: true } : {}),
                    };
                }
            }
            if (verifyResult === 'blocked') {
                this.lastKnownIsPlaying = false;
                if (sessionTracks.length > 0 && !this.isExternalContextActive) {
                    this.sessionCache.setHasConfirmedSessionPlayback(false);
                    this.sessionCache.setLastPlayTime(0);
                    this.sessionCache.setHasInitiatedSessionInRuntime(true);
                }
                this.setMobileWakeRequiredState(true);
                this.updateStatus(
                    '📱 Tap "Wake Spotify & Play" to resume backgrounded Spotify (Spotifyを起動して再生を開始してください)'
                );
                return { ok: false, status: res.status, mobileWakeRequired: true };
            }
            this.setMobileWakeRequiredState(false);
            if (this.statusText.startsWith('📱')) {
                this.updateStatus('Ready');
            }
            this.lastKnownIsPlaying = true;
        }
        return res;
    }

    async pause() {
        const pauseCmdSeq = ++this.transportCommandSeq;
        const wasPlayInFlight = this.isPlayTracksInFlight();
        const wasResumeInFlight = this.isResumeInFlight();
        if (wasPlayInFlight || wasResumeInFlight) {
            this.userExplicitlyPaused = true;
            if (wasPlayInFlight) {
                this.playbackGeneration++;
                this.inFlightPlayGeneration = null;
                this.inFlightPlayPromise = null;
                if (!this.hasConfirmedSessionPlayback && this.isSessionPlaybackActive()) {
                    const stagedTracks = this.sessionCache.getSessionTracks();
                    const stagedIdx = this.sessionCache.getSessionStartIndex();
                    this.sessionCache.setSessionTracks(stagedTracks, true, stagedIdx);
                    this.sessionCache.setHasInitiatedSessionInRuntime(stagedTracks.length > 0);
                    this.sessionCache.setLastPlayingTrack(stagedTracks[stagedIdx] ?? null, true);
                }
            }
            if (!this.hasConfirmedSessionPlayback) {
                this.sessionCache.setLastPlayTime(0);
            }
        }
        const res = await this.playerClient.pause();
        if (pauseCmdSeq !== this.transportCommandSeq) {
            return res;
        }
        if (res.ok) {
            this.lastKnownIsPlaying = false;
            this.userExplicitlyPaused = true;
            if (this.isPlayTracksInFlight()) {
                this.playbackGeneration++;
                this.inFlightPlayGeneration = null;
                this.inFlightPlayPromise = null;
                if (!this.hasConfirmedSessionPlayback && this.isSessionPlaybackActive()) {
                    const stagedTracks = this.sessionCache.getSessionTracks();
                    const stagedIdx = this.sessionCache.getSessionStartIndex();
                    this.sessionCache.setSessionTracks(stagedTracks, true, stagedIdx);
                    this.sessionCache.setHasInitiatedSessionInRuntime(stagedTracks.length > 0);
                    this.sessionCache.setLastPlayingTrack(stagedTracks[stagedIdx] ?? null, true);
                }
            }
            if (!this.hasConfirmedSessionPlayback) {
                this.sessionCache.setLastPlayTime(0);
            }
        } else if (wasPlayInFlight || wasResumeInFlight) {
            this.lastKnownIsPlaying = false;
        }
        return res;
    }

    private delayMs(ms: number): Promise<void> {
        if (ms <= 0) return Promise.resolve();
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, ms);
            if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') {
                timer.unref();
            }
        });
    }

    private async verifyMobileResumeStarted(
        targetDeviceId: string | undefined,
        options?: {
            skipForceTransferRetry?: boolean;
            fromMobileWake?: boolean;
            expectedGen?: number;
            expectedTransportSeq?: number;
            minExpectedSessionIndex?: number;
            shouldAbort?: () => boolean;
        }
    ): Promise<'started' | 'wrong_track' | 'blocked' | 'aborted'> {
        if (typeof this.spotify.getMyCurrentPlaybackState !== 'function') {
            return 'started';
        }
        const expectedGen = options?.expectedGen ?? this.playbackGeneration;
        const expectedTransportSeq = options?.expectedTransportSeq;
        const isAborted = () =>
            this.userExplicitlyPaused ||
            expectedGen !== this.playbackGeneration ||
            (expectedTransportSeq !== undefined && expectedTransportSeq !== this.transportCommandSeq) ||
            (!options?.fromMobileWake && this.mobileWakeInProgress) ||
            Boolean(options?.shouldAbort?.());

        const isPlayingOnTarget = (st: SpotifyApi.CurrentPlaybackResponse | null | undefined): boolean =>
            Boolean(
                st?.is_playing &&
                (!targetDeviceId || !st.device?.id || st.device.id === targetDeviceId)
            );

        const isWrongSessionTrack = (
            st: SpotifyApi.CurrentPlaybackResponse | null | undefined
        ): boolean => {
            if (options?.minExpectedSessionIndex === undefined || !st) {
                return false;
            }
            if (st.context?.uri) {
                return true;
            }
            if (!st.item) {
                return false;
            }
            if (st.item.type !== 'track') {
                return true;
            }
            const sessionIdx = this.sessionCache.findTrackIndexInSession(st.item as Track);
            return sessionIdx < options.minExpectedSessionIndex;
        };

        const fetchStateWithRetry = async (): Promise<{
            ok: boolean;
            state: SpotifyApi.CurrentPlaybackResponse | null;
        }> => {
            try {
                const st = await this.spotify.getMyCurrentPlaybackState({ market: 'from_token' });
                return { ok: true, state: st };
            } catch (err) {
                console.warn('Mobile post-resume state check failed; retrying once:', err);
                await this.delayMs(this.mobileResumeRetryDelayMs);
                if (isAborted()) {
                    return { ok: false, state: null };
                }
                try {
                    const retrySt = await this.spotify.getMyCurrentPlaybackState({ market: 'from_token' });
                    return { ok: true, state: retrySt };
                } catch (retryErr) {
                    console.warn('Mobile post-resume state check retry failed:', retryErr);
                    return { ok: false, state: null };
                }
            }
        };

        await this.delayMs(this.mobileResumeVerifyDelayMs);
        if (isAborted()) return 'aborted';

        let fetched = await fetchStateWithRetry();
        if (isAborted()) return 'aborted';
        if (!fetched.ok) return 'blocked';
        let postState = fetched.state;

        if (!isPlayingOnTarget(postState) && targetDeviceId && !options?.skipForceTransferRetry) {
            const retryRes = await this.playerClient.resume(targetDeviceId, {
                silent: true,
                forcePlayTransfer: true,
            });
            if (isAborted()) return 'aborted';
            if (retryRes.ok) {
                await this.delayMs(this.mobileResumeRetryDelayMs);
                if (isAborted()) return 'aborted';
                fetched = await fetchStateWithRetry();
                if (isAborted()) return 'aborted';
                if (!fetched.ok) return 'blocked';
                postState = fetched.state;
            }
        }

        if (
            isPlayingOnTarget(postState) &&
            typeof postState?.progress_ms === 'number' &&
            postState.progress_ms === 0
        ) {
            await this.delayMs(this.mobileResumeRetryDelayMs);
            if (isAborted()) return 'aborted';
            fetched = await fetchStateWithRetry();
            if (isAborted()) return 'aborted';
            if (!fetched.ok) return 'blocked';
            postState = fetched.state;
            if (
                isPlayingOnTarget(postState) &&
                typeof postState?.progress_ms === 'number' &&
                postState.progress_ms === 0
            ) {
                return 'blocked';
            }
        }

        if (!isPlayingOnTarget(postState)) {
            return 'blocked';
        }
        return isWrongSessionTrack(postState) ? 'wrong_track' : 'started';
    }

    private async resumeOrContinueExhaustedBatch(
        options?: { fromMobileWake?: boolean }
    ): Promise<SpotifyControlResult> {
        try {
            if (typeof this.playerClient.clearLastError === 'function') {
                this.playerClient.clearLastError();
            }
            this.lastBatchContinuationAttemptTime = 0;
            const currentItem = this.getEffectiveItemForPlayback(new Date());
            if (!currentItem) {
                return { ok: false };
            }
            const querySignature = getScheduleItemSignature(currentItem);
            const queriesToUse = getScheduleItemQueries(currentItem);

            if (querySignature !== this.lastQuery) {
                this.sessionCache.setBatchExhausted(false);
                await this.processDJLoop(false, true);
            } else if (queriesToUse.length > 0) {
                await this.continueExhaustedSessionBatch(
                    queriesToUse,
                    currentItem,
                    this.playbackGeneration,
                    { fastFailOnEmpty: !options?.fromMobileWake && this.canWakeLocalMobileSpotify() }
                );
                if (
                    options?.fromMobileWake &&
                    !this.sessionCache.isBatchExhausted() &&
                    this.lastPlayTime === 0 &&
                    !this.hasConfirmedSessionPlayback &&
                    !this.userExplicitlyPaused
                ) {
                    const stagedTracks = this.sessionCache.getSessionTracks();
                    if (stagedTracks.length > 0) {
                        await this.playTracks(stagedTracks, {
                            isDJSession: true,
                            fullSessionTracks: stagedTracks,
                            sessionStartIndex: 0,
                        });
                    }
                }
            } else {
                return { ok: false };
            }

            if (this.mobileWakeRequired) {
                return { ok: false, mobileWakeRequired: true };
            }
            if (
                this.sessionCache.isBatchExhausted() ||
                (this.lastKnownIsPlaying === false && !this.hasConfirmedSessionPlayback)
            ) {
                const classified =
                    typeof this.playerClient.getLastError === 'function'
                        ? this.playerClient.getLastError()
                        : null;
                return {
                    ok: false,
                    status: classified?.status,
                    error: classified ?? undefined,
                };
            }
            return { ok: true, status: 204 };
        } catch (e) {
            const classified = this.mobileWakeRequired
                ? (typeof this.playerClient.getLastError === 'function' ? this.playerClient.getLastError() : null)
                : (this.playerClient.reportThrownError(e, 'play') ??
                    (typeof this.playerClient.getLastError === 'function' ? this.playerClient.getLastError() : null));
            return {
                ok: false,
                status: classified?.status,
                error: classified ?? undefined,
                ...(this.mobileWakeRequired ? { mobileWakeRequired: true } : {}),
            };
        }
    }

    async resume(options?: { fromMobileWake?: boolean }): Promise<SpotifyControlResult> {
        this.inFlightResumeCount++;
        try {
            return await this.executeResumeInternal(options);
        } finally {
            this.inFlightResumeCount = Math.max(0, this.inFlightResumeCount - 1);
        }
    }

    private async executeResumeInternal(options?: { fromMobileWake?: boolean }): Promise<SpotifyControlResult> {
        const resumeCmdSeq = ++this.transportCommandSeq;
        const wasExplicitlyPaused = this.userExplicitlyPaused;
        this.userExplicitlyPaused = false;
        if (wasExplicitlyPaused) {
            this.manualBareResumeAttempted = false;
        }
        if (!wasExplicitlyPaused && this.isPlayTracksInFlight() && this.inFlightPlayPromise) {
            try {
                await this.inFlightPlayPromise;
                if (this.mobileWakeRequired) {
                    return { ok: false, mobileWakeRequired: true };
                }
                if (this.lastKnownIsPlaying === false && !this.hasConfirmedSessionPlayback) {
                    return { ok: false };
                }
                return { ok: true, status: 204 };
            } catch (e) {
                const classified = this.mobileWakeRequired
                    ? (typeof this.playerClient.getLastError === 'function' ? this.playerClient.getLastError() : null)
                    : (this.playerClient.reportThrownError(e, 'play') ??
                        (typeof this.playerClient.getLastError === 'function' ? this.playerClient.getLastError() : null));
                return {
                    ok: false,
                    status: classified?.status,
                    error: classified ?? undefined,
                    ...(this.mobileWakeRequired ? { mobileWakeRequired: true } : {}),
                };
            }
        }
        const sessionTracks = this.sessionCache.getSessionTracks();
        const isBatchExhaustedResume = this.sessionCache.isBatchExhausted();
        if (
            (sessionTracks.length === 0 || isBatchExhaustedResume) &&
            !this.isExternalContextActive &&
            this.schedule.length > 0 &&
            !isWaitingForScheduleStart(this.schedule)
        ) {
            if (isBatchExhaustedResume) {
                return await this.resumeOrContinueExhaustedBatch(options);
            }
            try {
                if (typeof this.playerClient.clearLastError === 'function') {
                    this.playerClient.clearLastError();
                }
                this.lastBatchContinuationAttemptTime = 0;
                await this.processDJLoop(false, true);
                if (this.mobileWakeRequired) {
                    return { ok: false, mobileWakeRequired: true };
                }
                if (this.lastKnownIsPlaying === false && !this.hasConfirmedSessionPlayback) {
                    return { ok: false };
                }
                return { ok: true, status: 204 };
            } catch (e) {
                const classified = this.mobileWakeRequired
                    ? (typeof this.playerClient.getLastError === 'function' ? this.playerClient.getLastError() : null)
                    : (this.playerClient.reportThrownError(e, 'play') ??
                        (typeof this.playerClient.getLastError === 'function' ? this.playerClient.getLastError() : null));
                return {
                    ok: false,
                    status: classified?.status,
                    error: classified ?? undefined,
                    ...(this.mobileWakeRequired ? { mobileWakeRequired: true } : {}),
                };
            }
        }
        if (sessionTracks.length > 0 && !this.isExternalContextActive) {
            const isUnconfirmedRuntimeSession =
                !this.hasConfirmedSessionPlayback &&
                this.sessionCache.getHasInitiatedSessionInRuntime();
            let shouldStartSessionTracks = !this.hasConfirmedSessionPlayback;

            // Verify whether Spotify is currently on one of our session tracks on an active device.
            // Also inspect when waking from mobile (`fromMobileWake` / `mobileWakeRequired`) so a paused
            // mid-track or pre-staged session track resumes in place before escalating to `{ uris }`.
            const canInspectLoadedSessionTrack =
                !isUnconfirmedRuntimeSession ||
                this.lastPlayTime > 0 ||
                Boolean(options?.fromMobileWake) ||
                this.mobileWakeRequired;
            if (canInspectLoadedSessionTrack) {
                try {
                    const state = await this.spotify.getMyCurrentPlaybackState({ market: 'from_token' });
                    if (resumeCmdSeq !== this.transportCommandSeq || this.userExplicitlyPaused) {
                        return { ok: false };
                    }
                    const hasExternalContextUri = Boolean(state?.context?.uri);
                    const loadedIdx =
                        state?.item && state.item.type === 'track'
                            ? this.sessionCache.findTrackIndexInSession(state.item as Track)
                            : -1;
                    // Guard against Trap 2A on direct manual Play tap before background loop polled:
                    // If Spotify finished the batch and reset paused to 0ms on Track 0, curate & start the next set
                    // instead of resuming Track 0 from the beginning.
                    if (
                        !hasExternalContextUri &&
                        this.isNaturalBatchExhaustionAtTrackZero(
                            loadedIdx,
                            Boolean(state?.is_playing),
                            state?.progress_ms,
                            Date.now()
                        ) &&
                        this.schedule.length > 0 &&
                        !isWaitingForScheduleStart(this.schedule)
                    ) {
                        this.sessionCache.markTracksPlayed(sessionTracks);
                        this.sessionCache.setSessionStartIndex(sessionTracks.length - 1);
                        this.sessionCache.setBatchExhausted(true);
                        this.lastBatchContinuationAttemptTime = 0;
                        this.addLog('🔄 Curated batch finished playing. Curating next fresh DJ set on Play...');
                        return await this.resumeOrContinueExhaustedBatch(options);
                    }
                    const minExpectedIdx = isUnconfirmedRuntimeSession
                        ? this.sessionCache.getSessionStartIndex()
                        : 0;
                    const isCurrentInSession = Boolean(
                        !hasExternalContextUri &&
                        (state?.device?.is_active || state?.device?.id) &&
                        !state?.device?.is_restricted &&
                        loadedIdx >= minExpectedIdx
                    );
                    const isResumableCarryoverRefill = Boolean(
                        this.hasConfirmedSessionPlayback &&
                        !isUnconfirmedRuntimeSession &&
                        !hasExternalContextUri &&
                        loadedIdx === -1 &&
                        state?.item &&
                        state.item.type === 'track' &&
                        (state?.device?.is_active || state?.device?.id) &&
                        !state?.device?.is_restricted &&
                        this.sessionCache.isKnownRefillCarryoverTrack(state.item as Track)
                    );
                    if (isCurrentInSession || isResumableCarryoverRefill) {
                        const effectiveResumeSessionIdx = isCurrentInSession
                            ? loadedIdx
                            : this.sessionCache.getSessionStartIndex();
                        const isAlreadyPlayingOnWakeTarget = Boolean(
                            options?.fromMobileWake &&
                            state?.is_playing &&
                            state?.device?.is_active &&
                            (typeof state.progress_ms !== 'number' || state.progress_ms > 0) &&
                            (!this.canWakeLocalMobileSpotify() ||
                                !state.device.type ||
                                isMobileSpotifyDevice(state.device) ||
                                state.device.id === this.getPreferredDeviceId())
                        );
                        if (isAlreadyPlayingOnWakeTarget) {
                            this.setMobileWakeRequiredState(false);
                            if (this.statusText.startsWith('📱')) {
                                this.updateStatus('Ready');
                            }
                            this.resetStartupResumeKicks();
                            this.sessionCache.confirmSessionPlayback();
                            if (isCurrentInSession) {
                                this.sessionCache.setSessionStartIndex(loadedIdx);
                                this.lastPlayingTrack = sessionTracks[loadedIdx] ?? this.lastPlayingTrack;
                            }
                            if (this.lastPlayTime === 0) {
                                this.sessionCache.setLastPlayTime(Date.now());
                            }
                            this.reconcilePendingStartFailureAfterManualPlay();
                            this.lastKnownIsPlaying = true;
                            return { ok: true, status: 204 };
                        }

                        const shouldEscalateAfterFailedBareResume = Boolean(
                            this.manualBareResumeAttempted &&
                            !state?.is_playing &&
                            !options?.fromMobileWake
                        );
                        if (shouldEscalateAfterFailedBareResume) {
                            // Prior manual empty-body resume already returned 204 without starting playback;
                            // escalate directly to full `playTracks({ uris })` instead of calling bare resume again.
                            if (isCurrentInSession) {
                                this.sessionCache.setSessionStartIndex(loadedIdx);
                                this.lastPlayingTrack = sessionTracks[loadedIdx] ?? this.lastPlayingTrack;
                            }
                        } else {
                            const wasPausedBeforeResume = !state?.is_playing;
                            this.startupResumeKickCount = 0;
                            const kickNow = Date.now();
                            this.lastStartupResumeKickTime = kickNow;
                            const resumeDeviceId =
                                state?.device?.id ||
                                (typeof this.playerClient.getActiveDeviceId === 'function'
                                    ? this.playerClient.getActiveDeviceId() || undefined
                                    : undefined);
                            const useLoadedForceTransfer = Boolean(
                                options?.fromMobileWake ||
                                (wasPausedBeforeResume && state?.device && !state.device.is_active && isMobileSpotifyDevice(state.device))
                            );
                            const res = await this.playerClient.resume(
                                resumeDeviceId,
                                useLoadedForceTransfer
                                    ? { silent: true, forcePlayTransfer: true }
                                    : { silent: true }
                            );
                            if (resumeCmdSeq !== this.transportCommandSeq || this.userExplicitlyPaused) {
                                return { ok: false };
                            }
                            if (res.ok) {
                                let verifiedMobileLoadedResume = false;
                                if (wasPausedBeforeResume && this.canWakeLocalMobileSpotify()) {
                                    const verifyResult = await this.verifyMobileResumeStarted(resumeDeviceId, {
                                        skipForceTransferRetry: useLoadedForceTransfer,
                                        fromMobileWake: Boolean(options?.fromMobileWake),
                                        expectedTransportSeq: resumeCmdSeq,
                                        minExpectedSessionIndex: isCurrentInSession ? minExpectedIdx : undefined,
                                    });
                                    if (verifyResult === 'aborted') {
                                        return { ok: false };
                                    }
                                    if (verifyResult === 'wrong_track') {
                                        // Mobile device woke up playing a leftover foreign/stale track (e.g. after `forcePlayTransfer`);
                                        // escalate immediately to `playTracks({ uris })` from `effectiveResumeSessionIdx` on the now-awake device.
                                        this.sessionCache.setSessionStartIndex(effectiveResumeSessionIdx);
                                        this.lastPlayingTrack = sessionTracks[effectiveResumeSessionIdx] ?? this.lastPlayingTrack;
                                    } else if (verifyResult === 'blocked') {
                                        if (options?.fromMobileWake) {
                                            // Freshly cold-started Spotify may drop its prior paused track state;
                                            // escalate to `playTracks({ uris })` from `effectiveResumeSessionIdx` within the same wake call.
                                            this.sessionCache.setSessionStartIndex(effectiveResumeSessionIdx);
                                            this.lastPlayingTrack = sessionTracks[effectiveResumeSessionIdx] ?? this.lastPlayingTrack;
                                        } else {
                                            this.manualBareResumeAttempted = true;
                                            this.lastKnownIsPlaying = false;
                                            this.sessionCache.setSessionStartIndex(effectiveResumeSessionIdx);
                                            this.lastPlayingTrack = sessionTracks[effectiveResumeSessionIdx] ?? this.lastPlayingTrack;
                                            this.sessionCache.setHasConfirmedSessionPlayback(false);
                                            this.sessionCache.setHasInitiatedSessionInRuntime(true);
                                            this.sessionCache.setLastPlayTime(0);
                                            this.setMobileWakeRequiredState(true);
                                            this.updateStatus(
                                                '📱 Tap "Wake Spotify & Play" to resume backgrounded Spotify (Spotifyを起動して再生を開始してください)'
                                            );
                                            return {
                                                ok: false,
                                                status: res.status,
                                                mobileWakeRequired: true,
                                            };
                                        }
                                    } else {
                                        verifiedMobileLoadedResume = true;
                                        this.setMobileWakeRequiredState(false);
                                        if (this.statusText.startsWith('📱')) {
                                            this.updateStatus('Ready');
                                        }
                                    }
                                }
                                if (!wasPausedBeforeResume || !this.canWakeLocalMobileSpotify() || verifiedMobileLoadedResume) {
                                    const verifiedAt = Date.now();
                                    this.lastSuccessfulStartupKickTime = verifiedAt;
                                    if (isCurrentInSession) {
                                        this.sessionCache.setSessionStartIndex(loadedIdx);
                                        this.lastPlayingTrack = sessionTracks[loadedIdx] ?? this.lastPlayingTrack;
                                    }
                                    if (verifiedMobileLoadedResume && this.lastPlayTime === 0) {
                                        this.sessionCache.setLastPlayTime(verifiedAt);
                                    }
                                    if (
                                        Boolean(
                                            state?.is_playing &&
                                            typeof state.progress_ms === 'number' &&
                                            state.progress_ms > 0
                                        )
                                    ) {
                                        this.resetStartupResumeKicks();
                                        this.sessionCache.confirmSessionPlayback();
                                    } else if (wasPausedBeforeResume) {
                                        this.manualBareResumeAttempted = !verifiedMobileLoadedResume;
                                    }
                                    this.reconcilePendingStartFailureAfterManualPlay();
                                    this.lastKnownIsPlaying = true;
                                    return res;
                                }
                            }
                        }
                    }
                    shouldStartSessionTracks = true;
                } catch {
                    if (resumeCmdSeq !== this.transportCommandSeq || this.userExplicitlyPaused) {
                        return { ok: false };
                    }
                    // If state inspection fails and session playback was previously confirmed, try bare resume first
                    if (!shouldStartSessionTracks) {
                        const fallbackDeviceId =
                            typeof this.playerClient.getActiveDeviceId === 'function'
                                ? this.playerClient.getActiveDeviceId() || undefined
                                : undefined;
                        const wakeCapableFallback = this.canWakeLocalMobileSpotify();
                        const useFallbackForceTransfer = Boolean(
                            options?.fromMobileWake ||
                            (wakeCapableFallback && this.isKnownInactiveMobileDevice(fallbackDeviceId))
                        );
                        const res = await this.playerClient.resume(
                            fallbackDeviceId,
                            useFallbackForceTransfer
                                ? { silent: true, forcePlayTransfer: true }
                                : { silent: true }
                        );
                        if (resumeCmdSeq !== this.transportCommandSeq || this.userExplicitlyPaused) {
                            return { ok: false };
                        }
                        if (res.ok) {
                            if (wakeCapableFallback) {
                                const verifyResult = await this.verifyMobileResumeStarted(fallbackDeviceId, {
                                    skipForceTransferRetry: useFallbackForceTransfer,
                                    fromMobileWake: Boolean(options?.fromMobileWake),
                                    expectedTransportSeq: resumeCmdSeq,
                                    minExpectedSessionIndex: 0,
                                });
                                if (verifyResult === 'aborted') {
                                    return { ok: false };
                                }
                                if (verifyResult === 'wrong_track') {
                                    // Device woke onto a foreign track; fall through to `shouldStartSessionTracks = true`
                                } else if (verifyResult === 'blocked') {
                                    if (!options?.fromMobileWake) {
                                        this.manualBareResumeAttempted = true;
                                        this.lastKnownIsPlaying = false;
                                        this.sessionCache.setHasConfirmedSessionPlayback(false);
                                        this.sessionCache.setHasInitiatedSessionInRuntime(true);
                                        this.sessionCache.setLastPlayTime(0);
                                        this.setMobileWakeRequiredState(true);
                                        this.updateStatus(
                                            '📱 Tap "Wake Spotify & Play" to resume backgrounded Spotify (Spotifyを起動して再生を開始してください)'
                                        );
                                        return {
                                            ok: false,
                                            status: res.status,
                                            mobileWakeRequired: true,
                                        };
                                    }
                                } else {
                                    this.setMobileWakeRequiredState(false);
                                    if (this.statusText.startsWith('📱')) {
                                        this.updateStatus('Ready');
                                    }
                                    if (this.lastPlayTime === 0) {
                                        this.sessionCache.setLastPlayTime(Date.now());
                                    }
                                    this.lastKnownIsPlaying = true;
                                    return res;
                                }
                            } else {
                                this.lastKnownIsPlaying = true;
                                return res;
                            }
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
                    const sessionStartIdx = this.sessionCache.getSessionStartIndex();
                    const startIdx = isUnconfirmedRuntimeSession
                        ? Math.max(currentIdx, sessionStartIdx)
                        : (currentIdx >= 0 ? currentIdx : sessionStartIdx);
                    const tracksToPlay = sessionTracks.slice(startIdx);
                    if (tracksToPlay.length > 0) {
                        await this.playTracks(tracksToPlay, {
                            isDJSession: true,
                            fullSessionTracks: sessionTracks,
                            sessionStartIndex: startIdx,
                            fastFailOnEmpty: !options?.fromMobileWake && this.canWakeLocalMobileSpotify(),
                        });
                        if (this.mobileWakeRequired) {
                            return { ok: false, mobileWakeRequired: true };
                        }
                        if (this.lastKnownIsPlaying === false && !this.hasConfirmedSessionPlayback) {
                            return { ok: false };
                        }
                        return { ok: true, status: 204 };
                    }
                } catch (e) {
                    const classified = this.mobileWakeRequired
                        ? (typeof this.playerClient.getLastError === 'function' ? this.playerClient.getLastError() : null)
                        : (this.playerClient.reportThrownError(e, 'play') ??
                            (typeof this.playerClient.getLastError === 'function' ? this.playerClient.getLastError() : null));
                    return {
                        ok: false,
                        status: classified?.status,
                        error: classified ?? undefined,
                        ...(this.mobileWakeRequired ? { mobileWakeRequired: true } : {}),
                    };
                }
            }
        }

        const wakeCapableMobile = this.canWakeLocalMobileSpotify();
        let bareTargetId = this.playerClient.getActiveDeviceId() || undefined;
        if (
            wakeCapableMobile &&
            !bareTargetId &&
            typeof this.playerClient.resolveTargetDevice === 'function'
        ) {
            try {
                bareTargetId = await this.playerClient.resolveTargetDevice(
                    !options?.fromMobileWake ? { fastFailOnEmpty: true } : undefined
                );
            } catch (e) {
                if (resumeCmdSeq !== this.transportCommandSeq || this.userExplicitlyPaused) {
                    return { ok: false };
                }
                const classified =
                    this.playerClient.reportThrownError?.(e, 'resolve_device') ??
                    (typeof this.playerClient.getLastError === 'function'
                        ? this.playerClient.getLastError()
                        : null) ??
                    undefined;
                this.lastKnownIsPlaying = false;
                this.setMobileWakeRequiredState(true);
                this.updateStatus(
                    '📱 Tap "Wake Spotify & Play" to resume backgrounded Spotify (Spotifyを起動して再生を開始してください)'
                );
                return {
                    ok: false,
                    status: classified?.status,
                    error: classified,
                    mobileWakeRequired: true,
                };
            }
        }

        if (resumeCmdSeq !== this.transportCommandSeq || this.userExplicitlyPaused) {
            return { ok: false };
        }

        const useInitialForceTransfer = Boolean(
            options?.fromMobileWake ||
            (wakeCapableMobile && this.isKnownInactiveMobileDevice(bareTargetId))
        );
        const res = await this.playerClient.resume(
            bareTargetId,
            useInitialForceTransfer ? { silent: true, forcePlayTransfer: true } : undefined
        );
        if (resumeCmdSeq !== this.transportCommandSeq || this.userExplicitlyPaused) {
            return { ok: false };
        }
        if (!res.ok) {
            if (
                wakeCapableMobile &&
                (res.status === 404 || res.error?.category === 'device_not_found')
            ) {
                this.lastKnownIsPlaying = false;
                this.setMobileWakeRequiredState(true);
                this.updateStatus(
                    '📱 Tap "Wake Spotify & Play" to resume backgrounded Spotify (Spotifyを起動して再生を開始してください)'
                );
                return { ...res, mobileWakeRequired: true };
            }
            return res;
        }

        if (wakeCapableMobile) {
            const verifyResult = await this.verifyMobileResumeStarted(bareTargetId, {
                skipForceTransferRetry: useInitialForceTransfer,
                fromMobileWake: Boolean(options?.fromMobileWake),
                expectedTransportSeq: resumeCmdSeq,
            });
            if (verifyResult === 'aborted') {
                return { ok: false };
            }
            if (verifyResult === 'blocked') {
                this.lastKnownIsPlaying = false;
                this.setMobileWakeRequiredState(true);
                this.updateStatus(
                    '📱 Tap "Wake Spotify & Play" to resume backgrounded Spotify (Spotifyを起動して再生を開始してください)'
                );
                return {
                    ok: false,
                    status: res.status,
                    mobileWakeRequired: true,
                };
            }
            this.setMobileWakeRequiredState(false);
            if (this.statusText.startsWith('📱')) {
                this.updateStatus('Ready');
            }
        }

        this.lastKnownIsPlaying = true;
        return res;
    }
}
