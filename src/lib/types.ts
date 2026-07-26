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
