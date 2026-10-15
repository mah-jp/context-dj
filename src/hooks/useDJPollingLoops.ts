import { useEffect, useRef } from 'react';
import { DJCore } from '../lib/dj-core';
import { SpotifyAuth } from '../lib/spotify-auth';
import { STORAGE_KEYS, PLAYBACK_CONSTANTS, DEFAULTS } from '../lib/constants';
import { getStorageItem } from '../lib/storage';

interface UseDJPollingLoopsProps {
    authorized: boolean;
    djCore: DJCore | null;
    syncUIState: (options?: { forceAll?: boolean }) => Promise<SpotifyApi.CurrentPlaybackResponse | null>;
    onError: (msg: string) => void;
}

/**
 * Manages the decoupled UI polling loop, background-throttled DJ logic loop,
 * proactive Spotify token refresh, and page visibility/focus lifecycle.
 */
export function useDJPollingLoops({
    authorized,
    djCore,
    syncUIState,
    onError,
}: UseDJPollingLoopsProps) {
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const djTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (!authorized || !djCore) {
            if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
            if (djTimerRef.current) {
                clearTimeout(djTimerRef.current);
                djTimerRef.current = null;
            }
            return;
        }

        let isCancelled = false;

        const checkAndRefreshToken = async () => {
            if (isCancelled) return;
            const expiresAtStr = getStorageItem(STORAGE_KEYS.SPOTIFY_EXPIRES_AT);
            if (expiresAtStr) {
                const expiresAt = parseInt(expiresAtStr, 10);
                if (Date.now() > expiresAt - PLAYBACK_CONSTANTS.TOKEN_REFRESH_BUFFER_MS) {
                    const clientId = getStorageItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID);
                    if (clientId) {
                        try {
                            const refreshedToken = await SpotifyAuth.refreshToken(clientId);
                            if (refreshedToken && !isCancelled) {
                                djCore.updateAccessToken(refreshedToken);
                                console.log("🔑 Proactive token refresh succeeded");
                            }
                        } catch (e) {
                            console.error("Token Refresh Failed:", e);
                        }
                    }
                }
            }
        };

        // --- UI Loop (High Priority, Suspended when Backgrounded) ---
        const runUILoop = async () => {
            if (isCancelled) return;

            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
                timerRef.current = null;
                return;
            }

            let nextDelay: number = PLAYBACK_CONSTANTS.UI_POLL_INTERVAL_MS;

            try {
                const playbackState = await syncUIState();

                if (
                    playbackState &&
                    playbackState.is_playing &&
                    playbackState.item &&
                    playbackState.item.duration_ms &&
                    playbackState.progress_ms
                ) {
                    const remaining = playbackState.item.duration_ms - playbackState.progress_ms;
                    if (remaining < PLAYBACK_CONSTANTS.TRACK_REMAINING_THRESHOLD_MS) {
                        nextDelay = PLAYBACK_CONSTANTS.UI_POLL_FAST_INTERVAL_MS;
                    }
                }
            } catch (loopError) {
                console.error("Error in UI Loop:", loopError);
            }

            if (isCancelled) return;

            await checkAndRefreshToken();

            if (!isCancelled && typeof document !== 'undefined' && document.visibilityState !== 'hidden') {
                timerRef.current = setTimeout(runUILoop, nextDelay);
            } else {
                timerRef.current = null;
            }
        };

        // --- DJ Logic Loop (AI, Heavy Process, Throttled in Background) ---
        const runDJLoop = async () => {
            if (isCancelled) return;

            const isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
            const nextDelay: number = isHidden
                ? PLAYBACK_CONSTANTS.DJ_LOOP_BACKGROUND_INTERVAL_MS
                : PLAYBACK_CONSTANTS.DJ_LOOP_INTERVAL_MS;

            try {
                const savedFiltering = getStorageItem(STORAGE_KEYS.AI_FILTERING_ENABLED, '');
                djCore.updateConfig({
                    aiFiltering: savedFiltering === '' ? DEFAULTS.AI_FILTERING_ENABLED : savedFiltering === 'true'
                });

                await djCore.processDJLoop();
            } catch (djLoopError: unknown) {
                console.error("Error in DJ Loop:", djLoopError);
                const msg = djLoopError instanceof Error ? djLoopError.message : "Unknown background error";
                onError(msg);
            }

            if (isCancelled) return;

            if (isHidden) {
                await checkAndRefreshToken();
            }

            if (!isCancelled) {
                djTimerRef.current = setTimeout(runDJLoop, nextDelay);
            }
        };

        runUILoop();
        runDJLoop();

        const handleVisibilityChange = () => {
            if (isCancelled) return;

            if (document.visibilityState === 'visible') {
                console.log("📱 App visible: immediately syncing UI and resuming loops");
                checkAndRefreshToken();
                syncUIState({ forceAll: true });

                if (timerRef.current) clearTimeout(timerRef.current);
                if (djTimerRef.current) clearTimeout(djTimerRef.current);
                runUILoop();
                runDJLoop();
            } else {
                console.log("💤 App backgrounded: suspending UI polling, throttling DJ loop to save battery");
                if (timerRef.current) {
                    clearTimeout(timerRef.current);
                    timerRef.current = null;
                }
                if (djTimerRef.current) {
                    clearTimeout(djTimerRef.current);
                    djTimerRef.current = setTimeout(runDJLoop, PLAYBACK_CONSTANTS.DJ_LOOP_BACKGROUND_INTERVAL_MS);
                }
            }
        };

        const handleFocus = () => {
            if (document.visibilityState === 'visible' && !timerRef.current && !isCancelled) {
                handleVisibilityChange();
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        window.addEventListener('focus', handleFocus);

        return () => {
            isCancelled = true;
            if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
            if (djTimerRef.current) {
                clearTimeout(djTimerRef.current);
                djTimerRef.current = null;
            }
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            window.removeEventListener('focus', handleFocus);
        };
    }, [authorized, djCore, syncUIState, onError]);
}
