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

export interface BrowserEnvironmentHint {
    userAgent?: string;
    maxTouchPoints?: number;
    userAgentDataMobile?: boolean;
}

/**
 * Detects whether the current runtime is a smartphone or tablet browser
 * (including iPadOS desktop-class Safari via Macintosh UA + multi-touch).
 */
export function isMobileBrowserEnvironment(env?: BrowserEnvironmentHint): boolean {
    if (env) {
        if (env.userAgentDataMobile === true) return true;
        const ua = env.userAgent || '';
        if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua)) {
            return true;
        }
        if (/Macintosh|MacIntel/i.test(ua) && (env.maxTouchPoints ?? 0) > 1) {
            return true;
        }
        return false;
    }
    if (typeof navigator === 'undefined') return false;
    const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
    return isMobileBrowserEnvironment({
        userAgent: nav.userAgent || '',
        maxTouchPoints: nav.maxTouchPoints ?? 0,
        userAgentDataMobile: nav.userAgentData?.mobile,
    });
}

export interface SelectDeviceOptions {
    preferredDeviceId?: string | null;
    cachedActiveDeviceId?: string | null;
    isMobile?: boolean;
}

/**
 * Selects the best Spotify Connect target device.
 * - Filters out restricted devices (`is_restricted === true`), which reject all Web API commands.
 * - Honors an explicit user selection (`preferredDeviceId`) first.
 * - On mobile browsers, prioritizes unrestricted `Smartphone` (then `Tablet`) devices so
 *   switching from the mobile Spotify app to the mobile browser targets the phone itself
 *   even if Spotify Connect marked the phone inactive or kept a desktop client active.
 */
export function selectTargetSpotifyDevice(
    devices: SpotifyApi.UserDevice[],
    options: SelectDeviceOptions = {}
): SpotifyApi.UserDevice | null {
    if (!Array.isArray(devices) || devices.length === 0) return null;

    const withId = devices.filter(
        (d): d is SpotifyApi.UserDevice & { id: string } => Boolean(d && d.id)
    );
    if (withId.length === 0) return null;

    const unrestricted = withId.filter(d => !d.is_restricted);
    if (unrestricted.length === 0) return null;
    const pool = unrestricted;

    if (options.preferredDeviceId) {
        const preferred = pool.find(d => d.id === options.preferredDeviceId);
        if (preferred) return preferred;
    }

    if (options.isMobile && unrestricted.length > 0) {
        const activeSmartphone = unrestricted.find(
            d => d.type?.toLowerCase() === 'smartphone' && d.is_active
        );
        if (activeSmartphone) return activeSmartphone;

        const anySmartphone = unrestricted.find(
            d => d.type?.toLowerCase() === 'smartphone'
        );
        if (anySmartphone) return anySmartphone;

        const activeTablet = unrestricted.find(
            d => d.type?.toLowerCase() === 'tablet' && d.is_active
        );
        if (activeTablet) return activeTablet;

        const anyTablet = unrestricted.find(
            d => d.type?.toLowerCase() === 'tablet'
        );
        if (anyTablet) return anyTablet;
    }

    const cachedActive = options.cachedActiveDeviceId
        ? pool.find(d => d.id === options.cachedActiveDeviceId && d.is_active)
        : undefined;
    if (cachedActive) return cachedActive;

    const anyActive = pool.find(d => d.is_active);
    if (anyActive) return anyActive;

    const cachedAvailable = options.cachedActiveDeviceId
        ? pool.find(d => d.id === options.cachedActiveDeviceId)
        : undefined;
    if (cachedAvailable) return cachedAvailable;

    return pool[0] ?? null;
}

/**
 * Determines whether the silent HTMLAudioElement Keep-Alive loop must be suppressed
 * to prevent the mobile browser from stealing OS Audio Focus and pausing Spotify on the same device.
 */
export function shouldSuppressBackgroundKeepAlive(params: {
    isMobile: boolean;
    devices: SpotifyApi.UserDevice[];
    preferredDeviceId?: string | null;
    activeDeviceType?: string | null;
}): boolean {
    if (!params.isMobile) {
        return false;
    }

    if (params.activeDeviceType && /^(smartphone|tablet)$/i.test(params.activeDeviceType)) {
        return true;
    }

    const controllable = Array.isArray(params.devices)
        ? params.devices.filter(d => Boolean(d && d.id && !d.is_restricted))
        : [];
    if (controllable.length === 0) {
        return true;
    }

    if (params.preferredDeviceId) {
        const preferred = controllable.find(d => d.id === params.preferredDeviceId);
        if (preferred) {
            return /^(smartphone|tablet)$/i.test(preferred.type || '');
        }
    }

    // Without an explicit non-mobile preferred device, mobile browsers prioritize Smartphone/Tablet if present
    const hasMobileSpotifyDevice = controllable.some(d => /^(smartphone|tablet)$/i.test(d.type || ''));
    if (hasMobileSpotifyDevice) {
        return true;
    }

    const activeExternal = controllable.find(d => d.is_active);
    if (!activeExternal) {
        return true;
    }

    return /^(smartphone|tablet)$/i.test(activeExternal.type || '');
}

export interface SpotifyPlayerClientOptions {
    isMobile?: () => boolean;
    transferSettleDelayMs?: number;
    retryDelayMs?: number;
    devicePollDelayMs?: number;
}

/**
 * Handles low-level Spotify Connect REST API interactions (device discovery,
 * typed queue retrieval, playback transfer, shuffle/repeat control, and 204-safe transport commands).
 */
export class SpotifyPlayerClient {
    private spotify: SpotifyWebApi.SpotifyWebApiJs;
    private activeDeviceId: string | null = null;
    private preferredDeviceId: string | null = null;
    private lastResolvedDevice: SpotifyApi.UserDevice | null = null;
    private onError?: (error: SpotifyApiErrorInfo) => void;
    private lastError: SpotifyApiErrorInfo | null = null;
    private lastNotifiedErrorMap = new Map<string, number>();
    private options: SpotifyPlayerClientOptions;

    constructor(
        spotify: SpotifyWebApi.SpotifyWebApiJs,
        onError?: (error: SpotifyApiErrorInfo) => void,
        options: SpotifyPlayerClientOptions = {}
    ) {
        this.spotify = spotify;
        this.onError = onError;
        this.options = options;
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

    getPreferredDeviceId(): string | null {
        return this.preferredDeviceId;
    }

    syncActiveDeviceId(deviceId: string | null) {
        if (deviceId && this.activeDeviceId !== deviceId) {
            this.activeDeviceId = deviceId;
        }
    }

    private isMobileRuntime(): boolean {
        return this.options.isMobile
            ? this.options.isMobile()
            : isMobileBrowserEnvironment();
    }

    private delay(ms: number): Promise<void> {
        if (ms <= 0) return Promise.resolve();
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, ms);
            if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') {
                timer.unref();
            }
        });
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
        const prevPreferredId = this.preferredDeviceId;
        this.activeDeviceId = deviceId;
        this.preferredDeviceId = deviceId;
        console.log(`📱 Active device set to: ${deviceId}`);

        const token = this.spotify.getAccessToken();
        if (!token) {
            this.activeDeviceId = prevDeviceId;
            this.preferredDeviceId = prevPreferredId;
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
                this.preferredDeviceId = prevPreferredId;
                const retryAfter = res.headers?.get?.('Retry-After');
                const errInfo = classifySpotifyError(res.status, 'transfer_device', retryAfter, res.statusText);
                console.warn(`Transfer playback failed: ${res.status} - ${errInfo.message}`);
                this.notifyError(errInfo);
                return { ok: false, status: res.status, error: errInfo };
            }

            if (this.lastResolvedDevice?.id === deviceId) {
                this.lastResolvedDevice = { ...this.lastResolvedDevice, is_active: true };
            } else {
                this.lastResolvedDevice = null;
            }
            console.log(`📱 Playback transferred to ${deviceId}`);
            return { ok: true, status: res.status };
        } catch (e) {
            this.activeDeviceId = prevDeviceId;
            this.preferredDeviceId = prevPreferredId;
            const detail = e instanceof Error ? e.message : String(e);
            const errInfo = classifySpotifyError(undefined, 'transfer_device', null, detail);
            console.error("Failed to transfer playback:", e);
            this.notifyError(errInfo);
            return { ok: false, error: errInfo };
        }
    }

    async resolveTargetDevice(): Promise<string> {
        let resolved: SpotifyApi.UserDevice | null = null;
        const isMobile = this.isMobileRuntime();
        const pollDelayMs = this.options.devicePollDelayMs ?? 1000;

        for (let attempt = 0; attempt < 3; attempt++) {
            let devices: SpotifyApi.UserDevicesResponse;
            try {
                devices = await this.spotify.getMyDevices();
            } catch (e) {
                this.reportThrownError(e, 'resolve_device');
                throw e;
            }
            const list = Array.isArray(devices?.devices) ? devices.devices : [];
            console.log(
                `📱 Devices found (attempt ${attempt + 1}):`,
                list.map(d => `${d.name} (${d.type}, ${d.is_active ? 'Active' : 'Inactive'}${d.is_restricted ? ', Restricted' : ''})`)
            );

            const chosen = selectTargetSpotifyDevice(list, {
                preferredDeviceId: this.preferredDeviceId,
                cachedActiveDeviceId: this.activeDeviceId,
                isMobile,
            });

            if (chosen?.id) {
                resolved = chosen;
                this.activeDeviceId = chosen.id;
                this.lastResolvedDevice = chosen;
                break;
            }

            await this.delay(pollDelayMs);
        }

        if (!resolved?.id) {
            this.activeDeviceId = null;
            this.lastResolvedDevice = null;
            const errInfo = classifySpotifyError(404, 'resolve_device');
            this.notifyError(errInfo);
            throw new Error("No active device found after retries. Please open Spotify. (再生デバイスが見つかりません。スマホまたはPCでSpotifyを開いてください)");
        }

        return resolved.id;
    }

    private async transferPlaybackQuietly(deviceId: string, token: string): Promise<boolean> {
        try {
            const res = await fetch('https://api.spotify.com/v1/me/player', {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ device_ids: [deviceId], play: false }),
            });
            return Boolean(res.ok || res.status === 204 || res.status === 202);
        } catch (e) {
            console.warn(`Quiet pre-transfer to ${deviceId} failed (continuing to play):`, e);
            return false;
        }
    }

    async startPlaybackOnDevice(deviceId: string, uris: string[]) {
        const token = this.spotify.getAccessToken();
        if (!token) throw new Error("No access token available");

        // When targeting an inactive Connect device (especially a backgrounded mobile Smartphone),
        // pre-transfer the Connect session with play:false so `{ uris }` is accepted cleanly without resuming old context.
        if (this.lastResolvedDevice?.id === deviceId && !this.lastResolvedDevice.is_active) {
            const transferred = await this.transferPlaybackQuietly(deviceId, token);
            if (transferred) {
                await this.delay(this.options.transferSettleDelayMs ?? 350);
            }
        }

        const playBody = uris.length > 0 ? JSON.stringify({ uris }) : undefined;
        const executePlay = async (targetId: string, bearerToken: string) => {
            const playUrl = `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(targetId)}`;
            return fetch(playUrl, {
                method: 'PUT',
                headers: playBody
                    ? {
                        'Authorization': `Bearer ${bearerToken}`,
                        'Content-Type': 'application/json',
                    }
                    : {
                        'Authorization': `Bearer ${bearerToken}`,
                    },
                ...(playBody ? { body: playBody } : {}),
            });
        };

        let targetDeviceId = deviceId;
        let res = await executePlay(targetDeviceId, token);

        const isTransientPlayFailure =
            !res.ok &&
            res.status !== 204 &&
            (res.status === 404 || res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504);
        const canRetryDifferentUnrestrictedDevice = !res.ok && res.status === 403;

        if (isTransientPlayFailure || canRetryDifferentUnrestrictedDevice) {
            let freshChosen: SpotifyApi.UserDevice | null = null;
            if (typeof this.spotify.getMyDevices === 'function') {
                try {
                    const refreshed = await this.spotify.getMyDevices();
                    const rawList = Array.isArray(refreshed?.devices) ? refreshed.devices : [];
                    const filteredList = canRetryDifferentUnrestrictedDevice
                        ? rawList.filter(d => d.id !== targetDeviceId && !d.is_restricted)
                        : rawList;
                    freshChosen = selectTargetSpotifyDevice(filteredList, {
                        preferredDeviceId: canRetryDifferentUnrestrictedDevice && this.preferredDeviceId === targetDeviceId
                            ? null
                            : this.preferredDeviceId,
                        cachedActiveDeviceId: canRetryDifferentUnrestrictedDevice ? null : targetDeviceId,
                        isMobile: this.isMobileRuntime(),
                    });
                } catch (e) {
                    console.warn('Device re-discovery before play retry failed:', e);
                }
            }

            const retryDeviceId = canRetryDifferentUnrestrictedDevice
                ? (freshChosen?.id ?? null)
                : (freshChosen?.id || targetDeviceId);

            if (retryDeviceId) {
                const latestToken = this.spotify.getAccessToken() || token;
                await this.transferPlaybackQuietly(retryDeviceId, latestToken);
                await this.delay(this.options.retryDelayMs ?? 450);
                res = await executePlay(retryDeviceId, latestToken);
                if (res.ok || res.status === 204) {
                    targetDeviceId = retryDeviceId;
                    this.activeDeviceId = retryDeviceId;
                    if (freshChosen) {
                        this.lastResolvedDevice = { ...freshChosen, is_active: true };
                    }
                }
            }
        }

        if (!res.ok && res.status !== 204) {
            const errText = await res.text().catch(() => 'No error details');
            const retryAfter = res.headers?.get?.('Retry-After');
            const errInfo = classifySpotifyError(res.status, 'play', retryAfter, res.statusText);
            console.error(`Spotify Play API Error: ${res.status} ${res.statusText}`, errText);
            this.notifyError(errInfo);
            throw new Error(`Spotify Play Failed: ${res.statusText} (${errInfo.message})`);
        }

        if (this.lastResolvedDevice?.id === targetDeviceId) {
            this.lastResolvedDevice = { ...this.lastResolvedDevice, is_active: true };
        }
        console.log('▶️ Playback started successfully (Fetch)');
    }

    /**
     * Normalizes shuffle (`false`) and repeat (`off`) ONLY after session playback has
     * converged on an active, unrestricted device and ONLY for modes that actually differ.
     */
    async ensurePlaybackModes(
        state: Pick<SpotifyApi.CurrentPlaybackResponse, 'is_playing' | 'shuffle_state' | 'repeat_state' | 'device'> | null | undefined
    ): Promise<void> {
        if (!state || !state.is_playing) return;
        if (!state.device || !state.device.is_active || state.device.is_restricted) return;

        const needDisableShuffle = state.shuffle_state === true;
        const needDisableRepeat = Boolean(state.repeat_state && state.repeat_state !== 'off');
        if (!needDisableShuffle && !needDisableRepeat) {
            return;
        }

        const token = this.spotify.getAccessToken();
        if (!token) return;

        const deviceParam = state.device.id ? `&device_id=${encodeURIComponent(state.device.id)}` : '';

        if (needDisableShuffle) {
            try {
                await fetch(`https://api.spotify.com/v1/me/player/shuffle?state=false${deviceParam}`, {
                    method: 'PUT',
                    headers: { 'Authorization': `Bearer ${token}` },
                });
                console.log('🔀 Shuffle disabled after playback convergence');
            } catch (e) {
                console.warn('Post-convergence disable shuffle failed (non-critical):', e);
            }
        }

        if (needDisableRepeat) {
            try {
                await fetch(`https://api.spotify.com/v1/me/player/repeat?state=off${deviceParam}`, {
                    method: 'PUT',
                    headers: { 'Authorization': `Bearer ${token}` },
                });
                console.log('🔁 Repeat disabled after playback convergence');
            } catch (e) {
                console.warn('Post-convergence disable repeat failed (non-critical):', e);
            }
        }
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
    async resume(deviceId?: string) {
        const endpoint = deviceId ? `play?device_id=${encodeURIComponent(deviceId)}` : 'play';
        return this.safeControlRequest(endpoint, 'PUT');
    }
}

