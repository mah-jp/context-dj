import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractCodeFromInput, getValidSpotifyToken } from '../src/cli/auth';
import { isConfigured, CLIConfig, loadConfig } from '../src/cli/config';

describe('CLI Auth - extractCodeFromInput', () => {
    test('extracts code from full redirect URL with query params', () => {
        const url = 'http://127.0.0.1:8888/callback?code=AQD123456789&state=secret_state';
        const extracted = extractCodeFromInput(url);
        assert.strictEqual(extracted, 'AQD123456789');
    });

    test('extracts code when code param is preceded by other params', () => {
        const url = 'http://127.0.0.1:8888/callback?state=secret_state&code=AQD_abc_xyz';
        const extracted = extractCodeFromInput(url);
        assert.strictEqual(extracted, 'AQD_abc_xyz');
    });

    test('extracts raw code when user pastes code directly without URL', () => {
        const rawCode = 'AQD_plain_code_value';
        const extracted = extractCodeFromInput(rawCode);
        assert.strictEqual(extracted, 'AQD_plain_code_value');
    });

    test('handles leading/trailing whitespace gracefully', () => {
        const urlWithSpaces = '   http://127.0.0.1:8888/callback?code=TRIMMED_CODE   ';
        const extracted = extractCodeFromInput(urlWithSpaces);
        assert.strictEqual(extracted, 'TRIMMED_CODE');
    });
});

describe('CLI Config - isConfigured', () => {
    test('returns false for null config', () => {
        assert.strictEqual(isConfigured(null), false);
    });

    test('returns false when Spotify credentials are missing', () => {
        const cfg: CLIConfig = {
            aiProvider: 'gemini',
            aiApiKey: 'test-key',
        };
        assert.strictEqual(isConfigured(cfg), false);
    });

    test('returns false when AI API key is missing', () => {
        const cfg: CLIConfig = {
            spotifyClientId: 'spotify-client-id',
            spotifyRefreshToken: 'spotify-refresh-token',
            aiProvider: 'gemini',
            aiApiKey: '',
        };
        assert.strictEqual(isConfigured(cfg), false);
    });

    test('returns true when both Spotify and AI are configured', () => {
        const cfg: CLIConfig = {
            spotifyClientId: 'spotify-client-id',
            spotifyRefreshToken: 'spotify-refresh-token',
            aiProvider: 'gemini',
            aiApiKey: 'valid-api-key',
        };
        assert.strictEqual(isConfigured(cfg), true);
    });

    test('getValidSpotifyToken refreshes expired token, persists to disk, and mutates in-memory config', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-dj-cli-test-'));
        const tmpConfigPath = path.join(tmpDir, 'config.json');
        const prevEnv = process.env.CONTEXT_DJ_CONFIG;
        const origFetch = globalThis.fetch;
        process.env.CONTEXT_DJ_CONFIG = tmpConfigPath;

        try {
            let fetchCount = 0;
            globalThis.fetch = (async () => {
                fetchCount++;
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        access_token: 'fresh_cli_token_999',
                        token_type: 'Bearer',
                        scope: 'streaming',
                        expires_in: 3600,
                        refresh_token: 'rotated_refresh_token',
                    }),
                } as unknown as Response;
            }) as typeof fetch;

            const config: CLIConfig = {
                spotifyClientId: 'cli_client',
                spotifyRefreshToken: 'initial_refresh',
                spotifyAccessToken: 'expired_token',
                spotifyExpiresAt: Date.now() - 5000,
                aiProvider: 'gemini',
                aiApiKey: 'key_123',
            };

            const token1 = await getValidSpotifyToken(config);
            assert.strictEqual(token1, 'fresh_cli_token_999');
            assert.strictEqual(fetchCount, 1);
            // In-memory config must also be updated so subsequent calls don't re-fetch unnecessarily
            assert.strictEqual(config.spotifyAccessToken, 'fresh_cli_token_999');
            assert.strictEqual(config.spotifyRefreshToken, 'rotated_refresh_token');
            assert.ok((config.spotifyExpiresAt ?? 0) > Date.now());

            // Second call uses updated in-memory token without hitting network again
            const token2 = await getValidSpotifyToken(config);
            assert.strictEqual(token2, 'fresh_cli_token_999');
            assert.strictEqual(fetchCount, 1);

            const diskConfig = loadConfig();
            assert.strictEqual(diskConfig?.spotifyAccessToken, 'fresh_cli_token_999');
        } finally {
            globalThis.fetch = origFetch;
            if (prevEnv === undefined) {
                delete process.env.CONTEXT_DJ_CONFIG;
            } else {
                process.env.CONTEXT_DJ_CONFIG = prevEnv;
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
