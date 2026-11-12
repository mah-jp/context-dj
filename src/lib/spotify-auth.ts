import { v4 as uuidv4 } from 'uuid';
import { STORAGE_KEYS, SPOTIFY_AUTH_CONSTANTS } from '../lib/constants';
import { getStorageItem, setStorageItem, removeStorageItem } from './storage';
import { clearSpotifySessionStorage, notifySpotifyAuthStateChanged } from './settings-sync';

interface TokenResponse {
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token?: string;
    scope?: string;
}

/**
 * Resolves the canonical root callback URL for Spotify OAuth PKCE.
 * Strips query/hash, `/index.html`, and `/settings` suffixes, and normalizes trailing slash
 * to match Next.js `trailingSlash: true` static export across both root (`/`) and subpath (`/context-dj/`).
 */
export function resolveCanonicalRedirectUri(href: string): string {
    if (!href) return '';
    try {
        const url = new URL(href);
        let basePath = url.pathname
            .replace(/\/index\.html$/i, '/')
            .replace(/\/settings(?:\/index\.html)?\/?$/i, '/');
        if (!basePath.endsWith('/')) {
            basePath += '/';
        }
        return `${url.origin}${basePath}`;
    } catch {
        return '';
    }
}

export class SpotifyAuth {
    private static lastError: string | null = null;

    static getLastError(): string | null {
        return this.lastError;
    }

    static clearLastError(): void {
        this.lastError = null;
    }

    static getRedirectUri() {
        if (typeof window !== 'undefined' && window.location?.href) {
            return resolveCanonicalRedirectUri(window.location.href);
        }
        return '';
    }

    // Generate a cryptographically secure random string for PKCE code verifier
    private static generateCodeVerifier(length: number): string {
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
        const randomValues = new Uint8Array(length);
        const cryptoObj = (typeof window !== 'undefined' && window.crypto)
            ? window.crypto
            : globalThis.crypto;

        if (typeof cryptoObj?.getRandomValues === 'function') {
            cryptoObj.getRandomValues(randomValues);
        } else {
            for (let i = 0; i < length; i++) {
                randomValues[i] = Math.floor(Math.random() * 256);
            }
        }

        let text = '';
        for (let i = 0; i < length; i++) {
            text += possible.charAt(randomValues[i] % possible.length);
        }
        return text;
    }

    // Hash the code verifier to create code challenge
    private static async generateCodeChallenge(codeVerifier: string): Promise<string> {
        const encoder = new TextEncoder();
        const data = encoder.encode(codeVerifier);
        const subtle = (typeof window !== 'undefined' && window.crypto?.subtle)
            ? window.crypto.subtle
            : globalThis.crypto.subtle;
        const digest = await subtle.digest('SHA-256', data);

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
        const scope = SPOTIFY_AUTH_CONSTANTS.SCOPES.join(' ');

        // Store verifier and state locally to verify later
        setStorageItem(STORAGE_KEYS.SPOTIFY_VERIFIER, codeVerifier);
        setStorageItem(STORAGE_KEYS.SPOTIFY_AUTH_STATE, state);

        const args = new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            scope: scope,
            redirect_uri: this.getRedirectUri(),
            state: state,
            code_challenge_method: 'S256',
            code_challenge: codeChallenge,
        });

        window.location.href = `${SPOTIFY_AUTH_CONSTANTS.AUTH_URL}?${args}`;
    }

    // Handle Callback from Spotify
    static async handleCallback(clientId: string, code: string, returnedState?: string | null): Promise<string | null> {
        this.lastError = null;
        const codeVerifier = getStorageItem(STORAGE_KEYS.SPOTIFY_VERIFIER, '');
        const savedState = getStorageItem(STORAGE_KEYS.SPOTIFY_AUTH_STATE, '');
        const redirectUri = this.getRedirectUri();

        if (!codeVerifier) {
            this.lastError = 'Spotify login verifier missing or expired. Please try logging in again. (ログイン検証情報が見つかりません。もう一度ログインしてください)';
            console.error('No code verifier found');
            return null;
        }

        if (savedState && (!returnedState || savedState !== returnedState)) {
            this.lastError = 'Spotify OAuth state mismatch. Please try logging in again. (認証状態の一致確認に失敗しました。もう一度ログインしてください)';
            console.error('OAuth state mismatch. Possible CSRF attempt.');
            return null;
        }

        try {
            const response = await fetch(SPOTIFY_AUTH_CONSTANTS.TOKEN_URL, {
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

            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                let detail = errText;
                try {
                    const parsed = JSON.parse(errText) as { error_description?: string; error?: string };
                    detail = parsed.error_description || parsed.error || errText;
                } catch {
                    // Keep raw text when response is not JSON
                }
                const cleanDetail = detail.replace(/\s+/g, ' ').trim();
                this.lastError = `Spotify token exchange failed (${response.status}${cleanDetail ? `: ${cleanDetail}` : ''}). Please check Client ID and Redirect URI (${redirectUri}). (Spotify認証に失敗しました[${response.status}]。Client IDとRedirect URIの設定を確認してください)`;
                console.error(`Error fetching token (${response.status}):`, errText);
                return null;
            }

            const data: TokenResponse = await response.json();

            if (data.access_token) {
                this.setSession(data);
                removeStorageItem(STORAGE_KEYS.SPOTIFY_VERIFIER);
                removeStorageItem(STORAGE_KEYS.SPOTIFY_AUTH_STATE);
                return data.access_token;
            }
            this.lastError = 'Spotify token response did not contain an access token. (アクセストークンを取得できませんでした)';
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.lastError = `Network error during Spotify authentication: ${detail} (Spotify認証中に通信エラーが発生しました)`;
            console.error('Error fetching token:', error);
        }
        return null;
    }

    // Refresh Token
    static async refreshToken(clientId: string): Promise<string | null> {
        const refreshToken = getStorageItem(STORAGE_KEYS.SPOTIFY_REFRESH_TOKEN, '');
        if (!refreshToken) return null;

        try {
            const response = await fetch(SPOTIFY_AUTH_CONSTANTS.TOKEN_URL, {
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

            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                console.error(`Error refreshing token (${response.status}):`, errText);
                return null;
            }

            const data: TokenResponse = await response.json();
            if (data.access_token) {
                this.setSession(data);
                return data.access_token;
            }
        } catch (error) {
            console.error('Error refreshing token:', error);
        }
        return null;
    }

    private static setSession(data: TokenResponse) {
        const expiresAt = Date.now() + data.expires_in * 1000;
        setStorageItem(STORAGE_KEYS.SPOTIFY_ACCESS_TOKEN, data.access_token);
        setStorageItem(STORAGE_KEYS.SPOTIFY_EXPIRES_AT, expiresAt.toString());
        if (data.refresh_token) {
            setStorageItem(STORAGE_KEYS.SPOTIFY_REFRESH_TOKEN, data.refresh_token);
        }
        notifySpotifyAuthStateChanged();
    }

    static getAccessToken(): string | null {
        return getStorageItem(STORAGE_KEYS.SPOTIFY_ACCESS_TOKEN, '') || null;
    }

    static isAuthenticated() {
        const token = getStorageItem(STORAGE_KEYS.SPOTIFY_ACCESS_TOKEN, '');
        const expiresAt = getStorageItem(STORAGE_KEYS.SPOTIFY_EXPIRES_AT, '');

        if (!token || !expiresAt) return false;

        return Date.now() < parseInt(expiresAt);
    }

    static logout() {
        clearSpotifySessionStorage();
    }
}
