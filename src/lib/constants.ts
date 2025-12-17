export const STORAGE_KEYS = {
    // Spotify Auth
    SPOTIFY_CLIENT_ID: 'spotify_client_id',
    SPOTIFY_ACCESS_TOKEN: 'spotify_access_token',
    SPOTIFY_REFRESH_TOKEN: 'spotify_refresh_token',
    SPOTIFY_EXPIRES_AT: 'spotify_expires_at',
    SPOTIFY_VERIFIER: 'spotify_verifier',

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
    VOICE_INPUT_LANG: 'voice_input_lang',
    BACKGROUND_KEEP_ALIVE: 'background_keep_alive',
} as const;
