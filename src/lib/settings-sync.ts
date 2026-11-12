import { DEFAULT_MODELS, DEFAULTS, STORAGE_KEYS } from './constants';
import { getStorageItem, getStoredJSON } from './storage';
import { AIProvider } from './types';

export const SPOTIFY_AUTH_SYNC_EVENT = 'contextdj:spotify-auth-sync';

export const SUPPORTED_VOICE_LANGS = [
    'ja-JP',
    'en-US',
    'en-GB',
    'es-ES',
    'fr-FR',
    'de-DE',
    'ko-KR',
    'zh-CN',
] as const;

const VOICE_LANG_PRIMARY_MAP: Record<string, string> = {
    ja: 'ja-JP',
    en: 'en-US',
    es: 'es-ES',
    fr: 'fr-FR',
    de: 'de-DE',
    ko: 'ko-KR',
    zh: 'zh-CN',
};

export interface SettingsFormState {
    spotifyClientId: string;
    openAiKey: string;
    openAiModel: string;
    geminiKey: string;
    geminiModel: string;
    aiProvider: AIProvider;
    personalPref: string;
    prefHistory: string[];
    voiceLang: string;
    backgroundKeepAlive: boolean;
    aiFilteringEnabled: boolean;
}

export const SERVER_DEFAULT_SETTINGS_FORM: SettingsFormState = {
    spotifyClientId: '',
    openAiKey: '',
    openAiModel: DEFAULT_MODELS.OPENAI,
    geminiKey: '',
    geminiModel: DEFAULT_MODELS.GEMINI,
    aiProvider: DEFAULTS.AI_PROVIDER,
    personalPref: '',
    prefHistory: [],
    voiceLang: DEFAULTS.VOICE_LANG,
    backgroundKeepAlive: false,
    aiFilteringEnabled: DEFAULTS.AI_FILTERING_ENABLED,
};

/**
 * Normalizes a browser/OS or stored locale tag (e.g. "ja", "en", "en-gb", "pt-BR")
 * into one of the supported Settings `<select>` voice input languages, falling back to `DEFAULTS.VOICE_LANG` ("ja-JP").
 */
export function normalizeVoiceLang(rawLang?: string | null): string {
    if (!rawLang) return DEFAULTS.VOICE_LANG;
    const trimmed = rawLang.trim().replace(/_/g, '-');
    if (!trimmed) return DEFAULTS.VOICE_LANG;

    const exactMatch = SUPPORTED_VOICE_LANGS.find(
        (opt) => opt.toLowerCase() === trimmed.toLowerCase()
    );
    if (exactMatch) return exactMatch;

    const primary = trimmed.split('-')[0].toLowerCase();
    return VOICE_LANG_PRIMARY_MAP[primary] || DEFAULTS.VOICE_LANG;
}

export function getDefaultVoiceLang(): string {
    if (typeof navigator !== 'undefined' && navigator.language) {
        return normalizeVoiceLang(navigator.language);
    }
    return DEFAULTS.VOICE_LANG;
}

export function hasStoredSpotifyTokens(): boolean {
    return Boolean(
        getStorageItem(STORAGE_KEYS.SPOTIFY_ACCESS_TOKEN, '') ||
        getStorageItem(STORAGE_KEYS.SPOTIFY_REFRESH_TOKEN, '')
    );
}

export function subscribeSpotifySessionStore(onStoreChange: () => void): () => void {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
        return () => {};
    }
    const handleStorage = (e: StorageEvent) => {
        if (
            e.key === null ||
            e.key === STORAGE_KEYS.SPOTIFY_ACCESS_TOKEN ||
            e.key === STORAGE_KEYS.SPOTIFY_REFRESH_TOKEN ||
            e.key === STORAGE_KEYS.SPOTIFY_EXPIRES_AT
        ) {
            onStoreChange();
        }
    };
    window.addEventListener('storage', handleStorage);
    window.addEventListener(SPOTIFY_AUTH_SYNC_EVENT, onStoreChange);
    return () => {
        window.removeEventListener('storage', handleStorage);
        window.removeEventListener(SPOTIFY_AUTH_SYNC_EVENT, onStoreChange);
    };
}

export function notifySpotifyAuthStateChanged(): void {
    if (
        typeof window !== 'undefined' &&
        typeof window.dispatchEvent === 'function' &&
        typeof Event === 'function'
    ) {
        window.dispatchEvent(new Event(SPOTIFY_AUTH_SYNC_EVENT));
    }
}

export function resolveInitialAIProviderFromStorage(): AIProvider {
    const savedProvider = getStorageItem(STORAGE_KEYS.SELECTED_AI_PROVIDER, '').trim();
    if (savedProvider === 'gemini' || savedProvider === 'openai') {
        return savedProvider;
    }
    const hasGemini = Boolean(getStorageItem(STORAGE_KEYS.GEMINI_API_KEY, '').trim());
    const hasOpenAi = Boolean(getStorageItem(STORAGE_KEYS.OPENAI_API_KEY, '').trim());
    return hasGemini && !hasOpenAi ? 'gemini' : DEFAULTS.AI_PROVIDER;
}

export function readSettingsFormStateFromStorage(
    defaultVoiceLang: string = getDefaultVoiceLang()
): SettingsFormState {
    const savedFiltering = getStorageItem(STORAGE_KEYS.AI_FILTERING_ENABLED, '');
    return {
        spotifyClientId: getStorageItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID, ''),
        openAiKey: getStorageItem(STORAGE_KEYS.OPENAI_API_KEY, ''),
        openAiModel: getStorageItem(STORAGE_KEYS.OPENAI_MODEL, '') || DEFAULT_MODELS.OPENAI,
        geminiKey: getStorageItem(STORAGE_KEYS.GEMINI_API_KEY, ''),
        geminiModel: getStorageItem(STORAGE_KEYS.GEMINI_MODEL, '') || DEFAULT_MODELS.GEMINI,
        aiProvider: resolveInitialAIProviderFromStorage(),
        personalPref: getStorageItem(STORAGE_KEYS.PERSONAL_PREFERENCE, ''),
        prefHistory: getStoredJSON<string[]>(STORAGE_KEYS.PERSONAL_PREFERENCE_HISTORY, []),
        voiceLang: normalizeVoiceLang(getStorageItem(STORAGE_KEYS.VOICE_INPUT_LANG, '') || defaultVoiceLang),
        backgroundKeepAlive: getStorageItem(STORAGE_KEYS.BACKGROUND_KEEP_ALIVE, '') === 'true',
        aiFilteringEnabled: savedFiltering === '' ? DEFAULTS.AI_FILTERING_ENABLED : savedFiltering === 'true',
    };
}

/**
 * Applies a cross-tab `StorageEvent` (`key === null` on `localStorage.clear()` or a specific key)
 * to `SettingsFormState` without clobbering unrelated in-progress form fields during background playback.
 */
export function applySettingsStorageEvent(
    prev: SettingsFormState,
    key: string | null,
    defaultVoiceLang: string = getDefaultVoiceLang()
): SettingsFormState {
    if (key === null) {
        return readSettingsFormStateFromStorage(defaultVoiceLang);
    }

    switch (key) {
        case STORAGE_KEYS.SPOTIFY_CLIENT_ID:
            return { ...prev, spotifyClientId: getStorageItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID, '') };
        case STORAGE_KEYS.OPENAI_API_KEY:
            return {
                ...prev,
                openAiKey: getStorageItem(STORAGE_KEYS.OPENAI_API_KEY, ''),
                aiProvider: resolveInitialAIProviderFromStorage(),
            };
        case STORAGE_KEYS.OPENAI_MODEL:
            return {
                ...prev,
                openAiModel: getStorageItem(STORAGE_KEYS.OPENAI_MODEL, '') || DEFAULT_MODELS.OPENAI,
            };
        case STORAGE_KEYS.GEMINI_API_KEY:
            return {
                ...prev,
                geminiKey: getStorageItem(STORAGE_KEYS.GEMINI_API_KEY, ''),
                aiProvider: resolveInitialAIProviderFromStorage(),
            };
        case STORAGE_KEYS.GEMINI_MODEL:
            return {
                ...prev,
                geminiModel: getStorageItem(STORAGE_KEYS.GEMINI_MODEL, '') || DEFAULT_MODELS.GEMINI,
            };
        case STORAGE_KEYS.SELECTED_AI_PROVIDER:
            return { ...prev, aiProvider: resolveInitialAIProviderFromStorage() };
        case STORAGE_KEYS.PERSONAL_PREFERENCE:
            return { ...prev, personalPref: getStorageItem(STORAGE_KEYS.PERSONAL_PREFERENCE, '') };
        case STORAGE_KEYS.PERSONAL_PREFERENCE_HISTORY:
            return {
                ...prev,
                prefHistory: getStoredJSON<string[]>(STORAGE_KEYS.PERSONAL_PREFERENCE_HISTORY, []),
            };
        case STORAGE_KEYS.VOICE_INPUT_LANG:
            return {
                ...prev,
                voiceLang: normalizeVoiceLang(
                    getStorageItem(STORAGE_KEYS.VOICE_INPUT_LANG, '') || defaultVoiceLang
                ),
            };
        case STORAGE_KEYS.BACKGROUND_KEEP_ALIVE:
            return {
                ...prev,
                backgroundKeepAlive: getStorageItem(STORAGE_KEYS.BACKGROUND_KEEP_ALIVE, '') === 'true',
            };
        case STORAGE_KEYS.AI_FILTERING_ENABLED: {
            const savedFiltering = getStorageItem(STORAGE_KEYS.AI_FILTERING_ENABLED, '');
            return {
                ...prev,
                aiFilteringEnabled:
                    savedFiltering === '' ? DEFAULTS.AI_FILTERING_ENABLED : savedFiltering === 'true',
            };
        }
        default:
            return prev;
    }
}
