import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SpotifyAuth } from '../src/lib/spotify-auth';
import { STORAGE_KEYS } from '../src/lib/constants';
import { setStorageItem, getStorageItem } from '../src/lib/storage';

const globalEnv = globalThis as unknown as {
    window?: unknown;
    localStorage?: unknown;
};

describe('SpotifyAuth', () => {
    let originalWindow: unknown;
    let originalFetch: typeof globalThis.fetch;
    let store: Record<string, string> = {};

    beforeEach(() => {
        store = {};
        originalWindow = globalEnv.window;
        originalFetch = globalThis.fetch;

        const localStorageMock = {
            getItem: (key: string) => store[key] ?? null,
            setItem: (key: string, value: string) => { store[key] = String(value); },
            removeItem: (key: string) => { delete store[key]; },
            clear: () => { store = {}; }
        };

        globalEnv.window = {
            localStorage: localStorageMock,
            location: {
                href: 'https://example.com/app?foo=bar#baz',
                origin: 'https://example.com',
                pathname: '/app',
            },
            crypto: {
                getRandomValues: (arr: Uint8Array) => globalThis.crypto.getRandomValues(arr),
                subtle: {
                    digest: async (algo: string, data: Uint8Array) => {
                        return globalThis.crypto.subtle.digest(algo, data);
                    }
                }
            }
        };
        globalEnv.localStorage = localStorageMock;
    });

    afterEach(() => {
        globalEnv.window = originalWindow;
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

    it('generates RFC 7636 S256 PKCE challenge and stores verifier + state on login()', async () => {
        await SpotifyAuth.login('client_pkce_123');

        const verifier = getStorageItem(STORAGE_KEYS.SPOTIFY_VERIFIER);
        const state = getStorageItem(STORAGE_KEYS.SPOTIFY_AUTH_STATE);
        assert.strictEqual(verifier.length, 128);
        assert.match(verifier, /^[A-Za-z0-9\-._~]{128}$/);
        assert.ok(state.length > 0);

        const loc = (globalEnv.window as { location: { href: string } }).location.href;
        const authUrl = new URL(loc);
        assert.strictEqual(authUrl.searchParams.get('client_id'), 'client_pkce_123');
        assert.strictEqual(authUrl.searchParams.get('code_challenge_method'), 'S256');
        assert.strictEqual(authUrl.searchParams.get('state'), state);
        assert.strictEqual(authUrl.searchParams.get('redirect_uri'), 'https://example.com/app');

        // Verify challenge matches SHA-256 base64url(verifier)
        const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
        const expectedChallenge = Buffer.from(digest).toString('base64url');
        assert.strictEqual(authUrl.searchParams.get('code_challenge'), expectedChallenge);
    });

    it('validates OAuth state on handleCallback and rejects missing or mismatched state', async () => {
        setStorageItem(STORAGE_KEYS.SPOTIFY_VERIFIER, 'verifier_abc');
        setStorageItem(STORAGE_KEYS.SPOTIFY_AUTH_STATE, 'expected_state_123');

        globalThis.fetch = (async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                access_token: 'callback_token',
                token_type: 'Bearer',
                expires_in: 3600,
            })
        })) as unknown as typeof globalThis.fetch;

        // Missing/null state MUST fail when savedState exists (prevents CSRF state-stripping bypass)
        const missingStateToken = await SpotifyAuth.handleCallback('client_123', 'code_xyz', null);
        assert.strictEqual(missingStateToken, null);
        assert.match(SpotifyAuth.getLastError() || '', /state mismatch/i);

        // Mismatched state should fail
        const rejectedToken = await SpotifyAuth.handleCallback('client_123', 'code_xyz', 'wrong_state');
        assert.strictEqual(rejectedToken, null);
        assert.match(SpotifyAuth.getLastError() || '', /state mismatch/i);

        // Matching state should succeed, clear error, and clean up verifier & state
        const validToken = await SpotifyAuth.handleCallback('client_123', 'code_xyz', 'expected_state_123');
        assert.strictEqual(validToken, 'callback_token');
        assert.strictEqual(SpotifyAuth.getLastError(), null);
        assert.strictEqual(getStorageItem(STORAGE_KEYS.SPOTIFY_VERIFIER), '');
        assert.strictEqual(getStorageItem(STORAGE_KEYS.SPOTIFY_AUTH_STATE), '');
    });

    it('records concrete error messages in getLastError when verifier is missing or token exchange returns 400', async () => {
        // 1. Missing PKCE verifier
        const noVerifierRes = await SpotifyAuth.handleCallback('client_123', 'code_xyz', 'state_1');
        assert.strictEqual(noVerifierRes, null);
        assert.match(SpotifyAuth.getLastError() || '', /verifier missing/i);

        // 2. Token endpoint HTTP 400 with JSON error_description
        setStorageItem(STORAGE_KEYS.SPOTIFY_VERIFIER, 'verifier_abc');
        setStorageItem(STORAGE_KEYS.SPOTIFY_AUTH_STATE, 'state_1');
        globalThis.fetch = (async () => ({
            ok: false,
            status: 400,
            text: async () => JSON.stringify({
                error: 'invalid_grant',
                error_description: 'Invalid redirect URI',
            }),
        })) as unknown as typeof globalThis.fetch;

        const failedToken = await SpotifyAuth.handleCallback('client_123', 'code_xyz', 'state_1');
        assert.strictEqual(failedToken, null);
        const errMsg = SpotifyAuth.getLastError() || '';
        assert.match(errMsg, /400/);
        assert.match(errMsg, /Invalid redirect URI/);
        assert.match(errMsg, /https:\/\/example\.com\/app/);
    });

    it('handles successful token refresh via mock fetch', async () => {
        setStorageItem(STORAGE_KEYS.SPOTIFY_REFRESH_TOKEN, 'old_refresh_token');

        globalThis.fetch = (async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                access_token: 'new_access_token',
                token_type: 'Bearer',
                expires_in: 3600,
                refresh_token: 'new_refresh_token'
            })
        })) as unknown as typeof globalThis.fetch;

        const token = await SpotifyAuth.refreshToken('client_123');
        assert.strictEqual(token, 'new_access_token');
        assert.strictEqual(SpotifyAuth.getAccessToken(), 'new_access_token');
        assert.strictEqual(getStorageItem(STORAGE_KEYS.SPOTIFY_REFRESH_TOKEN), 'new_refresh_token');
    });

    it('handles token refresh failure gracefully', async () => {
        setStorageItem(STORAGE_KEYS.SPOTIFY_REFRESH_TOKEN, 'invalid_refresh_token');

        globalThis.fetch = (async () => ({
            ok: false,
            status: 400,
            text: async () => 'Invalid grant',
        })) as unknown as typeof globalThis.fetch;

        const token = await SpotifyAuth.refreshToken('client_123');
        assert.strictEqual(token, null);
    });
});

