'use client';

import React, { createContext, useContext, useEffect, useState, useRef, useCallback, useMemo, ReactNode } from 'react';
import { DJCore } from '../lib/dj-core';
import { SpotifyAuth } from '../lib/spotify-auth';
import { STORAGE_KEYS, PLAYBACK_CONSTANTS, DEFAULT_MODELS, DEFAULTS } from '../lib/constants';
import { AIProvider, ScheduleItem, SpotifyApiErrorInfo, Track } from '../lib/types';
import { getStorageItem, removeStorageItem, getStoredJSON, setStoredJSON } from '../lib/storage';
import { useDJPollingLoops } from '../hooks/useDJPollingLoops';
import { useIsHydrated } from '../hooks/useIsHydrated';
import { PlaybackConvergenceController } from '../lib/playback-sync';
import {
    isMobileBrowserEnvironment,
    selectTargetSpotifyDevice,
    shouldSuppressBackgroundKeepAlive,
} from '../lib/spotify-player-client';
import {
    generateTrackKey,
    getScheduleItemSignature,
    isWaitingForScheduleStart,
    resolveScheduleThought,
} from '../lib/dj-utils';

const EMPTY_SCHEDULE: ScheduleItem[] = [];

export interface SetupStatus {
    hasClientId: boolean;
    hasAiKey: boolean;
}

export interface ResolvedAIConfig {
    provider: AIProvider;
    apiKey: string;
    model: string;
}

export interface PlayerLogsContextType {
    logs: string[];
}

export interface PlayerQueueScheduleContextType {
    queue: Track[];
    schedule: ScheduleItem[];
    setSchedule: (s: ScheduleItem[]) => void;
    handleRemoveScheduleItem: (index: number) => void;
}

export interface PlayerPlaybackContextType {
    status: string;
    currentTrack: Track | null;
    isPlaying: boolean;
    deviceName: string;
    devices: SpotifyApi.UserDevice[];
    currentQuery: string | null;
    currentThought: string | null;
    error: string | null;
}

export interface PlayerActionsContextType {
    djCore: DJCore | null;
    authorized: boolean;
    needsOnboarding: boolean;
    setupStatus: SetupStatus;
    setStatus: (s: string) => void;
    setSchedule: (s: ScheduleItem[]) => void;
    refreshDevices: () => Promise<void>;
    setDevice: (deviceId: string) => Promise<void>;
    handleNext: () => Promise<void>;
    handlePrev: () => Promise<void>;
    handleTogglePlay: () => Promise<void>;
    handlePlayQueueIndex: (index: number) => Promise<void>;
    handleRemoveScheduleItem: (index: number) => void;
    clearError: () => void;
    startBackgroundKeepAlive: () => void;
    syncUIState: (options?: { forceAll?: boolean }) => Promise<SpotifyApi.CurrentPlaybackResponse | null>;
    reloadConfig: () => void;
}

export type PlayerContextType =
    PlayerActionsContextType &
    PlayerPlaybackContextType &
    PlayerQueueScheduleContextType &
    PlayerLogsContextType;

const PlayerLogsContext = createContext<PlayerLogsContextType | undefined>(undefined);
const PlayerQueueScheduleContext = createContext<PlayerQueueScheduleContextType | undefined>(undefined);
const PlayerPlaybackContext = createContext<PlayerPlaybackContextType | undefined>(undefined);
const PlayerActionsContext = createContext<PlayerActionsContextType | undefined>(undefined);

export function resolveAIConfigFromStorage(): ResolvedAIConfig | null {
    const rawProvider = getStorageItem(STORAGE_KEYS.SELECTED_AI_PROVIDER, '').trim();
    const openaiKey = getStorageItem(STORAGE_KEYS.OPENAI_API_KEY, '').trim();
    const openaiModel = getStorageItem(STORAGE_KEYS.OPENAI_MODEL, '').trim() || DEFAULT_MODELS.OPENAI;
    const geminiKey = getStorageItem(STORAGE_KEYS.GEMINI_API_KEY, '').trim();
    const geminiModel = getStorageItem(STORAGE_KEYS.GEMINI_MODEL, '').trim() || DEFAULT_MODELS.GEMINI;

    if (rawProvider === 'gemini') {
        return geminiKey ? { provider: 'gemini', apiKey: geminiKey, model: geminiModel } : null;
    }
    if (rawProvider === 'openai') {
        return openaiKey ? { provider: 'openai', apiKey: openaiKey, model: openaiModel } : null;
    }
    // Fallback when SELECTED_AI_PROVIDER has not been explicitly stored yet
    if (openaiKey) {
        return { provider: 'openai', apiKey: openaiKey, model: openaiModel };
    }
    if (geminiKey) {
        return { provider: 'gemini', apiKey: geminiKey, model: geminiModel };
    }
    return null;
}

export function computeSetupStatus(): SetupStatus {
    const clientId = getStorageItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID, '').trim();
    const aiConfig = resolveAIConfigFromStorage();
    return { hasClientId: Boolean(clientId), hasAiKey: Boolean(aiConfig) };
}

export function shouldShowOnboarding(params: {
    setupStatus: SetupStatus;
    authorized: boolean;
    isAuthPending: boolean;
}): boolean {
    if (!params.setupStatus.hasClientId || !params.setupStatus.hasAiKey) {
        return true;
    }
    if (params.authorized || params.isAuthPending) {
        return false;
    }
    return true;
}

export function applyStoredConfigToDJ(dj: DJCore) {
    const aiConfig = resolveAIConfigFromStorage();
    if (aiConfig) {
        dj.initAI(aiConfig.provider, aiConfig.apiKey, aiConfig.model);
    } else {
        dj.clearAI();
    }

    const savedFiltering = getStorageItem(STORAGE_KEYS.AI_FILTERING_ENABLED, '');
    dj.updateConfig({
        aiFiltering: savedFiltering === '' ? DEFAULTS.AI_FILTERING_ENABLED : savedFiltering === 'true'
    });
}

export function isSameTrackDisplay(a: Track | null, b: Track | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return (
        a.uri === b.uri &&
        a.id === b.id &&
        a.name === b.name &&
        a.vibeTag === b.vibeTag &&
        a.selectionReason === b.selectionReason &&
        a.stage === b.stage &&
        a.energy === b.energy &&
        a.contextName === b.contextName
    );
}

export type CrossTabStorageAction = 'reload_config' | 'sync_schedule' | 'sync_query' | 'ignore';

const CONFIG_AND_AUTH_STORAGE_KEYS = new Set<string>([
    STORAGE_KEYS.SPOTIFY_CLIENT_ID,
    STORAGE_KEYS.SPOTIFY_ACCESS_TOKEN,
    STORAGE_KEYS.SPOTIFY_EXPIRES_AT,
    STORAGE_KEYS.SPOTIFY_REFRESH_TOKEN,
    STORAGE_KEYS.OPENAI_API_KEY,
    STORAGE_KEYS.OPENAI_MODEL,
    STORAGE_KEYS.GEMINI_API_KEY,
    STORAGE_KEYS.GEMINI_MODEL,
    STORAGE_KEYS.SELECTED_AI_PROVIDER,
    STORAGE_KEYS.AI_FILTERING_ENABLED,
    STORAGE_KEYS.BACKGROUND_KEEP_ALIVE,
]);

export function classifyStorageEventAction(key: string | null): CrossTabStorageAction {
    if (key === null || CONFIG_AND_AUTH_STORAGE_KEYS.has(key)) {
        return 'reload_config';
    }
    if (key === STORAGE_KEYS.DJ_SCHEDULE) {
        return 'sync_schedule';
    }
    if (key === STORAGE_KEYS.DJ_LAST_QUERY) {
        return 'sync_query';
    }
    return 'ignore';
}

export function isSameDeviceList(a: SpotifyApi.UserDevice[], b: SpotifyApi.UserDevice[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (
            a[i].id !== b[i].id ||
            a[i].name !== b[i].name ||
            a[i].is_active !== b[i].is_active ||
            a[i].type !== b[i].type ||
            a[i].volume_percent !== b[i].volume_percent
        ) {
            return false;
        }
    }
    return true;
}

export function PlayerProvider({ children }: { children: ReactNode }) {
    const isHydrated = useIsHydrated();
    const [authorized, setAuthorized] = useState(false);
    const [djCore, setDjCore] = useState<DJCore | null>(null);
    const [status, setStatus] = useState('Initializing...');

    const [currentTrack, setCurrentTrack] = useState<Track | null>(() => {
        if (typeof window !== 'undefined') {
            return getStoredJSON<Track | null>(STORAGE_KEYS.DJ_CURRENT_PLAYING_TRACK, null);
        }
        return null;
    });
    const [isPlaying, setIsPlaying] = useState(false);
    const [deviceName, setDeviceName] = useState('');
    const [schedule, setScheduleState] = useState<ScheduleItem[]>(() => {
        if (typeof window !== 'undefined') {
            return getStoredJSON<ScheduleItem[]>(STORAGE_KEYS.DJ_SCHEDULE, []);
        }
        return [];
    });
    const [currentQuery, setCurrentQuery] = useState<string | null>(() => {
        if (typeof window !== 'undefined') {
            return getStorageItem(STORAGE_KEYS.DJ_LAST_QUERY, '') || null;
        }
        return null;
    });
    const [currentThought, setCurrentThought] = useState<string | null>(() => {
        if (typeof window !== 'undefined') {
            const savedSchedule = getStoredJSON<ScheduleItem[]>(STORAGE_KEYS.DJ_SCHEDULE, []);
            const savedQuery = getStorageItem(STORAGE_KEYS.DJ_LAST_QUERY, '') || null;
            return resolveScheduleThought(savedSchedule, savedQuery);
        }
        return null;
    });
    const [needsOnboarding, setNeedsOnboarding] = useState(false);
    const [setupStatus, setSetupStatus] = useState<SetupStatus>(() => computeSetupStatus());
    const [queue, setQueue] = useState<Track[]>([]);
    const [devices, setDevices] = useState<SpotifyApi.UserDevice[]>([]);
    const [djLogs, setDjLogs] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);

    const djRef = useRef<DJCore | null>(null);
    const detachDJSubscriptionsRef = useRef<(() => void) | null>(null);
    const convergenceRef = useRef<PlaybackConvergenceController>(new PlaybackConvergenceController());
    const backgroundAudioRef = useRef<HTMLAudioElement | null>(null);
    const lastTrackUriRef = useRef<string | null>(currentTrack?.uri || null);
    const currentTrackRef = useRef<Track | null>(currentTrack);
    const isPlayingRef = useRef<boolean>(false);
    const deviceNameRef = useRef<string>('');
    const lastProgressMsRef = useRef<number | null>(null);
    const isRefreshingTokenRef = useRef<boolean>(false);
    const lastSessionActiveRef = useRef<boolean | null>(null);
    const lastDevicesFetchRef = useRef<number>(0);
    const lastQueueSyncPlayTimeRef = useRef<number>(0);
    const lastSyncedSessionVersionRef = useRef<number>(0);
    const queueLengthRef = useRef<number>(0);
    const queueRef = useRef<Track[]>([]);
    const hasInitialQueueSyncRef = useRef<boolean>(false);
    const devicesRef = useRef<SpotifyApi.UserDevice[]>([]);

    const updateIsPlaying = useCallback((next: boolean) => {
        isPlayingRef.current = next;
        setIsPlaying(next);
    }, []);

    const updateDeviceName = useCallback((next: string) => {
        deviceNameRef.current = next;
        setDeviceName(next);
    }, []);

    const persistPlayingTrack = useCallback((track: Track | null, updateSessionCache: boolean = true) => {
        if (updateSessionCache && djRef.current) {
            djRef.current.getSessionCache().setLastPlayingTrack(track, true);
        } else if (track) {
            setStoredJSON(STORAGE_KEYS.DJ_CURRENT_PLAYING_TRACK, track);
        }
    }, []);

    const setSchedule = useCallback((nextSchedule: ScheduleItem[]) => {
        setScheduleState(nextSchedule);
        if (djRef.current) {
            if (djRef.current.getSchedule() !== nextSchedule) {
                djRef.current.setSchedule(nextSchedule, true);
            }
        } else {
            setStoredJSON(STORAGE_KEYS.DJ_SCHEDULE, nextSchedule);
        }
    }, []);

    const updateQueueState = useCallback((nextQueue: Track[]) => {
        queueRef.current = nextQueue;
        queueLengthRef.current = nextQueue.length;
        setQueue(prev => {
            if (
                prev.length === nextQueue.length &&
                prev.every((t, i) => isSameTrackDisplay(t, nextQueue[i]))
            ) {
                return prev;
            }
            return nextQueue;
        });
    }, []);

    const updateDevicesState = useCallback((nextDevices: SpotifyApi.UserDevice[]) => {
        devicesRef.current = nextDevices;
        setDevices(prev => (isSameDeviceList(prev, nextDevices) ? prev : nextDevices));
    }, []);

    const stopBackgroundKeepAlive = useCallback(() => {
        if (backgroundAudioRef.current) {
            const audio = backgroundAudioRef.current;
            backgroundAudioRef.current = null;
            try {
                audio.pause();
                audio.currentTime = 0;
                audio.src = '';
                if (typeof audio.load === 'function') {
                    audio.load();
                }
            } catch {
                // Ignore audio cleanup errors
            }
            console.log("🔇 Background Keep-Alive Audio Stopped");
        }
    }, []);

    const resetLoggedOutState = useCallback((nextSetup: SetupStatus, nextStatus: string) => {
        stopBackgroundKeepAlive();
        convergenceRef.current.cancel();
        if (detachDJSubscriptionsRef.current) {
            detachDJSubscriptionsRef.current();
            detachDJSubscriptionsRef.current = null;
        }
        djRef.current = null;
        setDjCore(null);
        updateIsPlaying(false);
        updateDeviceName('');
        updateDevicesState([]);
        updateQueueState([]);
        currentTrackRef.current = null;
        setCurrentTrack(null);
        lastTrackUriRef.current = null;
        setAuthorized(false);
        setStatus(nextStatus);
        setNeedsOnboarding(shouldShowOnboarding({
            setupStatus: nextSetup,
            authorized: false,
            isAuthPending: false,
        }));
    }, [stopBackgroundKeepAlive, updateIsPlaying, updateDeviceName, updateDevicesState, updateQueueState]);

    const handleAuthExpired = useCallback(() => {
        if (isRefreshingTokenRef.current) return;
        const clientId = getStorageItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID, '').trim();
        const nextSetup = computeSetupStatus();
        setSetupStatus(nextSetup);
        if (!clientId) {
            SpotifyAuth.logout();
            resetLoggedOutState(nextSetup, 'connect_needed');
            return;
        }
        isRefreshingTokenRef.current = true;
        void SpotifyAuth.refreshToken(clientId)
            .then((refreshed) => {
                if (refreshed) {
                    djRef.current?.updateAccessToken(refreshed);
                } else {
                    SpotifyAuth.logout();
                    resetLoggedOutState(computeSetupStatus(), 'connect_needed');
                }
            })
            .finally(() => {
                isRefreshingTokenRef.current = false;
            });
    }, [resetLoggedOutState]);

    const syncUIState = useCallback(async (options?: { forceAll?: boolean }) => {
        if (!djRef.current) return null;
        const forceAll = options?.forceAll ?? false;

        try {
            // 1. Fetch playback state first to determine the exact currently playing track & progress
            const playbackState = await djRef.current.getPlaybackState();
            const guard = convergenceRef.current.inspectState(playbackState);

            if (playbackState && !playbackState.__optimisticFallback && typeof playbackState.progress_ms === 'number') {
                lastProgressMsRef.current = playbackState.progress_ms;
            }

            const rawTrackItem = (playbackState && playbackState.item && playbackState.item.type === 'track')
                ? (playbackState.item as Track)
                : null;

            const isSessionActive = typeof djRef.current.isSessionPlaybackActive === 'function'
                ? djRef.current.isSessionPlaybackActive()
                : false;

            const hasExternalContextUri = Boolean(playbackState?.context?.uri);
            const isRawTrackInSession = Boolean(
                !hasExternalContextUri &&
                rawTrackItem &&
                djRef.current.findTrackIndexInSession(rawTrackItem) >= 0
            );
            // If ContextDJ has an active session and Spotify is paused/idle on a leftover external track
            // OR playing a leftover external track while ContextDJ's session has not yet been confirmed on the device,
            // keep ContextDJ's session track & show Play (not Pause) so pressing Play starts ContextDJ Track 1 immediately.
            const isForeignOrIdleInSession = Boolean(
                isSessionActive &&
                !playbackState?.__optimisticFallback &&
                !isRawTrackInSession
            );
            const sessionTracks = djRef.current.getSessionCache().getSessionTracks();
            const sessionStartIdx = djRef.current.getSessionCache().getSessionStartIndex();
            const authoritativeSessionTrack =
                sessionTracks[sessionStartIdx] ??
                (currentTrackRef.current && djRef.current.findTrackIndexInSession(currentTrackRef.current) >= 0
                    ? currentTrackRef.current
                    : null);
            const currentTrackItem = isForeignOrIdleInSession
                ? authoritativeSessionTrack
                : rawTrackItem;

            const currentTrackUri = currentTrackItem?.uri || null;
            const trackChanged = !guard.suppressTrackUpdate && currentTrackUri !== lastTrackUriRef.current;
            if (trackChanged) {
                lastTrackUriRef.current = currentTrackUri;
            }

            const sessionModeChanged = !guard.suppressTrackUpdate &&
                lastSessionActiveRef.current !== null &&
                isSessionActive !== lastSessionActiveRef.current;
            if (!guard.suppressTrackUpdate) {
                lastSessionActiveRef.current = isSessionActive;
            }

            // 2. Conditionally fetch Queue (skip overwriting optimistic queue if track is still in stale transition)
            const lastPlayTime = typeof djRef.current.getLastPlayTime === 'function' ? djRef.current.getLastPlayTime() : 0;
            const newPlayOccurred = lastPlayTime > lastQueueSyncPlayTimeRef.current;
            const currentSessionVersion = typeof djRef.current.getSessionCache === 'function'
                ? djRef.current.getSessionCache().getSessionVersion()
                : 0;
            const sessionTracksChanged = currentSessionVersion !== lastSyncedSessionVersionRef.current;
            const shouldFetchQueue = !guard.suppressTrackUpdate && (
                forceAll || trackChanged || sessionModeChanged || !hasInitialQueueSyncRef.current || newPlayOccurred || sessionTracksChanged
            );
            let queuePromise: Promise<Track[]> | null = null;
            if (shouldFetchQueue) {
                queuePromise = djRef.current.getQueue(currentTrackItem);
            }

            // 3. Conditionally fetch Devices
            const now = Date.now();
            const shouldFetchDevices = forceAll || devicesRef.current.length === 0 ||
                (now - lastDevicesFetchRef.current > PLAYBACK_CONSTANTS.DEVICE_REFRESH_INTERVAL_MS);
            let devicesPromise: Promise<SpotifyApi.UserDevice[]> | null = null;
            if (shouldFetchDevices) {
                devicesPromise = djRef.current.getDevices();
                lastDevicesFetchRef.current = now;
            }

            if (queuePromise) {
                const currentQ = await queuePromise;
                hasInitialQueueSyncRef.current = true;
                updateQueueState(currentQ.slice(0, 20));
                lastQueueSyncPlayTimeRef.current = lastPlayTime;
                lastSyncedSessionVersionRef.current = currentSessionVersion;
            }
            let latestDevices = devicesRef.current;
            if (devicesPromise) {
                const currentDevices = await devicesPromise;
                latestDevices = currentDevices;
                updateDevicesState(currentDevices);
            }

            if (
                backgroundAudioRef.current &&
                shouldSuppressBackgroundKeepAlive({
                    isMobile: isMobileBrowserEnvironment(),
                    devices: latestDevices,
                    preferredDeviceId: typeof djRef.current.getPreferredDeviceId === 'function'
                        ? djRef.current.getPreferredDeviceId()
                        : null,
                    activeDeviceType: !playbackState?.__optimisticFallback ? playbackState?.device?.type ?? null : null,
                })
            ) {
                stopBackgroundKeepAlive();
            }

            // Determine Device Name (suppress stale device revert while device transfer is converging,
            // and never overwrite a real device name with synthetic startup fallback 'Connecting...')
            if (!guard.suppressDeviceUpdate) {
                let activeDeviceName = '';
                if (playbackState && playbackState.device && !playbackState.__optimisticFallback) {
                    activeDeviceName = playbackState.device.name;
                } else if (latestDevices.length > 0) {
                    const activeD = latestDevices.find(d => d.is_active && !d.is_restricted) || latestDevices.find(d => d.is_active);
                    if (activeD) {
                        activeDeviceName = activeD.name;
                    } else {
                        const targetD = selectTargetSpotifyDevice(latestDevices, {
                            preferredDeviceId: typeof djRef.current.getPreferredDeviceId === 'function'
                                ? djRef.current.getPreferredDeviceId()
                                : null,
                            isMobile: isMobileBrowserEnvironment(),
                        });
                        if (targetD) activeDeviceName = targetD.name;
                    }
                } else if (playbackState?.device?.name && !deviceNameRef.current) {
                    activeDeviceName = playbackState.device.name;
                }
                if (activeDeviceName && activeDeviceName !== deviceNameRef.current) {
                    updateDeviceName(activeDeviceName);
                }
            }

            // Sync Track Info (suppress stale track/play-state revert while transport command is converging)
            if (currentTrackItem) {
                if (!guard.suppressTrackUpdate) {
                    const finalTrack = djRef.current.enrichTrackWithCachedMetadata(currentTrackItem);
                    currentTrackRef.current = finalTrack;
                    const shouldUpdateSessionCache = Boolean(playbackState && !playbackState.__optimisticFallback && !isForeignOrIdleInSession);
                    setCurrentTrack(prev => {
                        if (isSameTrackDisplay(prev, finalTrack)) {
                            return prev;
                        }
                        persistPlayingTrack(finalTrack, shouldUpdateSessionCache);
                        return finalTrack;
                    });
                }
                if (!guard.suppressPlayStateUpdate) {
                    updateIsPlaying(!isForeignOrIdleInSession && Boolean(playbackState?.is_playing));
                }
            } else if (!guard.suppressTrackUpdate) {
                const isNonTrackMedia = Boolean(
                    playbackState &&
                    ((playbackState.item && playbackState.item.type !== 'track') ||
                        (playbackState.currently_playing_type &&
                            playbackState.currently_playing_type !== 'track' &&
                            playbackState.currently_playing_type !== 'unknown'))
                );
                if (isNonTrackMedia && (!isSessionActive || (!isForeignOrIdleInSession && playbackState?.is_playing))) {
                    currentTrackRef.current = null;
                    setCurrentTrack(null);
                    persistPlayingTrack(null, true);
                }
                if (!guard.suppressPlayStateUpdate) {
                    updateIsPlaying(false);
                }
            }

            // Update Status
            const djStatus = djRef.current.getDJStatus();
            setCurrentQuery(djStatus.currentQuery);
            setCurrentThought(djStatus.currentThought);

            return playbackState;
        } catch (syncErr) {
            console.error("Error in syncUIState:", syncErr);
            return null;
        }
    }, [stopBackgroundKeepAlive, updateQueueState, updateDevicesState, updateDeviceName, updateIsPlaying, persistPlayingTrack]);

    const attachDJInstance = useCallback((token: string) => {
        if (djRef.current) {
            djRef.current.updateAccessToken(token);
            applyStoredConfigToDJ(djRef.current);
            return;
        }

        if (detachDJSubscriptionsRef.current) {
            detachDJSubscriptionsRef.current();
            detachDJSubscriptionsRef.current = null;
        }

        const dj = new DJCore(token);
        applyStoredConfigToDJ(dj);

        djRef.current = dj;
        setDjCore(dj);
        const initialSnapshot = dj.getStateSnapshot();
        setScheduleState(initialSnapshot.schedule);
        setCurrentQuery(initialSnapshot.currentQuery);
        setCurrentThought(initialSnapshot.currentThought);
        if (initialSnapshot.status.startsWith('⏰')) {
            setStatus(initialSnapshot.status);
        }

        dj.setErrorCallback((errMsg: string, errInfo?: SpotifyApiErrorInfo) => {
            setError(prev => (prev === errMsg ? prev : errMsg));
            if (errInfo?.category === 'auth_expired') {
                handleAuthExpired();
            }
        });
        const unsubscribeState = dj.subscribe((snapshot) => {
            setStatus(snapshot.status);
            setCurrentQuery(snapshot.currentQuery);
            setCurrentThought(snapshot.currentThought);
            setScheduleState(prev => (prev === snapshot.schedule ? prev : snapshot.schedule));
        });
        const unsubscribeLogs = dj.subscribeLogs((latestLogs) => {
            setDjLogs(prev =>
                prev.length === latestLogs.length && prev[0] === latestLogs[0]
                    ? prev
                    : latestLogs
            );
        });

        dj.setOnTracksPlayedCallback((tracks) => {
            if (tracks.length > 0) {
                setError(null);
                const first = tracks[0];
                currentTrackRef.current = first;
                setCurrentTrack(first);
                persistPlayingTrack(first, false);
                updateQueueState(tracks.slice(1, 21));
                updateIsPlaying(true);
                lastTrackUriRef.current = first.uri;
                lastQueueSyncPlayTimeRef.current = dj.getLastPlayTime();
                lastSyncedSessionVersionRef.current = dj.getSessionCache().getSessionVersion();
                void convergenceRef.current.syncUntilConverged(
                    {
                        expectedTrackUri: first.uri,
                        expectedTrackKey: generateTrackKey(first),
                        expectedIsPlaying: true,
                    },
                    syncUIState
                );
            }
        });

        const savedSessionTracks = dj.getSessionCache().getSessionTracks();
        if (savedSessionTracks.length > 0) {
            const startIdx = dj.getSessionCache().getSessionStartIndex();
            updateQueueState(savedSessionTracks.slice(startIdx + 1, startIdx + 21));
        }

        detachDJSubscriptionsRef.current = () => {
            unsubscribeState();
            unsubscribeLogs();
        };
    }, [handleAuthExpired, persistPlayingTrack, syncUIState, updateIsPlaying, updateQueueState]);

    const reloadConfig = useCallback(() => {
        if (getStorageItem(STORAGE_KEYS.BACKGROUND_KEEP_ALIVE) !== 'true') {
            stopBackgroundKeepAlive();
        }
        const storedClientId = getStorageItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID, '').trim();
        const nextSetup = computeSetupStatus();
        setSetupStatus(nextSetup);

        if (!storedClientId) {
            resetLoggedOutState(nextSetup, 'Please configure settings first.');
            return;
        }

        const isAuth = SpotifyAuth.isAuthenticated();
        const token = SpotifyAuth.getAccessToken();
        if (isAuth && token) {
            setAuthorized(true);
            setNeedsOnboarding(shouldShowOnboarding({
                setupStatus: nextSetup,
                authorized: true,
                isAuthPending: false,
            }));
            attachDJInstance(token);
            setStatus(prev => (prev === 'connect_needed' || prev === 'Please configure settings first.' ? 'Ready' : prev));
            return;
        }

        const hasRefreshToken = Boolean(getStorageItem(STORAGE_KEYS.SPOTIFY_REFRESH_TOKEN, '').trim());
        if (hasRefreshToken) {
            setNeedsOnboarding(shouldShowOnboarding({
                setupStatus: nextSetup,
                authorized: false,
                isAuthPending: true,
            }));
            void SpotifyAuth.refreshToken(storedClientId).then((refreshed) => {
                const latestSetup = computeSetupStatus();
                setSetupStatus(latestSetup);
                if (refreshed) {
                    setAuthorized(true);
                    setNeedsOnboarding(shouldShowOnboarding({
                        setupStatus: latestSetup,
                        authorized: true,
                        isAuthPending: false,
                    }));
                    attachDJInstance(refreshed);
                    setStatus(prev => (prev === 'connect_needed' || prev === 'Please configure settings first.' ? 'Ready' : prev));
                } else {
                    SpotifyAuth.logout();
                    resetLoggedOutState(latestSetup, 'connect_needed');
                }
            });
            return;
        }

        resetLoggedOutState(nextSetup, 'connect_needed');
    }, [attachDJInstance, resetLoggedOutState, stopBackgroundKeepAlive]);

    // Synchronize auth, settings, and schedule changes across browser tabs
    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
            return;
        }
        const handleStorageChange = (e: StorageEvent) => {
            const action = classifyStorageEventAction(e.key);
            if (action === 'reload_config') {
                reloadConfig();
            } else if (action === 'sync_schedule') {
                const nextSchedule = getStoredJSON<ScheduleItem[]>(STORAGE_KEYS.DJ_SCHEDULE, []);
                setScheduleState(nextSchedule);
                if (djRef.current) {
                    djRef.current.setSchedule(nextSchedule, false);
                } else {
                    let effectiveQuery = getStorageItem(STORAGE_KEYS.DJ_LAST_QUERY, '') || null;
                    if (nextSchedule.length === 0) {
                        effectiveQuery = null;
                        setCurrentQuery(null);
                    } else if (isWaitingForScheduleStart(nextSchedule)) {
                        if (effectiveQuery && nextSchedule.some(item => getScheduleItemSignature(item) === effectiveQuery)) {
                            effectiveQuery = null;
                        }
                        setCurrentQuery(prev =>
                            prev && nextSchedule.some(item => getScheduleItemSignature(item) === prev) ? null : prev
                        );
                    }
                    setCurrentThought(resolveScheduleThought(nextSchedule, effectiveQuery));
                }
            } else if (action === 'sync_query') {
                setCurrentQuery(getStorageItem(STORAGE_KEYS.DJ_LAST_QUERY, '') || null);
            }
        };
        window.addEventListener('storage', handleStorageChange);
        return () => {
            window.removeEventListener('storage', handleStorageChange);
        };
    }, [reloadConfig]);

    // Initialize Auth & DJCore
    useEffect(() => {
        let isCancelled = false;
        const convergenceController = convergenceRef.current;

        const init = async () => {
            try {
                const initialSetup = computeSetupStatus();
                setSetupStatus(initialSetup);

                const params = new URLSearchParams(window.location.search);
                const code = params.get('code');
                const returnedState = params.get('state');
                const oauthError = params.get('error');
                const storedClientId = getStorageItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID, '').trim();

                if (oauthError) {
                    window.history.replaceState({}, document.title, window.location.pathname);
                    removeStorageItem(STORAGE_KEYS.SPOTIFY_VERIFIER);
                    removeStorageItem(STORAGE_KEYS.SPOTIFY_AUTH_STATE);
                    const oauthMsg = oauthError === 'access_denied'
                        ? 'Spotify authorization was cancelled. Please click Login to connect your account. (Spotifyの認証がキャンセルされました)'
                        : `Spotify authorization failed: ${oauthError} (Spotify認証エラー: ${oauthError})`;
                    setError(oauthMsg);
                }

                const hasPendingAuth = Boolean(
                    storedClientId &&
                    !oauthError &&
                    (code || SpotifyAuth.isAuthenticated() || getStorageItem(STORAGE_KEYS.SPOTIFY_REFRESH_TOKEN, '').trim())
                );
                setNeedsOnboarding(shouldShowOnboarding({
                    setupStatus: initialSetup,
                    authorized: SpotifyAuth.isAuthenticated(),
                    isAuthPending: hasPendingAuth,
                }));

                if (!storedClientId) {
                    setStatus('Please configure settings first.');
                    return;
                }

                let token: string | null = SpotifyAuth.getAccessToken();

                if (code) {
                    setStatus('Authenticating...');
                    token = await SpotifyAuth.handleCallback(storedClientId, code, returnedState);
                    window.history.replaceState({}, document.title, window.location.pathname);
                    if (!token) {
                        const callbackErr = SpotifyAuth.getLastError();
                        if (callbackErr) {
                            setError(callbackErr);
                        }
                    }
                }

                if (isCancelled) return;

                if (!token || !SpotifyAuth.isAuthenticated()) {
                    const newToken = await SpotifyAuth.refreshToken(storedClientId);
                    if (isCancelled) return;
                    if (newToken) {
                        token = newToken;
                        console.log("Token refreshed successfully");
                    } else {
                        SpotifyAuth.logout();
                        const latestSetup = computeSetupStatus();
                        setSetupStatus(latestSetup);
                        setAuthorized(false);
                        setNeedsOnboarding(shouldShowOnboarding({
                            setupStatus: latestSetup,
                            authorized: false,
                            isAuthPending: false,
                        }));
                        setStatus('connect_needed');
                        return;
                    }
                }

                if (isCancelled) return;

                const finalSetup = computeSetupStatus();
                setSetupStatus(finalSetup);
                setAuthorized(true);
                setNeedsOnboarding(shouldShowOnboarding({
                    setupStatus: finalSetup,
                    authorized: true,
                    isAuthPending: false,
                }));
                setStatus('Ready');

                attachDJInstance(token);
            } catch (initError: unknown) {
                if (isCancelled) return;
                console.error("Fatal initialization error:", initError);
                const msg = initError instanceof Error ? initError.message : String(initError);
                setStatus(`Init Error: ${msg}`);
                setError(msg);
            }
        };

        init();

        return () => {
            isCancelled = true;
            stopBackgroundKeepAlive();
            convergenceController.cancel();
            if (detachDJSubscriptionsRef.current) {
                detachDJSubscriptionsRef.current();
                detachDJSubscriptionsRef.current = null;
            }
        };
    }, [attachDJInstance, stopBackgroundKeepAlive]);

    const handleLoopError = useCallback((msg: string) => {
        setError(prev => (prev === msg ? prev : msg));
    }, []);

    // Manage decoupled UI polling & DJ background loops
    useDJPollingLoops({
        authorized,
        djCore,
        syncUIState,
        onError: handleLoopError,
        onAuthExpired: handleAuthExpired,
    });

    // Memoized Handlers
    const startBackgroundKeepAlive = useCallback(() => {
        if (getStorageItem(STORAGE_KEYS.BACKGROUND_KEEP_ALIVE) !== 'true') return;
        if (
            shouldSuppressBackgroundKeepAlive({
                isMobile: isMobileBrowserEnvironment(),
                devices: devicesRef.current,
                preferredDeviceId: typeof djRef.current?.getPreferredDeviceId === 'function'
                    ? djRef.current.getPreferredDeviceId()
                    : null,
            })
        ) {
            stopBackgroundKeepAlive();
            return;
        }

        if (!backgroundAudioRef.current) {
            const SILENT_MP3 = 'data:audio/mp3;base64,SUQzBAAAAAABEVRYWFgAAAAAtAAADgAAAB5WFb4AAABAAAAAAAAAAAAAA//uQZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMAAA//uQZAAAAAAA0gAAAAABBQAA0gAAAAEAABAAAAAAAABAAAAAAAAAAAAAAP/7kGQAAAAAADSAAAAAAAEAAADSAAAAAQAAEAAAAAAAQAAAAAAAAAAAAAA//uQZAAAAAAA0gAAAAAAAQAAANIAAAABAAAQAAAAAAAQAAAAAAAAAAAAAAD/+5BkAAAAAADSAAAAAAABAAAA0gAAAAEAABAAAAAAAEAAAAAAAAAAAAAAA//uQZAAAAAAA0gAAAAAAAQAAANIAAAABAAAQAAAAAAAQAAAAAAAAAAAAAAA==';
            const audio = new Audio(SILENT_MP3);
            audio.loop = true;
            audio.volume = 0.01;
            backgroundAudioRef.current = audio;
        }

        backgroundAudioRef.current.play().catch(e => {
            console.warn("Background audio auto-play blocked. User interaction required.", e);
        });
        console.log("🔊 Background Keep-Alive Audio Started");
    }, [stopBackgroundKeepAlive]);

    const handleNext = useCallback(async () => {
        startBackgroundKeepAlive();
        if (djRef.current) {
            const previousTrack = currentTrackRef.current;
            const previousUri = lastTrackUriRef.current;
            const currentQueue = queueRef.current;
            let expectedNextUri: string | null = null;
            let expectedNextKey: string | null = null;
            if (currentQueue.length > 0) {
                const nextTrack = currentQueue[0];
                const remaining = currentQueue.slice(1);
                expectedNextUri = nextTrack.uri || null;
                expectedNextKey = generateTrackKey(nextTrack);
                currentTrackRef.current = nextTrack;
                setCurrentTrack(nextTrack);
                persistPlayingTrack(nextTrack, false);
                lastTrackUriRef.current = expectedNextUri;
                updateQueueState(remaining);
            }
            const playTimeBefore = djRef.current.getLastPlayTime();
            const res = await djRef.current.next();
            if (res.ok) {
                if (djRef.current.getLastPlayTime() === playTimeBefore) {
                    void convergenceRef.current.syncUntilConverged(
                        expectedNextUri
                            ? {
                                expectedTrackUri: expectedNextUri,
                                expectedTrackKey: expectedNextKey,
                                departedTrackUri: previousUri,
                            }
                            : { departedTrackUri: previousUri },
                        syncUIState
                    );
                }
            } else if (currentQueue.length > 0) {
                // Revert optimistic track & queue shift if skip failed
                currentTrackRef.current = previousTrack;
                setCurrentTrack(previousTrack);
                persistPlayingTrack(previousTrack, false);
                lastTrackUriRef.current = previousUri;
                updateQueueState(currentQueue);
            }
        }
    }, [startBackgroundKeepAlive, syncUIState, updateQueueState, persistPlayingTrack]);

    const handlePrev = useCallback(async () => {
        startBackgroundKeepAlive();
        if (djRef.current) {
            const previousUri = lastTrackUriRef.current;
            const previousProgressMs = lastProgressMsRef.current;
            const playTimeBefore = djRef.current.getLastPlayTime();
            const res = await djRef.current.previous();
            if (res.ok && djRef.current.getLastPlayTime() === playTimeBefore) {
                void convergenceRef.current.syncUntilConverged(
                    {
                        departedTrackUri: previousUri,
                        departedProgressMs: previousProgressMs,
                        allowSameTrackRewind: true,
                    },
                    syncUIState
                );
            }
        }
    }, [startBackgroundKeepAlive, syncUIState]);

    const handleTogglePlay = useCallback(async () => {
        startBackgroundKeepAlive();
        if (djRef.current) {
            const targetIsPlaying = !isPlayingRef.current;
            const playTimeBefore = djRef.current.getLastPlayTime();
            updateIsPlaying(targetIsPlaying);
            const res = targetIsPlaying
                ? await djRef.current.resume()
                : await djRef.current.pause();
            if (res.ok) {
                // If resume() initiated playTracks(), setOnTracksPlayedCallback has already
                // registered a full expectedTrackUri + expectedIsPlaying convergence guard.
                if (djRef.current.getLastPlayTime() === playTimeBefore) {
                    void convergenceRef.current.syncUntilConverged(
                        { expectedIsPlaying: targetIsPlaying },
                        syncUIState
                    );
                }
            } else {
                // Revert optimistic toggle if request failed immediately
                updateIsPlaying(!targetIsPlaying);
            }
        }
    }, [startBackgroundKeepAlive, syncUIState, updateIsPlaying]);

    const handlePlayQueueIndex = useCallback(async (index: number) => {
        startBackgroundKeepAlive();
        if (!djRef.current) return;
        const currentQueue = queueRef.current;
        if (index < 0 || index >= currentQueue.length) return;
        try {
            await djRef.current.playFromQueueIndex(index, currentQueue);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setError(prev => (prev === msg ? prev : msg));
        }
    }, [startBackgroundKeepAlive]);

    const handleRemoveScheduleItem = useCallback((index: number) => {
        if (djRef.current) {
            const prevQuery = djRef.current.getDJStatus().currentQuery;
            const prevStatus = djRef.current.getStateSnapshot().status;
            const newSchedule = djRef.current.removeScheduleItem(index, true);
            setScheduleState([...newSchedule]);
            if (newSchedule.length === 0) {
                setCurrentQuery(null);
                setCurrentThought(null);
            } else {
                const nextDjStatus = djRef.current.getDJStatus();
                setCurrentQuery(nextDjStatus.currentQuery);
                setCurrentThought(nextDjStatus.currentThought);
                if (prevQuery !== null || prevStatus.startsWith('⏰')) {
                    void djRef.current.processDJLoop(true, false).catch((err) => {
                        console.warn('Schedule transition after item removal failed:', err);
                    });
                }
            }
        } else {
            setScheduleState(prev => {
                if (index < 0 || index >= prev.length) return prev;
                const next = prev.filter((_, i) => i !== index);
                setStoredJSON(STORAGE_KEYS.DJ_SCHEDULE, next);
                if (next.length === 0) {
                    setCurrentQuery(null);
                    setCurrentThought(null);
                    removeStorageItem(STORAGE_KEYS.DJ_LAST_QUERY);
                } else {
                    let savedQ = getStorageItem(STORAGE_KEYS.DJ_LAST_QUERY, '') || null;
                    if (isWaitingForScheduleStart(next)) {
                        if (savedQ && next.some(item => getScheduleItemSignature(item) === savedQ)) {
                            savedQ = null;
                            setCurrentQuery(null);
                            removeStorageItem(STORAGE_KEYS.DJ_LAST_QUERY);
                        }
                    }
                    setCurrentThought(resolveScheduleThought(next, savedQ));
                }
                return next;
            });
        }
    }, []);

    const refreshDevices = useCallback(async () => {
        if (djRef.current) {
            const d = await djRef.current.getDevices();
            updateDevicesState(d);
        }
    }, [updateDevicesState]);

    const setDevice = useCallback(async (deviceId: string) => {
        if (djRef.current) {
            const prevDeviceName = deviceNameRef.current;
            const targetDevice = devicesRef.current.find(d => d.id === deviceId);
            if (targetDevice?.name) {
                updateDeviceName(targetDevice.name);
            }
            if (
                backgroundAudioRef.current &&
                shouldSuppressBackgroundKeepAlive({
                    isMobile: isMobileBrowserEnvironment(),
                    devices: devicesRef.current,
                    preferredDeviceId: deviceId,
                    activeDeviceType: targetDevice?.type ?? null,
                })
            ) {
                stopBackgroundKeepAlive();
            }
            const shouldStartSessionOnNewDevice =
                (typeof djRef.current.hasPendingStartRetry === 'function' && djRef.current.hasPendingStartRetry()) ||
                (
                    typeof djRef.current.hasConfirmedPlayback === 'function' &&
                    !djRef.current.hasConfirmedPlayback() &&
                    typeof djRef.current.isSessionPlaybackActive === 'function' &&
                    djRef.current.isSessionPlaybackActive()
                );
            const res = await djRef.current.setActiveDevice(deviceId);
            if (res.ok) {
                if (shouldStartSessionOnNewDevice) {
                    void djRef.current.processDJLoop(true, false).catch((err) => {
                        console.warn('Immediate playback retry after device switch failed:', err);
                    });
                }
                void convergenceRef.current.syncUntilConverged(
                    { expectedDeviceId: deviceId },
                    syncUIState
                );
            } else {
                updateDeviceName(prevDeviceName);
            }
        }
    }, [stopBackgroundKeepAlive, syncUIState, updateDeviceName]);

    const clearError = useCallback(() => setError(null), []);

    // Granular Context Values to isolate re-renders
    const logsContextValue = useMemo<PlayerLogsContextType>(() => ({
        logs: djLogs,
    }), [djLogs]);

    const exposedSchedule = isHydrated ? schedule : EMPTY_SCHEDULE;
    const exposedTrack = isHydrated ? currentTrack : null;
    const exposedQuery = isHydrated ? currentQuery : null;
    const exposedThought = isHydrated ? currentThought : null;

    const queueScheduleContextValue = useMemo<PlayerQueueScheduleContextType>(() => ({
        queue,
        schedule: exposedSchedule,
        setSchedule,
        handleRemoveScheduleItem,
    }), [queue, exposedSchedule, setSchedule, handleRemoveScheduleItem]);

    const playbackContextValue = useMemo<PlayerPlaybackContextType>(() => ({
        status,
        currentTrack: exposedTrack,
        isPlaying,
        deviceName,
        devices,
        currentQuery: exposedQuery,
        currentThought: exposedThought,
        error,
    }), [
        status,
        exposedTrack,
        isPlaying,
        deviceName,
        devices,
        exposedQuery,
        exposedThought,
        error,
    ]);

    const actionsContextValue = useMemo<PlayerActionsContextType>(() => ({
        djCore,
        authorized,
        needsOnboarding,
        setupStatus,
        setStatus,
        setSchedule,
        refreshDevices,
        setDevice,
        handleNext,
        handlePrev,
        handleTogglePlay,
        handlePlayQueueIndex,
        handleRemoveScheduleItem,
        clearError,
        startBackgroundKeepAlive,
        syncUIState,
        reloadConfig,
    }), [
        djCore,
        authorized,
        needsOnboarding,
        setupStatus,
        setSchedule,
        refreshDevices,
        setDevice,
        handleNext,
        handlePrev,
        handleTogglePlay,
        handlePlayQueueIndex,
        handleRemoveScheduleItem,
        clearError,
        startBackgroundKeepAlive,
        syncUIState,
        reloadConfig,
    ]);

    return (
        <PlayerActionsContext.Provider value={actionsContextValue}>
            <PlayerPlaybackContext.Provider value={playbackContextValue}>
                <PlayerQueueScheduleContext.Provider value={queueScheduleContextValue}>
                    <PlayerLogsContext.Provider value={logsContextValue}>
                        {children}
                    </PlayerLogsContext.Provider>
                </PlayerQueueScheduleContext.Provider>
            </PlayerPlaybackContext.Provider>
        </PlayerActionsContext.Provider>
    );
}

export function usePlayerLogs(): PlayerLogsContextType {
    const context = useContext(PlayerLogsContext);
    if (context === undefined) {
        throw new Error('usePlayerLogs must be used within a PlayerProvider');
    }
    return context;
}

export function usePlayerQueueSchedule(): PlayerQueueScheduleContextType {
    const context = useContext(PlayerQueueScheduleContext);
    if (context === undefined) {
        throw new Error('usePlayerQueueSchedule must be used within a PlayerProvider');
    }
    return context;
}

export function usePlayerPlayback(): PlayerPlaybackContextType {
    const context = useContext(PlayerPlaybackContext);
    if (context === undefined) {
        throw new Error('usePlayerPlayback must be used within a PlayerProvider');
    }
    return context;
}

export function usePlayerActions(): PlayerActionsContextType {
    const context = useContext(PlayerActionsContext);
    if (context === undefined) {
        throw new Error('usePlayerActions must be used within a PlayerProvider');
    }
    return context;
}

/**
 * Combined hook preserved for backward compatibility.
 * Prefer `usePlayerPlayback`, `usePlayerQueueSchedule`, `usePlayerActions`, or `usePlayerLogs`
 * in performance-sensitive components to avoid unnecessary re-renders.
 */
export function usePlayer(): PlayerContextType {
    const actions = usePlayerActions();
    const playback = usePlayerPlayback();
    const queueSchedule = usePlayerQueueSchedule();
    const logs = usePlayerLogs();

    return useMemo<PlayerContextType>(() => ({
        ...actions,
        ...playback,
        ...queueSchedule,
        ...logs,
    }), [actions, playback, queueSchedule, logs]);
}
