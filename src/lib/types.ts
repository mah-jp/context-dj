export type AIProvider = 'openai' | 'gemini';

export interface ScheduleItem {
    start: string;
    end: string;
    query: string;
    queries?: string[]; // Support multiple search queries
    priorityTrack?: string; // Query for a specific song to play first
    thought?: string; // DJ's reasoning/comment
    userRequest?: string; // Original user instruction for context
}

export interface Track extends SpotifyApi.TrackObjectFull {
    contextName?: string;
}

export interface DJConfig {
    minPopularity: number;
    trackSearchLimit: number;
    onlyOfficial: boolean;
    aiFiltering: boolean;
}

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
}
