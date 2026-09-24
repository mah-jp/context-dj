import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeTrackName,
    generateTrackKey,
    isScheduleItemActive,
    isScheduleItemPast,
    getScheduleItemSignature,
    getScheduleItemQueries,
} from '../src/lib/dj-utils.ts';
import { ScheduleItem, Track } from '../src/lib/types.ts';

describe('dj-utils', () => {
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
    });

    describe('generateTrackKey', () => {
        it('should generate consistent deduplication key', () => {
            const track1: Partial<Track> = {
                name: 'Plastic Love (Remastered)',
                artists: [{ name: 'Mariya Takeuchi' }] as any,
            };
            const track2: Partial<Track> = {
                name: 'Plastic Love - 2021 Version',
                artists: [{ name: '  mariya takeuchi  ' }] as any,
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
                artists: [] as any,
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
});
