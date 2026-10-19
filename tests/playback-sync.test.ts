import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    isPlaybackStateConverged,
    evaluateTransitionGuard,
    PlaybackConvergenceController,
} from '../src/lib/playback-sync';

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

        it('rejects synthetic __optimisticFallback playback states as non-converged', () => {
            const syntheticState = makePlaybackState({
                uri: 'spotify:track:first',
                isPlaying: true,
                optimisticFallback: true,
            });
            assert.strictEqual(
                isPlaybackStateConverged(syntheticState, {
                    expectedTrackUri: 'spotify:track:first',
                    expectedIsPlaying: true,
                }),
                false
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
    });
});
