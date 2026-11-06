import { Track, ScheduleItem } from './types';

/**
 * Normalizes track titles by stripping version strings, remaster tags, and parentheses
 * while preserving hyphenated words (e.g. "Anti-Hero", "Lo-Fi") and words containing
 * substrings like "live" or "edit" (e.g. "Alive", "Meditation", "Live Forever").
 */
export function normalizeTrackName(name: string): string {
    if (!name) return '';
    // Remove text within parentheses, brackets, or tildes/wave dashes (half-width and full-width)
    let clean = name.replace(/[(\[（［~〜].*?[)\]）］~〜]/g, '');
    // Remove common metadata patterns after tilde or whitespace-delimited hyphen/slash
    clean = clean.replace(/(?:\s+[-\/]\s*|\s*[〜~]\s*).*$/g, '');
    // Remove trailing remastered/version/live/edit/radio/mix/instrumental tags at word boundaries
    clean = clean.replace(/\s+\b(?:remaster(?:ed)?|version|live|edit|radio(?:\s+(?:edit|mix))?|mix|instrumental)\b.*$/i, '');

    const trimmed = clean.trim().toLowerCase();
    return trimmed || name.trim().toLowerCase();
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
 * Parses time string (e.g. "14:00", "9:30", "2:00 PM", "14:00:00") into minutes from midnight (0 - 1439).
 */
export function parseTimeToMinutes(timeStr: string): number {
    if (!timeStr) return 0;
    const isPM = /pm/i.test(timeStr);
    const isAM = /am/i.test(timeStr);
    const clean = timeStr.replace(/[^\d:]/g, '');
    const parts = clean.split(':').map(Number);
    let hours = parts[0] || 0;
    const minutes = parts[1] || 0;
    if (isPM && hours < 12) hours += 12;
    if (isAM && hours === 12) hours = 0;
    return (hours % 24) * 60 + (minutes % 60);
}

/**
 * Normalizes any time string into standard 24-hour "HH:mm" format.
 */
export function normalizeTimeString(timeStr: string): string {
    const mins = parseTimeToMinutes(timeStr);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Checks whether a given schedule item is currently active for the specified date.
 * Handles overnight slots (e.g. 23:00 - 01:00).
 */
export function isScheduleItemActive(item: ScheduleItem, date: Date = new Date()): boolean {
    const currentMins = date.getHours() * 60 + date.getMinutes();
    const startMins = parseTimeToMinutes(item.start);
    const endMins = parseTimeToMinutes(item.end);

    if (startMins <= endMins) {
        return startMins <= currentMins && currentMins < endMins;
    }
    // Overnight case (e.g., 23:00 - 01:00)
    return currentMins >= startMins || currentMins < endMins;
}

/**
 * Checks whether a schedule item has already passed.
 * Handles overnight slots appropriately.
 */
export function isScheduleItemPast(item: ScheduleItem, date: Date = new Date()): boolean {
    if (isScheduleItemActive(item, date)) return false;

    const currentMins = date.getHours() * 60 + date.getMinutes();
    const startMins = parseTimeToMinutes(item.start);
    const endMins = parseTimeToMinutes(item.end);

    if (startMins <= endMins) {
        return currentMins >= endMins;
    }
    // Overnight case: passed if current time is after end but before start
    return currentMins >= endMins && currentMins < startMins;
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

/**
 * Finds the schedule item strictly active at the given date, or falls back to the sole item if only one exists.
 */
export function findActiveScheduleItem(schedule: ScheduleItem[], date: Date = new Date()): ScheduleItem | null {
    if (!schedule || schedule.length === 0) return null;

    for (const item of schedule) {
        if (isScheduleItemActive(item, date)) {
            return item;
        }
    }

    if (schedule.length === 1) {
        return schedule[0];
    }

    return null;
}

/**
 * Resolves the effective schedule item to play right now, handling pre-schedule times,
 * inter-slot gaps, and overnight slots across midnight boundaries.
 */
export function resolveEffectiveScheduleItem(schedule: ScheduleItem[], date: Date = new Date()): ScheduleItem | null {
    if (!schedule || schedule.length === 0) return null;

    const activeItem = findActiveScheduleItem(schedule, date);
    if (activeItem) return activeItem;

    const currentMins = date.getHours() * 60 + date.getMinutes();

    // Find items that have already started or ended earlier today (including overnight slots that ended after midnight)
    let mostRecentPastItem: ScheduleItem | null = null;
    let smallestMinsSinceEnd = Infinity;

    for (const item of schedule) {
        const startMins = parseTimeToMinutes(item.start);
        const endMins = parseTimeToMinutes(item.end);
        const isOvernight = startMins > endMins;
        const occurredToday = isOvernight
            ? (currentMins >= startMins || endMins <= currentMins)
            : (startMins <= currentMins);

        if (occurredToday) {
            const minsSinceEnd = (currentMins - endMins + 1440) % 1440;
            if (minsSinceEnd < smallestMinsSinceEnd) {
                smallestMinsSinceEnd = minsSinceEnd;
                mostRecentPastItem = item;
            }
        }
    }

    return mostRecentPastItem ?? schedule[0];
}




