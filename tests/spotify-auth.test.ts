import test, { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SpotifyAuth } from '../src/lib/spotify-auth';
import { STORAGE_KEYS } from '../src/lib/constants';
import { setStorageItem, getStorageItem } from '../src/lib/storage';

describe('SpotifyAuth', () => {
    let originalWindow: any;
    let originalFetch: any;
    let store: Record<string, string> = {};

    beforeEach(() => {
        store = {};
        originalWindow = (globalThis as any).window;
        originalFetch = globalThis.fetch;

        const localStorageMock = {
            getItem: (key: string) => store[key] ?? null,
            setItem: (key: string, value: string) => { store[key] = String(value); },
            removeItem: (key: string) => { delete store[key]; },
            clear: () => { store = {}; }
        };

        (globalThis as any).window = {
            localStorage: localStorageMock,
            location: {
                href: 'https://example.com/app?foo=bar#baz',
                origin: 'https://example.com',
                pathname: '/app',
            },
            crypto: {
                subtle: {
                    digest: async (_algo: string, data: Uint8Array) => {
                        return data.buffer;
                    }
                }
            }
        };
        (globalThis as any).localStorage = localStorageMock;
    });

    afterEach(() => {
        (globalThis as any).window = originalWindow;
        globalThis.fetch = originalFetch;
    });

    it('gets correct redirect URI without query or hash', () => {
        assert.strictEqual(SpotifyAuth.getRedirectUri(), 'https://example.com/app');
    });

    it('evaluates isAuthenticated correctly based on token and expiration', () => {
        // No token
        assert.strictEqual(SpotifyAuth.isAuthenticated(), false);

        // Valid token
        setStorageItem(STORAGE_KEYS.SPOTIFY_ACCESS_TOKEN, 'valid_token');
        setStorageItem(STORAGE_KEYS.SPOTIFY_EXPIRES_AT, String(Date.now() + 60000));
        assert.strictEqual(SpotifyAuth.isAuthenticated(), true);
        assert.strictEqual(SpotifyAuth.getAccessToken(), 'valid_token');

        // Expired token
        setStorageItem(STORAGE_KEYS.SPOTIFY_EXPIRES_AT, String(Date.now() - 1000));
        assert.strictEqual(SpotifyAuth.isAuthenticated(), false);
    });

    it('clears all session storage keys on logout', () => {
        setStorageItem(STORAGE_KEYS.SPOTIFY_ACCESS_TOKEN, 'token');
        setStorageItem(STORAGE_KEYS.SPOTIFY_EXPIRES_AT, '123456');
        setStorageItem(STORAGE_KEYS.SPOTIFY_REFRESH_TOKEN, 'refresh_token');

        SpotifyAuth.logout();

        assert.strictEqual(getStorageItem(STORAGE_KEYS.SPOTIFY_ACCESS_TOKEN), '');
        assert.strictEqual(getStorageItem(STORAGE_KEYS.SPOTIFY_EXPIRES_AT), '');
        assert.strictEqual(getStorageItem(STORAGE_KEYS.SPOTIFY_REFRESH_TOKEN), '');
    });

    it('handles successful token refresh via mock fetch', async () => {
        setStorageItem(STORAGE_KEYS.SPOTIFY_REFRESH_TOKEN, 'old_refresh_token');

        globalThis.fetch = async (url: any) => {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    access_token: 'new_access_token',
                    token_type: 'Bearer',
                    expires_in: 3600,
                    refresh_token: 'new_refresh_token'
                })
            } as any;
        };

        const token = await SpotifyAuth.refreshToken('client_123');
        assert.strictEqual(token, 'new_access_token');
        assert.strictEqual(SpotifyAuth.getAccessToken(), 'new_access_token');
        assert.strictEqual(getStorageItem(STORAGE_KEYS.SPOTIFY_REFRESH_TOKEN), 'new_refresh_token');
    });

    it('handles token refresh failure gracefully', async () => {
        setStorageItem(STORAGE_KEYS.SPOTIFY_REFRESH_TOKEN, 'invalid_refresh_token');

        globalThis.fetch = async () => {
            return {
                ok: false,
                status: 400,
                text: async () => 'Invalid grant',
            } as any;
        };

        const token = await SpotifyAuth.refreshToken('client_123');
        assert.strictEqual(token, null);
    });
});
