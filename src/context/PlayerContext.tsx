'use client';

import React, { createContext, useContext, useEffect, useState, useRef, ReactNode } from 'react';
import { DJCore, Track } from '../lib/dj-core';
import { ScheduleItem } from '../lib/ai';
import { SpotifyAuth } from '../lib/spotify-auth';

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

    const djRef = useRef<DJCore | null>(null);
    const timerRef = useRef<NodeJS.Timeout | null>(null);

    // Helper to sync UI with DJ Core state
    const syncUIState = React.useCallback(async () => {
        if (!djRef.current) return null;

        // Sync Playing State
        const playbackState = await djRef.current.getPlaybackState();
        if (playbackState && playbackState.item) {
            setCurrentTrack(playbackState.item as Track);
            setIsPlaying(playbackState.is_playing);
            setDeviceName(playbackState.device.name);
        } else {
            setCurrentTrack(null);
            setIsPlaying(false);
            setDeviceName('');
        }

        const currentQ = await djRef.current.getQueue();
        setQueue(currentQ.slice(0, 20));

        // Sync Devices
        const currentDevices = await djRef.current.getDevices();
        setDevices(currentDevices);

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
        const init = async () => {
            // 0. Check Onboarding
            if (typeof window !== 'undefined') {
                setNeedsOnboarding(!localStorage.getItem('spotify_client_id'));
            }

            // 1. Check for Callback Code
            const params = new URLSearchParams(window.location.search);
            const code = params.get('code');
            // Ideally we shouldn't access localStorage if window is undefined, but useEffect runs on client
            const storedClientId = localStorage.getItem('spotify_client_id');

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
                const openaiKey = localStorage.getItem('openai_api_key');
                const openaiModel = localStorage.getItem('openai_model') || 'gpt-4o-mini';
                const geminiKey = localStorage.getItem('gemini_api_key');
                const geminiModel = localStorage.getItem('gemini_model') || 'gemini-2.0-flash';
                const selectedProvider = localStorage.getItem('selected_ai_provider') || 'openai';

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

                // Restore Schedule
                const savedSchedule = localStorage.getItem('dj_schedule');
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

            // 3. Start Polling Loop with Dynamic Interval
            if (timerRef.current) clearTimeout(timerRef.current);

            const tick = async () => {
                let nextDelay = 5000; // Default 5s

                try {
                    if (djRef.current) {
                        // Check Schedule (AI Logic)
                        await djRef.current.processDJLoop();

                        // Sync UI
                        const playbackState = await syncUIState();

                        // Dynamic Interval: If track is ending soon (< 10s), increase polling rate to 1s
                        if (playbackState && playbackState.is_playing && playbackState.item && playbackState.item.duration_ms && playbackState.progress_ms) {
                            const remaining = playbackState.item.duration_ms - playbackState.progress_ms;
                            if (remaining < 10000) {
                                nextDelay = 1000;
                            }
                        }
                    }
                } catch (error) {
                    console.error("Error in DJ Loop tick:", error);
                    // On error, keep default delay or increase it slightly to avoid rapid error spam
                }

                // Auto-refresh token if expiring soon (within 5 minutes)
                if (authorized) {
                    const expiresAtStr = localStorage.getItem('spotify_expires_at');
                    if (expiresAtStr) {
                        const expiresAt = parseInt(expiresAtStr);
                        const nowMs = Date.now();
                        // 5 minutes buffer = 5 * 60 * 1000 = 300000
                        if (expiresAt - nowMs < 300000) {
                            console.log('🔄 Token expiring soon, refreshing...');
                            const clientId = localStorage.getItem('spotify_client_id');
                            if (clientId) {
                                const newToken = await SpotifyAuth.refreshToken(clientId);
                                if (newToken && djRef.current) {
                                    djRef.current.updateAccessToken(newToken);
                                    console.log('✅ Token refreshed and updated in DJCore');
                                }
                            }
                        }
                    }
                }

                // Schedule next tick
                timerRef.current = setTimeout(tick, nextDelay);
            };

            tick();
        };

        // Initialize
        init();

        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, [syncUIState]); // Run ONCE on mount (with syncUIState stable)

    // Handlers
    const handleNext = async () => {
        if (djRef.current) {
            await djRef.current.next();
            setTimeout(syncUIState, 500); // Trigger immediate refresh after small delay
        }
    };
    const handlePrev = async () => {
        if (djRef.current) {
            await djRef.current.previous();
            setTimeout(syncUIState, 500);
        }
    };
    const handleTogglePlay = async () => {
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
            localStorage.setItem('dj_schedule', JSON.stringify(newSchedule));
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
            logs: djLogs
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
