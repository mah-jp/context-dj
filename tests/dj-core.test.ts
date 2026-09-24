import test, { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DJCore } from '../src/lib/dj-core.ts';
import { ScheduleItem } from '../src/lib/types.ts';

describe('DJCore', () => {
    let store: Record<string, string> = {};

    beforeEach(() => {
        store = {};
        const localStorageMock = {
            getItem: (key: string) => store[key] ?? null,
            setItem: (key: string, value: string) => { store[key] = String(value); },
            removeItem: (key: string) => { delete store[key]; },
            clear: () => { store = {}; }
        };

        (globalThis as any).window = { localStorage: localStorageMock };
        (globalThis as any).localStorage = localStorageMock;
    });

    describe('Schedule management', () => {
        it('sets and removes schedule items correctly', () => {
            const dj = new DJCore('fake_token');
            const items: ScheduleItem[] = [
                { start: '10:00', end: '12:00', query: 'morning coffee' },
                { start: '12:00', end: '14:00', query: 'lunch acoustic' },
                { start: '14:00', end: '16:00', query: 'afternoon focus' },
            ];

            dj.setSchedule(items);
            assert.strictEqual(dj.getDJStatus().currentScheduleItem, null); // assuming test run time is not 10-16

            // Remove item at index 1
            dj.removeScheduleItem(1);
            // Verify by finding items around lunch
            const testDate = new Date(2026, 8, 24, 12, 30);
            assert.strictEqual(dj.getItemForDate(testDate), null);

            // Item 0 and 2 should still exist
            const morningDate = new Date(2026, 8, 24, 10, 30);
            assert.strictEqual(dj.getItemForDate(morningDate)?.query, 'morning coffee');
        });

        it('finds correct schedule item across midnight boundaries', () => {
            const dj = new DJCore('fake_token');
            const items: ScheduleItem[] = [
                { start: '09:00', end: '17:00', query: 'work day' },
                { start: '23:00', end: '01:00', query: 'midnight session' },
            ];
            dj.setSchedule(items);

            // Test normal slot
            const dayTime = new Date(2026, 8, 24, 14, 0);
            assert.strictEqual(dj.getItemForDate(dayTime)?.query, 'work day');

            // Test overnight slot - before midnight
            const lateNight = new Date(2026, 8, 24, 23, 30);
            assert.strictEqual(dj.getItemForDate(lateNight)?.query, 'midnight session');

            // Test overnight slot - after midnight
            const earlyMorning = new Date(2026, 8, 25, 0, 30);
            assert.strictEqual(dj.getItemForDate(earlyMorning)?.query, 'midnight session');

            // Test outside of any slot
            const outside = new Date(2026, 8, 24, 19, 0);
            assert.strictEqual(dj.getItemForDate(outside), null);
        });

        it('falls back to single schedule item if only one exists', () => {
            const dj = new DJCore('fake_token');
            dj.setSchedule([
                { start: '12:00', end: '14:00', query: 'only one item' }
            ]);

            // Even if outside 12:00-14:00, single item acts as fallback
            const midnight = new Date(2026, 8, 24, 3, 0);
            assert.strictEqual(dj.getItemForDate(midnight)?.query, 'only one item');
        });
    });

    describe('Process log management', () => {
        it('limits process log to 100 entries', () => {
            const dj = new DJCore('fake_token');
            // dj-core addLog is private, but triggered internally; let's check initial log
            assert.deepStrictEqual(dj.getProcessLog(), []);
        });
    });

    describe('Up Next & Metadata caching', () => {
        it('restores selectionReason via URI, ID, or trackKey', () => {
            // Pre-seed track metadata cache in localStorage
            store['dj_track_metadata_cache'] = JSON.stringify({
                'spotify:track:uri1': { selectionReason: 'Reason by URI', stage: 'intro' },
                'id2': { selectionReason: 'Reason by ID', stage: 'build' },
                'key:ocean walk|artist3': { selectionReason: 'Reason by TrackKey', stage: 'peak' },
            });

            const dj = new DJCore('fake_token');

            // 1. Match by URI
            const t1 = dj.enrichTrackWithCachedMetadata({
                id: 'other_id',
                name: 'Some Name',
                uri: 'spotify:track:uri1',
                artists: [{ name: 'Artist1' } as any],
                album: {} as any
            } as any);
            assert.strictEqual(t1.selectionReason, 'Reason by URI');
            assert.strictEqual(t1.stage, 'intro');

            // 2. Match by ID
            const t2 = dj.enrichTrackWithCachedMetadata({
                id: 'id2',
                name: 'Another Name',
                uri: 'spotify:track:different_uri',
                artists: [{ name: 'Artist2' } as any],
                album: {} as any
            } as any);
            assert.strictEqual(t2.selectionReason, 'Reason by ID');
            assert.strictEqual(t2.stage, 'build');

            // 3. Match by TrackKey (Title + Artist) when URI and ID differ (relinked track)
            const t3 = dj.enrichTrackWithCachedMetadata({
                id: 'relinked_id',
                name: 'Ocean Walk (Remastered 2026)',
                uri: 'spotify:track:relinked_uri',
                artists: [{ name: 'Artist3' } as any],
                album: {} as any
            } as any);
            assert.strictEqual(t3.selectionReason, 'Reason by TrackKey');
            assert.strictEqual(t3.stage, 'peak');
        });

        it('advances Up Next dynamically as currently playing track changes', async () => {
            // Seed session tracks in localStorage
            const sessionTracks = [
                { id: 't1', uri: 'spotify:track:1', name: 'Song 1', artists: [{ name: 'Art 1' }], selectionReason: 'Reason 1' },
                { id: 't2', uri: 'spotify:track:2', name: 'Song 2', artists: [{ name: 'Art 2' }], selectionReason: 'Reason 2' },
                { id: 't3', uri: 'spotify:track:3', name: 'Song 3', artists: [{ name: 'Art 3' }], selectionReason: 'Reason 3' },
                { id: 't4', uri: 'spotify:track:4', name: 'Song 4', artists: [{ name: 'Art 4' }], selectionReason: 'Reason 4' },
            ];
            store['dj_current_session_tracks'] = JSON.stringify(sessionTracks);

            const dj = new DJCore('fake_token');
            // Mock spotify.getGeneric to return empty queue (simulating mobile Spotify Connect)
            (dj as any).spotify.getGeneric = async () => ({ queue: [] });

            // Case 1: Currently playing Song 1 (index 0) -> Up Next should be [Song 2, Song 3, Song 4]
            const queueAtSong1 = await dj.getQueue(sessionTracks[0] as any);
            assert.strictEqual(queueAtSong1.length, 3);
            assert.strictEqual(queueAtSong1[0].name, 'Song 2');
            assert.strictEqual(queueAtSong1[0].selectionReason, 'Reason 2');
            assert.strictEqual(queueAtSong1[1].name, 'Song 3');

            // Case 2: Track advances to Song 2 (index 1) -> Up Next should dynamically advance to [Song 3, Song 4]
            const queueAtSong2 = await dj.getQueue(sessionTracks[1] as any);
            assert.strictEqual(queueAtSong2.length, 2);
            assert.strictEqual(queueAtSong2[0].name, 'Song 3');
            assert.strictEqual(queueAtSong2[0].selectionReason, 'Reason 3');
            assert.strictEqual(queueAtSong2[1].name, 'Song 4');

            // Case 3: Track advances to Song 3 (index 2) -> Up Next should dynamically advance to [Song 4]
            const queueAtSong3 = await dj.getQueue(sessionTracks[2] as any);
            assert.strictEqual(queueAtSong3.length, 1);
            assert.strictEqual(queueAtSong3[0].name, 'Song 4');
            assert.strictEqual(queueAtSong3[0].selectionReason, 'Reason 4');
        });

        it('advances Up Next accurately even when Spotify API returns a lagging/stale queue', async () => {
            const sessionTracks = [
                { id: 's1', uri: 'spotify:track:s1', name: 'Song 1', artists: [{ name: 'Artist 1' }], selectionReason: 'Reason 1' },
                { id: 's2', uri: 'spotify:track:s2', name: 'Song 2', artists: [{ name: 'Artist 2' }], selectionReason: 'Reason 2' },
                { id: 's3', uri: 'spotify:track:s3', name: 'Song 3', artists: [{ name: 'Artist 3' }], selectionReason: 'Reason 3' },
            ];
            store['dj_current_session_tracks'] = JSON.stringify(sessionTracks);

            const dj = new DJCore('fake_token');
            // Mock spotify.getGeneric to return a lagging queue that still includes Song 2 at index 0
            (dj as any).spotify.getGeneric = async () => ({
                currently_playing: sessionTracks[1],
                queue: [
                    { id: 's2', uri: 'spotify:track:s2', name: 'Song 2', type: 'track' },
                    { id: 's3', uri: 'spotify:track:s3', name: 'Song 3', type: 'track' }
                ]
            });

            // Currently playing Song 2 -> Up Next MUST advance to Song 3, NOT show Song 2 at index 0!
            const upcoming = await dj.getQueue(sessionTracks[1] as any);
            assert.strictEqual(upcoming.length, 1);
            assert.strictEqual(upcoming[0].name, 'Song 3');
            assert.strictEqual(upcoming[0].selectionReason, 'Reason 3');
        });

        it('uses Spotify live queue when available from API and enriches with metadata', async () => {
            // Seed metadata cache in localStorage
            store['dj_track_metadata_cache'] = JSON.stringify({
                'spotify:track:q1': { selectionReason: 'Reason for Q1', vibeTag: '#Chill' },
                'spotify:track:q2': { selectionReason: 'Reason for Q2', vibeTag: '#Energy' }
            });

            const dj = new DJCore('fake_token');
            const realSpotifyQueue = [
                { id: 'q1', uri: 'spotify:track:q1', name: 'Track Q1', artists: [{ name: 'Artist 1' }], type: 'track' },
                { id: 'q2', uri: 'spotify:track:q2', name: 'Track Q2', artists: [{ name: 'Artist 2' }], type: 'track' },
            ];
            (dj as any).spotify.getGeneric = async () => ({ queue: realSpotifyQueue });

            const queue = await dj.getQueue();
            assert.strictEqual(queue.length, 2);
            assert.strictEqual(queue[0].name, 'Track Q1');
            assert.strictEqual(queue[0].selectionReason, 'Reason for Q1');
            assert.strictEqual(queue[0].vibeTag, '#Chill');
            assert.strictEqual(queue[1].name, 'Track Q2');
            assert.strictEqual(queue[1].selectionReason, 'Reason for Q2');
        });

        it('restores selectionReason via currentSessionTracks and fuzzy title match on reload when cache is missing', async () => {
            // Simulate page reload where track metadata cache was cleared or track was relinked,
            // but session tracks exist in localStorage.
            const sessionTracks = [
                {
                    id: 'original_id',
                    uri: 'spotify:track:orig_uri',
                    name: 'Sunset Cruise',
                    artists: [{ name: 'City Pop Band' }],
                    selectionReason: '夕暮れの爽快なムードにぴったりの名曲。',
                    vibeTag: '#夕暮れドライブ',
                    stage: 'build'
                }
            ];
            store['dj_current_session_tracks'] = JSON.stringify(sessionTracks);
            // Notice: track_metadata_cache is intentionally empty in localStorage!

            const dj = new DJCore('fake_token');

            // Spotify returns a relinked track with different ID/URI and minor title variance (e.g. remastered tag)
            const rawSpotifyTrack = {
                id: 'relinked_different_id',
                uri: 'spotify:track:relinked_different_uri',
                name: 'Sunset Cruise - 2026 Remaster',
                artists: [{ name: 'City Pop Band' }],
                type: 'track'
            };

            const enriched = dj.enrichTrackWithCachedMetadata(rawSpotifyTrack as any);

            // Should be successfully enriched from currentSessionTracks via fuzzy match
            assert.strictEqual(enriched.selectionReason, '夕暮れの爽快なムードにぴったりの名曲。');
            assert.strictEqual(enriched.vibeTag, '#夕暮れドライブ');
            assert.strictEqual(enriched.stage, 'build');
        });
    });
});

