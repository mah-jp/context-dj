import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    isPlaybackStateConverged,
    evaluateTransitionGuard,
    PlaybackConvergenceController,
} from '../src/lib/playback-sync';
import { PLAYBACK_CONSTANTS } from '../src/lib/constants';

function makePlaybackState(overrides: {
    uri?: string;
    name?: string;
    artistName?: string;
    isPlaying?: boolean;
    deviceId?: string;
    progressMs?: number;
    optimisticFallback?: boolean;
}): SpotifyApi.CurrentPlaybackResponse {
    return {
        is_playing: overrides.isPlaying ?? true,
        progress_ms: overrides.progressMs ?? 15000,
        item: overrides.uri
            ? ({
                uri: overrides.uri,
                type: 'track',
                name: overrides.name ?? 'Track',
                artists: [{ name: overrides.artistName ?? 'Artist' }],
            } as unknown as SpotifyApi.TrackObjectFull)
            : null,
        device: {
            id: overrides.deviceId ?? 'dev_1',
            name: 'Device 1',
            is_active: true,
        } as SpotifyApi.UserDevice,
        ...(overrides.optimisticFallback ? { __optimisticFallback: true } : {}),
    } as SpotifyApi.CurrentPlaybackResponse;
}

describe('playback-sync', () => {
    describe('isPlaybackStateConverged & evaluateTransitionGuard', () => {
        it('suppresses stale track, play state, and device updates before convergence and clears once converged', () => {
            const now = 10000;
            const pending = {
                id: 1,
                expectedTrackUri: 'spotify:track:next_song',
                expectedIsPlaying: true,
                expectedDeviceId: 'dev_2',
                createdAt: now,
                expiresAt: now + 5000,
            };

            // 1. Stale state returned by Spotify Connect (still on old_song, paused, dev_1)
            const staleState = makePlaybackState({
                uri: 'spotify:track:old_song',
                isPlaying: false,
                deviceId: 'dev_1',
            });
            const guardStale = evaluateTransitionGuard(staleState, pending, now + 500);
            assert.strictEqual(guardStale.converged, false);
            assert.strictEqual(guardStale.suppressTrackUpdate, true);
            assert.strictEqual(guardStale.suppressPlayStateUpdate, true);
            assert.strictEqual(guardStale.suppressDeviceUpdate, true);
            assert.strictEqual(guardStale.nextPending, pending);

            // 2. Converged state returned by Spotify Connect
            const convergedState = makePlaybackState({
                uri: 'spotify:track:next_song',
                isPlaying: true,
                deviceId: 'dev_2',
            });
            const guardConverged = evaluateTransitionGuard(convergedState, pending, now + 1200);
            assert.strictEqual(guardConverged.converged, true);
            assert.strictEqual(guardConverged.suppressTrackUpdate, false);
            assert.strictEqual(guardConverged.suppressPlayStateUpdate, false);
            assert.strictEqual(guardConverged.suppressDeviceUpdate, false);
            assert.strictEqual(guardConverged.nextPending, null);
        });

        it('rejects synthetic __optimisticFallback playback states as non-converged and suppresses track/play-state updates', () => {
            const now = 10000;
            const syntheticState = makePlaybackState({
                uri: 'spotify:track:first',
                isPlaying: true,
                optimisticFallback: true,
            });
            const pending = {
                id: 1,
                expectedTrackUri: 'spotify:track:first',
                expectedIsPlaying: true,
                createdAt: now,
                expiresAt: now + 5000,
            };
            assert.strictEqual(
                isPlaybackStateConverged(syntheticState, pending),
                false
            );
            const guard = evaluateTransitionGuard(syntheticState, pending, now + 350);
            assert.strictEqual(guard.converged, false);
            assert.strictEqual(guard.suppressTrackUpdate, true);
            assert.strictEqual(guard.suppressPlayStateUpdate, true);
            assert.strictEqual(guard.suppressDeviceUpdate, true);
        });

        it('converges via linked_from.uri when Spotify relinks a track with a localized title', () => {
            const relinkedLocalizedState = {
                ...makePlaybackState({
                    uri: 'spotify:track:jp_relinked_uri',
                    name: '海辺の散歩 (日本語タイトル)',
                    artistName: '別名義アーティスト',
                }),
                item: {
                    uri: 'spotify:track:jp_relinked_uri',
                    id: 'jp_relinked_uri',
                    type: 'track',
                    name: '海辺の散歩 (日本語タイトル)',
                    artists: [{ name: '別名義アーティスト' }],
                    linked_from: {
                        uri: 'spotify:track:orig_global_uri',
                        id: 'orig_global_uri',
                    },
                } as unknown as SpotifyApi.TrackObjectFull,
            } as SpotifyApi.CurrentPlaybackResponse;

            assert.strictEqual(
                isPlaybackStateConverged(relinkedLocalizedState, {
                    expectedTrackUri: 'spotify:track:orig_global_uri',
                    expectedTrackKey: 'ocean walk|english artist',
                }),
                true
            );
        });

        it('handles departedTrackUri expectation and same-track rewind for previous()', () => {
            const stateStillOnOld = makePlaybackState({ uri: 'spotify:track:current', progressMs: 42000 });
            const stateMovedToPrev = makePlaybackState({ uri: 'spotify:track:prev', progressMs: 0 });
            const stateRewoundSameTrack = makePlaybackState({ uri: 'spotify:track:current', progressMs: 800 });

            assert.strictEqual(
                isPlaybackStateConverged(stateStillOnOld, {
                    departedTrackUri: 'spotify:track:current',
                    departedProgressMs: 42000,
                    allowSameTrackRewind: true,
                }),
                false
            );
            assert.strictEqual(
                isPlaybackStateConverged(stateMovedToPrev, {
                    departedTrackUri: 'spotify:track:current',
                    departedProgressMs: 42000,
                    allowSameTrackRewind: true,
                }),
                true
            );
            assert.strictEqual(
                isPlaybackStateConverged(stateRewoundSameTrack, {
                    departedTrackUri: 'spotify:track:current',
                    departedProgressMs: 42000,
                    allowSameTrackRewind: true,
                }),
                true
            );
        });

        it('converges on relinked track via expectedTrackKey or when departedTrackUri has changed', () => {
            const relinkedState = makePlaybackState({
                uri: 'spotify:track:relinked_jp',
                name: 'Ocean Walk - 2026 Remaster',
                artistName: 'City Pop',
            });
            assert.strictEqual(
                isPlaybackStateConverged(relinkedState, {
                    expectedTrackUri: 'spotify:track:original_us',
                    expectedTrackKey: 'ocean walk|city pop',
                }),
                true
            );

            const userQueuedState = makePlaybackState({
                uri: 'spotify:track:user_manual_queue',
            });
            assert.strictEqual(
                isPlaybackStateConverged(userQueuedState, {
                    expectedTrackUri: 'spotify:track:session_next',
                    departedTrackUri: 'spotify:track:session_prev',
                }),
                true
            );
        });

        it('expires transition guard after TTL so UI never gets permanently stuck', () => {
            const now = 10000;
            const pending = {
                id: 1,
                expectedTrackUri: 'spotify:track:next_song',
                createdAt: now,
                expiresAt: now + 5000,
            };
            const staleState = makePlaybackState({ uri: 'spotify:track:old_song' });

            const expiredEval = evaluateTransitionGuard(staleState, pending, now + 5001);
            assert.strictEqual(expiredEval.expired, true);
            assert.strictEqual(expiredEval.suppressTrackUpdate, false);
            assert.strictEqual(expiredEval.nextPending, null);
        });
    });

    describe('PlaybackConvergenceController', () => {
        it('polls with backoff until state converges and stops early without running remaining retries', async () => {
            const controller = new PlaybackConvergenceController();
            const responses = [
                makePlaybackState({ uri: 'spotify:track:old' }),
                makePlaybackState({ uri: 'spotify:track:target' }),
                makePlaybackState({ uri: 'spotify:track:target' }),
            ];
            let callCount = 0;

            const converged = await controller.syncUntilConverged(
                { expectedTrackUri: 'spotify:track:target' },
                async () => {
                    const state = responses[callCount++] ?? responses[responses.length - 1];
                    controller.inspectState(state);
                    return state;
                },
                { backoffMs: [10, 20, 40, 80], ttlMs: 1000 }
            );

            assert.strictEqual(converged, true);
            // Converged on 2nd poll, so 3rd and 4th backoff polls were skipped!
            assert.strictEqual(callCount, 2);
            assert.strictEqual(controller.getPendingTransition(), null);
        });

        it('returns false when TTL expires before playback state converges', async () => {
            const controller = new PlaybackConvergenceController();
            const converged = await controller.syncUntilConverged(
                { expectedTrackUri: 'spotify:track:never_arrives' },
                async () => {
                    const stale = makePlaybackState({ uri: 'spotify:track:old' });
                    controller.inspectState(stale);
                    return stale;
                },
                { backoffMs: [15, 25], ttlMs: 10 }
            );

            assert.strictEqual(converged, false);
            assert.strictEqual(controller.getPendingTransition(), null);
        });

        it('cancels earlier convergence loop when superseded by a newer transition', async () => {
            const controller = new PlaybackConvergenceController();
            let firstLoopCalls = 0;
            let secondLoopCalls = 0;

            const p1 = controller.syncUntilConverged(
                { expectedTrackUri: 'spotify:track:first' },
                async () => {
                    firstLoopCalls++;
                    return makePlaybackState({ uri: 'spotify:track:old' });
                },
                { backoffMs: [40, 80] }
            );

            // Immediately supersede with a second transition before first timer fires
            const p2 = controller.syncUntilConverged(
                { expectedTrackUri: 'spotify:track:second' },
                async () => {
                    secondLoopCalls++;
                    const state = makePlaybackState({ uri: 'spotify:track:second' });
                    controller.inspectState(state);
                    return state;
                },
                { backoffMs: [10, 20] }
            );

            const [res1, res2] = await Promise.all([p1, p2]);
            assert.strictEqual(res1, false);
            assert.strictEqual(res2, true);
            assert.strictEqual(firstLoopCalls, 0);
            assert.strictEqual(secondLoopCalls, 1);
        });

        it('keeps total CONVERGENCE_BACKOFF_MS longer than STARTUP_GRACE_MS so empty-swing playback reconciles against real server state instead of synthetic __optimisticFallback', async () => {
            const totalBackoffMs = PLAYBACK_CONSTANTS.CONVERGENCE_BACKOFF_MS.reduce((acc, ms) => acc + ms, 0);
            assert.ok(
                totalBackoffMs > PLAYBACK_CONSTANTS.STARTUP_GRACE_MS,
                `Expected total convergence backoff (${totalBackoffMs}ms) > STARTUP_GRACE_MS (${PLAYBACK_CONSTANTS.STARTUP_GRACE_MS}ms)`
            );
            assert.ok(
                totalBackoffMs < PLAYBACK_CONSTANTS.TRANSITION_GUARD_TTL_MS,
                `Expected total convergence backoff (${totalBackoffMs}ms) < TRANSITION_GUARD_TTL_MS (${PLAYBACK_CONSTANTS.TRANSITION_GUARD_TTL_MS}ms)`
            );

            // Simulate empty-swing startup: first 3 polls fall inside STARTUP_GRACE_MS (__optimisticFallback),
            // final polls after STARTUP_GRACE_MS return real paused state (is_playing: false).
            const controller = new PlaybackConvergenceController();
            const pollStates = [
                makePlaybackState({ uri: 'spotify:track:dj1', isPlaying: true, optimisticFallback: true }),
                makePlaybackState({ uri: 'spotify:track:dj1', isPlaying: true, optimisticFallback: true }),
                makePlaybackState({ uri: 'spotify:track:old_song', isPlaying: false, optimisticFallback: false }),
            ];
            let idx = 0;
            let lastObservedReconciledPlayState: boolean | null = null;

            const converged = await controller.syncUntilConverged(
                { expectedTrackUri: 'spotify:track:dj1', expectedIsPlaying: true },
                async () => {
                    const st = pollStates[Math.min(idx++, pollStates.length - 1)];
                    const guard = controller.inspectState(st);
                    if (!guard.suppressPlayStateUpdate) {
                        lastObservedReconciledPlayState = st.is_playing;
                    }
                    return st;
                },
                { backoffMs: [5, 10, 15], ttlMs: 100 }
            );

            assert.strictEqual(converged, false);
            assert.strictEqual(controller.getPendingTransition(), null);
            // Exhaustion reconciliation inside syncUntilConverged read real server state (is_playing: false) instead of synthetic true!
            assert.strictEqual(lastObservedReconciledPlayState, false);
        });
    });
});
