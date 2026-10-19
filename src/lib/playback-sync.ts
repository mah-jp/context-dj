import { PLAYBACK_CONSTANTS } from './constants';
import { generateTrackKey } from './dj-utils';
import { Track } from './types';

export interface TransitionExpectation {
    expectedTrackUri?: string | null;
    expectedTrackKey?: string | null;
    departedTrackUri?: string | null;
    departedProgressMs?: number | null;
    allowSameTrackRewind?: boolean;
    expectedIsPlaying?: boolean;
    expectedDeviceId?: string;
}

export interface PendingPlaybackTransition extends TransitionExpectation {
    id: number;
    createdAt: number;
    expiresAt: number;
}

export interface TransitionGuardEvaluation {
    converged: boolean;
    expired: boolean;
    suppressTrackUpdate: boolean;
    suppressPlayStateUpdate: boolean;
    suppressDeviceUpdate: boolean;
    nextPending: PendingPlaybackTransition | null;
}

function isTrackMatchingExpectation(
    state: SpotifyApi.CurrentPlaybackResponse | null,
    expectation: TransitionExpectation
): boolean {
    if (!state) return false;
    const currentUri = state.item?.uri || null;
    const currentItem = state.item?.type === 'track' ? (state.item as Track) : null;

    const hasTrackExpectation = Boolean(expectation.expectedTrackUri || expectation.expectedTrackKey);
    const hasDepartedExpectation = Boolean(expectation.departedTrackUri);

    if (hasTrackExpectation) {
        if (expectation.expectedTrackUri && currentUri === expectation.expectedTrackUri) {
            return true;
        }
        if (
            expectation.expectedTrackKey &&
            currentItem &&
            generateTrackKey(currentItem) === expectation.expectedTrackKey
        ) {
            return true;
        }
        // If we also know the track we departed from (e.g. handleNext) and Spotify has already
        // moved to a different track (such as a relinked URI or user-queued track), treat as transitioned.
        if (hasDepartedExpectation && currentUri && currentUri !== expectation.departedTrackUri) {
            return true;
        }
        return false;
    }

    if (hasDepartedExpectation) {
        if (!currentUri) return false;
        if (currentUri !== expectation.departedTrackUri) {
            return true;
        }
        if (expectation.allowSameTrackRewind && typeof state.progress_ms === 'number') {
            if (
                expectation.departedProgressMs != null &&
                expectation.departedProgressMs >= 3000
            ) {
                return state.progress_ms < Math.min(4000, expectation.departedProgressMs - 2000);
            }
            return state.progress_ms < 3000;
        }
        return false;
    }

    return true;
}

/**
 * Checks whether a Spotify playback state response has converged to match all
 * expectations of a recently issued user/DJ transport action.
 */
export function isPlaybackStateConverged(
    state: SpotifyApi.CurrentPlaybackResponse | null,
    expectation: TransitionExpectation
): boolean {
    if (!state || state.__optimisticFallback) return false;

    const hasTrackExpectation = Boolean(expectation.expectedTrackUri || expectation.expectedTrackKey);
    const hasDepartedExpectation = Boolean(expectation.departedTrackUri);
    const hasPlayExpectation = expectation.expectedIsPlaying !== undefined;
    const hasDeviceExpectation = Boolean(expectation.expectedDeviceId);

    if (!hasTrackExpectation && !hasDepartedExpectation && !hasPlayExpectation && !hasDeviceExpectation) {
        return true;
    }

    if ((hasTrackExpectation || hasDepartedExpectation) && !isTrackMatchingExpectation(state, expectation)) {
        return false;
    }

    if (hasPlayExpectation && state.is_playing !== expectation.expectedIsPlaying) {
        return false;
    }

    if (hasDeviceExpectation && state.device?.id !== expectation.expectedDeviceId) {
        return false;
    }

    return true;
}

/**
 * Evaluates whether an incoming Spotify playback state should be applied or partially
 * suppressed to prevent UI bounce-back (揺り戻し) while Spotify Connect propagates a change.
 */
export function evaluateTransitionGuard(
    state: SpotifyApi.CurrentPlaybackResponse | null,
    pending: PendingPlaybackTransition | null,
    now: number = Date.now()
): TransitionGuardEvaluation {
    if (!pending) {
        return {
            converged: false,
            expired: false,
            suppressTrackUpdate: false,
            suppressPlayStateUpdate: false,
            suppressDeviceUpdate: false,
            nextPending: null,
        };
    }

    if (now >= pending.expiresAt) {
        return {
            converged: false,
            expired: true,
            suppressTrackUpdate: false,
            suppressPlayStateUpdate: false,
            suppressDeviceUpdate: false,
            nextPending: null,
        };
    }

    if (isPlaybackStateConverged(state, pending)) {
        return {
            converged: true,
            expired: false,
            suppressTrackUpdate: false,
            suppressPlayStateUpdate: false,
            suppressDeviceUpdate: false,
            nextPending: null,
        };
    }

    const hasTrackOrDeparted = Boolean(
        pending.expectedTrackUri || pending.expectedTrackKey || pending.departedTrackUri
    );
    const suppressTrackUpdate = Boolean(
        hasTrackOrDeparted && !isTrackMatchingExpectation(state, pending)
    );
    const suppressPlayStateUpdate = Boolean(
        pending.expectedIsPlaying !== undefined && state?.is_playing !== pending.expectedIsPlaying
    );
    const suppressDeviceUpdate = Boolean(
        (pending.expectedDeviceId !== undefined && state?.device?.id !== pending.expectedDeviceId) ||
        state?.__optimisticFallback
    );

    return {
        converged: false,
        expired: false,
        suppressTrackUpdate,
        suppressPlayStateUpdate,
        suppressDeviceUpdate,
        nextPending: pending,
    };
}

/**
 * Coordinates exponential-backoff state synchronization and guards optimistic UI state
 * against stale Spotify Connect API responses during track/device/play-state transitions.
 */
export class PlaybackConvergenceController {
    private pendingTransition: PendingPlaybackTransition | null = null;
    private lastConvergedId: number | null = null;
    private generation = 0;
    private activeTimer: ReturnType<typeof setTimeout> | null = null;
    private timerResolver: (() => void) | null = null;

    getPendingTransition(): PendingPlaybackTransition | null {
        return this.pendingTransition;
    }

    inspectState(
        state: SpotifyApi.CurrentPlaybackResponse | null,
        now: number = Date.now()
    ): TransitionGuardEvaluation {
        const currentPendingId = this.pendingTransition?.id ?? null;
        const evaluation = evaluateTransitionGuard(state, this.pendingTransition, now);
        this.pendingTransition = evaluation.nextPending;
        if (evaluation.converged && currentPendingId !== null) {
            this.lastConvergedId = currentPendingId;
        }
        return evaluation;
    }

    cancel() {
        this.generation++;
        this.pendingTransition = null;
        if (this.activeTimer) {
            clearTimeout(this.activeTimer);
            this.activeTimer = null;
        }
        if (this.timerResolver) {
            const resolve = this.timerResolver;
            this.timerResolver = null;
            resolve();
        }
    }

    private waitDelay(ms: number, gen: number): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            if (gen !== this.generation) {
                resolve(false);
                return;
            }
            this.timerResolver = () => resolve(gen === this.generation);
            this.activeTimer = setTimeout(() => {
                this.activeTimer = null;
                this.timerResolver = null;
                resolve(gen === this.generation);
            }, ms);
        });
    }

    async syncUntilConverged(
        expectation: TransitionExpectation,
        syncFn: (options?: { forceAll?: boolean }) => Promise<SpotifyApi.CurrentPlaybackResponse | null>,
        options?: {
            backoffMs?: readonly number[];
            ttlMs?: number;
        }
    ): Promise<boolean> {
        this.cancel();
        const currentGen = ++this.generation;
        const backoffMs = options?.backoffMs ?? PLAYBACK_CONSTANTS.CONVERGENCE_BACKOFF_MS;
        const ttlMs = options?.ttlMs ?? PLAYBACK_CONSTANTS.TRANSITION_GUARD_TTL_MS;
        const now = Date.now();

        this.pendingTransition = {
            ...expectation,
            id: currentGen,
            createdAt: now,
            expiresAt: now + ttlMs,
        };

        for (const delay of backoffMs) {
            const stillActive = await this.waitDelay(delay, currentGen);
            if (!stillActive || currentGen !== this.generation) {
                return false;
            }

            if (this.lastConvergedId === currentGen) {
                this.pendingTransition = null;
                return true;
            }

            const state = await syncFn({ forceAll: true });
            if (currentGen !== this.generation) {
                return false;
            }

            if (this.lastConvergedId === currentGen || isPlaybackStateConverged(state, expectation)) {
                this.pendingTransition = null;
                return true;
            }

            if (!this.pendingTransition) {
                // Transition guard expired during inspectState without converging
                return false;
            }
        }

        // Backoff attempts exhausted: clear transition guard and reconcile with actual server state
        if (currentGen === this.generation) {
            this.pendingTransition = null;
            await syncFn({ forceAll: true });
        }
        return false;
    }
}
