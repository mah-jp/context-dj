import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import SpotifyWebApi from 'spotify-web-api-js';
import { SpotifyPlayerClient } from '../src/lib/spotify-player-client';

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
        await client.next();
        await client.pause();
        await client.addToQueue('spotify:track:123');

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
});
