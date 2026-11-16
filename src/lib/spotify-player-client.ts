import SpotifyWebApi from 'spotify-web-api-js';
import { generateTrackKey } from './dj-utils';
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
export function isMobileBrowserEnvironment(env?: BrowserEnvironmentHint | null): boolean {
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

export function isMobileSpotifyDevice(
    device: Pick<SpotifyApi.UserDevice, 'type'> | null | undefined
): boolean {
    return Boolean(device?.type && /^(smartphone|tablet)$/i.test(device.type));
}

/**
 * Checks whether the browser currently holds an active transient user gesture
 * (`navigator.userActivation.isActive`, ~5.0s window in Chromium / WebKit).
 */
export function hasActiveBrowserUserGesture(): boolean {
    if (typeof navigator === 'undefined') return false;
    const nav = navigator as Navigator & {
        userActivation?: { isActive?: boolean };
    };
    return Boolean(nav.userActivation?.isActive);
}

export const SPOTIFY_ANDROID_WAKE_INTENT_URI =
    'intent://home#Intent;scheme=spotify;package=com.spotify.music;S.browser_fallback_url=https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdetails%3Fid%3Dcom.spotify.music;end';

/**
 * Resolves the platform-appropriate Spotify wake URI:
 * - Android Chromium / WebAPK: package-targeted `intent://` URI for `com.spotify.music`
 *   with a safe HTTPS fallback (preventing `ExternalNavigationHandler` opaque-SSP drops or
 *   `ERR_UNKNOWN_URL_SCHEME` inside `SameTaskWebApkActivity`).
 * - iOS / other browsers: standard `spotify:` custom-scheme URI.
 */
export function resolveSpotifyWakeUri(userAgent?: string): string {
    const ua =
        userAgent !== undefined
            ? userAgent
            : typeof navigator !== 'undefined'
                ? navigator.userAgent || ''
                : '';
    if (/\bAndroid\b/i.test(ua)) {
        return SPOTIFY_ANDROID_WAKE_INTENT_URI;
    }
    return 'spotify:';
}

function isAllowedSpotifyWakeUri(uri: string): boolean {
    if (/^spotify:/i.test(uri)) {
        return true;
    }
    return /^intent:\/\/[a-z0-9/_-]*#Intent;scheme=spotify;package=com\.spotify\.music;(?:S\.browser_fallback_url=https%3A%2F%2F[^;\s]+;)?end;?$/i.test(
        uri
    );
}

/**
 * Fires a platform-appropriate Spotify wake URI (`intent://...package=com.spotify.music...` on Android,
 * `spotify:` on iOS) via a temporary anchor click to wake a frozen or BFGS-restricted mobile Spotify app
 * without navigating the current ContextDJ document away.
 */
export function launchSpotifyAppUri(
    uri?: string,
    docOverride?: Document | null
): boolean {
    const resolvedUri = uri === undefined ? resolveSpotifyWakeUri() : uri;
    if (typeof resolvedUri !== 'string' || !isAllowedSpotifyWakeUri(resolvedUri.trim())) {
        return false;
    }
    const cleanUri = resolvedUri.trim();
    const doc = docOverride !== undefined
        ? docOverride
        : (typeof document !== 'undefined' ? document : null);

    if (doc && doc.body && typeof doc.createElement === 'function') {
        const anchor = doc.createElement('a');
        anchor.href = cleanUri;
        anchor.rel = 'noopener noreferrer';
        anchor.style.display = 'none';
        doc.body.appendChild(anchor);
        try {
            anchor.click();
            return true;
        } finally {
            if (anchor.parentNode) {
                anchor.parentNode.removeChild(anchor);
            } else if (typeof anchor.remove === 'function') {
                anchor.remove();
            }
        }
    }

    if (docOverride === undefined && typeof window !== 'undefined' && window.location?.assign) {
        window.location.assign(cleanUri);
        return true;
    }

    return false;
}

export interface SpotifyPlayerClientOptions {
    isMobile?: () => boolean;
    transferSettleDelayMs?: number;
    retryDelayMs?: number;
    devicePollDelayMs?: number;
    postPlayVerifyDelayMs?: number;
    onDevicesResolved?: (devices: SpotifyApi.UserDevice[]) => void;
}

export interface StartPlaybackOptions {
    shouldAbort?: () => boolean;
    expectedTrackKeys?: string[];
    isSkippablePriorTrack?: (track: Track) => boolean;
    onResumeKickSent?: () => void;
    fastFailForUserGesture?: boolean;
}

export interface StartPlaybackResult {
    confirmedPlaying: boolean;
    targetTrackLoaded: boolean;
    deviceActivelyPlaying?: boolean;
    targetDeviceId: string;
    isMobileTarget: boolean;
    aborted?: boolean;
}

/**
 * Checks whether Spotify's current playback state reflects one of the target track URIs
 * (or normalized title+artist keys across Spotify Track Relinking) loaded directly
 * (`context === null`, not an external album/playlist context) on the expected device.
 */
export function isTargetTrackLoadedOnState(
    state: SpotifyApi.CurrentPlaybackResponse | null | undefined,
    uris: string[],
    expectedDeviceId?: string,
    expectedTrackKeys?: string[]
): boolean {
    const validTrackKeys = Array.isArray(expectedTrackKeys)
        ? expectedTrackKeys.filter(k => Boolean(k && k !== '|'))
        : [];
    if (!state || Boolean(state.context?.uri) || (uris.length === 0 && validTrackKeys.length === 0)) {
        return false;
    }
    if (expectedDeviceId && state.device?.id && state.device.id !== expectedDeviceId) {
        return false;
    }
    if (!state.item || state.item.type !== 'track') {
        return false;
    }
    const targetSet = new Set(uris);
    const currentUri = state.item.uri;
    const linkedUri = (state.item as { linked_from?: { uri?: string } }).linked_from?.uri;
    if ((currentUri && targetSet.has(currentUri)) || (linkedUri && targetSet.has(linkedUri))) {
        return true;
    }
    if (validTrackKeys.length > 0) {
        const itemKey = generateTrackKey(state.item as SpotifyApi.TrackObjectFull);
        if (itemKey && itemKey !== '|' && validTrackKeys.includes(itemKey)) {
            return true;
        }
    }
    return false;
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
    private knownDevices = new Map<string, SpotifyApi.UserDevice>();
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

    isMobileRuntime(): boolean {
        return this.options.isMobile
            ? this.options.isMobile()
            : isMobileBrowserEnvironment();
    }

    getLastResolvedDevice(): SpotifyApi.UserDevice | null {
        return this.lastResolvedDevice;
    }

    getKnownDevice(deviceId: string): SpotifyApi.UserDevice | null {
        return (
            this.knownDevices.get(deviceId) ??
            (this.lastResolvedDevice?.id === deviceId ? this.lastResolvedDevice : null)
        );
    }

    private rememberDevices(devices: SpotifyApi.UserDevice[]) {
        for (const d of devices) {
            if (d && d.id) {
                this.knownDevices.set(d.id, d);
            }
        }
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
            const list = Array.isArray(response?.devices) ? response.devices : [];
            this.rememberDevices(list);
            const trackedId = this.preferredDeviceId || this.activeDeviceId;
            if (trackedId) {
                const matched = list.find(d => d.id === trackedId);
                if (matched) {
                    this.lastResolvedDevice = matched;
                }
            }
            this.options.onDevicesResolved?.(list);
            return list;
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

    async setActiveDevice(
        deviceId: string,
        options?: { play?: boolean; deferTransfer?: boolean }
    ): Promise<SpotifyControlResult> {
        const prevDeviceId = this.activeDeviceId;
        const prevPreferredId = this.preferredDeviceId;
        this.activeDeviceId = deviceId;
        this.preferredDeviceId = deviceId;
        console.log(`📱 Active device set to: ${deviceId}`);

        if (options?.deferTransfer) {
            this.lastResolvedDevice = this.getKnownDevice(deviceId);
            return { ok: true, status: 204 };
        }

        const token = this.spotify.getAccessToken();
        if (!token) {
            this.activeDeviceId = prevDeviceId;
            this.preferredDeviceId = prevPreferredId;
            return { ok: false };
        }

        try {
            const transferPayload = typeof options?.play === 'boolean'
                ? { device_ids: [deviceId], play: options.play }
                : { device_ids: [deviceId] };
            const res = await fetch('https://api.spotify.com/v1/me/player', {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(transferPayload)
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

            const known = this.getKnownDevice(deviceId);
            if (known) {
                const updated = { ...known, is_active: true };
                this.lastResolvedDevice = updated;
                this.knownDevices.set(deviceId, updated);
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

    async resolveTargetDevice(options?: {
        maxAttempts?: number;
        pollDelayMs?: number;
        fastFailOnEmpty?: boolean;
    }): Promise<string> {
        let resolved: SpotifyApi.UserDevice | null = null;
        const isMobile = this.isMobileRuntime();
        const pollDelayMs = options?.pollDelayMs ?? this.options.devicePollDelayMs ?? 1000;
        const maxAttempts = Math.max(1, options?.maxAttempts ?? 3);

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            let devices: SpotifyApi.UserDevicesResponse;
            try {
                devices = await this.spotify.getMyDevices();
            } catch (e) {
                this.reportThrownError(e, 'resolve_device');
                throw e;
            }
            const list = Array.isArray(devices?.devices) ? devices.devices : [];
            this.rememberDevices(list);
            this.options.onDevicesResolved?.(list);
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

            if (options?.fastFailOnEmpty && list.length === 0) {
                break;
            }

            if (attempt < maxAttempts - 1) {
                await this.delay(pollDelayMs);
            }
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

    async startPlaybackOnDevice(
        deviceId: string,
        uris: string[],
        options?: StartPlaybackOptions
    ): Promise<StartPlaybackResult> {
        const token = this.spotify.getAccessToken();
        if (!token) throw new Error("No access token available");

        const targetKnownDevice = this.getKnownDevice(deviceId);
        let isMobileTarget = targetKnownDevice
            ? isMobileSpotifyDevice(targetKnownDevice)
            : this.isMobileRuntime();

        if (options?.shouldAbort?.()) {
            return {
                confirmedPlaying: false,
                targetTrackLoaded: false,
                targetDeviceId: deviceId,
                isMobileTarget,
                aborted: true,
            };
        }

        const wasInitiallyInactive = Boolean(
            targetKnownDevice && !targetKnownDevice.is_active
        );
        let didPreTransferToTarget = false;

        // CRITICAL: Never send `PUT /v1/me/player { play: false }` (`transferPlaybackQuietly`) to a mobile
        // Smartphone/Tablet! On Android 14+ (`targetSdkVersion >= 34`), sending `play: false` to a backgrounded
        // Spotify app stops `ForegroundKeeperService` within ~260ms, after which Android Background-FGS
        // restrictions block subsequent network-only `PUT /me/player/play` commands from starting audio.
        // Only use quiet pre-transfer on inactive non-mobile Connect targets (Desktop / Speaker).
        if (wasInitiallyInactive && !isMobileTarget) {
            const transferred = await this.transferPlaybackQuietly(deviceId, token);
            if (options?.shouldAbort?.()) {
                return {
                    confirmedPlaying: false,
                    targetTrackLoaded: false,
                    targetDeviceId: deviceId,
                    isMobileTarget,
                    aborted: true,
                };
            }
            if (transferred) {
                didPreTransferToTarget = true;
                await this.delay(this.options.transferSettleDelayMs ?? 650);
            }
            if (options?.shouldAbort?.()) {
                return {
                    confirmedPlaying: false,
                    targetTrackLoaded: false,
                    targetDeviceId: deviceId,
                    isMobileTarget,
                    aborted: true,
                };
            }
        }

        const playBody = uris.length > 0 ? JSON.stringify({ uris }) : undefined;
        const playWithOffsetBody = uris.length > 0
            ? JSON.stringify({ uris, offset: { position: 0 }, position_ms: 0 })
            : undefined;
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
        const executePlayWithOffset = async (targetId: string, bearerToken: string) => {
            const playUrl = `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(targetId)}`;
            return fetch(playUrl, {
                method: 'PUT',
                headers: playWithOffsetBody
                    ? {
                        'Authorization': `Bearer ${bearerToken}`,
                        'Content-Type': 'application/json',
                    }
                    : {
                        'Authorization': `Bearer ${bearerToken}`,
                    },
                ...(playWithOffsetBody ? { body: playWithOffsetBody } : {}),
            });
        };
        const executeEmptyResume = async (targetId: string, bearerToken: string) => {
            const resumeUrl = targetId
                ? `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(targetId)}`
                : 'https://api.spotify.com/v1/me/player/play';
            return fetch(resumeUrl, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${bearerToken}`,
                },
            });
        };
        const executeNextOnDevice = async (targetId: string, bearerToken: string) => {
            const nextUrl = targetId
                ? `https://api.spotify.com/v1/me/player/next?device_id=${encodeURIComponent(targetId)}`
                : 'https://api.spotify.com/v1/me/player/next';
            return fetch(nextUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${bearerToken}`,
                },
            });
        };

        let targetDeviceId = deviceId;
        let res = await executePlay(targetDeviceId, token);
        if (options?.shouldAbort?.()) {
            return {
                confirmedPlaying: false,
                targetTrackLoaded: false,
                targetDeviceId,
                isMobileTarget,
                aborted: true,
            };
        }

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
                    this.rememberDevices(rawList);
                    this.options.onDevicesResolved?.(rawList);
                    if (options?.shouldAbort?.()) {
                        return {
                            confirmedPlaying: false,
                            targetTrackLoaded: false,
                            targetDeviceId,
                            isMobileTarget,
                            aborted: true,
                        };
                    }
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
                    if (options?.shouldAbort?.()) {
                        return {
                            confirmedPlaying: false,
                            targetTrackLoaded: false,
                            targetDeviceId,
                            isMobileTarget,
                            aborted: true,
                        };
                    }
                }
            }

            const retryDeviceId = canRetryDifferentUnrestrictedDevice
                ? (freshChosen?.id ?? null)
                : (freshChosen?.id || targetDeviceId);

            if (retryDeviceId) {
                const retryKnownDevice = freshChosen ?? this.getKnownDevice(retryDeviceId);
                const retryIsMobile = retryKnownDevice
                    ? isMobileSpotifyDevice(retryKnownDevice)
                    : retryDeviceId === deviceId
                        ? isMobileTarget
                        : this.isMobileRuntime();
                const latestToken = this.spotify.getAccessToken() || token;
                const retryTransferred = retryIsMobile
                    ? false
                    : await this.transferPlaybackQuietly(retryDeviceId, latestToken);
                if (options?.shouldAbort?.()) {
                    return {
                        confirmedPlaying: false,
                        targetTrackLoaded: false,
                        targetDeviceId: retryDeviceId,
                        isMobileTarget: retryIsMobile,
                        aborted: true,
                    };
                }
                await this.delay(this.options.retryDelayMs ?? (retryIsMobile ? 400 : 500));
                if (options?.shouldAbort?.()) {
                    return {
                        confirmedPlaying: false,
                        targetTrackLoaded: false,
                        targetDeviceId: retryDeviceId,
                        isMobileTarget: retryIsMobile,
                        aborted: true,
                    };
                }
                res = await executePlay(retryDeviceId, latestToken);
                if (res.ok || res.status === 204) {
                    targetDeviceId = retryDeviceId;
                    isMobileTarget = retryIsMobile;
                    didPreTransferToTarget = retryTransferred;
                    this.activeDeviceId = retryDeviceId;
                    if (freshChosen) {
                        const updatedChosen = { ...freshChosen, is_active: true };
                        this.lastResolvedDevice = updatedChosen;
                        this.knownDevices.set(retryDeviceId, updatedChosen);
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

        const resolvedAfterPlay = this.getKnownDevice(targetDeviceId);
        if (resolvedAfterPlay) {
            const updatedTarget = { ...resolvedAfterPlay, is_active: true };
            this.lastResolvedDevice = updatedTarget;
            this.knownDevices.set(targetDeviceId, updatedTarget);
        }

        let confirmedPlaying = true;
        let targetTrackLoaded = uris.length > 0;
        let deviceActivelyPlaying = false;
        let hadConfirmedActivePlaybackOnTarget = false;

        // Spotify mobile clients may reset their internal queue parser when `{ uris }` is injected
        // (leaving Track 1 loaded in `is_playing: false`), OR Android 14+ Cached App Freezer / BFGS
        // restrictions may cause Spotify Cloud to return HTTP 204 while the phone stays frozen/stopped,
        // OR Android `com.spotify.music` actively streaming in background FGS may reset the current track
        // to 0ms while queuing `uris[0..N]` immediately behind it (`queue[0] === uris[0]` or behind carryover refill items).
        // Verify post-play state (across `progress_ms === 0` cloud mirages and relinked tracks), advance/retry
        // if stuck on a prior playing track, send an empty-body resume kick if paused, and report accurate
        // `confirmedPlaying` + `deviceActivelyPlaying` so callers never fake playback or falsely show "asleep".
        if (
            uris.length > 0 &&
            typeof this.spotify.getMyCurrentPlaybackState === 'function' &&
            !options?.shouldAbort?.()
        ) {
            try {
                const fastFailMobileGesture = Boolean(isMobileTarget && options?.fastFailForUserGesture);
                const verifyDelayMs =
                    this.options.postPlayVerifyDelayMs ??
                    (fastFailMobileGesture ? 450 : isMobileTarget ? 550 : 700);
                const stepRetryDelayMs =
                    this.options.retryDelayMs ??
                    (fastFailMobileGesture ? 350 : isMobileTarget ? 400 : 500);
                let hadTargetActiveOnDevice = false;
                const isTargetLoaded = (st: SpotifyApi.CurrentPlaybackResponse | null | undefined) => {
                    const candidateUris = st?.shuffle_state ? uris : uris.slice(0, 1);
                    const candidateKeys = st?.shuffle_state
                        ? options?.expectedTrackKeys
                        : options?.expectedTrackKeys?.slice(0, 1);
                    return isTargetTrackLoadedOnState(st, candidateUris, targetDeviceId, candidateKeys);
                };
                const observeStateOnTarget = (st: SpotifyApi.CurrentPlaybackResponse | null | undefined) => {
                    if (!st) return;
                    if (st.device?.is_active && st.device.id === targetDeviceId) {
                        hadTargetActiveOnDevice = true;
                    }
                    const onTargetDevice = !st.device?.id || st.device.id === targetDeviceId;
                    if (!onTargetDevice || !st.is_playing) {
                        return;
                    }
                    const hasNonZeroProgress =
                        typeof st.progress_ms !== 'number' || st.progress_ms > 0;
                    const isPlayingNonRequestedItem = !isTargetTrackLoadedOnState(
                        st,
                        uris,
                        targetDeviceId,
                        options?.expectedTrackKeys
                    );
                    if (hasNonZeroProgress || isPlayingNonRequestedItem) {
                        hadConfirmedActivePlaybackOnTarget = true;
                    }
                };
                const fetchPlaybackState = async () => {
                    try {
                        const st = await this.spotify.getMyCurrentPlaybackState({ market: 'from_token' });
                        observeStateOnTarget(st);
                        return st;
                    } catch (err) {
                        await this.delay(stepRetryDelayMs);
                        if (options?.shouldAbort?.()) {
                            throw err;
                        }
                        const retrySt = await this.spotify.getMyCurrentPlaybackState({ market: 'from_token' });
                        observeStateOnTarget(retrySt);
                        return retrySt;
                    }
                };
                const matchesTargetQueueItem = (
                    item: SpotifyQueueItem | SpotifyApi.TrackObjectFull | SpotifyApi.EpisodeObjectFull | null | undefined,
                    shuffleActive?: boolean
                ): boolean => {
                    if (!item || item.type !== 'track') {
                        return false;
                    }
                    const trackItem = item as Track;
                    const candidateUris = shuffleActive ? uris : uris.slice(0, 1);
                    const candidateKeys = shuffleActive
                        ? options?.expectedTrackKeys
                        : options?.expectedTrackKeys?.slice(0, 1);
                    const uriSet = new Set(candidateUris);
                    const linkedUri = (trackItem as { linked_from?: { uri?: string } }).linked_from?.uri;
                    if ((trackItem.uri && uriSet.has(trackItem.uri)) || (linkedUri && uriSet.has(linkedUri))) {
                        return true;
                    }
                    const validKeys = Array.isArray(candidateKeys)
                        ? candidateKeys.filter(k => Boolean(k && k !== '|'))
                        : [];
                    if (validKeys.length > 0) {
                        const key = generateTrackKey(trackItem);
                        if (key && key !== '|' && validKeys.includes(key)) {
                            return true;
                        }
                    }
                    return false;
                };
                const inspectQueueForTarget = async (
                    priorState: SpotifyApi.CurrentPlaybackResponse | null | undefined,
                    shuffleActive?: boolean
                ): Promise<
                    | { status: 'already_current' }
                    | { status: 'queued'; skipsNeeded: number }
                    | { status: 'not_queued' }
                > => {
                    if (typeof this.spotify.getGeneric !== 'function') {
                        return { status: 'not_queued' };
                    }
                    try {
                        const rawQueueRes = (await this.spotify.getGeneric(
                            'https://api.spotify.com/v1/me/player/queue'
                        )) as {
                            currently_playing?: SpotifyQueueItem | null;
                            queue?: SpotifyQueueItem[];
                        } | null;
                        if (
                            matchesTargetQueueItem(rawQueueRes?.currently_playing, shuffleActive) &&
                            !matchesTargetQueueItem(priorState?.item, shuffleActive)
                        ) {
                            return { status: 'already_current' };
                        }
                        // Inspect raw `queue` positions directly WITHOUT pre-filtering out episodes so
                        // non-track items (`type === 'episode'`) at index 0 never shift subsequent track indices.
                        const rawQueue = Array.isArray(rawQueueRes?.queue) ? rawQueueRes.queue : [];
                        const MAX_PRIOR_CARRYOVER_SKIPS = 5;
                        for (let idx = 0; idx <= MAX_PRIOR_CARRYOVER_SKIPS && idx < rawQueue.length; idx++) {
                            const qItem = rawQueue[idx];
                            if (!qItem || qItem.type !== 'track') {
                                break;
                            }
                            if (matchesTargetQueueItem(qItem, shuffleActive)) {
                                return { status: 'queued', skipsNeeded: idx + 1 };
                            }
                            if (
                                idx < MAX_PRIOR_CARRYOVER_SKIPS &&
                                options?.isSkippablePriorTrack?.(qItem as Track)
                            ) {
                                continue;
                            }
                            break;
                        }
                        return { status: 'not_queued' };
                    } catch {
                        return { status: 'not_queued' };
                    }
                };
                const kickResume = async (stateDeviceId?: string | null) => {
                    const latestToken = this.spotify.getAccessToken() || token;
                    const resumeDeviceId = stateDeviceId || targetDeviceId;
                    const kickRes = await executeEmptyResume(resumeDeviceId, latestToken);
                    if (kickRes.ok || kickRes.status === 204) {
                        options?.onResumeKickSent?.();
                    }
                };
                const confirmAfterResumeKick = async (
                    priorState: SpotifyApi.CurrentPlaybackResponse | null | undefined
                ): Promise<SpotifyApi.CurrentPlaybackResponse | null | undefined> => {
                    if (options?.shouldAbort?.()) {
                        return priorState;
                    }
                    await this.delay(stepRetryDelayMs);
                    if (options?.shouldAbort?.()) {
                        return priorState;
                    }
                    let afterKickState = await fetchPlaybackState();
                    if (options?.shouldAbort?.()) {
                        return afterKickState;
                    }
                    if (
                        afterKickState?.is_playing &&
                        typeof afterKickState.progress_ms === 'number' &&
                        afterKickState.progress_ms === 0
                    ) {
                        await this.delay(stepRetryDelayMs);
                        if (!options?.shouldAbort?.()) {
                            afterKickState = await fetchPlaybackState();
                        }
                    }
                    return afterKickState ?? priorState;
                };
                const verifyLoadedState = async (
                    loadedState: SpotifyApi.CurrentPlaybackResponse | null | undefined,
                    mirageWaitMs: number,
                    pausedLog: string,
                    mirageLog: string
                ): Promise<{
                    droppedAfterMirage: boolean;
                    latestState: SpotifyApi.CurrentPlaybackResponse | null | undefined;
                }> => {
                    if (!loadedState?.is_playing) {
                        console.log(pausedLog);
                        await kickResume(loadedState?.device?.id);
                        if (options?.shouldAbort?.()) {
                            return { droppedAfterMirage: false, latestState: loadedState };
                        }
                        const postKickState = await confirmAfterResumeKick(loadedState);
                        return { droppedAfterMirage: false, latestState: postKickState };
                    }
                    if (typeof loadedState.progress_ms === 'number' && loadedState.progress_ms === 0) {
                        // Cloud cache briefly reports `is_playing: true, progress_ms: 0` before a mobile client
                        // finishes parsing `{ uris }` or rejecting a background start under BFGS.
                        await this.delay(mirageWaitMs);
                        if (options?.shouldAbort?.()) {
                            return { droppedAfterMirage: false, latestState: loadedState };
                        }
                        let afterMirageState = await fetchPlaybackState();
                        if (options?.shouldAbort?.()) {
                            return { droppedAfterMirage: false, latestState: afterMirageState };
                        }
                        if (isTargetLoaded(afterMirageState)) {
                            if (!afterMirageState?.is_playing) {
                                console.log(mirageLog);
                                await kickResume(afterMirageState?.device?.id);
                                if (options?.shouldAbort?.()) {
                                    return { droppedAfterMirage: false, latestState: afterMirageState };
                                }
                                const postKickState = await confirmAfterResumeKick(afterMirageState);
                                return { droppedAfterMirage: false, latestState: postKickState };
                            }
                            if (
                                hadConfirmedActivePlaybackOnTarget &&
                                typeof afterMirageState.progress_ms === 'number' &&
                                afterMirageState.progress_ms === 0
                            ) {
                                await this.delay(stepRetryDelayMs);
                                if (!options?.shouldAbort?.()) {
                                    afterMirageState = await fetchPlaybackState();
                                }
                            }
                            return { droppedAfterMirage: false, latestState: afterMirageState };
                        }
                        return { droppedAfterMirage: true, latestState: afterMirageState };
                    }
                    return { droppedAfterMirage: false, latestState: loadedState };
                };

                const isSameStaleItemOnTarget = (
                    st: SpotifyApi.CurrentPlaybackResponse | null | undefined,
                    prior: SpotifyApi.CurrentPlaybackResponse | null | undefined
                ): boolean => {
                    if (!st || (st.device?.id && st.device.id !== targetDeviceId)) {
                        return false;
                    }
                    if (st.item?.uri && prior?.item?.uri) {
                        return st.item.uri === prior.item.uri;
                    }
                    if (
                        !st.item &&
                        !prior?.item &&
                        st.currently_playing_type === 'episode' &&
                        prior?.currently_playing_type === 'episode'
                    ) {
                        return true;
                    }
                    return false;
                };

                const retryDroppedUris = async (
                    lastState: SpotifyApi.CurrentPlaybackResponse | null | undefined
                ): Promise<SpotifyApi.CurrentPlaybackResponse | null | undefined> => {
                    const latestToken = this.spotify.getAccessToken() || token;
                    const heldByOtherDevice = Boolean(
                        lastState?.device?.id && lastState.device.id !== targetDeviceId
                    );
                    const isActivelyPlayingWrongTrackOnTarget = Boolean(
                        !heldByOtherDevice &&
                        lastState?.is_playing &&
                        !isTargetLoaded(lastState)
                    );

                    if (isActivelyPlayingWrongTrackOnTarget) {
                        // Target device IS awake and actively playing another track/episode (`is_playing === true`),
                        // yet `PUT /me/player/play { uris }` (HTTP 204) kept the prior item at the active head
                        // (e.g. Android `com.spotify.music` background FGS resetting the current item to 0ms while
                        // queuing `uris[0..N]` behind it at `queue[0]` or behind ContextDJ's carryover refill items).
                        if (lastState?.repeat_state && lastState.repeat_state !== 'off') {
                            try {
                                await fetch(
                                    `https://api.spotify.com/v1/me/player/repeat?state=off&device_id=${encodeURIComponent(targetDeviceId)}`,
                                    {
                                        method: 'PUT',
                                        headers: { 'Authorization': `Bearer ${latestToken}` },
                                    }
                                );
                            } catch (repeatErr) {
                                console.warn('Pre-switch disable repeat warning (non-fatal):', repeatErr);
                            }
                            if (options?.shouldAbort?.()) {
                                return lastState;
                            }
                        }

                        const advanceQueuedHeadViaNext = async (
                            priorState: SpotifyApi.CurrentPlaybackResponse | null | undefined,
                            skipsCount: number = 1
                        ): Promise<{
                            switched: boolean;
                            sentAnyNext: boolean;
                            state: SpotifyApi.CurrentPlaybackResponse | null | undefined;
                        }> => {
                            const totalSkips = Math.max(1, skipsCount);
                            for (let step = 0; step < totalSkips; step++) {
                                const currentToken = this.spotify.getAccessToken() || latestToken;
                                const nextRes = await executeNextOnDevice(targetDeviceId, currentToken);
                                if (!(nextRes.ok || nextRes.status === 204) || options?.shouldAbort?.()) {
                                    return { switched: false, sentAnyNext: step > 0, state: priorState };
                                }
                                if (step < totalSkips - 1) {
                                    await this.delay(Math.min(180, stepRetryDelayMs));
                                    if (options?.shouldAbort?.()) {
                                        return { switched: false, sentAnyNext: true, state: priorState };
                                    }
                                }
                            }
                            await this.delay(verifyDelayMs);
                            if (options?.shouldAbort?.()) {
                                return { switched: false, sentAnyNext: true, state: priorState };
                            }
                            let postNextState = await fetchPlaybackState();
                            if (options?.shouldAbort?.()) {
                                return { switched: false, sentAnyNext: true, state: postNextState };
                            }
                            if (
                                !isTargetLoaded(postNextState) &&
                                (isSameStaleItemOnTarget(postNextState, priorState) || totalSkips > 1)
                            ) {
                                await this.delay(stepRetryDelayMs);
                                if (options?.shouldAbort?.()) {
                                    return { switched: false, sentAnyNext: true, state: postNextState };
                                }
                                postNextState = await fetchPlaybackState();
                                if (options?.shouldAbort?.()) {
                                    return { switched: false, sentAnyNext: true, state: postNextState };
                                }
                            }
                            if (isTargetLoaded(postNextState)) {
                                const checked = await verifyLoadedState(
                                    postNextState,
                                    stepRetryDelayMs,
                                    '⚡ Track loaded paused after next-skip onto queued { uris }; sending empty-body resume kick',
                                    '⚡ Track settled paused after 0ms mirage following next-skip; sending empty-body resume kick'
                                );
                                return {
                                    switched: isTargetLoaded(checked.latestState) && !checked.droppedAfterMirage,
                                    sentAnyNext: true,
                                    state: checked.latestState,
                                };
                            }
                            return { switched: false, sentAnyNext: true, state: postNextState };
                        };

                        const queueBeforeRetry = await inspectQueueForTarget(
                            lastState,
                            Boolean(lastState?.shuffle_state)
                        );
                        if (options?.shouldAbort?.()) {
                            return lastState;
                        }
                        if (queueBeforeRetry.status === 'already_current') {
                            const convergedState = await fetchPlaybackState();
                            if (options?.shouldAbort?.() || !isTargetLoaded(convergedState)) {
                                return convergedState;
                            }
                            const checked = await verifyLoadedState(
                                convergedState,
                                stepRetryDelayMs,
                                '⚡ Target track converged paused on queue snapshot; sending empty-body resume kick',
                                '⚡ Target track settled paused after 0ms mirage; sending empty-body resume kick'
                            );
                            return checked.latestState;
                        }
                        if (queueBeforeRetry.status === 'queued') {
                            console.log(
                                `⚡ Target track queued behind active item (skipsNeeded=${queueBeforeRetry.skipsNeeded}); advancing to target`
                            );
                            const skipped = await advanceQueuedHeadViaNext(lastState, queueBeforeRetry.skipsNeeded);
                            if (skipped.switched || options?.shouldAbort?.()) {
                                return skipped.state;
                            }
                            if (skipped.sentAnyNext) {
                                const postSkipQueue = await inspectQueueForTarget(
                                    skipped.state,
                                    Boolean(skipped.state?.shuffle_state)
                                );
                                if (options?.shouldAbort?.()) {
                                    return skipped.state;
                                }
                                if (postSkipQueue.status === 'already_current') {
                                    await this.delay(stepRetryDelayMs);
                                    if (options?.shouldAbort?.()) {
                                        return skipped.state;
                                    }
                                    const settledAfterSkip = await fetchPlaybackState();
                                    if (options?.shouldAbort?.() || !isTargetLoaded(settledAfterSkip)) {
                                        return settledAfterSkip;
                                    }
                                    const checked = await verifyLoadedState(
                                        settledAfterSkip,
                                        stepRetryDelayMs,
                                        '⚡ Track settled paused after next-skip; sending empty-body resume kick',
                                        '⚡ Track settled paused after 0ms mirage; sending empty-body resume kick'
                                    );
                                    return checked.latestState;
                                }
                            }
                        }

                        // Disable shuffle before explicit `offset: { position: 0 }` retry when `context === null`
                        // so `uris[0]` (priorityTrack / intro opener) is guaranteed to start first.
                        if (lastState?.shuffle_state === true && !lastState.context?.uri) {
                            try {
                                const shuffleToken = this.spotify.getAccessToken() || latestToken;
                                await fetch(
                                    `https://api.spotify.com/v1/me/player/shuffle?state=false&device_id=${encodeURIComponent(targetDeviceId)}`,
                                    {
                                        method: 'PUT',
                                        headers: { 'Authorization': `Bearer ${shuffleToken}` },
                                    }
                                );
                            } catch (shuffleErr) {
                                console.warn('Pre-offset disable shuffle warning (non-fatal):', shuffleErr);
                            }
                            if (options?.shouldAbort?.()) {
                                return lastState;
                            }
                        }

                        // Retry `PUT /me/player/play` with explicit `offset: { position: 0 }, position_ms: 0`
                        // to force Spotify's ContextPlayer onto index 0 of `{ uris }`.
                        const currentToken = this.spotify.getAccessToken() || latestToken;
                        const offsetPlayRes = await executePlayWithOffset(targetDeviceId, currentToken);
                        if ((offsetPlayRes.ok || offsetPlayRes.status === 204) && !options?.shouldAbort?.()) {
                            await this.delay(verifyDelayMs);
                            if (options?.shouldAbort?.()) {
                                return lastState;
                            }
                            const thirdState = await fetchPlaybackState();
                            if (options?.shouldAbort?.()) {
                                return thirdState;
                            }
                            if (isTargetLoaded(thirdState)) {
                                const checked = await verifyLoadedState(
                                    thirdState,
                                    stepRetryDelayMs,
                                    '⚡ Offset play retry loaded track in paused state; sending empty-body resume kick',
                                    '⚡ Offset play retry settled paused after 0ms mirage; sending empty-body resume kick'
                                );
                                return checked.latestState;
                            }
                            const stillPlayingWrongTrackOnTarget = Boolean(
                                thirdState?.is_playing &&
                                (!thirdState.device?.id || thirdState.device.id === targetDeviceId)
                            );
                            if (stillPlayingWrongTrackOnTarget) {
                                const queueAfterOffset = await inspectQueueForTarget(
                                    thirdState,
                                    Boolean(thirdState?.shuffle_state)
                                );
                                if (options?.shouldAbort?.()) {
                                    return thirdState;
                                }
                                if (queueAfterOffset.status === 'already_current') {
                                    const converged = await fetchPlaybackState();
                                    if (!options?.shouldAbort?.() && isTargetLoaded(converged)) {
                                        const checked = await verifyLoadedState(
                                            converged,
                                            stepRetryDelayMs,
                                            '⚡ Offset play converged paused; sending empty-body resume kick',
                                            '⚡ Offset play settled paused after 0ms mirage; sending empty-body resume kick'
                                        );
                                        return checked.latestState;
                                    }
                                    return converged;
                                }
                                if (
                                    queueAfterOffset.status === 'queued' ||
                                    (queueBeforeRetry.status === 'not_queued' && !thirdState?.context?.uri)
                                ) {
                                    const skips =
                                        queueAfterOffset.status === 'queued' ? queueAfterOffset.skipsNeeded : 1;
                                    console.log(
                                        `⚡ Offset play retry kept prior track at head (skipsNeeded=${skips}); advancing via next`
                                    );
                                    const skippedAfterOffset = await advanceQueuedHeadViaNext(thirdState, skips);
                                    return skippedAfterOffset.state;
                                }
                            }
                            return thirdState;
                        }
                        return lastState;
                    }

                    if (isMobileTarget) {
                        // On mobile targets, NEVER send `play: false` (`transferPlaybackQuietly`).
                        // Reclaim Connect via `play: true` ONLY when a different device holds the session.
                        if (heldByOtherDevice) {
                            await this.transferPlaybackWithPlay(targetDeviceId, { silent: true });
                            if (options?.shouldAbort?.()) {
                                return lastState;
                            }
                            await this.delay(this.options.transferSettleDelayMs ?? stepRetryDelayMs);
                            if (options?.shouldAbort?.()) {
                                return lastState;
                            }
                        }
                    } else {
                        const alreadyTransferredOrActiveOnTarget =
                            didPreTransferToTarget || hadTargetActiveOnDevice;
                        const shouldQuietTransferBeforeRetry = alreadyTransferredOrActiveOnTarget
                            ? heldByOtherDevice
                            : (!lastState?.device?.is_active || lastState.device.id !== targetDeviceId);

                        if (shouldQuietTransferBeforeRetry) {
                            const retryTransferred = await this.transferPlaybackQuietly(targetDeviceId, latestToken);
                            if (retryTransferred) {
                                didPreTransferToTarget = true;
                            }
                            if (options?.shouldAbort?.()) {
                                return lastState;
                            }
                            await this.delay(
                                this.options.transferSettleDelayMs ?? this.options.retryDelayMs ?? 650
                            );
                            if (options?.shouldAbort?.()) {
                                return lastState;
                            }
                        }
                    }

                    const retryPlayRes = await executePlay(targetDeviceId, latestToken);
                    if ((retryPlayRes.ok || retryPlayRes.status === 204) && !options?.shouldAbort?.()) {
                        await this.delay(verifyDelayMs);
                        if (options?.shouldAbort?.()) {
                            return lastState;
                        }
                        let thirdState = await fetchPlaybackState();
                        if (options?.shouldAbort?.()) {
                            return thirdState;
                        }
                        if (
                            !isTargetLoaded(thirdState) &&
                            !thirdState?.is_playing &&
                            (!thirdState?.device?.id || thirdState.device.id === targetDeviceId)
                        ) {
                            await this.delay(stepRetryDelayMs);
                            if (options?.shouldAbort?.()) {
                                return thirdState;
                            }
                            thirdState = await fetchPlaybackState();
                            if (options?.shouldAbort?.()) {
                                return thirdState;
                            }
                        }
                        if (isTargetLoaded(thirdState)) {
                            const checked = await verifyLoadedState(
                                thirdState,
                                stepRetryDelayMs,
                                '⚡ Wake-up retry loaded track in paused state; sending empty-body resume kick',
                                '⚡ Wake-up retry settled paused after 0ms mirage; sending empty-body resume kick'
                            );
                            return checked.latestState;
                        }
                        return thirdState;
                    }
                    return lastState;
                };

                let finalState: SpotifyApi.CurrentPlaybackResponse | null | undefined;
                await this.delay(verifyDelayMs);
                if (options?.shouldAbort?.()) {
                    return {
                        confirmedPlaying: false,
                        targetTrackLoaded: false,
                        targetDeviceId,
                        isMobileTarget,
                        aborted: true,
                    };
                }
                const postState = await fetchPlaybackState();
                if (options?.shouldAbort?.()) {
                    return {
                        confirmedPlaying: false,
                        targetTrackLoaded: false,
                        targetDeviceId,
                        isMobileTarget,
                        aborted: true,
                    };
                }

                if (isTargetLoaded(postState)) {
                    const checked = await verifyLoadedState(
                        postState,
                        this.options.retryDelayMs ?? (isMobileTarget ? 450 : 600),
                        '⚡ Track loaded in paused state after { uris }; sending empty-body resume kick',
                        '⚡ Track settled paused after initial 0ms cloud mirage; sending empty-body resume kick'
                    );
                    finalState = checked.latestState;
                    if (checked.droppedAfterMirage && !options?.shouldAbort?.()) {
                        finalState = await retryDroppedUris(checked.latestState);
                    }
                } else {
                    await this.delay(stepRetryDelayMs);
                    if (options?.shouldAbort?.()) {
                        return {
                            confirmedPlaying: false,
                            targetTrackLoaded: false,
                            targetDeviceId,
                            isMobileTarget,
                            aborted: true,
                        };
                    }
                    let secondState = await fetchPlaybackState();
                    if (options?.shouldAbort?.()) {
                        return {
                            confirmedPlaying: false,
                            targetTrackLoaded: false,
                            targetDeviceId,
                            isMobileTarget,
                            aborted: true,
                        };
                    }

                    // When an initially-inactive device is waking up to process `{ uris }`, its Connect
                    // state can take ~1.5s to surface Track 1 in `/me/player` (`null` or idle device state
                    // on the first two checks). Allow one additional settle check before declaring `{ uris }` dropped,
                    // unless caller holds a live browser user gesture (5.0s Chromium/WebKit window) that needs
                    // fast dead-device detection to auto-launch `spotify:` on the same tap.
                    const isStillWakingOnTarget =
                        !fastFailMobileGesture &&
                        (didPreTransferToTarget || (isMobileTarget && wasInitiallyInactive)) &&
                        !secondState?.is_playing &&
                        (!secondState?.device?.id || secondState.device.id === targetDeviceId);
                    if (!isTargetLoaded(secondState) && isStillWakingOnTarget) {
                        await this.delay(this.options.retryDelayMs ?? (isMobileTarget ? 450 : 600));
                        if (options?.shouldAbort?.()) {
                            return {
                                confirmedPlaying: false,
                                targetTrackLoaded: false,
                                targetDeviceId,
                                isMobileTarget,
                                aborted: true,
                            };
                        }
                        secondState = await fetchPlaybackState();
                        if (options?.shouldAbort?.()) {
                            return {
                                confirmedPlaying: false,
                                targetTrackLoaded: false,
                                targetDeviceId,
                                isMobileTarget,
                                aborted: true,
                            };
                        }
                    }

                    if (isTargetLoaded(secondState)) {
                        const checked = await verifyLoadedState(
                            secondState,
                            stepRetryDelayMs,
                            '⚡ Delayed track load landed paused; sending empty-body resume kick',
                            '⚡ Delayed track load settled paused after 0ms mirage; sending empty-body resume kick'
                        );
                        finalState = checked.latestState;
                        if (checked.droppedAfterMirage && !options?.shouldAbort?.()) {
                            finalState = await retryDroppedUris(checked.latestState);
                        }
                    } else {
                        const heldByOtherDeviceOnSecondCheck = Boolean(
                            secondState?.device?.id && secondState.device.id !== targetDeviceId
                        );
                        if (fastFailMobileGesture && !heldByOtherDeviceOnSecondCheck && !secondState?.is_playing) {
                            // Phone ignored `PUT /me/player/play { uris }` completely (frozen / BFGS-blocked)
                            // while no other device holds Connect: return immediately (< 2.0s) so the caller's
                            // active browser user gesture can synchronously launch `spotify:` on the first tap.
                            finalState = secondState;
                        } else {
                            finalState = await retryDroppedUris(secondState);
                        }
                    }
                }

                if (options?.shouldAbort?.()) {
                    return {
                        confirmedPlaying: false,
                        targetTrackLoaded: false,
                        targetDeviceId,
                        isMobileTarget,
                        aborted: true,
                    };
                }

                targetTrackLoaded = isTargetLoaded(finalState);
                const isTargetZeroMirage = Boolean(
                    isMobileTarget &&
                    targetTrackLoaded &&
                    finalState?.is_playing &&
                    typeof finalState.progress_ms === 'number' &&
                    finalState.progress_ms === 0
                );
                const isFinalPlayingOnTarget = Boolean(
                    finalState?.is_playing &&
                    (!finalState.device?.id || finalState.device.id === targetDeviceId)
                );
                deviceActivelyPlaying = Boolean(
                    hadConfirmedActivePlaybackOnTarget
                        ? isFinalPlayingOnTarget
                        : (isFinalPlayingOnTarget && !isTargetZeroMirage)
                );
                confirmedPlaying = Boolean(
                    targetTrackLoaded &&
                    finalState?.is_playing &&
                    !isTargetZeroMirage
                );
            } catch (verifyErr) {
                if (options?.shouldAbort?.()) {
                    return {
                        confirmedPlaying: false,
                        targetTrackLoaded: false,
                        targetDeviceId,
                        isMobileTarget,
                        aborted: true,
                    };
                }
                console.warn('Post-play playback verification warning (non-fatal):', verifyErr);
                if (isMobileTarget) {
                    confirmedPlaying = false;
                    targetTrackLoaded = false;
                    if (hadConfirmedActivePlaybackOnTarget) {
                        deviceActivelyPlaying = true;
                    }
                }
            }
        } else if (options?.shouldAbort?.()) {
            return {
                confirmedPlaying: false,
                targetTrackLoaded: false,
                targetDeviceId,
                isMobileTarget,
                aborted: true,
            };
        }

        if (confirmedPlaying) {
            console.log('▶️ Playback started successfully (Fetch)');
        } else if (deviceActivelyPlaying) {
            console.warn(
                `⚠️ Playback command accepted (204), but device ${targetDeviceId} remained on prior playing track (targetTrackLoaded=${targetTrackLoaded}, isMobileTarget=${isMobileTarget})`
            );
        } else {
            console.warn(
                `⚠️ Playback command accepted (204), but device ${targetDeviceId} remained paused/asleep (targetTrackLoaded=${targetTrackLoaded}, isMobileTarget=${isMobileTarget})`
            );
        }

        return {
            confirmedPlaying,
            targetTrackLoaded,
            ...(deviceActivelyPlaying ? { deviceActivelyPlaying: true } : {}),
            targetDeviceId,
            isMobileTarget,
        };
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

    async safeControlRequest(
        endpoint: string,
        method: 'POST' | 'PUT',
        body?: unknown,
        options?: { silent?: boolean }
    ): Promise<SpotifyControlResult> {
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
                if (!options?.silent) {
                    this.notifyError(errInfo);
                }
                return { ok: false, status: res.status, error: errInfo };
            }
            return { ok: true, status: res.status };
        } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            const errInfo = classifySpotifyError(undefined, operationName, null, detail);
            console.error(`Control request ${endpoint} error:`, e);
            if (!options?.silent) {
                this.notifyError(errInfo);
            }
            return { ok: false, error: errInfo };
        }
    }

    private async transferPlaybackWithPlay(
        deviceId: string,
        options?: { silent?: boolean }
    ): Promise<SpotifyControlResult> {
        const token = this.spotify.getAccessToken();
        if (!token) return { ok: false };

        try {
            const res = await fetch('https://api.spotify.com/v1/me/player', {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ device_ids: [deviceId], play: true }),
            });
            if (!res.ok && res.status !== 204) {
                const retryAfter = res.headers?.get?.('Retry-After');
                const errInfo = classifySpotifyError(res.status, 'transfer_play', retryAfter, res.statusText);
                console.warn(`Active play transfer to ${deviceId} failed: ${res.status} - ${errInfo.message}`);
                if (!options?.silent) {
                    this.notifyError(errInfo);
                }
                return { ok: false, status: res.status, error: errInfo };
            }
            return { ok: true, status: res.status };
        } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            const errInfo = classifySpotifyError(undefined, 'transfer_play', null, detail);
            console.error(`Active play transfer to ${deviceId} error:`, e);
            if (!options?.silent) {
                this.notifyError(errInfo);
            }
            return { ok: false, error: errInfo };
        }
    }

    async addToQueue(uri: string) {
        return this.safeControlRequest(`queue?uri=${encodeURIComponent(uri)}`, 'POST');
    }

    async next() { return this.safeControlRequest('next', 'POST'); }
    async previous() { return this.safeControlRequest('previous', 'POST'); }
    async pause() { return this.safeControlRequest('pause', 'PUT'); }
    async resume(deviceId?: string, options?: { silent?: boolean; forcePlayTransfer?: boolean }) {
        if (options?.forcePlayTransfer && deviceId) {
            const transferRes = await this.transferPlaybackWithPlay(deviceId, options);
            if (transferRes.ok) {
                return transferRes;
            }
        }
        const endpoint = deviceId ? `play?device_id=${encodeURIComponent(deviceId)}` : 'play';
        return this.safeControlRequest(endpoint, 'PUT', undefined, options);
    }
}

