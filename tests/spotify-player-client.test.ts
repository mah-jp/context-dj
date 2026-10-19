import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import SpotifyWebApi from 'spotify-web-api-js';
import { SpotifyPlayerClient, classifySpotifyError } from '../src/lib/spotify-player-client';
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
});
