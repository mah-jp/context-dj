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
        it('limits process log to 100 entries in newest-first order and notifies log listeners', () => {
            const dj = new DJCore('fake_token');
            let latestNotifiedLogs: string[] = [];
            const unsubscribe = dj.subscribeLogs((logs) => {
                latestNotifiedLogs = logs;
            });

            const djInternal = dj as unknown as { addLog: (msg: string) => void };
            for (let i = 1; i <= 105; i++) {
                djInternal.addLog(`Log entry #${i}`);
            }

            const logs = dj.getProcessLog();
            assert.strictEqual(logs.length, 100);
            assert.match(logs[0], /Log entry #105$/);
            assert.match(logs[99], /Log entry #6$/);
            assert.strictEqual(latestNotifiedLogs.length, 100);
            assert.match(latestNotifiedLogs[0], /Log entry #105$/);

            unsubscribe();
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

        it('snaps LLM clock-rounding drift (<= 60m) for immediate mood prompts while preserving explicit future start times', async () => {
            const dj = new DJCore('fake_token');
            const now = new Date();
            const plus5 = new Date(now.getTime() + 5 * 60_000);
            const plus40 = new Date(now.getTime() + 40 * 60_000);
            const plus90 = new Date(now.getTime() + 90 * 60_000);
            const plus180 = new Date(now.getTime() + 180 * 60_000);
            const fmt = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            const nowStr = fmt(now);
            const plus5Str = fmt(plus5);
            const plus40Str = fmt(plus40);
            const plus90Str = fmt(plus90);
            const plus180Str = fmt(plus180);

            let mockGenerated: ScheduleItem[] = [];
            (dj as unknown as { ai: { generateSchedule: () => Promise<ScheduleItem[]> } }).ai = {
                generateSchedule: async () => mockGenerated.map(item => ({ ...item })),
            };

            // Case 1: AI rounds current time 40 minutes ahead (e.g. 14:20 -> 15:00) for an immediate mood request -> snaps to nowStr
            mockGenerated = [{ start: plus40Str, end: plus180Str, query: 'ocean walk', queries: ['ocean walk'] }];
            const snapped = await dj.createSchedule('海を散歩したい気分に合う音楽を');
            assert.strictEqual(snapped[0].start, nowStr);

            // Case 2: User explicitly requested that start time (even within 5m) -> preserved!
            mockGenerated = [{ start: plus5Str, end: plus180Str, query: 'piano jazz', queries: ['piano jazz'] }];
            const explicitNear = await dj.createSchedule(`${plus5Str}からピアノのJazzを聴きたい`);
            assert.strictEqual(explicitNear[0].start, plus5Str);

            // Case 3: Deferred keyword ("今夜") 40m ahead -> preserved!
            mockGenerated = [{ start: plus40Str, end: plus180Str, query: 'night jazz', queries: ['night jazz'] }];
            const deferredTonight = await dj.createSchedule('今夜はピアノのJazzを聴きたい');
            assert.strictEqual(deferredTonight[0].start, plus40Str);

            // Case 4: Future schedule block 90 minutes ahead -> preserved!
            mockGenerated = [{ start: plus90Str, end: plus180Str, query: 'late night jazz', queries: ['late night jazz'] }];
            const futurePreserved = await dj.createSchedule('23時からはピアノのJazzを聴きたい');
            assert.strictEqual(futurePreserved[0].start, plus90Str);

            // Case 5: Multi-block prompt containing "今夜" or a later hour whose suffix matches Block 0's 12h digit
            // MUST still snap Block 0 to nowStr while preserving Block 1's future start!
            mockGenerated = [
                { start: plus40Str, end: '23:00', query: 'ocean walk', queries: ['ocean walk'] },
                { start: '23:00', end: '01:00', query: 'piano jazz', queries: ['piano jazz'] },
            ];
            const multiWithTonight = await dj.createSchedule('海を散歩したい気分に合う音楽を。今夜23時からはピアノのJazzを聴きたいです。');
            assert.strictEqual(multiWithTonight[0].start, nowStr);
            assert.strictEqual(multiWithTonight[1].start, '23:00');
        });

        it('stands by for >12h future reservations, clears matching stale lastQuery, and resets standby status when items are removed', async () => {
            const dj = new DJCore('fake_token');
            const now = new Date();
            const fmt = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            // 14 hours in the future (840m > 720m), triggering the exact >12h wraparound case
            const plus14h = new Date(now.getTime() + 14 * 60 * 60_000);
            const plus15h = new Date(now.getTime() + 15 * 60 * 60_000);
            const plus16h = new Date(now.getTime() + 16 * 60 * 60_000);

            // Seed a stale lastQuery that happens to match the upcoming block's signature
            store['dj_last_query'] = 'piano jazz';
            (dj as unknown as { lastQuery: string | null }).lastQuery = 'piano jazz';

            (dj as unknown as { ai: { generateSchedule: () => Promise<ScheduleItem[]> } }).ai = {
                generateSchedule: async () => [
                    { start: fmt(plus14h), end: fmt(plus15h), query: 'piano jazz', queries: ['piano jazz'] },
                    { start: fmt(plus15h), end: fmt(plus16h), query: 'midnight ambient', queries: ['midnight ambient'] },
                ],
            };

            let searchCalls = 0;
            (dj as unknown as { searchTracks: () => Promise<Track[]> }).searchTracks = async () => {
                searchCalls++;
                return [];
            };

            await dj.createSchedule(`${fmt(plus14h)}からはピアノのJazzを聴きたいです`);
            // Stale matching lastQuery must be cleared while waiting for schedule start
            assert.strictEqual(dj.getDJStatus().currentQuery, null);
            assert.strictEqual(store['dj_last_query'], undefined);

            await dj.processDJLoop(false, true);
            assert.strictEqual(searchCalls, 0);
            assert.strictEqual(
                dj.getStateSnapshot().status,
                `⏰ Waiting for ${fmt(plus14h)}... (${fmt(plus14h)}の開始を待機中...)`
            );

            // Removing the first waiting block immediately updates standby status to the second block's start time
            dj.removeScheduleItem(0, true);
            assert.strictEqual(
                dj.getStateSnapshot().status,
                `⏰ Waiting for ${fmt(plus15h)}... (${fmt(plus15h)}の開始を待機中...)`
            );

            // Removing the last remaining waiting block resets status cleanly back to 'Ready'
            dj.removeScheduleItem(0, true);
            assert.strictEqual(dj.getStateSnapshot().status, 'Ready');
        });

        it('stands by without premature playback for future-start schedules, preloads 60s before start, and plays on time', async () => {
            const dj = new DJCore('fake_token');
            const now = new Date();
            const fmt = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            const plus10 = new Date(now.getTime() + 10 * 60_000);
            const plus120 = new Date(now.getTime() + 120 * 60_000);

            let searchCalls = 0;
            let playedUris: string[] = [];

            const djInternal = dj as unknown as {
                playerClient: {
                    getDevices: () => Promise<SpotifyApi.UserDevice[]>;
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: (_id: string, uris: string[]) => Promise<void>;
                    clearLastError: () => void;
                    getLastError: () => null;
                };
                searchTracks: () => Promise<Track[]>;
            };
            djInternal.playerClient.getDevices = async () => [{ id: 'dev_1', name: 'Speaker', is_active: true } as SpotifyApi.UserDevice];
            djInternal.playerClient.resolveTargetDevice = async () => 'dev_1';
            djInternal.playerClient.startPlaybackOnDevice = async (_id, uris) => {
                playedUris = uris;
            };
            djInternal.playerClient.clearLastError = () => {};
            djInternal.playerClient.getLastError = () => null;
            djInternal.searchTracks = async () => {
                searchCalls++;
                return [makeTrack({ id: 'pj1', uri: 'spotify:track:pj1', name: 'Midnight Waltz', artistName: 'Bill Evans' })];
            };

            // 1. Schedule starts 10 minutes in the future: processDJLoop(false, true) must stand by, NOT play early or throw
            dj.setSchedule([{ start: fmt(plus10), end: fmt(plus120), query: 'piano jazz', queries: ['piano jazz'] }]);
            await dj.processDJLoop(false, true);
            assert.strictEqual(searchCalls, 0);
            assert.strictEqual(playedUris.length, 0);
            assert.match(dj.getStateSnapshot().status, /^⏰ Waiting for /);

            // 2. 60 seconds before start (next minute): background tick preloads silently while still waiting!
            const nextMinute = new Date(now.getTime() + 60_000);
            (dj as unknown as { schedule: ScheduleItem[] }).schedule = [
                { start: fmt(nextMinute), end: fmt(plus120), query: 'piano jazz', queries: ['piano jazz'] },
            ];
            await dj.processDJLoop(true, false);
            // Allow microtask queue to settle preloadedResult
            await new Promise((r) => setTimeout(r, 10));
            assert.strictEqual(searchCalls, 1);
            assert.strictEqual(playedUris.length, 0);

            // 3. Start time arrives: consumes preloaded tracks and starts playback without calling searchTracks again!
            (dj as unknown as { schedule: ScheduleItem[] }).schedule = [
                { start: fmt(now), end: fmt(plus120), query: 'piano jazz', queries: ['piano jazz'] },
            ];
            await dj.processDJLoop(true, false);
            assert.strictEqual(searchCalls, 1);
            assert.deepStrictEqual(playedUris, ['spotify:track:pj1']);
            assert.strictEqual(dj.getStateSnapshot().status, 'Ready');
        });

        it('backs off after playTracks 403/404 failure without burning AI search credits every 5s, and reuses cached tracks after device switch', async () => {
            const dj = new DJCore('fake_token');
            dj.setSchedule([{ start: '00:00', end: '00:00', query: 'city pop', queries: ['city pop'] }]);

            let searchCalls = 0;
            let playCalls = 0;
            let shouldFailPlay = true;

            const djInternal = dj as unknown as {
                playerClient: {
                    getDevices: () => Promise<SpotifyApi.UserDevice[]>;
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: (_id: string, uris: string[]) => Promise<void>;
                    setActiveDevice: (id: string) => Promise<{ ok: boolean }>;
                    clearLastError: () => void;
                    getLastError: () => { status: number; category: string; operation: string; message: string } | null;
                };
                searchTracks: () => Promise<Track[]>;
            };

            djInternal.playerClient.getDevices = async () => [{ id: 'dev_restricted', name: 'Restricted Speaker', is_active: true } as SpotifyApi.UserDevice];
            djInternal.playerClient.resolveTargetDevice = async () => 'dev_restricted';
            djInternal.playerClient.clearLastError = () => {};
            djInternal.playerClient.getLastError = () =>
                shouldFailPlay
                    ? {
                        status: 403,
                        category: 'forbidden',
                        operation: 'play',
                        message: 'Spotify Premium is required (403).',
                    }
                    : null;
            djInternal.playerClient.setActiveDevice = async () => ({ ok: true });
            djInternal.searchTracks = async () => {
                searchCalls++;
                return [makeTrack({ id: 'cp1', uri: 'spotify:track:cp1', name: 'Plastic Love', artistName: 'Mariya Takeuchi' })];
            };
            djInternal.playerClient.startPlaybackOnDevice = async () => {
                playCalls++;
                if (shouldFailPlay) {
                    throw new Error('Spotify Play Failed: Forbidden');
                }
            };

            // 1. Initial forced play throws concrete error and sets non-Starting warning status (never locking UI isBusy!)
            await assert.rejects(
                async () => dj.processDJLoop(false, true),
                /Spotify Play Failed/
            );
            assert.strictEqual(searchCalls, 1);
            assert.strictEqual(playCalls, 1);
            assert.match(dj.getStateSnapshot().status, /^⚠️ Spotify Premium is required/);
            assert.strictEqual(dj.getStateSnapshot().status.includes('Starting'), false);

            // 2. Subsequent 5-second background ticks MUST back off without calling searchTracks or startPlaybackOnDevice!
            await dj.processDJLoop(true, false);
            await dj.processDJLoop(true, false);
            assert.strictEqual(searchCalls, 1);
            assert.strictEqual(playCalls, 1);

            // 3. User switches to a working device via setActiveDevice -> next tick retries immediately using cached tracks (searchCalls stays 1!)
            shouldFailPlay = false;
            await dj.setActiveDevice('dev_working');
            await dj.processDJLoop(true, false);
            assert.strictEqual(searchCalls, 1);
            assert.strictEqual(playCalls, 2);
            assert.strictEqual(dj.getStateSnapshot().status, 'Ready');
        });

        it('keeps schedule immutable on setSchedule/removeScheduleItem and clears lastQuery when last item is removed', () => {
            const dj = new DJCore('fake_token');
            store['dj_last_query'] = 'morning jazz';
            (dj as unknown as { lastQuery: string | null }).lastQuery = 'morning jazz';

            const input: ScheduleItem[] = [
                { start: '09:00', end: '12:00', query: 'morning jazz' },
                { start: '12:00', end: '15:00', query: 'afternoon soul' },
            ];
            dj.setSchedule(input, true);
            const refAfterSet = dj.getSchedule();
            assert.notStrictEqual(refAfterSet, input);

            const refAfterFirstRemove = dj.removeScheduleItem(0, true);
            assert.notStrictEqual(refAfterFirstRemove, refAfterSet);
            assert.strictEqual(refAfterFirstRemove.length, 1);
            assert.strictEqual(dj.getDJStatus().currentQuery, 'morning jazz');

            const refAfterLastRemove = dj.removeScheduleItem(0, true);
            assert.strictEqual(refAfterLastRemove.length, 0);
            assert.strictEqual(dj.getDJStatus().currentQuery, null);
            assert.strictEqual(store['dj_last_query'], undefined);
        });

        it('preloads upcoming block silently, deduplicates in-flight preload at slot transition, and invalidates preload on schedule edit', async () => {
            const dj = new DJCore('fake_token');
            const now = new Date();
            const nextMinute = new Date(now.getTime() + 60_000);
            const endFuture = new Date(now.getTime() + 120 * 60_000);
            const startPast = new Date(now.getTime() - 60 * 60_000);
            const fmt = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

            const slot1: ScheduleItem = { start: fmt(startPast), end: fmt(nextMinute), query: 'slot one', queries: ['slot one'] };
            const slot2: ScheduleItem = { start: fmt(nextMinute), end: fmt(endFuture), query: 'slot two', queries: ['slot two'] };

            const observedStatuses: string[] = [];
            dj.setStatusCallback((s) => observedStatuses.push(s));

            let searchCalls = 0;
            let resolvePreload!: (tracks: Track[]) => void;

            const djInternal = dj as unknown as {
                lastQuery: string | null;
                spotify: { getMyCurrentPlaybackState: () => Promise<unknown> };
                playerClient: {
                    getDevices: () => Promise<SpotifyApi.UserDevice[]>;
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: (_id: string, uris: string[]) => Promise<void>;
                    clearLastError: () => void;
                    getLastError: () => null;
                };
                searchTracks: (q: string | string[], prio?: string, ctx?: { silent?: boolean }) => Promise<Track[]>;
            };

            djInternal.playerClient.getDevices = async () => [{ id: 'dev_1', name: 'Speaker', is_active: true } as SpotifyApi.UserDevice];
            djInternal.playerClient.resolveTargetDevice = async () => 'dev_1';
            djInternal.playerClient.startPlaybackOnDevice = async () => {};
            djInternal.playerClient.clearLastError = () => {};
            djInternal.playerClient.getLastError = () => null;
            djInternal.spotify.getMyCurrentPlaybackState = async () => ({
                is_playing: true,
                item: makeTrack({ id: 's1', uri: 'spotify:track:s1', name: 'Slot 1 Song', artistName: 'Art' }),
                device: { id: 'dev_1', name: 'Speaker', is_active: true },
            });

            let preloadWasSilent = false;
            djInternal.searchTracks = (q, _prio, ctx) => {
                searchCalls++;
                const firstQ = Array.isArray(q) ? q[0] : q;
                if (firstQ === 'slot two') {
                    preloadWasSilent = Boolean(ctx?.silent);
                    return new Promise<Track[]>((resolve) => {
                        resolvePreload = resolve;
                    });
                }
                return Promise.resolve([makeTrack({ id: 's1', uri: 'spotify:track:s1', name: 'Slot 1 Song', artistName: 'Art' })]);
            };

            // Seed active session for slot 1
            dj.setSchedule([slot1, slot2]);
            dj.getSessionCache().activateDJSession(
                [
                    makeTrack({ id: 's1', uri: 'spotify:track:s1', name: 'Slot 1 Song', artistName: 'Art' }),
                    ...Array.from({ length: 6 }, (_, i) => makeTrack({ id: `q${i}`, uri: `spotify:track:q${i}`, name: `Q${i}`, artistName: 'Art' })),
                ],
                true,
                0
            );
            djInternal.lastQuery = 'slot one';

            // Tick 60s before slot2: starts silent in-flight preload without blocking foreground loop
            await dj.processDJLoop(true, false);
            assert.strictEqual(searchCalls, 1);
            assert.strictEqual(preloadWasSilent, true);
            assert.strictEqual(observedStatuses.some(s => s.includes('AI Filtering')), false);

            // Simulate slot2 becoming active while preload is STILL in flight!
            const activeSlot2: ScheduleItem = { start: fmt(startPast), end: fmt(endFuture), query: 'slot two', queries: ['slot two'] };
            (dj as unknown as { schedule: ScheduleItem[] }).schedule = [activeSlot2];

            const transitionPromise = dj.processDJLoop(true, false);
            // Resolve the in-flight preload -> transition must reuse it without calling searchTracks a second time!
            resolvePreload([makeTrack({ id: 's2_pre', uri: 'spotify:track:s2_pre', name: 'Preloaded Song', artistName: 'Art' })]);
            await transitionPromise;

            assert.strictEqual(searchCalls, 1);
            assert.strictEqual(dj.getSessionCache().getSessionTracks()[0].id, 's2_pre');
        });

        it('advances optimistically across rapid consecutive next()/previous() calls and rolls back if Spotify command fails', async () => {
            const sessionTracks = [
                makeTrack({ id: 't0', uri: 'spotify:track:t0', name: 'T0', artistName: 'Art' }),
                makeTrack({ id: 't1', uri: 'spotify:track:t1', name: 'T1', artistName: 'Art' }),
                makeTrack({ id: 't2', uri: 'spotify:track:t2', name: 'T2', artistName: 'Art' }),
            ];
            store['dj_current_session_tracks'] = JSON.stringify(sessionTracks);

            const dj = new DJCore('fake_token');
            dj.getSessionCache().setLastPlayingTrack(sessionTracks[0], false);
            dj.getSessionCache().setSessionStartIndex(0);

            let nextShouldSucceed = true;
            let prevShouldSucceed = true;
            const djInternal = dj as unknown as {
                playerClient: {
                    next: () => Promise<{ ok: boolean }>;
                    previous: () => Promise<{ ok: boolean }>;
                };
            };
            djInternal.playerClient.next = async () => ({ ok: nextShouldSucceed });
            djInternal.playerClient.previous = async () => ({ ok: prevShouldSucceed });

            // Two rapid next() calls before any getPlaybackState() poll -> must reach index 2 (t2)!
            await dj.next();
            await dj.next();
            assert.strictEqual(dj.getSessionCache().getSessionStartIndex(), 2);
            assert.strictEqual(dj.getSessionCache().getLastPlayingTrack()?.id, 't2');

            // Failed previous() rolls back cleanly to index 2 (t2)
            prevShouldSucceed = false;
            const failedPrev = await dj.previous();
            assert.strictEqual(failedPrev.ok, false);
            assert.strictEqual(dj.getSessionCache().getSessionStartIndex(), 2);
            assert.strictEqual(dj.getSessionCache().getLastPlayingTrack()?.id, 't2');

            // Successful previous() steps back to index 1 (t1), then failed next() rolls back to index 1 (t1)
            prevShouldSucceed = true;
            await dj.previous();
            assert.strictEqual(dj.getSessionCache().getSessionStartIndex(), 1);
            nextShouldSucceed = false;
            const failedNext = await dj.next();
            assert.strictEqual(failedNext.ok, false);
            assert.strictEqual(dj.getSessionCache().getSessionStartIndex(), 1);
            assert.strictEqual(dj.getSessionCache().getLastPlayingTrack()?.id, 't1');
        });

        it('applies cooldown when restored-session auto-start fails so background loop does not retry-storm every 5s', async () => {
            const sessionTracks = [
                makeTrack({ id: 'r1', uri: 'spotify:track:r1', name: 'Restored 1', artistName: 'Art' }),
            ];
            store['dj_current_session_tracks'] = JSON.stringify(sessionTracks);
            store['dj_last_query'] = 'restored query';

            const dj = new DJCore('fake_token');
            dj.setSchedule([{ start: '00:00', end: '23:59', query: 'restored query' }]);

            let playAttempts = 0;
            const djInternal = dj as unknown as {
                spotify: { getMyCurrentPlaybackState: () => Promise<unknown> };
                playerClient: {
                    getDevices: () => Promise<SpotifyApi.UserDevice[]>;
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: () => Promise<void>;
                };
            };
            djInternal.spotify.getMyCurrentPlaybackState = async () => null;
            djInternal.playerClient.getDevices = async () => [{ id: 'dev_1', name: 'Asleep Device', is_active: false } as SpotifyApi.UserDevice];
            djInternal.playerClient.resolveTargetDevice = async () => 'dev_1';
            djInternal.playerClient.startPlaybackOnDevice = async () => {
                playAttempts++;
                throw new Error('404 Device not found');
            };

            // First background tick tries once and catches error gracefully
            await dj.processDJLoop(true, false);
            assert.strictEqual(playAttempts, 1);

            // Immediate second background tick respects 60s cooldown instead of spamming playTracks again
            await dj.processDJLoop(true, false);
            assert.strictEqual(playAttempts, 1);
        });

        it('backs off background 5s polling when searchTracks returns 0 tracks, while allowing immediate forced retry', async () => {
            const dj = new DJCore('fake_token');
            dj.setSchedule([{ start: '00:00', end: '23:59', query: 'impossible_query_xyz' }]);

            let searchCalls = 0;
            let searchResult: Track[] = [];
            const djInternal = dj as unknown as {
                playerClient: {
                    getDevices: () => Promise<SpotifyApi.UserDevice[]>;
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: () => Promise<void>;
                    clearLastError: () => void;
                    getLastError: () => null;
                };
                searchTracks: () => Promise<Track[]>;
            };
            djInternal.playerClient.getDevices = async () => [
                { id: 'dev_1', name: 'Speaker', is_active: true } as SpotifyApi.UserDevice,
            ];
            djInternal.playerClient.resolveTargetDevice = async () => 'dev_1';
            djInternal.playerClient.startPlaybackOnDevice = async () => {};
            djInternal.playerClient.clearLastError = () => {};
            djInternal.playerClient.getLastError = () => null;
            djInternal.searchTracks = async () => {
                searchCalls++;
                return searchResult;
            };

            // 1. User-initiated run finds 0 tracks -> throws concrete error and sets warning status
            await assert.rejects(
                () => dj.processDJLoop(false, true),
                /No matching tracks found/
            );
            assert.strictEqual(searchCalls, 1);
            assert.strictEqual(dj.hasPendingStartRetry(), false);

            // 2. Subsequent 5s background polls must NOT hammer searchTracks again during cooldown
            await dj.processDJLoop(true, false);
            await dj.processDJLoop(true, false);
            assert.strictEqual(searchCalls, 1);

            // 3. Explicit forced retry (force=true) bypasses cooldown immediately and plays when tracks exist
            searchResult = [makeTrack({ id: 'ok1', uri: 'spotify:track:ok1', name: 'Found', artistName: 'Art' })];
            await dj.processDJLoop(false, true);
            assert.strictEqual(searchCalls, 2);
            assert.strictEqual(dj.getStateSnapshot().status, 'Ready');
        });

        it('stands by without playing at 09:17 for >12h future schedule ("23時からはピアノのJazz"), and clears stale lastQuery when active block is removed', async (t) => {
            // Freeze wall clock at 2026-11-12 09:17:00
            const fixedMorning = new Date(2026, 10, 12, 9, 17, 0, 0);
            t.mock.timers.enable({ apis: ['Date'], now: fixedMorning.getTime() });

            const dj = new DJCore('fake_token');
            let playedCount = 0;
            const djInternal = dj as unknown as {
                ai: {
                    generateSchedule: (instruction: string) => Promise<ScheduleItem[]>;
                };
                playerClient: {
                    getDevices: () => Promise<SpotifyApi.UserDevice[]>;
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: () => Promise<void>;
                    clearLastError: () => void;
                    getLastError: () => null;
                };
                searchTracks: () => Promise<Track[]>;
            };

            djInternal.ai = {
                generateSchedule: async () => [
                    {
                        start: '23:00',
                        end: '01:00',
                        query: 'genre:jazz piano',
                        queries: ['genre:jazz piano'],
                        thought: '23時からの静かなピアノジャズをお届けします。',
                    },
                ],
            };
            djInternal.playerClient.getDevices = async () => [
                { id: 'dev_1', name: 'Living Room Speaker', is_active: true } as SpotifyApi.UserDevice,
            ];
            djInternal.playerClient.resolveTargetDevice = async () => 'dev_1';
            djInternal.playerClient.startPlaybackOnDevice = async () => {
                playedCount++;
            };
            djInternal.playerClient.clearLastError = () => {};
            djInternal.playerClient.getLastError = () => null;
            djInternal.searchTracks = async () => [
                makeTrack({ id: 'pj1', uri: 'spotify:track:pj1', name: 'Waltz for Debby', artistName: 'Bill Evans' }),
            ];

            // 1. At 09:17, booking 23:00 - 01:00 must stand by and NOT start playback!
            await dj.createSchedule('23時からはピアノのJazzを聴きたいです。');
            await dj.processDJLoop(false, true);
            assert.strictEqual(playedCount, 0);
            assert.match(dj.getStateSnapshot().status, /^⏰ Waiting for 23:00/);
            assert.strictEqual(dj.getStateSnapshot().currentQuery, null);

            // 2. Multi-block prompt ("海を散歩したい気分に合う音楽を。23時からはピアノのJazzを聴きたいです。") where AI rounds Block 0 to 09:30:
            //    "23時" must NOT falsely match "3時", so Block 0 snaps to 09:17 and starts playing immediately!
            djInternal.ai.generateSchedule = async () => [
                {
                    start: '09:30',
                    end: '23:00',
                    query: 'ocean breeze acoustic',
                    queries: ['ocean breeze acoustic'],
                    thought: '海辺の散歩に合う爽やかな音楽です。',
                },
                {
                    start: '23:00',
                    end: '01:00',
                    query: 'genre:jazz piano',
                    queries: ['genre:jazz piano'],
                    thought: '23時からのピアノジャズです。',
                },
            ];
            const multiSchedule = await dj.createSchedule('海を散歩したい気分に合う音楽を。23時からはピアノのJazzを聴きたいです。');
            assert.strictEqual(multiSchedule[0].start, '09:17');
            await dj.processDJLoop(false, true);
            assert.strictEqual(playedCount, 1);
            assert.strictEqual(dj.getStateSnapshot().currentQuery, 'ocean breeze acoustic');

            // 3. Removing Block 0 (09:17 - 23:00) leaves only Block 1 (23:00 - 01:00) -> enters standby without prematurely playing Block 1,
            //    suppresses future Block 1 thought while 'ocean breeze acoustic' is still active,
            //    and if lastQuery collided with Block 1's signature, clears it so 23:00 will start cleanly when reached!
            dj.removeScheduleItem(0, true);
            assert.strictEqual(dj.getStateSnapshot().currentQuery, 'ocean breeze acoustic');
            assert.strictEqual(dj.getStateSnapshot().currentThought, null);
            assert.strictEqual(dj.getDJStatus().currentThought, null);
            await dj.processDJLoop(true, false);
            assert.strictEqual(playedCount, 1);
            assert.match(dj.getStateSnapshot().status, /^⏰ Waiting for 23:00/);

            // Colliding lastQuery with upcoming 23:00 signature is cleared on setSchedule so 23:00 transition is never skipped
            store['dj_last_query'] = 'genre:jazz piano';
            (dj as unknown as { lastQuery: string | null }).lastQuery = 'genre:jazz piano';
            dj.setSchedule(dj.getSchedule(), true);
            assert.strictEqual(dj.getStateSnapshot().currentQuery, null);
            assert.strictEqual(dj.getStateSnapshot().currentThought, '23時からのピアノジャズです。');
            assert.strictEqual(store['dj_last_query'], undefined);

            // Advance clock to 23:00 -> standby ends and piano jazz starts playing automatically!
            t.mock.timers.setTime(new Date(2026, 10, 12, 23, 0, 0, 0).getTime());
            await dj.processDJLoop(true, false);
            assert.strictEqual(playedCount, 2);
            assert.strictEqual(dj.getStateSnapshot().currentQuery, 'genre:jazz piano');
            assert.strictEqual(dj.getStateSnapshot().status, 'Ready');
        });

        it('strips expired yesterday schedules, stands by for multi-block tomorrow & >10h overnight reservations, and preserves active playback when appending future slots', async (t) => {
            // 1. Seed a schedule on Wed 23:00 - Thu 01:00, then advance to Thu 09:17 (8h 17m after show ended)
            const wedNight = new Date(2026, 10, 11, 23, 0, 0, 0);
            t.mock.timers.enable({ apis: ['Date'], now: wedNight.getTime() });

            const dj = new DJCore('fake_token');
            let playedCount = 0;
            let receivedExistingSchedule: ScheduleItem[] = [];

            const djInternal = dj as unknown as {
                ai: {
                    generateSchedule: (instruction: string, existing: ScheduleItem[]) => Promise<ScheduleItem[]>;
                };
                spotify: {
                    getMyCurrentPlaybackState: () => Promise<unknown>;
                };
                playerClient: {
                    getDevices: () => Promise<SpotifyApi.UserDevice[]>;
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: () => Promise<void>;
                    getUserQueue: () => Promise<{ currently_playing: Track | null; queue: Track[] }>;
                    clearLastError: () => void;
                    getLastError: () => null;
                };
                searchTracks: () => Promise<Track[]>;
            };

            djInternal.playerClient.getDevices = async () => [
                { id: 'dev_1', name: 'Speaker', is_active: true } as SpotifyApi.UserDevice,
            ];
            djInternal.playerClient.resolveTargetDevice = async () => 'dev_1';
            djInternal.playerClient.startPlaybackOnDevice = async () => {
                playedCount++;
            };
            djInternal.playerClient.clearLastError = () => {};
            djInternal.playerClient.getLastError = () => null;
            const sampleTracks = Array.from({ length: 6 }, (_, idx) =>
                makeTrack({ id: `tr_${idx}`, uri: `spotify:track:tr_${idx}`, name: `Track ${idx}`, artistName: 'Artist' })
            );
            djInternal.searchTracks = async () => sampleTracks;
            djInternal.spotify.getMyCurrentPlaybackState = async () => ({
                is_playing: true,
                item: sampleTracks[0],
                device: { id: 'dev_1', name: 'Speaker', is_active: true },
            });
            djInternal.playerClient.getUserQueue = async () => ({
                currently_playing: sampleTracks[0],
                queue: sampleTracks.slice(1),
            });

            djInternal.ai = {
                generateSchedule: async (_inst, existing) => {
                    receivedExistingSchedule = existing;
                    return [{ start: '23:00', end: '01:00', query: 'wed jazz', queries: ['wed jazz'] }];
                },
            };
            await dj.createSchedule('23時からジャズ');

            // Advance to Thu 09:17 -> yesterday's 23:00-01:00 has finished; booking tonight's 23:00 must strip expired context & stand by!
            const thu0917 = new Date(2026, 10, 12, 9, 17, 0, 0);
            t.mock.timers.setTime(thu0917.getTime());
            djInternal.ai.generateSchedule = async (_inst, existing) => {
                receivedExistingSchedule = existing;
                return [{ start: '23:00', end: '01:00', query: 'thu bossa', queries: ['thu bossa'] }];
            };
            await dj.createSchedule('23時からはボサノバを聴きたいです');
            assert.deepStrictEqual(receivedExistingSchedule, []);
            await dj.processDJLoop(false, true);
            assert.strictEqual(playedCount, 0);
            assert.match(dj.getStateSnapshot().status, /^⏰ Waiting for 23:00/);

            // 2. Long overnight future slot ("今夜23時から朝10時までアンビエント" -> 23:00 - 10:00) at Thu 09:17 must stand by!
            djInternal.ai.generateSchedule = async () => [
                { start: '23:00', end: '10:00', query: 'sleep ambient', queries: ['sleep ambient'] },
            ];
            await dj.createSchedule('今夜23時から朝10時までアンビエント');
            await dj.processDJLoop(false, true);
            assert.strictEqual(playedCount, 0);
            assert.match(dj.getStateSnapshot().status, /^⏰ Waiting for 23:00/);

            // 3. Multi-block tomorrow schedule ("明日の朝9時からはクラシック、12時からはボサノバ") at Thu 09:17 must stand by until Friday 09:00!
            djInternal.ai.generateSchedule = async () => [
                { start: '09:00', end: '12:00', query: 'fri classical', queries: ['fri classical'] },
                { start: '12:00', end: '15:00', query: 'fri bossa', queries: ['fri bossa'] },
            ];
            await dj.createSchedule('明日の朝9時からはクラシック、12時からはボサノバ');
            await dj.processDJLoop(false, true);
            assert.strictEqual(playedCount, 0);
            assert.match(dj.getStateSnapshot().status, /^⏰ Waiting for 09:00/);

            // 4. Active session playing 09:17-12:00 'morning acoustic': appending a 23:00 block preserves active playback without restarting!
            djInternal.ai.generateSchedule = async () => [
                { start: '09:30', end: '12:00', query: 'morning acoustic', queries: ['morning acoustic'] },
            ];
            await dj.createSchedule('3時間くらい作業用アコースティックをかけて');
            assert.strictEqual(dj.getSchedule()[0].start, '09:17');
            await dj.processDJLoop(false, true);
            assert.strictEqual(playedCount, 1);
            assert.strictEqual(dj.isSessionPlaybackActive(), true);

            const prevSched = dj.getSchedule();
            const prevQuery = dj.getDJStatus().currentQuery;
            const wasActive = dj.isSessionPlaybackActive();
            djInternal.ai.generateSchedule = async () => [
                { start: '09:17', end: '23:00', query: 'morning acoustic', queries: ['morning acoustic'] },
                { start: '23:00', end: '01:00', query: 'piano jazz', queries: ['piano jazz'] },
            ];
            await dj.createSchedule('23時からはピアノのJazzも追加して');
            const preserve = dj.shouldPreservePlaybackAfterScheduleChange(prevSched, prevQuery, wasActive);
            assert.strictEqual(preserve, true);
            await dj.processDJLoop(false, !preserve);
            // Active session was NOT interrupted (playedCount remained 1)!
            assert.strictEqual(playedCount, 1);
            assert.strictEqual(dj.getDJStatus().currentQuery, 'morning acoustic');
        });
    });
});

