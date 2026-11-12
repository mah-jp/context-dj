import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import SpotifyWebApi from 'spotify-web-api-js';
import {
    SpotifyPlayerClient,
    classifySpotifyError,
    isMobileBrowserEnvironment,
    selectTargetSpotifyDevice,
    shouldSuppressBackgroundKeepAlive,
} from '../src/lib/spotify-player-client';
import { SpotifyApiErrorInfo } from '../src/lib/types';

describe('SpotifyPlayerClient', () => {
    let originalFetch: typeof globalThis.fetch;
    let fetchCalls: { url: string; init?: RequestInit }[] = [];

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        fetchCalls = [];
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            fetchCalls.push({ url: String(input), init });
            return {
                ok: true,
                status: 204,
                statusText: 'No Content',
                text: async () => '',
            } as Response;
        }) as typeof fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('resolves active device from Spotify devices list', async () => {
        const fakeSpotify = {
            getAccessToken: () => 'token_123',
            getMyDevices: async () => ({
                devices: [
                    { id: 'dev_inactive', name: 'Desktop', type: 'Computer', is_active: false },
                    { id: 'dev_active', name: 'Phone', type: 'Smartphone', is_active: true },
                ],
            }),
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;

        const client = new SpotifyPlayerClient(fakeSpotify);
        const deviceId = await client.resolveTargetDevice();

        assert.strictEqual(deviceId, 'dev_active');
        assert.strictEqual(client.getActiveDeviceId(), 'dev_active');
    });

    it('sends 204-safe transport commands with Authorization header', async () => {
        const fakeSpotify = {
            getAccessToken: () => 'token_abc',
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;

        const client = new SpotifyPlayerClient(fakeSpotify);
        const nextRes = await client.next();
        const pauseRes = await client.pause();
        const queueRes = await client.addToQueue('spotify:track:123');

        assert.strictEqual(nextRes.ok, true);
        assert.strictEqual(pauseRes.ok, true);
        assert.strictEqual(queueRes.ok, true);
        assert.strictEqual(fetchCalls.length, 3);
        assert.strictEqual(fetchCalls[0].url, 'https://api.spotify.com/v1/me/player/next');
        assert.strictEqual(fetchCalls[0].init?.method, 'POST');
        assert.strictEqual(fetchCalls[1].url, 'https://api.spotify.com/v1/me/player/pause');
        assert.strictEqual(fetchCalls[1].init?.method, 'PUT');
        assert.strictEqual(
            fetchCalls[2].url,
            'https://api.spotify.com/v1/me/player/queue?uri=spotify%3Atrack%3A123'
        );
    });

    it('fetches typed user queue via getUserQueue and filters out non-track items', async () => {
        const fakeSpotify = {
            getGeneric: async (url: string) => {
                assert.strictEqual(url, 'https://api.spotify.com/v1/me/player/queue');
                return {
                    currently_playing: { id: 'curr1', uri: 'spotify:track:curr1', name: 'Current Song', type: 'track' },
                    queue: [
                        { id: 't1', uri: 'spotify:track:t1', name: 'Queue Song 1', type: 'track' },
                        { id: 'ep1', uri: 'spotify:episode:ep1', name: 'Podcast Episode', type: 'episode' },
                        { id: 't2', uri: 'spotify:track:t2', name: 'Queue Song 2', type: 'track' },
                    ],
                };
            },
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;

        const client = new SpotifyPlayerClient(fakeSpotify);
        const res = await client.getUserQueue();

        assert.strictEqual(res.currently_playing?.id, 'curr1');
        assert.strictEqual(res.queue.length, 2);
        assert.deepStrictEqual(res.queue.map(t => t.id), ['t1', 't2']);
    });

    it('classifies 401, 403, 404, and 429 Spotify API errors and propagates them via onError callback', async () => {
        const fakeSpotify = {
            getAccessToken: () => 'token_abc',
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;

        const capturedErrors: SpotifyApiErrorInfo[] = [];
        const client = new SpotifyPlayerClient(fakeSpotify, (err) => {
            capturedErrors.push(err);
        });

        const statuses = [
            { status: 401, statusText: 'Unauthorized', retryAfter: null },
            { status: 403, statusText: 'Forbidden', retryAfter: null },
            { status: 404, statusText: 'Not Found', retryAfter: null },
            { status: 429, statusText: 'Too Many Requests', retryAfter: '12' },
        ];
        let callIdx = 0;

        globalThis.fetch = (async () => {
            const current = statuses[callIdx++];
            return {
                ok: false,
                status: current.status,
                statusText: current.statusText,
                headers: {
                    get: (name: string) => (name.toLowerCase() === 'retry-after' ? current.retryAfter : null),
                },
                text: async () => current.statusText,
            } as unknown as Response;
        }) as typeof fetch;

        const r401 = await client.next();
        const r403 = await client.pause();
        const r404 = await client.setActiveDevice('dev_missing');
        const r429 = await client.addToQueue('spotify:track:999');

        assert.strictEqual(r401.ok, false);
        assert.strictEqual(r401.error?.category, 'auth_expired');
        assert.strictEqual(r403.ok, false);
        assert.strictEqual(r403.error?.category, 'forbidden');
        assert.strictEqual(r404.ok, false);
        assert.strictEqual(r404.error?.category, 'device_not_found');
        assert.strictEqual(r429.ok, false);
        assert.strictEqual(r429.error?.category, 'rate_limited');
        assert.strictEqual(r429.error?.retryAfterSeconds, 12);

        assert.strictEqual(capturedErrors.length, 4);
        assert.ok(capturedErrors[0].message.includes('401'));
        assert.ok(capturedErrors[1].message.includes('403'));
        assert.ok(capturedErrors[2].message.includes('404'));
        assert.ok(capturedErrors[3].message.includes('429'));
        assert.ok(capturedErrors[3].message.includes('12s'));

        const directClassified = classifySpotifyError(500, 'play', null, 'Internal Server Error');
        assert.strictEqual(directClassified.category, 'network_or_server');
    });

    it('rolls back activeDeviceId when setActiveDevice transfer request fails', async () => {
        const fakeSpotify = {
            getAccessToken: () => 'token_abc',
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;

        const client = new SpotifyPlayerClient(fakeSpotify);
        const firstTransfer = await client.setActiveDevice('dev_initial');
        assert.strictEqual(firstTransfer.ok, true);
        assert.strictEqual(client.getActiveDeviceId(), 'dev_initial');

        globalThis.fetch = (async () => ({
            ok: false,
            status: 404,
            statusText: 'Not Found',
            headers: { get: () => null },
            text: async () => 'Device not found',
        } as unknown as Response)) as typeof fetch;

        const failedTransfer = await client.setActiveDevice('dev_broken');
        assert.strictEqual(failedTransfer.ok, false);
        assert.strictEqual(client.getActiveDeviceId(), 'dev_initial');
    });

    it('classifies and reports thrown 401/429 errors from spotify-web-api-js in getDevices and getUserQueue', async () => {
        const fakeSpotify = {
            getAccessToken: () => 'token_abc',
            getMyDevices: async () => {
                throw { status: 401, responseText: '{"error":{"status":401,"message":"The access token expired"}}' };
            },
            getGeneric: async () => {
                throw {
                    status: 429,
                    getResponseHeader: (h: string) => (h.toLowerCase() === 'retry-after' ? '7' : null),
                    responseText: 'Rate limit exceeded',
                };
            },
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;

        const captured: SpotifyApiErrorInfo[] = [];
        const client = new SpotifyPlayerClient(fakeSpotify, (err) => captured.push(err));

        const devices = await client.getDevices();
        assert.deepStrictEqual(devices, []);
        assert.strictEqual(captured.length, 1);
        assert.strictEqual(captured[0].category, 'auth_expired');
        assert.strictEqual(captured[0].status, 401);

        const queue = await client.getUserQueue();
        assert.deepStrictEqual(queue, { currently_playing: null, queue: [] });
        assert.strictEqual(captured.length, 2);
        assert.strictEqual(captured[1].category, 'rate_limited');
        assert.strictEqual(captured[1].retryAfterSeconds, 7);
    });

    it('re-resolves target device when cached activeDeviceId goes offline or becomes inactive while another device is active', async () => {
        let currentDevices: SpotifyApi.UserDevice[] = [
            { id: 'dev_old', name: 'Old Laptop', type: 'Computer', is_active: true } as SpotifyApi.UserDevice,
        ];
        const fakeSpotify = {
            getAccessToken: () => 'token_123',
            getMyDevices: async () => ({ devices: currentDevices }),
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;

        const client = new SpotifyPlayerClient(fakeSpotify);
        const firstResolved = await client.resolveTargetDevice();
        assert.strictEqual(firstResolved, 'dev_old');

        // Now dev_old disconnects and dev_phone is available
        currentDevices = [
            { id: 'dev_phone', name: 'Smartphone', type: 'Smartphone', is_active: false } as SpotifyApi.UserDevice,
        ];
        const secondResolved = await client.resolveTargetDevice();
        assert.strictEqual(secondResolved, 'dev_phone');
        assert.strictEqual(client.getActiveDeviceId(), 'dev_phone');
    });

    it('sends clean { uris } payload without offset or pre/post-play shuffle/repeat spam on active device', async () => {
        const fakeSpotify = {
            getAccessToken: () => 'token_clean',
            getMyDevices: async () => ({
                devices: [
                    { id: 'phone_1', name: 'iPhone', type: 'Smartphone', is_active: true, is_restricted: false },
                ],
            }),
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;

        const client = new SpotifyPlayerClient(fakeSpotify, undefined, {
            isMobile: () => true,
            transferSettleDelayMs: 0,
            retryDelayMs: 0,
        });
        const resolved = await client.resolveTargetDevice();
        assert.strictEqual(resolved, 'phone_1');

        await client.startPlaybackOnDevice(resolved, ['spotify:track:dj1', 'spotify:track:dj2']);
        // Wait >500ms equivalent to ensure no delayed timer fires shuffle/repeat
        await new Promise((r) => setTimeout(r, 20));

        assert.strictEqual(fetchCalls.length, 1);
        assert.strictEqual(fetchCalls[0].url, 'https://api.spotify.com/v1/me/player/play?device_id=phone_1');
        assert.strictEqual(fetchCalls[0].init?.method, 'PUT');
        const parsedBody = JSON.parse(String(fetchCalls[0].init?.body));
        assert.deepStrictEqual(parsedBody, { uris: ['spotify:track:dj1', 'spotify:track:dj2'] });
        assert.strictEqual('offset' in parsedBody, false);
    });

    it('pre-transfers quietly (play: false) before starting { uris } when mobile Smartphone device is inactive', async () => {
        const fakeSpotify = {
            getAccessToken: () => 'token_mobile',
            getMyDevices: async () => ({
                devices: [
                    { id: 'pc_1', name: 'MacBook', type: 'Computer', is_active: true, is_restricted: false },
                    { id: 'phone_1', name: 'Pixel', type: 'Smartphone', is_active: false, is_restricted: false },
                ],
            }),
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;

        const client = new SpotifyPlayerClient(fakeSpotify, undefined, {
            isMobile: () => true,
            transferSettleDelayMs: 0,
            retryDelayMs: 0,
        });

        // Mobile browser prioritizes unrestricted Smartphone even when Computer was active
        const targetId = await client.resolveTargetDevice();
        assert.strictEqual(targetId, 'phone_1');

        await client.startPlaybackOnDevice(targetId, ['spotify:track:dj1']);

        assert.strictEqual(fetchCalls.length, 2);
        // 1. Quiet pre-transfer with play: false
        assert.strictEqual(fetchCalls[0].url, 'https://api.spotify.com/v1/me/player');
        assert.deepStrictEqual(JSON.parse(String(fetchCalls[0].init?.body)), {
            device_ids: ['phone_1'],
            play: false,
        });
        // 2. Clean play { uris }
        assert.strictEqual(fetchCalls[1].url, 'https://api.spotify.com/v1/me/player/play?device_id=phone_1');
        assert.deepStrictEqual(JSON.parse(String(fetchCalls[1].init?.body)), {
            uris: ['spotify:track:dj1'],
        });
    });

    it('retries once on transient 404/502 with device refresh and falls back to unrestricted device on 403 without retrying 401/429', async () => {
        let devicesList: SpotifyApi.UserDevice[] = [
            { id: 'phone_stale', name: 'iPhone', type: 'Smartphone', is_active: true, is_restricted: false } as SpotifyApi.UserDevice,
        ];
        const fakeSpotify = {
            getAccessToken: () => 'token_retry',
            getMyDevices: async () => ({ devices: devicesList }),
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;

        const errors: SpotifyApiErrorInfo[] = [];
        const client = new SpotifyPlayerClient(fakeSpotify, (e) => errors.push(e), {
            isMobile: () => true,
            transferSettleDelayMs: 0,
            retryDelayMs: 0,
        });

        // Case 1: Initial play gets 404 (device went to sleep), refresh finds woken phone_woken -> succeeds without error notification!
        let playCall = 0;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            fetchCalls.push({ url, init });
            if (url.includes('/player/play')) {
                playCall++;
                if (playCall === 1) {
                    devicesList = [
                        { id: 'phone_woken', name: 'iPhone', type: 'Smartphone', is_active: false, is_restricted: false } as SpotifyApi.UserDevice,
                    ];
                    return { ok: false, status: 404, statusText: 'Not Found', headers: { get: () => null }, text: async () => 'Not found' } as unknown as Response;
                }
            }
            return { ok: true, status: 204, statusText: 'No Content', text: async () => '' } as Response;
        }) as typeof fetch;

        await client.startPlaybackOnDevice('phone_stale', ['spotify:track:dj1']);
        assert.strictEqual(playCall, 2);
        assert.strictEqual(client.getActiveDeviceId(), 'phone_woken');
        assert.strictEqual(errors.length, 0);

        // Case 2: 403 on restricted/locked device falls back ONLY when another unrestricted device exists
        fetchCalls = [];
        playCall = 0;
        devicesList = [
            { id: 'restricted_1', name: 'Restricted Speaker', type: 'Speaker', is_active: true, is_restricted: true } as SpotifyApi.UserDevice,
            { id: 'phone_ok', name: 'iPhone', type: 'Smartphone', is_active: false, is_restricted: false } as SpotifyApi.UserDevice,
        ];
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            fetchCalls.push({ url, init });
            if (url.includes('/player/play')) {
                playCall++;
                if (url.includes('restricted_1')) {
                    return { ok: false, status: 403, statusText: 'Forbidden', headers: { get: () => null }, text: async () => 'Restricted' } as unknown as Response;
                }
            }
            return { ok: true, status: 204, statusText: 'No Content', text: async () => '' } as Response;
        }) as typeof fetch;

        await client.startPlaybackOnDevice('restricted_1', ['spotify:track:dj1']);
        assert.strictEqual(playCall, 2);
        assert.strictEqual(client.getActiveDeviceId(), 'phone_ok');

        // Case 3: 429 rate limit is NOT retried
        fetchCalls = [];
        playCall = 0;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            fetchCalls.push({ url: String(input), init });
            playCall++;
            return {
                ok: false,
                status: 429,
                statusText: 'Too Many Requests',
                headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? '5' : null) },
                text: async () => 'Rate limited',
            } as unknown as Response;
        }) as typeof fetch;

        await assert.rejects(() => client.startPlaybackOnDevice('phone_ok', ['spotify:track:dj1']), /429/);
        assert.strictEqual(playCall, 1);
    });

    it('ensurePlaybackModes disables shuffle and repeat ONLY after convergence when enabled on an active unrestricted device', async () => {
        const fakeSpotify = {
            getAccessToken: () => 'token_modes',
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;
        const client = new SpotifyPlayerClient(fakeSpotify);

        // 1. Paused or restricted or already normalized -> 0 API calls
        await client.ensurePlaybackModes(null);
        await client.ensurePlaybackModes({
            is_playing: false,
            shuffle_state: true,
            repeat_state: 'context',
            device: { id: 'd1', is_active: true, is_restricted: false } as SpotifyApi.UserDevice,
        });
        await client.ensurePlaybackModes({
            is_playing: true,
            shuffle_state: true,
            repeat_state: 'track',
            device: { id: 'd1', is_active: true, is_restricted: true } as SpotifyApi.UserDevice,
        });
        await client.ensurePlaybackModes({
            is_playing: true,
            shuffle_state: false,
            repeat_state: 'off',
            device: { id: 'd1', is_active: true, is_restricted: false } as SpotifyApi.UserDevice,
        });
        assert.strictEqual(fetchCalls.length, 0);

        // 2. Only shuffle is true -> sends ONLY shuffle=false
        await client.ensurePlaybackModes({
            is_playing: true,
            shuffle_state: true,
            repeat_state: 'off',
            device: { id: 'phone_1', is_active: true, is_restricted: false } as SpotifyApi.UserDevice,
        });
        assert.strictEqual(fetchCalls.length, 1);
        assert.strictEqual(fetchCalls[0].url, 'https://api.spotify.com/v1/me/player/shuffle?state=false&device_id=phone_1');

        // 3. Both shuffle and repeat are active -> disables both
        fetchCalls = [];
        await client.ensurePlaybackModes({
            is_playing: true,
            shuffle_state: true,
            repeat_state: 'track',
            device: { id: 'phone_1', is_active: true, is_restricted: false } as SpotifyApi.UserDevice,
        });
        assert.strictEqual(fetchCalls.length, 2);
        assert.strictEqual(fetchCalls[0].url, 'https://api.spotify.com/v1/me/player/shuffle?state=false&device_id=phone_1');
        assert.strictEqual(fetchCalls[1].url, 'https://api.spotify.com/v1/me/player/repeat?state=off&device_id=phone_1');
    });

    it('correctly detects mobile browsers, prioritizes unrestricted Smartphone unless user explicitly selected preferredDeviceId, and suppresses mobile Keep-Alive', async () => {
        // 1. Mobile browser environment detection matrix
        assert.strictEqual(isMobileBrowserEnvironment(null), false);
        assert.strictEqual(
            isMobileBrowserEnvironment({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15', maxTouchPoints: 5 }),
            true
        );
        assert.strictEqual(
            isMobileBrowserEnvironment({ userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36', maxTouchPoints: 5 }),
            true
        );
        // iPadOS desktop-class UA
        assert.strictEqual(
            isMobileBrowserEnvironment({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', maxTouchPoints: 5 }),
            true
        );
        // Real macOS desktop
        assert.strictEqual(
            isMobileBrowserEnvironment({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0', maxTouchPoints: 0 }),
            false
        );

        // 2. Device selection respects !is_restricted and explicit preferredDeviceId override
        const devices = [
            { id: 'speaker_restricted', name: 'Locked Cast', type: 'CastAudio', is_active: true, is_restricted: true },
            { id: 'pc_1', name: 'Office PC', type: 'Computer', is_active: true, is_restricted: false },
            { id: 'phone_1', name: 'My iPhone', type: 'Smartphone', is_active: false, is_restricted: false },
            { id: 'speaker_1', name: 'Kitchen Speaker', type: 'Speaker', is_active: false, is_restricted: false },
        ] as SpotifyApi.UserDevice[];

        // Default on mobile: picks phone_1 (ignoring restricted & overriding active Computer)
        assert.strictEqual(selectTargetSpotifyDevice(devices, { isMobile: true })?.id, 'phone_1');
        // Default on desktop: picks active unrestricted pc_1 (skipping restricted speaker_restricted)
        assert.strictEqual(selectTargetSpotifyDevice(devices, { isMobile: false })?.id, 'pc_1');
        // Explicit user selection on mobile (e.g. user tapped Kitchen Speaker in Device Selector): honors speaker_1!
        assert.strictEqual(
            selectTargetSpotifyDevice(devices, { isMobile: true, preferredDeviceId: 'speaker_1' })?.id,
            'speaker_1'
        );

        // 3. Keep-Alive suppression matrix
        assert.strictEqual(shouldSuppressBackgroundKeepAlive({ isMobile: false, devices }), false);
        assert.strictEqual(shouldSuppressBackgroundKeepAlive({ isMobile: true, devices: [] }), true);
        assert.strictEqual(shouldSuppressBackgroundKeepAlive({ isMobile: true, devices }), true);
        assert.strictEqual(
            shouldSuppressBackgroundKeepAlive({ isMobile: true, devices, preferredDeviceId: 'speaker_1' }),
            false
        );
        assert.strictEqual(
            shouldSuppressBackgroundKeepAlive({ isMobile: true, devices, preferredDeviceId: 'phone_1' }),
            true
        );

        // 4. Never selects restricted-only device pools; resolveTargetDevice polls until unrestricted Smartphone wakes up
        const onlyRestricted = [
            { id: 'sonos_locked', name: 'Locked Sonos', type: 'Speaker', is_active: true, is_restricted: true },
        ] as SpotifyApi.UserDevice[];
        assert.strictEqual(selectTargetSpotifyDevice(onlyRestricted, { isMobile: true }), null);

        let pollAttempt = 0;
        const wakingSpotify = {
            getAccessToken: () => 'token_wake',
            getMyDevices: async () => {
                pollAttempt++;
                if (pollAttempt === 1) {
                    return { devices: onlyRestricted };
                }
                return {
                    devices: [
                        ...onlyRestricted,
                        { id: 'phone_awake', name: 'iPhone', type: 'Smartphone', is_active: false, is_restricted: false },
                    ] as SpotifyApi.UserDevice[],
                };
            },
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;
        const wakingClient = new SpotifyPlayerClient(wakingSpotify, undefined, {
            isMobile: () => true,
            devicePollDelayMs: 0,
        });
        const resolvedAfterWake = await wakingClient.resolveTargetDevice();
        assert.strictEqual(pollAttempt, 2);
        assert.strictEqual(resolvedAfterWake, 'phone_awake');
    });
});
