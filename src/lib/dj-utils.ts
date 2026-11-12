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

export const POST_OVERNIGHT_END_WINDOW_MINS = 180; // 3 hours after an overnight/late-night slot ends
const MAX_PRE_SCHEDULE_VALID_MS = 7 * 24 * 3600_000; // 7 days prior to scheduled start
const MAX_POST_SCHEDULE_VALID_MS = 12 * 3600_000; // 12 hours after schedule end before daily wraparound

function getMinuteFloorMs(date: Date): number {
    return new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        date.getHours(),
        date.getMinutes(),
        0,
        0
    ).getTime();
}

function getSlotDurationMinutes(startMins: number, endMins: number): number {
    const rawDuration = (endMins - startMins + 1440) % 1440;
    return rawDuration === 0 ? 1440 : rawDuration;
}

/**
 * Checks whether a given schedule item is currently active for the specified date.
 * Respects `scheduledStartAt` when anchored, and handles overnight slots (e.g. 23:00 - 01:00).
 */
export function isScheduleItemActive(item: ScheduleItem, date: Date = new Date()): boolean {
    const startMins = parseTimeToMinutes(item.start);
    const endMins = parseTimeToMinutes(item.end);

    if (typeof item.scheduledStartAt === 'number' && Number.isFinite(item.scheduledStartAt)) {
        const durationMins = getSlotDurationMinutes(startMins, endMins);
        const itemStartMs = item.scheduledStartAt;
        const itemEndMs = itemStartMs + durationMins * 60_000;
        const dateFloorMs = getMinuteFloorMs(date);
        if (
            dateFloorMs >= itemStartMs - MAX_PRE_SCHEDULE_VALID_MS &&
            dateFloorMs <= itemEndMs + MAX_POST_SCHEDULE_VALID_MS
        ) {
            return dateFloorMs >= itemStartMs && dateFloorMs < itemEndMs;
        }
    }

    const currentMins = date.getHours() * 60 + date.getMinutes();

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
 * Respects `scheduledStartAt` when anchored, and handles overnight slots appropriately.
 */
export function isScheduleItemPast(item: ScheduleItem, date: Date = new Date()): boolean {
    if (isScheduleItemActive(item, date)) return false;

    const startMins = parseTimeToMinutes(item.start);
    const endMins = parseTimeToMinutes(item.end);

    if (typeof item.scheduledStartAt === 'number' && Number.isFinite(item.scheduledStartAt)) {
        const durationMins = getSlotDurationMinutes(startMins, endMins);
        const itemStartMs = item.scheduledStartAt;
        const itemEndMs = itemStartMs + durationMins * 60_000;
        const dateFloorMs = getMinuteFloorMs(date);
        if (
            dateFloorMs >= itemStartMs - MAX_PRE_SCHEDULE_VALID_MS &&
            dateFloorMs <= itemEndMs + MAX_POST_SCHEDULE_VALID_MS
        ) {
            return dateFloorMs >= itemEndMs;
        }
    }

    const currentMins = date.getHours() * 60 + date.getMinutes();

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

interface TimelineEntry {
    item: ScheduleItem;
    index: number;
    relStart: number;
    relEnd: number;
}

function computeRelativeTimelineEntries(schedule: ScheduleItem[]) {
    const anchorMins = parseTimeToMinutes(schedule[0].start);
    let prevRelEnd = 0;
    const entries: TimelineEntry[] = schedule.map((item, index) => {
        const startMins = parseTimeToMinutes(item.start);
        const endMins = parseTimeToMinutes(item.end);
        let relStart = (startMins - anchorMins + 1440) % 1440;
        if (index > 0) {
            while (relStart < prevRelEnd) {
                relStart += 1440;
            }
        }
        const duration = getSlotDurationMinutes(startMins, endMins);
        const relEnd = relStart + duration;
        prevRelEnd = relEnd;
        return { item, index, relStart, relEnd };
    });

    const maxRelEnd = entries.reduce((max, e) => Math.max(max, e.relEnd), 0);
    return { anchorMins, entries, maxRelEnd };
}

function buildScheduleTimeline(schedule: ScheduleItem[], date: Date) {
    const { anchorMins, entries, maxRelEnd } = computeRelativeTimelineEntries(schedule);
    const anchorStartMs = schedule[0].scheduledStartAt;

    if (typeof anchorStartMs === 'number' && Number.isFinite(anchorStartMs)) {
        const dateFloorMs = getMinuteFloorMs(date);
        const minValidMs = anchorStartMs - MAX_PRE_SCHEDULE_VALID_MS;
        const maxValidMs = anchorStartMs + maxRelEnd * 60_000 + MAX_POST_SCHEDULE_VALID_MS;
        if (dateFloorMs >= minValidMs && dateFloorMs <= maxValidMs) {
            const exactRelNow = Math.round((dateFloorMs - anchorStartMs) / 60_000);
            return {
                entries,
                relNow: exactRelNow,
                maxRelEnd,
                isBeforeScheduleStart: exactRelNow < 0,
                isAnchored: true,
            };
        }
    }

    const currentMins = date.getHours() * 60 + date.getMinutes();
    const relNow = (currentMins - anchorMins + 1440) % 1440;
    let isBeforeScheduleStart = false;

    if (relNow >= maxRelEnd) {
        const waitUntilStartMins = 1440 - relNow;
        const elapsedSinceEndMins = relNow - maxRelEnd;
        const overnightEndMins = anchorMins + maxRelEnd;

        if (overnightEndMins < 1440) {
            // Same-day schedule (e.g. 14:00-16:00 or 22:00-23:59):
            // Any earlier time on the same calendar day is waiting for start unless a late-night slot (ending >= 23:00)
            // just ended within the last 3 hours; late night <= 3h before an after-midnight start is also waiting.
            isBeforeScheduleStart =
                (currentMins < anchorMins &&
                    (overnightEndMins < 1380 || elapsedSinceEndMins >= POST_OVERNIGHT_END_WINDOW_MINS)) ||
                (waitUntilStartMins <= POST_OVERNIGHT_END_WINDOW_MINS && waitUntilStartMins <= elapsedSinceEndMins);
        } else {
            // Midnight-reaching / overnight schedule (e.g. 23:00-01:00 or 21:00-04:00):
            // Within 3h right after the overnight end (e.g. 01:30 after 01:00) is post-schedule;
            // morning, afternoon, and evening hours leading up to tonight's start (e.g. 09:17 or 21:00 before 23:00) are waiting.
            isBeforeScheduleStart =
                elapsedSinceEndMins >= POST_OVERNIGHT_END_WINDOW_MINS ||
                waitUntilStartMins <= elapsedSinceEndMins;
        }
    }

    return { entries, relNow, maxRelEnd, isBeforeScheduleStart, isAnchored: false };
}

/**
 * Finds the schedule item strictly active at the given date without any single-item fallback.
 * Uses linear anchored timeline when `scheduledStartAt` is present so next-day blocks do not match prematurely.
 */
export function findStrictlyActiveScheduleItem(schedule: ScheduleItem[], date: Date = new Date()): ScheduleItem | null {
    if (!schedule || schedule.length === 0) return null;

    const timeline = buildScheduleTimeline(schedule, date);
    if (timeline.isAnchored) {
        if (timeline.isBeforeScheduleStart) return null;
        for (const entry of timeline.entries) {
            if (entry.relStart <= timeline.relNow && timeline.relNow < entry.relEnd) {
                return entry.item;
            }
        }
        return null;
    }

    for (const item of schedule) {
        if (isScheduleItemActive(item, date)) {
            return item;
        }
    }

    return null;
}

/**
 * Finds the schedule item strictly active at the given date, or falls back to the sole item if only one exists.
 */
export function findActiveScheduleItem(schedule: ScheduleItem[], date: Date = new Date()): ScheduleItem | null {
    const strict = findStrictlyActiveScheduleItem(schedule, date);
    if (strict) return strict;

    if (schedule && schedule.length === 1) {
        return schedule[0];
    }

    return null;
}

/**
 * Anchors each schedule item to an absolute `scheduledStartAt` epoch timestamp (minute precision)
 * relative to `now`, eliminating 24-hour modulo ambiguity for future reservations > 12h ahead
 * and multi-block schedules spanning into the next morning.
 */
export function attachScheduleTimestamps(
    schedule: ScheduleItem[],
    now: Date = new Date(),
    previousSchedule: ScheduleItem[] = [],
    options?: { forceFutureDay?: boolean; forceFutureStart?: boolean; hasImmediateCue?: boolean }
): ScheduleItem[] {
    if (!schedule || schedule.length === 0) return [];

    const { anchorMins, entries, maxRelEnd } = computeRelativeTimelineEntries(schedule);
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const nowFloorMs = getMinuteFloorMs(now);
    const relNow = (nowMins - anchorMins + 1440) % 1440;

    const prevFirst = previousSchedule[0];
    let prevScheduleUnexpired = false;
    let prevScheduleStillRunning = false;
    if (
        prevFirst &&
        typeof prevFirst.scheduledStartAt === 'number' &&
        Number.isFinite(prevFirst.scheduledStartAt)
    ) {
        const { maxRelEnd: prevMaxRelEnd } = computeRelativeTimelineEntries(previousSchedule);
        const prevEndMs = prevFirst.scheduledStartAt + prevMaxRelEnd * 60_000;
        prevScheduleUnexpired =
            nowFloorMs >= prevFirst.scheduledStartAt - MAX_PRE_SCHEDULE_VALID_MS &&
            nowFloorMs < prevEndMs;
        prevScheduleStillRunning = prevFirst.scheduledStartAt <= nowFloorMs && nowFloorMs < prevEndMs;
    }

    const prevSameStart = Boolean(
        prevFirst &&
        normalizeTimeString(prevFirst.start) === normalizeTimeString(schedule[0].start)
    );
    const prevFirstAlreadyStarted = Boolean(prevScheduleStillRunning && prevSameStart);
    const prevUpcomingAnchorPreserved = Boolean(
        prevScheduleUnexpired &&
        !prevScheduleStillRunning &&
        prevSameStart &&
        prevFirst &&
        getScheduleItemSignature(prevFirst) === getScheduleItemSignature(schedule[0]) &&
        !options?.forceFutureDay &&
        !options?.hasImmediateCue
    );

    if (prevUpcomingAnchorPreserved && typeof prevFirst?.scheduledStartAt === 'number') {
        const preservedAnchorMs = prevFirst.scheduledStartAt;
        return schedule.map((item, idx) => ({
            ...item,
            scheduledStartAt: preservedAnchorMs + entries[idx].relStart * 60_000,
        }));
    }

    if (options?.forceFutureDay && !prevFirstAlreadyStarted) {
        const anchorHours = Math.floor(anchorMins / 60);
        const anchorRemMins = anchorMins % 60;
        const tomorrowAnchorMs = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate() + 1,
            anchorHours,
            anchorRemMins,
            0,
            0
        ).getTime();
        return schedule.map((item, idx) => ({
            ...item,
            scheduledStartAt: tomorrowAnchorMs + entries[idx].relStart * 60_000,
        }));
    }

    const hasAlreadyStarted =
        !options?.forceFutureDay &&
        (!options?.forceFutureStart || prevFirstAlreadyStarted) &&
        (relNow < entries[0].relEnd ||
            prevFirstAlreadyStarted ||
            (relNow < maxRelEnd &&
                (anchorMins <= nowMins ||
                    (nowMins < POST_OVERNIGHT_END_WINDOW_MINS &&
                        relNow - entries[0].relEnd < POST_OVERNIGHT_END_WINDOW_MINS))));

    let anchorStartMs: number;
    if (hasAlreadyStarted) {
        if (
            prevFirstAlreadyStarted &&
            typeof prevFirst?.scheduledStartAt === 'number' &&
            nowFloorMs - prevFirst.scheduledStartAt < 24 * 3600_000
        ) {
            anchorStartMs = prevFirst.scheduledStartAt;
        } else {
            anchorStartMs = nowFloorMs - relNow * 60_000;
        }
    } else {
        const forwardMins = (anchorMins - nowMins + 1440) % 1440 || 1440;
        anchorStartMs = nowFloorMs + forwardMins * 60_000;
    }

    return schedule.map((item, idx) => ({
        ...item,
        scheduledStartAt: anchorStartMs + entries[idx].relStart * 60_000,
    }));
}

const IMMEDIATE_PROMPT_CUE_REGEX =
    /(?:今から|いまから|今は|いまは|すぐ|まずは)|\b(?:right now|for now|start now|starting now)\b/i;

export function hasImmediateCueInPrompt(instruction: string, totalBlocks: number = 1): boolean {
    if (!instruction) return false;
    if (totalBlocks <= 1) {
        return IMMEDIATE_PROMPT_CUE_REGEX.test(instruction);
    }
    const sepMatch = /[。.、,\n]|\b(?:and|then)\b/i.exec(instruction);
    const firstClause = sepMatch ? instruction.slice(0, sepMatch.index) : instruction;
    return IMMEDIATE_PROMPT_CUE_REGEX.test(firstClause);
}

function isEndBoundContext(before: string, after: string): boolean {
    if (/^\s*(?:まで|迄)/.test(after)) {
        return true;
    }
    if (/(?:\bfrom\s+\S+(?:\s*(?:a\.?m\.?|p\.?m\.?))?\s+to|\bup\s+to|\b(?:until|till)|[-〜~–—])\s*$/.test(before)) {
        return true;
    }
    if (/(?:正午|真夜中|\d\s*(?:時(?:\d+分|半)?|分|a\.?m\.?|p\.?m\.?)?)\s*から\s*$/.test(before)) {
        return true;
    }
    return false;
}

function hasConflictingMeridiem(before: string, after: string, isPM: boolean, h24: number, matchedHour12: boolean): boolean {
    if (isPM) {
        if (/(?:午前|\ba\.?m\.?)\s*$/.test(before) || /^\s*a\.?m\.?(?![a-z])/.test(after)) {
            return true;
        }
        if (/(?:早?朝)の?\s*$/.test(before)) {
            return true;
        }
        if (h24 >= 12 && h24 <= 16 && /(?:今夜|今晩|夜)の?\s*$/.test(before)) {
            return true;
        }
        if (h24 >= 12 && h24 <= 21 && /(?:深夜|真夜中|夜中)の?\s*$/.test(before)) {
            return true;
        }
        if (h24 === 12 && matchedHour12 && /(?:夜|深夜|真夜中|夜中)の?\s*$/.test(before)) {
            return true;
        }
    } else {
        if (/(?:午後|\bp\.?m\.?)\s*$/.test(before) || /^\s*p\.?m\.?(?![a-z])/.test(after)) {
            return true;
        }
        if (/(?:夕方)の?\s*$/.test(before)) {
            return true;
        }
        if (h24 <= 10 && /(?:お?昼)の?\s*$/.test(before)) {
            return true;
        }
        if (h24 >= 5 && h24 <= 11 && /(?:今夜|今晩|夜)の?\s*$/.test(before)) {
            return true;
        }
    }
    return false;
}

interface StartTimeMatchContext {
    checkMeridiem: boolean;
    isPM: boolean;
    h24: number;
    matchedHour12?: boolean;
    totalBlocks: number;
    firstClauseEnd: number;
    firstClauseHasImmediateCue: boolean;
    firstClauseHasTomorrow: boolean;
}

function hasStartTimeTokenMatch(
    normalizedInput: string,
    pattern: RegExp,
    options: StartTimeMatchContext
): boolean {
    const globalPattern = new RegExp(pattern.source, 'g');
    for (const match of normalizedInput.matchAll(globalPattern)) {
        const idx = match.index ?? 0;
        const before = normalizedInput.slice(Math.max(0, idx - 20), idx);
        const after = normalizedInput.slice(idx + match[0].length, idx + match[0].length + 20);
        if (options.totalBlocks > 1 && idx >= options.firstClauseEnd) {
            if (options.firstClauseHasImmediateCue) {
                continue;
            }
            if (
                !options.firstClauseHasTomorrow &&
                /(?:明日|あした|\btomorrow\b)(?:の|\s)*(?:早?朝|午前|午後|お?昼|夕方|夜|深夜)?(?:の|\s)*$/.test(before)
            ) {
                continue;
            }
        }
        if (isEndBoundContext(before, after)) {
            continue;
        }
        if (
            options.checkMeridiem &&
            hasConflictingMeridiem(before, after, options.isPM, options.h24, Boolean(options.matchedHour12))
        ) {
            continue;
        }
        return true;
    }
    return false;
}

/**
 * Determines whether a user's prompt explicitly requested a deferred/future start time for the first block,
 * preventing LLM clock-rounding snap (<= 60m) from overriding intentional future reservations while avoiding
 * partial-digit false positives (e.g. "23時" vs "3時", "21:00" vs "1:00"), duration false positives ("3時間"),
 * end-bound false positives ("23時まで"), natural meridiem conflicts ("夜9時" vs "09:00", "朝9時" vs "21:00"),
 * and multi-block "今夜" / "明日" false positives.
 */
export function isExplicitFutureScheduleRequest(
    instruction: string,
    normalizedStart: string,
    forwardDiff: number,
    totalBlocks: number = 1
): boolean {
    if (!instruction) return false;

    const mins = parseTimeToMinutes(normalizedStart);
    const h24 = Math.floor(mins / 60);
    const m = mins % 60;
    const h12 = h24 % 12 || 12;
    const isPM = h24 >= 12;
    const mm = String(m).padStart(2, '0');
    const hh24 = String(h24).padStart(2, '0');

    const normalizedInput = instruction
        .replace(/[０-９Ａ-Ｚａ-ｚ：　]/g, (ch) => {
            if (ch === '：') return ':';
            if (ch === '　') return ' ';
            return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
        })
        .toLowerCase();

    const sepMatch = /[。.、,\n]|\b(?:and|then)\b/i.exec(normalizedInput);
    const firstClauseEnd = sepMatch ? sepMatch.index : normalizedInput.length;
    const firstClause = normalizedInput.slice(0, firstClauseEnd);
    const firstClauseHasImmediateCue =
        /(?:今から|いまから|今は|いまは|すぐ|まずは)/.test(firstClause) ||
        /\b(?:right now|for now|start now|starting now)\b/.test(firstClause);
    const firstClauseHasTomorrow = /(?:明日|あした)|\btomorrow\b/.test(firstClause);

    const baseCtx = {
        isPM,
        h24,
        totalBlocks,
        firstClauseEnd,
        firstClauseHasImmediateCue,
        firstClauseHasTomorrow,
    };

    // 1. Exact 24-hour colon notation (e.g. "23:00", "9:05", "09:05", plus "24:00" for 00:00)
    const hour24ColonGroup = h24 === 0 ? `(?:00|0|24)` : `(?:${hh24}|${h24})`;
    const colon24Regex = new RegExp(`(?<!\\d)${hour24ColonGroup}:${mm}(?!\\d)`);
    if (
        hasStartTimeTokenMatch(normalizedInput, colon24Regex, {
            ...baseCtx,
            checkMeridiem: true,
            matchedHour12: h24 === 12,
        })
    ) {
        return true;
    }

    // 2. 12-hour colon notation (e.g. "3:00", "3:00pm", "午後3:00" for 15:00; "午後0:00" for 12:00)
    if (h12 !== h24) {
        const colon12Regex = new RegExp(`(?<!\\d)0?${h12}:${mm}(?!\\d)`);
        if (
            hasStartTimeTokenMatch(normalizedInput, colon12Regex, {
                ...baseCtx,
                checkMeridiem: true,
                matchedHour12: h12 === 12,
            })
        ) {
            return true;
        }
    }
    if (
        h24 === 12 &&
        hasStartTimeTokenMatch(normalizedInput, new RegExp(`午後\\s*0?0:${mm}(?!\\d)`), {
            ...baseCtx,
            checkMeridiem: false,
        })
    ) {
        return true;
    }

    // 3. Japanese hour/minute notation ("23時", "24時", "15時30分", "3時半", "午後3時", "午後0時"; excludes durations like "3時間")
    const minuteSuffixPattern =
        m === 0
            ? '(?:0?0分)?(?!\\d|半|間)'
            : m === 30
                ? `(?:0?30分|半)(?!\\d)`
                : `0?${m}分(?!\\d)`;

    const hour24JpGroup = h24 === 0 ? `(?:00|0|24)` : `(?:${hh24}|${h24})`;
    const jp24Regex = new RegExp(`(?<!\\d)${hour24JpGroup}時${minuteSuffixPattern}`);
    if (
        hasStartTimeTokenMatch(normalizedInput, jp24Regex, {
            ...baseCtx,
            checkMeridiem: true,
            matchedHour12: h24 === 12,
        })
    ) {
        return true;
    }

    if (h12 !== h24) {
        const jp12Regex = new RegExp(`(?<!\\d)${h12}時${minuteSuffixPattern}`);
        if (
            hasStartTimeTokenMatch(normalizedInput, jp12Regex, {
                ...baseCtx,
                checkMeridiem: true,
                matchedHour12: h12 === 12,
            })
        ) {
            return true;
        }
    }
    if (
        h24 === 12 &&
        hasStartTimeTokenMatch(normalizedInput, new RegExp(`午後\\s*0?0時${minuteSuffixPattern}`), {
            ...baseCtx,
            checkMeridiem: false,
        })
    ) {
        return true;
    }

    // 4. English AM/PM notation without colon & exact noon/midnight words when m === 0
    if (m === 0) {
        const meridiemPattern = isPM ? 'p\\.?m\\.?' : 'a\\.?m\\.?';
        const amPmHourRegex = new RegExp(`(?<!\\d)0?${h12}\\s*${meridiemPattern}(?![a-z\\d])`);
        if (hasStartTimeTokenMatch(normalizedInput, amPmHourRegex, { ...baseCtx, checkMeridiem: false })) {
            return true;
        }
        if (h24 === 0 && hasStartTimeTokenMatch(normalizedInput, /(?:真夜中|\bmidnight\b)/, { ...baseCtx, checkMeridiem: false })) {
            return true;
        }
        if (h24 === 12 && hasStartTimeTokenMatch(normalizedInput, /(?:正午|\bnoon\b)/, { ...baseCtx, checkMeridiem: false })) {
            return true;
        }
    }

    const hasExplicitImmediateCue =
        totalBlocks === 1
            ? /(?:今から|いまから|今は|いまは|すぐ|まずは)/.test(normalizedInput) ||
              /\b(?:right now|for now|start now|starting now)\b/.test(normalizedInput)
            : firstClauseHasImmediateCue;

    if (hasExplicitImmediateCue) {
        return false;
    }

    // 5. Relative future offset expressions (e.g. "30分後に", "1時間後から", "in 30 minutes")
    const relativeTargetScope = totalBlocks === 1 ? normalizedInput : firstClause;
    if (/(?<!\d)\d+\s*(?:分後|時間後)/.test(relativeTargetScope) || /半時間後/.test(relativeTargetScope)) {
        return true;
    }
    if (/\bin\s+(?:\d+|an?|half\s+an)\s*(?:minutes?|mins?|hours?|hrs?)\b/.test(relativeTargetScope)) {
        return true;
    }

    // 6. Vague deferred time-of-day keywords apply ONLY when the schedule is a single block AND
    //    the prompt did not already specify a different concrete start clock hour (e.g. "深夜2時" vs "14:00").
    if (totalBlocks === 1 && forwardDiff > 15) {
        const anyClockPattern = /(?<!\d)\d{1,2}(?::\d{2}|時(?:\d{1,2}分|半)?(?!\d|間)|\s*(?:a\.?m\.?|p\.?m\.?)(?![a-z\d]))/g;
        let hasDifferentExplicitStartClock = false;
        for (const clockMatch of normalizedInput.matchAll(anyClockPattern)) {
            const cIdx = clockMatch.index ?? 0;
            const cBefore = normalizedInput.slice(Math.max(0, cIdx - 20), cIdx);
            const cAfter = normalizedInput.slice(cIdx + clockMatch[0].length, cIdx + clockMatch[0].length + 20);
            if (!isEndBoundContext(cBefore, cAfter)) {
                hasDifferentExplicitStartClock = true;
                break;
            }
        }
        if (!hasDifferentExplicitStartClock) {
            if (/(?:今夜|今晩|深夜|夜遅く|明日|あした|あとで|後で)/.test(normalizedInput)) {
                return true;
            }
            if (/\b(?:tonight|this evening|late night|tomorrow|later)\b/.test(normalizedInput)) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Determines whether the first block in a newly generated schedule explicitly targets tomorrow
 * (e.g. "明日の10時からジャズ" or "明日の朝9時からはクラシック、12時からはボサノバ").
 */
export function isTomorrowFirstBlockRequest(
    instruction: string,
    firstBlockStart: string,
    totalBlocks: number = 1
): boolean {
    if (!instruction) return false;

    const todayOrNowRegex =
        /(?:今日|今夜|今晩|今から|いまから|今は|いまは|すぐ|まずは)|\b(?:today|tonight|this evening|right now|for now|start now|starting now)\b/i;

    if (totalBlocks <= 1) {
        if (todayOrNowRegex.test(instruction)) return false;
        return /(?:明日|あした)|\btomorrow\b/i.test(instruction);
    }

    const sepMatch = /[。.、,\n]|\b(?:and|then)\b/i.exec(instruction);
    const firstClause = sepMatch ? instruction.slice(0, sepMatch.index) : instruction;
    if (todayOrNowRegex.test(firstClause)) {
        return false;
    }

    const tomorrowMatch = /(?:明日|あした)|\btomorrow\b/i.exec(firstClause);
    if (!tomorrowMatch) {
        return false;
    }

    const prefixBeforeTomorrow = firstClause.slice(0, tomorrowMatch.index);
    const hasEarlierClockToken =
        /(?:\d{1,2}|[０-９]{1,2})\s*(?:[:：]\s*(?:\d{2}|[０-９]{2})|時(?!間)|a\.?m\.?|p\.?m\.?)|正午|真夜中|\b(?:noon|midnight)\b/i.test(
            prefixBeforeTomorrow
        );
    if (hasEarlierClockToken) {
        return false;
    }

    return isExplicitFutureScheduleRequest(instruction, firstBlockStart, 60, totalBlocks);
}

/**
 * Filters out past/expired blocks from a schedule timeline so stale completed slots
 * are not carried forward as active existing context on a new day.
 */
export function filterActiveOrUpcomingSchedule(
    schedule: ScheduleItem[],
    date: Date = new Date()
): ScheduleItem[] {
    if (!schedule || schedule.length === 0) return [];
    return schedule.filter((_, idx) => !isScheduleItemPastInTimeline(schedule, idx, date));
}

/**
 * Returns true when no schedule slot is currently active and the current time is prior to
 * the first slot's scheduled start time on the timeline (e.g. 09:17 or 21:00 waiting for a 23:00 show).
 */
export function isWaitingForScheduleStart(schedule: ScheduleItem[], date: Date = new Date()): boolean {
    if (!schedule || schedule.length === 0) return false;
    if (findStrictlyActiveScheduleItem(schedule, date)) return false;
    return buildScheduleTimeline(schedule, date).isBeforeScheduleStart;
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

    const timeline = buildScheduleTimeline(schedule, date);
    if (timeline.isBeforeScheduleStart) return false;
    if (timeline.isAnchored) {
        const entry = timeline.entries[index];
        return entry.relEnd <= timeline.relNow;
    }

    if (isScheduleItemActive(schedule[index], date)) return false;
    return timeline.entries[index].relEnd <= timeline.relNow;
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

/**
 * Resolves the DJ curation thought appropriate for the current UI state without
 * mislabeling an active prior playback session with a future standby block's thought.
 */
export function resolveScheduleThought(
    schedule: ScheduleItem[],
    currentQuery: string | null = null,
    date: Date = new Date()
): string | null {
    if (!schedule || schedule.length === 0) return null;

    if (isWaitingForScheduleStart(schedule, date)) {
        if (currentQuery) {
            return null;
        }
        return schedule[0]?.thought ?? null;
    }

    if (currentQuery) {
        const matched = schedule.find((s) => getScheduleItemSignature(s) === currentQuery);
        if (matched) {
            return matched.thought ?? null;
        }
    }

    const currentItem = findActiveScheduleItem(schedule, date) ?? resolveEffectiveScheduleItem(schedule, date);
    return currentItem?.thought ?? null;
}

/**
 * Determines whether an already-playing DJ session should continue uninterrupted when a schedule update
 * only appends, edits, or removes future/non-active blocks while keeping the currently playing block intact.
 */
export function shouldPreserveActivePlaybackOnScheduleUpdate(params: {
    prevSchedule: ScheduleItem[];
    nextSchedule: ScheduleItem[];
    prevCurrentQuery: string | null;
    isSessionActive: boolean;
    date?: Date;
}): boolean {
    const { prevSchedule, nextSchedule, prevCurrentQuery, isSessionActive, date = new Date() } = params;
    if (!isSessionActive || !prevCurrentQuery || prevSchedule.length === 0 || nextSchedule.length <= 1) {
        return false;
    }
    if (isWaitingForScheduleStart(nextSchedule, date)) {
        return false;
    }
    const nextEffective = resolveEffectiveScheduleItem(nextSchedule, date);
    if (!nextEffective || getScheduleItemSignature(nextEffective) !== prevCurrentQuery) {
        return false;
    }
    const prevActive =
        prevSchedule.find((s) => getScheduleItemSignature(s) === prevCurrentQuery) ??
        resolveEffectiveScheduleItem(prevSchedule, date);
    const prevOtherSigs = prevSchedule
        .filter((s) => s !== prevActive)
        .map((s) => `${normalizeTimeString(s.start)}-${normalizeTimeString(s.end)}:${getScheduleItemSignature(s)}`)
        .join('||');
    const nextOtherSigs = nextSchedule
        .filter((s) => s !== nextEffective)
        .map((s) => `${normalizeTimeString(s.start)}-${normalizeTimeString(s.end)}:${getScheduleItemSignature(s)}`)
        .join('||');
    return prevOtherSigs !== nextOtherSigs;
}

export type ScheduleItemDisplayStatus = 'active' | 'standby' | 'upcoming' | 'past';

/**
 * Computes the visual & logical display status for a schedule item in the timeline:
 * - 'standby'  : First block of a future-reserved schedule waiting for its start time
 * - 'active'   : Currently playing / effective schedule block
 * - 'past'     : Completed schedule block earlier in the timeline
 * - 'upcoming' : Future block scheduled after the active or standby block
 */
export function getScheduleItemDisplayStatus(
    schedule: ScheduleItem[],
    index: number,
    currentQuery: string | null = null,
    date: Date = new Date()
): ScheduleItemDisplayStatus {
    if (!schedule || index < 0 || index >= schedule.length) {
        return 'upcoming';
    }

    if (isWaitingForScheduleStart(schedule, date)) {
        return index === 0 ? 'standby' : 'upcoming';
    }

    const item = schedule[index];
    const strictActive = findStrictlyActiveScheduleItem(schedule, date);
    const effectiveItem = resolveEffectiveScheduleItem(schedule, date);
    const pastInTimeline = isScheduleItemPastInTimeline(schedule, index, date);
    const hasMatchingCurrentQuery = Boolean(
        currentQuery && schedule.some(s => getScheduleItemSignature(s) === currentQuery)
    );
    const signature = getScheduleItemSignature(item);

    let isActive: boolean;
    if (strictActive) {
        isActive = hasMatchingCurrentQuery
            ? currentQuery === signature && (item === strictActive || item === effectiveItem)
            : item === strictActive;
    } else {
        isActive = hasMatchingCurrentQuery
            ? currentQuery === signature && item === effectiveItem
            : !pastInTimeline && item === effectiveItem;
    }

    if (isActive) {
        return 'active';
    }
    if (pastInTimeline) {
        return 'past';
    }
    return 'upcoming';
}

