'use client';

import React, { createContext, useContext, useEffect, useState, useRef, useCallback, useMemo, ReactNode } from 'react';
import { DJCore } from '../lib/dj-core';
import { SpotifyAuth } from '../lib/spotify-auth';
import { STORAGE_KEYS, PLAYBACK_CONSTANTS, DEFAULT_MODELS, DEFAULTS } from '../lib/constants';
import { AIProvider, ScheduleItem, Track } from '../lib/types';
import { getStorageItem, getStoredJSON, setStoredJSON } from '../lib/storage';
import { useDJPollingLoops } from '../hooks/useDJPollingLoops';

interface SetupStatus {
    hasClientId: boolean;
    hasAiKey: boolean;
}

interface PlayerContextType {
    djCore: DJCore | null;
    authorized: boolean;
    status: string;
    setStatus: (s: string) => void;
    currentTrack: Track | null;
    isPlaying: boolean;
    deviceName: string;
    schedule: ScheduleItem[];
    setSchedule: (s: ScheduleItem[]) => void;
    currentQuery: string | null;
    currentThought: string | null;
    queue: Track[];
    devices: SpotifyApi.UserDevice[];
    refreshDevices: () => Promise<void>;
    setDevice: (deviceId: string) => Promise<void>;
    handleNext: () => Promise<void>;
    handlePrev: () => Promise<void>;
    handleTogglePlay: () => Promise<void>;
    handleRemoveScheduleItem: (index: number) => void;
    needsOnboarding: boolean;
    setupStatus: SetupStatus;
    logs: string[];
    error: string | null;
    clearError: () => void;
    startBackgroundKeepAlive: () => void;
    syncUIState: (options?: { forceAll?: boolean }) => Promise<SpotifyApi.CurrentPlaybackResponse | null>;
    reloadConfig: () => void;
}

const PlayerContext = createContext<PlayerContextType | undefined>(undefined);

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

function isSameTrackDisplay(a: Track | null, b: Track | null): boolean {
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
    const [schedule, setSchedule] = useState<ScheduleItem[]>([]);
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
    const backgroundAudioRef = useRef<HTMLAudioElement | null>(null);
    const lastTrackUriRef = useRef<string | null>(null);
    const lastDevicesFetchRef = useRef<number>(0);
    const lastQueueSyncPlayTimeRef = useRef<number>(0);
    const queueLengthRef = useRef<number>(0);
    const devicesRef = useRef<SpotifyApi.UserDevice[]>([]);

    const updateQueueState = useCallback((nextQueue: Track[]) => {
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
        setDevices(nextDevices);
    }, []);

    const syncUIState = useCallback(async (options?: { forceAll?: boolean }) => {
        if (!djRef.current) return null;
        const forceAll = options?.forceAll ?? false;

        try {
            // 1. Fetch playback state first to determine the exact currently playing track & progress
            const playbackState = await djRef.current.getPlaybackState();
            const currentTrackItem = (playbackState && playbackState.item && playbackState.item.type === 'track')
                ? (playbackState.item as Track)
                : null;

            const currentTrackUri = currentTrackItem?.uri || null;
            const trackChanged = currentTrackUri !== lastTrackUriRef.current;
            if (trackChanged) {
                lastTrackUriRef.current = currentTrackUri;
            }

            // 2. Conditionally fetch Queue
            const lastPlayTime = typeof djRef.current.getLastPlayTime === 'function' ? djRef.current.getLastPlayTime() : 0;
            const newPlayOccurred = lastPlayTime > lastQueueSyncPlayTimeRef.current;
            const shouldFetchQueue = forceAll || trackChanged || queueLengthRef.current === 0 || newPlayOccurred;
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
                updateQueueState(currentQ.slice(0, 20));
                lastQueueSyncPlayTimeRef.current = lastPlayTime;
            }
            let latestDevices = devicesRef.current;
            if (devicesPromise) {
                const currentDevices = await devicesPromise;
                latestDevices = currentDevices;
                updateDevicesState(currentDevices);
            }

            // Determine Device Name
            let activeDeviceName = '';
            if (playbackState && playbackState.device) {
                activeDeviceName = playbackState.device.name;
            } else if (latestDevices.length > 0) {
                const activeD = latestDevices.find(d => d.is_active);
                if (activeD) activeDeviceName = activeD.name;
            }
            if (activeDeviceName) {
                setDeviceName(activeDeviceName);
            }

            // Sync Track Info (avoid new object reference & localStorage write if unchanged)
            if (currentTrackItem) {
                const finalTrack = djRef.current.enrichTrackWithCachedMetadata(currentTrackItem);
                setCurrentTrack(prev => {
                    if (isSameTrackDisplay(prev, finalTrack)) {
                        return prev;
                    }
                    setStoredJSON(STORAGE_KEYS.DJ_CURRENT_PLAYING_TRACK, finalTrack);
                    return finalTrack;
                });
                setIsPlaying(playbackState!.is_playing);
            } else {
                setIsPlaying(false);
            }

            // Update Status
            const djStatus = djRef.current.getDJStatus();
            setCurrentQuery(djStatus.currentQuery);
            setCurrentThought(djStatus.currentThought);

            // Sync Logs (only update state when log entries actually change)
            if (typeof djRef.current.getProcessLog === 'function') {
                const latestLogs = djRef.current.getProcessLog();
                setDjLogs(prev =>
                    prev.length === latestLogs.length && prev[0] === latestLogs[0]
                        ? prev
                        : [...latestLogs]
                );
            }

            return playbackState;
        } catch (syncErr) {
            console.error("Error in syncUIState:", syncErr);
            return null;
        }
    }, [updateQueueState, updateDevicesState]);

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
                    dj.setOnTracksPlayedCallback((tracks) => {
                        if (tracks.length > 0) {
                            const first = tracks[0];
                            setCurrentTrack(first);
                            setStoredJSON(STORAGE_KEYS.DJ_CURRENT_PLAYING_TRACK, first);
                            updateQueueState(tracks.slice(1, 21));
                            setIsPlaying(true);
                            lastTrackUriRef.current = tracks[0].uri;
                            lastQueueSyncPlayTimeRef.current = dj.getLastPlayTime();
                            setTimeout(() => syncUIState({ forceAll: true }), 1500);
                        }
                    });

                    const savedSessionTracks = getStoredJSON<Track[]>(STORAGE_KEYS.DJ_CURRENT_SESSION_TRACKS, []);
                    if (savedSessionTracks.length > 0) {
                        updateQueueState(savedSessionTracks.slice(1, 21));
                    }

                    const savedSchedule = getStoredJSON<ScheduleItem[]>(STORAGE_KEYS.DJ_SCHEDULE, []);
                    if (savedSchedule.length > 0) {
                        setSchedule(savedSchedule);
                        dj.setSchedule(savedSchedule);
                        const djStatus = dj.getDJStatus();
                        if (djStatus.currentThought) {
                            setCurrentThought(djStatus.currentThought);
                        }
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
        };
    }, [syncUIState, updateQueueState]);

    const handleLoopError = useCallback((msg: string) => {
        setError(prev => (prev === msg ? prev : msg));
    }, []);

    // Manage decoupled UI polling & DJ background loops
    useDJPollingLoops({
        authorized,
        djCore,
        syncUIState,
        onError: handleLoopError,
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
            setQueue(prevQueue => {
                if (prevQueue.length > 0) {
                    const nextTrack = prevQueue[0];
                    setCurrentTrack(nextTrack);
                    setStoredJSON(STORAGE_KEYS.DJ_CURRENT_PLAYING_TRACK, nextTrack);
                    const remaining = prevQueue.slice(1);
                    queueLengthRef.current = remaining.length;
                    return remaining;
                }
                return prevQueue;
            });
            await djRef.current.next();
            setTimeout(() => syncUIState({ forceAll: true }), 500);
            setTimeout(() => syncUIState({ forceAll: true }), 1500);
        }
    }, [startBackgroundKeepAlive, syncUIState]);

    const handlePrev = useCallback(async () => {
        startBackgroundKeepAlive();
        if (djRef.current) {
            await djRef.current.previous();
            setTimeout(() => syncUIState({ forceAll: true }), 500);
            setTimeout(() => syncUIState({ forceAll: true }), 1500);
        }
    }, [startBackgroundKeepAlive, syncUIState]);

    const handleTogglePlay = useCallback(async () => {
        startBackgroundKeepAlive();
        if (djRef.current) {
            if (isPlaying) await djRef.current.pause();
            else await djRef.current.resume();
            setIsPlaying(prev => !prev);
            setTimeout(() => syncUIState(), 500);
        }
    }, [isPlaying, startBackgroundKeepAlive, syncUIState]);

    const handleRemoveScheduleItem = useCallback((index: number) => {
        if (djRef.current) {
            const newSchedule = djRef.current.removeScheduleItem(index);
            setSchedule([...newSchedule]);
            setStoredJSON(STORAGE_KEYS.DJ_SCHEDULE, newSchedule);
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
            await djRef.current.setActiveDevice(deviceId);
            setTimeout(() => syncUIState({ forceAll: true }), 500);
        }
    }, [syncUIState]);

    const clearError = useCallback(() => setError(null), []);

    const contextValue = useMemo<PlayerContextType>(() => ({
        djCore,
        authorized,
        status,
        setStatus,
        currentTrack,
        isPlaying,
        deviceName,
        schedule,
        setSchedule,
        currentQuery,
        currentThought,
        queue,
        devices,
        refreshDevices,
        setDevice,
        handleNext,
        handlePrev,
        handleTogglePlay,
        handleRemoveScheduleItem,
        needsOnboarding,
        setupStatus,
        logs: djLogs,
        error,
        clearError,
        startBackgroundKeepAlive,
        syncUIState,
        reloadConfig
    }), [
        djCore,
        authorized,
        status,
        currentTrack,
        isPlaying,
        deviceName,
        schedule,
        currentQuery,
        currentThought,
        queue,
        devices,
        refreshDevices,
        setDevice,
        handleNext,
        handlePrev,
        handleTogglePlay,
        handleRemoveScheduleItem,
        needsOnboarding,
        setupStatus,
        djLogs,
        error,
        clearError,
        startBackgroundKeepAlive,
        syncUIState,
        reloadConfig
    ]);

    return (
        <PlayerContext.Provider value={contextValue}>
            {children}
        </PlayerContext.Provider>
    );
}

export function usePlayer() {
    const context = useContext(PlayerContext);
    if (context === undefined) {
        throw new Error('usePlayer must be used within a PlayerProvider');
    }
    return context;
}
