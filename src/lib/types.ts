export type AIProvider = 'openai' | 'gemini';

export interface TrackEvaluation {
    id: string;              // Spotify URI
    score: number;           // 0-100 (Relevance to context)
    vibeTag: string;         // e.g. "#夕暮れチル"
    selectionReason: string; // DJ's short rationale
    estimatedBpm?: number;   // Estimated BPM
    energy?: number;         // 1-10 intensity
    stage?: 'intro' | 'build' | 'peak' | 'outro'; // Sequencing stage
}

export interface ScheduleItem {
    start: string;
    end: string;
    query: string;
    queries?: string[]; // Support multiple search queries
    anchorTracks?: string[]; // Iconic tracks or artists representing this block
    priorityTrack?: string; // Query for a specific song to play first
    thought?: string; // DJ's reasoning/comment
    userRequest?: string; // Original user instruction for context
}

export interface TrackMetadata {
    contextName?: string;
    score?: number;
    vibeTag?: string;
    selectionReason?: string;
    estimatedBpm?: number;
    energy?: number;
    stage?: 'intro' | 'build' | 'peak' | 'outro';
}

export interface Track extends SpotifyApi.TrackObjectFull, TrackMetadata {}

export interface DJConfig {
    minPopularity: number;
    trackSearchLimit: number;
    onlyOfficial: boolean;
    aiFiltering: boolean;
}

export interface SearchPipelineContext {
    userRequest?: string;
    thought?: string;
    anchorTracks?: string[];
}

// Spotify Queue API Types (/v1/me/player/queue)
export interface SpotifyNonTrackQueueItem {
    type?: string;
    id?: string;
    uri?: string;
    name?: string;
}

export type SpotifyQueueItem = Track | SpotifyNonTrackQueueItem;

export interface SpotifyQueueResponse {
    currently_playing: Track | null;
    queue: Track[];
}

// Granular Spotify API Error Classification
export type SpotifyErrorCategory =
    | 'auth_expired'       // 401 Unauthorized
    | 'forbidden'          // 403 Forbidden (Premium required / device restriction)
    | 'device_not_found'   // 404 Not Found (Device asleep / inactive)
    | 'rate_limited'       // 429 Too Many Requests
    | 'network_or_server'; // 5xx or network error

export interface SpotifyApiErrorInfo {
    status?: number;
    category: SpotifyErrorCategory;
    operation: string;
    message: string;
    retryAfterSeconds?: number;
}

export interface SpotifyControlResult {
    ok: boolean;
    status?: number;
    error?: SpotifyApiErrorInfo;
}

// DJCore Subscription / Event Types
export interface DJStateSnapshot {
    status: string;
    schedule: ScheduleItem[];
    currentQuery: string | null;
    currentThought: string | null;
    logs: string[];
    lastError: string | null;
}

export type DJStateListener = (snapshot: DJStateSnapshot) => void;
export type DJLogListener = (logs: string[]) => void;
export type DJErrorListener = (errorMessage: string, errorInfo?: SpotifyApiErrorInfo) => void;

// Web Speech API Types
export interface SpeechRecognitionAlternative {
    readonly transcript: string;
    readonly confidence: number;
}

export interface SpeechRecognitionResult {
    readonly isFinal: boolean;
    readonly length: number;
    item(index: number): SpeechRecognitionAlternative;
    [index: number]: SpeechRecognitionAlternative;
}

export interface SpeechRecognitionResultList {
    readonly length: number;
    item(index: number): SpeechRecognitionResult;
    [index: number]: SpeechRecognitionResult;
}

export interface SpeechRecognitionEvent extends Event {
    readonly resultIndex: number;
    readonly results: SpeechRecognitionResultList;
}

export interface ISpeechRecognition extends EventTarget {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    onstart: ((this: ISpeechRecognition, ev: Event) => void) | null;
    onresult: ((this: ISpeechRecognition, ev: SpeechRecognitionEvent) => void) | null;
    onerror: ((this: ISpeechRecognition, ev: Event) => void) | null;
    onend: ((this: ISpeechRecognition, ev: Event) => void) | null;
    start(): void;
    stop(): void;
    abort(): void;
}

export interface ISpeechRecognitionConstructor {
    new (): ISpeechRecognition;
}

declare global {
    interface Window {
        SpeechRecognition?: ISpeechRecognitionConstructor;
        webkitSpeechRecognition?: ISpeechRecognitionConstructor;
    }

    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace SpotifyApi {
        interface CurrentPlaybackResponse {
            currently_playing_type?: 'track' | 'episode' | 'ad' | 'unknown' | string;
            __optimisticFallback?: boolean;
        }
    }
}

