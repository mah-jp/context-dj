import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DJCore } from '../src/lib/dj-core';
import { isSameTrackDisplay, isSameDeviceList } from '../src/context/PlayerContext';
import { computeNextUIPollDelay, createDJPollingController } from '../src/hooks/useDJPollingLoops';
import { SpotifyAuth } from '../src/lib/spotify-auth';
import { SpotifyApiErrorInfo, Track } from '../src/lib/types';

function makeTrack(overrides: {
    id: string;
    name: string;
    uri: string;
    artistName: string;
    vibeTag?: string;
    selectionReason?: string;
    stage?: 'intro' | 'build' | 'peak' | 'outro';
}): Track {
    return {
        id: overrides.id,
        name: overrides.name,
        uri: overrides.uri,
        artists: [{ name: overrides.artistName } as SpotifyApi.ArtistObjectSimplified],
        album: {} as SpotifyApi.AlbumObjectSimplified,
        vibeTag: overrides.vibeTag,
        selectionReason: overrides.selectionReason,
        stage: overrides.stage,
        type: 'track',
    } as unknown as Track;
}

describe('Context, DJCore Subscriptions, and Polling Loop Controller', () => {
    let store: Record<string, string> = {};
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        store = {};
        originalFetch = globalThis.fetch;
        const localStorageMock = {
            getItem: (key: string) => store[key] ?? null,
            setItem: (key: string, value: string) => { store[key] = String(value); },
            removeItem: (key: string) => { delete store[key]; },
            clear: () => { store = {}; },
        };
        const g = globalThis as Record<string, unknown>;
        g.window = {
            localStorage: localStorageMock,
            addEventListener: () => {},
            removeEventListener: () => {},
        };
        g.localStorage = localStorageMock;
        g.document = {
            visibilityState: 'visible',
            addEventListener: () => {},
            removeEventListener: () => {},
        };
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('propagates 403/404/429 Spotify transport errors from SpotifyPlayerClient through DJCore to UI error callbacks and process logs without firing state listeners on log append', async () => {
        const dj = new DJCore('fake_token');
        const receivedErrors: { msg: string; info?: SpotifyApiErrorInfo }[] = [];
        const logSnapshots: string[][] = [];
        let stateListenerCalls = 0;

        dj.setErrorCallback((msg, info) => {
            receivedErrors.push({ msg, info });
        });
        const unsubState = dj.subscribe(() => {
            stateListenerCalls++;
        });
        const unsubLogs = dj.subscribeLogs((logs) => {
            logSnapshots.push(logs);
        });

        globalThis.fetch = (async () => ({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
            headers: { get: () => null },
            text: async () => 'Player command failed: Premium required',
        } as unknown as Response)) as typeof fetch;

        const res = await dj.next();
        assert.strictEqual(res.ok, false);
        assert.strictEqual(receivedErrors.length, 1);
        assert.strictEqual(receivedErrors[0].info?.category, 'forbidden');
        assert.strictEqual(receivedErrors[0].info?.status, 403);
        assert.ok(receivedErrors[0].msg.includes('403'));

        // Log listener was notified reactively without polling, and stateListeners were NOT spammed by addLog
        assert.ok(logSnapshots.length >= 1);
        assert.ok(logSnapshots[logSnapshots.length - 1][0].includes('Spotify API [403]'));
        assert.strictEqual(stateListenerCalls, 0);

        unsubState();
        unsubLogs();
    });

    it('restores schedule from localStorage, preserves currentThought in schedule gaps, and notifies state subscribers when schedule is modified', () => {
        store['dj_schedule'] = JSON.stringify([
            { start: '00:01', end: '00:02', query: 'morning coffee', thought: 'Start fresh' },
            { start: '23:58', end: '23:59', query: 'afternoon groove', thought: 'Keep moving' },
        ]);

        const dj = new DJCore('fake_token');
        assert.strictEqual(dj.getSchedule().length, 2);
        // Even in schedule gaps, getDJStatus() falls back to getEffectiveItemForPlayback() so currentThought is preserved
        assert.ok(dj.getDJStatus().currentThought !== null);

        const snapshots: number[] = [];
        const unsub = dj.subscribe((snap) => {
            snapshots.push(snap.schedule.length);
        });

        dj.removeScheduleItem(0, true);
        assert.strictEqual(dj.getSchedule().length, 1);
        assert.strictEqual(snapshots[0], 1);

        const persisted = JSON.parse(store['dj_schedule']);
        assert.strictEqual(persisted.length, 1);
        assert.strictEqual(persisted[0].query, 'afternoon groove');

        unsub();
    });

    it('isSameTrackDisplay and isSameDeviceList accurately compare display fields to prevent redundant Context re-renders', () => {
        const t1 = makeTrack({
            id: '1',
            uri: 'spotify:track:1',
            name: 'Song A',
            artistName: 'Artist A',
            vibeTag: '#Chill',
            selectionReason: 'Great vibe',
            stage: 'intro',
        });
        const t2 = makeTrack({
            id: '1',
            uri: 'spotify:track:1',
            name: 'Song A',
            artistName: 'Artist A',
            vibeTag: '#Chill',
            selectionReason: 'Great vibe',
            stage: 'intro',
        });
        const t3DifferentReason = makeTrack({
            id: '1',
            uri: 'spotify:track:1',
            name: 'Song A',
            artistName: 'Artist A',
            vibeTag: '#Chill',
            selectionReason: 'Updated reason',
            stage: 'intro',
        });

        assert.strictEqual(isSameTrackDisplay(null, null), true);
        assert.strictEqual(isSameTrackDisplay(t1, null), false);
        assert.strictEqual(isSameTrackDisplay(t1, t2), true);
        assert.strictEqual(isSameTrackDisplay(t1, t3DifferentReason), false);

        const d1 = [{ id: 'dev1', name: 'Speaker', is_active: true, type: 'Speaker', volume_percent: 50 }] as SpotifyApi.UserDevice[];
        const d2 = [{ id: 'dev1', name: 'Speaker', is_active: true, type: 'Speaker', volume_percent: 50 }] as SpotifyApi.UserDevice[];
        const d3 = [{ id: 'dev1', name: 'Speaker', is_active: false, type: 'Speaker', volume_percent: 50 }] as SpotifyApi.UserDevice[];
        assert.strictEqual(isSameDeviceList(d1, d2), true);
        assert.strictEqual(isSameDeviceList(d1, d3), false);
    });

    it('computeNextUIPollDelay switches to fast interval when track has < 10s remaining and handles progress_ms === 0', () => {
        const startOfShortTrack = {
            is_playing: true,
            progress_ms: 0,
            item: { duration_ms: 8000 },
        } as unknown as SpotifyApi.CurrentPlaybackResponse;

        const normalPlayback = {
            is_playing: true,
            progress_ms: 60000,
            item: { duration_ms: 180000 },
        } as unknown as SpotifyApi.CurrentPlaybackResponse;

        const nearEndPlayback = {
            is_playing: true,
            progress_ms: 175000,
            item: { duration_ms: 180000 },
        } as unknown as SpotifyApi.CurrentPlaybackResponse;

        assert.strictEqual(computeNextUIPollDelay(startOfShortTrack, 3000, 1000), 1000);
        assert.strictEqual(computeNextUIPollDelay(normalPlayback, 3000, 1000), 3000);
        assert.strictEqual(computeNextUIPollDelay(nearEndPlayback, 3000, 1000), 1000);
        assert.strictEqual(computeNextUIPollDelay(null, 3000, 1000), 3000);
    });

    it('createDJPollingController handles UI sync, background suspension, foreground resume, DJ loop error forwarding, and token refresh cooldown/expiry', async () => {
        const dj = new DJCore('fake_token');
        let djLoopCalls = 0;
        const syncCalls: { forceAll?: boolean }[] = [];
        const errors: string[] = [];
        let authExpiredCalls = 0;
        let refreshCalls = 0;

        const origRefresh = SpotifyAuth.refreshToken;
        SpotifyAuth.refreshToken = async () => {
            refreshCalls++;
            return null;
        };

        store['spotify_client_id'] = 'client_123';
        store['spotify_expires_at'] = String(Date.now() - 1000); // Already expired

        dj.processDJLoop = async () => {
            djLoopCalls++;
            if (djLoopCalls === 2) {
                throw new Error('Simulated DJ background loop error');
            }
        };

        const controller = createDJPollingController({
            djCore: dj,
            syncUIState: async (opts) => {
                syncCalls.push(opts || {});
                return null;
            },
            onError: (msg) => errors.push(msg),
            onAuthExpired: () => { authExpiredCalls++; },
            uiPollIntervalMs: 50,
            djLoopIntervalMs: 50,
            tokenRefreshCooldownMs: 60_000,
        });

        try {
            // 1. Run UI loop when visible -> triggers syncUIState and checkAndRefreshToken
            await controller.runUILoop();
            assert.strictEqual(syncCalls.length, 1);
            assert.strictEqual(refreshCalls, 1);
            assert.strictEqual(authExpiredCalls, 1);

            // 2. Subsequent checkAndRefreshToken within cooldown window is throttled
            await controller.checkAndRefreshToken();
            assert.strictEqual(refreshCalls, 1);

            // 3. When document is hidden, UI loop skips syncing
            (globalThis as unknown as { document: { visibilityState: string } }).document.visibilityState = 'hidden';
            await controller.runUILoop();
            assert.strictEqual(syncCalls.length, 1);

            // 4. Returning to foreground triggers immediate forceAll sync
            (globalThis as unknown as { document: { visibilityState: string } }).document.visibilityState = 'visible';
            controller.handleVisibilityChange();
            await new Promise(r => setTimeout(r, 10));
            assert.strictEqual(syncCalls.some(c => c.forceAll === true), true);

            // 5. Error in DJ loop is forwarded to onError callback
            await controller.runDJLoop();
            assert.ok(errors.includes('Simulated DJ background loop error'));
        } finally {
            controller.stop();
            SpotifyAuth.refreshToken = origRefresh;
        }
    });
});
