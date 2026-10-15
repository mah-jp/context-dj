import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DJCore } from '../src/lib/dj-core';
import { ScheduleItem, Track } from '../src/lib/types';

function makeTrack(overrides: {
    id: string;
    name: string;
    uri: string;
    artistName: string;
    selectionReason?: string;
    vibeTag?: string;
    stage?: 'intro' | 'build' | 'peak' | 'outro';
}): Track {
    return {
        id: overrides.id,
        name: overrides.name,
        uri: overrides.uri,
        artists: [{ name: overrides.artistName } as SpotifyApi.ArtistObjectSimplified],
        album: {} as SpotifyApi.AlbumObjectSimplified,
        selectionReason: overrides.selectionReason,
        vibeTag: overrides.vibeTag,
        stage: overrides.stage,
        type: 'track',
    } as unknown as Track;
}

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

        const g = globalThis as Record<string, unknown>;
        g.window = { localStorage: localStorageMock };
        g.localStorage = localStorageMock;
    });

    describe('Schedule management', () => {
        it('sets and removes schedule items correctly', () => {
            const dj = new DJCore('fake_token');
            const items: ScheduleItem[] = [
                { start: '02:00', end: '04:00', query: 'early morning coffee' },
                { start: '04:00', end: '06:00', query: 'dawn acoustic' },
                { start: '06:00', end: '08:00', query: 'morning focus' },
            ];

            dj.setSchedule(items);
            const outsideDate = new Date(2026, 8, 24, 12, 30);
            assert.strictEqual(dj.getItemForDate(outsideDate), null);

            // Remove item at index 1
            dj.removeScheduleItem(1);
            // Verify by finding items around dawn (removed)
            const dawnDate = new Date(2026, 8, 24, 5, 0);
            assert.strictEqual(dj.getItemForDate(dawnDate), null);

            // Item 0 and 2 should still exist
            const earlyDate = new Date(2026, 8, 24, 3, 0);
            assert.strictEqual(dj.getItemForDate(earlyDate)?.query, 'early morning coffee');
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

        it('guarantees continuous playback via getEffectiveItemForPlayback even before slots or in gaps', () => {
            const dj = new DJCore('fake_token');
            dj.setSchedule([
                { start: '15:00', end: '18:00', query: 'afternoon cafe' },
                { start: '20:00', end: '23:00', query: 'night jazz' },
            ]);

            // 1. Current time is before the first slot (e.g. 14:55) -> must pick the first slot!
            const beforeFirst = new Date(2026, 8, 24, 14, 55);
            assert.strictEqual(dj.getItemForDate(beforeFirst), null); // strict item is null
            assert.strictEqual(dj.getEffectiveItemForPlayback(beforeFirst)?.query, 'afternoon cafe'); // effective item picks first!

            // 2. Current time is in the gap between slots (e.g. 19:00) -> picks the most recent slot!
            const inGap = new Date(2026, 8, 24, 19, 0);
            assert.strictEqual(dj.getItemForDate(inGap), null); // strict item is null
            assert.strictEqual(dj.getEffectiveItemForPlayback(inGap)?.query, 'afternoon cafe');
        });
    });

    describe('Process log management', () => {
        it('limits process log to 100 entries', () => {
            const dj = new DJCore('fake_token');
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
            const t1 = dj.enrichTrackWithCachedMetadata(makeTrack({
                id: 'other_id',
                name: 'Some Name',
                uri: 'spotify:track:uri1',
                artistName: 'Artist1',
            }));
            assert.strictEqual(t1.selectionReason, 'Reason by URI');
            assert.strictEqual(t1.stage, 'intro');

            // 2. Match by ID
            const t2 = dj.enrichTrackWithCachedMetadata(makeTrack({
                id: 'id2',
                name: 'Another Name',
                uri: 'spotify:track:different_uri',
                artistName: 'Artist2',
            }));
            assert.strictEqual(t2.selectionReason, 'Reason by ID');
            assert.strictEqual(t2.stage, 'build');

            // 3. Match by TrackKey (Title + Artist) when URI and ID differ (relinked track)
            const t3 = dj.enrichTrackWithCachedMetadata(makeTrack({
                id: 'relinked_id',
                name: 'Ocean Walk (Remastered 2026)',
                uri: 'spotify:track:relinked_uri',
                artistName: 'Artist3',
            }));
            assert.strictEqual(t3.selectionReason, 'Reason by TrackKey');
            assert.strictEqual(t3.stage, 'peak');
        });

        it('advances Up Next dynamically as currently playing track changes', async () => {
            const sessionTracks = [
                makeTrack({ id: 't1', uri: 'spotify:track:1', name: 'Song 1', artistName: 'Art 1', selectionReason: 'Reason 1' }),
                makeTrack({ id: 't2', uri: 'spotify:track:2', name: 'Song 2', artistName: 'Art 2', selectionReason: 'Reason 2' }),
                makeTrack({ id: 't3', uri: 'spotify:track:3', name: 'Song 3', artistName: 'Art 3', selectionReason: 'Reason 3' }),
                makeTrack({ id: 't4', uri: 'spotify:track:4', name: 'Song 4', artistName: 'Art 4', selectionReason: 'Reason 4' }),
            ];
            store['dj_current_session_tracks'] = JSON.stringify(sessionTracks);

            const dj = new DJCore('fake_token');
            const djInternal = dj as unknown as { spotify: { getGeneric: () => Promise<unknown> } };
            djInternal.spotify.getGeneric = async () => ({ queue: [] });

            // Case 1: Currently playing Song 1 (index 0) -> Up Next should be [Song 2, Song 3, Song 4]
            const queueAtSong1 = await dj.getQueue(sessionTracks[0]);
            assert.strictEqual(queueAtSong1.length, 3);
            assert.strictEqual(queueAtSong1[0].name, 'Song 2');
            assert.strictEqual(queueAtSong1[0].selectionReason, 'Reason 2');
            assert.strictEqual(queueAtSong1[1].name, 'Song 3');

            // Case 2: Track advances to Song 2 (index 1) -> Up Next should dynamically advance to [Song 3, Song 4]
            const queueAtSong2 = await dj.getQueue(sessionTracks[1]);
            assert.strictEqual(queueAtSong2.length, 2);
            assert.strictEqual(queueAtSong2[0].name, 'Song 3');
            assert.strictEqual(queueAtSong2[0].selectionReason, 'Reason 3');
            assert.strictEqual(queueAtSong2[1].name, 'Song 4');

            // Case 3: Track advances to Song 3 (index 2) -> Up Next should dynamically advance to [Song 4]
            const queueAtSong3 = await dj.getQueue(sessionTracks[2]);
            assert.strictEqual(queueAtSong3.length, 1);
            assert.strictEqual(queueAtSong3[0].name, 'Song 4');
            assert.strictEqual(queueAtSong3[0].selectionReason, 'Reason 4');
        });

        it('advances Up Next accurately even when Spotify API returns a lagging/stale queue', async () => {
            const sessionTracks = [
                makeTrack({ id: 's1', uri: 'spotify:track:s1', name: 'Song 1', artistName: 'Artist 1', selectionReason: 'Reason 1' }),
                makeTrack({ id: 's2', uri: 'spotify:track:s2', name: 'Song 2', artistName: 'Artist 2', selectionReason: 'Reason 2' }),
                makeTrack({ id: 's3', uri: 'spotify:track:s3', name: 'Song 3', artistName: 'Artist 3', selectionReason: 'Reason 3' }),
            ];
            store['dj_current_session_tracks'] = JSON.stringify(sessionTracks);

            const dj = new DJCore('fake_token');
            const djInternal = dj as unknown as { spotify: { getGeneric: () => Promise<unknown> } };
            djInternal.spotify.getGeneric = async () => ({
                currently_playing: sessionTracks[1],
                queue: [
                    { id: 's2', uri: 'spotify:track:s2', name: 'Song 2', type: 'track' },
                    { id: 's3', uri: 'spotify:track:s3', name: 'Song 3', type: 'track' }
                ]
            });

            // Currently playing Song 2 -> Up Next MUST advance to Song 3, NOT show Song 2 at index 0!
            const upcoming = await dj.getQueue(sessionTracks[1]);
            assert.strictEqual(upcoming.length, 1);
            assert.strictEqual(upcoming[0].name, 'Song 3');
            assert.strictEqual(upcoming[0].selectionReason, 'Reason 3');
        });

        it('uses Spotify live queue when available from API and enriches with metadata', async () => {
            store['dj_track_metadata_cache'] = JSON.stringify({
                'spotify:track:q1': { selectionReason: 'Reason for Q1', vibeTag: '#Chill' },
                'spotify:track:q2': { selectionReason: 'Reason for Q2', vibeTag: '#Energy' }
            });

            const dj = new DJCore('fake_token');
            const realSpotifyQueue = [
                { id: 'q1', uri: 'spotify:track:q1', name: 'Track Q1', artists: [{ name: 'Artist 1' }], type: 'track' },
                { id: 'q2', uri: 'spotify:track:q2', name: 'Track Q2', artists: [{ name: 'Artist 2' }], type: 'track' },
            ];
            const djInternal = dj as unknown as { spotify: { getGeneric: () => Promise<unknown> } };
            djInternal.spotify.getGeneric = async () => ({ queue: realSpotifyQueue });

            const queue = await dj.getQueue();
            assert.strictEqual(queue.length, 2);
            assert.strictEqual(queue[0].name, 'Track Q1');
            assert.strictEqual(queue[0].selectionReason, 'Reason for Q1');
            assert.strictEqual(queue[0].vibeTag, '#Chill');
            assert.strictEqual(queue[1].name, 'Track Q2');
            assert.strictEqual(queue[1].selectionReason, 'Reason for Q2');
        });

        it('restores selectionReason via currentSessionTracks and fuzzy title match on reload when cache is missing', async () => {
            const sessionTracks = [
                makeTrack({
                    id: 'original_id',
                    uri: 'spotify:track:orig_uri',
                    name: 'Sunset Cruise',
                    artistName: 'City Pop Band',
                    selectionReason: '夕暮れの爽快なムードにぴったりの名曲。',
                    vibeTag: '#夕暮れドライブ',
                    stage: 'build'
                })
            ];
            store['dj_current_session_tracks'] = JSON.stringify(sessionTracks);

            const dj = new DJCore('fake_token');

            const rawSpotifyTrack = makeTrack({
                id: 'relinked_different_id',
                uri: 'spotify:track:relinked_different_uri',
                name: 'Sunset Cruise - 2026 Remaster',
                artistName: 'City Pop Band',
            });

            const enriched = dj.enrichTrackWithCachedMetadata(rawSpotifyTrack);

            assert.strictEqual(enriched.selectionReason, '夕暮れの爽快なムードにぴったりの名曲。');
            assert.strictEqual(enriched.vibeTag, '#夕暮れドライブ');
            assert.strictEqual(enriched.stage, 'build');
        });

        it('returns new session upcoming tracks immediately even when activeTrack lags behind', async () => {
            const dj = new DJCore('fake_token');
            const newTracks: Track[] = [
                makeTrack({ id: 'track_1', uri: 'spotify:track:1', name: 'New Track 1', artistName: 'New Artist' }),
                makeTrack({ id: 'track_2', uri: 'spotify:track:2', name: 'New Track 2', artistName: 'New Artist' }),
                makeTrack({ id: 'track_3', uri: 'spotify:track:3', name: 'New Track 3', artistName: 'New Artist' }),
            ];

            const djInternal = dj as unknown as {
                currentSessionTracks: Track[];
                lastPlayTime: number;
            };
            djInternal.currentSessionTracks = newTracks;
            djInternal.lastPlayTime = Date.now();

            const oldTrack = makeTrack({ id: 'old_0', uri: 'spotify:track:old', name: 'Old Stale Song', artistName: 'Old Artist' });
            const upcoming = await dj.getQueue(oldTrack);

            assert.strictEqual(upcoming.length, 2);
            assert.strictEqual(upcoming[0].id, 'track_2');
            assert.strictEqual(upcoming[1].id, 'track_3');
        });
    });
});

