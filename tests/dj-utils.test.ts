import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeTrackName,
    generateTrackKey,
    isScheduleItemActive,
    isScheduleItemPast,
    isScheduleItemPastInTimeline,
    getScheduleItemSignature,
    getScheduleItemQueries,
    parseTimeToMinutes,
    normalizeTimeString,
    findActiveScheduleItem,
    findStrictlyActiveScheduleItem,
    isWaitingForScheduleStart,
    resolveEffectiveScheduleItem,
    attachScheduleTimestamps,
    filterActiveOrUpcomingSchedule,
    isExplicitFutureScheduleRequest,
    isTomorrowFirstBlockRequest,
    getScheduleItemDisplayStatus,
    resolveScheduleThought,
    shouldPreserveActivePlaybackOnScheduleUpdate,
} from '../src/lib/dj-utils';
import { ScheduleItem, Track } from '../src/lib/types';

describe('dj-utils', () => {
    describe('parseTimeToMinutes & normalizeTimeString', () => {
        it('parses standard 24h times', () => {
            assert.strictEqual(parseTimeToMinutes('00:00'), 0);
            assert.strictEqual(parseTimeToMinutes('14:30'), 14 * 60 + 30);
            assert.strictEqual(parseTimeToMinutes('23:59'), 23 * 60 + 59);
        });

        it('parses unpadded 1-digit hours and 12h AM/PM strings', () => {
            assert.strictEqual(parseTimeToMinutes('9:00'), 9 * 60);
            assert.strictEqual(parseTimeToMinutes('2:15 PM'), 14 * 60 + 15);
            assert.strictEqual(parseTimeToMinutes('12:00 AM'), 0);
            assert.strictEqual(parseTimeToMinutes('12:00 PM'), 12 * 60);
        });

        it('normalizes various time formats to standard HH:mm', () => {
            assert.strictEqual(normalizeTimeString('9:05'), '09:05');
            assert.strictEqual(normalizeTimeString('14:30:00'), '14:30');
            assert.strictEqual(normalizeTimeString('2:15 PM'), '14:15');
            assert.strictEqual(normalizeTimeString(''), '00:00');
        });

        it('parses full-width digits/colons and colon-less 3/4-digit times', () => {
            assert.strictEqual(parseTimeToMinutes('２３：３０'), 23 * 60 + 30);
            assert.strictEqual(normalizeTimeString('２３：３０'), '23:30');
            assert.strictEqual(normalizeTimeString('0930'), '09:30');
            assert.strictEqual(normalizeTimeString('930'), '09:30');
            assert.strictEqual(normalizeTimeString('2300'), '23:00');
        });
    });
    describe('normalizeTrackName', () => {
        it('should remove parentheses content (half-width and full-width)', () => {
            assert.strictEqual(normalizeTrackName('Song Title (Remastered 2020)'), 'song title');
            assert.strictEqual(normalizeTrackName('Song Title [Live at Tokyo]'), 'song title');
            assert.strictEqual(normalizeTrackName('Song Title（Bonus Track）'), 'song title');
            assert.strictEqual(normalizeTrackName('Song Title［2024 Remaster］'), 'song title');
        });

        it('should remove hyphen and tilde metadata', () => {
            assert.strictEqual(normalizeTrackName('Song Title - Radio Edit'), 'song title');
            assert.strictEqual(normalizeTrackName('Song Title / Extended Version'), 'song title');
            assert.strictEqual(normalizeTrackName('Song Title 〜Instrumental〜'), 'song title');
        });

        it('should remove version tags', () => {
            assert.strictEqual(normalizeTrackName('Song Title Remastered'), 'song title');
            assert.strictEqual(normalizeTrackName('Song Title Live'), 'song title');
            assert.strictEqual(normalizeTrackName('Song Title Radio Mix'), 'song title');
        });

        it('should preserve hyphenated titles and words containing live/edit/radio substrings', () => {
            assert.strictEqual(normalizeTrackName('Anti-Hero'), 'anti-hero');
            assert.strictEqual(normalizeTrackName('Lo-Fi Groove'), 'lo-fi groove');
            assert.strictEqual(normalizeTrackName('24/7'), '24/7');
            assert.strictEqual(normalizeTrackName('Meditation'), 'meditation');
            assert.strictEqual(normalizeTrackName('Alive'), 'alive');
            assert.strictEqual(normalizeTrackName('Live Forever'), 'live forever');
            assert.strictEqual(normalizeTrackName('I Want to Live'), 'i want to live');
            assert.strictEqual(normalizeTrackName('Radioactive'), 'radioactive');
            assert.strictEqual(normalizeTrackName('Video Killed the Radio Star'), 'video killed the radio star');
            assert.strictEqual(normalizeTrackName('On the Radio'), 'on the radio');
            assert.strictEqual(normalizeTrackName('Plastic Love – 2021 Remaster'), 'plastic love');
        });
    });

    describe('generateTrackKey', () => {
        it('should generate consistent deduplication key', () => {
            const track1: Partial<Track> = {
                name: 'Plastic Love (Remastered)',
                artists: [{ name: 'Mariya Takeuchi' } as SpotifyApi.ArtistObjectSimplified],
            };
            const track2: Partial<Track> = {
                name: 'Plastic Love - 2021 Version',
                artists: [{ name: '  mariya takeuchi  ' } as SpotifyApi.ArtistObjectSimplified],
            };

            assert.strictEqual(
                generateTrackKey(track1 as Track),
                generateTrackKey(track2 as Track)
            );
            assert.strictEqual(
                generateTrackKey(track1 as Track),
                'plastic love|mariya takeuchi'
            );
        });

        it('should handle missing artists gracefully', () => {
            const track: Partial<Track> = {
                name: 'Unknown Song',
                artists: [],
            };
            assert.strictEqual(generateTrackKey(track as Track), 'unknown song|');
        });
    });

    describe('isScheduleItemActive & isScheduleItemPast', () => {
        const normalItem: ScheduleItem = {
            start: '14:00',
            end: '16:00',
            query: 'chill beats',
        };

        const overnightItem: ScheduleItem = {
            start: '23:00',
            end: '01:00',
            query: 'midnight jazz',
        };

        const createDate = (hours: number, minutes: number): Date => {
            const d = new Date(2026, 8, 24, hours, minutes, 0, 0);
            return d;
        };

        it('handles regular time slots (14:00 - 16:00)', () => {
            // Before
            assert.strictEqual(isScheduleItemActive(normalItem, createDate(13, 59)), false);
            assert.strictEqual(isScheduleItemPast(normalItem, createDate(13, 59)), false);

            // Active (start inclusive)
            assert.strictEqual(isScheduleItemActive(normalItem, createDate(14, 0)), true);
            assert.strictEqual(isScheduleItemPast(normalItem, createDate(14, 0)), false);

            // Active (in-between)
            assert.strictEqual(isScheduleItemActive(normalItem, createDate(15, 30)), true);
            assert.strictEqual(isScheduleItemPast(normalItem, createDate(15, 30)), false);

            // Past (end exclusive)
            assert.strictEqual(isScheduleItemActive(normalItem, createDate(16, 0)), false);
            assert.strictEqual(isScheduleItemPast(normalItem, createDate(16, 0)), true);

            // Long past
            assert.strictEqual(isScheduleItemActive(normalItem, createDate(18, 0)), false);
            assert.strictEqual(isScheduleItemPast(normalItem, createDate(18, 0)), true);
        });

        it('handles overnight slots (23:00 - 01:00)', () => {
            // Before start (e.g. afternoon or late evening before 23:00)
            assert.strictEqual(isScheduleItemActive(overnightItem, createDate(22, 59)), false);
            // 22:59 is past yesterday's slot, but hasn't reached today's 23:00 yet
            assert.strictEqual(isScheduleItemPast(overnightItem, createDate(22, 59)), true);

            // Active (start inclusive at 23:00)
            assert.strictEqual(isScheduleItemActive(overnightItem, createDate(23, 0)), true);
            assert.strictEqual(isScheduleItemPast(overnightItem, createDate(23, 0)), false);

            // Active (late night at 23:45)
            assert.strictEqual(isScheduleItemActive(overnightItem, createDate(23, 45)), true);
            assert.strictEqual(isScheduleItemPast(overnightItem, createDate(23, 45)), false);

            // Active (midnight cross at 00:30)
            assert.strictEqual(isScheduleItemActive(overnightItem, createDate(0, 30)), true);
            assert.strictEqual(isScheduleItemPast(overnightItem, createDate(0, 30)), false);

            // Past (end exclusive at 01:00)
            assert.strictEqual(isScheduleItemActive(overnightItem, createDate(1, 0)), false);
            assert.strictEqual(isScheduleItemPast(overnightItem, createDate(1, 0)), true);

            // Past (middle of the next day at 12:00)
            assert.strictEqual(isScheduleItemActive(overnightItem, createDate(12, 0)), false);
            assert.strictEqual(isScheduleItemPast(overnightItem, createDate(12, 0)), true);
        });
    });

    describe('getScheduleItemSignature', () => {
        it('joins multiple queries with pipes', () => {
            const item: ScheduleItem = {
                start: '10:00',
                end: '12:00',
                query: 'fallback',
                queries: ['jazz', 'piano', 'chill'],
            };
            assert.strictEqual(getScheduleItemSignature(item), 'jazz|piano|chill');
        });

        it('includes priorityTrack if present', () => {
            const item: ScheduleItem = {
                start: '10:00',
                end: '12:00',
                query: 'morning',
                priorityTrack: 'track:"Plastic Love"',
            };
            assert.strictEqual(getScheduleItemSignature(item), 'morning|track:"Plastic Love"');
        });

        it('falls back to single query if queries array is missing', () => {
            const item: ScheduleItem = {
                start: '10:00',
                end: '12:00',
                query: 'ambient rain',
            };
            assert.strictEqual(getScheduleItemSignature(item), 'ambient rain');
        });
    });

    describe('getScheduleItemQueries', () => {
        it('returns queries array if present and non-empty', () => {
            const item: ScheduleItem = {
                start: '10:00',
                end: '12:00',
                query: 'single',
                queries: ['q1', 'q2'],
            };
            assert.deepStrictEqual(getScheduleItemQueries(item), ['q1', 'q2']);
        });

        it('falls back to [query] if queries is missing or empty', () => {
            const item: ScheduleItem = {
                start: '10:00',
                end: '12:00',
                query: 'single',
            };
            assert.deepStrictEqual(getScheduleItemQueries(item), ['single']);
        });

        it('returns empty array if neither queries nor query is defined', () => {
            const item: ScheduleItem = {
                start: '10:00',
                end: '12:00',
                query: '',
            };
            assert.deepStrictEqual(getScheduleItemQueries(item), []);
        });
    });

    describe('findActiveScheduleItem, resolveEffectiveScheduleItem & isScheduleItemPastInTimeline', () => {
        it('correctly resolves active and effective items across overnight gaps after midnight and before schedule start', () => {
            const schedule: ScheduleItem[] = [
                { start: '21:00', end: '23:00', query: 'evening chill' },
                { start: '23:00', end: '01:00', query: 'midnight jazz' },
                { start: '02:00', end: '04:00', query: 'late night ambient' },
            ];

            // At 20:30 (30m before schedule starts at 21:00):
            // Effective item must be 'evening chill' (schedule[0]), NOT 'midnight jazz' or 'late night ambient'
            const beforeStart = new Date(2026, 8, 24, 20, 30, 0, 0);
            assert.strictEqual(findActiveScheduleItem(schedule, beforeStart), null);
            assert.strictEqual(resolveEffectiveScheduleItem(schedule, beforeStart)?.query, 'evening chill');
            assert.strictEqual(isScheduleItemPastInTimeline(schedule, 0, beforeStart), false);
            assert.strictEqual(isScheduleItemPastInTimeline(schedule, 1, beforeStart), false);
            assert.strictEqual(isScheduleItemPastInTimeline(schedule, 2, beforeStart), false);

            // At 01:30 (gap between 23:00-01:00 and 02:00-04:00):
            // Strict active item is null, effective item must be 'midnight jazz' (which ended 30m ago at 01:00)
            const gapAfterMidnight = new Date(2026, 8, 25, 1, 30, 0, 0);
            assert.strictEqual(findActiveScheduleItem(schedule, gapAfterMidnight), null);
            assert.strictEqual(resolveEffectiveScheduleItem(schedule, gapAfterMidnight)?.query, 'midnight jazz');
            assert.strictEqual(isScheduleItemPastInTimeline(schedule, 0, gapAfterMidnight), true);
            assert.strictEqual(isScheduleItemPastInTimeline(schedule, 2, gapAfterMidnight), false);

            // At 04:30 (after 02:00-04:00 ended): effective item is 'late night ambient'
            const afterAll = new Date(2026, 8, 25, 4, 30, 0, 0);
            assert.strictEqual(resolveEffectiveScheduleItem(schedule, afterAll)?.query, 'late night ambient');
        });

        it('marks upcoming overnight slot as not past during daytime and marks daytime slot as past after midnight', () => {
            const schedule: ScheduleItem[] = [
                { start: '14:00', end: '23:00', query: 'beach walk' },
                { start: '23:00', end: '01:00', query: 'piano jazz' },
            ];

            // At 15:00 (during 14:00-23:00): 23:00-01:00 is upcoming, NOT past
            const afternoon = new Date(2026, 8, 24, 15, 0, 0, 0);
            assert.strictEqual(isScheduleItemPastInTimeline(schedule, 0, afternoon), false);
            assert.strictEqual(isScheduleItemPastInTimeline(schedule, 1, afternoon), false);

            // At 00:30 (during 23:00-01:00 after midnight): 14:00-23:00 is past, 23:00-01:00 is active
            const afterMidnight = new Date(2026, 8, 25, 0, 30, 0, 0);
            assert.strictEqual(isScheduleItemPastInTimeline(schedule, 0, afterMidnight), true);
            assert.strictEqual(isScheduleItemPastInTimeline(schedule, 1, afterMidnight), false);
        });

        it('treats full-day 00:00 - 00:00 (or 00:00 - 24:00 normalized) slot as active at any time', () => {
            const fullDayItem: ScheduleItem = { start: '00:00', end: '00:00', query: 'all day radio' };
            assert.strictEqual(isScheduleItemActive(fullDayItem, new Date(2026, 8, 24, 0, 0)), true);
            assert.strictEqual(isScheduleItemActive(fullDayItem, new Date(2026, 8, 24, 14, 30)), true);
        });

        it('handles single-item future overnight schedule (23:00 - 01:00 at 21:00) as waiting & not past, then past after 01:00', () => {
            const singleFutureOvernight: ScheduleItem[] = [
                { start: '23:00', end: '01:00', query: 'piano jazz' },
            ];

            // At 21:00 (2h before 23:00): strictly inactive, waiting for start, and NOT marked past!
            const at21 = new Date(2026, 8, 24, 21, 0, 0, 0);
            assert.strictEqual(findStrictlyActiveScheduleItem(singleFutureOvernight, at21), null);
            assert.strictEqual(isWaitingForScheduleStart(singleFutureOvernight, at21), true);
            assert.strictEqual(isScheduleItemPastInTimeline(singleFutureOvernight, 0, at21), false);

            // At 23:00 and 00:30: strictly active, no longer waiting, not past
            const at23 = new Date(2026, 8, 24, 23, 0, 0, 0);
            const at0030 = new Date(2026, 8, 25, 0, 30, 0, 0);
            assert.strictEqual(findStrictlyActiveScheduleItem(singleFutureOvernight, at23)?.query, 'piano jazz');
            assert.strictEqual(isWaitingForScheduleStart(singleFutureOvernight, at23), false);
            assert.strictEqual(isWaitingForScheduleStart(singleFutureOvernight, at0030), false);
            assert.strictEqual(isScheduleItemPastInTimeline(singleFutureOvernight, 0, at0030), false);

            // At 01:30 (after 01:00 end): no longer waiting for start, marked past in timeline, effective fallback continues
            const at0130 = new Date(2026, 8, 25, 1, 30, 0, 0);
            assert.strictEqual(findStrictlyActiveScheduleItem(singleFutureOvernight, at0130), null);
            assert.strictEqual(isWaitingForScheduleStart(singleFutureOvernight, at0130), false);
            assert.strictEqual(isScheduleItemPastInTimeline(singleFutureOvernight, 0, at0130), true);
            assert.strictEqual(resolveEffectiveScheduleItem(singleFutureOvernight, at0130)?.query, 'piano jazz');
        });

        it('treats morning/daytime reservations > 12h ahead (e.g. 09:17 -> 23:00 - 01:00) as waiting & not past', () => {
            const singleFutureOvernight: ScheduleItem[] = [
                { start: '23:00', end: '01:00', query: 'piano jazz' },
            ];

            // 09:17 (13h 43m before 23:00) and 06:00 (17h before 23:00): must stand by and NOT be marked past
            const at0917 = new Date(2026, 10, 12, 9, 17, 0, 0);
            const at0600 = new Date(2026, 10, 12, 6, 0, 0, 0);
            assert.strictEqual(isWaitingForScheduleStart(singleFutureOvernight, at0917), true);
            assert.strictEqual(isScheduleItemPastInTimeline(singleFutureOvernight, 0, at0917), false);
            assert.strictEqual(isWaitingForScheduleStart(singleFutureOvernight, at0600), true);
            assert.strictEqual(isScheduleItemPastInTimeline(singleFutureOvernight, 0, at0600), false);

            // Same-day evening slot (22:00 - 23:30) and midnight-ending slot (23:00 - 00:00) at 09:17
            const eveningSameDay: ScheduleItem[] = [{ start: '22:00', end: '23:30', query: 'night chill' }];
            const midnightEnd: ScheduleItem[] = [{ start: '23:00', end: '00:00', query: 'late piano' }];
            assert.strictEqual(isWaitingForScheduleStart(eveningSameDay, at0917), true);
            assert.strictEqual(isScheduleItemPastInTimeline(eveningSameDay, 0, at0917), false);
            assert.strictEqual(isWaitingForScheduleStart(midnightEnd, at0917), true);
            assert.strictEqual(isScheduleItemPastInTimeline(midnightEnd, 0, at0917), false);

            // Immediately after end (23:45 for 22:00-23:30, 00:15 for 23:00-00:00): must be past, NOT waiting
            const at2345 = new Date(2026, 10, 12, 23, 45, 0, 0);
            const at0015Next = new Date(2026, 10, 13, 0, 15, 0, 0);
            assert.strictEqual(isWaitingForScheduleStart(eveningSameDay, at2345), false);
            assert.strictEqual(isScheduleItemPastInTimeline(eveningSameDay, 0, at2345), true);
            assert.strictEqual(isWaitingForScheduleStart(midnightEnd, at0015Next), false);
            assert.strictEqual(isScheduleItemPastInTimeline(midnightEnd, 0, at0015Next), true);
        });

        it('anchors exact linear timeline via attachScheduleTimestamps across 24h+ without modulo ambiguity', () => {
            // Even at 01:15 AM, booking tonight's 23:00 - 01:00 (21h 45m ahead) anchors to tonight 23:00
            const created0115 = new Date(2026, 10, 12, 1, 15, 0, 0);
            const anchored = attachScheduleTimestamps(
                [{ start: '23:00', end: '01:00', query: 'piano jazz' }],
                created0115
            );

            // Waiting at 01:15 AM, 09:17 AM, and 22:59 PM on Nov 12
            assert.strictEqual(isWaitingForScheduleStart(anchored, created0115), true);
            assert.strictEqual(isScheduleItemPastInTimeline(anchored, 0, created0115), false);
            assert.strictEqual(isWaitingForScheduleStart(anchored, new Date(2026, 10, 12, 9, 17)), true);
            assert.strictEqual(isWaitingForScheduleStart(anchored, new Date(2026, 10, 12, 22, 59)), true);

            // Active at 23:00 Nov 12 and 00:30 Nov 13
            assert.strictEqual(isWaitingForScheduleStart(anchored, new Date(2026, 10, 12, 23, 0)), false);
            assert.strictEqual(isScheduleItemPastInTimeline(anchored, 0, new Date(2026, 10, 13, 0, 30)), false);

            // Past at 01:00 Nov 13 AND still past at 09:17 AM on Nov 13 (next morning after show finished!)
            assert.strictEqual(isWaitingForScheduleStart(anchored, new Date(2026, 10, 13, 1, 0)), false);
            assert.strictEqual(isScheduleItemPastInTimeline(anchored, 0, new Date(2026, 10, 13, 1, 0)), true);
            assert.strictEqual(isWaitingForScheduleStart(anchored, new Date(2026, 10, 13, 9, 17)), false);
            assert.strictEqual(isScheduleItemPastInTimeline(anchored, 0, new Date(2026, 10, 13, 9, 17)), true);
        });

        it('prevents next-morning blocks in a multi-block future schedule ([Thu 20:00-21:00, Fri 09:00-12:00] at Thu 09:17) from matching prematurely', () => {
            const thu0917 = new Date(2026, 10, 12, 9, 17, 0, 0);
            const anchored = attachScheduleTimestamps(
                [
                    { start: '20:00', end: '21:00', query: 'tonight jazz' },
                    { start: '09:00', end: '12:00', query: 'friday morning classical' },
                ],
                thu0917
            );

            // At Thu 09:17: NEITHER block is active (Fri 09:00-12:00 must NOT match Thu 09:17!), waiting is true, neither is past
            assert.strictEqual(findStrictlyActiveScheduleItem(anchored, thu0917), null);
            assert.strictEqual(isScheduleItemActive(anchored[1], thu0917), false);
            assert.strictEqual(isWaitingForScheduleStart(anchored, thu0917), true);
            assert.strictEqual(isScheduleItemPastInTimeline(anchored, 0, thu0917), false);
            assert.strictEqual(isScheduleItemPastInTimeline(anchored, 1, thu0917), false);

            // At Thu 20:30: Block 0 is active
            const thu2030 = new Date(2026, 10, 12, 20, 30, 0, 0);
            assert.strictEqual(findStrictlyActiveScheduleItem(anchored, thu2030)?.query, 'tonight jazz');
            assert.strictEqual(isWaitingForScheduleStart(anchored, thu2030), false);

            // At Thu 22:00 (gap between Thu 21:00 and Fri 09:00): Block 0 is past, Block 1 is upcoming, effective continues Block 0
            const thu2200 = new Date(2026, 10, 12, 22, 0, 0, 0);
            assert.strictEqual(findStrictlyActiveScheduleItem(anchored, thu2200), null);
            assert.strictEqual(isWaitingForScheduleStart(anchored, thu2200), false);
            assert.strictEqual(isScheduleItemPastInTimeline(anchored, 0, thu2200), true);
            assert.strictEqual(isScheduleItemPastInTimeline(anchored, 1, thu2200), false);
            assert.strictEqual(resolveEffectiveScheduleItem(anchored, thu2200)?.query, 'tonight jazz');

            // At Fri 09:17: Block 1 is now strictly active!
            const fri0917 = new Date(2026, 10, 13, 9, 17, 0, 0);
            assert.strictEqual(findStrictlyActiveScheduleItem(anchored, fri0917)?.query, 'friday morning classical');
            assert.strictEqual(isScheduleItemActive(anchored[1], fri0917), true);
            assert.strictEqual(isScheduleItemPastInTimeline(anchored, 0, fri0917), true);
            assert.strictEqual(isScheduleItemPastInTimeline(anchored, 1, fri0917), false);
        });

        it('supports forceFutureDay for explicit tomorrow single-block and multi-block reservations even when requested time >= current clock time', () => {
            const thu0917 = new Date(2026, 10, 12, 9, 17, 0, 0);
            const tomorrowMorning = attachScheduleTimestamps(
                [{ start: '09:00', end: '11:00', query: 'tomorrow jazz' }],
                thu0917,
                [],
                { forceFutureDay: true }
            );

            assert.strictEqual(findStrictlyActiveScheduleItem(tomorrowMorning, thu0917), null);
            assert.strictEqual(isWaitingForScheduleStart(tomorrowMorning, thu0917), true);
            assert.strictEqual(
                findStrictlyActiveScheduleItem(tomorrowMorning, new Date(2026, 10, 13, 9, 17, 0, 0))?.query,
                'tomorrow jazz'
            );

            // Requested time >= current time (Thu 09:17 -> "明日の10:00"): must anchor to Fri 10:00, NOT Thu 10:00!
            const tomorrowTenAm = attachScheduleTimestamps(
                [{ start: '10:00', end: '12:00', query: 'friday 10am jazz' }],
                thu0917,
                [],
                { forceFutureDay: true }
            );
            const thu1030 = new Date(2026, 10, 12, 10, 30, 0, 0);
            const fri1030 = new Date(2026, 10, 13, 10, 30, 0, 0);
            assert.strictEqual(findStrictlyActiveScheduleItem(tomorrowTenAm, thu1030), null);
            assert.strictEqual(isWaitingForScheduleStart(tomorrowTenAm, thu1030), true);
            assert.strictEqual(findStrictlyActiveScheduleItem(tomorrowTenAm, fri1030)?.query, 'friday 10am jazz');

            // Late-night booking (Thu 23:30 -> "明日の09:00"): must anchor to Fri 09:00, NOT Sat 09:00!
            const thu2330 = new Date(2026, 10, 12, 23, 30, 0, 0);
            const bookedLateForFri = attachScheduleTimestamps(
                [
                    { start: '09:00', end: '12:00', query: 'fri classical' },
                    { start: '12:00', end: '15:00', query: 'fri bossa' },
                ],
                thu2330,
                [],
                { forceFutureDay: true }
            );
            assert.strictEqual(isWaitingForScheduleStart(bookedLateForFri, thu2330), true);
            assert.strictEqual(
                findStrictlyActiveScheduleItem(bookedLateForFri, new Date(2026, 10, 13, 9, 30))?.query,
                'fri classical'
            );
            assert.strictEqual(
                findStrictlyActiveScheduleItem(bookedLateForFri, new Date(2026, 10, 13, 12, 30))?.query,
                'fri bossa'
            );
        });

        it('handles expired previousSchedule, >10h overnight future reservations, preserved upcoming anchors, and multi-day overlap advancement', () => {
            const wed2300 = new Date(2026, 10, 11, 23, 0, 0, 0);
            const expiredYesterday = attachScheduleTimestamps(
                [{ start: '23:00', end: '01:00', query: 'old jazz' }],
                wed2300
            );
            const thu0917 = new Date(2026, 10, 12, 9, 17, 0, 0);
            assert.deepStrictEqual(filterActiveOrUpcomingSchedule(expiredYesterday, thu0917), []);

            // Even if expiredYesterday is passed as previousSchedule at Thu 09:17, new 23:00 booking anchors to Thu 23:00 (waiting!)
            const rebookedTonight = attachScheduleTimestamps(
                [{ start: '23:00', end: '01:00', query: 'new bossa' }],
                thu0917,
                expiredYesterday
            );
            assert.strictEqual(isWaitingForScheduleStart(rebookedTonight, thu0917), true);

            // Multi-block overnight [23:00-07:00, 07:00-10:00] and long overnight [23:00-10:00] booked at Thu 09:17
            const twoBlockOvernight = attachScheduleTimestamps(
                [
                    { start: '23:00', end: '07:00', query: 'sleep ambient' },
                    { start: '07:00', end: '10:00', query: 'morning pop' },
                ],
                thu0917
            );
            assert.strictEqual(isWaitingForScheduleStart(twoBlockOvernight, thu0917), true);
            assert.strictEqual(findStrictlyActiveScheduleItem(twoBlockOvernight, thu0917), null);

            const longOvernight = attachScheduleTimestamps(
                [{ start: '23:00', end: '10:00', query: 'deep sleep' }],
                thu0917,
                [],
                { forceFutureStart: true }
            );
            assert.strictEqual(isWaitingForScheduleStart(longOvernight, thu0917), true);

            // Preserves upcoming Fri 09:00 anchor when appending a 12:00 block at Thu 09:18
            const friSingle = attachScheduleTimestamps(
                [{ start: '09:00', end: '12:00', query: 'fri classical' }],
                thu0917,
                [],
                { forceFutureDay: true }
            );
            const thu0918 = new Date(2026, 10, 12, 9, 18, 0, 0);
            const friAppended = attachScheduleTimestamps(
                [
                    { start: '09:00', end: '12:00', query: 'fri classical' },
                    { start: '12:00', end: '14:00', query: 'fri bossa' },
                ],
                thu0918,
                friSingle
            );
            assert.strictEqual(isWaitingForScheduleStart(friAppended, thu0918), true);
            assert.strictEqual(
                findStrictlyActiveScheduleItem(friAppended, new Date(2026, 10, 13, 12, 30))?.query,
                'fri bossa'
            );

            // Multi-day [Thu 08:50-12:00, Fri 09:00-11:00]: Block 1 advances to Fri 09:00 instead of overlapping Thu 08:50-12:00
            const thu0850 = new Date(2026, 10, 12, 8, 50, 0, 0);
            const todayPlusTomorrow = attachScheduleTimestamps(
                [
                    { start: '08:50', end: '12:00', query: 'today ocean' },
                    { start: '09:00', end: '11:00', query: 'tomorrow classical' },
                ],
                thu0850
            );
            assert.strictEqual(
                findStrictlyActiveScheduleItem(todayPlusTomorrow, new Date(2026, 10, 12, 9, 30))?.query,
                'today ocean'
            );
            assert.strictEqual(
                findStrictlyActiveScheduleItem(todayPlusTomorrow, new Date(2026, 10, 13, 9, 30))?.query,
                'tomorrow classical'
            );
        });
    });

    describe('isExplicitFutureScheduleRequest', () => {
        it('rejects partial digit substring false positives ("23時" vs "3時", "21:00" vs "1:00", "11pm" vs "1pm", "15時30分" vs "15:00")', () => {
            // "23時" must NOT match 15:00 (h12 = 3 -> "3時") or 03:00
            assert.strictEqual(
                isExplicitFutureScheduleRequest('海を散歩したい気分に合う音楽を。23時からはピアノのJazzを聴きたいです。', '15:00', 25, 2),
                false
            );
            assert.strictEqual(
                isExplicitFutureScheduleRequest('23時からはピアノのJazz', '03:00', 20, 1),
                false
            );

            // "21:00" must NOT match 13:00 (h12 = 1 -> "1:00") or 01:00
            assert.strictEqual(
                isExplicitFutureScheduleRequest('作業用BGMをお願い。21:00からはロックを聴きたい', '13:00', 20, 2),
                false
            );
            assert.strictEqual(
                isExplicitFutureScheduleRequest('Play chill beats until 21:00', '01:00', 20, 1),
                false
            );

            // "11pm" must NOT match 13:00 (h12 = 1 -> "1pm")
            assert.strictEqual(
                isExplicitFutureScheduleRequest('Chill music now, sleep ambient at 11pm', '13:00', 20, 2),
                false
            );

            // "15時30分" / "15時半" must NOT match "15:00", but MUST match "15:30"
            assert.strictEqual(isExplicitFutureScheduleRequest('15時30分からジャズ', '15:00', 30, 1), false);
            assert.strictEqual(isExplicitFutureScheduleRequest('15時半からジャズ', '15:00', 30, 1), false);
            assert.strictEqual(isExplicitFutureScheduleRequest('15時30分からジャズ', '15:30', 30, 1), true);
            assert.strictEqual(isExplicitFutureScheduleRequest('3時半からジャズ', '15:30', 30, 1), true);

            // AM/PM and 午前/午後 contradictions rejected, matching meridiems accepted
            assert.strictEqual(isExplicitFutureScheduleRequest('午前3時からアンビエント', '15:00', 20, 1), false);
            assert.strictEqual(isExplicitFutureScheduleRequest('3:00 am ambient', '15:00', 20, 1), false);
            assert.strictEqual(isExplicitFutureScheduleRequest('午後3時からボサノバ', '03:00', 20, 1), false);
            assert.strictEqual(isExplicitFutureScheduleRequest('午後3時からボサノバ', '15:00', 20, 1), true);
            assert.strictEqual(isExplicitFutureScheduleRequest('３時からボサノバ', '15:00', 20, 1), true);
            assert.strictEqual(isExplicitFutureScheduleRequest('Play jazz at 3 pm', '15:00', 20, 1), true);
        });

        it('does not misclassify Block 0 as future in multi-block schedules containing "今夜" / "tonight", while preserving single-block future requests', () => {
            // Multi-block (immediate + tonight): "今夜" refers to Block 1, so Block 0 must snap to now (false)
            assert.strictEqual(
                isExplicitFutureScheduleRequest('海を散歩したい気分に合う音楽を。今夜はピアノのJazzを聴きたいです。', '18:00', 40, 2),
                false
            );
            assert.strictEqual(
                isExplicitFutureScheduleRequest('Play focus beats, and tonight switch to piano jazz', '18:00', 40, 2),
                false
            );

            // Multi-block where user explicitly named Block 0's clock time ("21時"): preserved (true)
            assert.strictEqual(
                isExplicitFutureScheduleRequest('21時からジャズ、23時からはアンビエントを聴きたい', '21:00', 40, 2),
                true
            );

            // Single-block deferred ("今夜", "30分後", "in 30 minutes"): preserved (true)
            assert.strictEqual(
                isExplicitFutureScheduleRequest('今夜はピアノのJazzを聴きたい', '21:00', 40, 1),
                true
            );
            assert.strictEqual(
                isExplicitFutureScheduleRequest('30分後にジャズをかけて', '15:00', 30, 1),
                true
            );
            assert.strictEqual(
                isExplicitFutureScheduleRequest('Play jazz in 30 minutes', '15:00', 30, 1),
                true
            );

            // Explicit immediate cue ("今から") overrides vague deferred words
            assert.strictEqual(
                isExplicitFutureScheduleRequest('今から夜遅くまでジャズを聴きたい', '21:00', 40, 1),
                false
            );

            // Midnight ("24時", "24:00", "midnight") and Noon ("午後0時", "正午", "noon") expressions
            assert.strictEqual(isExplicitFutureScheduleRequest('24時からアンビエントを流して', '00:00', 30, 1), true);
            assert.strictEqual(isExplicitFutureScheduleRequest('24:00からアンビエントを流して', '00:00', 30, 1), true);
            assert.strictEqual(isExplicitFutureScheduleRequest('Play ambient at midnight', '00:00', 30, 1), true);
            assert.strictEqual(isExplicitFutureScheduleRequest('午後0時からボサノバ', '12:00', 30, 1), true);
            assert.strictEqual(isExplicitFutureScheduleRequest('正午からボサノバ', '12:00', 30, 1), true);
            assert.strictEqual(isExplicitFutureScheduleRequest('Play bossa nova at noon', '12:00', 30, 1), true);

            // End-bound expressions ("23時まで", "until 23:00", "21時から23時", "from 21:00 to 23:00") must NOT match as start time, while "これから23時に" MUST match
            assert.strictEqual(isExplicitFutureScheduleRequest('23時まで作業用BGMを流して', '23:00', 40, 1), false);
            assert.strictEqual(isExplicitFutureScheduleRequest('Play focus beats until 23:00', '23:00', 40, 1), false);
            assert.strictEqual(isExplicitFutureScheduleRequest('Play focus beats from 21:00 to 23:00', '23:00', 40, 1), false);
            assert.strictEqual(isExplicitFutureScheduleRequest('Play focus beats from 21:00 to 23:00', '21:00', 40, 1), true);
            assert.strictEqual(isExplicitFutureScheduleRequest('21時から23時はジャズ', '23:00', 40, 1), false);
            assert.strictEqual(isExplicitFutureScheduleRequest('21時から23時はジャズ', '21:00', 40, 1), true);
            assert.strictEqual(isExplicitFutureScheduleRequest('これから23時にジャズを流して', '23:00', 40, 1), true);
        });

        it('rejects duration false positives ("3時間") and natural meridiem conflicts ("夜9時" vs 09:00, "朝9時" vs 21:00), and classifies tomorrow multi-block prompts', () => {
            // Duration expressions ("3時間", "1時間", "24時間") must NOT match clock hours ("15:00", "01:00", "00:00")
            assert.strictEqual(isExplicitFutureScheduleRequest('3時間くらい作業用BGMをかけて', '15:00', 40, 1), false);
            assert.strictEqual(isExplicitFutureScheduleRequest('1時間だけ集中したい', '13:00', 40, 1), false);
            assert.strictEqual(isExplicitFutureScheduleRequest('24時間ラジオみたいに流して', '00:00', 40, 1), false);
            // Relative future offset ("1時間後") still matches as explicit future!
            assert.strictEqual(isExplicitFutureScheduleRequest('1時間後にジャズを流して', '15:00', 60, 1), true);

            // Natural Japanese meridiem words ("朝", "昼", "夕方", "夜", "深夜")
            assert.strictEqual(isExplicitFutureScheduleRequest('海を散歩したい。夜9時からはピアノのJazz', '09:00', 20, 2), false);
            assert.strictEqual(isExplicitFutureScheduleRequest('夜9時からはピアノのJazz', '21:00', 40, 1), true);
            assert.strictEqual(isExplicitFutureScheduleRequest('夜23時からはピアノのJazz', '23:00', 40, 1), true);
            assert.strictEqual(isExplicitFutureScheduleRequest('リラックスしたい。朝9時からはクラシック', '21:00', 20, 2), false);
            assert.strictEqual(isExplicitFutureScheduleRequest('朝9時からはクラシック', '09:00', 40, 1), true);
            assert.strictEqual(isExplicitFutureScheduleRequest('夕方5時からはロック', '05:00', 40, 1), false);
            assert.strictEqual(isExplicitFutureScheduleRequest('夕方5時からはロック', '17:00', 40, 1), true);
            assert.strictEqual(isExplicitFutureScheduleRequest('昼2時からはポップス', '02:00', 40, 1), false);
            assert.strictEqual(isExplicitFutureScheduleRequest('昼2時からはポップス', '14:00', 40, 1), true);
            assert.strictEqual(isExplicitFutureScheduleRequest('深夜2時からはアンビエント', '14:00', 40, 1), false);
            assert.strictEqual(isExplicitFutureScheduleRequest('深夜2時からはアンビエント', '02:00', 40, 1), true);

            // Clause-2 tomorrow clock token ("海を散歩したい。明日の朝9時からはクラシック") must NOT match Block 0's rounded 09:00
            assert.strictEqual(
                isExplicitFutureScheduleRequest('海を散歩したい気分。明日の朝9時からはクラシック', '09:00', 10, 2),
                false
            );
            assert.strictEqual(
                isTomorrowFirstBlockRequest('海を散歩したい気分。明日の朝9時からはクラシック', '09:00', 2),
                false
            );
            assert.strictEqual(
                isTomorrowFirstBlockRequest('22時からはジャズ、明日の朝9時からはクラシック', '22:00', 2),
                false
            );
            assert.strictEqual(
                isTomorrowFirstBlockRequest('明日の朝9時からはクラシック、12時からはボサノバ', '09:00', 2),
                true
            );
            assert.strictEqual(
                isTomorrowFirstBlockRequest('明日の10時からジャズを聴きたい', '10:00', 1),
                true
            );
        });
    });

    describe('getScheduleItemDisplayStatus, resolveScheduleThought & shouldPreserveActivePlaybackOnScheduleUpdate', () => {
        it('transitions cleanly across standby -> active -> past -> upcoming and marks expired idle schedules as past', () => {
            const bookedAt0917 = new Date(2026, 10, 12, 9, 17, 0, 0);
            const schedule = attachScheduleTimestamps(
                [
                    { start: '23:00', end: '01:00', query: 'piano jazz', thought: 'Late piano' },
                    { start: '01:00', end: '03:00', query: 'ambient sleep', thought: 'Deep sleep' },
                ],
                bookedAt0917
            );

            // At 09:17 (waiting for 23:00): Block 0 is 'standby', Block 1 is 'upcoming'
            assert.strictEqual(getScheduleItemDisplayStatus(schedule, 0, null, bookedAt0917), 'standby');
            assert.strictEqual(getScheduleItemDisplayStatus(schedule, 1, null, bookedAt0917), 'upcoming');
            // Thought is shown when idle, but suppressed if a prior block's query is still playing
            assert.strictEqual(resolveScheduleThought(schedule, null, bookedAt0917), 'Late piano');
            assert.strictEqual(resolveScheduleThought(schedule, 'ocean walk', bookedAt0917), null);

            // At 23:30: Block 0 is 'active', Block 1 is 'upcoming'
            const at2330 = new Date(2026, 10, 12, 23, 30, 0, 0);
            assert.strictEqual(getScheduleItemDisplayStatus(schedule, 0, 'piano jazz', at2330), 'active');
            assert.strictEqual(getScheduleItemDisplayStatus(schedule, 1, 'piano jazz', at2330), 'upcoming');

            // At 01:30 next day: Block 0 is 'past', Block 1 is 'active'
            const at0130 = new Date(2026, 10, 13, 1, 30, 0, 0);
            assert.strictEqual(getScheduleItemDisplayStatus(schedule, 0, 'ambient sleep', at0130), 'past');
            assert.strictEqual(getScheduleItemDisplayStatus(schedule, 1, 'ambient sleep', at0130), 'active');

            // At 09:17 next day after all slots ended: 'active' if fallback query still playing, 'past' if idle (currentQuery === null)
            const nextMorning = new Date(2026, 10, 13, 9, 17, 0, 0);
            assert.strictEqual(getScheduleItemDisplayStatus(schedule, 1, 'ambient sleep', nextMorning), 'active');
            assert.strictEqual(getScheduleItemDisplayStatus(schedule, 0, null, nextMorning), 'past');
            assert.strictEqual(getScheduleItemDisplayStatus(schedule, 1, null, nextMorning), 'past');

            // Preserves active playback when appending/editing future blocks, but restarts when active block changes or single block repeats
            const morningNow = new Date(2026, 10, 12, 10, 15, 0, 0);
            const prevSched = attachScheduleTimestamps(
                [{ start: '09:00', end: '12:00', query: 'ocean walk' }],
                morningNow
            );
            const nextWithTonight = attachScheduleTimestamps(
                [
                    { start: '09:00', end: '23:00', query: 'ocean walk' },
                    { start: '23:00', end: '01:00', query: 'piano jazz' },
                ],
                morningNow,
                prevSched
            );
            assert.strictEqual(
                shouldPreserveActivePlaybackOnScheduleUpdate({
                    prevSchedule: prevSched,
                    nextSchedule: nextWithTonight,
                    prevCurrentQuery: 'ocean walk',
                    isSessionActive: true,
                    date: morningNow,
                }),
                true
            );
            assert.strictEqual(
                shouldPreserveActivePlaybackOnScheduleUpdate({
                    prevSchedule: prevSched,
                    nextSchedule: prevSched,
                    prevCurrentQuery: 'ocean walk',
                    isSessionActive: true,
                    date: morningNow,
                }),
                false
            );
        });
    });
});
