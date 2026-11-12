import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DJCore } from '../src/lib/dj-core';
import {
    isSameTrackDisplay,
    isSameDeviceList,
    resolveAIConfigFromStorage,
    computeSetupStatus,
    shouldShowOnboarding,
    applyStoredConfigToDJ,
    classifyStorageEventAction,
} from '../src/context/PlayerContext';
import { classifySpeechRecognitionError } from '../src/hooks/useVoiceInput';
import { validateVisionImageFile, MAX_VISION_IMAGE_BYTES } from '../src/hooks/useVisionInput';
import { DEFAULT_MODELS, DEFAULTS, STORAGE_KEYS } from '../src/lib/constants';
import { computeNextUIPollDelay, createDJPollingController } from '../src/hooks/useDJPollingLoops';
import { SpotifyAuth } from '../src/lib/spotify-auth';
import {
    SPOTIFY_AUTH_SYNC_EVENT,
    applySettingsStorageEvent,
    hasStoredSpotifyTokens,
    normalizeVoiceLang,
    persistSettingsFormState,
    readSettingsFormStateFromStorage,
    subscribeSpotifySessionStore,
} from '../src/lib/settings-sync';
import { SpotifyApiErrorInfo, Track } from '../src/lib/types';

function makeTrack(overrides: {
    id: string;
    name: string;
    uri: string;
    artistName: string;
    vibeTag?: string;
    selectionReason?: string;
    stage?: 'intro' | 'build' | 'peak' | 'outro';
}): Track {
    return {
        id: overrides.id,
        name: overrides.name,
        uri: overrides.uri,
        artists: [{ name: overrides.artistName } as SpotifyApi.ArtistObjectSimplified],
        album: {} as SpotifyApi.AlbumObjectSimplified,
        vibeTag: overrides.vibeTag,
        selectionReason: overrides.selectionReason,
        stage: overrides.stage,
        type: 'track',
    } as unknown as Track;
}

describe('Context, DJCore Subscriptions, and Polling Loop Controller', () => {
    let store: Record<string, string> = {};
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        store = {};
        originalFetch = globalThis.fetch;
        const localStorageMock = {
            getItem: (key: string) => store[key] ?? null,
            setItem: (key: string, value: string) => { store[key] = String(value); },
            removeItem: (key: string) => { delete store[key]; },
            clear: () => { store = {}; },
        };
        const g = globalThis as Record<string, unknown>;
        g.window = {
            localStorage: localStorageMock,
            addEventListener: () => {},
            removeEventListener: () => {},
        };
        g.localStorage = localStorageMock;
        g.document = {
            visibilityState: 'visible',
            addEventListener: () => {},
            removeEventListener: () => {},
        };
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('propagates 403/404/429 Spotify transport errors from SpotifyPlayerClient through DJCore to UI error callbacks and process logs without firing state listeners on log append', async () => {
        const dj = new DJCore('fake_token');
        const receivedErrors: { msg: string; info?: SpotifyApiErrorInfo }[] = [];
        const logSnapshots: string[][] = [];
        let stateListenerCalls = 0;

        dj.setErrorCallback((msg, info) => {
            receivedErrors.push({ msg, info });
        });
        const unsubState = dj.subscribe(() => {
            stateListenerCalls++;
        });
        const unsubLogs = dj.subscribeLogs((logs) => {
            logSnapshots.push(logs);
        });

        globalThis.fetch = (async () => ({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
            headers: { get: () => null },
            text: async () => 'Player command failed: Premium required',
        } as unknown as Response)) as typeof fetch;

        const res = await dj.next();
        assert.strictEqual(res.ok, false);
        assert.strictEqual(receivedErrors.length, 1);
        assert.strictEqual(receivedErrors[0].info?.category, 'forbidden');
        assert.strictEqual(receivedErrors[0].info?.status, 403);
        assert.ok(receivedErrors[0].msg.includes('403'));

        // Log listener was notified reactively without polling, and stateListeners were NOT spammed by addLog
        assert.ok(logSnapshots.length >= 1);
        assert.ok(logSnapshots[logSnapshots.length - 1][0].includes('Spotify API [403]'));
        assert.strictEqual(stateListenerCalls, 0);

        unsubState();
        unsubLogs();
    });

    it('restores schedule from localStorage, preserves currentThought in schedule gaps, and notifies state subscribers when schedule is modified', () => {
        store['dj_schedule'] = JSON.stringify([
            { start: '00:01', end: '00:02', query: 'morning coffee', thought: 'Start fresh' },
            { start: '23:58', end: '23:59', query: 'afternoon groove', thought: 'Keep moving' },
        ]);

        const dj = new DJCore('fake_token');
        assert.strictEqual(dj.getSchedule().length, 2);
        // Even in schedule gaps, getDJStatus() falls back to getEffectiveItemForPlayback() so currentThought is preserved
        assert.ok(dj.getDJStatus().currentThought !== null);

        const snapshots: number[] = [];
        const unsub = dj.subscribe((snap) => {
            snapshots.push(snap.schedule.length);
        });

        dj.removeScheduleItem(0, true);
        assert.strictEqual(dj.getSchedule().length, 1);
        assert.strictEqual(snapshots[0], 1);

        const persisted = JSON.parse(store['dj_schedule']);
        assert.strictEqual(persisted.length, 1);
        assert.strictEqual(persisted[0].query, 'afternoon groove');

        unsub();
    });

    it('isSameTrackDisplay and isSameDeviceList accurately compare display fields to prevent redundant Context re-renders', () => {
        const t1 = makeTrack({
            id: '1',
            uri: 'spotify:track:1',
            name: 'Song A',
            artistName: 'Artist A',
            vibeTag: '#Chill',
            selectionReason: 'Great vibe',
            stage: 'intro',
        });
        const t2 = makeTrack({
            id: '1',
            uri: 'spotify:track:1',
            name: 'Song A',
            artistName: 'Artist A',
            vibeTag: '#Chill',
            selectionReason: 'Great vibe',
            stage: 'intro',
        });
        const t3DifferentReason = makeTrack({
            id: '1',
            uri: 'spotify:track:1',
            name: 'Song A',
            artistName: 'Artist A',
            vibeTag: '#Chill',
            selectionReason: 'Updated reason',
            stage: 'intro',
        });

        assert.strictEqual(isSameTrackDisplay(null, null), true);
        assert.strictEqual(isSameTrackDisplay(t1, null), false);
        assert.strictEqual(isSameTrackDisplay(t1, t2), true);
        assert.strictEqual(isSameTrackDisplay(t1, t3DifferentReason), false);

        const d1 = [{ id: 'dev1', name: 'Speaker', is_active: true, type: 'Speaker', volume_percent: 50 }] as SpotifyApi.UserDevice[];
        const d2 = [{ id: 'dev1', name: 'Speaker', is_active: true, type: 'Speaker', volume_percent: 50 }] as SpotifyApi.UserDevice[];
        const d3 = [{ id: 'dev1', name: 'Speaker', is_active: false, type: 'Speaker', volume_percent: 50 }] as SpotifyApi.UserDevice[];
        assert.strictEqual(isSameDeviceList(d1, d2), true);
        assert.strictEqual(isSameDeviceList(d1, d3), false);
    });

    it('computeNextUIPollDelay switches to fast interval when track has < 10s remaining and handles progress_ms === 0', () => {
        const startOfShortTrack = {
            is_playing: true,
            progress_ms: 0,
            item: { duration_ms: 8000 },
        } as unknown as SpotifyApi.CurrentPlaybackResponse;

        const normalPlayback = {
            is_playing: true,
            progress_ms: 60000,
            item: { duration_ms: 180000 },
        } as unknown as SpotifyApi.CurrentPlaybackResponse;

        const nearEndPlayback = {
            is_playing: true,
            progress_ms: 175000,
            item: { duration_ms: 180000 },
        } as unknown as SpotifyApi.CurrentPlaybackResponse;

        assert.strictEqual(computeNextUIPollDelay(startOfShortTrack, 3000, 1000), 1000);
        assert.strictEqual(computeNextUIPollDelay(normalPlayback, 3000, 1000), 3000);
        assert.strictEqual(computeNextUIPollDelay(nearEndPlayback, 3000, 1000), 1000);
        assert.strictEqual(computeNextUIPollDelay(null, 3000, 1000), 3000);
    });

    it('createDJPollingController handles UI sync, background suspension, foreground resume, DJ loop error forwarding, and token refresh cooldown/expiry', async () => {
        const dj = new DJCore('fake_token');
        let djLoopCalls = 0;
        const syncCalls: { forceAll?: boolean }[] = [];
        const errors: string[] = [];
        let authExpiredCalls = 0;
        let refreshCalls = 0;

        const origRefresh = SpotifyAuth.refreshToken;
        SpotifyAuth.refreshToken = async () => {
            refreshCalls++;
            return null;
        };

        store['spotify_client_id'] = 'client_123';
        store['spotify_expires_at'] = String(Date.now() - 1000); // Already expired

        dj.processDJLoop = async () => {
            djLoopCalls++;
            if (djLoopCalls === 2) {
                throw new Error('Simulated DJ background loop error');
            }
        };

        const controller = createDJPollingController({
            djCore: dj,
            syncUIState: async (opts) => {
                syncCalls.push(opts || {});
                return null;
            },
            onError: (msg) => errors.push(msg),
            onAuthExpired: () => { authExpiredCalls++; },
            uiPollIntervalMs: 50,
            djLoopIntervalMs: 50,
            tokenRefreshCooldownMs: 60_000,
        });

        try {
            // 1. Run UI loop when visible -> triggers syncUIState and checkAndRefreshToken
            await controller.runUILoop();
            assert.strictEqual(syncCalls.length, 1);
            assert.strictEqual(refreshCalls, 1);
            assert.strictEqual(authExpiredCalls, 1);

            // 2. Subsequent checkAndRefreshToken within cooldown window is throttled
            await controller.checkAndRefreshToken();
            assert.strictEqual(refreshCalls, 1);

            // 3. When document is hidden, UI loop skips syncing
            (globalThis as unknown as { document: { visibilityState: string } }).document.visibilityState = 'hidden';
            await controller.runUILoop();
            assert.strictEqual(syncCalls.length, 1);

            // 4. Returning to foreground triggers immediate forceAll sync
            (globalThis as unknown as { document: { visibilityState: string } }).document.visibilityState = 'visible';
            controller.handleVisibilityChange();
            await new Promise(r => setTimeout(r, 10));
            assert.strictEqual(syncCalls.some(c => c.forceAll === true), true);

            // 5. Error in DJ loop is forwarded to onError callback
            await controller.runDJLoop();
            assert.ok(errors.includes('Simulated DJ background loop error'));
        } finally {
            controller.stop();
            SpotifyAuth.refreshToken = origRefresh;
        }
    });

    it('unifies AI provider/key resolution across computeSetupStatus and applyStoredConfigToDJ and clears stale AI on key removal', async () => {
        const dj = new DJCore('fake_token');

        // 1. Legacy fallback when SELECTED_AI_PROVIDER is not yet stored -> picks Gemini key & default model
        store[STORAGE_KEYS.SPOTIFY_CLIENT_ID] = '  cid_123  ';
        store[STORAGE_KEYS.GEMINI_API_KEY] = '  AIza_test  ';
        store[STORAGE_KEYS.GEMINI_MODEL] = '   ';
        const resolvedLegacy = resolveAIConfigFromStorage();
        assert.deepStrictEqual(resolvedLegacy, {
            provider: 'gemini',
            apiKey: 'AIza_test',
            model: DEFAULT_MODELS.GEMINI,
        });
        assert.deepStrictEqual(computeSetupStatus(), { hasClientId: true, hasAiKey: true });
        applyStoredConfigToDJ(dj);

        // 2. User explicitly switches provider to 'openai' without setting OPENAI_API_KEY ->
        // BOTH computeSetupStatus and applyStoredConfigToDJ agree AI is unconfigured, and dj.clearAI() removes stale client!
        store[STORAGE_KEYS.SELECTED_AI_PROVIDER] = 'openai';
        assert.strictEqual(resolveAIConfigFromStorage(), null);
        assert.deepStrictEqual(computeSetupStatus(), { hasClientId: true, hasAiKey: false });
        applyStoredConfigToDJ(dj);
        await assert.rejects(
            async () => dj.createSchedule('play jazz'),
            /AI not initialized/
        );
    });

    it('derives shouldShowOnboarding across all 3 setup checklist steps without reload flash', () => {
        // Step 1 incomplete (no Client ID)
        assert.strictEqual(
            shouldShowOnboarding({ setupStatus: { hasClientId: false, hasAiKey: false }, authorized: false, isAuthPending: false }),
            true
        );

        // Step 1 complete, Step 2 incomplete (missing AI key) -> must keep Onboarding visible even if authorized
        assert.strictEqual(
            shouldShowOnboarding({ setupStatus: { hasClientId: true, hasAiKey: false }, authorized: true, isAuthPending: false }),
            true
        );

        // Step 1 & 2 complete, Step 3 incomplete (not logged in, no pending token refresh) -> must show Onboarding Step 3 Login!
        assert.strictEqual(
            shouldShowOnboarding({ setupStatus: { hasClientId: true, hasAiKey: true }, authorized: false, isAuthPending: false }),
            true
        );

        // Step 1 & 2 complete, token refresh or OAuth callback in flight -> suppress Onboarding flash!
        assert.strictEqual(
            shouldShowOnboarding({ setupStatus: { hasClientId: true, hasAiKey: true }, authorized: false, isAuthPending: true }),
            false
        );

        // All 3 steps complete -> show main Queue UI
        assert.strictEqual(
            shouldShowOnboarding({ setupStatus: { hasClientId: true, hasAiKey: true }, authorized: true, isAuthPending: false }),
            false
        );
    });

    it('classifies Web Speech API errors into concrete bilingual hints and ignores benign aborts', () => {
        assert.strictEqual(classifySpeechRecognitionError(undefined), null);
        assert.strictEqual(classifySpeechRecognitionError('no-speech'), null);
        assert.strictEqual(classifySpeechRecognitionError('aborted'), null);

        assert.match(classifySpeechRecognitionError('not-allowed') || '', /マイクへのアクセスが拒否/);
        assert.match(classifySpeechRecognitionError('service-not-allowed') || '', /Microphone access was denied/);
        assert.match(classifySpeechRecognitionError('audio-capture') || '', /マイクが見つかりません/);
        assert.match(classifySpeechRecognitionError('network') || '', /ネットワークエラー/);
        assert.match(classifySpeechRecognitionError('language-not-supported') || '', /サポートされていません/);
        assert.match(classifySpeechRecognitionError('bad-grammar') || '', /bad-grammar/);
    });

    it('classifies cross-tab localStorage events into reload_config, sync_schedule, sync_query, or ignore', () => {
        // localStorage.clear() emits key === null -> must reload config & auth state
        assert.strictEqual(classifyStorageEventAction(null), 'reload_config');
        assert.strictEqual(classifyStorageEventAction(STORAGE_KEYS.SPOTIFY_ACCESS_TOKEN), 'reload_config');
        assert.strictEqual(classifyStorageEventAction(STORAGE_KEYS.SPOTIFY_CLIENT_ID), 'reload_config');
        assert.strictEqual(classifyStorageEventAction(STORAGE_KEYS.OPENAI_API_KEY), 'reload_config');
        assert.strictEqual(classifyStorageEventAction(STORAGE_KEYS.GEMINI_API_KEY), 'reload_config');
        assert.strictEqual(classifyStorageEventAction(STORAGE_KEYS.SELECTED_AI_PROVIDER), 'reload_config');
        assert.strictEqual(classifyStorageEventAction(STORAGE_KEYS.BACKGROUND_KEEP_ALIVE), 'reload_config');

        // Schedule and query updates from sibling tabs
        assert.strictEqual(classifyStorageEventAction(STORAGE_KEYS.DJ_SCHEDULE), 'sync_schedule');
        assert.strictEqual(classifyStorageEventAction(STORAGE_KEYS.DJ_LAST_QUERY), 'sync_query');

        // UI-local or transient keys should not trigger full config reload in PlayerContext
        assert.strictEqual(classifyStorageEventAction(STORAGE_KEYS.PROMPT_HISTORY), 'ignore');
        assert.strictEqual(classifyStorageEventAction(STORAGE_KEYS.SHOW_NOTES), 'ignore');
        assert.strictEqual(classifyStorageEventAction('unrelated_third_party_key'), 'ignore');
    });

    it('validates Vision API image files for MIME support, extension fallback, empty files, and 20MB ceiling', () => {
        // Supported formats & image/jpg normalization
        assert.deepStrictEqual(
            validateVisionImageFile({ type: 'image/jpeg', size: 512_000, name: 'photo.jpg' }),
            { ok: true, normalizedMimeType: 'image/jpeg' }
        );
        assert.deepStrictEqual(
            validateVisionImageFile({ type: 'IMAGE/JPG', size: 1024, name: 'cam.JPG' }),
            { ok: true, normalizedMimeType: 'image/jpeg' }
        );
        assert.deepStrictEqual(
            validateVisionImageFile({ type: 'image/png', size: 2048, name: 'shot.png' }),
            { ok: true, normalizedMimeType: 'image/png' }
        );
        assert.deepStrictEqual(
            validateVisionImageFile({ type: 'image/webp', size: 4096, name: 'scene.webp' }),
            { ok: true, normalizedMimeType: 'image/webp' }
        );
        assert.deepStrictEqual(
            validateVisionImageFile({ type: 'image/gif', size: 4096, name: 'anim.gif' }),
            { ok: true, normalizedMimeType: 'image/gif' }
        );

        // Fallback to file extension when browser provides empty MIME type
        assert.deepStrictEqual(
            validateVisionImageFile({ type: '', size: 12_000, name: 'camera_upload.jpeg' }),
            { ok: true, normalizedMimeType: 'image/jpeg' }
        );

        // Empty file rejected
        const emptyRes = validateVisionImageFile({ type: 'image/png', size: 0, name: 'empty.png' });
        assert.strictEqual(emptyRes.ok, false);
        assert.match(emptyRes.errorMessage || '', /empty|空/);

        // > 20MB rejected with concrete MB display
        const hugeRes = validateVisionImageFile({
            type: 'image/jpeg',
            size: MAX_VISION_IMAGE_BYTES + 2 * 1024 * 1024,
            name: 'raw.jpg',
        });
        assert.strictEqual(hugeRes.ok, false);
        assert.match(hugeRes.errorMessage || '', /22\.0MB/);
        assert.match(hugeRes.errorMessage || '', /20MB/);

        // Unsupported image formats (HEIC, SVG) rejected with format hint
        const heicRes = validateVisionImageFile({ type: 'image/heic', size: 500_000, name: 'IMG_0001.HEIC' });
        assert.strictEqual(heicRes.ok, false);
        assert.match(heicRes.errorMessage || '', /image\/heic/);
        assert.match(heicRes.errorMessage || '', /JPEG, PNG, WebP, or GIF/);

        const heicNoMimeRes = validateVisionImageFile({ type: '', size: 500_000, name: 'IMG_0002.heic' });
        assert.strictEqual(heicNoMimeRes.ok, false);
        assert.match(heicNoMimeRes.errorMessage || '', /\.heic/);

        const svgRes = validateVisionImageFile({ type: 'image/svg+xml', size: 1000, name: 'icon.svg' });
        assert.strictEqual(svgRes.ok, false);
        assert.match(svgRes.errorMessage || '', /image\/svg\+xml/);

        // Non-image file rejected
        const pdfRes = validateVisionImageFile({ type: 'application/pdf', size: 10_000, name: 'doc.pdf' });
        assert.strictEqual(pdfRes.ok, false);
        assert.match(pdfRes.errorMessage || '', /画像ファイルを選択/);
    });

    it('synchronizes Settings Spotify session status across other-tab storage events and same-tab logout/refresh', () => {
        const listeners = new Map<string, Set<(ev?: unknown) => void>>();
        const g = globalThis as Record<string, unknown>;
        g.window = {
            localStorage: g.localStorage,
            addEventListener: (type: string, fn: (ev?: unknown) => void) => {
                if (!listeners.has(type)) listeners.set(type, new Set());
                listeners.get(type)!.add(fn);
            },
            removeEventListener: (type: string, fn: (ev?: unknown) => void) => {
                listeners.get(type)?.delete(fn);
            },
            dispatchEvent: (ev: Event) => {
                listeners.get(ev.type)?.forEach((fn) => fn(ev));
                return true;
            },
        };

        store[STORAGE_KEYS.SPOTIFY_CLIENT_ID] = 'cid_1';
        store[STORAGE_KEYS.SPOTIFY_ACCESS_TOKEN] = 'tok_1';
        store[STORAGE_KEYS.SPOTIFY_REFRESH_TOKEN] = 'ref_1';
        assert.strictEqual(hasStoredSpotifyTokens(), true);

        let storeChangeCount = 0;
        const unsubscribe = subscribeSpotifySessionStore(() => {
            storeChangeCount++;
        });

        // 1. Unrelated storage event in another tab does NOT trigger session store notification
        listeners.get('storage')?.forEach((fn) => fn({ key: STORAGE_KEYS.DJ_LAST_QUERY }));
        assert.strictEqual(storeChangeCount, 0);

        // 2. Another tab logs out (removes access & refresh tokens) -> fires notification & snapshot becomes false
        delete store[STORAGE_KEYS.SPOTIFY_ACCESS_TOKEN];
        delete store[STORAGE_KEYS.SPOTIFY_REFRESH_TOKEN];
        listeners.get('storage')?.forEach((fn) => fn({ key: STORAGE_KEYS.SPOTIFY_ACCESS_TOKEN }));
        assert.strictEqual(storeChangeCount, 1);
        assert.strictEqual(hasStoredSpotifyTokens(), false);

        // 3. Another tab logs in (sets refresh token) -> snapshot becomes true
        store[STORAGE_KEYS.SPOTIFY_REFRESH_TOKEN] = 'ref_2';
        listeners.get('storage')?.forEach((fn) => fn({ key: STORAGE_KEYS.SPOTIFY_REFRESH_TOKEN }));
        assert.strictEqual(storeChangeCount, 2);
        assert.strictEqual(hasStoredSpotifyTokens(), true);

        // 4. Another tab clears SPOTIFY_CLIENT_ID -> fires notification & snapshot becomes false even if stale refresh token remains
        store[STORAGE_KEYS.SPOTIFY_CLIENT_ID] = '';
        listeners.get('storage')?.forEach((fn) => fn({ key: STORAGE_KEYS.SPOTIFY_CLIENT_ID }));
        assert.strictEqual(storeChangeCount, 3);
        assert.strictEqual(hasStoredSpotifyTokens(), false);

        // 5. Same-tab persistSettingsFormState invalidates OAuth tokens when Client ID is cleared or changed to another app ID
        store[STORAGE_KEYS.SPOTIFY_CLIENT_ID] = 'cid_1';
        store[STORAGE_KEYS.SPOTIFY_ACCESS_TOKEN] = 'tok_2';
        store[STORAGE_KEYS.SPOTIFY_REFRESH_TOKEN] = 'ref_2';
        assert.strictEqual(hasStoredSpotifyTokens(), true);

        const baseForm = readSettingsFormStateFromStorage('ja-JP');
        persistSettingsFormState({ ...baseForm, spotifyClientId: '  cid_2  ' });
        assert.strictEqual(store[STORAGE_KEYS.SPOTIFY_CLIENT_ID], 'cid_2');
        assert.strictEqual(store[STORAGE_KEYS.SPOTIFY_ACCESS_TOKEN], undefined);
        assert.strictEqual(store[STORAGE_KEYS.SPOTIFY_REFRESH_TOKEN], undefined);
        assert.strictEqual(hasStoredSpotifyTokens(), false);
        assert.strictEqual(storeChangeCount, 4);

        store[STORAGE_KEYS.SPOTIFY_ACCESS_TOKEN] = 'tok_3';
        assert.strictEqual(hasStoredSpotifyTokens(), true);
        persistSettingsFormState({ ...readSettingsFormStateFromStorage('ja-JP'), spotifyClientId: '   ' });
        assert.strictEqual(store[STORAGE_KEYS.SPOTIFY_ACCESS_TOKEN], undefined);
        assert.strictEqual(hasStoredSpotifyTokens(), false);
        assert.strictEqual(storeChangeCount, 5);

        // 6. Same-tab SpotifyAuth.logout() dispatches SPOTIFY_AUTH_SYNC_EVENT -> snapshot becomes false immediately
        store[STORAGE_KEYS.SPOTIFY_CLIENT_ID] = 'cid_2';
        store[STORAGE_KEYS.SPOTIFY_ACCESS_TOKEN] = 'tok_4';
        assert.strictEqual(hasStoredSpotifyTokens(), true);
        SpotifyAuth.logout();
        assert.strictEqual(storeChangeCount, 6);
        assert.strictEqual(hasStoredSpotifyTokens(), false);
        assert.strictEqual(listeners.get(SPOTIFY_AUTH_SYNC_EVENT)?.size, 1);

        unsubscribe();
        assert.strictEqual(listeners.get(SPOTIFY_AUTH_SYNC_EVENT)?.size, 0);
    });

    it('synchronizes Settings form fields across cross-tab storage changes without clobbering unrelated unsaved edits', () => {
        store[STORAGE_KEYS.SPOTIFY_CLIENT_ID] = 'cid_initial';
        store[STORAGE_KEYS.GEMINI_API_KEY] = 'AIza_initial';

        const initial = readSettingsFormStateFromStorage('en-US');
        assert.strictEqual(initial.spotifyClientId, 'cid_initial');
        assert.strictEqual(initial.aiProvider, 'gemini');
        assert.strictEqual(initial.openAiModel, DEFAULT_MODELS.OPENAI);
        assert.strictEqual(initial.geminiModel, DEFAULT_MODELS.GEMINI);
        assert.strictEqual(initial.voiceLang, 'en-US');
        assert.strictEqual(initial.aiFilteringEnabled, DEFAULTS.AI_FILTERING_ENABLED);

        // Simulate user typing unsaved text into personalPref on /settings
        const withUnsavedDraft = { ...initial, personalPref: 'unsaved draft in progress' };

        // 1. Background playback storage updates in another tab leave form state reference untouched
        const afterPlaybackKey = applySettingsStorageEvent(withUnsavedDraft, STORAGE_KEYS.DJ_CURRENT_PLAYING_TRACK, 'en-US');
        assert.strictEqual(afterPlaybackKey, withUnsavedDraft);

        // 2. Another tab updates OPENAI_API_KEY and SELECTED_AI_PROVIDER -> updates those fields while preserving unsaved personalPref!
        store[STORAGE_KEYS.OPENAI_API_KEY] = 'sk_new_key';
        store[STORAGE_KEYS.SELECTED_AI_PROVIDER] = 'openai';
        store[STORAGE_KEYS.AI_FILTERING_ENABLED] = 'false';
        let synced = applySettingsStorageEvent(withUnsavedDraft, STORAGE_KEYS.OPENAI_API_KEY, 'en-US');
        synced = applySettingsStorageEvent(synced, STORAGE_KEYS.SELECTED_AI_PROVIDER, 'en-US');
        synced = applySettingsStorageEvent(synced, STORAGE_KEYS.AI_FILTERING_ENABLED, 'en-US');
        assert.strictEqual(synced.openAiKey, 'sk_new_key');
        assert.strictEqual(synced.aiProvider, 'openai');
        assert.strictEqual(synced.aiFilteringEnabled, false);
        assert.strictEqual(synced.personalPref, 'unsaved draft in progress');

        // 3. Another tab calls localStorage.clear() (key === null) -> resets all settings cleanly to storage defaults
        store = {};
        const afterClear = applySettingsStorageEvent(synced, null, 'ja-JP');
        assert.strictEqual(afterClear.spotifyClientId, '');
        assert.strictEqual(afterClear.openAiKey, '');
        assert.strictEqual(afterClear.geminiKey, '');
        assert.strictEqual(afterClear.aiProvider, DEFAULTS.AI_PROVIDER);
        assert.strictEqual(afterClear.personalPref, '');
        assert.strictEqual(afterClear.voiceLang, 'ja-JP');
        assert.strictEqual(afterClear.aiFilteringEnabled, DEFAULTS.AI_FILTERING_ENABLED);

        // 4. Short/regional/unsupported browser locales normalize cleanly to supported <select> option values
        assert.strictEqual(normalizeVoiceLang('ja'), 'ja-JP');
        assert.strictEqual(normalizeVoiceLang('en'), 'en-US');
        assert.strictEqual(normalizeVoiceLang('en-gb'), 'en-GB');
        assert.strictEqual(normalizeVoiceLang('zh-TW'), 'zh-CN');
        assert.strictEqual(normalizeVoiceLang('pt-BR'), 'ja-JP');
        assert.strictEqual(normalizeVoiceLang(''), 'ja-JP');
    });
});
