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
    // Remove common metadata patterns after tilde or whitespace-delimited hyphen/en-dash/em-dash/slash
    clean = clean.replace(/(?:\s+[-–—\/]\s*|\s*[〜~]\s*).*$/g, '');
    // Remove trailing remastered/version/live/edit/radio/mix/instrumental tags at word boundaries
    clean = clean.replace(
        /\s+\b(?:remaster(?:ed)?|version|(?:album|single|extended|acoustic|original|deluxe|japanese|english|instrumental|live|radio|mono|stereo)\s+(?:version|mix|edit)|(?<!\b(?:to|i|we|you|they)\s)live|edit|mix|instrumental)\b.*$/i,
        ''
    );

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
 * Parses time string (e.g. "14:00", "9:30", "2:00 PM", "14:00:00", "2300", "２３：３０") into minutes from midnight (0 - 1439).
 */
export function parseTimeToMinutes(timeStr: string): number {
    if (!timeStr) return 0;
    const ascii = timeStr.replace(/[０-９：]/g, (ch) =>
        ch === '：' ? ':' : String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
    );
    const isPM = /pm/i.test(ascii);
    const isAM = /am/i.test(ascii);
    const clean = ascii.replace(/[^\d:]/g, '');
    if (!clean) return 0;

    let hours = 0;
    let minutes = 0;
    if (!clean.includes(':') && clean.length >= 3) {
        const num = Number(clean.slice(0, 4));
        hours = Math.floor(num / 100);
        minutes = num % 100;
    } else {
        const parts = clean.split(':').map(Number);
        hours = parts[0] || 0;
        minutes = parts[1] || 0;
    }
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

    if (startMins === endMins) {
        return true;
    }
    if (startMins < endMins) {
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

interface TimelineEntry {
    item: ScheduleItem;
    index: number;
    relStart: number;
    relEnd: number;
}

function buildScheduleTimeline(schedule: ScheduleItem[], date: Date) {
    const currentMins = date.getHours() * 60 + date.getMinutes();
    const anchorMins = parseTimeToMinutes(schedule[0].start);
    const relNow = (currentMins - anchorMins + 1440) % 1440;

    let prevRelStart = 0;
    const entries: TimelineEntry[] = schedule.map((item, index) => {
        const startMins = parseTimeToMinutes(item.start);
        const endMins = parseTimeToMinutes(item.end);
        let relStart = (startMins - anchorMins + 1440) % 1440;
        if (index > 0 && relStart < prevRelStart) {
            relStart += 1440;
        }
        prevRelStart = relStart;
        const rawDuration = (endMins - startMins + 1440) % 1440;
        const duration = rawDuration === 0 ? 1440 : rawDuration;
        const relEnd = relStart + duration;
        return { item, index, relStart, relEnd };
    });

    const maxRelEnd = entries.reduce((max, e) => Math.max(max, e.relEnd), 0);
    const isBeforeScheduleStart =
        relNow >= maxRelEnd && (1440 - relNow) <= (relNow - maxRelEnd);

    return { entries, relNow, maxRelEnd, isBeforeScheduleStart };
}

/**
 * Checks whether a schedule item at a given index in an ordered schedule timeline has already passed.
 * Preserves chronological order across midnight boundaries so upcoming overnight slots are not marked past.
 */
export function isScheduleItemPastInTimeline(
    schedule: ScheduleItem[],
    index: number,
    date: Date = new Date()
): boolean {
    if (!schedule || index < 0 || index >= schedule.length) return false;
    const item = schedule[index];
    if (isScheduleItemActive(item, date)) return false;
    if (schedule.length === 1) return isScheduleItemPast(item, date);

    const { entries, relNow, isBeforeScheduleStart } = buildScheduleTimeline(schedule, date);
    if (isBeforeScheduleStart) return false;

    return entries[index].relEnd <= relNow;
}

/**
 * Resolves the effective schedule item to play right now, handling pre-schedule times,
 * inter-slot gaps, and overnight slots across midnight boundaries.
 */
export function resolveEffectiveScheduleItem(schedule: ScheduleItem[], date: Date = new Date()): ScheduleItem | null {
    if (!schedule || schedule.length === 0) return null;

    const activeItem = findActiveScheduleItem(schedule, date);
    if (activeItem) return activeItem;

    const { entries, relNow, isBeforeScheduleStart } = buildScheduleTimeline(schedule, date);
    if (isBeforeScheduleStart) {
        return schedule[0];
    }

    let mostRecentPastItem: ScheduleItem | null = null;
    let smallestGap = Infinity;

    for (const entry of entries) {
        if (entry.relEnd <= relNow) {
            const gap = relNow - entry.relEnd;
            if (gap <= smallestGap) {
                smallestGap = gap;
                mostRecentPastItem = entry.item;
            }
        }
    }

    return mostRecentPastItem ?? schedule[0];
}




