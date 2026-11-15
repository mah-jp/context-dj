import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import SpotifyWebApi from 'spotify-web-api-js';
import {
    SPOTIFY_ANDROID_WAKE_INTENT_URI,
    SpotifyPlayerClient,
    classifySpotifyError,
    hasActiveBrowserUserGesture,
    isMobileBrowserEnvironment,
    isMobileSpotifyDevice,
    isTargetTrackLoadedOnState,
    launchSpotifyAppUri,
    resolveSpotifyWakeUri,
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

    it('never sends play: false to inactive mobile Smartphone/Tablet (preserving Android ForegroundKeeperService) while still pre-transferring inactive Desktop/Speaker quietly', async () => {
        // 1. Mobile Smartphone (`is_active: false`) MUST NOT receive `PUT /v1/me/player { play: false }`!
        const fakeMobileSpotify = {
            getAccessToken: () => 'token_mobile',
            getMyDevices: async () => ({
                devices: [
                    { id: 'pc_1', name: 'MacBook', type: 'Computer', is_active: true, is_restricted: false },
                    { id: 'phone_1', name: 'Pixel', type: 'Smartphone', is_active: false, is_restricted: false },
                ],
            }),
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;

        const mobileClient = new SpotifyPlayerClient(fakeMobileSpotify, undefined, {
            isMobile: () => true,
            transferSettleDelayMs: 0,
            retryDelayMs: 0,
        });

        const mobileTargetId = await mobileClient.resolveTargetDevice();
        assert.strictEqual(mobileTargetId, 'phone_1');

        const mobileResult = await mobileClient.startPlaybackOnDevice(mobileTargetId, ['spotify:track:dj1']);
        assert.strictEqual(mobileResult.isMobileTarget, true);
        assert.strictEqual(fetchCalls.length, 1);
        assert.strictEqual(fetchCalls[0].url, 'https://api.spotify.com/v1/me/player/play?device_id=phone_1');
        assert.deepStrictEqual(JSON.parse(String(fetchCalls[0].init?.body)), {
            uris: ['spotify:track:dj1'],
        });

        // 2. Inactive non-mobile Computer/Speaker STILL receives quiet `play: false` pre-transfer before `{ uris }`
        fetchCalls = [];
        const fakeDesktopSpotify = {
            getAccessToken: () => 'token_desktop',
            getMyDevices: async () => ({
                devices: [
                    { id: 'speaker_1', name: 'Living Room Speaker', type: 'Speaker', is_active: false, is_restricted: false },
                ],
            }),
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;

        const desktopClient = new SpotifyPlayerClient(fakeDesktopSpotify, undefined, {
            isMobile: () => false,
            transferSettleDelayMs: 0,
            retryDelayMs: 0,
        });

        const desktopTargetId = await desktopClient.resolveTargetDevice();
        assert.strictEqual(desktopTargetId, 'speaker_1');

        const desktopResult = await desktopClient.startPlaybackOnDevice(desktopTargetId, ['spotify:track:dj1']);
        assert.strictEqual(desktopResult.isMobileTarget, false);
        assert.strictEqual(fetchCalls.length, 2);
        assert.strictEqual(fetchCalls[0].url, 'https://api.spotify.com/v1/me/player');
        assert.deepStrictEqual(JSON.parse(String(fetchCalls[0].init?.body)), {
            device_ids: ['speaker_1'],
            play: false,
        });
        assert.strictEqual(fetchCalls[1].url, 'https://api.spotify.com/v1/me/player/play?device_id=speaker_1');
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

    it('isTargetTrackLoadedOnState matches direct & relinked target URIs while rejecting external contexts or wrong devices', () => {
        const targetUris = ['spotify:track:take_on_me', 'spotify:track:every_woman'];

        assert.strictEqual(isTargetTrackLoadedOnState(null, targetUris, 'phone_1'), false);
        assert.strictEqual(isTargetTrackLoadedOnState(undefined, targetUris, 'phone_1'), false);

        // Direct match on expected device with context === null
        assert.strictEqual(
            isTargetTrackLoadedOnState(
                {
                    is_playing: false,
                    context: null,
                    device: { id: 'phone_1', is_active: true } as SpotifyApi.UserDevice,
                    item: { id: 'take_on_me', uri: 'spotify:track:take_on_me', type: 'track' } as SpotifyApi.TrackObjectFull,
                } as SpotifyApi.CurrentPlaybackResponse,
                targetUris,
                'phone_1'
            ),
            true
        );

        // Market-relinked track whose linked_from.uri matches uris[0]
        assert.strictEqual(
            isTargetTrackLoadedOnState(
                {
                    is_playing: false,
                    context: null,
                    device: { id: 'phone_1', is_active: true } as SpotifyApi.UserDevice,
                    item: {
                        id: 'relinked_jp',
                        uri: 'spotify:track:relinked_jp',
                        type: 'track',
                        linked_from: { uri: 'spotify:track:take_on_me' },
                    } as unknown as SpotifyApi.TrackObjectFull,
                } as SpotifyApi.CurrentPlaybackResponse,
                targetUris,
                'phone_1'
            ),
            true
        );

        // Rejects external playlist/album context even if same song URI is inside it
        assert.strictEqual(
            isTargetTrackLoadedOnState(
                {
                    is_playing: false,
                    context: { type: 'playlist', uri: 'spotify:playlist:80s_hits' } as SpotifyApi.ContextObject,
                    device: { id: 'phone_1', is_active: true } as SpotifyApi.UserDevice,
                    item: { id: 'take_on_me', uri: 'spotify:track:take_on_me', type: 'track' } as SpotifyApi.TrackObjectFull,
                } as SpotifyApi.CurrentPlaybackResponse,
                targetUris,
                'phone_1'
            ),
            false
        );

        // Rejects when loaded on a different device than expectedDeviceId
        assert.strictEqual(
            isTargetTrackLoadedOnState(
                {
                    is_playing: false,
                    context: null,
                    device: { id: 'pc_other', is_active: true } as SpotifyApi.UserDevice,
                    item: { id: 'take_on_me', uri: 'spotify:track:take_on_me', type: 'track' } as SpotifyApi.TrackObjectFull,
                } as SpotifyApi.CurrentPlaybackResponse,
                targetUris,
                'phone_1'
            ),
            false
        );
    });

    it('sends an empty-body resume kick when { uris } loads target track in paused state on mobile, and skips kick when already playing', async () => {
        let playbackState: SpotifyApi.CurrentPlaybackResponse | null = {
            is_playing: false,
            progress_ms: 0,
            context: null,
            device: { id: 'phone_1', name: 'Pixel', type: 'Smartphone', is_active: true, is_restricted: false } as SpotifyApi.UserDevice,
            item: { id: 'take_on_me', uri: 'spotify:track:take_on_me', type: 'track' } as SpotifyApi.TrackObjectFull,
        } as SpotifyApi.CurrentPlaybackResponse;

        const fakeSpotify = {
            getAccessToken: () => 'token_mobile',
            getMyCurrentPlaybackState: async () => playbackState,
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;

        const client = new SpotifyPlayerClient(fakeSpotify, undefined, {
            postPlayVerifyDelayMs: 0,
            retryDelayMs: 0,
        });

        await client.startPlaybackOnDevice('phone_1', ['spotify:track:take_on_me', 'spotify:track:every_woman']);

        // Call 1: PUT /me/player/play with { uris }
        // Call 2: PUT /me/player/play (empty body, no Content-Type) to kick-start paused mobile player
        assert.strictEqual(fetchCalls.length, 2);
        assert.strictEqual(fetchCalls[0].url, 'https://api.spotify.com/v1/me/player/play?device_id=phone_1');
        assert.deepStrictEqual(JSON.parse(String(fetchCalls[0].init?.body)), {
            uris: ['spotify:track:take_on_me', 'spotify:track:every_woman'],
        });
        assert.strictEqual(fetchCalls[1].url, 'https://api.spotify.com/v1/me/player/play?device_id=phone_1');
        assert.strictEqual(fetchCalls[1].init?.method, 'PUT');
        assert.strictEqual(fetchCalls[1].init?.body, undefined);
        assert.strictEqual((fetchCalls[1].init?.headers as Record<string, string>)?.['Content-Type'], undefined);

        // When Spotify already reports is_playing: true, no extra resume request is sent
        fetchCalls = [];
        playbackState = {
            ...playbackState,
            is_playing: true,
            progress_ms: 300,
        };
        await client.startPlaybackOnDevice('phone_1', ['spotify:track:take_on_me', 'spotify:track:every_woman']);
        assert.strictEqual(fetchCalls.length, 1);
    });

    it('waits an extra settle poll for waking inactive Smartphones without ever sending play:false, retries dropped { uris } cleanly, reclaims via play:true if another device holds Connect, and honors shouldAbort', async () => {
        // 1. Waking Smartphone (`wasInitiallyInactive === true`) surfaces Track 1 paused on 3rd check,
        //    then flips to `is_playing: true, progress_ms: 180` after empty-body resume kick!
        let stateCheckCount = 0;
        const fakeSpotify = {
            getAccessToken: () => 'token_wake_retry',
            getMyDevices: async () => ({
                devices: [
                    { id: 'phone_sleep', name: 'Android', type: 'Smartphone', is_active: false, is_restricted: false },
                ] as SpotifyApi.UserDevice[],
            }),
            getMyCurrentPlaybackState: async () => {
                stateCheckCount++;
                if (stateCheckCount <= 2) {
                    return null as unknown as SpotifyApi.CurrentPlaybackResponse;
                }
                return {
                    is_playing: stateCheckCount >= 4,
                    progress_ms: stateCheckCount >= 4 ? 180 : 0,
                    context: null,
                    device: { id: 'phone_sleep', name: 'Android', type: 'Smartphone', is_active: true, is_restricted: false } as SpotifyApi.UserDevice,
                    item: { id: 't1', uri: 'spotify:track:t1', type: 'track' } as SpotifyApi.TrackObjectFull,
                } as SpotifyApi.CurrentPlaybackResponse;
            },
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;

        const client = new SpotifyPlayerClient(fakeSpotify, undefined, {
            isMobile: () => true,
            transferSettleDelayMs: 0,
            postPlayVerifyDelayMs: 0,
            retryDelayMs: 0,
        });

        const resolvedId = await client.resolveTargetDevice();
        assert.strictEqual(resolvedId, 'phone_sleep');
        const wakeRes = await client.startPlaybackOnDevice(resolvedId, ['spotify:track:t1', 'spotify:track:t2']);

        // 0: initial play ({ uris }) — NO play:false pre-transfer!
        // 1: empty-body resume kick once 3rd check sees t1 loaded paused; 4th check confirms playing!
        assert.strictEqual(wakeRes.confirmedPlaying, true);
        assert.strictEqual(wakeRes.targetTrackLoaded, true);
        assert.strictEqual(stateCheckCount, 4);
        assert.strictEqual(fetchCalls.length, 2);
        assert.strictEqual(fetchCalls[0].url, 'https://api.spotify.com/v1/me/player/play?device_id=phone_sleep');
        assert.ok(fetchCalls[0].init?.body);
        assert.strictEqual(fetchCalls[1].url, 'https://api.spotify.com/v1/me/player/play?device_id=phone_sleep');
        assert.strictEqual(fetchCalls[1].init?.body, undefined);

        // 2. Waking Smartphone genuinely drops initial `{ uris }` across all 3 wake checks (`null` x 3):
        //    retries `{ uris }` + empty-body kick WITHOUT sending ANY `play: false` transfer!
        fetchCalls = [];
        let droppedCheckCount = 0;
        const droppedSpotify = {
            getAccessToken: () => 'token_dropped',
            getMyDevices: async () => ({
                devices: [
                    { id: 'phone_sleep', name: 'Android', type: 'Smartphone', is_active: false, is_restricted: false },
                ] as SpotifyApi.UserDevice[],
            }),
            getMyCurrentPlaybackState: async () => {
                droppedCheckCount++;
                if (droppedCheckCount <= 3) {
                    return null as unknown as SpotifyApi.CurrentPlaybackResponse;
                }
                return {
                    is_playing: droppedCheckCount >= 5,
                    progress_ms: droppedCheckCount >= 5 ? 210 : 0,
                    context: null,
                    device: { id: 'phone_sleep', name: 'Android', type: 'Smartphone', is_active: true, is_restricted: false } as SpotifyApi.UserDevice,
                    item: { id: 't1', uri: 'spotify:track:t1', type: 'track' } as SpotifyApi.TrackObjectFull,
                } as SpotifyApi.CurrentPlaybackResponse;
            },
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;
        const droppedClient = new SpotifyPlayerClient(droppedSpotify, undefined, {
            isMobile: () => true,
            transferSettleDelayMs: 0,
            postPlayVerifyDelayMs: 0,
            retryDelayMs: 0,
        });
        const droppedId = await droppedClient.resolveTargetDevice();
        const droppedRes = await droppedClient.startPlaybackOnDevice(droppedId, ['spotify:track:t1', 'spotify:track:t2']);

        // 0: initial play ({ uris })
        // 1: retry play ({ uris }) (NO /me/player play:false!)
        // 2: empty-body resume kick
        assert.strictEqual(droppedRes.confirmedPlaying, true);
        assert.strictEqual(fetchCalls.length, 3);
        assert.strictEqual(fetchCalls[0].url, 'https://api.spotify.com/v1/me/player/play?device_id=phone_sleep');
        assert.ok(fetchCalls[0].init?.body);
        assert.strictEqual(fetchCalls[1].url, 'https://api.spotify.com/v1/me/player/play?device_id=phone_sleep');
        assert.ok(fetchCalls[1].init?.body);
        assert.strictEqual(fetchCalls[2].url, 'https://api.spotify.com/v1/me/player/play?device_id=phone_sleep');
        assert.strictEqual(fetchCalls[2].init?.body, undefined);

        // 3. If a DIFFERENT device (`pc_other`) actively holds the Connect session on check #2,
        //    retryDroppedUris reclaims the mobile phone using `play: true` (NEVER `play: false`) before retrying `{ uris }`.
        fetchCalls = [];
        let stolenCheck = 0;
        const stolenSpotify = {
            getAccessToken: () => 'token_stolen',
            getMyDevices: async () => ({
                devices: [
                    { id: 'phone_sleep', name: 'Android', type: 'Smartphone', is_active: false, is_restricted: false },
                ] as SpotifyApi.UserDevice[],
            }),
            getMyCurrentPlaybackState: async () => {
                stolenCheck++;
                if (stolenCheck <= 2) {
                    return {
                        is_playing: true,
                        progress_ms: 5000,
                        context: { type: 'playlist', uri: 'spotify:playlist:pc' } as SpotifyApi.ContextObject,
                        device: { id: 'pc_other', name: 'Desktop', type: 'Computer', is_active: true, is_restricted: false } as SpotifyApi.UserDevice,
                        item: { id: 'other', uri: 'spotify:track:other', type: 'track' } as SpotifyApi.TrackObjectFull,
                    } as SpotifyApi.CurrentPlaybackResponse;
                }
                return {
                    is_playing: true,
                    progress_ms: 250,
                    context: null,
                    device: { id: 'phone_sleep', name: 'Android', type: 'Smartphone', is_active: true, is_restricted: false } as SpotifyApi.UserDevice,
                    item: { id: 't1', uri: 'spotify:track:t1', type: 'track' } as SpotifyApi.TrackObjectFull,
                } as SpotifyApi.CurrentPlaybackResponse;
            },
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;
        const stolenClient = new SpotifyPlayerClient(stolenSpotify, undefined, {
            isMobile: () => true,
            transferSettleDelayMs: 0,
            postPlayVerifyDelayMs: 0,
            retryDelayMs: 0,
        });
        const stolenId = await stolenClient.resolveTargetDevice();
        const stolenRes = await stolenClient.startPlaybackOnDevice(stolenId, ['spotify:track:t1']);
        assert.strictEqual(stolenRes.confirmedPlaying, true);
        assert.strictEqual(fetchCalls.length, 3);
        assert.strictEqual(fetchCalls[0].url, 'https://api.spotify.com/v1/me/player/play?device_id=phone_sleep');
        assert.strictEqual(fetchCalls[1].url, 'https://api.spotify.com/v1/me/player');
        assert.deepStrictEqual(JSON.parse(String(fetchCalls[1].init?.body)), {
            device_ids: ['phone_sleep'],
            play: true,
        });
        assert.strictEqual(fetchCalls[2].url, 'https://api.spotify.com/v1/me/player/play?device_id=phone_sleep');

        // 4. Verify shouldAbort suppresses post-play verification/resume kicks
        fetchCalls = [];
        let aborted = false;
        const abortingSpotify = {
            getAccessToken: () => 'token_abort',
            getMyCurrentPlaybackState: async () => {
                aborted = true;
                return {
                    is_playing: false,
                    progress_ms: 0,
                    context: null,
                    device: { id: 'phone_sleep', is_active: true } as SpotifyApi.UserDevice,
                    item: { id: 't1', uri: 'spotify:track:t1', type: 'track' } as SpotifyApi.TrackObjectFull,
                } as SpotifyApi.CurrentPlaybackResponse;
            },
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;
        const abortClient = new SpotifyPlayerClient(abortingSpotify, undefined, {
            postPlayVerifyDelayMs: 0,
            retryDelayMs: 0,
        });
        const abortedRes = await abortClient.startPlaybackOnDevice('phone_sleep', ['spotify:track:t1'], {
            shouldAbort: () => aborted,
        });
        assert.strictEqual(abortedRes.aborted, true);
        assert.strictEqual(fetchCalls.length, 1);
    });

    it('detects progress_ms === 0 cloud mirage flipping to paused, handles relinked tracks without linked_from via expectedTrackKeys, and recovers stale is_active: true dropped { uris } without play:false', async () => {
        // 1. Cloud mirage (`is_playing: true, progress_ms: 0` on 1st check -> `is_playing: false` on 2nd check ->
        //    `is_playing: true, progress_ms: 320` on 3rd check after kickResume)
        //    plus regional track relinking WITHOUT `linked_from` (`spotify:track:jp_relinked` != `spotify:track:intl_take_on_me`)!
        const receivedOptions: unknown[] = [];
        let mirageChecks = 0;
        let kickCallbackCount = 0;
        const mirageSpotify = {
            getAccessToken: () => 'token_mirage',
            getMyCurrentPlaybackState: async (opts?: unknown) => {
                receivedOptions.push(opts);
                mirageChecks++;
                return {
                    is_playing: mirageChecks !== 2,
                    progress_ms: mirageChecks >= 3 ? 320 : 0,
                    context: null,
                    device: { id: 'phone_1', name: 'Pixel', type: 'Smartphone', is_active: true, is_restricted: false } as SpotifyApi.UserDevice,
                    item: {
                        id: 'jp_relinked',
                        uri: 'spotify:track:jp_relinked',
                        name: 'Take On Me - 2015 Remaster',
                        artists: [{ name: 'a-ha' }],
                        type: 'track',
                    } as unknown as SpotifyApi.TrackObjectFull,
                } as SpotifyApi.CurrentPlaybackResponse;
            },
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;

        const mirageClient = new SpotifyPlayerClient(mirageSpotify, undefined, {
            postPlayVerifyDelayMs: 0,
            retryDelayMs: 0,
            transferSettleDelayMs: 0,
        });

        const mirageRes = await mirageClient.startPlaybackOnDevice('phone_1', ['spotify:track:intl_take_on_me'], {
            expectedTrackKeys: ['take on me|a-ha'],
            onResumeKickSent: () => {
                kickCallbackCount++;
            },
        });

        assert.strictEqual(mirageRes.confirmedPlaying, true);
        assert.strictEqual(mirageChecks, 3);
        assert.deepStrictEqual(receivedOptions[0], { market: 'from_token' });
        assert.strictEqual(kickCallbackCount, 1);
        assert.strictEqual(fetchCalls.length, 2);
        assert.ok(fetchCalls[0].init?.body);
        assert.strictEqual(fetchCalls[1].url, 'https://api.spotify.com/v1/me/player/play?device_id=phone_1');
        assert.strictEqual(fetchCalls[1].init?.body, undefined);

        // 2. Recently backgrounded Smartphone still marked stale `is_active: true` (`wasInitiallyInactive === false`)
        //    drops the initial `{ uris }` (`postState === null`, `secondState === null`) -> retries `{ uris }` + kick WITHOUT `play: false`!
        fetchCalls = [];
        let staleActiveChecks = 0;
        const resolvedDeviceSnapshots: SpotifyApi.UserDevice[][] = [];
        const staleActiveSpotify = {
            getAccessToken: () => 'token_stale_active',
            getMyDevices: async () => ({
                devices: [
                    { id: 'phone_bg', name: 'Galaxy', type: 'Smartphone', is_active: true, is_restricted: false },
                ] as SpotifyApi.UserDevice[],
            }),
            getMyCurrentPlaybackState: async () => {
                staleActiveChecks++;
                if (staleActiveChecks <= 2) {
                    return null as unknown as SpotifyApi.CurrentPlaybackResponse;
                }
                return {
                    is_playing: staleActiveChecks >= 4,
                    progress_ms: staleActiveChecks >= 4 ? 150 : 0,
                    context: null,
                    device: { id: 'phone_bg', name: 'Galaxy', type: 'Smartphone', is_active: true, is_restricted: false } as SpotifyApi.UserDevice,
                    item: { id: 't1', uri: 'spotify:track:t1', name: 'Song 1', artists: [{ name: 'Artist' }], type: 'track' } as unknown as SpotifyApi.TrackObjectFull,
                } as SpotifyApi.CurrentPlaybackResponse;
            },
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;

        const staleActiveClient = new SpotifyPlayerClient(staleActiveSpotify, undefined, {
            isMobile: () => true,
            postPlayVerifyDelayMs: 0,
            retryDelayMs: 0,
            transferSettleDelayMs: 0,
            onDevicesResolved: (devs) => {
                resolvedDeviceSnapshots.push(devs);
            },
        });

        const bgDeviceId = await staleActiveClient.resolveTargetDevice();
        assert.strictEqual(bgDeviceId, 'phone_bg');
        assert.strictEqual(resolvedDeviceSnapshots.length, 1);
        assert.strictEqual(resolvedDeviceSnapshots[0][0].id, 'phone_bg');

        const staleRes = await staleActiveClient.startPlaybackOnDevice(bgDeviceId, ['spotify:track:t1']);
        // 0: initial play ({ uris })
        // 1: retry play ({ uris }) (NO /me/player play:false!)
        // 2: empty-body resume kick because thirdState loaded paused
        assert.strictEqual(staleRes.confirmedPlaying, true);
        assert.strictEqual(fetchCalls.length, 3);
        assert.ok(fetchCalls[0].init?.body);
        assert.strictEqual(fetchCalls[1].url, 'https://api.spotify.com/v1/me/player/play?device_id=phone_bg');
        assert.ok(fetchCalls[1].init?.body);
        assert.strictEqual(fetchCalls[2].url, 'https://api.spotify.com/v1/me/player/play?device_id=phone_bg');
        assert.strictEqual(fetchCalls[2].init?.body, undefined);
    });

    it('suppresses global onError notifications when resume() is called with { silent: true } while preserving explicit resume error reporting', async () => {
        const reportedErrors: SpotifyApiErrorInfo[] = [];
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            fetchCalls.push({ url: String(input), init });
            return {
                ok: false,
                status: 403,
                statusText: 'Forbidden',
                headers: { get: () => null },
                text: async () => 'Restriction violated',
            } as unknown as Response;
        }) as typeof fetch;

        const fakeSpotify = {
            getAccessToken: () => 'token_silent',
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;

        const client = new SpotifyPlayerClient(fakeSpotify, (err) => {
            reportedErrors.push(err);
        });

        const silentRes = await client.resume('phone_1', { silent: true });
        assert.strictEqual(silentRes.ok, false);
        assert.strictEqual(silentRes.status, 403);
        assert.strictEqual(reportedErrors.length, 0);

        const loudRes = await client.resume('phone_1');
        assert.strictEqual(loudRes.ok, false);
        assert.strictEqual(loudRes.status, 403);
        assert.strictEqual(reportedErrors.length, 1);
    });

    it('grants extra settle check when inactive mobile device reports non-null idle state, honors pre-entry shouldAbort, and supports forcePlayTransfer resume with fallback', async () => {
        // 1. Pre-entry shouldAbort prevents ANY fetch call in startPlaybackOnDevice (e.g. user paused during resolveTargetDevice)
        const abortSpotify = {
            getAccessToken: () => 'token_abort_early',
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;
        const abortClient = new SpotifyPlayerClient(abortSpotify);
        const earlyAbortRes = await abortClient.startPlaybackOnDevice('phone_1', ['spotify:track:t1'], {
            shouldAbort: () => true,
        });
        assert.strictEqual(earlyAbortRes.aborted, true);
        assert.strictEqual(fetchCalls.length, 0);

        // 2. Waking inactive phone reports non-null `{ device: { id: 'phone_sleep', is_active: true }, is_playing: false, item: null }`
        //    on checks #1 and #2, surfaces `t1` paused on check #3, and confirms playing on check #4 ->
        //    must NOT send `play: false` or prematurely re-send `{ uris }`!
        let idleWakeChecks = 0;
        const idleWakeSpotify = {
            getAccessToken: () => 'token_idle_wake',
            getMyDevices: async () => ({
                devices: [
                    { id: 'phone_sleep', name: 'Android', type: 'Smartphone', is_active: false, is_restricted: false },
                ] as SpotifyApi.UserDevice[],
            }),
            getMyCurrentPlaybackState: async () => {
                idleWakeChecks++;
                if (idleWakeChecks <= 2) {
                    return {
                        is_playing: false,
                        progress_ms: 0,
                        context: null,
                        device: { id: 'phone_sleep', name: 'Android', type: 'Smartphone', is_active: true, is_restricted: false } as SpotifyApi.UserDevice,
                        item: null,
                    } as unknown as SpotifyApi.CurrentPlaybackResponse;
                }
                return {
                    is_playing: idleWakeChecks >= 4,
                    progress_ms: idleWakeChecks >= 4 ? 190 : 0,
                    context: null,
                    device: { id: 'phone_sleep', name: 'Android', type: 'Smartphone', is_active: true, is_restricted: false } as SpotifyApi.UserDevice,
                    item: { id: 't1', uri: 'spotify:track:t1', type: 'track' } as SpotifyApi.TrackObjectFull,
                } as SpotifyApi.CurrentPlaybackResponse;
            },
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;
        const idleWakeClient = new SpotifyPlayerClient(idleWakeSpotify, undefined, {
            isMobile: () => true,
            transferSettleDelayMs: 0,
            postPlayVerifyDelayMs: 0,
            retryDelayMs: 0,
        });
        const targetId = await idleWakeClient.resolveTargetDevice();
        const idleRes = await idleWakeClient.startPlaybackOnDevice(targetId, ['spotify:track:t1', 'spotify:track:t2']);

        assert.strictEqual(idleRes.confirmedPlaying, true);
        assert.strictEqual(idleWakeChecks, 4);
        assert.strictEqual(fetchCalls.length, 2);
        assert.strictEqual(fetchCalls[0].url, 'https://api.spotify.com/v1/me/player/play?device_id=phone_sleep');
        assert.ok(fetchCalls[0].init?.body);
        assert.strictEqual(fetchCalls[1].url, 'https://api.spotify.com/v1/me/player/play?device_id=phone_sleep');
        assert.strictEqual(fetchCalls[1].init?.body, undefined);

        // 3. resume(deviceId, { silent: true, forcePlayTransfer: true }) sends PUT /v1/me/player { device_ids, play: true },
        //    and falls back to PUT /v1/me/player/play?device_id=... if transfer fails.
        fetchCalls = [];
        const transferClient = new SpotifyPlayerClient({
            getAccessToken: () => 'token_transfer_play',
        } as unknown as SpotifyWebApi.SpotifyWebApiJs);

        const okTransfer = await transferClient.resume('phone_sleep', { silent: true, forcePlayTransfer: true });
        assert.strictEqual(okTransfer.ok, true);
        assert.strictEqual(fetchCalls.length, 1);
        assert.strictEqual(fetchCalls[0].url, 'https://api.spotify.com/v1/me/player');
        assert.deepStrictEqual(JSON.parse(String(fetchCalls[0].init?.body)), {
            device_ids: ['phone_sleep'],
            play: true,
        });

        fetchCalls = [];
        let callNum = 0;
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            callNum++;
            fetchCalls.push({ url: String(input), init });
            if (callNum === 1) {
                return {
                    ok: false,
                    status: 502,
                    statusText: 'Bad Gateway',
                    headers: { get: () => null },
                    text: async () => 'Bad Gateway',
                } as unknown as Response;
            }
            return {
                ok: true,
                status: 204,
                statusText: 'No Content',
                headers: { get: () => null },
                text: async () => '',
            } as unknown as Response;
        }) as typeof fetch;

        const fallbackTransfer = await transferClient.resume('phone_sleep', { silent: true, forcePlayTransfer: true });
        assert.strictEqual(fallbackTransfer.ok, true);
        assert.strictEqual(fetchCalls.length, 2);
        assert.strictEqual(fetchCalls[0].url, 'https://api.spotify.com/v1/me/player');
        assert.strictEqual(fetchCalls[1].url, 'https://api.spotify.com/v1/me/player/play?device_id=phone_sleep');
    });

    it('reports confirmedPlaying: false on frozen / BFGS-blocked Android 16 phone and validates launchSpotifyAppUri, hasActiveBrowserUserGesture, and setActiveDevice({ play: true })', async () => {
        // 1. Frozen Android 16 phone (`am_freeze` / `ForegroundKeeperService` stopped):
        //    Spotify Cloud returns HTTP 204 on `PUT /me/player/play`, while `/me/player` stays stuck on
        //    the previous external track ("Manteca - Live", `is_playing: false`)!
        const frozenSpotify = {
            getAccessToken: () => 'token_pixel10',
            getMyDevices: async () => ({
                devices: [
                    { id: 'pixel_10_pro_xl', name: 'Pixel 10 Pro XL', type: 'Smartphone', is_active: false, is_restricted: false },
                ] as SpotifyApi.UserDevice[],
            }),
            getMyCurrentPlaybackState: async () => ({
                is_playing: false,
                progress_ms: 431000,
                context: { type: 'album', uri: 'spotify:album:dizzy' } as SpotifyApi.ContextObject,
                device: { id: 'pixel_10_pro_xl', name: 'Pixel 10 Pro XL', type: 'Smartphone', is_active: false, is_restricted: false } as SpotifyApi.UserDevice,
                item: { id: 'manteca', uri: 'spotify:track:manteca', name: 'Manteca - Live', type: 'track' } as SpotifyApi.TrackObjectFull,
            } as SpotifyApi.CurrentPlaybackResponse),
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;

        const frozenClient = new SpotifyPlayerClient(frozenSpotify, undefined, {
            isMobile: () => true,
            postPlayVerifyDelayMs: 0,
            retryDelayMs: 0,
        });

        const pixelId = await frozenClient.resolveTargetDevice();
        const frozenResult = await frozenClient.startPlaybackOnDevice(pixelId, ['spotify:track:new_jazz_1']);
        assert.strictEqual(frozenResult.confirmedPlaying, false);
        assert.strictEqual(frozenResult.targetTrackLoaded, false);
        assert.strictEqual(frozenResult.isMobileTarget, true);
        // Zero `play: false` requests were ever sent!
        assert.strictEqual(
            fetchCalls.some(c => c.url.endsWith('/me/player') && String(c.init?.body).includes('"play":false')),
            false
        );

        // 2. BFGS-blocked phone loads Track 1 into Cloud state (`targetTrackLoaded: true`) but ignores `kickResume` (`is_playing: false`)
        fetchCalls = [];
        const bfgsPausedSpotify = {
            getAccessToken: () => 'token_bfgs',
            getMyDevices: async () => ({
                devices: [
                    { id: 'pixel_10_pro_xl', name: 'Pixel 10 Pro XL', type: 'Smartphone', is_active: true, is_restricted: false },
                ] as SpotifyApi.UserDevice[],
            }),
            getMyCurrentPlaybackState: async () => ({
                is_playing: false,
                progress_ms: 0,
                context: null,
                device: { id: 'pixel_10_pro_xl', name: 'Pixel 10 Pro XL', type: 'Smartphone', is_active: true, is_restricted: false } as SpotifyApi.UserDevice,
                item: { id: 'new_jazz_1', uri: 'spotify:track:new_jazz_1', type: 'track' } as SpotifyApi.TrackObjectFull,
            } as SpotifyApi.CurrentPlaybackResponse),
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;

        const bfgsClient = new SpotifyPlayerClient(bfgsPausedSpotify, undefined, {
            isMobile: () => true,
            postPlayVerifyDelayMs: 0,
            retryDelayMs: 0,
        });
        const bfgsDevId = await bfgsClient.resolveTargetDevice();
        const bfgsRes = await bfgsClient.startPlaybackOnDevice(bfgsDevId, ['spotify:track:new_jazz_1']);
        assert.strictEqual(bfgsRes.targetTrackLoaded, true);
        assert.strictEqual(bfgsRes.confirmedPlaying, false);
        assert.strictEqual(bfgsRes.isMobileTarget, true);

        // 3. setActiveDevice supports `{ play: true }` while keeping default body clean when omitted
        fetchCalls = [];
        await bfgsClient.setActiveDevice('pixel_10_pro_xl', { play: true });
        assert.deepStrictEqual(JSON.parse(String(fetchCalls[0].init?.body)), {
            device_ids: ['pixel_10_pro_xl'],
            play: true,
        });
        await bfgsClient.setActiveDevice('pixel_10_pro_xl');
        assert.deepStrictEqual(JSON.parse(String(fetchCalls[1].init?.body)), {
            device_ids: ['pixel_10_pro_xl'],
        });

        // 4. Helper validations: isMobileSpotifyDevice, hasActiveBrowserUserGesture, launchSpotifyAppUri
        assert.strictEqual(isMobileSpotifyDevice({ type: 'Smartphone' }), true);
        assert.strictEqual(isMobileSpotifyDevice({ type: 'Tablet' }), true);
        assert.strictEqual(isMobileSpotifyDevice({ type: 'Computer' }), false);
        assert.strictEqual(isMobileSpotifyDevice(null), false);
        assert.strictEqual(hasActiveBrowserUserGesture(), false);

        const clickedHrefs: string[] = [];
        const appendedNodes: unknown[] = [];
        const removedNodes: unknown[] = [];
        const fakeDoc = {
            body: {
                appendChild(node: { parentNode?: unknown }) {
                    node.parentNode = this;
                    appendedNodes.push(node);
                    return node;
                },
                removeChild(node: { parentNode?: unknown }) {
                    node.parentNode = null;
                    removedNodes.push(node);
                    return node;
                },
            },
            createElement(tag: string) {
                assert.strictEqual(tag, 'a');
                const el = {
                    href: '',
                    rel: '',
                    style: { display: '' },
                    parentNode: null as unknown,
                    click() {
                        clickedHrefs.push(this.href);
                    },
                };
                return el;
            },
        } as unknown as Document;

        assert.strictEqual(launchSpotifyAppUri('spotify:', fakeDoc), true);
        assert.deepStrictEqual(clickedHrefs, ['spotify:']);
        assert.strictEqual(appendedNodes.length, 1);
        assert.strictEqual(removedNodes.length, 1);

        // Reject unsafe or non-spotify schemes and empty inputs
        assert.strictEqual(launchSpotifyAppUri('javascript:alert(1)', fakeDoc), false);
        assert.strictEqual(launchSpotifyAppUri('https://open.spotify.com', fakeDoc), false);
        assert.strictEqual(launchSpotifyAppUri('', fakeDoc), false);
        assert.strictEqual(launchSpotifyAppUri('spotify:', null), false);
        assert.strictEqual(
            launchSpotifyAppUri('intent://home#Intent;scheme=spotify;package=com.evil.app;end', fakeDoc),
            false
        );
        assert.strictEqual(
            launchSpotifyAppUri('intent://home#Intent;scheme=http;package=com.spotify.music;end', fakeDoc),
            false
        );
        assert.strictEqual(clickedHrefs.length, 1);

        // Android WebAPK / Chrome resolves package-targeted `com.spotify.music` intent:// URI by default,
        // while iOS / Desktop resolves `spotify:`
        assert.strictEqual(
            resolveSpotifyWakeUri(
                'Mozilla/5.0 (Linux; Android 17; Pixel 10 Pro XL) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36'
            ),
            SPOTIFY_ANDROID_WAKE_INTENT_URI
        );
        assert.strictEqual(
            resolveSpotifyWakeUri(
                'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1'
            ),
            'spotify:'
        );

        const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
        try {
            Object.defineProperty(globalThis, 'navigator', {
                value: {
                    userAgent:
                        'Mozilla/5.0 (Linux; Android 17; Pixel 10 Pro XL) AppleWebKit/537.36 Chrome/142.0.0.0 Mobile Safari/537.36',
                },
                configurable: true,
                writable: true,
            });
            assert.strictEqual(launchSpotifyAppUri(undefined, fakeDoc), true);
            assert.strictEqual(clickedHrefs[1], SPOTIFY_ANDROID_WAKE_INTENT_URI);
        } finally {
            if (origNavDesc) {
                Object.defineProperty(globalThis, 'navigator', origNavDesc);
            } else {
                delete (globalThis as Record<string, unknown>).navigator;
            }
        }
    });

    it('preserves Smartphone classification across Computer switches, supports deferTransfer without idle PUT /me/player, avoids trailing resolveTargetDevice delay, and fast-fails dead mobile targets under user gesture', async () => {
        // 1. Even if `lastResolvedDevice` previously pointed to `pc_1` (`Computer`), `knownDevices` remembers
        //    `phone_1` (`Smartphone`, `is_active: false`) so `startPlaybackOnDevice('phone_1')` NEVER sends `play: false`!
        const multiSpotify = {
            getAccessToken: () => 'token_multi',
            getMyDevices: async () => ({
                devices: [
                    { id: 'pc_1', name: 'Desktop PC', type: 'Computer', is_active: true, is_restricted: false },
                    { id: 'phone_1', name: 'Pixel 10 Pro XL', type: 'Smartphone', is_active: false, is_restricted: false },
                ] as SpotifyApi.UserDevice[],
            }),
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;

        const desktopRuntimeClient = new SpotifyPlayerClient(multiSpotify, undefined, {
            isMobile: () => false,
            transferSettleDelayMs: 0,
            retryDelayMs: 0,
        });
        const firstResolved = await desktopRuntimeClient.resolveTargetDevice();
        assert.strictEqual(firstResolved, 'pc_1');

        // Defer transfer pins `phone_1` without firing any idle `PUT /v1/me/player` that would stop Android FGS
        fetchCalls = [];
        const deferRes = await desktopRuntimeClient.setActiveDevice('phone_1', { deferTransfer: true });
        assert.strictEqual(deferRes.ok, true);
        assert.strictEqual(fetchCalls.length, 0);
        assert.strictEqual(desktopRuntimeClient.getPreferredDeviceId(), 'phone_1');

        const phonePlayRes = await desktopRuntimeClient.startPlaybackOnDevice('phone_1', ['spotify:track:t1']);
        assert.strictEqual(phonePlayRes.isMobileTarget, true);
        assert.strictEqual(
            fetchCalls.some(c => c.url.endsWith('/me/player') && String(c.init?.body).includes('"play":false')),
            false
        );
        assert.strictEqual(fetchCalls.length, 1);
        assert.strictEqual(fetchCalls[0].url, 'https://api.spotify.com/v1/me/player/play?device_id=phone_1');

        // 2. `resolveTargetDevice` does NOT waste `pollDelayMs` sleeping after the final attempt
        let emptyAttempts = 0;
        const delayCalls: number[] = [];
        const emptySpotify = {
            getAccessToken: () => 'token_empty',
            getMyDevices: async () => {
                emptyAttempts++;
                return { devices: [] as SpotifyApi.UserDevice[] };
            },
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;
        const fastPollClient = new SpotifyPlayerClient(emptySpotify, undefined, {
            isMobile: () => true,
            devicePollDelayMs: 60,
        });
        (fastPollClient as unknown as { delay: (ms: number) => Promise<void> }).delay = async (ms: number) => {
            delayCalls.push(ms);
        };
        await assert.rejects(
            () => fastPollClient.resolveTargetDevice({ maxAttempts: 2, pollDelayMs: 30 }),
            /No active device found/
        );
        assert.strictEqual(emptyAttempts, 2);
        // Only 1 inter-attempt delay of 30ms between attempt 1 and attempt 2 (zero trailing sleep!)
        assert.deepStrictEqual(delayCalls, [30]);

        // 3. `fastFailForUserGesture: true` skips second dead-device `PUT /player/play` retry on frozen phone
        //    so Chromium's 5.0s `TransientUserActivation` window remains valid for 1-tap `spotify:` wake,
        //    while STILL reclaiming Connect via `play: true` if another device (`pc_1`) holds the session!
        fetchCalls = [];
        const deadPhoneSpotify = {
            getAccessToken: () => 'token_dead_gesture',
            getMyDevices: async () => ({
                devices: [
                    { id: 'phone_1', name: 'Pixel 10 Pro XL', type: 'Smartphone', is_active: false, is_restricted: false },
                ] as SpotifyApi.UserDevice[],
            }),
            getMyCurrentPlaybackState: async () => null,
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;
        const gestureClient = new SpotifyPlayerClient(deadPhoneSpotify, undefined, {
            isMobile: () => true,
            postPlayVerifyDelayMs: 0,
            retryDelayMs: 0,
        });
        const resolvedPhone = await gestureClient.resolveTargetDevice();
        const deadGestureRes = await gestureClient.startPlaybackOnDevice(
            resolvedPhone,
            ['spotify:track:fast1'],
            { fastFailForUserGesture: true }
        );
        assert.strictEqual(deadGestureRes.confirmedPlaying, false);
        assert.strictEqual(deadGestureRes.targetTrackLoaded, false);
        // Only 1 `PUT /player/play` call (zero redundant second dead-device retry!)
        assert.strictEqual(fetchCalls.filter(c => c.url.includes('/player/play')).length, 1);

        // When another device (`pc_1`) holds Connect, `fastFailForUserGesture: true` still reclaims via `play: true`!
        fetchCalls = [];
        let transferredToPhone = false;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            fetchCalls.push({ url, init });
            if (url.endsWith('/me/player') && String(init?.body).includes('"play":true')) {
                transferredToPhone = true;
            }
            return { ok: true, status: 204, statusText: 'No Content', text: async () => '' } as Response;
        }) as typeof fetch;
        const heldByPcSpotify = {
            getAccessToken: () => 'token_held_pc',
            getMyDevices: async () => ({
                devices: [
                    { id: 'pc_1', name: 'PC', type: 'Computer', is_active: true, is_restricted: false },
                    { id: 'phone_1', name: 'Pixel 10 Pro XL', type: 'Smartphone', is_active: false, is_restricted: false },
                ] as SpotifyApi.UserDevice[],
            }),
            getMyCurrentPlaybackState: async () =>
                transferredToPhone
                    ? ({
                          is_playing: true,
                          progress_ms: 350,
                          context: null,
                          device: { id: 'phone_1', name: 'Pixel 10 Pro XL', type: 'Smartphone', is_active: true, is_restricted: false },
                          item: { id: 'fast1', uri: 'spotify:track:fast1', type: 'track' },
                      } as unknown as SpotifyApi.CurrentPlaybackResponse)
                    : ({
                          is_playing: true,
                          progress_ms: 12000,
                          context: null,
                          device: { id: 'pc_1', name: 'PC', type: 'Computer', is_active: true, is_restricted: false },
                          item: { id: 'other', uri: 'spotify:track:other', type: 'track' },
                      } as unknown as SpotifyApi.CurrentPlaybackResponse),
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;
        const stealClient = new SpotifyPlayerClient(heldByPcSpotify, undefined, {
            isMobile: () => true,
            postPlayVerifyDelayMs: 0,
            retryDelayMs: 0,
            transferSettleDelayMs: 0,
        });
        const stealTarget = await stealClient.resolveTargetDevice();
        assert.strictEqual(stealTarget, 'phone_1');
        const stealRes = await stealClient.startPlaybackOnDevice(
            stealTarget,
            ['spotify:track:fast1'],
            { fastFailForUserGesture: true }
        );
        assert.strictEqual(stealRes.confirmedPlaying, true);
        assert.strictEqual(transferredToPhone, true);

        // Rejects persistent 0ms cloud mirage and repeated verification errors on mobile targets
        const stuckMirageSpotify = {
            getAccessToken: () => 'token_stuck_mirage',
            getMyDevices: async () => ({
                devices: [
                    { id: 'phone_1', name: 'Pixel 10 Pro XL', type: 'Smartphone', is_active: true, is_restricted: false },
                ] as SpotifyApi.UserDevice[],
            }),
            getMyCurrentPlaybackState: async () => ({
                is_playing: true,
                progress_ms: 0,
                context: null,
                device: { id: 'phone_1', name: 'Pixel 10 Pro XL', type: 'Smartphone', is_active: true, is_restricted: false },
                item: { id: 'fast1', uri: 'spotify:track:fast1', type: 'track' },
            } as unknown as SpotifyApi.CurrentPlaybackResponse),
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;
        const stuckMirageClient = new SpotifyPlayerClient(stuckMirageSpotify, undefined, {
            isMobile: () => true,
            postPlayVerifyDelayMs: 0,
            retryDelayMs: 0,
        });
        await stuckMirageClient.resolveTargetDevice();
        const stuckMirageRes = await stuckMirageClient.startPlaybackOnDevice('phone_1', ['spotify:track:fast1']);
        assert.strictEqual(stuckMirageRes.targetTrackLoaded, true);
        assert.strictEqual(stuckMirageRes.confirmedPlaying, false);

        const throwingVerifySpotify = {
            getAccessToken: () => 'token_throw_verify',
            getMyDevices: async () => ({
                devices: [
                    { id: 'phone_1', name: 'Pixel 10 Pro XL', type: 'Smartphone', is_active: true, is_restricted: false },
                ] as SpotifyApi.UserDevice[],
            }),
            getMyCurrentPlaybackState: async () => {
                throw new Error('503 Service Unavailable');
            },
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;
        const throwingVerifyClient = new SpotifyPlayerClient(throwingVerifySpotify, undefined, {
            isMobile: () => true,
            postPlayVerifyDelayMs: 0,
            retryDelayMs: 0,
        });
        await throwingVerifyClient.resolveTargetDevice();
        const throwingVerifyRes = await throwingVerifyClient.startPlaybackOnDevice('phone_1', ['spotify:track:fast1']);
        assert.strictEqual(throwingVerifyRes.confirmedPlaying, false);
    });

    it('resolveTargetDevice({ fastFailOnEmpty: true }) aborts immediately on empty device list without retry delay while still retrying restricted devices', async () => {
        let emptyCalls = 0;
        const emptySpotify = {
            getAccessToken: () => 'token_empty',
            getMyDevices: async () => {
                emptyCalls++;
                return { devices: [] };
            },
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;

        const fastFailClient = new SpotifyPlayerClient(emptySpotify, undefined, {
            isMobile: () => true,
            devicePollDelayMs: 5000, // Would block 10s if not fast-failed!
        });
        const startedAt = Date.now();
        await assert.rejects(
            async () => fastFailClient.resolveTargetDevice({ fastFailOnEmpty: true }),
            /No active device found/
        );
        const elapsedMs = Date.now() - startedAt;
        assert.strictEqual(emptyCalls, 1);
        assert.ok(elapsedMs < 500, `Expected immediate fast-fail without 5s poll delay, took ${elapsedMs}ms`);

        // Non-empty restricted list still retries and resolves when unrestricted on attempt 2
        let restrictedAttempt = 0;
        const wakingRestrictedSpotify = {
            getAccessToken: () => 'token_restricted_wake',
            getMyDevices: async () => {
                restrictedAttempt++;
                if (restrictedAttempt === 1) {
                    return {
                        devices: [
                            { id: 'phone_1', name: 'Pixel 10 Pro XL', type: 'Smartphone', is_active: false, is_restricted: true } as SpotifyApi.UserDevice,
                        ],
                    };
                }
                return {
                    devices: [
                        { id: 'phone_1', name: 'Pixel 10 Pro XL', type: 'Smartphone', is_active: false, is_restricted: false } as SpotifyApi.UserDevice,
                    ],
                };
            },
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;

        const retryRestrictedClient = new SpotifyPlayerClient(wakingRestrictedSpotify, undefined, {
            isMobile: () => true,
            devicePollDelayMs: 0,
        });
        const resolvedId = await retryRestrictedClient.resolveTargetDevice({ fastFailOnEmpty: true });
        assert.strictEqual(resolvedId, 'phone_1');
        assert.strictEqual(restrictedAttempt, 2);
    });
});
