import { AIProvider } from './types';

export const STORAGE_KEYS = {
    // Spotify Auth
    SPOTIFY_CLIENT_ID: 'spotify_client_id',
    SPOTIFY_ACCESS_TOKEN: 'spotify_access_token',
    SPOTIFY_REFRESH_TOKEN: 'spotify_refresh_token',
    SPOTIFY_EXPIRES_AT: 'spotify_expires_at',
    SPOTIFY_VERIFIER: 'spotify_verifier',
    SPOTIFY_AUTH_STATE: 'spotify_auth_state',

    // AI Settings
    SELECTED_AI_PROVIDER: 'selected_ai_provider',
    OPENAI_API_KEY: 'openai_api_key',
    OPENAI_MODEL: 'openai_model',
    GEMINI_API_KEY: 'gemini_api_key',
    GEMINI_MODEL: 'gemini_model',

    // App State
    DJ_SCHEDULE: 'dj_schedule',
    DJ_LAST_QUERY: 'dj_last_query',
    PROMPT_HISTORY: 'prompt_history',
    PERSONAL_PREFERENCE: 'personal_preference',
    PERSONAL_PREFERENCE_HISTORY: 'personal_pref_history',
    VOICE_INPUT_LANG: 'voice_input_lang',
    BACKGROUND_KEEP_ALIVE: 'background_keep_alive',
    SHOW_AI_THOUGHT: 'show_ai_thought',
    AI_FILTERING_ENABLED: 'ai_filtering_enabled',
} as const;

export const DEFAULT_MODELS = {
    OPENAI: 'gpt-5.4-mini',
    GEMINI: 'gemini-3.6-flash',
} as const;

export const DEFAULTS = {
    AI_PROVIDER: 'openai' as AIProvider,
    VOICE_LANG: 'ja-JP' as string,
    BACKGROUND_KEEP_ALIVE: false as boolean,
    AI_FILTERING_ENABLED: true as boolean,
} as const;

export const PRIVACY_NOTICE = {
    EN: "All Secure Information (API Keys, etc.) is stored **locally in your browser**. We do NOT send this information to any external server other than the respective AI providers (OpenAI/Google) for the sole purpose of generating responses.",
    JP: "安全に関わる情報 (APIキーなど) は、すべて**ご利用のブラウザ内にローカル保存**されます。応答生成の目的以外で、各AIプロバイダー (OpenAI/Google) 以外の外部サーバーに情報を送信することは一切ありません。"
};

export const PLAYBACK_CONSTANTS = {
    UI_POLL_INTERVAL_MS: 3000,
    UI_POLL_FAST_INTERVAL_MS: 1000,
    DJ_LOOP_INTERVAL_MS: 5000,
    TOKEN_REFRESH_BUFFER_MS: 300000, // 5 minutes
    TRACK_REMAINING_THRESHOLD_MS: 10000,
    MIN_QUEUE_SIZE_FOR_REFILL: 3,
    TRACK_SEARCH_LIMIT: 40,
    MIN_TRACK_POPULARITY: 45,
} as const;
