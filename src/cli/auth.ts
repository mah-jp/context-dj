import crypto from 'node:crypto';
import readline from 'node:readline';
import { loadConfig, saveConfig, CLIConfig } from './config';

const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
export const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:8888/callback';

const SCOPES = [
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
    'streaming',
    'app-remote-control',
    'playlist-read-private',
    'user-read-email',
    'user-read-private',
    'user-library-read',
    'user-library-modify'
].join(' ');

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

export function extractCodeFromInput(input: string): string {
    const trimmed = input.trim();
    if (!trimmed.includes('?') && !trimmed.includes('&') && !trimmed.includes('=')) {
        return trimmed;
    }
    try {
        // If user pasted a full URL
        const parsedUrl = new URL(trimmed.startsWith('http') ? trimmed : `http://${trimmed}`);
        const code = parsedUrl.searchParams.get('code');
        if (code) return code;
    } catch {
        // Fallback regex match for code=...
        const match = trimmed.match(/[?&]code=([^&\s]+)/);
        if (match && match[1]) {
            return decodeURIComponent(match[1]);
        }
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
    const code = extractCodeFromInput(userInput);

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
        throw new Error(`Spotify token exchange failed (${res.status}): ${errorText}`);
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
        throw new Error(`Failed to refresh Spotify access token (${res.status}): ${errorText}`);
    }

    const data = await res.json() as {
        access_token: string;
        token_type: string;
        scope: string;
        expires_in: number;
        refresh_token?: string;
    };

    const expiresAt = Date.now() + (data.expires_in - 60) * 1000;

    saveConfig({
        spotifyAccessToken: data.access_token,
        spotifyRefreshToken: data.refresh_token || config.spotifyRefreshToken,
        spotifyExpiresAt: expiresAt
    });

    return data.access_token;
}
