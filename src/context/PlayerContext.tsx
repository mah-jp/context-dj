'use client';

import React, { createContext, useContext, useEffect, useState, useRef, ReactNode } from 'react';
import { DJCore, Track } from '../lib/dj-core';
import { ScheduleItem } from '../lib/ai';
import { SpotifyAuth } from '../lib/spotify-auth';
import { STORAGE_KEYS, PLAYBACK_CONSTANTS } from '../lib/constants';

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
}

const PlayerContext = createContext<PlayerContextType | undefined>(undefined);

export function PlayerProvider({ children }: { children: ReactNode }) {
    const [authorized, setAuthorized] = useState(false);
    const [status, setStatus] = useState('Initializing...');

    const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [deviceName, setDeviceName] = useState('');
    const [schedule, setSchedule] = useState<ScheduleItem[]>([]);
    const [currentQuery, setCurrentQuery] = useState<string | null>(null);
    const [needsOnboarding, setNeedsOnboarding] = useState(false);
    const [queue, setQueue] = useState<Track[]>([]);
    const [devices, setDevices] = useState<SpotifyApi.UserDevice[]>([]);
    const [djLogs, setDjLogs] = useState<string[]>([]); // Added logs state
    const [error, setError] = useState<string | null>(null);

    const djRef = useRef<DJCore | null>(null);
    const timerRef = useRef<NodeJS.Timeout | null>(null);
    const djTimerRef = useRef<NodeJS.Timeout | null>(null);
    const backgroundAudioRef = useRef<HTMLAudioElement | null>(null);

    // Helper to sync UI with DJ Core state
    const syncUIState = React.useCallback(async () => {
        if (!djRef.current) return null;

        // Fetch Data concurrently for better performance and consistency
        const [playbackState, currentQ, currentDevices] = await Promise.all([
            djRef.current.getPlaybackState(),
            djRef.current.getQueue(),
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
        if (playbackState && playbackState.item && playbackState.item.type === 'track') {
            setCurrentTrack(playbackState.item as Track);
            setIsPlaying(playbackState.is_playing);
        } else {
            setCurrentTrack(null);
            setIsPlaying(false);
        }

        // Update Status
        const djStatus = djRef.current.getDJStatus();
        setCurrentQuery(djStatus.currentQuery);

        // Sync Logs
        if (typeof djRef.current.getProcessLog === 'function') {
            setDjLogs([...djRef.current.getProcessLog()]);
        }

        return playbackState;
    }, []);

    // Initialize
    useEffect(() => {
        let cleanupListeners: (() => void) | null = null;

        const init = async () => {
            try {
                // 0. Check Onboarding
                if (typeof window !== 'undefined') {
                    setNeedsOnboarding(!localStorage.getItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID));
                }

                // 1. Check for Callback Code
                const params = new URLSearchParams(window.location.search);
                const code = params.get('code');
                // Ideally we shouldn't access localStorage if window is undefined, but useEffect runs on client
                const storedClientId = localStorage.getItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID);

                if (!storedClientId) {
                    setStatus('Please configure settings first.');
                    return;
                }

                let token = SpotifyAuth.getAccessToken();

                if (code) {
                    setStatus('Authenticating...');
                    token = await SpotifyAuth.handleCallback(storedClientId, code);
                    // Clear code from URL after successful handling
                    window.history.replaceState({}, document.title, window.location.pathname);
                }

                if (!token || !SpotifyAuth.isAuthenticated()) {
                    // Try refreshing token
                    const newToken = await SpotifyAuth.refreshToken(storedClientId);
                    if (newToken) {
                        token = newToken;
                        console.log("Token refreshed successfully");
                    } else {
                        setStatus('connect_needed');
                        return;
                    }
                }

                // 2. Initialize DJ Core
                setAuthorized(true);
                setStatus('Ready');

                // Prevent re-creating DJCore if it exists (though useEffect run once implies it shouldn't exist)
                if (!djRef.current) {
                    const dj = new DJCore(token);

                    // Load AI Config
                    const openaiKey = localStorage.getItem(STORAGE_KEYS.OPENAI_API_KEY);
                    const openaiModel = localStorage.getItem(STORAGE_KEYS.OPENAI_MODEL) || 'gpt-4o-mini';
                    const geminiKey = localStorage.getItem(STORAGE_KEYS.GEMINI_API_KEY);
                    const geminiModel = localStorage.getItem(STORAGE_KEYS.GEMINI_MODEL) || 'gemini-2.0-flash';
                    const selectedProvider = localStorage.getItem(STORAGE_KEYS.SELECTED_AI_PROVIDER) || 'openai';

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
                    dj.setStatusCallback(setStatus);

                    // Restore Schedule
                    const savedSchedule = localStorage.getItem(STORAGE_KEYS.DJ_SCHEDULE);
                    if (savedSchedule) {
                        try {
                            const parsed = JSON.parse(savedSchedule);
                            if (Array.isArray(parsed)) {
                                setSchedule(parsed);
                                dj.setSchedule(parsed);
                            }
                        } catch (e) {
                            console.error("Failed to load saved schedule", e);
                        }
                    }
                }

                // 3. Start Separate Loops (UI & DJ Logic)
                // This decoupling ensures UI/Device status updates don't freeze while AI is thinking.

                if (timerRef.current) clearTimeout(timerRef.current);
                if (djTimerRef.current) clearTimeout(djTimerRef.current);

                // --- UI Loop (High Priority, Non-Blocking) ---
                const runUILoop = async () => {
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

                    // Auto-refresh token if expiring soon (Keep this in UI loop as it's lightweight logic)
                    if (authorized) {
                        const expiresAtStr = localStorage.getItem(STORAGE_KEYS.SPOTIFY_EXPIRES_AT);
                        if (expiresAtStr) {
                            const expiresAt = parseInt(expiresAtStr);
                            if (Date.now() > expiresAt - PLAYBACK_CONSTANTS.TOKEN_REFRESH_BUFFER_MS) {
                                const clientId = localStorage.getItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID);
                                if (clientId) {
                                    SpotifyAuth.refreshToken(clientId).then(token => {
                                        if (token && djRef.current) djRef.current.updateAccessToken(token);
                                    }).catch(e => console.error("Token Refresh Failed:", e));
                                }
                            }
                        }
                    }

                    timerRef.current = setTimeout(runUILoop, nextDelay);
                };

                // --- DJ Logic Loop (AI, Heavy Process) ---
                const runDJLoop = async () => {
                    let nextDelay = PLAYBACK_CONSTANTS.DJ_LOOP_INTERVAL_MS;

                    try {
                        if (djRef.current) {
                            // Sync Config
                            const savedFiltering = localStorage.getItem(STORAGE_KEYS.AI_FILTERING_ENABLED);
                            djRef.current.updateConfig({
                                aiFiltering: savedFiltering === null ? true : savedFiltering === 'true'
                            });

                            // Check Schedule (AI Logic) - This may block for seconds during AI request
                            await djRef.current.processDJLoop();
                        }
                    } catch (error: any) {
                        console.error("Error in DJ Loop:", error);
                        const msg = error.message || "Unknown background error";
                        setError(prev => prev === msg ? prev : msg);
                    }

                    djTimerRef.current = setTimeout(runDJLoop, nextDelay);
                };

                // Start both loops
                runUILoop();
                runDJLoop();

                // Visibility/Focus Restoration
                const handleVisible = () => {
                    if (document.visibilityState === 'visible') {
                        if (timerRef.current) clearTimeout(timerRef.current);
                        runUILoop();
                    }
                };
                const handleFocus = () => {
                    if (timerRef.current) clearTimeout(timerRef.current);
                    runUILoop();
                };

                document.addEventListener('visibilitychange', handleVisible);
                window.addEventListener('focus', handleFocus);

                cleanupListeners = () => {
                    document.removeEventListener('visibilitychange', handleVisible);
                    window.removeEventListener('focus', handleFocus);
                };
            } catch (initError: any) {
                console.error("Fatal initialization error:", initError);
                setStatus(`Init Error: ${initError.message || initError}`);
            }
        };

        // Initialize
        init();

        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
            if (djTimerRef.current) clearTimeout(djTimerRef.current);
            if (cleanupListeners) cleanupListeners();
        };
    }, [syncUIState]); // Run ONCE on mount (with syncUIState stable)

    // Handlers
    const handleNext = async () => {
        startBackgroundKeepAlive();
        if (djRef.current) {
            await djRef.current.next();
            setTimeout(syncUIState, 500); // Trigger immediate refresh after small delay
        }
    };
    const handlePrev = async () => {
        startBackgroundKeepAlive();
        if (djRef.current) {
            await djRef.current.previous();
            setTimeout(syncUIState, 500);
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
            localStorage.setItem(STORAGE_KEYS.DJ_SCHEDULE, JSON.stringify(newSchedule));
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
        if (localStorage.getItem(STORAGE_KEYS.BACKGROUND_KEEP_ALIVE) !== 'true') return;

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
            djCore: djRef.current,
            authorized,
            status,
            setStatus,
            currentTrack,
            isPlaying,
            deviceName,
            schedule,
            setSchedule,
            currentQuery,
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
            startBackgroundKeepAlive
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
