import { useEffect } from 'react';
import { DJCore } from '../lib/dj-core';
import { SpotifyAuth } from '../lib/spotify-auth';
import { STORAGE_KEYS, PLAYBACK_CONSTANTS, DEFAULTS } from '../lib/constants';
import { getStorageItem } from '../lib/storage';

export interface UseDJPollingLoopsProps {
    authorized: boolean;
    djCore: DJCore | null;
    syncUIState: (options?: { forceAll?: boolean }) => Promise<SpotifyApi.CurrentPlaybackResponse | null>;
    onError: (msg: string) => void;
    onAuthExpired?: () => void;
}

export interface DJPollingControllerOptions {
    djCore: DJCore;
    syncUIState: (options?: { forceAll?: boolean }) => Promise<SpotifyApi.CurrentPlaybackResponse | null>;
    onError: (msg: string) => void;
    onAuthExpired?: () => void;
    uiPollIntervalMs?: number;
    uiPollFastIntervalMs?: number;
    djLoopIntervalMs?: number;
    djLoopBackgroundIntervalMs?: number;
    tokenRefreshCooldownMs?: number;
}

/**
 * Computes the next UI polling delay, accelerating to fast interval when a track is near completion.
 */
export function computeNextUIPollDelay(
    playbackState: SpotifyApi.CurrentPlaybackResponse | null,
    normalIntervalMs: number = PLAYBACK_CONSTANTS.UI_POLL_INTERVAL_MS,
    fastIntervalMs: number = PLAYBACK_CONSTANTS.UI_POLL_FAST_INTERVAL_MS
): number {
    if (
        playbackState &&
        playbackState.is_playing &&
        playbackState.item &&
        typeof playbackState.item.duration_ms === 'number' &&
        playbackState.item.duration_ms > 0 &&
        typeof playbackState.progress_ms === 'number'
    ) {
        const remaining = playbackState.item.duration_ms - playbackState.progress_ms;
        if (remaining < PLAYBACK_CONSTANTS.TRACK_REMAINING_THRESHOLD_MS) {
            return fastIntervalMs;
        }
    }
    return normalIntervalMs;
}

/**
 * Creates a lifecycle-managed polling controller for UI state synchronization,
 * background DJ loop execution, proactive token refresh, and page visibility handling.
 */
export function createDJPollingController({
    djCore,
    syncUIState,
    onError,
    onAuthExpired,
    uiPollIntervalMs = PLAYBACK_CONSTANTS.UI_POLL_INTERVAL_MS,
    uiPollFastIntervalMs = PLAYBACK_CONSTANTS.UI_POLL_FAST_INTERVAL_MS,
    djLoopIntervalMs = PLAYBACK_CONSTANTS.DJ_LOOP_INTERVAL_MS,
    djLoopBackgroundIntervalMs = PLAYBACK_CONSTANTS.DJ_LOOP_BACKGROUND_INTERVAL_MS,
    tokenRefreshCooldownMs = 60_000,
}: DJPollingControllerOptions) {
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let djTimerId: ReturnType<typeof setTimeout> | null = null;
    let isCancelled = false;
    let isUILoopRunning = false;
    let isDJLoopRunning = false;
    let pendingForceAll = false;
    let lastResumeSyncTime = 0;
    let lastTokenRefreshAttemptTime = 0;

    const clearTimers = () => {
        if (timerId) {
            clearTimeout(timerId);
            timerId = null;
        }
        if (djTimerId) {
            clearTimeout(djTimerId);
            djTimerId = null;
        }
    };

    const isDocumentHidden = (): boolean => {
        return typeof document !== 'undefined' && document.visibilityState === 'hidden';
    };

    const checkAndRefreshToken = async () => {
        if (isCancelled) return;
        const expiresAtStr = getStorageItem(STORAGE_KEYS.SPOTIFY_EXPIRES_AT);
        if (expiresAtStr) {
            const expiresAt = parseInt(expiresAtStr, 10);
            const now = Date.now();
            if (now > expiresAt - PLAYBACK_CONSTANTS.TOKEN_REFRESH_BUFFER_MS) {
                if (lastTokenRefreshAttemptTime > 0 && now - lastTokenRefreshAttemptTime < tokenRefreshCooldownMs) {
                    return;
                }
                lastTokenRefreshAttemptTime = now;
                const clientId = getStorageItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID);
                if (clientId) {
                    try {
                        const refreshedToken = await SpotifyAuth.refreshToken(clientId);
                        if (refreshedToken && !isCancelled) {
                            lastTokenRefreshAttemptTime = 0;
                            djCore.updateAccessToken(refreshedToken);
                            console.log("🔑 Proactive token refresh succeeded");
                        } else if (!refreshedToken && !isCancelled && Date.now() >= expiresAt) {
                            onAuthExpired?.();
                        }
                    } catch (e) {
                        console.error("Token Refresh Failed:", e);
                    }
                }
            }
        }
    };

    // --- UI Loop (High Priority, Suspended when Backgrounded) ---
    const runUILoop = async (options?: { forceAll?: boolean }) => {
        if (isCancelled) return;
        if (isUILoopRunning) {
            if (options?.forceAll) {
                pendingForceAll = true;
            }
            return;
        }

        if (isDocumentHidden()) {
            timerId = null;
            return;
        }

        isUILoopRunning = true;
        if (timerId) {
            clearTimeout(timerId);
            timerId = null;
        }

        let nextDelay: number = uiPollIntervalMs;

        try {
            const playbackState = await syncUIState(options);
            nextDelay = computeNextUIPollDelay(playbackState, uiPollIntervalMs, uiPollFastIntervalMs);
        } catch (loopError) {
            console.error("Error in UI Loop:", loopError);
        } finally {
            isUILoopRunning = false;
        }

        if (isCancelled) return;

        if (pendingForceAll && !isDocumentHidden()) {
            pendingForceAll = false;
            void runUILoop({ forceAll: true });
            return;
        }

        await checkAndRefreshToken();

        if (!isCancelled && !isDocumentHidden()) {
            timerId = setTimeout(() => void runUILoop(), nextDelay);
        } else {
            timerId = null;
        }
    };

    // --- DJ Logic Loop (AI, Heavy Process, Throttled in Background) ---
    const runDJLoop = async () => {
        if (isCancelled || isDJLoopRunning) return;

        isDJLoopRunning = true;
        if (djTimerId) {
            clearTimeout(djTimerId);
            djTimerId = null;
        }

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
        } finally {
            isDJLoopRunning = false;
        }

        if (isCancelled) return;

        const isHidden = isDocumentHidden();
        const nextDelay: number = isHidden ? djLoopBackgroundIntervalMs : djLoopIntervalMs;

        if (isHidden) {
            await checkAndRefreshToken();
        }

        if (!isCancelled) {
            djTimerId = setTimeout(() => void runDJLoop(), nextDelay);
        }
    };

    const resumeOnForeground = () => {
        if (isCancelled) return;
        const now = Date.now();
        if (now - lastResumeSyncTime < 500) return;
        lastResumeSyncTime = now;

        console.log("📱 App foregrounded: immediately syncing UI and resuming loops");
        void checkAndRefreshToken();

        clearTimers();

        void runUILoop({ forceAll: true });
        if (!isDJLoopRunning) {
            void runDJLoop();
        }
    };

    const handleVisibilityChange = () => {
        if (isCancelled) return;

        if (!isDocumentHidden()) {
            resumeOnForeground();
        } else {
            console.log("💤 App backgrounded: suspending UI polling, throttling DJ loop to save battery");
            if (timerId) {
                clearTimeout(timerId);
                timerId = null;
            }
            if (djTimerId) {
                clearTimeout(djTimerId);
                djTimerId = setTimeout(() => void runDJLoop(), djLoopBackgroundIntervalMs);
            }
        }
    };

    const handleFocus = () => {
        if (!isCancelled && !isDocumentHidden()) {
            resumeOnForeground();
        }
    };

    const start = () => {
        void runUILoop();
        void runDJLoop();

        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('visibilitychange', handleVisibilityChange);
        }
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('focus', handleFocus);
        }
    };

    const stop = () => {
        isCancelled = true;
        clearTimers();
        if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        }
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('focus', handleFocus);
        }
    };

    return {
        start,
        stop,
        runUILoop,
        runDJLoop,
        checkAndRefreshToken,
        handleVisibilityChange,
    };
}

/**
 * Manages the decoupled UI polling & background-throttled DJ logic loop,
 * proactive Spotify token refresh, and page visibility/focus lifecycle.
 */
export function useDJPollingLoops({
    authorized,
    djCore,
    syncUIState,
    onError,
    onAuthExpired,
}: UseDJPollingLoopsProps) {
    useEffect(() => {
        if (!authorized || !djCore) {
            return;
        }

        const controller = createDJPollingController({
            djCore,
            syncUIState,
            onError,
            onAuthExpired,
        });
        controller.start();

        return () => {
            controller.stop();
        };
    }, [authorized, djCore, syncUIState, onError, onAuthExpired]);
}
