import { v4 as uuidv4 } from 'uuid';
import { STORAGE_KEYS } from '../lib/constants';

const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';

interface TokenResponse {
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token: string;
    scope: string;
}

export class SpotifyAuth {
    static getRedirectUri() {
        if (typeof window !== 'undefined') {
            // Remove query params and hash to get the base app URL
            const url = new URL(window.location.href);
            return `${url.origin}${url.pathname}`;
        }
        return '';
    }

    // Generate a random string for code verifier
    private static generateCodeVerifier(length: number) {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
        for (let i = 0; i < length; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    // Hash the code verifier to create code challenge
    private static async generateCodeChallenge(codeVerifier: string) {
        const encoder = new TextEncoder();
        const data = encoder.encode(codeVerifier);
        const digest = await window.crypto.subtle.digest('SHA-256', data);

        // Convert array buffer to base64url string
        return btoa(String.fromCharCode(...new Uint8Array(digest)))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
    }

    // Initiate Login Flow
    static async login(clientId: string) {
        const codeVerifier = this.generateCodeVerifier(128);
        const codeChallenge = await this.generateCodeChallenge(codeVerifier);
        const state = uuidv4();
        const scope = [
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

        // Store verifier and state locally to verify later
        localStorage.setItem(STORAGE_KEYS.SPOTIFY_VERIFIER, codeVerifier);
        localStorage.setItem('spotify_auth_state', state);

        const args = new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            scope: scope,
            redirect_uri: this.getRedirectUri(),
            state: state,
            code_challenge_method: 'S256',
            code_challenge: codeChallenge,
        });

        window.location.href = `${SPOTIFY_AUTH_URL}?${args}`;
    }

    // Handle Callback from Spotify
    static async handleCallback(clientId: string, code: string): Promise<string | null> {
        const codeVerifier = localStorage.getItem(STORAGE_KEYS.SPOTIFY_VERIFIER);
        const redirectUri = this.getRedirectUri();

        if (!codeVerifier) {
            console.error('No code verifier found');
            return null;
        }

        try {
            const response = await fetch(SPOTIFY_TOKEN_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    code: code,
                    redirect_uri: redirectUri,
                    client_id: clientId,
                    code_verifier: codeVerifier,
                }),
            });

            const data: TokenResponse = await response.json();

            if (data.access_token) {
                this.setSession(data);
                return data.access_token;
            }
        } catch (error) {
            console.error('Error fetching token:', error);
        }
        return null;
    }

    // Refresh Token
    static async refreshToken(clientId: string): Promise<string | null> {
        const refreshToken = localStorage.getItem(STORAGE_KEYS.SPOTIFY_REFRESH_TOKEN);
        if (!refreshToken) return null;

        try {
            const response = await fetch(SPOTIFY_TOKEN_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken,
                    client_id: clientId,
                }),
            });

            const data = await response.json();
            if (data.access_token) {
                this.setSession(data);
                return data.access_token;
            }
        } catch (error) {
            console.error('Error refreshing token:', error);
        }
        return null;
    }

    private static setSession(data: any) {
        const expiresAt = Date.now() + data.expires_in * 1000;
        localStorage.setItem(STORAGE_KEYS.SPOTIFY_ACCESS_TOKEN, data.access_token);
        localStorage.setItem(STORAGE_KEYS.SPOTIFY_EXPIRES_AT, expiresAt.toString());
        if (data.refresh_token) {
            localStorage.setItem(STORAGE_KEYS.SPOTIFY_REFRESH_TOKEN, data.refresh_token);
        }
    }

    static getAccessToken() {
        if (typeof window === 'undefined') return null;
        return localStorage.getItem(STORAGE_KEYS.SPOTIFY_ACCESS_TOKEN);
    }

    static isAuthenticated() {
        if (typeof window === 'undefined') return false;
        const token = localStorage.getItem(STORAGE_KEYS.SPOTIFY_ACCESS_TOKEN);
        const expiresAt = localStorage.getItem(STORAGE_KEYS.SPOTIFY_EXPIRES_AT);

        if (!token || !expiresAt) return false;

        return Date.now() < parseInt(expiresAt);
    }

    static logout() {
        if (typeof window === 'undefined') return;
        localStorage.removeItem(STORAGE_KEYS.SPOTIFY_ACCESS_TOKEN);
        localStorage.removeItem(STORAGE_KEYS.SPOTIFY_EXPIRES_AT);
        localStorage.removeItem(STORAGE_KEYS.SPOTIFY_REFRESH_TOKEN);
        localStorage.removeItem(STORAGE_KEYS.SPOTIFY_VERIFIER);
        localStorage.removeItem('spotify_auth_state');
    }
}
