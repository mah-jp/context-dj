import SpotifyWebApi from 'spotify-web-api-js';
import {
    SpotifyApiErrorInfo,
    SpotifyControlResult,
    SpotifyQueueItem,
    SpotifyQueueResponse,
    Track,
} from './types';

/**
 * Classifies Spotify Web API HTTP status codes into actionable, bilingual user feedback.
 */
export function classifySpotifyError(
    status: number | undefined,
    operation: string,
    retryAfterHeader?: string | null,
    detail?: string
): SpotifyApiErrorInfo {
    const parsedRetry = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
    const retryAfterSeconds = Number.isFinite(parsedRetry) && parsedRetry > 0 ? parsedRetry : undefined;

    if (status === 401) {
        return {
            status: 401,
            category: 'auth_expired',
            operation,
            message: `Spotify session expired (401) during ${operation}. Refreshing token or please re-login. (Spotify認証トークンの有効期限が切れました[401]。再ログインまたは更新が必要です)`,
        };
    }

    if (status === 403) {
        return {
            status: 403,
            category: 'forbidden',
            operation,
            message: `Spotify operation "${operation}" restricted (403). Spotify Premium is required, or the active device does not allow remote control. (操作が制限されています[403]。Spotify Premiumが必要か、対象デバイスが操作を受け付けていません)`,
        };
    }

    if (status === 404) {
        return {
            status: 404,
            category: 'device_not_found',
            operation,
            message: `Spotify device not found or asleep (404) during ${operation}. Please open Spotify and play a track to wake the device. (再生デバイスが見つからないかスリープ中です[404]。Spotifyアプリを開いてください)`,
        };
    }

    if (status === 429) {
        const waitHint = retryAfterSeconds ? ` (Retry after ${retryAfterSeconds}s)` : '';
        return {
            status: 429,
            category: 'rate_limited',
            operation,
            retryAfterSeconds,
            message: `Spotify API rate limit reached (429) during ${operation}${waitHint}. Please wait a moment. (Spotify APIのレート制限に達しました[429]。しばらく待ってから再試行してください)`,
        };
    }

    const statusSuffix = status ? ` (${status})` : '';
    const detailSuffix = detail ? `: ${detail}` : '';
    return {
        status,
        category: 'network_or_server',
        operation,
        message: `Spotify API error during ${operation}${statusSuffix}${detailSuffix}. (Spotify通信エラーが発生しました)`,
    };
}

/**
 * Extracts HTTP status and headers from errors thrown by `spotify-web-api-js` (XMLHttpRequest)
 * or standard fetch/Error objects, returning a classified `SpotifyApiErrorInfo` when an HTTP status >= 400 is present.
 */
export function classifyThrownSpotifyError(
    err: unknown,
    operation: string
): SpotifyApiErrorInfo | null {
    if (!err || typeof err !== 'object') return null;
    const maybeErr = err as {
        status?: unknown;
        statusCode?: unknown;
        statusText?: unknown;
        message?: unknown;
        getResponseHeader?: (name: string) => string | null;
        headers?: { get?: (name: string) => string | null };
    };
    const rawStatus =
        typeof maybeErr.status === 'number'
            ? maybeErr.status
            : typeof maybeErr.statusCode === 'number'
                ? maybeErr.statusCode
                : undefined;

    if (!rawStatus || rawStatus < 400) return null;

    const retryAfter =
        (typeof maybeErr.getResponseHeader === 'function' ? maybeErr.getResponseHeader('Retry-After') : null) ??
        (typeof maybeErr.headers?.get === 'function' ? maybeErr.headers.get('Retry-After') : null) ??
        null;
    const detail =
        typeof maybeErr.statusText === 'string' && maybeErr.statusText
            ? maybeErr.statusText
            : typeof maybeErr.message === 'string'
                ? maybeErr.message
                : undefined;

    return classifySpotifyError(rawStatus, operation, retryAfter, detail);
}

/**
 * Handles low-level Spotify Connect REST API interactions (device discovery,
 * typed queue retrieval, playback transfer, shuffle/repeat control, and 204-safe transport commands).
 */
export class SpotifyPlayerClient {
    private spotify: SpotifyWebApi.SpotifyWebApiJs;
    private activeDeviceId: string | null = null;
    private onError?: (error: SpotifyApiErrorInfo) => void;
    private lastError: SpotifyApiErrorInfo | null = null;
    private lastNotifiedErrorMap = new Map<string, number>();

    constructor(
        spotify: SpotifyWebApi.SpotifyWebApiJs,
        onError?: (error: SpotifyApiErrorInfo) => void
    ) {
        this.spotify = spotify;
        this.onError = onError;
    }

    setErrorHandler(cb: (error: SpotifyApiErrorInfo) => void) {
        this.onError = cb;
    }

    getLastError(): SpotifyApiErrorInfo | null {
        return this.lastError;
    }

    clearLastError() {
        this.lastError = null;
    }

    private notifyError(error: SpotifyApiErrorInfo, throttleMs: number = 0) {
        this.lastError = error;
        if (throttleMs > 0) {
            const key = `${error.category}:${error.operation}`;
            const now = Date.now();
            const lastTime = this.lastNotifiedErrorMap.get(key) ?? 0;
            if (now - lastTime < throttleMs) {
                return;
            }
            this.lastNotifiedErrorMap.set(key, now);
        }
        if (this.onError) {
            this.onError(error);
        }
    }

    reportThrownError(
        err: unknown,
        operation: string,
        options?: { throttleMs?: number }
    ): SpotifyApiErrorInfo | null {
        const classified = classifyThrownSpotifyError(err, operation);
        if (classified) {
            this.notifyError(classified, options?.throttleMs ?? 0);
        }
        return classified;
    }

    getActiveDeviceId(): string | null {
        return this.activeDeviceId;
    }

    syncActiveDeviceId(deviceId: string | null) {
        if (deviceId && this.activeDeviceId !== deviceId) {
            this.activeDeviceId = deviceId;
        }
    }

    async getDevices(): Promise<SpotifyApi.UserDevice[]> {
        try {
            const response = await this.spotify.getMyDevices();
            return response.devices;
        } catch (e) {
            this.reportThrownError(e, 'get_devices', { throttleMs: 10000 });
            console.warn("Failed to fetch devices:", e);
            return [];
        }
    }

    /**
     * Fetches the user's playback queue from `/v1/me/player/queue` with full type safety,
     * hiding `spotify-web-api-js`'s untyped `getGeneric` method.
     */
    async getUserQueue(): Promise<SpotifyQueueResponse> {
        try {
            const response = await this.spotify.getGeneric('https://api.spotify.com/v1/me/player/queue') as {
                currently_playing?: SpotifyQueueItem | null;
                queue?: SpotifyQueueItem[];
            } | null;

            const rawQueue = Array.isArray(response?.queue) ? response.queue : [];
            const tracks = rawQueue.filter((item): item is Track => item?.type === 'track');
            const currentlyPlaying = response?.currently_playing?.type === 'track'
                ? (response.currently_playing as Track)
                : null;

            return {
                currently_playing: currentlyPlaying,
                queue: tracks,
            };
        } catch (e) {
            this.reportThrownError(e, 'get_queue', { throttleMs: 10000 });
            console.warn('Failed to fetch user queue:', e);
            return {
                currently_playing: null,
                queue: [],
            };
        }
    }

    async setActiveDevice(deviceId: string): Promise<SpotifyControlResult> {
        const prevDeviceId = this.activeDeviceId;
        this.activeDeviceId = deviceId;
        console.log(`📱 Active device set to: ${deviceId}`);

        const token = this.spotify.getAccessToken();
        if (!token) {
            this.activeDeviceId = prevDeviceId;
            return { ok: false };
        }

        try {
            const res = await fetch('https://api.spotify.com/v1/me/player', {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ device_ids: [deviceId] })
            });

            if (!res.ok && res.status !== 204) {
                this.activeDeviceId = prevDeviceId;
                const retryAfter = res.headers?.get?.('Retry-After');
                const errInfo = classifySpotifyError(res.status, 'transfer_device', retryAfter, res.statusText);
                console.warn(`Transfer playback failed: ${res.status} - ${errInfo.message}`);
                this.notifyError(errInfo);
                return { ok: false, status: res.status, error: errInfo };
            }

            console.log(`📱 Playback transferred to ${deviceId}`);
            return { ok: true, status: res.status };
        } catch (e) {
            this.activeDeviceId = prevDeviceId;
            const detail = e instanceof Error ? e.message : String(e);
            const errInfo = classifySpotifyError(undefined, 'transfer_device', null, detail);
            console.error("Failed to transfer playback:", e);
            this.notifyError(errInfo);
            return { ok: false, error: errInfo };
        }
    }

    async resolveTargetDevice(): Promise<string> {
        let deviceId: string | null = this.activeDeviceId;

        for (let attempt = 0; attempt < 3; attempt++) {
            if (deviceId) break;

            let devices: SpotifyApi.UserDevicesResponse;
            try {
                devices = await this.spotify.getMyDevices();
            } catch (e) {
                this.reportThrownError(e, 'resolve_device');
                throw e;
            }
            console.log(`📱 Devices found (attempt ${attempt + 1}):`, devices.devices.map(d => `${d.name} (${d.type}, ${d.is_active ? 'Active' : 'Inactive'})`));

            const activeDevice = devices.devices.find(d => d.is_active);
            deviceId = activeDevice?.id || devices.devices[0]?.id || null;

            if (deviceId) {
                this.activeDeviceId = deviceId;
                break;
            }

            await new Promise(r => setTimeout(r, 1000));
        }

        if (!deviceId) {
            throw new Error("No active device found after retries. Please open Spotify. (再生デバイスが見つかりません。スマホまたはPCでSpotifyを開いてください)");
        }

        return deviceId;
    }

    async startPlaybackOnDevice(deviceId: string, uris: string[]) {
        const token = this.spotify.getAccessToken();
        if (!token) throw new Error("No access token available");

        // Disable shuffle before playing to ensure priority track and story order are respected
        try {
            await fetch(`https://api.spotify.com/v1/me/player/shuffle?state=false&device_id=${deviceId}`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            console.log('🔀 Shuffle disabled');
        } catch (e) {
            console.warn('Disable shuffle failed:', e);
        }

        const playUrl = `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`;
        const playBody = JSON.stringify({ uris });

        const res = await fetch(playUrl, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: playBody
        });

        if (!res.ok) {
            const errText = await res.text().catch(() => 'No error details');
            const retryAfter = res.headers?.get?.('Retry-After');
            const errInfo = classifySpotifyError(res.status, 'play', retryAfter, res.statusText);
            console.error(`Spotify Play API Error: ${res.status} ${res.statusText}`, errText);
            this.notifyError(errInfo);
            throw new Error(`Spotify Play Failed: ${res.statusText} (${errInfo.message})`);
        }
        console.log('▶️ Playback started successfully (Fetch)');

        // Ensure repeat is off after a short delay to let playback context establish
        setTimeout(async () => {
            const repeatUrl = `https://api.spotify.com/v1/me/player/repeat?state=off&device_id=${deviceId}`;
            try {
                await fetch(repeatUrl, {
                    method: 'PUT',
                    headers: { 'Authorization': `Bearer ${token}` }
                });
            } catch (e) {
                console.warn('Set repeat mode failed (non-critical):', e);
            }
        }, 500);
    }

    async safeControlRequest(endpoint: string, method: 'POST' | 'PUT', body?: unknown): Promise<SpotifyControlResult> {
        const token = this.spotify.getAccessToken();
        if (!token) return { ok: false };
        const operationName = endpoint.split('?')[0] || endpoint;

        try {
            const res = await fetch(`https://api.spotify.com/v1/me/player/${endpoint}`, {
                method,
                headers: { 'Authorization': `Bearer ${token}` },
                ...(body ? { body: JSON.stringify(body), headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } } : {})
            });
            if (!res.ok && res.status !== 204) {
                const retryAfter = res.headers?.get?.('Retry-After');
                const errInfo = classifySpotifyError(res.status, operationName, retryAfter, res.statusText);
                console.warn(`Control request ${endpoint} failed: ${res.status} - ${errInfo.message}`);
                this.notifyError(errInfo);
                return { ok: false, status: res.status, error: errInfo };
            }
            return { ok: true, status: res.status };
        } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            const errInfo = classifySpotifyError(undefined, operationName, null, detail);
            console.error(`Control request ${endpoint} error:`, e);
            this.notifyError(errInfo);
            return { ok: false, error: errInfo };
        }
    }

    async addToQueue(uri: string) {
        return this.safeControlRequest(`queue?uri=${encodeURIComponent(uri)}`, 'POST');
    }

    async next() { return this.safeControlRequest('next', 'POST'); }
    async previous() { return this.safeControlRequest('previous', 'POST'); }
    async pause() { return this.safeControlRequest('pause', 'PUT'); }
    async resume() { return this.safeControlRequest('play', 'PUT'); }
}

