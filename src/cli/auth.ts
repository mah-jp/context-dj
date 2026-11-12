import crypto from 'node:crypto';
import readline from 'node:readline';
import { saveConfig, CLIConfig } from './config';
import { SPOTIFY_AUTH_CONSTANTS } from '../lib/constants';

const SPOTIFY_AUTH_URL = SPOTIFY_AUTH_CONSTANTS.AUTH_URL;
const SPOTIFY_TOKEN_URL = SPOTIFY_AUTH_CONSTANTS.TOKEN_URL;
export const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:8888/callback';

const SCOPES = SPOTIFY_AUTH_CONSTANTS.SCOPES.join(' ');

function generateCodeVerifier(length = 128): string {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    let text = '';
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) {
        text += possible.charAt(bytes[i] % possible.length);
    }
    return text;
}

function generateCodeChallenge(verifier: string): string {
    return crypto
        .createHash('sha256')
        .update(verifier)
        .digest('base64url');
}

export function extractCodeFromInput(input: string, expectedState?: string): string {
    const trimmed = input.trim();
    if (!trimmed) return '';

    const looksLikeUrl = /^https?:\/\//i.test(trimmed);
    if (!looksLikeUrl && !trimmed.includes('?') && !trimmed.includes('&') && !trimmed.includes('=')) {
        return trimmed;
    }
    try {
        // If user pasted a full URL or query string
        const parsedUrl = new URL(looksLikeUrl ? trimmed : `http://${trimmed}`);
        const oauthError = parsedUrl.searchParams.get('error');
        if (oauthError) {
            throw new Error(`Spotify authorization failed: ${oauthError}`);
        }
        const returnedState = parsedUrl.searchParams.get('state');
        if (expectedState && (looksLikeUrl ? returnedState !== expectedState : (returnedState !== null && returnedState !== expectedState))) {
            throw new Error('Spotify OAuth state mismatch. Please restart setup and paste the latest callback URL.');
        }
        const code = parsedUrl.searchParams.get('code');
        if (code) return code;
        if (looksLikeUrl) return '';
    } catch (err) {
        if (err instanceof Error && err.message.startsWith('Spotify ')) {
            throw err;
        }
        // Fallback regex match for code=...
        const match = trimmed.match(/[?&]code=([^&\s]+)/);
        if (match && match[1]) {
            return decodeURIComponent(match[1]);
        }
        if (looksLikeUrl) return '';
    }
    return trimmed;
}

function promptLine(promptText: string): Promise<string> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise((resolve) => {
        rl.question(promptText, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}

function formatSpotifyTokenError(prefix: string, status: number, errorText: string): string {
    let detail = errorText.trim();
    try {
        const parsed = JSON.parse(errorText) as { error?: string; error_description?: string };
        if (parsed.error_description || parsed.error) {
            detail = [parsed.error, parsed.error_description].filter(Boolean).join(': ');
        }
    } catch {
        // Keep raw text when response body is not JSON
    }
    return `${prefix} (HTTP ${status}${detail ? ` - ${detail}` : ''})`;
}

/**
 * Runs Approach A: Displays the auth URL in terminal and accepts the redirected URL or code from the user.
 */
export async function runTerminalAuth(clientId: string, redirectUri: string = DEFAULT_REDIRECT_URI): Promise<CLIConfig> {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = crypto.randomBytes(16).toString('hex');

    const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        scope: SCOPES,
        redirect_uri: redirectUri,
        state: state,
        code_challenge_method: 'S256',
        code_challenge: codeChallenge,
    });

    const authUrl = `${SPOTIFY_AUTH_URL}?${params.toString()}`;

    console.log('\n' + '━'.repeat(64));
    console.log('  Spotify Authorization (Headless / Terminal Flow)');
    console.log('━'.repeat(64));
    console.log('\n1. Open this URL in your local browser:\n');
    console.log(`   \x1b[36m${authUrl}\x1b[0m\n`);
    console.log('2. Log in and click "Agree".');
    console.log(`3. You will be redirected to a URL starting with:\n   ${redirectUri}`);
    console.log('   (The browser page might show "Unable to connect" - this is completely normal!)\n');
    console.log('4. Copy the ENTIRE redirected URL (or just the code value) from your address bar.\n');

    const userInput = await promptLine('Paste redirected URL or code here: ');
    const code = extractCodeFromInput(userInput, state);

    if (!code) {
        throw new Error('No authorization code provided. Authorization aborted.');
    }

    console.log('\nExchanging authorization code for tokens...');

    const bodyParams = new URLSearchParams({
        client_id: clientId,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
    });

    const res = await fetch(SPOTIFY_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: bodyParams.toString(),
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(formatSpotifyTokenError('Spotify token exchange failed', res.status, errorText));
    }

    const data = await res.json() as {
        access_token: string;
        token_type: string;
        scope: string;
        expires_in: number;
        refresh_token?: string;
    };

    const expiresAt = Date.now() + (data.expires_in - 60) * 1000;

    const updated = saveConfig({
        spotifyClientId: clientId,
        spotifyAccessToken: data.access_token,
        spotifyRefreshToken: data.refresh_token,
        spotifyExpiresAt: expiresAt
    });

    console.log('\x1b[32m✔ Spotify authorization successful! Tokens saved.\x1b[0m\n');
    return updated;
}

/**
 * Returns a valid Spotify Access Token, refreshing it if expired.
 */
export async function getValidSpotifyToken(config: CLIConfig): Promise<string> {
    if (!config.spotifyClientId || !config.spotifyRefreshToken) {
        throw new Error('Spotify configuration missing. Please run setup first.');
    }

    const now = Date.now();
    // If current token is still valid with at least 60s margin, return it
    if (config.spotifyAccessToken && config.spotifyExpiresAt && config.spotifyExpiresAt > now) {
        return config.spotifyAccessToken;
    }

    // Refresh token
    const bodyParams = new URLSearchParams({
        client_id: config.spotifyClientId,
        grant_type: 'refresh_token',
        refresh_token: config.spotifyRefreshToken,
    });

    const res = await fetch(SPOTIFY_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: bodyParams.toString(),
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(formatSpotifyTokenError('Failed to refresh Spotify access token', res.status, errorText));
    }

    const data = await res.json() as {
        access_token: string;
        token_type: string;
        scope: string;
        expires_in: number;
        refresh_token?: string;
    };

    const expiresAt = Date.now() + (data.expires_in - 60) * 1000;
    const nextRefreshToken = data.refresh_token || config.spotifyRefreshToken;

    config.spotifyAccessToken = data.access_token;
    config.spotifyRefreshToken = nextRefreshToken;
    config.spotifyExpiresAt = expiresAt;

    saveConfig({
        spotifyAccessToken: data.access_token,
        spotifyRefreshToken: nextRefreshToken,
        spotifyExpiresAt: expiresAt
    });

    return data.access_token;
}
