'use client';

import React, { createContext, useContext, useEffect, useState, useRef, ReactNode } from 'react';
import { DJCore } from '../lib/dj-core';
import { SpotifyAuth } from '../lib/spotify-auth';
import { STORAGE_KEYS, PLAYBACK_CONSTANTS, DEFAULT_MODELS, DEFAULTS } from '../lib/constants';
import { AIProvider, ScheduleItem, Track } from '../lib/types';
import { getStorageItem, setStorageItem, getStoredJSON, setStoredJSON } from '../lib/storage';

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
    logs: string[];
    error: string | null;
    clearError: () => void;
    startBackgroundKeepAlive: () => void;
    syncUIState: () => Promise<SpotifyApi.CurrentPlaybackResponse | null>;
}

const PlayerContext = createContext<PlayerContextType | undefined>(undefined);

export function PlayerProvider({ children }: { children: ReactNode }) {
    const [authorized, setAuthorized] = useState(false);
    const [djCore, setDjCore] = useState<DJCore | null>(null);
    const [status, setStatus] = useState('Initializing...');

    const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [deviceName, setDeviceName] = useState('');
    const [schedule, setSchedule] = useState<ScheduleItem[]>([]);
    const [currentQuery, setCurrentQuery] = useState<string | null>(null);
    const [currentThought, setCurrentThought] = useState<string | null>(null);
    const [needsOnboarding, setNeedsOnboarding] = useState(false);
    const [queue, setQueue] = useState<Track[]>([]);
    const [devices, setDevices] = useState<SpotifyApi.UserDevice[]>([]);
    const [djLogs, setDjLogs] = useState<string[]>([]); // Added logs state
    const [error, setError] = useState<string | null>(null);

    const djRef = useRef<DJCore | null>(null);
    const authorizedRef = useRef(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const djTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const backgroundAudioRef = useRef<HTMLAudioElement | null>(null);

    // Helper to sync UI with DJ Core state
    const syncUIState = React.useCallback(async () => {
        if (!djRef.current) return null;

        try {
            // 1. Fetch playback state first to determine the exact currently playing track
            const playbackState = await djRef.current.getPlaybackState();
            const currentTrackItem = (playbackState && playbackState.item && playbackState.item.type === 'track')
                ? (playbackState.item as Track)
                : null;

            // 2. Fetch Queue (passing current track to advance Up Next dynamically) and Devices concurrently
            const [currentQ, currentDevices] = await Promise.all([
                djRef.current.getQueue(currentTrackItem),
                djRef.current.getDevices()
            ]);

            // Sync Devices & Queue
            setDevices(currentDevices);
            setQueue(currentQ.slice(0, 20));

            // Determine Device Name
            // Priority: 1. Playback State Device, 2. Active Device in List, 3. Empty
            let activeDeviceName = '';
            if (playbackState && playbackState.device) {
                activeDeviceName = playbackState.device.name;
            } else {
                const activeD = currentDevices.find(d => d.is_active);
                if (activeD) activeDeviceName = activeD.name;
            }
            setDeviceName(activeDeviceName);

            // Sync Track Info
            if (currentTrackItem) {
                setCurrentTrack(currentTrackItem);
                setIsPlaying(playbackState!.is_playing);
            } else {
                setCurrentTrack(null);
                setIsPlaying(false);
            }

            // Update Status
            const djStatus = djRef.current.getDJStatus();
            setCurrentQuery(djStatus.currentQuery);
            setCurrentThought(djStatus.currentThought);

            // Sync Logs
            if (typeof djRef.current.getProcessLog === 'function') {
                setDjLogs([...djRef.current.getProcessLog()]);
            }

            return playbackState;
        } catch (syncErr) {
            console.error("Error in syncUIState:", syncErr);
            return null;
        }
    }, []);

    // Initialize
    useEffect(() => {
        let cleanupListeners: (() => void) | null = null;
        let isCancelled = false;

        const init = async () => {
            try {
                // 0. Check Onboarding
                setNeedsOnboarding(!getStorageItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID));

                // 1. Check for Callback Code
                const params = new URLSearchParams(window.location.search);
                const code = params.get('code');
                const storedClientId = getStorageItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID);

                if (!storedClientId) {
                    setStatus('Please configure settings first.');
                    return;
                }

                let token: string | null = SpotifyAuth.getAccessToken();

                if (code) {
                    setStatus('Authenticating...');
                    token = await SpotifyAuth.handleCallback(storedClientId, code);
                    // Clear code from URL after successful handling
                    window.history.replaceState({}, document.title, window.location.pathname);
                }

                if (isCancelled) return;

                if (!token || !SpotifyAuth.isAuthenticated()) {
                    // Try refreshing token
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

                // 2. Initialize DJ Core
                setAuthorized(true);
                authorizedRef.current = true;
                setStatus('Ready');

                // Prevent re-creating DJCore if it exists (though useEffect run once implies it shouldn't exist)
                if (!djRef.current) {
                    const dj = new DJCore(token);

                    // Load AI Config
                    const openaiKey = getStorageItem(STORAGE_KEYS.OPENAI_API_KEY, '');
                    const openaiModel = getStorageItem(STORAGE_KEYS.OPENAI_MODEL, DEFAULT_MODELS.OPENAI);
                    const geminiKey = getStorageItem(STORAGE_KEYS.GEMINI_API_KEY, '');
                    const geminiModel = getStorageItem(STORAGE_KEYS.GEMINI_MODEL, DEFAULT_MODELS.GEMINI);
                    const selectedProvider = (getStorageItem(STORAGE_KEYS.SELECTED_AI_PROVIDER, '') as AIProvider) || DEFAULTS.AI_PROVIDER;

                    if (selectedProvider === 'gemini' && geminiKey) {
                        dj.initAI('gemini', geminiKey, geminiModel);
                    } else if (selectedProvider === 'openai' && openaiKey) {
                        dj.initAI('openai', openaiKey, openaiModel);
                    } else {
                        // Fallback
                        if (openaiKey) dj.initAI('openai', openaiKey, openaiModel);
                        else if (geminiKey) dj.initAI('gemini', geminiKey, geminiModel);
                    }

                    djRef.current = dj;
                    setDjCore(dj);
                    dj.setStatusCallback(setStatus);
                    dj.setOnTracksPlayedCallback((tracks) => {
                        if (tracks.length > 0) {
                            setCurrentTrack(tracks[0]);
                            setQueue(tracks.slice(1, 21));
                            setIsPlaying(true);
                            // Schedule a synced refresh after Spotify digest time (1.5s)
                            setTimeout(syncUIState, 1500);
                        }
                    });

                    // Restore Schedule
                    const savedSchedule = getStoredJSON<ScheduleItem[]>(STORAGE_KEYS.DJ_SCHEDULE, []);
                    if (savedSchedule.length > 0) {
                        setSchedule(savedSchedule);
                        dj.setSchedule(savedSchedule);
                    }
                }

                // 3. Start Separate Loops (UI & DJ Logic)
                // This decoupling ensures UI/Device status updates don't freeze while AI is thinking.

                if (timerRef.current) clearTimeout(timerRef.current);
                if (djTimerRef.current) clearTimeout(djTimerRef.current);

                // --- UI Loop (High Priority, Non-Blocking) ---
                const runUILoop = async () => {
                    if (isCancelled) return;
                    let nextDelay: number = PLAYBACK_CONSTANTS.UI_POLL_INTERVAL_MS;

                    try {
                        if (djRef.current) {
                            // Sync UI
                            const playbackState = await syncUIState();

                            // Dynamic Interval: If track is ending soon (< 10s), increase polling rate to 1s
                            if (playbackState && playbackState.is_playing && playbackState.item && playbackState.item.duration_ms && playbackState.progress_ms) {
                                const remaining = playbackState.item.duration_ms - playbackState.progress_ms;
                                if (remaining < PLAYBACK_CONSTANTS.TRACK_REMAINING_THRESHOLD_MS) {
                                    nextDelay = PLAYBACK_CONSTANTS.UI_POLL_FAST_INTERVAL_MS;
                                }
                            }
                        }
                    } catch (error) {
                        console.error("Error in UI Loop:", error);
                    }

                    if (isCancelled) return;

                    // Auto-refresh token if expiring soon (Keep this in UI loop as it's lightweight logic)
                    if (authorizedRef.current && djRef.current) {
                        const expiresAtStr = getStorageItem(STORAGE_KEYS.SPOTIFY_EXPIRES_AT);
                        if (expiresAtStr) {
                            const expiresAt = parseInt(expiresAtStr);
                            if (Date.now() > expiresAt - PLAYBACK_CONSTANTS.TOKEN_REFRESH_BUFFER_MS) {
                                const clientId = getStorageItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID);
                                if (clientId) {
                                    SpotifyAuth.refreshToken(clientId).then(token => {
                                        if (token && djRef.current && !isCancelled) djRef.current.updateAccessToken(token);
                                    }).catch(e => console.error("Token Refresh Failed:", e));
                                }
                            }
                        }
                    }

                    if (!isCancelled) {
                        timerRef.current = setTimeout(runUILoop, nextDelay);
                    }
                };

                // --- DJ Logic Loop (AI, Heavy Process) ---
                const runDJLoop = async () => {
                    if (isCancelled) return;
                    let nextDelay = PLAYBACK_CONSTANTS.DJ_LOOP_INTERVAL_MS;

                    try {
                        if (djRef.current) {
                            // Sync Config
                            const savedFiltering = getStorageItem(STORAGE_KEYS.AI_FILTERING_ENABLED, '');
                            djRef.current.updateConfig({
                                aiFiltering: savedFiltering === '' ? DEFAULTS.AI_FILTERING_ENABLED : savedFiltering === 'true'
                            });

                            // Check Schedule (AI Logic) - This may block for seconds during AI request
                            await djRef.current.processDJLoop();
                        }
                    } catch (error: unknown) {
                        console.error("Error in DJ Loop:", error);
                        const msg = error instanceof Error ? error.message : "Unknown background error";
                        setError(prev => prev === msg ? prev : msg);
                    }

                    if (!isCancelled) {
                        djTimerRef.current = setTimeout(runDJLoop, nextDelay);
                    }
                };

                // Start both loops
                runUILoop();
                runDJLoop();

                // Visibility/Focus Restoration (Triggered when user returns to PWA/browser)
                const handleWakeUp = () => {
                    if (document.visibilityState === 'visible' && authorizedRef.current && djRef.current) {
                        console.log("📱 App regained focus / visibility: syncing UI & resuming loops");

                        // 1. Proactively refresh token if expired while in background
                        const expiresAtStr = getStorageItem(STORAGE_KEYS.SPOTIFY_EXPIRES_AT);
                        if (expiresAtStr) {
                            const expiresAt = parseInt(expiresAtStr);
                            if (Date.now() > expiresAt - PLAYBACK_CONSTANTS.TOKEN_REFRESH_BUFFER_MS) {
                                const clientId = getStorageItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID);
                                if (clientId) {
                                    SpotifyAuth.refreshToken(clientId).then(token => {
                                        if (token && djRef.current && !isCancelled) {
                                            djRef.current.updateAccessToken(token);
                                            syncUIState();
                                        }
                                    }).catch(e => console.error("Wake-up Token Refresh Failed:", e));
                                }
                            }
                        }

                        // 2. Immediate sync to update currently playing track and Up Next
                        syncUIState();

                        // 3. Restart loops if they were frozen by mobile OS
                        if (timerRef.current) clearTimeout(timerRef.current);
                        if (djTimerRef.current) clearTimeout(djTimerRef.current);
                        runUILoop();
                        runDJLoop();
                    }
                };

                document.addEventListener('visibilitychange', handleWakeUp);
                window.addEventListener('focus', handleWakeUp);

                cleanupListeners = () => {
                    document.removeEventListener('visibilitychange', handleWakeUp);
                    window.removeEventListener('focus', handleWakeUp);
                };
            } catch (initError: unknown) {
                if (isCancelled) return;
                console.error("Fatal initialization error:", initError);
                const msg = initError instanceof Error ? initError.message : String(initError);
                setStatus(`Init Error: ${msg}`);
            }
        };

        // Initialize
        init();

        return () => {
            isCancelled = true;
            if (timerRef.current) clearTimeout(timerRef.current);
            if (djTimerRef.current) clearTimeout(djTimerRef.current);
            if (cleanupListeners) cleanupListeners();
        };
    }, [syncUIState]); // Run ONCE on mount (with syncUIState stable)

    // Handlers
    const handleNext = async () => {
        startBackgroundKeepAlive();
        if (djRef.current) {
            // Optimistic update: advance current track and Up Next queue immediately
            if (queue.length > 0) {
                const nextTrack = queue[0];
                setCurrentTrack(nextTrack);
                setQueue(queue.slice(1));
            }
            await djRef.current.next();
            // Staggered sync to absorb Spotify API latency
            setTimeout(syncUIState, 500);
            setTimeout(syncUIState, 1500);
        }
    };
    const handlePrev = async () => {
        startBackgroundKeepAlive();
        if (djRef.current) {
            await djRef.current.previous();
            setTimeout(syncUIState, 500);
            setTimeout(syncUIState, 1500);
        }
    };
    const handleTogglePlay = async () => {
        startBackgroundKeepAlive();
        if (djRef.current) {
            if (isPlaying) await djRef.current.pause();
            else await djRef.current.resume();
            setIsPlaying(!isPlaying); // Optimistic update
            setTimeout(syncUIState, 500);
        }
    };

    const handleRemoveScheduleItem = (index: number) => {
        if (djRef.current) {
            // Update DJ Core
            const newSchedule = djRef.current.removeScheduleItem(index);
            // Update Local State
            setSchedule([...newSchedule]);
            // Persist
            setStoredJSON(STORAGE_KEYS.DJ_SCHEDULE, newSchedule);
        }
    };

    const refreshDevices = async () => {
        if (djRef.current) {
            const d = await djRef.current.getDevices();
            setDevices(d);
        }
    };

    const setDevice = async (deviceId: string) => {
        if (djRef.current) {
            await djRef.current.setActiveDevice(deviceId);
            // Optional: Refresh state immediately to reflect 'active' status on new device
            setTimeout(syncUIState, 500);
        }
    };

    const startBackgroundKeepAlive = () => {
        // Check user setting
        if (getStorageItem(STORAGE_KEYS.BACKGROUND_KEEP_ALIVE) !== 'true') return;

        if (!backgroundAudioRef.current) {
            // 1-second silent MP3
            const SILENT_MP3 = 'data:audio/mp3;base64,SUQzBAAAAAABEVRYWFgAAAAAtAAADgAAAB5WFb4AAABAAAAAAAAAAAAAA//uQZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMAAA//uQZAAAAAAA0gAAAAABBQAA0gAAAAEAABAAAAAAAABAAAAAAAAAAAAAAP/7kGQAAAAAADSAAAAAAAEAAADSAAAAAQAAEAAAAAAAQAAAAAAAAAAAAAA//uQZAAAAAAA0gAAAAAAAQAAANIAAAABAAAQAAAAAAAQAAAAAAAAAAAAAAD/+5BkAAAAAADSAAAAAAABAAAA0gAAAAEAABAAAAAAAEAAAAAAAAAAAAAAA//uQZAAAAAAA0gAAAAAAAQAAANIAAAABAAAQAAAAAAAQAAAAAAAAAAAAAAA==';
            const audio = new Audio(SILENT_MP3);
            audio.loop = true;
            audio.volume = 0.01; // Almost silent, but technically playing
            backgroundAudioRef.current = audio;
        }

        backgroundAudioRef.current.play().catch(e => {
            console.warn("Background audio auto-play blocked. User interaction required.", e);
        });
        console.log("🔊 Background Keep-Alive Audio Started");
    };

    return (
        <PlayerContext.Provider value={{
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
            logs: djLogs,
            error,
            clearError: () => setError(null),
            startBackgroundKeepAlive,
            syncUIState
        }}>
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
