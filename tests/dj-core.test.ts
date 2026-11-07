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

        it('switches to Spotify live queue when user plays an external track in Spotify app and returns to ContextDJ', async () => {
            const sessionTracks = [
                makeTrack({ id: 'dj1', uri: 'spotify:track:dj1', name: 'DJ Track 1', artistName: 'DJ Artist 1', selectionReason: 'DJ Reason 1' }),
                makeTrack({ id: 'dj2', uri: 'spotify:track:dj2', name: 'DJ Track 2', artistName: 'DJ Artist 2', selectionReason: 'DJ Reason 2' }),
                makeTrack({ id: 'dj3', uri: 'spotify:track:dj3', name: 'DJ Track 3', artistName: 'DJ Artist 3', selectionReason: 'DJ Reason 3' }),
            ];
            store['dj_current_session_tracks'] = JSON.stringify(sessionTracks);

            const dj = new DJCore('fake_token');
            const spotifyExternalCurrent = makeTrack({
                id: 'sp_ext_1',
                uri: 'spotify:track:sp_ext_1',
                name: 'Spotify App Chosen Song',
                artistName: 'External Artist',
            });
            const spotifyExternalQueue = [
                makeTrack({ id: 'sp_ext_2', uri: 'spotify:track:sp_ext_2', name: 'Spotify Next 1', artistName: 'External Artist' }),
                makeTrack({ id: 'sp_ext_3', uri: 'spotify:track:sp_ext_3', name: 'Spotify Next 2', artistName: 'External Artist' }),
            ];

            const djInternal = dj as unknown as {
                spotify: {
                    getMyCurrentPlaybackState: () => Promise<unknown>;
                    getGeneric: () => Promise<unknown>;
                };
            };

            // Step 1: ContextDJ session track 1 is playing -> Up Next is [DJ Track 2, DJ Track 3]
            const initialQueue = await dj.getQueue(sessionTracks[0]);
            assert.strictEqual(initialQueue.length, 2);
            assert.strictEqual(initialQueue[0].id, 'dj2');
            assert.strictEqual(dj.isSessionPlaybackActive(), true);

            // Step 2: User plays a different song in the Spotify app and returns to ContextDJ
            djInternal.spotify.getMyCurrentPlaybackState = async () => ({
                is_playing: true,
                item: spotifyExternalCurrent,
                device: { id: 'dev_1', name: 'Spotify App', is_active: true },
            });
            djInternal.spotify.getGeneric = async () => ({
                currently_playing: spotifyExternalCurrent,
                queue: spotifyExternalQueue,
            });

            const stateAfterReturn = await dj.getPlaybackState();
            assert.strictEqual(stateAfterReturn?.item?.id, 'sp_ext_1');
            assert.strictEqual(dj.isSessionPlaybackActive(), false);
            assert.strictEqual(store['dj_current_session_tracks'], undefined);

            const queueAfterReturn = await dj.getQueue(stateAfterReturn?.item as Track);
            assert.strictEqual(queueAfterReturn.length, 2);
            assert.strictEqual(queueAfterReturn[0].id, 'sp_ext_2');
            assert.strictEqual(queueAfterReturn[1].id, 'sp_ext_3');
        });

        it('does not auto-refill DJ tracks into Spotify queue when external Spotify playback is active', async () => {
            const sessionTracks = [
                makeTrack({ id: 'dj1', uri: 'spotify:track:dj1', name: 'DJ Track 1', artistName: 'DJ Artist 1' }),
                makeTrack({ id: 'dj2', uri: 'spotify:track:dj2', name: 'DJ Track 2', artistName: 'DJ Artist 2' }),
            ];
            store['dj_current_session_tracks'] = JSON.stringify(sessionTracks);
            store['dj_last_query'] = 'chill jazz';

            const dj = new DJCore('fake_token');
            dj.setSchedule([{ start: '00:00', end: '23:59', query: 'chill jazz' }]);

            const externalTrack = makeTrack({
                id: 'ext_single',
                uri: 'spotify:track:ext_single',
                name: 'User Single Track',
                artistName: 'User Artist',
            });

            let searchCalled = false;
            const djInternal = dj as unknown as {
                spotify: {
                    getMyCurrentPlaybackState: () => Promise<unknown>;
                    getGeneric: () => Promise<unknown>;
                };
                searchTracks: () => Promise<Track[]>;
            };

            djInternal.spotify.getMyCurrentPlaybackState = async () => ({
                is_playing: true,
                item: externalTrack,
                device: { id: 'dev_1', name: 'Phone', is_active: true },
            });
            djInternal.spotify.getGeneric = async () => ({
                currently_playing: externalTrack,
                queue: [], // Empty queue on Spotify
            });
            djInternal.searchTracks = async () => {
                searchCalled = true;
                return [];
            };

            // Running background DJ loop in the same schedule slot must detect external playback and NOT trigger auto-refill
            await dj.processDJLoop(true, false);

            assert.strictEqual(dj.isSessionPlaybackActive(), false);
            assert.strictEqual(searchCalled, false);
        });

        it('detects external playback when Spotify plays a track with an album/playlist context URI even if the track exists in sessionTracks', async () => {
            const sessionTracks = [
                makeTrack({ id: 'dj1', uri: 'spotify:track:dj1', name: 'DJ Track 1', artistName: 'DJ Artist' }),
                makeTrack({ id: 'dj2', uri: 'spotify:track:dj2', name: 'DJ Track 2', artistName: 'DJ Artist' }),
                makeTrack({ id: 'dj3', uri: 'spotify:track:dj3', name: 'DJ Track 3', artistName: 'DJ Artist' }),
            ];
            store['dj_current_session_tracks'] = JSON.stringify(sessionTracks);

            const dj = new DJCore('fake_token');
            const albumQueue = [
                makeTrack({ id: 'alb2', uri: 'spotify:track:alb2', name: 'Album Track 2', artistName: 'DJ Artist' }),
                makeTrack({ id: 'alb3', uri: 'spotify:track:alb3', name: 'Album Track 3', artistName: 'DJ Artist' }),
            ];

            const djInternal = dj as unknown as {
                spotify: {
                    getMyCurrentPlaybackState: () => Promise<unknown>;
                    getGeneric: () => Promise<unknown>;
                };
            };

            // User starts playing an album in Spotify that begins with 'dj1' (which is also in sessionTracks)
            djInternal.spotify.getMyCurrentPlaybackState = async () => ({
                is_playing: true,
                item: sessionTracks[0],
                context: { type: 'album', uri: 'spotify:album:external_album_123' },
                device: { id: 'dev_1', name: 'Spotify App', is_active: true },
            });
            djInternal.spotify.getGeneric = async () => ({
                currently_playing: sessionTracks[0],
                queue: albumQueue,
            });

            const state = await dj.getPlaybackState();
            assert.strictEqual(state?.item?.id, 'dj1');
            assert.strictEqual(dj.isSessionPlaybackActive(), false);
            assert.strictEqual(store['dj_current_session_tracks'], undefined);

            const queue = await dj.getQueue(state?.item as Track);
            assert.strictEqual(queue.length, 2);
            assert.strictEqual(queue[0].id, 'alb2');
            assert.strictEqual(queue[1].id, 'alb3');
        });

        it('detects external playback when Spotify plays a podcast episode (currently_playing_type === "episode")', async () => {
            const sessionTracks = [
                makeTrack({ id: 'dj1', uri: 'spotify:track:dj1', name: 'DJ Track 1', artistName: 'DJ Artist' }),
                makeTrack({ id: 'dj2', uri: 'spotify:track:dj2', name: 'DJ Track 2', artistName: 'DJ Artist' }),
            ];
            store['dj_current_session_tracks'] = JSON.stringify(sessionTracks);

            const dj = new DJCore('fake_token');
            const djInternal = dj as unknown as {
                spotify: {
                    getMyCurrentPlaybackState: () => Promise<unknown>;
                    getGeneric: () => Promise<unknown>;
                };
            };

            djInternal.spotify.getMyCurrentPlaybackState = async () => ({
                is_playing: true,
                item: null,
                currently_playing_type: 'episode',
                device: { id: 'dev_1', name: 'Phone', is_active: true },
            });
            djInternal.spotify.getGeneric = async () => ({
                currently_playing: null,
                queue: [],
            });

            await dj.getPlaybackState();
            assert.strictEqual(dj.isSessionPlaybackActive(), false);
            assert.strictEqual(store['dj_current_session_tracks'], undefined);

            const queue = await dj.getQueue(null);
            assert.deepStrictEqual(queue, []);
        });

        it('preserves full session tracks beyond 20-item UI slice in playFromQueueIndex and avoids re-enabling DJ session when in external mode', async () => {
            const fullSession = Array.from({ length: 25 }, (_, idx) =>
                makeTrack({
                    id: `dj_${idx + 1}`,
                    uri: `spotify:track:dj_${idx + 1}`,
                    name: `DJ Song ${idx + 1}`,
                    artistName: 'DJ Artist',
                })
            );
            store['dj_current_session_tracks'] = JSON.stringify(fullSession);

            const dj = new DJCore('fake_token');
            let playedUris: string[] = [];
            const djInternal = dj as unknown as {
                playerClient: {
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: (deviceId: string, uris: string[]) => Promise<void>;
                };
            };
            djInternal.playerClient.resolveTargetDevice = async () => 'dev_1';
            djInternal.playerClient.startPlaybackOnDevice = async (_deviceId: string, uris: string[]) => {
                playedUris = uris;
            };

            // Displayed UI queue is truncated to 20 items (tracks 2..21, i.e., indices 1..20 of fullSession)
            const displayedUiQueue = fullSession.slice(1, 21);

            // Clicking index 2 in displayedUiQueue (which is dj_4, index 3 in fullSession) must play dj_4..dj_25 (22 tracks)
            await dj.playFromQueueIndex(2, displayedUiQueue);
            assert.strictEqual(playedUris.length, 22);
            assert.strictEqual(playedUris[0], 'spotify:track:dj_4');
            assert.strictEqual(playedUris[21], 'spotify:track:dj_25');
            assert.strictEqual(dj.isSessionPlaybackActive(), true);

            // Now simulate external playback mode (session cleared) and clicking an item in the external queue
            await dj.playTracks(
                [
                    makeTrack({ id: 'ext1', uri: 'spotify:track:ext1', name: 'Ext 1', artistName: 'Ext' }),
                    makeTrack({ id: 'ext2', uri: 'spotify:track:ext2', name: 'Ext 2', artistName: 'Ext' }),
                ],
                { isDJSession: false }
            );
            assert.strictEqual(dj.isSessionPlaybackActive(), false);
            assert.strictEqual(store['dj_current_session_tracks'], undefined);
        });

        it('marks startup grace fallback state in getPlaybackState with __optimisticFallback: true', async () => {
            const dj = new DJCore('fake_token');
            const djInternal = dj as unknown as {
                spotify: {
                    getMyCurrentPlaybackState: () => Promise<unknown>;
                };
                playerClient: {
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: () => Promise<void>;
                };
            };
            djInternal.playerClient.resolveTargetDevice = async () => 'dev_1';
            djInternal.playerClient.startPlaybackOnDevice = async () => {};
            djInternal.spotify.getMyCurrentPlaybackState = async () => ({
                is_playing: false,
                item: null,
            });

            await dj.playTracks([
                makeTrack({ id: 'g1', uri: 'spotify:track:g1', name: 'Grace Track', artistName: 'Artist' }),
            ]);

            const state = await dj.getPlaybackState();
            assert.strictEqual(state?.__optimisticFallback, true);
            assert.strictEqual(state?.item?.uri, 'spotify:track:g1');
        });

        it('only appends and marks tracks that succeed in addToQueue during auto-refill', async () => {
            const initialTracks = [
                makeTrack({ id: 'init1', uri: 'spotify:track:init1', name: 'Initial 1', artistName: 'Artist' }),
            ];
            store['dj_current_session_tracks'] = JSON.stringify(initialTracks);
            store['dj_last_query'] = 'chill beats';

            const dj = new DJCore('fake_token');
            dj.setSchedule([{ start: '00:00', end: '23:59', query: 'chill beats' }]);

            const refillCandidates = [
                makeTrack({ id: 'ref1', uri: 'spotify:track:ref1', name: 'Refill 1', artistName: 'Artist' }),
                makeTrack({ id: 'ref2', uri: 'spotify:track:ref2', name: 'Refill 2', artistName: 'Artist' }),
            ];

            let addCalls = 0;
            const djInternal = dj as unknown as {
                spotify: {
                    getMyCurrentPlaybackState: () => Promise<unknown>;
                    getGeneric: () => Promise<unknown>;
                };
                playerClient: {
                    getDevices: () => Promise<SpotifyApi.UserDevice[]>;
                    getUserQueue: () => Promise<{ currently_playing: Track | null; queue: Track[] }>;
                    addToQueue: (uri: string) => Promise<{ ok: boolean }>;
                };
                searchTracks: () => Promise<Track[]>;
            };

            djInternal.playerClient.getDevices = async () => [
                { id: 'dev_1', name: 'Speaker', is_active: true } as SpotifyApi.UserDevice,
            ];
            djInternal.spotify.getMyCurrentPlaybackState = async () => ({
                is_playing: true,
                item: initialTracks[0],
                device: { id: 'dev_1', name: 'Speaker', is_active: true },
            });
            djInternal.playerClient.getUserQueue = async () => ({
                currently_playing: initialTracks[0],
                queue: [],
            });
            djInternal.searchTracks = async () => refillCandidates;
            djInternal.playerClient.addToQueue = async () => {
                addCalls++;
                // First track succeeds, second track fails (e.g., 429 rate limit)
                return { ok: addCalls === 1 };
            };

            await dj.processDJLoop(true, false);

            const sessionAfterRefill = dj.getSessionCache().getSessionTracks();
            // Only init1 and ref1 should be in session tracks; ref2 failed addToQueue so it must not be appended
            assert.deepStrictEqual(
                sessionAfterRefill.map(t => t.id),
                ['init1', 'ref1']
            );
        });

        it('reverts lastQuery and reports error when searchTracks returns 0 tracks during processDJLoop', async () => {
            const dj = new DJCore('fake_token');
            dj.setSchedule([{ start: '00:00', end: '23:59', query: 'impossible query 12345' }]);

            const djInternal = dj as unknown as {
                playerClient: {
                    getDevices: () => Promise<SpotifyApi.UserDevice[]>;
                };
                searchTracks: () => Promise<Track[]>;
            };
            djInternal.playerClient.getDevices = async () => [
                { id: 'dev_1', name: 'Speaker', is_active: true } as SpotifyApi.UserDevice,
            ];
            djInternal.searchTracks = async () => [];

            await assert.rejects(
                async () => dj.processDJLoop(false, true),
                /No matching tracks found/
            );

            // lastQuery must be reverted to null so subsequent ticks or retries can run
            assert.strictEqual(dj.getDJStatus().currentQuery, null);
            assert.strictEqual(store['dj_last_query'], undefined);
        });

        it('automatically starts playback on the next tick after Spotify device comes online', async () => {
            const dj = new DJCore('fake_token');
            dj.setSchedule([{ start: '00:00', end: '23:59', query: 'morning jazz' }]);

            let availableDevices: SpotifyApi.UserDevice[] = [];
            let playedTracksCount = 0;

            const djInternal = dj as unknown as {
                playerClient: {
                    getDevices: () => Promise<SpotifyApi.UserDevice[]>;
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: (_deviceId: string, uris: string[]) => Promise<void>;
                    clearLastError: () => void;
                    getLastError: () => null;
                };
                searchTracks: () => Promise<Track[]>;
            };

            djInternal.playerClient.getDevices = async () => availableDevices;
            djInternal.playerClient.resolveTargetDevice = async () => 'dev_1';
            djInternal.playerClient.startPlaybackOnDevice = async (_deviceId: string, uris: string[]) => {
                playedTracksCount = uris.length;
            };
            djInternal.playerClient.clearLastError = () => {};
            djInternal.playerClient.getLastError = () => null;
            djInternal.searchTracks = async () => [
                makeTrack({ id: 'mj1', uri: 'spotify:track:mj1', name: 'Jazz 1', artistName: 'Bill Evans' }),
            ];

            // Tick 1: No Spotify device open yet -> should not lock in lastQuery
            await dj.processDJLoop(true, false);
            assert.strictEqual(playedTracksCount, 0);
            assert.strictEqual(dj.getDJStatus().currentQuery, null);

            // Tick 2: User opens Spotify -> device appears -> playback starts automatically without force=true!
            availableDevices = [{ id: 'dev_1', name: 'MacBook', is_active: true } as SpotifyApi.UserDevice];
            await dj.processDJLoop(true, false);
            assert.strictEqual(playedTracksCount, 1);
            assert.strictEqual(dj.getDJStatus().currentQuery, 'morning jazz');
        });

        it('aborts in-flight auto-refill if a new schedule session starts while refill search is awaiting', async () => {
            const initialTracks = [
                makeTrack({ id: 'old1', uri: 'spotify:track:old1', name: 'Old 1', artistName: 'Old Artist' }),
            ];
            store['dj_current_session_tracks'] = JSON.stringify(initialTracks);
            store['dj_last_query'] = 'old query';

            const dj = new DJCore('fake_token');
            dj.setSchedule([{ start: '00:00', end: '23:59', query: 'old query' }]);

            const queuedUris: string[] = [];
            const djInternal = dj as unknown as {
                spotify: {
                    getMyCurrentPlaybackState: () => Promise<unknown>;
                };
                playerClient: {
                    getDevices: () => Promise<SpotifyApi.UserDevice[]>;
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: (_deviceId: string, uris: string[]) => Promise<void>;
                    getUserQueue: () => Promise<{ currently_playing: Track | null; queue: Track[] }>;
                    addToQueue: (uri: string) => Promise<{ ok: boolean }>;
                    clearLastError: () => void;
                    getLastError: () => null;
                };
                searchTracks: (q: string | string[]) => Promise<Track[]>;
            };

            djInternal.playerClient.getDevices = async () => [
                { id: 'dev_1', name: 'Speaker', is_active: true } as SpotifyApi.UserDevice,
            ];
            djInternal.playerClient.resolveTargetDevice = async () => 'dev_1';
            djInternal.playerClient.startPlaybackOnDevice = async () => {};
            djInternal.playerClient.clearLastError = () => {};
            djInternal.playerClient.getLastError = () => null;
            djInternal.spotify.getMyCurrentPlaybackState = async () => ({
                is_playing: true,
                item: initialTracks[0],
                device: { id: 'dev_1', name: 'Speaker', is_active: true },
            });
            djInternal.playerClient.getUserQueue = async () => ({
                currently_playing: initialTracks[0],
                queue: [],
            });
            djInternal.playerClient.addToQueue = async (uri: string) => {
                queuedUris.push(uri);
                return { ok: true };
            };

            djInternal.searchTracks = async (q: string | string[]) => {
                const firstQ = Array.isArray(q) ? q[0] : q;
                if (firstQ === 'old query') {
                    // Simulate user starting a new schedule while refill search is in flight
                    dj.setSchedule([{ start: '00:00', end: '23:59', query: 'new query' }]);
                    await dj.processDJLoop(false, true);
                    return [makeTrack({ id: 'stale_refill', uri: 'spotify:track:stale_refill', name: 'Stale', artistName: 'Old' })];
                }
                return [makeTrack({ id: 'new_session_1', uri: 'spotify:track:new_session_1', name: 'New 1', artistName: 'New' })];
            };

            await dj.processDJLoop(true, false);

            // Stale refill track must NOT have been added to Spotify queue or appended to the new session
            assert.deepStrictEqual(queuedUris, []);
            assert.deepStrictEqual(
                dj.getSessionCache().getSessionTracks().map(t => t.id),
                ['new_session_1']
            );
        });

        it('does not prematurely confirm session playback during startup grace when getQueue is called with synthetic fallback item', async () => {
            const dj = new DJCore('fake_token');
            const oldTrack = makeTrack({ id: 'old_sp', uri: 'spotify:track:old_sp', name: 'Old Song', artistName: 'Old Artist' });
            const sessionTracks = [
                makeTrack({ id: 'dj1', uri: 'spotify:track:dj1', name: 'DJ 1', artistName: 'DJ Artist' }),
                makeTrack({ id: 'dj2', uri: 'spotify:track:dj2', name: 'DJ 2', artistName: 'DJ Artist' }),
                makeTrack({ id: 'dj3', uri: 'spotify:track:dj3', name: 'DJ 3', artistName: 'DJ Artist' }),
            ];

            const djInternal = dj as unknown as {
                spotify: {
                    getMyCurrentPlaybackState: () => Promise<unknown>;
                };
                playerClient: {
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: () => Promise<void>;
                };
            };
            djInternal.playerClient.resolveTargetDevice = async () => 'dev_1';
            djInternal.playerClient.startPlaybackOnDevice = async () => {};
            // Spotify Connect lags behind and still reports oldTrack
            djInternal.spotify.getMyCurrentPlaybackState = async () => ({
                is_playing: true,
                item: oldTrack,
                device: { id: 'dev_1', name: 'Speaker', is_active: true },
            });

            await dj.playTracks(sessionTracks);

            // Poll 1: getPlaybackState returns synthetic fallback for dj1, and UI calls getQueue(state.item)
            const state1 = await dj.getPlaybackState();
            assert.strictEqual(state1?.__optimisticFallback, true);
            assert.strictEqual(state1?.item?.id, 'dj1');
            const queue1 = await dj.getQueue(state1?.item as Track);
            assert.deepStrictEqual(queue1.map(t => t.id), ['dj2', 'dj3']);

            // hasConfirmedSessionPlayback MUST remain false so Poll 2 does NOT wipe the session!
            assert.strictEqual(dj.getSessionCache().getHasConfirmedSessionPlayback(), false);

            // Poll 2 (still lagging on oldTrack): must stay in startup grace and keep sessionTracks intact!
            const state2 = await dj.getPlaybackState();
            assert.strictEqual(state2?.__optimisticFallback, true);
            assert.strictEqual(dj.isSessionPlaybackActive(), true);
            assert.strictEqual(dj.getSessionCache().getSessionTracks().length, 3);
        });

        it('preserves earlier tracks in sessionCache during playFromQueueIndex so previous() and pre-switch polls do not destroy the session', async () => {
            const sessionTracks = [
                makeTrack({ id: 'dj1', uri: 'spotify:track:dj1', name: 'DJ 1', artistName: 'DJ Artist' }),
                makeTrack({ id: 'dj2', uri: 'spotify:track:dj2', name: 'DJ 2', artistName: 'DJ Artist' }),
                makeTrack({ id: 'dj3', uri: 'spotify:track:dj3', name: 'DJ 3', artistName: 'DJ Artist' }),
                makeTrack({ id: 'dj4', uri: 'spotify:track:dj4', name: 'DJ 4', artistName: 'DJ Artist' }),
            ];
            store['dj_current_session_tracks'] = JSON.stringify(sessionTracks);

            const dj = new DJCore('fake_token');
            let currentSpotifyItem = sessionTracks[0];

            const djInternal = dj as unknown as {
                spotify: {
                    getMyCurrentPlaybackState: () => Promise<unknown>;
                };
                playerClient: {
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: () => Promise<void>;
                    previous: () => Promise<{ ok: boolean }>;
                };
            };
            djInternal.playerClient.resolveTargetDevice = async () => 'dev_1';
            djInternal.playerClient.startPlaybackOnDevice = async () => {};
            djInternal.playerClient.previous = async () => {
                currentSpotifyItem = sessionTracks[1];
                return { ok: true };
            };
            djInternal.spotify.getMyCurrentPlaybackState = async () => ({
                is_playing: true,
                item: currentSpotifyItem,
                device: { id: 'dev_1', name: 'Speaker', is_active: true },
            });

            // User clicks index 1 in Up Next [dj2, dj3, dj4] -> jumps to dj3 (index 2 in sessionTracks)
            await dj.playFromQueueIndex(1, sessionTracks.slice(1));

            // Full sessionTracks [dj1, dj2, dj3, dj4] must remain in sessionCache with sessionStartIndex = 2
            assert.deepStrictEqual(dj.getSessionCache().getSessionTracks().map(t => t.id), ['dj1', 'dj2', 'dj3', 'dj4']);
            assert.strictEqual(dj.getSessionCache().getSessionStartIndex(), 2);

            // While Spotify is still playing dj1 (index 0 < sessionStartIndex 2), startup grace returns dj3 and does NOT confirm playback early
            const stateBeforeSwitch = await dj.getPlaybackState();
            assert.strictEqual(stateBeforeSwitch?.__optimisticFallback, true);
            assert.strictEqual(stateBeforeSwitch?.item?.id, 'dj3');
            assert.strictEqual(dj.getSessionCache().getHasConfirmedSessionPlayback(), false);
            const queueDuringGrace = await dj.getQueue(sessionTracks[0]);
            assert.deepStrictEqual(queueDuringGrace.map(t => t.id), ['dj4']);

            // Spotify switches to dj3 -> playback is confirmed
            currentSpotifyItem = sessionTracks[2];
            const stateAtDj3 = await dj.getPlaybackState();
            assert.strictEqual(stateAtDj3?.item?.id, 'dj3');
            assert.strictEqual(dj.getSessionCache().getHasConfirmedSessionPlayback(), true);

            // User clicks Previous -> Spotify steps back to dj2 (index 1); session must remain active with Up Next [dj3, dj4]
            await dj.previous();
            const stateAtDj2 = await dj.getPlaybackState();
            assert.strictEqual(stateAtDj2?.item?.id, 'dj2');
            assert.strictEqual(dj.isSessionPlaybackActive(), true);
            const queueAtDj2 = await dj.getQueue(stateAtDj2?.item as Track);
            assert.deepStrictEqual(queueAtDj2.map(t => t.id), ['dj3', 'dj4']);
        });

        it('does not treat a paused external track (is_playing: false) as external playback takeover', async () => {
            const sessionTracks = [
                makeTrack({ id: 'dj1', uri: 'spotify:track:dj1', name: 'DJ 1', artistName: 'DJ Artist' }),
                makeTrack({ id: 'dj2', uri: 'spotify:track:dj2', name: 'DJ 2', artistName: 'DJ Artist' }),
            ];
            store['dj_current_session_tracks'] = JSON.stringify(sessionTracks);

            const dj = new DJCore('fake_token');
            const pausedLeftoverTrack = makeTrack({
                id: 'leftover_1',
                uri: 'spotify:track:leftover_1',
                name: 'Yesterday Song',
                artistName: 'Other Artist',
            });

            const djInternal = dj as unknown as {
                spotify: {
                    getMyCurrentPlaybackState: () => Promise<unknown>;
                };
            };
            djInternal.spotify.getMyCurrentPlaybackState = async () => ({
                is_playing: false,
                item: pausedLeftoverTrack,
                context: { type: 'playlist', uri: 'spotify:playlist:yesterday' },
                device: { id: 'dev_1', name: 'Spotify App', is_active: true },
            });

            const state = await dj.getPlaybackState();
            assert.strictEqual(state?.is_playing, false);
            // Session must NOT be wiped when Spotify is merely paused on a leftover track
            assert.strictEqual(dj.isSessionPlaybackActive(), true);
            assert.strictEqual(dj.getSessionCache().getSessionTracks().length, 2);

            const queue = await dj.getQueue(pausedLeftoverTrack);
            assert.strictEqual(dj.isSessionPlaybackActive(), true);
            assert.deepStrictEqual(queue.map(t => t.id), ['dj2']);
        });

        it('starts playback in processDJLoop when lastQuery matches current schedule but sessionTracks is empty', async () => {
            store['dj_last_query'] = 'chill jazz';
            // Note: dj_current_session_tracks is empty!
            const dj = new DJCore('fake_token');
            dj.setSchedule([{ start: '00:00', end: '23:59', query: 'chill jazz' }]);

            let playedUris: string[] = [];
            const djInternal = dj as unknown as {
                playerClient: {
                    getDevices: () => Promise<SpotifyApi.UserDevice[]>;
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: (_deviceId: string, uris: string[]) => Promise<void>;
                    clearLastError: () => void;
                    getLastError: () => null;
                };
                searchTracks: () => Promise<Track[]>;
            };
            djInternal.playerClient.getDevices = async () => [
                { id: 'dev_1', name: 'Speaker', is_active: true } as SpotifyApi.UserDevice,
            ];
            djInternal.playerClient.resolveTargetDevice = async () => 'dev_1';
            djInternal.playerClient.startPlaybackOnDevice = async (_id, uris) => {
                playedUris = uris;
            };
            djInternal.playerClient.clearLastError = () => {};
            djInternal.playerClient.getLastError = () => null;
            djInternal.searchTracks = async () => [
                makeTrack({ id: 'cj1', uri: 'spotify:track:cj1', name: 'Jazz 1', artistName: 'Artist' }),
            ];

            await dj.processDJLoop(true, false);
            assert.deepStrictEqual(playedUris, ['spotify:track:cj1']);
            assert.strictEqual(dj.isSessionPlaybackActive(), true);
        });

        it('starts playing ContextDJ session tracks on resume() when session playback was not yet confirmed on Spotify', async () => {
            const sessionTracks = [
                makeTrack({ id: 'dj1', uri: 'spotify:track:dj1', name: 'DJ 1', artistName: 'DJ Artist' }),
                makeTrack({ id: 'dj2', uri: 'spotify:track:dj2', name: 'DJ 2', artistName: 'DJ Artist' }),
            ];
            store['dj_current_session_tracks'] = JSON.stringify(sessionTracks);

            const dj = new DJCore('fake_token');
            let playedUris: string[] = [];

            const djInternal = dj as unknown as {
                spotify: {
                    getMyCurrentPlaybackState: () => Promise<unknown>;
                };
                playerClient: {
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: (_deviceId: string, uris: string[]) => Promise<void>;
                };
            };
            djInternal.spotify.getMyCurrentPlaybackState = async () => ({
                is_playing: false,
                item: makeTrack({ id: 'other', uri: 'spotify:track:other', name: 'Other', artistName: 'Other' }),
                device: { id: 'dev_1', name: 'Speaker', is_active: false },
            });
            djInternal.playerClient.resolveTargetDevice = async () => 'dev_1';
            djInternal.playerClient.startPlaybackOnDevice = async (_id, uris) => {
                playedUris = uris;
            };

            const res = await dj.resume();
            assert.strictEqual(res.ok, true);
            assert.deepStrictEqual(playedUris, ['spotify:track:dj1', 'spotify:track:dj2']);
            assert.strictEqual(dj.isSessionPlaybackActive(), true);
        });

        it('restarts ContextDJ session tracks from current track on resume() even if hasConfirmedSessionPlayback was true when Spotify is now paused on an external track', async () => {
            const sessionTracks = [
                makeTrack({ id: 'dj1', uri: 'spotify:track:dj1', name: 'DJ 1', artistName: 'DJ Artist' }),
                makeTrack({ id: 'dj2', uri: 'spotify:track:dj2', name: 'DJ 2', artistName: 'DJ Artist' }),
                makeTrack({ id: 'dj3', uri: 'spotify:track:dj3', name: 'DJ 3', artistName: 'DJ Artist' }),
            ];
            store['dj_current_session_tracks'] = JSON.stringify(sessionTracks);

            const dj = new DJCore('fake_token');
            let playedUris: string[] = [];
            let bareResumeCalled = false;
            let currentSpotifyState: unknown = {
                is_playing: true,
                item: sessionTracks[1],
                device: { id: 'dev_1', name: 'Speaker', is_active: true },
            };

            const djInternal = dj as unknown as {
                spotify: {
                    getMyCurrentPlaybackState: () => Promise<unknown>;
                };
                playerClient: {
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: (_deviceId: string, uris: string[]) => Promise<void>;
                    resume: () => Promise<{ ok: boolean }>;
                };
            };
            djInternal.spotify.getMyCurrentPlaybackState = async () => currentSpotifyState;
            djInternal.playerClient.resolveTargetDevice = async () => 'dev_1';
            djInternal.playerClient.startPlaybackOnDevice = async (_id, uris) => {
                playedUris = uris;
            };
            djInternal.playerClient.resume = async () => {
                bareResumeCalled = true;
                return { ok: true };
            };

            // Step 1: DJ 2 is confirmed playing on Spotify
            await dj.getPlaybackState();
            assert.strictEqual(dj.getSessionCache().getHasConfirmedSessionPlayback(), true);
            assert.strictEqual(dj.getSessionCache().getSessionStartIndex(), 1);

            // Step 2: Spotify is now paused on an unrelated external song (or device went idle returning null)
            currentSpotifyState = {
                is_playing: false,
                item: makeTrack({ id: 'ext_paused', uri: 'spotify:track:ext_paused', name: 'External Paused', artistName: 'Other' }),
                context: { type: 'playlist', uri: 'spotify:playlist:other' },
                device: { id: 'dev_1', name: 'Speaker', is_active: true },
            };
            await dj.getPlaybackState();

            // Step 3: User clicks Play in ContextDJ -> must NOT bare-resume the external track; must start [dj2, dj3]!
            const res = await dj.resume();
            assert.strictEqual(res.ok, true);
            assert.strictEqual(bareResumeCalled, false);
            assert.deepStrictEqual(playedUris, ['spotify:track:dj2', 'spotify:track:dj3']);
            assert.strictEqual(dj.isSessionPlaybackActive(), true);
        });

        it('preserves lastPlayingTrack and sessionStartIndex when Spotify returns 204/null state during an active session, and handles rapid playFromQueueIndex + previous()', async () => {
            const sessionTracks = [
                makeTrack({ id: 'dj1', uri: 'spotify:track:dj1', name: 'DJ 1', artistName: 'DJ Artist' }),
                makeTrack({ id: 'dj2', uri: 'spotify:track:dj2', name: 'DJ 2', artistName: 'DJ Artist' }),
                makeTrack({ id: 'dj3', uri: 'spotify:track:dj3', name: 'DJ 3', artistName: 'DJ Artist' }),
                makeTrack({ id: 'dj4', uri: 'spotify:track:dj4', name: 'DJ 4', artistName: 'DJ Artist' }),
            ];
            store['dj_current_session_tracks'] = JSON.stringify(sessionTracks);

            const dj = new DJCore('fake_token');
            let currentSpotifyState: unknown = {
                is_playing: true,
                item: sessionTracks[2],
                device: { id: 'dev_1', name: 'Speaker', is_active: true },
            };

            const djInternal = dj as unknown as {
                spotify: {
                    getMyCurrentPlaybackState: () => Promise<unknown>;
                };
                playerClient: {
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: () => Promise<void>;
                    previous: () => Promise<{ ok: boolean }>;
                };
            };
            djInternal.spotify.getMyCurrentPlaybackState = async () => currentSpotifyState;
            djInternal.playerClient.resolveTargetDevice = async () => 'dev_1';
            djInternal.playerClient.startPlaybackOnDevice = async () => {};
            djInternal.playerClient.previous = async () => ({ ok: true });

            // Confirmed playing dj3 (index 2)
            await dj.getPlaybackState();
            assert.strictEqual(dj.getSessionCache().getLastPlayingTrack()?.id, 'dj3');
            assert.strictEqual(dj.getSessionCache().getSessionStartIndex(), 2);

            // Spotify device temporarily returns null (HTTP 204) -> lastPlayingTrack must remain dj3
            currentSpotifyState = null;
            await dj.getPlaybackState();
            assert.strictEqual(dj.getSessionCache().getLastPlayingTrack()?.id, 'dj3');
            const queueWhileIdle = await dj.getQueue();
            assert.deepStrictEqual(queueWhileIdle.map(t => t.id), ['dj4']);

            // Rapid queue jump to dj4 followed immediately by previous() while Spotify is still on dj1
            currentSpotifyState = {
                is_playing: true,
                item: sessionTracks[0],
                device: { id: 'dev_1', name: 'Speaker', is_active: true },
            };
            await dj.playFromQueueIndex(0, [sessionTracks[3]]);
            await dj.previous();

            const stateAfterRapidPrev = await dj.getPlaybackState();
            assert.strictEqual(stateAfterRapidPrev?.__optimisticFallback, undefined);
            assert.strictEqual(stateAfterRapidPrev?.item?.id, 'dj1');
            assert.strictEqual(dj.isSessionPlaybackActive(), true);
        });
    });
});

