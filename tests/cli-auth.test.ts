import { test, describe } from 'node:test';
import assert from 'node:assert';
import { extractCodeFromInput } from '../src/cli/auth';
import { isConfigured, CLIConfig } from '../src/cli/config';

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
});
