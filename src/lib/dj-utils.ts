import { Track, ScheduleItem } from './types';

/**
 * Normalizes track titles by stripping version strings, remaster tags, and parentheses.
 */
export function normalizeTrackName(name: string): string {
    // Remove text within parentheses or tildes/wave dashes (half-width and full-width)
    let clean = name.replace(/[(\[（［~〜].*?[)\]）］~〜]/g, '');
    // Remove common metadata patterns after hyphen, slash, or tildes
    clean = clean.replace(/\s*[-/〜~]\s*.*$/g, '');
    // Remove remastered/version/instrumental strings
    clean = clean.replace(/(remaster|version|live|edit|radio|mix|instrumental).*$/i, '');

    return clean.trim().toLowerCase();
}

/**
 * Generates a unique deduplication key for a track based on normalized title and main artist.
 */
export function generateTrackKey(track: Track | SpotifyApi.TrackObjectFull): string {
    const cleanName = normalizeTrackName(track.name);
    const artist = track.artists?.[0]?.name?.toLowerCase()?.trim() || '';
    return `${cleanName}|${artist}`;
}

/**
 * Checks whether a given schedule item is currently active for the specified date.
 * Handles overnight slots (e.g. 23:00 - 01:00).
 */
export function isScheduleItemActive(item: ScheduleItem, date: Date = new Date()): boolean {
    const currentTime = date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });

    if (item.start <= item.end) {
        return item.start <= currentTime && currentTime < item.end;
    }
    // Overnight case (e.g., 23:00 - 01:00)
    return currentTime >= item.start || currentTime < item.end;
}

/**
 * Checks whether a schedule item has already passed.
 * Handles overnight slots appropriately.
 */
export function isScheduleItemPast(item: ScheduleItem, date: Date = new Date()): boolean {
    if (isScheduleItemActive(item, date)) return false;

    const currentTime = date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });

    if (item.start <= item.end) {
        return currentTime >= item.end;
    }
    // Overnight case: passed if current time is after end but before start
    return currentTime >= item.end && currentTime < item.start;
}

/**
 * Resolves the query array for a schedule item.
 */
export function getScheduleItemQueries(item: ScheduleItem): string[] {
    if (item.queries && item.queries.length > 0) {
        return item.queries;
    }
    return item.query ? [item.query] : [];
}

/**
 * Generates a unique signature for a schedule item to detect context changes.
 */
export function getScheduleItemSignature(item: ScheduleItem): string {
    const queries = getScheduleItemQueries(item);
    const priority = item.priorityTrack ? `|${item.priorityTrack}` : '';
    return `${queries.join('|')}${priority}`;
}



