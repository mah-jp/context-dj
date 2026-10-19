'use client';

import React, { createContext, useContext, useEffect, useState, useRef, useCallback, useMemo, ReactNode } from 'react';
import { DJCore } from '../lib/dj-core';
import { SpotifyAuth } from '../lib/spotify-auth';
import { STORAGE_KEYS, PLAYBACK_CONSTANTS, DEFAULT_MODELS, DEFAULTS } from '../lib/constants';
import { AIProvider, ScheduleItem, SpotifyApiErrorInfo, Track } from '../lib/types';
import { getStorageItem, getStoredJSON } from '../lib/storage';
import { useDJPollingLoops } from '../hooks/useDJPollingLoops';
import { PlaybackConvergenceController } from '../lib/playback-sync';
import { generateTrackKey } from '../lib/dj-utils';

export interface SetupStatus {
    hasClientId: boolean;
    hasAiKey: boolean;
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

function computeSetupStatus(): SetupStatus {
    const clientId = getStorageItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID);
    const provider = (getStorageItem(STORAGE_KEYS.SELECTED_AI_PROVIDER) as AIProvider) || DEFAULTS.AI_PROVIDER;
    const hasAiKey = provider === 'gemini'
        ? !!getStorageItem(STORAGE_KEYS.GEMINI_API_KEY)
        : !!getStorageItem(STORAGE_KEYS.OPENAI_API_KEY);
    return { hasClientId: !!clientId, hasAiKey };
}

function applyStoredConfigToDJ(dj: DJCore) {
    const openaiKey = getStorageItem(STORAGE_KEYS.OPENAI_API_KEY, '');
    const openaiModel = getStorageItem(STORAGE_KEYS.OPENAI_MODEL, DEFAULT_MODELS.OPENAI);
    const geminiKey = getStorageItem(STORAGE_KEYS.GEMINI_API_KEY, '');
    const geminiModel = getStorageItem(STORAGE_KEYS.GEMINI_MODEL, DEFAULT_MODELS.GEMINI);
    const selectedProvider = (getStorageItem(STORAGE_KEYS.SELECTED_AI_PROVIDER, '') as AIProvider) || DEFAULTS.AI_PROVIDER;

    if (selectedProvider === 'gemini' && geminiKey) {
        dj.initAI('gemini', geminiKey, geminiModel);
    } else if (selectedProvider === 'openai' && openaiKey) {
        dj.initAI('openai', openaiKey, openaiModel);
    } else if (openaiKey) {
        dj.initAI('openai', openaiKey, openaiModel);
    } else if (geminiKey) {
        dj.initAI('gemini', geminiKey, geminiModel);
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
    const [schedule, setScheduleState] = useState<ScheduleItem[]>([]);
    const [currentQuery, setCurrentQuery] = useState<string | null>(null);
    const [currentThought, setCurrentThought] = useState<string | null>(() => {
        if (typeof window !== 'undefined') {
            const savedSchedule = getStoredJSON<ScheduleItem[]>(STORAGE_KEYS.DJ_SCHEDULE, []);
            if (savedSchedule.length > 0) {
                return savedSchedule[0]?.thought || null;
            }
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

    const persistPlayingTrack = useCallback((track: Track | null) => {
        if (djRef.current) {
            djRef.current.getSessionCache().setLastPlayingTrack(track);
        }
    }, []);

    const setSchedule = useCallback((nextSchedule: ScheduleItem[]) => {
        setScheduleState(nextSchedule);
        if (djRef.current && djRef.current.getSchedule() !== nextSchedule) {
            djRef.current.setSchedule(nextSchedule, false);
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

    const handleAuthExpired = useCallback(() => {
        if (isRefreshingTokenRef.current) return;
        const clientId = getStorageItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID);
        if (!clientId) {
            SpotifyAuth.logout();
            setAuthorized(false);
            setStatus('connect_needed');
            return;
        }
        isRefreshingTokenRef.current = true;
        void SpotifyAuth.refreshToken(clientId)
            .then((refreshed) => {
                if (refreshed) {
                    djRef.current?.updateAccessToken(refreshed);
                } else {
                    SpotifyAuth.logout();
                    setAuthorized(false);
                    setStatus('connect_needed');
                }
            })
            .finally(() => {
                isRefreshingTokenRef.current = false;
            });
    }, []);

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

            const currentTrackItem = (playbackState && playbackState.item && playbackState.item.type === 'track')
                ? (playbackState.item as Track)
                : null;

            const currentTrackUri = currentTrackItem?.uri || null;
            const trackChanged = !guard.suppressTrackUpdate && currentTrackUri !== lastTrackUriRef.current;
            if (trackChanged) {
                lastTrackUriRef.current = currentTrackUri;
            }

            const isSessionActive = typeof djRef.current.isSessionPlaybackActive === 'function'
                ? djRef.current.isSessionPlaybackActive()
                : false;
            const sessionModeChanged = lastSessionActiveRef.current !== null && isSessionActive !== lastSessionActiveRef.current;
            lastSessionActiveRef.current = isSessionActive;

            // 2. Conditionally fetch Queue (skip overwriting optimistic queue if track is still in stale transition)
            const lastPlayTime = typeof djRef.current.getLastPlayTime === 'function' ? djRef.current.getLastPlayTime() : 0;
            const newPlayOccurred = lastPlayTime > lastQueueSyncPlayTimeRef.current;
            const shouldFetchQueue = !guard.suppressTrackUpdate && (
                forceAll || trackChanged || sessionModeChanged || !hasInitialQueueSyncRef.current || newPlayOccurred
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
            }
            let latestDevices = devicesRef.current;
            if (devicesPromise) {
                const currentDevices = await devicesPromise;
                latestDevices = currentDevices;
                updateDevicesState(currentDevices);
            }

            // Determine Device Name (suppress stale device revert while device transfer is converging,
            // and never overwrite a real device name with synthetic startup fallback 'Connecting...')
            if (!guard.suppressDeviceUpdate) {
                let activeDeviceName = '';
                if (playbackState && playbackState.device && !playbackState.__optimisticFallback) {
                    activeDeviceName = playbackState.device.name;
                } else if (latestDevices.length > 0) {
                    const activeD = latestDevices.find(d => d.is_active);
                    if (activeD) activeDeviceName = activeD.name;
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
                    setCurrentTrack(prev => {
                        if (isSameTrackDisplay(prev, finalTrack)) {
                            return prev;
                        }
                        persistPlayingTrack(finalTrack);
                        return finalTrack;
                    });
                }
                if (!guard.suppressPlayStateUpdate) {
                    updateIsPlaying(playbackState!.is_playing);
                }
            } else if (!guard.suppressTrackUpdate) {
                const isNonTrackMedia = Boolean(
                    playbackState &&
                    ((playbackState.item && playbackState.item.type !== 'track') ||
                        (playbackState.currently_playing_type &&
                            playbackState.currently_playing_type !== 'track' &&
                            playbackState.currently_playing_type !== 'unknown'))
                );
                if (isNonTrackMedia) {
                    currentTrackRef.current = null;
                    setCurrentTrack(null);
                    persistPlayingTrack(null);
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
    }, [updateQueueState, updateDevicesState, updateDeviceName, updateIsPlaying, persistPlayingTrack]);

    const reloadConfig = useCallback(() => {
        const storedClientId = getStorageItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID);
        setNeedsOnboarding(!storedClientId);
        setSetupStatus(computeSetupStatus());

        if (!storedClientId) {
            setAuthorized(false);
            setStatus('Please configure settings first.');
            return;
        }

        const isAuth = SpotifyAuth.isAuthenticated();
        if (!isAuth) {
            setAuthorized(false);
            setStatus('connect_needed');
            return;
        }

        if (djRef.current) {
            applyStoredConfigToDJ(djRef.current);
        }
    }, []);

    // Initialize Auth & DJCore
    useEffect(() => {
        let isCancelled = false;
        let unsubscribeLogs: (() => void) | null = null;
        let unsubscribeState: (() => void) | null = null;
        const convergenceController = convergenceRef.current;

        const init = async () => {
            try {
                setNeedsOnboarding(!getStorageItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID));
                setSetupStatus(computeSetupStatus());

                const params = new URLSearchParams(window.location.search);
                const code = params.get('code');
                const returnedState = params.get('state');
                const storedClientId = getStorageItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID);

                if (!storedClientId) {
                    setStatus('Please configure settings first.');
                    return;
                }

                let token: string | null = SpotifyAuth.getAccessToken();

                if (code) {
                    setStatus('Authenticating...');
                    token = await SpotifyAuth.handleCallback(storedClientId, code, returnedState);
                    window.history.replaceState({}, document.title, window.location.pathname);
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
                        setAuthorized(false);
                        setStatus('connect_needed');
                        return;
                    }
                }

                if (isCancelled) return;

                setAuthorized(true);
                setStatus('Ready');

                if (!djRef.current) {
                    const dj = new DJCore(token);
                    applyStoredConfigToDJ(dj);

                    djRef.current = dj;
                    setDjCore(dj);
                    dj.setStatusCallback(setStatus);
                    dj.setErrorCallback((errMsg: string, errInfo?: SpotifyApiErrorInfo) => {
                        setError(prev => (prev === errMsg ? prev : errMsg));
                        if (errInfo?.category === 'auth_expired') {
                            handleAuthExpired();
                        }
                    });
                    unsubscribeState = dj.subscribe((snapshot) => {
                        setStatus(snapshot.status);
                        setCurrentQuery(snapshot.currentQuery);
                        setCurrentThought(snapshot.currentThought);
                        setScheduleState(prev => (prev === snapshot.schedule ? prev : snapshot.schedule));
                    });
                    unsubscribeLogs = dj.subscribeLogs((latestLogs) => {
                        setDjLogs(prev =>
                            prev.length === latestLogs.length && prev[0] === latestLogs[0]
                                ? prev
                                : latestLogs
                        );
                    });

                    dj.setOnTracksPlayedCallback((tracks) => {
                        if (tracks.length > 0) {
                            const first = tracks[0];
                            currentTrackRef.current = first;
                            setCurrentTrack(first);
                            persistPlayingTrack(first);
                            updateQueueState(tracks.slice(1, 21));
                            updateIsPlaying(true);
                            lastTrackUriRef.current = first.uri;
                            lastQueueSyncPlayTimeRef.current = dj.getLastPlayTime();
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
                        updateQueueState(savedSessionTracks.slice(1, 21));
                    }
                }
            } catch (initError: unknown) {
                if (isCancelled) return;
                console.error("Fatal initialization error:", initError);
                const msg = initError instanceof Error ? initError.message : String(initError);
                setStatus(`Init Error: ${msg}`);
            }
        };

        init();

        return () => {
            isCancelled = true;
            convergenceController.cancel();
            if (unsubscribeState) {
                unsubscribeState();
            }
            if (unsubscribeLogs) {
                unsubscribeLogs();
            }
        };
    }, [syncUIState, updateQueueState, updateIsPlaying, persistPlayingTrack, handleAuthExpired]);

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
    }, []);

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
                persistPlayingTrack(nextTrack);
                lastTrackUriRef.current = expectedNextUri;
                updateQueueState(remaining);
            }
            const res = await djRef.current.next();
            if (res.ok) {
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
            } else if (currentQueue.length > 0) {
                // Revert optimistic track & queue shift if skip failed
                currentTrackRef.current = previousTrack;
                setCurrentTrack(previousTrack);
                persistPlayingTrack(previousTrack);
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
            const res = await djRef.current.previous();
            if (res.ok) {
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
            updateIsPlaying(targetIsPlaying);
            const res = targetIsPlaying
                ? await djRef.current.resume()
                : await djRef.current.pause();
            if (res.ok) {
                void convergenceRef.current.syncUntilConverged(
                    { expectedIsPlaying: targetIsPlaying },
                    syncUIState
                );
            } else {
                // Revert optimistic toggle if request failed immediately
                updateIsPlaying(!targetIsPlaying);
            }
        }
    }, [startBackgroundKeepAlive, syncUIState, updateIsPlaying]);

    const handleRemoveScheduleItem = useCallback((index: number) => {
        if (djRef.current) {
            const newSchedule = djRef.current.removeScheduleItem(index, true);
            setScheduleState([...newSchedule]);
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
            const res = await djRef.current.setActiveDevice(deviceId);
            if (res.ok) {
                void convergenceRef.current.syncUntilConverged(
                    { expectedDeviceId: deviceId },
                    syncUIState
                );
            } else {
                updateDeviceName(prevDeviceName);
            }
        }
    }, [syncUIState, updateDeviceName]);

    const clearError = useCallback(() => setError(null), []);

    // Granular Context Values to isolate re-renders
    const logsContextValue = useMemo<PlayerLogsContextType>(() => ({
        logs: djLogs,
    }), [djLogs]);

    const queueScheduleContextValue = useMemo<PlayerQueueScheduleContextType>(() => ({
        queue,
        schedule,
        setSchedule,
        handleRemoveScheduleItem,
    }), [queue, schedule, setSchedule, handleRemoveScheduleItem]);

    const playbackContextValue = useMemo<PlayerPlaybackContextType>(() => ({
        status,
        currentTrack,
        isPlaying,
        deviceName,
        devices,
        currentQuery,
        currentThought,
        error,
    }), [
        status,
        currentTrack,
        isPlaying,
        deviceName,
        devices,
        currentQuery,
        currentThought,
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
