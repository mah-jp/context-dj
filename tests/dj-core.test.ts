import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DJCore } from '../src/lib/dj-core';
import { STORAGE_KEYS } from '../src/lib/constants';
import { ScheduleItem, Track } from '../src/lib/types';

function makeTrack(overrides: {
    id: string;
    name: string;
    uri: string;
    artistName: string;
    duration_ms?: number;
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
        duration_ms: overrides.duration_ms,
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

        it('keeps schedule immutable on setSchedule/removeScheduleItem and clears lastQuery when last item is removed', (t) => {
            t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 12, 10, 0, 0, 0).getTime() });
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

        it('protects unconfirmed runtime sessionTracks from external-playback false positives, normalizes shuffle/repeat once after convergence, and detects external takeover after confirmation', async (t) => {
            const baseNow = new Date(2026, 10, 12, 14, 0, 0, 0).getTime();
            t.mock.timers.enable({ apis: ['Date'], now: baseNow });

            const dj = new DJCore('fake_token');
            const djTracks = [
                makeTrack({ id: 'dj1', uri: 'spotify:track:dj1', name: 'Curated 1', artistName: 'DJ Art' }),
                makeTrack({ id: 'dj2', uri: 'spotify:track:dj2', name: 'Curated 2', artistName: 'DJ Art' }),
                makeTrack({ id: 'dj3', uri: 'spotify:track:dj3', name: 'Curated 3', artistName: 'DJ Art' }),
            ];
            const oldPhoneTrack = makeTrack({ id: 'old1', uri: 'spotify:track:old1', name: 'Old Phone Song', artistName: 'Other' });

            let currentSpotifyState: unknown = {
                is_playing: true,
                item: oldPhoneTrack,
                context: { uri: 'spotify:playlist:previous_playlist' },
                shuffle_state: true,
                repeat_state: 'context',
                device: { id: 'phone_1', name: 'iPhone', type: 'Smartphone', is_active: true, is_restricted: false },
            };
            let ensureModesCalls = 0;

            const djInternal = dj as unknown as {
                spotify: { getMyCurrentPlaybackState: () => Promise<unknown> };
                playerClient: {
                    getDevices: () => Promise<SpotifyApi.UserDevice[]>;
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: () => Promise<void>;
                    ensurePlaybackModes: (st: unknown) => Promise<void>;
                    clearLastError: () => void;
                    getLastError: () => null;
                };
            };
            djInternal.spotify.getMyCurrentPlaybackState = async () => currentSpotifyState;
            djInternal.playerClient.getDevices = async () => [
                { id: 'phone_1', name: 'iPhone', type: 'Smartphone', is_active: true, is_restricted: false } as SpotifyApi.UserDevice,
            ];
            djInternal.playerClient.resolveTargetDevice = async () => 'phone_1';
            djInternal.playerClient.startPlaybackOnDevice = async () => {};
            djInternal.playerClient.ensurePlaybackModes = async () => {
                ensureModesCalls++;
            };
            djInternal.playerClient.clearLastError = () => {};
            djInternal.playerClient.getLastError = () => null;

            await dj.playTracks(djTracks, { isDJSession: true });
            assert.strictEqual(dj.hasConfirmedPlayback(), false);
            assert.strictEqual(dj.isSessionPlaybackActive(), true);

            // 1. Even 20s after playTracks (well past STARTUP_GRACE_MS), if Track 1 has NEVER been confirmed playing,
            //    Spotify reporting oldPhoneTrack must NOT wipe sessionTracks or clobber lastPlayingTrack!
            t.mock.timers.setTime(baseNow + 20_000);
            const unconfirmedPoll = await dj.getPlaybackState();
            assert.strictEqual(unconfirmedPoll?.item?.id, 'old1');
            assert.strictEqual(dj.isSessionPlaybackActive(), true);
            assert.strictEqual(dj.hasConfirmedPlayback(), false);
            assert.strictEqual(dj.getSessionCache().getLastPlayingTrack()?.id, 'dj1');
            assert.strictEqual(ensureModesCalls, 0);

            const queueWhileUnconfirmed = await dj.getQueue(oldPhoneTrack);
            assert.deepStrictEqual(queueWhileUnconfirmed.map((tr) => tr.id), ['dj2', 'dj3']);
            assert.strictEqual(dj.isSessionPlaybackActive(), true);

            // 2. Now Track 1 (dj1) starts playing on the phone -> confirms session & calls ensurePlaybackModes ONCE!
            currentSpotifyState = {
                is_playing: true,
                item: djTracks[0],
                context: null,
                shuffle_state: true,
                repeat_state: 'context',
                device: { id: 'phone_1', name: 'iPhone', type: 'Smartphone', is_active: true, is_restricted: false },
            };
            const confirmedPoll1 = await dj.getPlaybackState();
            assert.strictEqual(confirmedPoll1?.item?.id, 'dj1');
            assert.strictEqual(dj.hasConfirmedPlayback(), true);
            assert.strictEqual(ensureModesCalls, 1);

            // Subsequent poll on dj1 does NOT re-fire ensurePlaybackModes
            await dj.getPlaybackState();
            assert.strictEqual(ensureModesCalls, 1);

            // 3. Once session playback WAS confirmed, switching to an external track DOES trigger external takeover!
            currentSpotifyState = {
                is_playing: true,
                item: oldPhoneTrack,
                context: { uri: 'spotify:playlist:user_switched' },
                device: { id: 'phone_1', name: 'iPhone', type: 'Smartphone', is_active: true, is_restricted: false },
            };
            await dj.getPlaybackState();
            assert.strictEqual(dj.isSessionPlaybackActive(), false);
            assert.strictEqual(dj.getSessionCache().getSessionTracks().length, 0);
        });

        it('preserves curated sessionTracks on 404 play failure and starts ContextDJ Track 1 immediately on 1-tap resume()', async () => {
            const dj = new DJCore('fake_token');
            dj.setSchedule([{ start: '00:00', end: '23:59', query: 'ocean walk', thought: 'Seaside breeze' }]);

            const curatedTracks = [
                makeTrack({ id: 'dj1', uri: 'spotify:track:dj1', name: 'Ocean Track 1', artistName: 'Sea' }),
                makeTrack({ id: 'dj2', uri: 'spotify:track:dj2', name: 'Ocean Track 2', artistName: 'Sea' }),
                makeTrack({ id: 'dj3', uri: 'spotify:track:dj3', name: 'Ocean Track 3', artistName: 'Sea' }),
            ];
            let shouldFail404 = true;
            const startedUrisHistory: string[][] = [];

            const djInternal = dj as unknown as {
                spotify: { getMyCurrentPlaybackState: () => Promise<unknown> };
                playerClient: {
                    getDevices: () => Promise<SpotifyApi.UserDevice[]>;
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: (_devId: string, uris: string[]) => Promise<void>;
                    resume: () => Promise<{ ok: boolean }>;
                    clearLastError: () => void;
                    getLastError: () => null;
                };
                searchTracks: () => Promise<Track[]>;
            };
            djInternal.spotify.getMyCurrentPlaybackState = async () => ({
                is_playing: false,
                item: makeTrack({ id: 'old_paused', uri: 'spotify:track:old_paused', name: 'Previous Song', artistName: 'Prev' }),
                context: { uri: 'spotify:album:prev' },
                device: { id: 'phone_1', name: 'iPhone', type: 'Smartphone', is_active: false },
            });
            djInternal.playerClient.getDevices = async () => [
                { id: 'phone_1', name: 'iPhone', type: 'Smartphone', is_active: false } as SpotifyApi.UserDevice,
            ];
            djInternal.playerClient.resolveTargetDevice = async () => 'phone_1';
            djInternal.playerClient.startPlaybackOnDevice = async (_devId: string, uris: string[]) => {
                if (shouldFail404) {
                    throw new Error('Spotify Play Failed: Not Found (404 Device not found)');
                }
                startedUrisHistory.push(uris);
            };
            djInternal.playerClient.resume = async () => {
                throw new Error('Bare resume should NOT be called when unconfirmed sessionTracks exist!');
            };
            djInternal.playerClient.clearLastError = () => {};
            djInternal.playerClient.getLastError = () => null;
            djInternal.searchTracks = async () => curatedTracks;

            // 1. Initial curation hits 404 because mobile Spotify went to sleep
            await assert.rejects(() => dj.processDJLoop(false, true), /404/);

            // Curated tracks are preserved in sessionCache with lastPlayTime === 0 (no fake optimistic playing state!)
            assert.strictEqual(dj.isSessionPlaybackActive(), true);
            assert.strictEqual(dj.hasConfirmedPlayback(), false);
            assert.strictEqual(dj.getLastPlayTime(), 0);
            assert.strictEqual(dj.hasPendingStartRetry(), true);
            assert.deepStrictEqual(dj.getSessionCache().getSessionTracks().map((t) => t.id), ['dj1', 'dj2', 'dj3']);
            assert.deepStrictEqual((await dj.getQueue()).map((t) => t.id), ['dj2', 'dj3']);
            const stateAfter404 = await dj.getPlaybackState();
            assert.strictEqual(Boolean(stateAfter404?.__optimisticFallback), false);

            // 2. User taps ContextDJ's Play button -> resume() sends full [dj1, dj2, dj3] URIs instead of bare resume,
            //    and reconciles pending start failure / currentQuery / status!
            shouldFail404 = false;
            const resumeRes = await dj.resume();
            assert.strictEqual(resumeRes.ok, true);
            assert.strictEqual(startedUrisHistory.length, 1);
            assert.deepStrictEqual(startedUrisHistory[0], [
                'spotify:track:dj1',
                'spotify:track:dj2',
                'spotify:track:dj3',
            ]);
            assert.strictEqual(dj.hasPendingStartRetry(), false);
            assert.strictEqual(dj.getDJStatus().currentQuery, 'ocean walk');
            assert.strictEqual(dj.getStateSnapshot().status, 'Ready');
        });

        it('recovers unconfirmed mobile empty-swing or 404 sessions immediately on foreground return without overriding explicit user pause', async (t) => {
            const baseNow = new Date(2026, 10, 12, 15, 0, 0, 0).getTime();
            t.mock.timers.enable({ apis: ['Date'], now: baseNow });

            const dj = new DJCore('fake_token');
            dj.setSchedule([{ start: '00:00', end: '23:59', query: 'sunset chill' }]);

            const curatedTracks = [
                makeTrack({ id: 'dj1', uri: 'spotify:track:dj1', name: 'Sunset 1', artistName: 'Art' }),
                makeTrack({ id: 'dj2', uri: 'spotify:track:dj2', name: 'Sunset 2', artistName: 'Art' }),
            ];
            let searchCalls = 0;
            const playCalls: string[][] = [];

            const djInternal = dj as unknown as {
                spotify: { getMyCurrentPlaybackState: () => Promise<unknown> };
                playerClient: {
                    getDevices: () => Promise<SpotifyApi.UserDevice[]>;
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: (_devId: string, uris: string[]) => Promise<void>;
                    pause: () => Promise<{ ok: boolean }>;
                    clearLastError: () => void;
                    getLastError: () => null;
                };
                searchTracks: () => Promise<Track[]>;
            };
            djInternal.spotify.getMyCurrentPlaybackState = async () => ({
                is_playing: false,
                item: makeTrack({ id: 'old1', uri: 'spotify:track:old1', name: 'Old', artistName: 'Prev' }),
                device: { id: 'phone_1', name: 'iPhone', type: 'Smartphone', is_active: true },
            });
            djInternal.playerClient.getDevices = async () => [
                { id: 'phone_1', name: 'iPhone', type: 'Smartphone', is_active: true } as SpotifyApi.UserDevice,
            ];
            djInternal.playerClient.resolveTargetDevice = async () => 'phone_1';
            djInternal.playerClient.startPlaybackOnDevice = async (_devId: string, uris: string[]) => {
                playCalls.push(uris);
            };
            djInternal.playerClient.pause = async () => ({ ok: true });
            djInternal.playerClient.clearLastError = () => {};
            djInternal.playerClient.getLastError = () => null;
            djInternal.searchTracks = async () => {
                searchCalls++;
                return curatedTracks;
            };

            // 1. Initial DJ curation gets HTTP 204 (playCalls = 1), but phone actually stayed paused on old1 (empty-swing)
            await dj.processDJLoop(false, true);
            assert.strictEqual(searchCalls, 1);
            assert.strictEqual(playCalls.length, 1);
            assert.strictEqual(dj.hasConfirmedPlayback(), false);

            // 2. User switches to Spotify, sees it paused, and returns to browser 2.0s later (< 4s STARTUP_GRACE_MS):
            //    notifyForegrounded() + processDJLoop() immediately recovers Track 1 without re-running searchTracks!
            t.mock.timers.setTime(baseNow + 2000);
            dj.notifyForegrounded();
            await dj.processDJLoop(true, false);
            assert.strictEqual(searchCalls, 1);
            assert.strictEqual(playCalls.length, 2);
            assert.deepStrictEqual(playCalls[1], ['spotify:track:dj1', 'spotify:track:dj2']);

            // 3. If user explicitly clicks Pause, returning to foreground does NOT auto-resume against user's intent
            await dj.pause();
            t.mock.timers.setTime(baseNow + 8000);
            dj.notifyForegrounded();
            await dj.processDJLoop(true, false);
            assert.strictEqual(playCalls.length, 2);
        });

        it('starts ContextDJ session tracks via playTracks on next()/previous() when runtime session is unconfirmed instead of advancing old Spotify context', async () => {
            const dj = new DJCore('fake_token');
            const djTracks = [
                makeTrack({ id: 'dj1', uri: 'spotify:track:dj1', name: 'DJ 1', artistName: 'Art' }),
                makeTrack({ id: 'dj2', uri: 'spotify:track:dj2', name: 'DJ 2', artistName: 'Art' }),
                makeTrack({ id: 'dj3', uri: 'spotify:track:dj3', name: 'DJ 3', artistName: 'Art' }),
            ];
            let failPlay = false;
            const playHistory: string[][] = [];
            let bareNextCalls = 0;
            let barePrevCalls = 0;

            const djInternal = dj as unknown as {
                spotify: {
                    getMyCurrentPlaybackState: () => Promise<unknown>;
                };
                playerClient: {
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: (_dev: string, uris: string[]) => Promise<void>;
                    next: () => Promise<{ ok: boolean }>;
                    previous: () => Promise<{ ok: boolean }>;
                    clearLastError: () => void;
                    getLastError: () => null;
                };
            };
            djInternal.spotify.getMyCurrentPlaybackState = async () => ({
                is_playing: false,
                item: makeTrack({ id: 'old_ext', uri: 'spotify:track:old_ext', name: 'Old Song', artistName: 'Prev' }),
                context: { uri: 'spotify:playlist:old_context' },
                device: { id: 'phone_1', name: 'iPhone', type: 'Smartphone', is_active: true },
            });
            djInternal.playerClient.resolveTargetDevice = async () => 'phone_1';
            djInternal.playerClient.startPlaybackOnDevice = async (_dev, uris) => {
                if (failPlay) throw new Error('404 Device asleep');
                playHistory.push(uris);
            };
            djInternal.playerClient.next = async () => {
                bareNextCalls++;
                return { ok: true };
            };
            djInternal.playerClient.previous = async () => {
                barePrevCalls++;
                return { ok: true };
            };
            djInternal.playerClient.clearLastError = () => {};
            djInternal.playerClient.getLastError = () => null;

            // Initial play fails with 404 -> session is unconfirmed runtime session at index 0 (dj1)
            failPlay = true;
            await assert.rejects(() => dj.playTracks(djTracks, { isDJSession: true }), /404/);
            assert.strictEqual(dj.hasConfirmedPlayback(), false);
            assert.strictEqual(dj.getSessionCache().getSessionStartIndex(), 0);

            // Failed next() while phone is still asleep rolls back sessionStartIndex cleanly to 0
            const failedNext = await dj.next();
            assert.strictEqual(failedNext.ok, false);
            assert.strictEqual(bareNextCalls, 0);
            assert.strictEqual(dj.getSessionCache().getSessionStartIndex(), 0);
            assert.strictEqual(dj.getSessionCache().getLastPlayingTrack()?.id, 'dj1');

            // Phone wakes up -> next() starts [dj2, dj3] via playTracks instead of bare POST /next!
            failPlay = false;
            const okNext = await dj.next();
            assert.strictEqual(okNext.ok, true);
            assert.strictEqual(bareNextCalls, 0);
            assert.deepStrictEqual(playHistory[0], ['spotify:track:dj2', 'spotify:track:dj3']);
            assert.strictEqual(dj.getSessionCache().getSessionStartIndex(), 1);

            // Still unconfirmed -> previous() starts [dj1, dj2, dj3] via playTracks instead of bare POST /previous!
            const okPrev = await dj.previous();
            assert.strictEqual(okPrev.ok, true);
            assert.strictEqual(barePrevCalls, 0);
            assert.deepStrictEqual(playHistory[1], ['spotify:track:dj1', 'spotify:track:dj2', 'spotify:track:dj3']);
            assert.strictEqual(dj.getSessionCache().getSessionStartIndex(), 0);
        });

        it('guards against premature 0ms cloud mirages, defers shuffle/repeat normalization until playback settles, and clears startup grace on explicit pause()', async (t) => {
            const baseNow = new Date(2026, 10, 12, 16, 0, 0, 0).getTime();
            t.mock.timers.enable({ apis: ['Date'], now: baseNow });

            const dj = new DJCore('fake_token');
            const djTracks = [
                makeTrack({ id: 'dj1', uri: 'spotify:track:dj1', name: 'DJ 1', artistName: 'Art' }),
                makeTrack({ id: 'dj2', uri: 'spotify:track:dj2', name: 'DJ 2', artistName: 'Art' }),
            ];
            let currentState: unknown = null;
            let ensureModesCount = 0;

            const djInternal = dj as unknown as {
                spotify: { getMyCurrentPlaybackState: () => Promise<unknown> };
                playerClient: {
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: () => Promise<void>;
                    ensurePlaybackModes: () => Promise<void>;
                    pause: () => Promise<{ ok: boolean }>;
                };
            };
            djInternal.spotify.getMyCurrentPlaybackState = async () => currentState;
            djInternal.playerClient.resolveTargetDevice = async () => 'phone_1';
            djInternal.playerClient.startPlaybackOnDevice = async () => {};
            djInternal.playerClient.ensurePlaybackModes = async () => {
                ensureModesCount++;
            };
            djInternal.playerClient.pause = async () => ({ ok: true });

            await dj.playTracks(djTracks, { isDJSession: true });

            // 1. At 350ms, cloud reports progress_ms === 0 -> does NOT confirm prematurely or spam shuffle/repeat!
            t.mock.timers.setTime(baseNow + 350);
            currentState = {
                is_playing: true,
                progress_ms: 0,
                item: djTracks[0],
                context: null,
                shuffle_state: true,
                repeat_state: 'context',
                device: { id: 'phone_1', name: 'iPhone', type: 'Smartphone', is_active: true, is_restricted: false },
            };
            await dj.getPlaybackState();
            assert.strictEqual(dj.hasConfirmedPlayback(), false);
            assert.strictEqual(ensureModesCount, 0);

            // 2. At 700ms, audio advances (progress_ms: 400 > 0) -> confirms session, but STILL defers shuffle/repeat until >= 1.5s!
            t.mock.timers.setTime(baseNow + 700);
            currentState = {
                ...(currentState as Record<string, unknown>),
                progress_ms: 400,
            };
            await dj.getPlaybackState();
            assert.strictEqual(dj.hasConfirmedPlayback(), true);
            assert.strictEqual(ensureModesCount, 0);

            // 3. At 1800ms, playback is settled -> normalizes shuffle/repeat once!
            t.mock.timers.setTime(baseNow + 1800);
            currentState = {
                ...(currentState as Record<string, unknown>),
                progress_ms: 1500,
            };
            await dj.getPlaybackState();
            assert.strictEqual(ensureModesCount, 1);

            // 4. Start a fresh session and immediately pause() at 500ms (< 4s STARTUP_GRACE_MS) -> returns real paused state, NOT __optimisticFallback!
            t.mock.timers.setTime(baseNow + 5000);
            await dj.playTracks(djTracks, { isDJSession: true });
            t.mock.timers.setTime(baseNow + 5500);
            await dj.pause();
            currentState = {
                is_playing: false,
                progress_ms: 0,
                item: djTracks[0],
                context: null,
                device: { id: 'phone_1', name: 'iPhone', type: 'Smartphone', is_active: true, is_restricted: false },
            };
            const pausedState = await dj.getPlaybackState();
            assert.strictEqual(Boolean(pausedState?.__optimisticFallback), false);
            assert.strictEqual(pausedState?.is_playing, false);
        });

        it('curates and starts active schedule on resume() when initial run saw 0 controllable devices, and honors foreground recovery across in-flight failure', async (t) => {
            const baseNow = new Date(2026, 10, 12, 17, 0, 0, 0).getTime();
            t.mock.timers.enable({ apis: ['Date'], now: baseNow });

            const dj = new DJCore('fake_token');
            dj.setSchedule([{ start: '00:00', end: '23:59', query: 'piano jazz' }]);

            const curated = [
                makeTrack({ id: 'pj1', uri: 'spotify:track:pj1', name: 'Piano 1', artistName: 'Trio' }),
            ];
            let devices: SpotifyApi.UserDevice[] = [];
            let shouldFail404 = false;
            let playCount = 0;

            const djInternal = dj as unknown as {
                playerClient: {
                    getDevices: () => Promise<SpotifyApi.UserDevice[]>;
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: () => Promise<void>;
                    resume: () => Promise<{ ok: boolean }>;
                    clearLastError: () => void;
                    getLastError: () => null;
                };
                searchTracks: () => Promise<Track[]>;
            };
            djInternal.playerClient.getDevices = async () => devices;
            djInternal.playerClient.resolveTargetDevice = async () => 'phone_1';
            djInternal.playerClient.startPlaybackOnDevice = async () => {
                if (shouldFail404) throw new Error('404 Asleep');
                playCount++;
            };
            djInternal.playerClient.resume = async () => {
                throw new Error('Should not bare-resume old Spotify song when active schedule awaits curation!');
            };
            djInternal.playerClient.clearLastError = () => {};
            djInternal.playerClient.getLastError = () => null;
            djInternal.searchTracks = async () => curated;

            // 1. Initial attempt when only a restricted speaker exists -> skips search cleanly
            devices = [{ id: 'sonos_locked', name: 'Locked', type: 'Speaker', is_active: true, is_restricted: true } as SpotifyApi.UserDevice];
            await assert.rejects(() => dj.processDJLoop(false, true), /Please open Spotify/);
            assert.strictEqual(dj.getSessionCache().getSessionTracks().length, 0);

            // 2. User opens Spotify on phone and presses ContextDJ Play -> resume() curates & plays [pj1]!
            devices = [{ id: 'phone_1', name: 'iPhone', type: 'Smartphone', is_active: true, is_restricted: false } as SpotifyApi.UserDevice];
            const res = await dj.resume();
            assert.strictEqual(res.ok, true);
            assert.strictEqual(playCount, 1);

            // 3. Simulate foreground notification arriving BEFORE an in-flight failure writes lastStartFailure.timestamp:
            //    next processDJLoop still honors pendingForegroundRecovery and retries immediately!
            dj.setSchedule([{ start: '00:00', end: '23:59', query: 'night jazz' }]);
            shouldFail404 = true;
            await assert.rejects(() => dj.processDJLoop(false, true), /404/);
            dj.notifyForegrounded();
            // Simulate in-flight failure overwriting timestamp right after notifyForegrounded()
            (dj as unknown as { lastStartFailure: { timestamp: number } }).lastStartFailure.timestamp = Date.now();
            shouldFail404 = false;
            await dj.processDJLoop(true, false);
            assert.strictEqual(playCount, 2);
        });

        it('keeps __optimisticFallback and blocks false confirmation during prolonged progress_ms === 0 cloud mirages, then kick-starts paused mobile playback', async (t) => {
            const baseNow = new Date(2026, 10, 13, 2, 19, 0, 0).getTime();
            t.mock.timers.enable({ apis: ['Date'], now: baseNow });

            const dj = new DJCore('fake_token');
            const djTracks = [
                makeTrack({ id: 'take_on_me', uri: 'spotify:track:take_on_me', name: 'Take on Me', artistName: 'a-ha' }),
                makeTrack({ id: 'want_that_man', uri: 'spotify:track:want_that_man', name: 'I Want That Man', artistName: 'Deborah Harry' }),
                makeTrack({ id: 'every_woman', uri: 'spotify:track:every_woman', name: "I'm Every Woman", artistName: 'Chaka Khan' }),
            ];

            let currentState: unknown = null;
            const resumeCalls: (string | undefined)[] = [];

            const djInternal = dj as unknown as {
                spotify: { getMyCurrentPlaybackState: () => Promise<unknown> };
                playerClient: {
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: () => Promise<void>;
                    resume: (deviceId?: string) => Promise<{ ok: boolean }>;
                    ensurePlaybackModes: () => Promise<void>;
                };
            };
            djInternal.spotify.getMyCurrentPlaybackState = async () => currentState;
            djInternal.playerClient.resolveTargetDevice = async () => 'phone_android';
            djInternal.playerClient.startPlaybackOnDevice = async () => {};
            djInternal.playerClient.resume = async (deviceId?: string) => {
                resumeCalls.push(deviceId);
                return { ok: true };
            };
            djInternal.playerClient.ensurePlaybackModes = async () => {};

            await dj.playTracks(djTracks, { isDJSession: true });

            // 1. At 350ms AND 2000ms (< 4000ms STARTUP_GRACE_MS), cloud returns transient is_playing: true, progress_ms: 0 mirage:
            //    must NOT falsely confirm session playback AND must return __optimisticFallback: true so convergence keeps polling!
            for (const offsetMs of [350, 2000]) {
                t.mock.timers.setTime(baseNow + offsetMs);
                currentState = {
                    is_playing: true,
                    progress_ms: 0,
                    item: djTracks[0],
                    context: null,
                    device: { id: 'phone_android', name: 'Pixel', type: 'Smartphone', is_active: true, is_restricted: false },
                };
                const mirageState = await dj.getPlaybackState();
                assert.strictEqual(dj.hasConfirmedPlayback(), false);
                assert.strictEqual(Boolean(mirageState?.__optimisticFallback), true);
                assert.strictEqual(resumeCalls.length, 0);
            }

            // 2. At 2600ms, mobile queue parser finishes loading Track 1 in paused state (is_playing: false, progress_ms: 0):
            //    getPlaybackState() immediately fires startup resume kick #1!
            t.mock.timers.setTime(baseNow + 2600);
            currentState = {
                is_playing: false,
                progress_ms: 0,
                item: djTracks[0],
                context: null,
                device: { id: 'phone_android', name: 'Pixel', type: 'Smartphone', is_active: true, is_restricted: false },
            };
            await dj.getPlaybackState();
            await Promise.resolve();
            assert.deepStrictEqual(resumeCalls, ['phone_android']);

            // 3. Poll within 1500ms cooldown (3400ms) does not spam duplicate kicks; after >= 1500ms (4300ms) sends kick #2; caps at max 2 kicks!
            t.mock.timers.setTime(baseNow + 3400);
            await dj.getPlaybackState();
            await Promise.resolve();
            assert.strictEqual(resumeCalls.length, 1);

            t.mock.timers.setTime(baseNow + 4300);
            await dj.getPlaybackState();
            await Promise.resolve();
            assert.strictEqual(resumeCalls.length, 2);

            t.mock.timers.setTime(baseNow + 6200);
            await dj.getPlaybackState();
            await Promise.resolve();
            assert.strictEqual(resumeCalls.length, 2);

            // 4. Once audio advances (progress_ms > 0), session playback confirms cleanly
            t.mock.timers.setTime(baseNow + 6600);
            currentState = {
                is_playing: true,
                progress_ms: 850,
                item: djTracks[0],
                context: null,
                device: { id: 'phone_android', name: 'Pixel', type: 'Smartphone', is_active: true, is_restricted: false },
            };
            const confirmedState = await dj.getPlaybackState();
            assert.strictEqual(dj.hasConfirmedPlayback(), true);
            assert.strictEqual(Boolean(confirmedState?.__optimisticFallback), false);
            assert.strictEqual(confirmedState?.is_playing, true);
        });

        it('uses empty-body resume() instead of re-sending { uris } when unconfirmed session track is already loaded paused on Spotify (with fallback & jump-index safety)', async (t) => {
            const baseNow = new Date(2026, 10, 13, 2, 30, 0, 0).getTime();
            t.mock.timers.enable({ apis: ['Date'], now: baseNow });

            const dj = new DJCore('fake_token');
            dj.setSchedule([{ start: '00:00', end: '23:59', query: 'synthpop classics' }]);

            const djTracks = [
                makeTrack({ id: 'sp1', uri: 'spotify:track:sp1', name: 'Take on Me', artistName: 'a-ha' }),
                makeTrack({ id: 'sp2', uri: 'spotify:track:sp2', name: 'I Want That Man', artistName: 'Deborah Harry' }),
                makeTrack({ id: 'sp3', uri: 'spotify:track:sp3', name: "I'm Every Woman", artistName: 'Chaka Khan' }),
            ];

            const currentState: unknown = {
                is_playing: false,
                progress_ms: 0,
                item: djTracks[0],
                context: null,
                device: { id: 'phone_1', name: 'Pixel', type: 'Smartphone', is_active: true, is_restricted: false },
            };
            let resumeOk = true;
            const resumeCalls: (string | undefined)[] = [];
            const startedUrisHistory: string[][] = [];

            const djInternal = dj as unknown as {
                spotify: { getMyCurrentPlaybackState: () => Promise<unknown> };
                playerClient: {
                    getDevices: () => Promise<SpotifyApi.UserDevice[]>;
                    getActiveDeviceId: () => string | null;
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: (_devId: string, uris: string[]) => Promise<void>;
                    resume: (deviceId?: string) => Promise<{ ok: boolean }>;
                    clearLastError: () => void;
                    getLastError: () => null;
                };
                searchTracks: () => Promise<Track[]>;
                lastRefillAttemptTime: number;
            };
            djInternal.spotify.getMyCurrentPlaybackState = async () => currentState;
            djInternal.playerClient.getDevices = async () => [
                { id: 'phone_1', name: 'Pixel', type: 'Smartphone', is_active: true, is_restricted: false } as SpotifyApi.UserDevice,
            ];
            djInternal.playerClient.getActiveDeviceId = () => 'phone_1';
            djInternal.playerClient.resolveTargetDevice = async () => 'phone_1';
            djInternal.playerClient.startPlaybackOnDevice = async (_devId: string, uris: string[]) => {
                startedUrisHistory.push(uris);
            };
            djInternal.playerClient.resume = async (deviceId?: string) => {
                resumeCalls.push(deviceId);
                return { ok: resumeOk };
            };
            djInternal.playerClient.clearLastError = () => {};
            djInternal.playerClient.getLastError = () => null;
            djInternal.searchTracks = async () => djTracks;

            // Simulate leftover 60s cooldown from an earlier session -> New Session Started must clear lastRefillAttemptTime!
            djInternal.lastRefillAttemptTime = baseNow - 5_000;
            await dj.processDJLoop(false, true);
            assert.strictEqual(djInternal.lastRefillAttemptTime, 0);
            assert.strictEqual(startedUrisHistory.length, 1);
            assert.strictEqual(dj.hasConfirmedPlayback(), false);

            // 1. User taps Play in PlayerBar while Track 1 is loaded paused -> sends bare resume('phone_1'), NOT { uris }!
            //    Preserves lastPlayTime so PlayerContext.handleTogglePlay registers its convergence guard.
            t.mock.timers.setTime(baseNow + 5_000);
            const playTimeBeforeManualResume = dj.getLastPlayTime();
            const manualRes = await dj.resume();
            assert.strictEqual(manualRes.ok, true);
            assert.deepStrictEqual(resumeCalls, ['phone_1']);
            assert.strictEqual(startedUrisHistory.length, 1);
            assert.strictEqual(dj.getLastPlayTime(), playTimeBeforeManualResume);

            // 2. Background checkAndRefillQueue at +16s while unconfirmed & loaded paused:
            //    fires exactly ONE bare resume('phone_1') (does NOT double-fire on top of getPlaybackState's kick or re-send { uris })!
            t.mock.timers.setTime(baseNow + 16_000);
            await dj.processDJLoop(true, false);
            await Promise.resolve();
            assert.strictEqual(resumeCalls.length, 2);
            assert.strictEqual(startedUrisHistory.length, 1);

            //    And past 30s (where getPlaybackState no longer auto-kicks), checkAndRefillQueue directly sends bare resume('phone_1')!
            t.mock.timers.setTime(baseNow + 35_000);
            await dj.processDJLoop(true, false);
            assert.strictEqual(resumeCalls.length, 3);
            assert.strictEqual(startedUrisHistory.length, 1);

            // 3. 2nd manual tap while still paused escalates directly to startPlaybackOnDevice({ uris }) without another bare resume;
            //    and on a fresh unconfirmed session where bare resume returns { ok: false }, dj.resume() immediately falls back to { uris }!
            const escalatedRes = await dj.resume();
            assert.strictEqual(escalatedRes.ok, true);
            assert.strictEqual(resumeCalls.length, 3);
            assert.strictEqual(startedUrisHistory.length, 2);
            assert.deepStrictEqual(startedUrisHistory[1], ['spotify:track:sp1', 'spotify:track:sp2', 'spotify:track:sp3']);

            resumeOk = false;
            const fallbackRes = await dj.resume();
            assert.strictEqual(fallbackRes.ok, true);
            assert.strictEqual(resumeCalls.length, 4);
            assert.strictEqual(startedUrisHistory.length, 3);
            assert.deepStrictEqual(startedUrisHistory[2], ['spotify:track:sp1', 'spotify:track:sp2', 'spotify:track:sp3']);

            // 4. Mid-session jump safety: user jumps to sp3 (index 2), but Spotify is still paused on old sp1 (index 0 < 2) ->
            //    dj.resume() must NOT bare-resume sp1; it must start [sp3]!
            resumeOk = true;
            await dj.playFromQueueIndex(1, [djTracks[1], djTracks[2]]); // jumps to sp3 (sessionStartIndex = 2)
            assert.strictEqual(dj.getSessionCache().getSessionStartIndex(), 2);
            assert.strictEqual(startedUrisHistory.length, 4);
            // Spotify state is still stuck on djTracks[0] (sp1, index 0 < sessionStartIndex 2)
            await dj.resume();
            assert.strictEqual(resumeCalls.length, 4); // did NOT bare-resume sp1!
            assert.strictEqual(startedUrisHistory.length, 5);
            assert.deepStrictEqual(startedUrisHistory[4], ['spotify:track:sp3']);
        });

        it('aborts in-flight playTracks cleanly if user explicitly pauses before startPlaybackOnDevice resolves', async () => {
            const dj = new DJCore('fake_token');
            const djTracks = [
                makeTrack({ id: 'p1', uri: 'spotify:track:p1', name: 'Track 1', artistName: 'Artist' }),
                makeTrack({ id: 'p2', uri: 'spotify:track:p2', name: 'Track 2', artistName: 'Artist' }),
            ];

            let observedAbortFlag = false;
            let tracksPlayedCallbackFired = false;
            dj.setOnTracksPlayedCallback(() => {
                tracksPlayedCallbackFired = true;
            });

            const djInternal = dj as unknown as {
                playerClient: {
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: (_devId: string, _uris: string[], opts?: { shouldAbort?: () => boolean }) => Promise<void>;
                    pause: () => Promise<{ ok: boolean }>;
                };
            };
            djInternal.playerClient.resolveTargetDevice = async () => 'phone_1';
            djInternal.playerClient.pause = async () => ({ ok: true });
            djInternal.playerClient.startPlaybackOnDevice = async (_devId, _uris, opts) => {
                assert.strictEqual(opts?.shouldAbort?.(), false);
                await dj.pause();
                observedAbortFlag = Boolean(opts?.shouldAbort?.());
            };

            await dj.playTracks(djTracks, { isDJSession: true });

            assert.strictEqual(observedAbortFlag, true);
            assert.strictEqual(tracksPlayedCallbackFired, false);
            assert.strictEqual(dj.getLastPlayTime(), 0);
            assert.strictEqual(dj.hasConfirmedPlayback(), false);
            assert.strictEqual(dj.getSessionCache().getSessionTracks().length, 2);
        });

        it('coordinates onResumeKickSent with post-kick mirage grace, passes { silent: true } on speculative/background kicks, and notifies onDevicesUpdated before play', async (t) => {
            const baseNow = new Date(2026, 10, 13, 2, 45, 0, 0).getTime();
            t.mock.timers.enable({ apis: ['Date'], now: baseNow });

            const dj = new DJCore('fake_token');
            dj.setSchedule([{ start: '00:00', end: '23:59', query: 'night synth' }]);
            const djTracks = [
                makeTrack({ id: 't1', uri: 'spotify:track:t1', name: 'Take On Me - 2015 Remaster', artistName: 'a-ha' }),
                makeTrack({ id: 't2', uri: 'spotify:track:t2', name: 'Blue Monday', artistName: 'New Order' }),
            ];

            const eventOrder: string[] = [];
            let capturedTrackKeys: string[] | undefined;
            const resumeInvocations: { deviceId?: string; options?: { silent?: boolean } }[] = [];
            let currentState: unknown = {
                is_playing: false,
                progress_ms: 0,
                item: djTracks[0],
                context: null,
                device: { id: 'phone_1', name: 'Pixel', type: 'Smartphone', is_active: true, is_restricted: false },
            };

            dj.setOnDevicesUpdatedCallback((devs) => {
                eventOrder.push(`devices:${devs[0]?.id}`);
            });

            const djInternal = dj as unknown as {
                spotify: { getMyCurrentPlaybackState: (opts?: unknown) => Promise<unknown> };
                playerClient: {
                    getDevices: () => Promise<SpotifyApi.UserDevice[]>;
                    getActiveDeviceId: () => string | null;
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: (
                        _devId: string,
                        _uris: string[],
                        opts?: { expectedTrackKeys?: string[]; onResumeKickSent?: () => void }
                    ) => Promise<void>;
                    resume: (deviceId?: string, options?: { silent?: boolean }) => Promise<{ ok: boolean }>;
                    clearLastError: () => void;
                    getLastError: () => null;
                };
                searchTracks: () => Promise<Track[]>;
            };
            djInternal.spotify.getMyCurrentPlaybackState = async () => currentState;
            djInternal.playerClient.getDevices = async () => [
                { id: 'phone_1', name: 'Pixel', type: 'Smartphone', is_active: true, is_restricted: false } as SpotifyApi.UserDevice,
            ];
            djInternal.playerClient.getActiveDeviceId = () => 'phone_1';
            djInternal.playerClient.resolveTargetDevice = async () => 'phone_1';
            djInternal.playerClient.startPlaybackOnDevice = async (_devId, _uris, opts) => {
                eventOrder.push('startPlaybackOnDevice');
                capturedTrackKeys = opts?.expectedTrackKeys;
                opts?.onResumeKickSent?.();
            };
            djInternal.playerClient.resume = async (deviceId, options) => {
                resumeInvocations.push({ deviceId, options });
                return { ok: true };
            };
            djInternal.playerClient.clearLastError = () => {};
            djInternal.playerClient.getLastError = () => null;
            djInternal.searchTracks = async () => djTracks;

            await dj.processDJLoop(false, true);

            // 1. Fresh devices callback fired BEFORE startPlaybackOnDevice so mobile Keep-Alive Audio Focus can release first
            assert.deepStrictEqual(eventOrder, ['devices:phone_1', 'startPlaybackOnDevice']);
            assert.deepStrictEqual(capturedTrackKeys, ['take on me|a-ha', 'blue monday|new order']);

            // 2. Immediate poll at +350ms after onResumeKickSent does NOT double-kick within 1500ms cooldown
            t.mock.timers.setTime(baseNow + 350);
            await dj.getPlaybackState();
            await Promise.resolve();
            assert.strictEqual(resumeInvocations.length, 0);

            // 3. At +3800ms, still paused -> fires silent kick #1; then at +4200ms (> 4000ms STARTUP_GRACE_MS, but < 2200ms post-kick grace),
            //    a transient 0ms cloud mirage stays guarded (__optimisticFallback: true, unconfirmed) until audio advances!
            t.mock.timers.setTime(baseNow + 3800);
            await dj.getPlaybackState();
            await Promise.resolve();
            assert.strictEqual(resumeInvocations.length, 1);
            assert.deepStrictEqual(resumeInvocations[0], { deviceId: 'phone_1', options: { silent: true } });

            t.mock.timers.setTime(baseNow + 4200);
            currentState = {
                is_playing: true,
                progress_ms: 0,
                item: djTracks[0],
                context: null,
                device: { id: 'phone_1', name: 'Pixel', type: 'Smartphone', is_active: true, is_restricted: false },
            };
            const postKickMirage = await dj.getPlaybackState();
            assert.strictEqual(dj.hasConfirmedPlayback(), false);
            assert.strictEqual(Boolean(postKickMirage?.__optimisticFallback), true);
        });

        it('escalates 2nd manual Play tap to full playTracks({ uris }) when bare resume returns 204 without starting playback, and guards next() after stalled queue jump', async (t) => {
            const baseNow = new Date(2026, 10, 13, 3, 0, 0, 0).getTime();
            t.mock.timers.enable({ apis: ['Date'], now: baseNow });

            const dj = new DJCore('fake_token');
            const djTracks = [
                makeTrack({ id: 's1', uri: 'spotify:track:s1', name: 'Song 1', artistName: 'Artist' }),
                makeTrack({ id: 's2', uri: 'spotify:track:s2', name: 'Song 2', artistName: 'Artist' }),
                makeTrack({ id: 's3', uri: 'spotify:track:s3', name: 'Song 3', artistName: 'Artist' }),
            ];

            const currentState = {
                is_playing: false,
                progress_ms: 0,
                item: djTracks[0],
                context: null,
                device: { id: 'phone_1', name: 'Pixel', type: 'Smartphone', is_active: true, is_restricted: false },
            };
            const resumeCalls: { deviceId?: string; silent?: boolean }[] = [];
            const startedUrisHistory: string[][] = [];
            let nextTransportCalls = 0;

            const djInternal = dj as unknown as {
                spotify: { getMyCurrentPlaybackState: () => Promise<unknown> };
                playerClient: {
                    getActiveDeviceId: () => string | null;
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: (_devId: string, uris: string[]) => Promise<void>;
                    resume: (deviceId?: string, opts?: { silent?: boolean }) => Promise<{ ok: boolean; status: number }>;
                    next: () => Promise<{ ok: boolean }>;
                    clearLastError: () => void;
                    getLastError: () => null;
                };
            };
            djInternal.spotify.getMyCurrentPlaybackState = async () => currentState;
            djInternal.playerClient.getActiveDeviceId = () => 'phone_1';
            djInternal.playerClient.resolveTargetDevice = async () => 'phone_1';
            djInternal.playerClient.startPlaybackOnDevice = async (_devId, uris) => {
                startedUrisHistory.push(uris);
            };
            // Simulate stopped mobile audio engine that returns HTTP 204 (`ok: true`) to bare resume without starting audio
            djInternal.playerClient.resume = async (deviceId, opts) => {
                resumeCalls.push({ deviceId, silent: opts?.silent });
                return { ok: true, status: 204 };
            };
            djInternal.playerClient.next = async () => {
                nextTransportCalls++;
                return { ok: true };
            };
            djInternal.playerClient.clearLastError = () => {};
            djInternal.playerClient.getLastError = () => null;

            await dj.playTracks(djTracks, { isDJSession: true });
            assert.strictEqual(startedUrisHistory.length, 1);

            // 1st manual Play tap: attempts silent empty-body resume without resetting { uris }
            let stateFetchCount = 0;
            djInternal.spotify.getMyCurrentPlaybackState = async () => {
                stateFetchCount++;
                return currentState;
            };
            t.mock.timers.setTime(baseNow + 5_000);
            const firstTap = await dj.resume();
            assert.strictEqual(firstTap.ok, true);
            assert.strictEqual(resumeCalls.length, 1);
            assert.strictEqual(resumeCalls[0].silent, true);
            assert.strictEqual(startedUrisHistory.length, 1);
            assert.strictEqual(stateFetchCount, 1);

            // 2nd manual Play tap while Spotify is STILL paused: escalates directly to full playTracks({ uris })
            // WITHOUT calling playerClient.resume() again or polling getMyCurrentPlaybackState() at 0ms!
            t.mock.timers.setTime(baseNow + 12_000);
            const secondTap = await dj.resume();
            assert.strictEqual(secondTap.ok, true);
            assert.strictEqual(resumeCalls.length, 1);
            assert.strictEqual(stateFetchCount, 2);
            assert.strictEqual(startedUrisHistory.length, 2);
            assert.deepStrictEqual(startedUrisHistory[1], ['spotify:track:s1', 'spotify:track:s2', 'spotify:track:s3']);

            // User jumps to s2 (index 1), Spotify remains settled paused on old s1 (index 0) past STARTUP_GRACE_MS, then user taps Next ->
            // starts [s3] via playTracks instead of advancing stale s1 -> s2!
            await dj.playFromQueueIndex(0, [djTracks[1], djTracks[2]]);
            assert.strictEqual(dj.getSessionCache().getSessionStartIndex(), 1);
            assert.strictEqual(startedUrisHistory.length, 3);
            t.mock.timers.setTime(baseNow + 20_000);
            await dj.next();
            assert.strictEqual(nextTransportCalls, 0);
            assert.strictEqual(startedUrisHistory.length, 4);
            assert.deepStrictEqual(startedUrisHistory[3], ['spotify:track:s3']);
        });

        it('suppresses premature startup kicks/recovery while playTracks() is in flight, protects 0ms mirage on foreground focus, and fires onDevicesUpdated exactly once via native client', async (t) => {
            const baseNow = new Date(2026, 10, 13, 3, 15, 0, 0).getTime();
            t.mock.timers.enable({ apis: ['Date'], now: baseNow });

            const dj = new DJCore('fake_token');
            dj.setSchedule([{ start: '00:00', end: '23:59', query: '80s synthpop' }]);
            const djTracks = [
                makeTrack({ id: 't1', uri: 'spotify:track:t1', name: 'Take on Me', artistName: 'a-ha' }),
                makeTrack({ id: 't2', uri: 'spotify:track:t2', name: 'I Want That Man', artistName: 'Deborah Harry' }),
            ];

            // 1. Verify DJCore.getDevices() with native SpotifyPlayerClient.getDevices invokes onDevicesUpdated ONCE (not twice!)
            let devicesCallbackCount = 0;
            dj.setOnDevicesUpdatedCallback(() => {
                devicesCallbackCount++;
            });

            const djInternal = dj as unknown as {
                spotify: {
                    getMyDevices: () => Promise<{ devices: SpotifyApi.UserDevice[] }>;
                    getMyCurrentPlaybackState: () => Promise<unknown>;
                };
                playerClient: {
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: (_devId: string, uris: string[]) => Promise<void>;
                    resume: (deviceId?: string) => Promise<{ ok: boolean }>;
                    ensurePlaybackModes: () => Promise<void>;
                };
                checkAndRefillQueue: (queries: string[], item: ScheduleItem, isForeground?: boolean) => Promise<void>;
                startupResumeKickCount: number;
            };

            djInternal.spotify.getMyDevices = async () => ({
                devices: [
                    { id: 'phone_1', name: 'Pixel', type: 'Smartphone', is_active: true, is_restricted: false } as SpotifyApi.UserDevice,
                ],
            });
            const fetchedDevices = await dj.getDevices();
            assert.strictEqual(fetchedDevices.length, 1);
            assert.strictEqual(devicesCallbackCount, 1);

            // And if getMyDevices throws a transient error, onDevicesUpdated is NOT invoked with an empty fallback
            djInternal.spotify.getMyDevices = async () => {
                throw Object.assign(new Error('Server Error'), { status: 503 });
            };
            const errorDevices = await dj.getDevices();
            assert.deepStrictEqual(errorDevices, []);
            assert.strictEqual(devicesCallbackCount, 1);

            // 2. While playTracks() is in flight (even across > 4s STARTUP_GRACE_MS), concurrent getPlaybackState()
            //    and checkAndRefillQueue() must NOT fire startup kicks, consume startupResumeKickCount, or abort playTracks!
            let currentState: unknown = {
                is_playing: false,
                progress_ms: 0,
                item: djTracks[0],
                context: null,
                device: { id: 'phone_1', name: 'Pixel', type: 'Smartphone', is_active: true, is_restricted: false },
            };
            djInternal.spotify.getMyCurrentPlaybackState = async () => currentState;
            djInternal.spotify.getMyDevices = async () => ({
                devices: [
                    { id: 'phone_1', name: 'Pixel', type: 'Smartphone', is_active: true, is_restricted: false } as SpotifyApi.UserDevice,
                ],
            });

            const resumeCalls: (string | undefined)[] = [];
            const startedBatches: string[][] = [];
            let ensureModesCalls = 0;
            let resolveInFlightPlay!: () => void;
            const inFlightBarrier = new Promise<void>((res) => {
                resolveInFlightPlay = res;
            });

            djInternal.playerClient.resolveTargetDevice = async () => 'phone_1';
            djInternal.playerClient.startPlaybackOnDevice = async (_devId, uris) => {
                startedBatches.push(uris);
                await inFlightBarrier;
            };
            djInternal.playerClient.resume = async (deviceId) => {
                resumeCalls.push(deviceId);
                return { ok: true };
            };
            djInternal.playerClient.ensurePlaybackModes = async () => {
                ensureModesCalls++;
            };

            const playPromise = dj.playTracks(djTracks, { isDJSession: true });

            // Before playTracks resolves, lastPlayTime is still 0 (not prematurely stamped)
            assert.strictEqual(dj.getLastPlayTime(), 0);

            // Simulate concurrent UI & DJ loop polls at +1000ms and +5000ms (> STARTUP_GRACE_MS) while playTracks is in flight
            t.mock.timers.setTime(baseNow + 1_000);
            await dj.getPlaybackState();
            await djInternal.checkAndRefillQueue(['80s synthpop'], { start: '00:00', end: '23:59', query: '80s synthpop' }, false);

            t.mock.timers.setTime(baseNow + 5_000);
            await dj.getPlaybackState();
            await djInternal.checkAndRefillQueue(['80s synthpop'], { start: '00:00', end: '23:59', query: '80s synthpop' }, true);
            await Promise.resolve();

            // Zero premature kicks, zero kick budget consumed, and in-flight playTracks was NOT re-triggered!
            assert.strictEqual(resumeCalls.length, 0);
            assert.strictEqual(djInternal.startupResumeKickCount, 0);
            assert.strictEqual(startedBatches.length, 1);
            assert.strictEqual(ensureModesCalls, 0);

            // Tapping Play (dj.resume()) while playTracks() is already in flight joins the active promise instead of aborting/restarting it!
            const joinedResumePromise = dj.resume();
            assert.strictEqual(startedBatches.length, 1);

            // Now complete startPlaybackOnDevice at +5200ms -> stamps lastPlayTime = baseNow + 5200 and preserves full 2-kick budget!
            t.mock.timers.setTime(baseNow + 5_200);
            resolveInFlightPlay();
            await playPromise;
            const joinedResumeRes = await joinedResumePromise;
            assert.strictEqual(joinedResumeRes.ok, true);
            assert.strictEqual(startedBatches.length, 1);
            assert.strictEqual(dj.getLastPlayTime(), baseNow + 5_200);
            assert.strictEqual(djInternal.startupResumeKickCount, 0);

            // 3. Foreground focus at +7200ms (2.0s after playTracks finished) while Track 1 is at 0ms cloud mirage (`is_playing: true, progress_ms: 0`):
            //    checkAndRefillQueue(..., true) must NOT reset `{ uris }` via tryStartPendingSessionTracks!
            t.mock.timers.setTime(baseNow + 7_200);
            currentState = {
                is_playing: true,
                progress_ms: 0,
                item: djTracks[0],
                context: null,
                device: { id: 'phone_1', name: 'Pixel', type: 'Smartphone', is_active: true, is_restricted: false },
            };
            dj.notifyForegrounded();
            await dj.processDJLoop(true, false);
            assert.strictEqual(startedBatches.length, 1);
            assert.strictEqual(resumeCalls.length, 0);

            // 4. Post-start paused poll still has all 2 startup kicks available (`+8000ms` and `+9800ms`)
            currentState = {
                is_playing: false,
                progress_ms: 0,
                item: djTracks[0],
                context: null,
                device: { id: 'phone_1', name: 'Pixel', type: 'Smartphone', is_active: true, is_restricted: false },
            };
            t.mock.timers.setTime(baseNow + 8_000);
            await dj.getPlaybackState();
            await Promise.resolve();
            assert.strictEqual(resumeCalls.length, 1);

            t.mock.timers.setTime(baseNow + 9_800);
            await dj.getPlaybackState();
            await Promise.resolve();
            assert.strictEqual(resumeCalls.length, 2);
        });

        it('handles in-flight pause->resume generation handoff, optimistic in-flight polls, 2nd-kick forcePlayTransfer, confirmed/restored 2nd-tap escalation, and post-grace queue-jump safety', async (t) => {
            const baseNow = new Date(2026, 10, 13, 3, 30, 0, 0).getTime();
            t.mock.timers.enable({ apis: ['Date'], now: baseNow });

            const djTracks = [
                makeTrack({ id: 'q1', uri: 'spotify:track:q1', name: 'Take on Me', artistName: 'a-ha' }),
                makeTrack({ id: 'q2', uri: 'spotify:track:q2', name: 'I Want That Man', artistName: 'Deborah Harry' }),
                makeTrack({ id: 'q3', uri: 'spotify:track:q3', name: "I'm Every Woman", artistName: 'Whitney Houston' }),
            ];

            // 1. Pausing during resolveTargetDevice() aborts before startPlaybackOnDevice() is ever called;
            //    and pausing during startPlaybackOnDevice() followed immediately by resume() keeps old shouldAbort() === true!
            const djRace = new DJCore('fake_token');
            let resolveDevBarrier!: (id: string) => void;
            let startCalls = 0;
            let finishFirstStart!: () => void;
            let capturedFirstShouldAbort: (() => boolean) | undefined;
            const startedRaceBatches: string[][] = [];

            const raceInternal = djRace as unknown as {
                spotify: { getMyCurrentPlaybackState: () => Promise<unknown> };
                playerClient: {
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: (_devId: string, uris: string[], opts?: { shouldAbort?: () => boolean }) => Promise<void>;
                    pause: () => Promise<{ ok: boolean }>;
                    resume: (deviceId?: string, opts?: { silent?: boolean }) => Promise<{ ok: boolean }>;
                    clearLastError: () => void;
                    getLastError: () => null;
                };
            };
            raceInternal.spotify.getMyCurrentPlaybackState = async () => null;
            raceInternal.playerClient.pause = async () => ({ ok: true });
            raceInternal.playerClient.resume = async () => ({ ok: true });
            raceInternal.playerClient.clearLastError = () => {};
            raceInternal.playerClient.getLastError = () => null;
            raceInternal.playerClient.resolveTargetDevice = () =>
                new Promise<string>((res) => {
                    resolveDevBarrier = res;
                });
            raceInternal.playerClient.startPlaybackOnDevice = async (_devId, uris) => {
                startCalls++;
                startedRaceBatches.push(uris);
            };

            const abortedDuringResolve = djRace.playTracks(djTracks, { isDJSession: true });
            // Concurrent UI poll while playTracks is in flight returns optimistic is_playing: true (never flashes false pause)
            const inFlightPollState = await djRace.getPlaybackState();
            assert.strictEqual(Boolean(inFlightPollState?.__optimisticFallback), true);
            assert.strictEqual(inFlightPollState?.is_playing, true);

            await djRace.pause();
            resolveDevBarrier('phone_1');
            await abortedDuringResolve;
            assert.strictEqual(startCalls, 0);

            // Now start playTracks #2, pause while startPlaybackOnDevice #2 is sleeping, and IMMEDIATELY call djRace.resume()
            // BEFORE startPlaybackOnDevice #2 wakes up -> old shouldAbort() MUST stay true!
            raceInternal.playerClient.resolveTargetDevice = async () => 'phone_1';
            raceInternal.playerClient.startPlaybackOnDevice = async (_devId, uris, opts) => {
                startCalls++;
                startedRaceBatches.push(uris);
                if (startCalls === 1) {
                    capturedFirstShouldAbort = opts?.shouldAbort;
                    await new Promise<void>((res) => {
                        finishFirstStart = res;
                    });
                }
            };

            const inFlightPlay2 = djRace.playTracks(djTracks, { isDJSession: true });
            await Promise.resolve();
            assert.strictEqual(startCalls, 1);
            assert.strictEqual(capturedFirstShouldAbort?.(), false);

            await djRace.pause();
            assert.strictEqual(capturedFirstShouldAbort?.(), true);

            // Immediate resume() resets userExplicitlyPaused = false, yet old generation's shouldAbort() remains permanently true!
            const resumedAfterPause = await djRace.resume();
            assert.strictEqual(resumedAfterPause.ok, true);
            assert.strictEqual(capturedFirstShouldAbort?.(), true);
            assert.strictEqual(startCalls, 2);

            finishFirstStart();
            await inFlightPlay2;
            assert.strictEqual(djRace.getLastPlayTime() > 0, true);

            // 2. Storage-restored unconfirmed session & confirmed dormant session:
            //    - 1st manual tap does NOT prematurely confirm paused playback;
            //    - 2nd manual tap while still paused escalates to playTracks({ uris }) from loadedIdx;
            //    - Explicit pause() resets manualBareResumeAttempted so resuming after intentional pause uses bare resume;
            //    - 2nd startup kick passes { silent: true, forcePlayTransfer: true };
            //    - Post-STARTUP_GRACE_MS poll after mid-session queue jump never kicks or reverts to stale pre-jump track!
            localStorage.setItem(STORAGE_KEYS.DJ_CURRENT_SESSION_TRACKS, JSON.stringify(djTracks));
            const djRestored = new DJCore('fake_token');

            let restoredState: unknown = {
                is_playing: false,
                progress_ms: 0,
                item: djTracks[1], // paused on q2 (index 1)
                context: null,
                device: { id: 'phone_1', name: 'Pixel', type: 'Smartphone', is_active: true, is_restricted: false },
            };
            const restoredResumeCalls: { deviceId?: string; options?: { silent?: boolean; forcePlayTransfer?: boolean } }[] = [];
            const restoredBatches: string[][] = [];

            const restoredInternal = djRestored as unknown as {
                spotify: { getMyCurrentPlaybackState: () => Promise<unknown> };
                playerClient: {
                    getActiveDeviceId: () => string | null;
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: (_devId: string, uris: string[]) => Promise<void>;
                    pause: () => Promise<{ ok: boolean }>;
                    resume: (deviceId?: string, options?: { silent?: boolean; forcePlayTransfer?: boolean }) => Promise<{ ok: boolean; status: number }>;
                    clearLastError: () => void;
                    getLastError: () => null;
                };
            };
            restoredInternal.spotify.getMyCurrentPlaybackState = async () => restoredState;
            restoredInternal.playerClient.getActiveDeviceId = () => 'phone_1';
            restoredInternal.playerClient.resolveTargetDevice = async () => 'phone_1';
            restoredInternal.playerClient.startPlaybackOnDevice = async (_devId, uris) => {
                restoredBatches.push(uris);
            };
            restoredInternal.playerClient.pause = async () => ({ ok: true });
            restoredInternal.playerClient.resume = async (deviceId, options) => {
                restoredResumeCalls.push({ deviceId, options });
                return { ok: true, status: 204 };
            };
            restoredInternal.playerClient.clearLastError = () => {};
            restoredInternal.playerClient.getLastError = () => null;

            // 1st manual tap on storage-restored paused session -> bare resume, does NOT falsely mark confirmed!
            await djRestored.resume();
            assert.strictEqual(restoredResumeCalls.length, 1);
            assert.strictEqual(djRestored.hasConfirmedPlayback(), false);
            assert.strictEqual(restoredBatches.length, 0);

            // 2nd manual tap while still paused -> escalates directly to playTracks([q2, q3])!
            await djRestored.resume();
            assert.strictEqual(restoredResumeCalls.length, 1);
            assert.strictEqual(restoredBatches.length, 1);
            assert.deepStrictEqual(restoredBatches[0], ['spotify:track:q2', 'spotify:track:q3']);

            // Confirm playback on q2 (progress_ms > 0), then simulate dormant paused state on q2:
            t.mock.timers.setTime(baseNow + 5_000);
            restoredState = {
                is_playing: true,
                progress_ms: 2_500,
                item: djTracks[1],
                context: null,
                device: { id: 'phone_1', name: 'Pixel', type: 'Smartphone', is_active: true, is_restricted: false },
            };
            await djRestored.getPlaybackState();
            assert.strictEqual(djRestored.hasConfirmedPlayback(), true);

            // User explicitly pauses -> then resumes -> uses bare resume (not escalated); if dormant afterwards, 2nd tap escalates!
            await djRestored.pause();
            restoredState = {
                is_playing: false,
                progress_ms: 2_500,
                item: djTracks[1],
                context: null,
                device: { id: 'phone_1', name: 'Pixel', type: 'Smartphone', is_active: true, is_restricted: false },
            };
            await djRestored.resume(); // 1st tap after explicit pause -> bare resume
            assert.strictEqual(restoredResumeCalls.length, 2);
            assert.strictEqual(restoredBatches.length, 1);

            await djRestored.resume(); // 2nd tap while still paused -> escalates even on previously confirmed session!
            assert.strictEqual(restoredResumeCalls.length, 2);
            assert.strictEqual(restoredBatches.length, 2);
            assert.deepStrictEqual(restoredBatches[1], ['spotify:track:q2', 'spotify:track:q3']);

            // Verify Kick #1 sends { silent: true } and Kick #2 escalates to { silent: true, forcePlayTransfer: true }
            t.mock.timers.setTime(baseNow + 7_000);
            await djRestored.getPlaybackState();
            await Promise.resolve();
            assert.strictEqual(restoredResumeCalls.length, 3);
            assert.deepStrictEqual(restoredResumeCalls[2], { deviceId: 'phone_1', options: { silent: true } });

            t.mock.timers.setTime(baseNow + 9_000);
            await djRestored.getPlaybackState();
            await Promise.resolve();
            assert.strictEqual(restoredResumeCalls.length, 4);
            assert.deepStrictEqual(restoredResumeCalls[3], {
                deviceId: 'phone_1',
                options: { silent: true, forcePlayTransfer: true },
            });

            // Jump to q3 (index 2) while Spotify remains stuck paused on old q1 (index 0) past STARTUP_GRACE_MS (+6000ms):
            // getPlaybackState() must NOT kick stale q1 or overwrite lastPlayingTrack, and dj.resume() must play [q3]!
            t.mock.timers.setTime(baseNow + 10_000);
            await djRestored.playFromQueueIndex(0, [djTracks[2]]);
            assert.strictEqual(djRestored.getSessionCache().getSessionStartIndex(), 2);
            assert.strictEqual(restoredBatches.length, 3);

            restoredState = {
                is_playing: false,
                progress_ms: 0,
                item: djTracks[0], // stale q1 (index 0 < sessionStartIndex 2)
                context: null,
                device: { id: 'phone_1', name: 'Pixel', type: 'Smartphone', is_active: true, is_restricted: false },
            };
            t.mock.timers.setTime(baseNow + 16_000); // 6s after jump (> 4000ms STARTUP_GRACE_MS)
            await djRestored.getPlaybackState();
            await Promise.resolve();
            // Must NOT have sent a startup resume kick for stale q1!
            assert.strictEqual(restoredResumeCalls.length, 4);

            // Manual resume must start [q3] (index 2), NOT [q1, q2, q3]!
            await djRestored.resume();
            assert.strictEqual(restoredResumeCalls.length, 4);
            assert.strictEqual(restoredBatches.length, 4);
            assert.deepStrictEqual(restoredBatches[3], ['spotify:track:q3']);
        });

        it('reproduces and resolves frozen/BFGS-blocked Pixel 10 Pro XL playback without 8s fake playing mirage, stages 1-tap wake, recovers on wake/foreground, and skips mobileWakeRequired when targeting a non-mobile Speaker', async () => {
            const djTracks = [
                makeTrack({ id: 'j1', uri: 'spotify:track:j1', name: 'Waltz for Debby', artistName: 'Bill Evans' }),
                makeTrack({ id: 'j2', uri: 'spotify:track:j2', name: 'Blue in Green', artistName: 'Miles Davis' }),
                makeTrack({ id: 'j3', uri: 'spotify:track:j3', name: 'Autumn Leaves', artistName: 'Chet Baker' }),
            ];
            const mantecaExternal = makeTrack({
                id: 'manteca',
                uri: 'spotify:track:manteca',
                name: 'Manteca - Live',
                artistName: 'Dizzy Gillespie',
            });

            const dj = new DJCore('fake_token');
            let isFrozen = true;
            let currentState: unknown = {
                is_playing: false,
                progress_ms: 431_000,
                item: mantecaExternal,
                context: { type: 'album', uri: 'spotify:album:dizzy' },
                device: {
                    id: 'pixel_10_pro_xl',
                    name: 'Pixel 10 Pro XL',
                    type: 'Smartphone',
                    is_active: false,
                    is_restricted: false,
                },
            };

            const playedEvents: { tracks: Track[]; meta?: { confirmedPlaying: boolean; mobileWakeRequired: boolean } }[] = [];
            dj.setOnTracksPlayedCallback((tracks, meta) => {
                playedEvents.push({ tracks, meta });
            });

            const djInternal = dj as unknown as {
                mobileResumeVerifyDelayMs: number;
                mobileResumeRetryDelayMs: number;
                spotify: {
                    getMyDevices: () => Promise<{ devices: SpotifyApi.UserDevice[] }>;
                    getMyCurrentPlaybackState: () => Promise<unknown>;
                };
                playerClient: {
                    isMobileRuntime: () => boolean;
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: (devId: string, uris: string[]) => Promise<{
                        confirmedPlaying: boolean;
                        targetTrackLoaded: boolean;
                        targetDeviceId: string;
                        isMobileTarget: boolean;
                    }>;
                    resume: (deviceId?: string, opts?: { silent?: boolean; forcePlayTransfer?: boolean }) => Promise<{ ok: boolean; status: number }>;
                    getActiveDeviceId: () => string | null;
                    getPreferredDeviceId: () => string | null;
                    setActiveDevice: (id: string, opts?: { play?: boolean }) => Promise<{ ok: boolean; status: number }>;
                    clearLastError: () => void;
                    getLastError: () => null;
                };
                searchTracks: () => Promise<Track[]>;
            };

            djInternal.mobileResumeVerifyDelayMs = 0;
            djInternal.mobileResumeRetryDelayMs = 0;
            djInternal.searchTracks = async () => djTracks;

            let preferredId: string | null = null;
            let deviceList: SpotifyApi.UserDevice[] = [
                {
                    id: 'pixel_10_pro_xl',
                    name: 'Pixel 10 Pro XL',
                    type: 'Smartphone',
                    is_active: false,
                    is_restricted: false,
                } as SpotifyApi.UserDevice,
            ];

            djInternal.spotify.getMyDevices = async () => ({ devices: deviceList });
            djInternal.spotify.getMyCurrentPlaybackState = async () => currentState;
            djInternal.playerClient.isMobileRuntime = () => true;
            djInternal.playerClient.getActiveDeviceId = () => 'pixel_10_pro_xl';
            djInternal.playerClient.getPreferredDeviceId = () => preferredId;
            djInternal.playerClient.clearLastError = () => {};
            djInternal.playerClient.getLastError = () => null;
            djInternal.playerClient.resolveTargetDevice = async () => {
                await dj.getDevices();
                return preferredId || 'pixel_10_pro_xl';
            };
            djInternal.playerClient.setActiveDevice = async (id) => {
                preferredId = id;
                return { ok: true, status: 204 };
            };
            djInternal.playerClient.resume = async () => {
                if (!isFrozen) {
                    currentState = {
                        is_playing: true,
                        progress_ms: 431_500,
                        item: mantecaExternal,
                        context: { type: 'album', uri: 'spotify:album:dizzy' },
                        device: {
                            id: 'pixel_10_pro_xl',
                            name: 'Pixel 10 Pro XL',
                            type: 'Smartphone',
                            is_active: true,
                            is_restricted: false,
                        },
                    };
                }
                return { ok: true, status: 204 };
            };

            let startPlayCalls = 0;
            djInternal.playerClient.startPlaybackOnDevice = async (devId, uris) => {
                startPlayCalls++;
                const targetDev = deviceList.find(d => d.id === devId);
                const isMobileTarget = Boolean(targetDev && targetDev.type === 'Smartphone');
                if (isFrozen) {
                    return {
                        confirmedPlaying: false,
                        targetTrackLoaded: false,
                        targetDeviceId: devId,
                        isMobileTarget,
                    };
                }
                currentState = {
                    is_playing: true,
                    progress_ms: 420,
                    item: djTracks.find(t => t.uri === uris[0]) || djTracks[0],
                    context: null,
                    device: {
                        id: devId,
                        name: 'Pixel 10 Pro XL',
                        type: 'Smartphone',
                        is_active: true,
                        is_restricted: false,
                    },
                };
                return {
                    confirmedPlaying: true,
                    targetTrackLoaded: true,
                    targetDeviceId: devId,
                    isMobileTarget,
                };
            };

            // 1. Bare external Play tap on frozen Pixel 10 Pro XL ("Manteca - Live" paused, no DJ schedule yet):
            //    Must detect frozen non-starting phone and return `{ ok: false, mobileWakeRequired: true }` instead of faking ok!
            const bareFrozenResume = await dj.resume();
            assert.strictEqual(bareFrozenResume.ok, false);
            assert.strictEqual(bareFrozenResume.mobileWakeRequired, true);
            assert.strictEqual(dj.isMobileWakeRequired(), true);

            dj.clearMobileWakeRequired();
            assert.strictEqual(dj.isMobileWakeRequired(), false);

            // 2. AI Schedule execution while Pixel 10 Pro XL Spotify is frozen/BFGS-blocked:
            //    Must stage sessionTracks with `lastPlayTime === 0`, `confirmedPlaying === false`, `mobileWakeRequired === true`,
            //    preserve `📱` wake status, and NEVER emit fake `__optimisticFallback: true` in `getPlaybackState()`!
            dj.setSchedule([
                { start: '00:00', end: '23:59', query: 'bill evans piano jazz', thought: 'Midnight jazz' },
            ], true);
            await dj.processDJLoop(false, true);

            assert.strictEqual(startPlayCalls, 1);
            assert.strictEqual(dj.isMobileWakeRequired(), true);
            assert.strictEqual(dj.getLastPlayTime(), 0);
            assert.match(dj.getStateSnapshot().status, /^📱/);
            assert.strictEqual(playedEvents.length, 1);
            assert.deepStrictEqual(playedEvents[0].meta, {
                confirmedPlaying: false,
                mobileWakeRequired: true,
            });

            // Poll `getPlaybackState()` right after unconfirmed frozen start -> NO fake `__optimisticFallback: true`!
            const postFrozenPoll = await dj.getPlaybackState();
            assert.strictEqual(Boolean((postFrozenPoll as { __optimisticFallback?: boolean } | null)?.__optimisticFallback), false);
            assert.strictEqual(postFrozenPoll?.is_playing, false);

            // Up Next queue already holds curated Track 2 & Track 3 ready to go
            const stagedQueue = await dj.getQueue(djTracks[0]);
            assert.deepStrictEqual(stagedQueue.map(t => t.id), ['j2', 'j3']);

            // Background `processDJLoop(true, false)` does NOT spam `playTracks` while waiting for user's 1-tap wake
            await dj.processDJLoop(true, false);
            assert.strictEqual(startPlayCalls, 1);

            // 3. User taps "Spotifyを起動して再生" (`spotify:` unfreezes Spotify -> `dj.resume({ fromMobileWake: true })`):
            //    Immediately pushes staged `[j1, j2, j3]`, confirms playback, and clears `mobileWakeRequired`!
            isFrozen = false;
            const wakeResume = await dj.resume({ fromMobileWake: true });
            assert.strictEqual(wakeResume.ok, true);
            assert.strictEqual(startPlayCalls, 2);
            assert.strictEqual(dj.isMobileWakeRequired(), false);
            assert.strictEqual(dj.getLastPlayTime() > 0, true);
            assert.strictEqual(playedEvents.length, 2);
            assert.deepStrictEqual(playedEvents[1].meta, {
                confirmedPlaying: true,
                mobileWakeRequired: false,
            });

            // 4. When user explicitly selects a non-mobile Wi-Fi Speaker on a mobile browser, `canWakeLocalMobileSpotify()` is false
            //    so a paused speaker does NOT falsely ask to wake the phone's local Spotify app!
            isFrozen = true;
            deviceList = [
                {
                    id: 'pixel_10_pro_xl',
                    name: 'Pixel 10 Pro XL',
                    type: 'Smartphone',
                    is_active: false,
                    is_restricted: false,
                } as SpotifyApi.UserDevice,
                {
                    id: 'living_speaker',
                    name: 'Sonos Speaker',
                    type: 'Speaker',
                    is_active: true,
                    is_restricted: false,
                } as SpotifyApi.UserDevice,
            ];
            await dj.getDevices();
            await dj.setActiveDevice('living_speaker', { play: true });
            assert.strictEqual(dj.canWakeLocalMobileSpotify(), false);

            await dj.playTracks(djTracks, { isDJSession: true });
            assert.strictEqual(dj.isMobileWakeRequired(), false);
            assert.deepStrictEqual(playedEvents[playedEvents.length - 1].meta, {
                confirmedPlaying: false,
                mobileWakeRequired: false,
            });
        });

        it('curates & stages tracks in foreground on mobile when devices=[] without error, guards wake/resume from foreground refill races, and triggers mobileWakeRequired on frozen next/previous/queue-jump', async () => {
            const djTracks = [
                makeTrack({ id: 'm1', uri: 'spotify:track:m1', name: 'Sea Walk 1', artistName: 'Artist A' }),
                makeTrack({ id: 'm2', uri: 'spotify:track:m2', name: 'Sea Walk 2', artistName: 'Artist B' }),
                makeTrack({ id: 'm3', uri: 'spotify:track:m3', name: 'Sea Walk 3', artistName: 'Artist C' }),
            ];

            const dj = new DJCore('fake_token');
            let deviceList: SpotifyApi.UserDevice[] = [];
            let isFrozen = true;
            let currentState: unknown = null;
            const resumeOptionsLog: ({ silent?: boolean; forcePlayTransfer?: boolean } | undefined)[] = [];
            const playedEvents: { tracks: Track[]; meta?: { confirmedPlaying: boolean; mobileWakeRequired: boolean } }[] = [];

            dj.setOnTracksPlayedCallback((tracks, meta) => {
                playedEvents.push({ tracks, meta });
            });

            const djInternal = dj as unknown as {
                mobileResumeVerifyDelayMs: number;
                mobileResumeRetryDelayMs: number;
                spotify: {
                    getMyDevices: () => Promise<{ devices: SpotifyApi.UserDevice[] }>;
                    getMyCurrentPlaybackState: () => Promise<unknown>;
                };
                playerClient: {
                    isMobileRuntime: () => boolean;
                    getKnownDevice: (id: string) => SpotifyApi.UserDevice | null;
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: (devId: string, uris: string[]) => Promise<{
                        confirmedPlaying: boolean;
                        targetTrackLoaded: boolean;
                        targetDeviceId: string;
                        isMobileTarget: boolean;
                    }>;
                    resume: (deviceId?: string, opts?: { silent?: boolean; forcePlayTransfer?: boolean }) => Promise<{ ok: boolean; status: number }>;
                    next: () => Promise<{ ok: boolean; status: number }>;
                    previous: () => Promise<{ ok: boolean; status: number }>;
                    getActiveDeviceId: () => string | null;
                    getPreferredDeviceId: () => string | null;
                    clearLastError: () => void;
                    getLastError: () => null;
                };
                searchTracks: () => Promise<Track[]>;
            };

            djInternal.mobileResumeVerifyDelayMs = 0;
            djInternal.mobileResumeRetryDelayMs = 0;
            djInternal.searchTracks = async () => djTracks;
            djInternal.spotify.getMyDevices = async () => ({ devices: deviceList });
            djInternal.spotify.getMyCurrentPlaybackState = async () => currentState;
            djInternal.playerClient.isMobileRuntime = () => true;
            djInternal.playerClient.getKnownDevice = (id) => deviceList.find(d => d.id === id) ?? null;
            djInternal.playerClient.getActiveDeviceId = () => (deviceList[0]?.id ?? null);
            djInternal.playerClient.getPreferredDeviceId = () => null;
            djInternal.playerClient.clearLastError = () => {};
            djInternal.playerClient.getLastError = () => null;

            let startPlayCalls = 0;
            let releaseInFlightWakePlay: (() => void) | null = null;
            djInternal.playerClient.resolveTargetDevice = async () => {
                await dj.getDevices();
                if (deviceList.length === 0) {
                    throw new Error('404 No active device');
                }
                return deviceList[0].id!;
            };
            djInternal.playerClient.startPlaybackOnDevice = async (devId, uris) => {
                startPlayCalls++;
                if (releaseInFlightWakePlay) {
                    await new Promise<void>((r) => {
                        releaseInFlightWakePlay = r;
                    });
                }
                if (isFrozen) {
                    return {
                        confirmedPlaying: false,
                        targetTrackLoaded: false,
                        targetDeviceId: devId,
                        isMobileTarget: true,
                    };
                }
                currentState = {
                    is_playing: true,
                    progress_ms: 500,
                    item: djTracks.find(t => t.uri === uris[0]) || djTracks[0],
                    context: null,
                    device: { id: devId, name: 'Pixel 10 Pro XL', type: 'Smartphone', is_active: true, is_restricted: false },
                };
                return {
                    confirmedPlaying: true,
                    targetTrackLoaded: true,
                    targetDeviceId: devId,
                    isMobileTarget: true,
                };
            };
            djInternal.playerClient.resume = async (_devId, opts) => {
                resumeOptionsLog.push(opts);
                return { ok: true, status: 204 };
            };
            djInternal.playerClient.next = async () => ({ ok: true, status: 204 });
            djInternal.playerClient.previous = async () => ({ ok: true, status: 204 });

            // 1. Mobile `processDJLoop(false, true)` when `devices === []` (Spotify killed/frozen in background):
            //    Must curate tracks immediately in foreground without throwing `Please open Spotify`, stage Track 1,
            //    and set `mobileWakeRequired = true`!
            dj.setSchedule([{ start: '00:00', end: '23:59', query: 'ocean walk chill' }], true);
            await dj.processDJLoop(false, true);

            assert.strictEqual(startPlayCalls, 0);
            assert.strictEqual(dj.isMobileWakeRequired(), true);
            assert.strictEqual(dj.getSessionCache().getSessionTracks().length, 3);
            assert.strictEqual(dj.getLastPlayTime(), 0);
            assert.match(dj.getStateSnapshot().status, /^📱/);
            assert.strictEqual(playedEvents.length, 1);
            assert.deepStrictEqual(playedEvents[0].meta, {
                confirmedPlaying: false,
                mobileWakeRequired: true,
            });

            // 2. While `mobileWakeInProgress === true`, foreground `notifyForegrounded()` + `processDJLoop(true, false)`
            //    MUST NOT launch a competing `tryStartPendingSessionTracks` that aborts `dj.resume({ fromMobileWake: true })`!
            deviceList = [
                { id: 'pixel_10_pro_xl', name: 'Pixel 10 Pro XL', type: 'Smartphone', is_active: false, is_restricted: false } as SpotifyApi.UserDevice,
            ];
            isFrozen = false;
            dj.setMobileWakeInProgress(true);
            dj.notifyForegrounded();
            await dj.processDJLoop(true, false);
            assert.strictEqual(startPlayCalls, 0);

            let unblockPlay!: () => void;
            releaseInFlightWakePlay = () => {};
            const gatePromise = new Promise<void>((r) => {
                unblockPlay = r;
            });
            djInternal.playerClient.startPlaybackOnDevice = async (devId, uris) => {
                startPlayCalls++;
                await gatePromise;
                currentState = {
                    is_playing: true,
                    progress_ms: 500,
                    item: djTracks.find(t => t.uri === uris[0]) || djTracks[0],
                    context: null,
                    device: { id: devId, name: 'Pixel 10 Pro XL', type: 'Smartphone', is_active: true, is_restricted: false },
                };
                return {
                    confirmedPlaying: true,
                    targetTrackLoaded: true,
                    targetDeviceId: devId,
                    isMobileTarget: true,
                };
            };

            const wakeResumePromise = dj.resume({ fromMobileWake: true });
            assert.strictEqual(dj.isResumeInFlight(), true);
            dj.setMobileWakeInProgress(false);
            dj.notifyForegrounded();
            await dj.processDJLoop(true, false); // Must see `isResumeInFlight()` and NOT double-play!
            unblockPlay();
            const wakeRes = await wakeResumePromise;
            assert.strictEqual(wakeRes.ok, true);
            assert.strictEqual(startPlayCalls, 1);
            assert.strictEqual(dj.isMobileWakeRequired(), false);
            // Status automatically cleared from `📱 ...` back to `'Ready'`!
            assert.strictEqual(dj.getStateSnapshot().status, 'Ready');

            // 3. Mid-session queue jump (`playFromQueueIndex`) when mobile Spotify went asleep (`devices === []` -> 404):
            //    Stages the jumped track (`m3`, index 2) with `mobileWakeRequired = true` instead of rolling back to `m1`!
            await dj.getPlaybackState();
            assert.strictEqual(dj.hasConfirmedPlayback(), true);
            deviceList = [];
            await assert.rejects(() => dj.playFromQueueIndex(1, [djTracks[1], djTracks[2]]), /404/);
            assert.strictEqual(dj.isMobileWakeRequired(), true);
            assert.strictEqual(dj.getSessionCache().getSessionStartIndex(), 2);
            assert.strictEqual(dj.getSessionCache().getLastPlayingTrack()?.id, 'm3');

            // 4. Frozen HTTP 204 empty-swing on `next()` / `previous()` when paused on mobile sets `mobileWakeRequired = true`
            deviceList = [
                { id: 'pixel_10_pro_xl', name: 'Pixel 10 Pro XL', type: 'Smartphone', is_active: false, is_restricted: false } as SpotifyApi.UserDevice,
            ];
            await dj.getDevices();
            dj.clearMobileWakeRequired();
            dj.getSessionCache().activateExternalContext(false, true);
            currentState = {
                is_playing: false,
                progress_ms: 1000,
                item: djTracks[0],
                context: { type: 'album', uri: 'spotify:album:sea' },
                device: deviceList[0],
            };
            await dj.getPlaybackState(); // sets `lastKnownIsPlaying = false`

            const frozenNext = await dj.next();
            assert.strictEqual(frozenNext.ok, false);
            assert.strictEqual(frozenNext.mobileWakeRequired, true);
            assert.strictEqual(dj.isMobileWakeRequired(), true);

            dj.clearMobileWakeRequired();
            const frozenPrev = await dj.previous();
            assert.strictEqual(frozenPrev.ok, false);
            assert.strictEqual(frozenPrev.mobileWakeRequired, true);

            // 5. Bare external `resume()` on known-inactive Smartphone sends `forcePlayTransfer: true` on the FIRST shot
            resumeOptionsLog.length = 0;
            await dj.resume();
            assert.deepStrictEqual(resumeOptionsLog[0], { silent: true, forcePlayTransfer: true });
        });

        it('verifies mobile foreground recovery while mobileWakeRequired is true (both still BFGS-blocked and manually unfrozen), suppresses in-flight/mirage optimistic fake-playing, and verifies executeResumeInternal catch fallback', async () => {
            const djTracks = [
                makeTrack({ id: 'fg1', uri: 'spotify:track:fg1', name: 'Wannabe', artistName: 'Spice Girls' }),
                makeTrack({ id: 'fg2', uri: 'spotify:track:fg2', name: 'All That She Wants', artistName: 'Ace of Base' }),
                makeTrack({ id: 'fg3', uri: 'spotify:track:fg3', name: 'Happy Nation', artistName: 'Ace of Base' }),
            ];
            const leftoverExternal = makeTrack({
                id: 'ext_old',
                uri: 'spotify:track:ext_old',
                name: 'Old Song',
                artistName: 'Old Artist',
            });

            const dj = new DJCore('fake_token');
            let isFrozen = true;
            let trackLoadedOnDevice = true;
            let throwOnNextStateCheck = false;
            const mobileDevice: SpotifyApi.UserDevice = {
                id: 'pixel_10_pro_xl',
                name: 'Pixel 10 Pro XL',
                type: 'Smartphone',
                is_active: false,
                is_restricted: false,
                is_private_session: false,
                volume_percent: 80,
            };
            let deviceList: SpotifyApi.UserDevice[] = [mobileDevice];
            let currentState: unknown = {
                is_playing: false,
                progress_ms: 0,
                item: djTracks[0],
                context: null,
                device: mobileDevice,
            };

            const djInternal = dj as unknown as {
                mobileResumeVerifyDelayMs: number;
                mobileResumeRetryDelayMs: number;
                lastKnownIsPlaying: boolean | null;
                spotify: {
                    getMyDevices: () => Promise<{ devices: SpotifyApi.UserDevice[] }>;
                    getMyCurrentPlaybackState: () => Promise<unknown>;
                };
                playerClient: {
                    isMobileRuntime: () => boolean;
                    getKnownDevice: (id: string) => SpotifyApi.UserDevice | null;
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: (devId: string, uris: string[]) => Promise<{
                        confirmedPlaying: boolean;
                        targetTrackLoaded: boolean;
                        targetDeviceId: string;
                        isMobileTarget: boolean;
                    }>;
                    resume: (
                        deviceId?: string,
                        opts?: { silent?: boolean; forcePlayTransfer?: boolean }
                    ) => Promise<{ ok: boolean; status: number }>;
                    getActiveDeviceId: () => string | null;
                    getPreferredDeviceId: () => string | null;
                    clearLastError: () => void;
                    getLastError: () => null;
                };
                searchTracks: () => Promise<Track[]>;
            };

            djInternal.mobileResumeVerifyDelayMs = 0;
            djInternal.mobileResumeRetryDelayMs = 0;
            djInternal.searchTracks = async () => djTracks;
            djInternal.spotify.getMyDevices = async () => ({ devices: deviceList });
            djInternal.spotify.getMyCurrentPlaybackState = async () => {
                if (throwOnNextStateCheck) {
                    throwOnNextStateCheck = false;
                    throw Object.assign(new Error('502 Bad Gateway'), { status: 502 });
                }
                return currentState;
            };
            djInternal.playerClient.isMobileRuntime = () => true;
            djInternal.playerClient.getKnownDevice = (id) => deviceList.find(d => d.id === id) ?? null;
            djInternal.playerClient.getActiveDeviceId = () => 'pixel_10_pro_xl';
            djInternal.playerClient.getPreferredDeviceId = () => null;
            djInternal.playerClient.clearLastError = () => {};
            djInternal.playerClient.getLastError = () => null;
            djInternal.playerClient.resolveTargetDevice = async () => {
                await dj.getDevices();
                return 'pixel_10_pro_xl';
            };

            let startPlayCalls = 0;
            let resumeCalls = 0;
            let holdInFlightStart: (() => Promise<void>) | null = null;

            djInternal.playerClient.startPlaybackOnDevice = async (devId, uris) => {
                startPlayCalls++;
                if (holdInFlightStart) {
                    await holdInFlightStart();
                }
                if (isFrozen) {
                    if (trackLoadedOnDevice) {
                        currentState = {
                            is_playing: false,
                            progress_ms: 0,
                            item: djTracks.find(t => t.uri === uris[0]) || djTracks[0],
                            context: null,
                            device: mobileDevice,
                        };
                    }
                    return {
                        confirmedPlaying: false,
                        targetTrackLoaded: trackLoadedOnDevice,
                        targetDeviceId: devId,
                        isMobileTarget: true,
                    };
                }
                currentState = {
                    is_playing: true,
                    progress_ms: 680,
                    item: djTracks.find(t => t.uri === uris[0]) || djTracks[0],
                    context: null,
                    device: { ...mobileDevice, is_active: true },
                };
                return {
                    confirmedPlaying: true,
                    targetTrackLoaded: true,
                    targetDeviceId: devId,
                    isMobileTarget: true,
                };
            };

            djInternal.playerClient.resume = async () => {
                resumeCalls++;
                if (!isFrozen && trackLoadedOnDevice) {
                    currentState = {
                        is_playing: true,
                        progress_ms: 520,
                        item: djTracks[0],
                        context: null,
                        device: { ...mobileDevice, is_active: true },
                    };
                }
                return { ok: true, status: 204 };
            };

            // 1. Initial schedule run while Pixel 10 Pro XL is BFGS-blocked with Track 1 loaded paused:
            dj.setSchedule([{ start: '00:00', end: '23:59', query: '90s pop party' }], true);
            await dj.processDJLoop(false, true);
            assert.strictEqual(startPlayCalls, 1);
            assert.strictEqual(dj.isMobileWakeRequired(), true);
            assert.strictEqual(dj.getLastPlayTime(), 0);
            assert.strictEqual(djInternal.lastKnownIsPlaying, false);
            assert.match(dj.getStateSnapshot().status, /^📱/);

            // 2. Foreground recovery (`notifyForegrounded()` + `processDJLoop()`) 3 times in a row while phone is STILL BFGS-blocked:
            //    `playerClient.resume` returns HTTP 204, `verifyMobileResumeStarted` sees `is_playing === false` ->
            //    MUST keep `mobileWakeRequired === true`, `lastPlayTime === 0`, `lastKnownIsPlaying === false`,
            //    MUST NOT spin `tryStartPendingSessionTracks`, and `getPlaybackState()` MUST NEVER emit `__optimisticFallback`!
            for (let attempt = 1; attempt <= 3; attempt++) {
                dj.notifyForegrounded();
                await dj.processDJLoop(true, false);
                assert.strictEqual(resumeCalls, attempt);
                assert.strictEqual(startPlayCalls, 1);
                assert.strictEqual(dj.isMobileWakeRequired(), true);
                assert.strictEqual(dj.getLastPlayTime(), 0);
                assert.strictEqual(djInternal.lastKnownIsPlaying, false);
                assert.match(dj.getStateSnapshot().status, /^📱/);

                const pollWhileBlocked = await dj.getPlaybackState();
                assert.strictEqual(
                    Boolean((pollWhileBlocked as { __optimisticFallback?: boolean } | null)?.__optimisticFallback),
                    false
                );
                assert.strictEqual(pollWhileBlocked?.is_playing, false);
            }

            // Even a transient 0ms cloud mirage (`is_playing: true, progress_ms: 0`) while `mobileWakeRequired === true`
            // must be clamped to `is_playing: false` without mutating the mock object or clearing `mobileWakeRequired`!
            const mirageFixture = {
                is_playing: true,
                progress_ms: 0,
                item: djTracks[0],
                context: null,
                device: { ...mobileDevice, is_active: true },
            };
            currentState = mirageFixture;
            const miragePoll = await dj.getPlaybackState();
            assert.strictEqual(miragePoll?.is_playing, false);
            assert.strictEqual(mirageFixture.is_playing, true);
            assert.strictEqual(dj.isMobileWakeRequired(), true);
            assert.strictEqual(djInternal.lastKnownIsPlaying, false);

            // Restore paused loaded Track 1, then user manually opens Spotify (`isFrozen = false`) and switches back to ContextDJ:
            // `notifyForegrounded()` + `processDJLoop()` resumes loaded Track 1, verifies start, clears `mobileWakeRequired` & `'📱'` status!
            currentState = {
                is_playing: false,
                progress_ms: 0,
                item: djTracks[0],
                context: null,
                device: mobileDevice,
            };
            isFrozen = false;
            dj.notifyForegrounded();
            await dj.processDJLoop(true, false);

            assert.strictEqual(resumeCalls, 4);
            assert.strictEqual(startPlayCalls, 1); // Resumed loaded Track 1 directly without resetting `{ uris }`!
            assert.strictEqual(dj.isMobileWakeRequired(), false);
            assert.strictEqual(dj.getStateSnapshot().status, 'Ready');
            assert.strictEqual(dj.getLastPlayTime() > 0, true);
            assert.strictEqual(djInternal.lastKnownIsPlaying, true);

            const confirmedAfterManualUnfreeze = await dj.getPlaybackState();
            assert.strictEqual(confirmedAfterManualUnfreeze?.is_playing, true);
            assert.strictEqual(dj.hasConfirmedPlayback(), true);

            // 3. `executeResumeInternal` catch fallback when `getMyCurrentPlaybackState` throws on a confirmed session:
            //    3a. When mobile Spotify re-froze in background (`isFrozen = true`), bare fallback `resume` returns 204
            //        but `verifyMobileResumeStarted` detects `is_playing === false` -> returns `{ ok: false, mobileWakeRequired: true }`!
            isFrozen = true;
            currentState = {
                is_playing: false,
                progress_ms: 12_000,
                item: djTracks[0],
                context: null,
                device: mobileDevice,
            };
            throwOnNextStateCheck = true;
            const catchFrozenRes = await dj.resume();
            assert.strictEqual(catchFrozenRes.ok, false);
            assert.strictEqual(catchFrozenRes.mobileWakeRequired, true);
            assert.strictEqual(dj.isMobileWakeRequired(), true);
            assert.strictEqual(djInternal.lastKnownIsPlaying, false);
            assert.match(dj.getStateSnapshot().status, /^📱/);

            //    3b. Re-confirm session, then test `catch` fallback when Spotify IS unfrozen (`isFrozen = false`):
            //        verifies playback started, clears `mobileWakeRequired`, resets `'📱'` status to `'Ready'`, and returns `{ ok: true }`!
            isFrozen = false;
            const wokeRes = await dj.resume({ fromMobileWake: true });
            assert.strictEqual(wokeRes.ok, true);
            await dj.getPlaybackState();
            assert.strictEqual(dj.hasConfirmedPlayback(), true);

            // Simulate leftover `mobileWakeRequired` + transient `/me/player` 502 during manual `dj.resume()` when unfrozen
            (dj as unknown as { setMobileWakeRequiredState: (v: boolean) => void }).setMobileWakeRequiredState(true);
            (dj as unknown as { updateStatus: (s: string) => void }).updateStatus('📱 Stale wake banner');
            currentState = {
                is_playing: false,
                progress_ms: 15_000,
                item: djTracks[0],
                context: null,
                device: mobileDevice,
            };
            throwOnNextStateCheck = true;
            const catchSuccessRes = await dj.resume();
            assert.strictEqual(catchSuccessRes.ok, true);
            assert.strictEqual(dj.isMobileWakeRequired(), false);
            assert.strictEqual(dj.getStateSnapshot().status, 'Ready');
            assert.strictEqual(djInternal.lastKnownIsPlaying, true);

            // 4. Foreground recovery while `mobileWakeRequired === true` AND Track 1 is NOT loaded on Spotify (`leftoverExternal` paused):
            //    While `tryStartPendingSessionTracks` -> `playTracks` is in flight, `getPlaybackState()` MUST NOT leak
            //    `{ is_playing: true, __optimisticFallback: true }`!
            isFrozen = true;
            trackLoadedOnDevice = false;
            currentState = {
                is_playing: false,
                progress_ms: 90_000,
                item: leftoverExternal,
                context: { type: 'album', uri: 'spotify:album:old' },
                device: mobileDevice,
            };
            await dj.playTracks(djTracks, { isDJSession: true });
            assert.strictEqual(dj.isMobileWakeRequired(), true);
            assert.strictEqual(dj.getLastPlayTime(), 0);

            let releaseFgPlay!: () => void;
            let enteredFgPlay!: () => void;
            const enteredPromise = new Promise<void>((r) => {
                enteredFgPlay = r;
            });
            holdInFlightStart = () => {
                enteredFgPlay();
                return new Promise<void>((r) => {
                    releaseFgPlay = r;
                });
            };

            dj.notifyForegrounded();
            const fgLoopPromise = dj.processDJLoop(true, false);
            await enteredPromise;

            const inFlightWhileWakeRequired = await dj.getPlaybackState();
            assert.strictEqual(
                Boolean((inFlightWhileWakeRequired as { __optimisticFallback?: boolean } | null)?.__optimisticFallback),
                false
            );
            assert.strictEqual(inFlightWhileWakeRequired?.is_playing, false);

            releaseFgPlay();
            await fgLoopPromise;
            holdInFlightStart = null;
            assert.strictEqual(dj.isMobileWakeRequired(), true);
            assert.strictEqual(dj.getLastPlayTime(), 0);

            // And if Connect devices list goes empty (`deviceList = []`) on an unconfirmed mobile session,
            // `tryStartPendingSessionTracks` keeps `mobileWakeRequired === true` with `📱` prompt cleanly;
            // then once user manually opens Spotify (`deviceList = [mobileDevice]`, `isFrozen = false`), next foreground return starts `[fg1, fg2, fg3]`!
            dj.clearMobileWakeRequired();
            deviceList = [];
            currentState = null;
            dj.notifyForegrounded();
            await dj.processDJLoop(true, false);
            assert.strictEqual(dj.isMobileWakeRequired(), true);
            assert.match(dj.getStateSnapshot().status, /^📱/);

            deviceList = [mobileDevice];
            isFrozen = false;
            trackLoadedOnDevice = true;
            dj.notifyForegrounded();
            await dj.processDJLoop(true, false);
            assert.strictEqual(dj.isMobileWakeRequired(), false);
            assert.strictEqual(dj.getStateSnapshot().status, 'Ready');
            assert.strictEqual(dj.getLastPlayTime() > 0, true);
        });

        it('suppresses pre-wake mobile playInFlight optimistic fallback, aborts verifyMobileResumeStarted cleanly on pause race, rejects persistent 502 / wrong-device / 0ms mirages, and preserves mid-track progress on fromMobileWake with cold-start escalation', async () => {
            const djTracks = [
                makeTrack({ id: 'adv1', uri: 'spotify:track:adv1', name: 'Midnight Train', artistName: 'Journey' }),
                makeTrack({ id: 'adv2', uri: 'spotify:track:adv2', name: 'Africa', artistName: 'Toto' }),
            ];

            const mobileDevice: SpotifyApi.UserDevice = {
                id: 'pixel_10_pro_xl',
                name: 'Pixel 10 Pro XL',
                type: 'Smartphone',
                is_active: false,
                is_restricted: false,
                is_private_session: false,
                volume_percent: 75,
            };
            const homePcDevice: SpotifyApi.UserDevice = {
                id: 'pc_home',
                name: 'Home PC',
                type: 'Computer',
                is_active: true,
                is_restricted: false,
                is_private_session: false,
                volume_percent: 100,
            };

            const dj = new DJCore('fake_token');
            const deviceList: SpotifyApi.UserDevice[] = [homePcDevice, mobileDevice];
            let currentState: unknown = null;
            let remainingStateThrows = 0;
            let holdStateVerify: (() => Promise<void>) | null = null;
            let holdStartPlay: (() => Promise<void>) | null = null;
            let startPlayCalls = 0;
            let resumeCalls = 0;
            let resumeBehavior: 'noop' | 'start_at_12s' | 'mirage_0ms' = 'noop';
            let pauseStatus = 204;

            const djInternal = dj as unknown as {
                mobileResumeVerifyDelayMs: number;
                mobileResumeRetryDelayMs: number;
                lastKnownIsPlaying: boolean | null;
                spotify: {
                    getMyDevices: () => Promise<{ devices: SpotifyApi.UserDevice[] }>;
                    getMyCurrentPlaybackState: () => Promise<unknown>;
                };
                playerClient: {
                    isMobileRuntime: () => boolean;
                    getKnownDevice: (id: string) => SpotifyApi.UserDevice | null;
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: (devId: string, uris: string[]) => Promise<{
                        confirmedPlaying: boolean;
                        targetTrackLoaded: boolean;
                        targetDeviceId: string;
                        isMobileTarget: boolean;
                    }>;
                    resume: (
                        deviceId?: string,
                        opts?: { silent?: boolean; forcePlayTransfer?: boolean }
                    ) => Promise<{ ok: boolean; status: number }>;
                    pause: () => Promise<{ ok: boolean; status: number }>;
                    getActiveDeviceId: () => string | null;
                    getPreferredDeviceId: () => string | null;
                    clearLastError: () => void;
                    getLastError: () => null;
                };
            };

            djInternal.mobileResumeVerifyDelayMs = 0;
            djInternal.mobileResumeRetryDelayMs = 0;
            djInternal.spotify.getMyDevices = async () => ({ devices: deviceList });
            djInternal.spotify.getMyCurrentPlaybackState = async () => {
                if (holdStateVerify) {
                    await holdStateVerify();
                }
                if (remainingStateThrows > 0) {
                    remainingStateThrows--;
                    throw Object.assign(new Error('502 Bad Gateway'), { status: 502 });
                }
                return currentState;
            };
            djInternal.playerClient.isMobileRuntime = () => true;
            djInternal.playerClient.getKnownDevice = (id) => deviceList.find(d => d.id === id) ?? null;
            djInternal.playerClient.getActiveDeviceId = () => 'pixel_10_pro_xl';
            djInternal.playerClient.getPreferredDeviceId = () => null;
            djInternal.playerClient.clearLastError = () => {};
            djInternal.playerClient.getLastError = () => null;
            djInternal.playerClient.resolveTargetDevice = async () => {
                await dj.getDevices();
                return 'pixel_10_pro_xl';
            };
            djInternal.playerClient.pause = async () => ({
                ok: pauseStatus < 400,
                status: pauseStatus,
            });
            djInternal.playerClient.resume = async () => {
                resumeCalls++;
                if (resumeBehavior === 'start_at_12s') {
                    currentState = {
                        is_playing: true,
                        progress_ms: 12_450,
                        item: djTracks[0],
                        context: null,
                        device: { ...mobileDevice, is_active: true },
                    };
                } else if (resumeBehavior === 'mirage_0ms') {
                    currentState = {
                        is_playing: true,
                        progress_ms: 0,
                        item: djTracks[0],
                        context: null,
                        device: { ...mobileDevice, is_active: true },
                    };
                }
                return { ok: true, status: 204 };
            };
            djInternal.playerClient.startPlaybackOnDevice = async (devId, uris) => {
                startPlayCalls++;
                if (holdStartPlay) {
                    await holdStartPlay();
                }
                currentState = {
                    is_playing: true,
                    progress_ms: 600,
                    item: djTracks.find(t => t.uri === uris[0]) || djTracks[0],
                    context: null,
                    device: { ...mobileDevice, is_active: true },
                };
                return {
                    confirmedPlaying: true,
                    targetTrackLoaded: true,
                    targetDeviceId: devId,
                    isMobileTarget: true,
                };
            };

            // 1. Mobile `playInFlight` BEFORE `mobileWakeRequired` is ever set:
            //    `getPlaybackState()` MUST NOT emit fake `{ is_playing: true, __optimisticFallback: true }`!
            await dj.getDevices();
            assert.strictEqual(dj.isMobileWakeRequired(), false);
            let enteredInitialPlay!: () => void;
            let releaseInitialPlay!: () => void;
            const enteredInitPromise = new Promise<void>((r) => {
                enteredInitialPlay = r;
            });
            holdStartPlay = () => {
                enteredInitialPlay();
                return new Promise<void>((r) => {
                    releaseInitialPlay = r;
                });
            };

            const initialPlayPromise = dj.playTracks(djTracks, { isDJSession: true });
            await enteredInitPromise;
            const pollDuringInitialMobilePlay = await dj.getPlaybackState();
            assert.strictEqual(
                Boolean((pollDuringInitialMobilePlay as { __optimisticFallback?: boolean } | null)?.__optimisticFallback),
                false
            );
            releaseInitialPlay();
            await initialPlayPromise;
            holdStartPlay = null;
            await dj.getPlaybackState();
            assert.strictEqual(dj.hasConfirmedPlayback(), true);
            assert.strictEqual(startPlayCalls, 1);

            // 2. Pause race during `verifyMobileResumeStarted`:
            //    User taps Play (`dj.resume()`), then immediately taps Pause (`dj.pause()`, even when Spotify returns 403 because
            //    the frozen phone never started playing). Must abort cleanly WITHOUT setting `mobileWakeRequired = true`!
            currentState = {
                is_playing: false,
                progress_ms: 12_000,
                item: djTracks[0],
                context: null,
                device: mobileDevice,
            };
            let verifyCallCount = 0;
            let releasePausedVerify!: () => void;
            let enteredPausedVerify!: () => void;
            const enteredVerifyPromise = new Promise<void>((r) => {
                enteredPausedVerify = r;
            });
            holdStateVerify = async () => {
                verifyCallCount++;
                if (verifyCallCount === 2) {
                    enteredPausedVerify();
                    await new Promise<void>((r) => {
                        releasePausedVerify = r;
                    });
                }
            };
            pauseStatus = 403;
            resumeBehavior = 'noop';

            const racingResumePromise = dj.resume();
            await enteredVerifyPromise;
            await dj.pause();
            releasePausedVerify();
            const racingResumeRes = await racingResumePromise;
            holdStateVerify = null;
            pauseStatus = 204;

            assert.strictEqual(racingResumeRes.ok, false);
            assert.strictEqual(racingResumeRes.mobileWakeRequired, undefined);
            assert.strictEqual(dj.isMobileWakeRequired(), false);
            assert.strictEqual(djInternal.lastKnownIsPlaying, false);

            // 3. Persistent `/me/player` 502 error across `executeResumeInternal` catch fallback AND `verifyMobileResumeStarted`
            //    MUST fail closed (`{ ok: false, mobileWakeRequired: true }`) instead of falsely reporting `{ ok: true }`!
            remainingStateThrows = 5;
            const persistent502Res = await dj.resume();
            remainingStateThrows = 0;
            assert.strictEqual(persistent502Res.ok, false);
            assert.strictEqual(persistent502Res.mobileWakeRequired, true);
            assert.strictEqual(dj.isMobileWakeRequired(), true);

            // 4. Cross-device guard: `Home PC` (`type: 'Computer'`) playing externally in another room MUST NOT
            //    clear `mobileWakeRequired` in `getPlaybackState()` or trick `verifyMobileResumeStarted('pixel_10_pro_xl')`!
            currentState = {
                is_playing: true,
                progress_ms: 48_000,
                item: makeTrack({ id: 'pc_song', uri: 'spotify:track:pc_song', name: 'PC Song', artistName: 'PC Artist' }),
                context: { type: 'playlist', uri: 'spotify:playlist:pc' },
                device: homePcDevice,
            };
            const crossDevicePoll = await dj.getPlaybackState();
            assert.strictEqual(dj.isMobileWakeRequired(), true);
            assert.strictEqual(crossDevicePoll?.is_playing, false);
            assert.match(dj.getStateSnapshot().status, /^📱/);

            // 5. Persistent `0ms` cloud mirage (`is_playing: true, progress_ms: 0`) during `resume()` on mobile
            //    is rejected as blocked rather than falsely confirming playback!
            await dj.pause();
            currentState = {
                is_playing: false,
                progress_ms: 12_000,
                item: djTracks[0],
                context: null,
                device: mobileDevice,
            };
            resumeBehavior = 'mirage_0ms';
            const mirageResumeRes = await dj.resume();
            assert.strictEqual(mirageResumeRes.ok, false);
            assert.strictEqual(mirageResumeRes.mobileWakeRequired, true);
            assert.strictEqual(dj.isMobileWakeRequired(), true);

            // 6a. `dj.resume({ fromMobileWake: true })` when `adv1` is still loaded paused at `12,000ms` on the newly-unfrozen phone:
            //     Resumes in place at `12,450ms` WITHOUT calling `startPlaybackOnDevice({ uris })` (preserving mid-track position)!
            currentState = {
                is_playing: false,
                progress_ms: 12_000,
                item: djTracks[0],
                context: null,
                device: mobileDevice,
            };
            resumeBehavior = 'start_at_12s';
            const prevStartPlayCalls = startPlayCalls;
            const prevResumeCalls = resumeCalls;
            const inPlaceWakeRes = await dj.resume({ fromMobileWake: true });
            assert.strictEqual(inPlaceWakeRes.ok, true);
            assert.strictEqual(startPlayCalls, prevStartPlayCalls);
            assert.strictEqual(resumeCalls, prevResumeCalls + 1);
            assert.strictEqual(dj.isMobileWakeRequired(), false);
            assert.strictEqual(dj.getStateSnapshot().status, 'Ready');
            assert.strictEqual((currentState as { progress_ms: number }).progress_ms, 12_450);

            // 6b. If cold-started Spotify dropped local playback so loaded `resume` stays paused (`resumeBehavior = 'noop'`),
            //     `dj.resume({ fromMobileWake: true })` escalates to `playTracks({ uris })` within the SAME wake call!
            await dj.getPlaybackState();
            currentState = {
                is_playing: false,
                progress_ms: 0,
                item: djTracks[0],
                context: null,
                device: mobileDevice,
            };
            resumeBehavior = 'noop';
            const failManual = await dj.resume();
            assert.strictEqual(failManual.ok, false);
            assert.strictEqual(dj.isMobileWakeRequired(), true);

            const coldStartWakeRes = await dj.resume({ fromMobileWake: true });
            assert.strictEqual(coldStartWakeRes.ok, true);
            assert.strictEqual(startPlayCalls, prevStartPlayCalls + 1);
            assert.strictEqual(dj.isMobileWakeRequired(), false);
        });

        it('escalates to playTracks when mobile forcePlayTransfer wakes onto a leftover foreign track, completes full verification under navigator.userActivation, and stages synchronous t=0ms wake navigation', async () => {
            const origFetch = globalThis.fetch;
            const origNavDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
            try {
                // Simulate real Android Chrome with an active transient user gesture (`userActivation.isActive === true`)
                Object.defineProperty(globalThis, 'navigator', {
                    configurable: true,
                    value: {
                        userAgent: 'Mozilla/5.0 (Linux; Android 17; Pixel 10 Pro XL) AppleWebKit/537.36 Chrome/142.0.0.0 Mobile Safari/537.36',
                        userActivation: { isActive: true },
                    },
                });

                const djTracks = [
                    makeTrack({ id: 'wannabe', uri: 'spotify:track:wannabe', name: 'Wannabe', artistName: 'Spice Girls' }),
                    makeTrack({ id: 'mmmbop', uri: 'spotify:track:mmmbop', name: 'MMMBop', artistName: 'Hanson' }),
                    makeTrack({ id: 'barbie', uri: 'spotify:track:barbie', name: 'Barbie Girl', artistName: 'Aqua' }),
                ];
                const foreignTrack = makeTrack({
                    id: 'manteca',
                    uri: 'spotify:track:manteca',
                    name: 'Manteca - Live',
                    artistName: 'Dizzy Gillespie',
                });
                const mobileDevice: SpotifyApi.UserDevice = {
                    id: 'pixel_10_pro_xl',
                    name: 'Pixel 10 Pro XL',
                    type: 'Smartphone',
                    is_active: false,
                    is_private_session: false,
                    is_restricted: false,
                    volume_percent: 80,
                };

                // 1. Real SpotifyPlayerClient integration under `navigator.userActivation.isActive = true`:
                //    Inactive Pixel 10 Pro XL takes 3 `/me/player` polls (`null`, `null`, then `wannabe` paused -> kick -> playing).
                //    Previously `hasActiveBrowserUserGesture()` forced `fastFailForUserGesture: true` and aborted at poll #2!
                const sentRequests: { url: string; body?: string }[] = [];
                globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
                    sentRequests.push({
                        url: String(input),
                        body: init?.body ? String(init.body) : undefined,
                    });
                    return {
                        ok: true,
                        status: 204,
                        statusText: 'No Content',
                        headers: { get: () => null },
                        text: async () => '',
                    } as unknown as Response;
                }) as typeof fetch;

                let statePoll = 0;
                const realClientDj = new DJCore('token_real_gesture');
                const realInternal = realClientDj as unknown as {
                    mobileResumeVerifyDelayMs: number;
                    mobileResumeRetryDelayMs: number;
                    spotify: {
                        getAccessToken: () => string;
                        getMyDevices: () => Promise<{ devices: SpotifyApi.UserDevice[] }>;
                        getMyCurrentPlaybackState: () => Promise<SpotifyApi.CurrentPlaybackResponse | null>;
                    };
                    playerClient: {
                        options: {
                            postPlayVerifyDelayMs?: number;
                            retryDelayMs?: number;
                            transferSettleDelayMs?: number;
                            devicePollDelayMs?: number;
                        };
                    };
                };
                realInternal.mobileResumeVerifyDelayMs = 0;
                realInternal.mobileResumeRetryDelayMs = 0;
                realInternal.playerClient.options.postPlayVerifyDelayMs = 0;
                realInternal.playerClient.options.retryDelayMs = 0;
                realInternal.playerClient.options.transferSettleDelayMs = 0;
                realInternal.playerClient.options.devicePollDelayMs = 0;
                realInternal.spotify.getAccessToken = () => 'token_real_gesture';
                realInternal.spotify.getMyDevices = async () => ({ devices: [mobileDevice] });
                realInternal.spotify.getMyCurrentPlaybackState = async () => {
                    statePoll++;
                    // Poll 1: executeResumeInternal initial inspection (`Manteca` paused on inactive phone)
                    if (statePoll === 1) {
                        return {
                            is_playing: false,
                            progress_ms: 431_000,
                            item: foreignTrack,
                            context: { type: 'album', uri: 'spotify:album:dizzy' },
                            device: mobileDevice,
                        } as unknown as SpotifyApi.CurrentPlaybackResponse;
                    }
                    // Polls 2 & 3: inactive phone still waking up (`null`, `null`)
                    if (statePoll <= 3) {
                        return null;
                    }
                    // Poll 4 (3rd settle check in startPlaybackOnDevice!): `wannabe` surfaces paused; Poll 5+: playing!
                    return {
                        is_playing: statePoll >= 5,
                        progress_ms: statePoll >= 5 ? 280 : 0,
                        item: djTracks[0],
                        context: null,
                        device: { ...mobileDevice, is_active: true },
                    } as unknown as SpotifyApi.CurrentPlaybackResponse;
                };

                realClientDj.getSessionCache().setSessionTracks(djTracks, true, 0);
                realClientDj.getSessionCache().setLastPlayingTrack(djTracks[0], true);
                const gestureResumeRes = await realClientDj.resume();
                assert.strictEqual(gestureResumeRes.ok, true);
                assert.strictEqual(realClientDj.isMobileWakeRequired(), false);

                // 2. `verifyMobileResumeStarted` `'wrong_track'` escalation:
                //    Cloud `/me/player` initially reports `wannabe` paused on inactive `Pixel 10 Pro XL`,
                //    but `forcePlayTransfer` wakes `Pixel 10 Pro XL` onto its local `Manteca - Live` (`spotify:album:dizzy`)!
                //    `dj.resume()` must NOT stop on `Manteca` or let a concurrent `getPlaybackState()` poll wipe `sessionTracks` —
                //    it must immediately escalate to `startPlaybackOnDevice` (`{ uris: [wannabe, ...] }`)!
                const dj = new DJCore('token_wrong_track');
                let currentState: Record<string, unknown> | null = {
                    is_playing: false,
                    progress_ms: 0,
                    item: djTracks[0],
                    context: null,
                    device: mobileDevice,
                };
                let playedUrisLog: string[][] = [];
                let concurrentPollChecked = false;
                const djInternal = dj as unknown as {
                    mobileResumeVerifyDelayMs: number;
                    mobileResumeRetryDelayMs: number;
                    spotify: {
                        getMyDevices: () => Promise<{ devices: SpotifyApi.UserDevice[] }>;
                        getMyCurrentPlaybackState: () => Promise<unknown>;
                    };
                    playerClient: {
                        isMobileRuntime: () => boolean;
                        getKnownDevice: (id: string) => SpotifyApi.UserDevice | null;
                        getActiveDeviceId: () => string | null;
                        getPreferredDeviceId: () => string | null;
                        clearLastError: () => void;
                        getLastError: () => null;
                        resolveTargetDevice: () => Promise<string>;
                        resume: () => Promise<{ ok: boolean; status: number }>;
                        next: () => Promise<{ ok: boolean; status: number }>;
                        startPlaybackOnDevice: (
                            devId: string,
                            uris: string[]
                        ) => Promise<{
                            confirmedPlaying: boolean;
                            targetTrackLoaded: boolean;
                            targetDeviceId: string;
                            isMobileTarget: boolean;
                        }>;
                    };
                };
                djInternal.mobileResumeVerifyDelayMs = 0;
                djInternal.mobileResumeRetryDelayMs = 0;
                djInternal.spotify.getMyDevices = async () => ({ devices: [mobileDevice] });
                djInternal.spotify.getMyCurrentPlaybackState = async () => currentState;
                djInternal.playerClient.isMobileRuntime = () => true;
                djInternal.playerClient.getKnownDevice = () => mobileDevice;
                djInternal.playerClient.getActiveDeviceId = () => 'pixel_10_pro_xl';
                djInternal.playerClient.getPreferredDeviceId = () => null;
                djInternal.playerClient.clearLastError = () => {};
                djInternal.playerClient.getLastError = () => null;
                djInternal.playerClient.resolveTargetDevice = async () => 'pixel_10_pro_xl';
                djInternal.playerClient.resume = async () => {
                    // `forcePlayTransfer` wakes phone onto local foreign album `Manteca - Live`!
                    currentState = {
                        is_playing: true,
                        progress_ms: 431_450,
                        item: foreignTrack,
                        context: { type: 'album', uri: 'spotify:album:dizzy' },
                        device: { ...mobileDevice, is_active: true },
                    };
                    if (!concurrentPollChecked) {
                        concurrentPollChecked = true;
                        // Simulate a 1s UI poll firing mid-resume while `Manteca` is momentarily playing:
                        // must NOT wipe `sessionTracks` as an external takeover!
                        await dj.getPlaybackState();
                    }
                    return { ok: true, status: 204 };
                };
                djInternal.playerClient.startPlaybackOnDevice = async (devId, uris) => {
                    playedUrisLog.push(uris);
                    const started = djTracks.find(t => t.uri === uris[0]) || djTracks[0];
                    currentState = {
                        is_playing: true,
                        progress_ms: 420,
                        item: started,
                        context: null,
                        device: { ...mobileDevice, is_active: true },
                    };
                    return {
                        confirmedPlaying: true,
                        targetTrackLoaded: true,
                        targetDeviceId: devId,
                        isMobileTarget: true,
                    };
                };

                // Session restored from storage (`hasInitiatedSessionInRuntime === false` initially)
                dj.getSessionCache().setSessionTracks(djTracks, true, 0);
                dj.getSessionCache().setLastPlayingTrack(djTracks[0], true);
                await dj.getDevices();

                const wrongTrackResumeRes = await dj.resume();
                assert.strictEqual(wrongTrackResumeRes.ok, true);
                assert.strictEqual(concurrentPollChecked, true);
                assert.strictEqual(dj.isSessionPlaybackActive(), true);
                assert.strictEqual(dj.isMobileWakeRequired(), false);
                assert.deepStrictEqual(playedUrisLog, [
                    ['spotify:track:wannabe', 'spotify:track:mmmbop', 'spotify:track:barbie'],
                ]);
                assert.strictEqual((currentState as { item: Track }).item.uri, 'spotify:track:wannabe');

                // 3. `stageNavigationForMobileWake` stages Next / Previous / Queue synchronously with zero network calls
                playedUrisLog = [];
                const stagedCallbacks: { uris: string[]; confirmedPlaying: boolean; mobileWakeRequired?: boolean }[] = [];
                dj.setOnTracksPlayedCallback((tracks, meta) => {
                    stagedCallbacks.push({
                        uris: tracks.map(t => t.uri),
                        confirmedPlaying: Boolean(meta?.confirmedPlaying),
                        mobileWakeRequired: meta?.mobileWakeRequired,
                    });
                });

                // Out-of-bounds queue index is safely ignored
                assert.strictEqual(
                    dj.stageNavigationForMobileWake({ type: 'queue', index: -1, displayedQueue: djTracks.slice(1) }),
                    null
                );
                assert.strictEqual(
                    dj.stageNavigationForMobileWake({ type: 'queue', index: 99, displayedQueue: djTracks.slice(1) }),
                    null
                );
                assert.strictEqual(stagedCallbacks.length, 0);

                // Stage Next (0 -> 1 `mmmbop`), then Queue index 1 of remaining queue (`barbie`), then Previous (2 -> 1 `mmmbop`)
                const stagedNext = dj.stageNavigationForMobileWake({ type: 'next' });
                assert.strictEqual(stagedNext?.uri, 'spotify:track:mmmbop');
                assert.strictEqual(dj.getSessionCache().getSessionStartIndex(), 1);

                const stagedQueue = dj.stageNavigationForMobileWake({
                    type: 'queue',
                    index: 0,
                    displayedQueue: [djTracks[2]],
                });
                assert.strictEqual(stagedQueue?.uri, 'spotify:track:barbie');
                assert.strictEqual(dj.getSessionCache().getSessionStartIndex(), 2);

                const stagedPrev = dj.stageNavigationForMobileWake({ type: 'previous' });
                assert.strictEqual(stagedPrev?.uri, 'spotify:track:mmmbop');
                assert.strictEqual(dj.getSessionCache().getSessionStartIndex(), 1);
                assert.strictEqual(playedUrisLog.length, 0);
                assert.strictEqual(stagedCallbacks.length, 3);
                assert.strictEqual(stagedCallbacks[2].confirmedPlaying, false);
                assert.strictEqual(stagedCallbacks[2].mobileWakeRequired, true);
                assert.deepStrictEqual(stagedCallbacks[2].uris, [
                    'spotify:track:mmmbop',
                    'spotify:track:barbie',
                ]);

                // Subsequent `dj.resume({ fromMobileWake: true })` starts from staged index 1 (`mmmbop`)!
                currentState = null;
                const wakeStagedRes = await dj.resume({ fromMobileWake: true });
                assert.strictEqual(wakeStagedRes.ok, true);
                assert.deepStrictEqual(playedUrisLog, [
                    ['spotify:track:mmmbop', 'spotify:track:barbie'],
                ]);
            } finally {
                globalThis.fetch = origFetch;
                if (origNavDescriptor) {
                    Object.defineProperty(globalThis, 'navigator', origNavDescriptor);
                } else {
                    delete (globalThis as Record<string, unknown>).navigator;
                }
            }
        });

        it('stages 1-tap mobile wake cleanly when Spotify freezes into 404 mid-curation in processDJLoop or when post-start background kick fails on Android 17', async () => {
            const origNavDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
            const origFetch = globalThis.fetch;

            try {
                Object.defineProperty(globalThis, 'navigator', {
                    value: {
                        userAgent:
                            'Mozilla/5.0 (Linux; Android 17; Pixel 10 Pro XL) AppleWebKit/537.36 Chrome/142.0.0.0 Mobile Safari/537.36',
                        maxTouchPoints: 5,
                    },
                    configurable: true,
                    writable: true,
                });

                const djTracks = [
                    makeTrack({ id: 'w1', uri: 'spotify:track:w1', name: 'Wannabe', artistName: 'Spice Girls' }),
                    makeTrack({ id: 'w2', uri: 'spotify:track:w2', name: 'MMMBop', artistName: 'Hanson' }),
                ];
                const pixelDevice: SpotifyApi.UserDevice = {
                    id: 'pixel_10',
                    name: 'Pixel 10 Pro XL',
                    type: 'Smartphone',
                    is_active: true,
                    is_private_session: false,
                    is_restricted: false,
                    volume_percent: 80,
                };

                // 1. Mobile Spotify is initially visible in getDevices(), then freezes during AI search so
                //    `PUT /v1/me/player/play` returns HTTP 404 (`device_not_found`):
                //    `processDJLoop` MUST NOT throw, wipe `currentQuery`, schedule `lastStartFailure`, or fire error toasts!
                globalThis.fetch = (async () => ({
                    ok: false,
                    status: 404,
                    statusText: 'Not Found',
                    headers: { get: () => null },
                    text: async () => 'Player command failed: Device not found',
                } as unknown as Response)) as typeof fetch;

                const dj = new DJCore('fake_token');
                const errorCallbacks: string[] = [];
                dj.setErrorCallback((msg) => {
                    errorCallbacks.push(msg);
                });
                dj.setSchedule([{ start: '00:00', end: '23:59', query: '90s pop party', thought: 'Upbeat 90s' }]);

                const djInternal = dj as unknown as {
                    mobileResumeVerifyDelayMs: number;
                    mobileResumeRetryDelayMs: number;
                    spotify: {
                        getMyDevices: () => Promise<{ devices: SpotifyApi.UserDevice[] }>;
                        getMyCurrentPlaybackState: () => Promise<unknown>;
                    };
                    playerClient: {
                        options: {
                            postPlayVerifyDelayMs?: number;
                            retryDelayMs?: number;
                            devicePollDelayMs?: number;
                            transferSettleDelayMs?: number;
                        };
                    };
                    searchTracks: () => Promise<Track[]>;
                };
                djInternal.mobileResumeVerifyDelayMs = 0;
                djInternal.mobileResumeRetryDelayMs = 0;
                djInternal.playerClient.options = {
                    ...djInternal.playerClient.options,
                    postPlayVerifyDelayMs: 0,
                    retryDelayMs: 0,
                    devicePollDelayMs: 0,
                    transferSettleDelayMs: 0,
                };
                djInternal.spotify.getMyDevices = async () => ({ devices: [pixelDevice] });
                djInternal.spotify.getMyCurrentPlaybackState = async () => null;
                djInternal.searchTracks = async () => djTracks;

                await dj.processDJLoop(false, true);

                assert.strictEqual(dj.isMobileWakeRequired(), true);
                assert.strictEqual(dj.hasPendingStartRetry(), false);
                assert.strictEqual(dj.getDJStatus().currentQuery, '90s pop party');
                assert.ok(dj.getStateSnapshot().status.startsWith('📱'));
                assert.deepStrictEqual(
                    dj.getSessionCache().getSessionTracks().map(t => t.uri),
                    ['spotify:track:w1', 'spotify:track:w2']
                );
                // Asleep mobile 404 is handled by 1-tap Wake UI — zero red error toast!
                assert.deepStrictEqual(errorCallbacks, []);

                // Critical errors (e.g. 403 Premium required) STILL notify error callbacks on mobile
                globalThis.fetch = (async () => ({
                    ok: false,
                    status: 403,
                    statusText: 'Forbidden',
                    headers: { get: () => null },
                    text: async () => 'Premium required',
                } as unknown as Response)) as typeof fetch;
                await dj.next();
                assert.strictEqual(errorCallbacks.length, 1);

                // 2. Transient cloud `confirmedPlaying: true` followed by Android 17 background pause (`is_playing: false`):
                //    `triggerStartupPausedSessionKick` verifies playback, and when blocked, immediately clears
                //    `lastPlayTime = 0` + sets `mobileWakeRequired = true` so `getPlaybackState()` stops emitting
                //    `__optimisticFallback: true` instead of faking Play for ~7.5s!
                const djKick = new DJCore('fake_token');
                let pollState: unknown = {
                    is_playing: true,
                    progress_ms: 150,
                    item: djTracks[0],
                    context: null,
                    device: pixelDevice,
                };
                globalThis.fetch = (async () => ({
                    ok: true,
                    status: 204,
                    statusText: 'No Content',
                    headers: { get: () => null },
                    text: async () => '',
                } as unknown as Response)) as typeof fetch;

                const kickInternal = djKick as unknown as {
                    mobileResumeVerifyDelayMs: number;
                    mobileResumeRetryDelayMs: number;
                    spotify: {
                        getMyDevices: () => Promise<{ devices: SpotifyApi.UserDevice[] }>;
                        getMyCurrentPlaybackState: () => Promise<unknown>;
                    };
                    playerClient: {
                        options: {
                            postPlayVerifyDelayMs?: number;
                            retryDelayMs?: number;
                            transferSettleDelayMs?: number;
                        };
                    };
                };
                kickInternal.mobileResumeVerifyDelayMs = 0;
                kickInternal.mobileResumeRetryDelayMs = 0;
                kickInternal.playerClient.options = {
                    ...kickInternal.playerClient.options,
                    postPlayVerifyDelayMs: 0,
                    retryDelayMs: 0,
                    transferSettleDelayMs: 0,
                };
                kickInternal.spotify.getMyDevices = async () => ({ devices: [pixelDevice] });
                kickInternal.spotify.getMyCurrentPlaybackState = async () => pollState;

                await djKick.getDevices();
                await djKick.playTracks(djTracks, { isDJSession: true });
                assert.strictEqual(djKick.hasConfirmedPlayback(), false);
                assert.strictEqual(djKick.getLastPlayTime() > 0, true);

                // Android 17 rejects BFGS / AudioFocus in background -> Spotify flips to `is_playing: false`
                pollState = {
                    is_playing: false,
                    progress_ms: 0,
                    item: djTracks[0],
                    context: null,
                    device: pixelDevice,
                };
                await djKick.getPlaybackState();
                // Allow async `verifyMobileResumeStarted` inside `triggerStartupPausedSessionKick` to settle
                await new Promise((r) => setTimeout(r, 15));

                assert.strictEqual(djKick.isMobileWakeRequired(), true);
                assert.strictEqual(djKick.getLastPlayTime(), 0);
                assert.ok(djKick.getStateSnapshot().status.startsWith('📱'));

                // Next UI poll immediately gets real `is_playing: false` (zero 7.5s fake `__optimisticFallback`!)
                const postKickState = await djKick.getPlaybackState();
                assert.strictEqual(Boolean(postKickState?.__optimisticFallback), false);
                assert.strictEqual(postKickState?.is_playing, false);
            } finally {
                globalThis.fetch = origFetch;
                if (origNavDescriptor) {
                    Object.defineProperty(globalThis, 'navigator', origNavDescriptor);
                } else {
                    delete (globalThis as Record<string, unknown>).navigator;
                }
            }
        });

        it('handles Trap 2A (batch exhaustion paused at 0ms on Track 0 after screen-off Doze), arms mobileWakeRequired on frozen devices:[], and starts fresh Batch 2 on Wake or direct Play', async (t) => {
            const origNavDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
            const origFetch = globalThis.fetch;
            const start2058 = new Date(2026, 10, 15, 20, 58, 0, 0).getTime();
            t.mock.timers.enable({ apis: ['Date'], now: start2058 });

            try {
                Object.defineProperty(globalThis, 'navigator', {
                    value: {
                        userAgent:
                            'Mozilla/5.0 (Linux; Android 17; Pixel 10 Pro XL) AppleWebKit/537.36 Chrome/142.0.0.0 Mobile Safari/537.36',
                    },
                    configurable: true,
                    writable: true,
                });

                const playedUriPayloads: string[][] = [];
                globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
                    if (init?.body) {
                        const parsed = JSON.parse(String(init.body)) as { uris?: string[] };
                        if (Array.isArray(parsed.uris)) {
                            playedUriPayloads.push(parsed.uris);
                        }
                    }
                    return {
                        ok: true,
                        status: 204,
                        statusText: 'No Content',
                        headers: { get: () => null },
                        text: async () => '',
                    } as unknown as Response;
                }) as typeof fetch;

                const pixelDevice: SpotifyApi.UserDevice = {
                    id: 'pixel_10_pro_xl',
                    name: 'Pixel 10 Pro XL',
                    type: 'Smartphone',
                    is_active: true,
                    is_private_session: false,
                    is_restricted: false,
                    volume_percent: 70,
                };

                const batch1 = [
                    makeTrack({ id: 'b1_0', uri: 'spotify:track:b1_0', name: 'Brave Shine', artistName: 'Aimer', duration_ms: 232_000 }),
                    makeTrack({ id: 'b1_1', uri: 'spotify:track:b1_1', name: 'Someone You Loved', artistName: 'Lewis Capaldi', duration_ms: 182_000 }),
                    makeTrack({ id: 'b1_2', uri: 'spotify:track:b1_2', name: 'Ballad Three', artistName: 'Artist 3', duration_ms: 240_000 }),
                    makeTrack({ id: 'b1_3', uri: 'spotify:track:b1_3', name: 'Ballad Four', artistName: 'Artist 4', duration_ms: 235_000 }),
                    makeTrack({ id: 'b1_4', uri: 'spotify:track:b1_4', name: 'Love Hurts', artistName: 'Artist 5', duration_ms: 240_000 }),
                ];
                const batch2 = Array.from({ length: 6 }, (_, idx) =>
                    makeTrack({
                        id: `b2_${idx}`,
                        uri: `spotify:track:b2_${idx}`,
                        name: `Fresh Study Track ${idx + 1}`,
                        artistName: `Fresh Artist ${idx + 1}`,
                        duration_ms: 210_000,
                    })
                );

                let currentDevices: SpotifyApi.UserDevice[] = [pixelDevice];
                let currentPlayback: SpotifyApi.CurrentPlaybackResponse | null = {
                    is_playing: true,
                    progress_ms: 1200,
                    item: batch1[0],
                    context: null,
                    device: pixelDevice,
                } as unknown as SpotifyApi.CurrentPlaybackResponse;
                const observedTargetCounts: (number | undefined)[] = [];
                let searchCall = 0;

                const dj = new DJCore('token_trap_2a');
                const internal = dj as unknown as {
                    mobileResumeVerifyDelayMs: number;
                    mobileResumeRetryDelayMs: number;
                    spotify: {
                        getMyDevices: () => Promise<{ devices: SpotifyApi.UserDevice[] }>;
                        getMyCurrentPlaybackState: () => Promise<SpotifyApi.CurrentPlaybackResponse | null>;
                    };
                    playerClient: {
                        getUserQueue: () => Promise<{ currently_playing: Track | null; queue: Track[] }>;
                        options: {
                            postPlayVerifyDelayMs?: number;
                            retryDelayMs?: number;
                            transferSettleDelayMs?: number;
                            devicePollDelayMs?: number;
                        };
                    };
                    searchTracks: (q: string[], p?: string, ctx?: { targetTrackCount?: number }) => Promise<Track[]>;
                };
                internal.mobileResumeVerifyDelayMs = 0;
                internal.mobileResumeRetryDelayMs = 0;
                internal.playerClient.options = {
                    ...internal.playerClient.options,
                    postPlayVerifyDelayMs: 0,
                    retryDelayMs: 0,
                    transferSettleDelayMs: 0,
                    devicePollDelayMs: 0,
                };
                internal.spotify.getMyDevices = async () => ({ devices: currentDevices });
                internal.spotify.getMyCurrentPlaybackState = async () => currentPlayback;
                internal.playerClient.getUserQueue = async () => ({ currently_playing: null, queue: [] });
                internal.searchTracks = async (_q, _p, ctx) => {
                    observedTargetCounts.push(ctx?.targetTrackCount);
                    searchCall++;
                    return searchCall === 1 ? batch1 : [...batch1, ...batch2];
                };

                dj.setSchedule([
                    { start: '20:58', end: '23:00', query: 'study ballad', queries: ['study ballad'] },
                    { start: '23:00', end: '01:30', query: 'late piano', queries: ['late piano'] },
                ]);

                // 1. Initial 20:58 - 23:00 block requests targetTrackCount = 35 (~2h Doze coverage)
                await dj.processDJLoop(false, false);
                assert.strictEqual(observedTargetCounts[0], 35);
                assert.strictEqual(playedUriPayloads.length, 1);
                await dj.getPlaybackState(); // Confirm Track 0 playing

                // 2. Advance to Track 2 (`Someone You Loved`, index 1), then screen turns off for 20 minutes (Doze!)
                t.mock.timers.setTime(start2058 + 5 * 60_000);
                currentPlayback = {
                    is_playing: true,
                    progress_ms: 45_000,
                    item: batch1[1],
                    context: null,
                    device: pixelDevice,
                } as unknown as SpotifyApi.CurrentPlaybackResponse;
                await dj.getPlaybackState();

                // 20 minutes later (21:22): Batch 1 finished; Spotify reset cursor to Track 0 (`Brave Shine`) paused at 0ms
                t.mock.timers.setTime(start2058 + 24 * 60_000);
                currentPlayback = {
                    is_playing: false,
                    progress_ms: 0,
                    item: batch1[0],
                    context: null,
                    device: { ...pixelDevice, is_active: false },
                } as unknown as SpotifyApi.CurrentPlaybackResponse;

                // Poll 1: Must NOT rewind sessionStartIndex to 0 or resurrect already-played tracks in getQueue()!
                await dj.getPlaybackState();
                const postExhaustionQueue = await dj.getQueue(batch1[0]);
                assert.deepStrictEqual(postExhaustionQueue, []);

                // Poll 2: Android 17 Cached App Freezer freezes Spotify -> `devices: []` arms `mobileWakeRequired = true`!
                currentDevices = [];
                currentPlayback = null;
                await dj.getDevices();
                assert.strictEqual(dj.isMobileWakeRequired(), true);

                // Background loop curates & stages fresh Batch 2 (excluding all 5 played Batch 1 tracks)
                await dj.processDJLoop(true, false);
                const stagedQueue = await dj.getQueue(null);
                assert.strictEqual(stagedQueue[0]?.id, 'b2_1');
                assert.strictEqual(dj.getSessionCache().getSessionTracks()[0]?.id, 'b2_0');

                // User taps 1-Tap Wake (`fromMobileWake: true`): phone wakes paused on old `Brave Shine`,
                // and `dj.resume` pushes the newly staged Batch 2 (`spotify:track:b2_0`)!
                currentDevices = [pixelDevice];
                currentPlayback = {
                    is_playing: false,
                    progress_ms: 0,
                    item: batch1[0],
                    context: null,
                    device: { ...pixelDevice, is_active: false },
                } as unknown as SpotifyApi.CurrentPlaybackResponse;
                globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
                    if (init?.body) {
                        const parsed = JSON.parse(String(init.body)) as { uris?: string[] };
                        if (Array.isArray(parsed.uris)) {
                            playedUriPayloads.push(parsed.uris);
                            if (parsed.uris[0] === 'spotify:track:b2_0') {
                                currentPlayback = {
                                    is_playing: true,
                                    progress_ms: 900,
                                    item: batch2[0],
                                    context: null,
                                    device: pixelDevice,
                                } as unknown as SpotifyApi.CurrentPlaybackResponse;
                            }
                        }
                    }
                    return {
                        ok: true,
                        status: 204,
                        statusText: 'No Content',
                        headers: { get: () => null },
                        text: async () => '',
                    } as unknown as Response;
                }) as typeof fetch;
                dj.setMobileWakeInProgress(true);
                const wakeRes = await dj.resume({ fromMobileWake: true });
                dj.setMobileWakeInProgress(false);
                assert.strictEqual(wakeRes.ok, true);
                assert.strictEqual(playedUriPayloads[playedUriPayloads.length - 1][0], 'spotify:track:b2_0');

                // 3. Direct manual `dj.resume()` BEFORE `getPlaybackState()` polled Trap 2A also curates fresh Batch 3 instead of replaying Track 0!
                const batch3 = [
                    makeTrack({ id: 'b3_0', uri: 'spotify:track:b3_0', name: 'Batch 3 Opening', artistName: 'Artist B3', duration_ms: 200_000 }),
                ];
                internal.searchTracks = async () => batch3;
                // Confirm Batch 2 playing on last track (`b2_5`) 15 minutes later, then Spotify finishes and resets to `b2_0` at 0ms paused
                t.mock.timers.setTime(start2058 + 39 * 60_000);
                currentPlayback = {
                    is_playing: true,
                    progress_ms: 190_000,
                    item: batch2[5],
                    context: null,
                    device: pixelDevice,
                } as unknown as SpotifyApi.CurrentPlaybackResponse;
                await dj.getPlaybackState();

                let playSwitchedToBatch3 = false;
                globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
                    if (init?.body) {
                        const parsed = JSON.parse(String(init.body)) as { uris?: string[] };
                        if (Array.isArray(parsed.uris) && parsed.uris[0] === 'spotify:track:b3_0') {
                            playSwitchedToBatch3 = true;
                            currentPlayback = {
                                is_playing: true,
                                progress_ms: 800,
                                item: batch3[0],
                                context: null,
                                device: pixelDevice,
                            } as unknown as SpotifyApi.CurrentPlaybackResponse;
                        }
                    }
                    return {
                        ok: true,
                        status: 204,
                        statusText: 'No Content',
                        headers: { get: () => null },
                        text: async () => '',
                    } as unknown as Response;
                }) as typeof fetch;

                currentPlayback = {
                    is_playing: false,
                    progress_ms: 0,
                    item: batch2[0],
                    context: null,
                    device: pixelDevice,
                } as unknown as SpotifyApi.CurrentPlaybackResponse;
                const directResumeRes = await dj.resume();
                assert.strictEqual(directResumeRes.ok, true);
                assert.strictEqual(playSwitchedToBatch3, true);
            } finally {
                globalThis.fetch = origFetch;
                if (origNavDescriptor) {
                    Object.defineProperty(globalThis, 'navigator', origNavDescriptor);
                } else {
                    delete (globalThis as Record<string, unknown>).navigator;
                }
            }
        });

        it('handles Trap 2B (Spotify Autoplay after final track) without wiping DJ session while preserving mid-session external takeover detection', async (t) => {
            const baseNow = new Date(2026, 10, 15, 21, 0, 0, 0).getTime();
            t.mock.timers.enable({ apis: ['Date'], now: baseNow });

            const batch1 = Array.from({ length: 5 }, (_, idx) =>
                makeTrack({
                    id: `ap1_${idx}`,
                    uri: `spotify:track:ap1_${idx}`,
                    name: `Session Song ${idx}`,
                    artistName: 'DJ Artist',
                    duration_ms: 200_000,
                })
            );
            const batch2 = [
                makeTrack({ id: 'ap2_0', uri: 'spotify:track:ap2_0', name: 'Next Curated Set', artistName: 'DJ Artist 2', duration_ms: 210_000 }),
            ];
            const autoplayRec = makeTrack({
                id: 'spotify_rec_1',
                uri: 'spotify:track:spotify_rec_1',
                name: 'Autoplay Recommended Song',
                artistName: 'Random Artist',
                duration_ms: 195_000,
            });

            let playbackState: SpotifyApi.CurrentPlaybackResponse | null = null;
            const playedBatches: string[][] = [];

            const dj = new DJCore('token_trap_2b');
            const internal = dj as unknown as {
                spotify: {
                    getMyCurrentPlaybackState: () => Promise<SpotifyApi.CurrentPlaybackResponse | null>;
                };
                playerClient: {
                    getDevices: () => Promise<SpotifyApi.UserDevice[]>;
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: (_dev: string, uris: string[]) => Promise<{
                        confirmedPlaying: boolean;
                        targetTrackLoaded: boolean;
                        targetDeviceId: string;
                        isMobileTarget: boolean;
                    }>;
                    getUserQueue: () => Promise<{ currently_playing: Track | null; queue: Track[] }>;
                    clearLastError: () => void;
                    getLastError: () => null;
                };
                searchTracks: () => Promise<Track[]>;
            };

            const speaker: SpotifyApi.UserDevice = {
                id: 'spk_1',
                name: 'Studio Speaker',
                type: 'Speaker',
                is_active: true,
                is_restricted: false,
                volume_percent: 60,
            };
            internal.playerClient.getDevices = async () => [speaker];
            internal.playerClient.resolveTargetDevice = async () => 'spk_1';
            internal.playerClient.startPlaybackOnDevice = async (_dev, uris) => {
                playedBatches.push(uris);
                return {
                    confirmedPlaying: true,
                    targetTrackLoaded: true,
                    targetDeviceId: 'spk_1',
                    isMobileTarget: false,
                };
            };
            internal.playerClient.getUserQueue = async () => ({ currently_playing: null, queue: [] });
            internal.playerClient.clearLastError = () => {};
            internal.playerClient.getLastError = () => null;
            internal.spotify.getMyCurrentPlaybackState = async () => playbackState;

            let callNum = 0;
            internal.searchTracks = async () => {
                callNum++;
                return callNum === 1 ? batch1 : batch2;
            };

            dj.setSchedule([{ start: '21:00', end: '23:00', query: 'chill', queries: ['chill'] }]);
            await dj.processDJLoop(false, false);

            // Confirm Track 0 (`index 0 of 5`), then Advance to final track (`index 4 of 5`)
            playbackState = {
                is_playing: true,
                progress_ms: 15_000,
                item: batch1[0],
                context: null,
                device: speaker,
            } as unknown as SpotifyApi.CurrentPlaybackResponse;
            await dj.getPlaybackState();

            playbackState = {
                is_playing: true,
                progress_ms: 185_000,
                item: batch1[4],
                context: null,
                device: speaker,
            } as unknown as SpotifyApi.CurrentPlaybackResponse;
            await dj.getPlaybackState();

            // Trap 2B: Final track ends and Spotify Autoplay starts `autoplayRec` (`context: null`)
            t.mock.timers.setTime(baseNow + 90_000);
            playbackState = {
                is_playing: true,
                progress_ms: 3_000,
                item: autoplayRec,
                context: null,
                device: speaker,
            } as unknown as SpotifyApi.CurrentPlaybackResponse;
            await dj.getPlaybackState();

            // Session MUST remain active (NOT wiped as external takeover!), and next loop curates Batch 2!
            assert.strictEqual(dj.isSessionPlaybackActive(), true);
            await dj.processDJLoop(true, false);
            assert.strictEqual(playedBatches.length, 2);
            assert.deepStrictEqual(playedBatches[1], ['spotify:track:ap2_0']);

            // Verify genuine mid-session manual single-song play (at index 0 of multi-track session, 12s elapsed) STILL triggers external takeover!
            const batch3 = Array.from({ length: 5 }, (_, idx) =>
                makeTrack({ id: `mid_${idx}`, uri: `spotify:track:mid_${idx}`, name: `Mid ${idx}`, artistName: 'DJ', duration_ms: 210_000 })
            );
            await dj.playTracks(batch3, { isDJSession: true });
            t.mock.timers.setTime(baseNow + 100_000);
            playbackState = {
                is_playing: true,
                progress_ms: 12_000,
                item: batch3[0],
                context: null,
                device: speaker,
            } as unknown as SpotifyApi.CurrentPlaybackResponse;
            await dj.getPlaybackState();

            t.mock.timers.setTime(baseNow + 112_000);
            const manualForeignTrack = makeTrack({
                id: 'manual_pick',
                uri: 'spotify:track:manual_pick',
                name: 'User Picked Song',
                artistName: 'Other Band',
            });
            playbackState = {
                is_playing: true,
                progress_ms: 1_500,
                item: manualForeignTrack,
                context: null,
                device: speaker,
            } as unknown as SpotifyApi.CurrentPlaybackResponse;
            await dj.getPlaybackState();
            assert.strictEqual(dj.isSessionPlaybackActive(), false);
        });

        it('prevents Auto-Refill carryover tracks in Spotify User Queue from wiping the next schedule block and skips pre-transition overfill', async (t) => {
            const start2200 = new Date(2026, 10, 15, 22, 0, 0, 0).getTime();
            t.mock.timers.enable({ apis: ['Date'], now: start2200 });

            const block1Tracks = [
                makeTrack({ id: 's1_0', uri: 'spotify:track:s1_0', name: 'Block1 One', artistName: 'A1', duration_ms: 200_000 }),
                makeTrack({ id: 's1_1', uri: 'spotify:track:s1_1', name: 'Block1 Two', artistName: 'A1', duration_ms: 200_000 }),
                makeTrack({ id: 's1_2', uri: 'spotify:track:s1_2', name: 'Block1 Three', artistName: 'A1', duration_ms: 200_000 }),
            ];
            const refillTrack = makeTrack({
                id: 'refill_carry_1',
                uri: 'spotify:track:refill_carry_1',
                name: 'Refill Carryover Ballad',
                artistName: 'Refill Singer',
                duration_ms: 210_000,
            });
            const block2Tracks = [
                makeTrack({ id: 's2_0', uri: 'spotify:track:s2_0', name: 'Midnight Jazz 1', artistName: 'Bill Evans', duration_ms: 220_000 }),
                makeTrack({ id: 's2_1', uri: 'spotify:track:s2_1', name: 'Midnight Jazz 2', artistName: 'Bill Evans', duration_ms: 220_000 }),
                makeTrack({ id: 's2_2', uri: 'spotify:track:s2_2', name: 'Midnight Jazz 3', artistName: 'Bill Evans', duration_ms: 220_000 }),
            ];

            const addedToUserQueue: string[] = [];
            let playbackState: SpotifyApi.CurrentPlaybackResponse | null = null;
            const speaker: SpotifyApi.UserDevice = {
                id: 'spk_q',
                name: 'Speaker',
                type: 'Speaker',
                is_active: true,
                is_restricted: false,
                volume_percent: 70,
            };

            const dj = new DJCore('token_carryover');
            const internal = dj as unknown as {
                spotify: {
                    getMyCurrentPlaybackState: () => Promise<SpotifyApi.CurrentPlaybackResponse | null>;
                };
                playerClient: {
                    getDevices: () => Promise<SpotifyApi.UserDevice[]>;
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: () => Promise<{
                        confirmedPlaying: boolean;
                        targetTrackLoaded: boolean;
                        targetDeviceId: string;
                        isMobileTarget: boolean;
                    }>;
                    addToQueue: (uri: string) => Promise<{ ok: boolean; status?: number }>;
                    getUserQueue: () => Promise<{ currently_playing: Track | null; queue: Track[] }>;
                    clearLastError: () => void;
                    getLastError: () => null;
                };
                searchTracks: (queries: string[]) => Promise<Track[]>;
            };

            internal.playerClient.getDevices = async () => [speaker];
            internal.playerClient.resolveTargetDevice = async () => 'spk_q';
            internal.playerClient.startPlaybackOnDevice = async () => ({
                confirmedPlaying: true,
                targetTrackLoaded: true,
                targetDeviceId: 'spk_q',
                isMobileTarget: false,
            });
            internal.playerClient.addToQueue = async (uri: string) => {
                addedToUserQueue.push(uri);
                return { ok: true, status: 204 };
            };
            internal.playerClient.getUserQueue = async () => ({ currently_playing: null, queue: [] });
            internal.playerClient.clearLastError = () => {};
            internal.playerClient.getLastError = () => null;
            internal.spotify.getMyCurrentPlaybackState = async () => playbackState;
            internal.searchTracks = async (queries: string[]) => {
                if (queries[0] === 'midnight jazz') return block2Tracks;
                return [...block1Tracks, refillTrack];
            };

            dj.setSchedule([
                { start: '22:00', end: '23:00', query: 'study pop', queries: ['study pop'] },
                { start: '23:00', end: '01:00', query: 'midnight jazz', queries: ['midnight jazz'] },
            ]);

            // 1. Start Block 1 at 22:00 (only returns block1Tracks initially)
            internal.searchTracks = async (queries: string[]) =>
                queries[0] === 'midnight jazz' ? block2Tracks : block1Tracks;
            await dj.processDJLoop(false, false);

            playbackState = {
                is_playing: true,
                progress_ms: 30_000,
                item: block1Tracks[0],
                context: null,
                device: speaker,
            } as unknown as SpotifyApi.CurrentPlaybackResponse;
            await dj.getPlaybackState();

            // 2. At 22:05 (55m remaining in Block 1), queue has 2 tracks (< MIN_QUEUE_SIZE_FOR_REFILL=3) -> refills `refill_carry_1`!
            internal.searchTracks = async (queries: string[]) =>
                queries[0] === 'midnight jazz' ? block2Tracks : [refillTrack];
            t.mock.timers.setTime(new Date(2026, 10, 15, 22, 5, 0, 0).getTime());
            await dj.processDJLoop(true, false);
            assert.deepStrictEqual(addedToUserQueue, ['spotify:track:refill_carry_1']);

            // 3. At 22:57 (only 3m remaining until 23:00 Block 2 transition; 2 queued tracks + 170s current = ~9.8m > 3m + 45s):
            //    Must skip `addToQueue` so we do NOT dump extra leftover tracks into Spotify's persistent User Queue right before 23:00!
            const lateExtra = makeTrack({ id: 'late_extra', uri: 'spotify:track:late_extra', name: 'Late Extra', artistName: 'X', duration_ms: 200_000 });
            internal.searchTracks = async (queries: string[]) =>
                queries[0] === 'midnight jazz' ? block2Tracks : [lateExtra];
            playbackState = {
                is_playing: true,
                progress_ms: 30_000,
                item: block1Tracks[1],
                context: null,
                device: speaker,
            } as unknown as SpotifyApi.CurrentPlaybackResponse;
            t.mock.timers.setTime(new Date(2026, 10, 15, 22, 57, 0, 0).getTime());
            await dj.processDJLoop(true, false);
            assert.deepStrictEqual(addedToUserQueue, ['spotify:track:refill_carry_1']); // Unchanged!

            // 4. At 23:00, Block 2 (`midnight jazz`) starts and Track 1 (`s2_0`) confirms playing
            t.mock.timers.setTime(new Date(2026, 10, 15, 23, 0, 5, 0).getTime());
            await dj.processDJLoop(true, false);
            t.mock.timers.setTime(new Date(2026, 10, 15, 23, 0, 15, 0).getTime());
            playbackState = {
                is_playing: true,
                progress_ms: 10_000,
                item: block2Tracks[0],
                context: null,
                device: speaker,
            } as unknown as SpotifyApi.CurrentPlaybackResponse;
            await dj.getPlaybackState();
            assert.strictEqual(dj.hasConfirmedPlayback(), true);

            // 5. After `s2_0` finishes, Spotify's persistent User Queue plays leftover `refill_carry_1` (`context: null`)!
            //    Must NOT trigger `handleExternalPlaybackDetected()` or wipe Block 2's `sessionTracks`!
            t.mock.timers.setTime(new Date(2026, 10, 15, 23, 3, 50, 0).getTime());
            playbackState = {
                is_playing: true,
                progress_ms: 8_000,
                item: refillTrack,
                context: null,
                device: speaker,
            } as unknown as SpotifyApi.CurrentPlaybackResponse;
            await dj.getPlaybackState();
            assert.strictEqual(dj.isSessionPlaybackActive(), true);
            const remainingBlock2Queue = await dj.getQueue(refillTrack);
            assert.deepStrictEqual(
                remainingBlock2Queue.map(tr => tr.id),
                ['s2_1', 's2_2']
            );
        });

        it('snaps Block 0 start time at 22:32 even when LLM clock-rounding drifts Block 0 start (23:12) past Block 0 end (23:00)', async (t) => {
            const at2232 = new Date(2026, 10, 15, 22, 32, 0, 0).getTime();
            t.mock.timers.enable({ apis: ['Date'], now: at2232 });

            const dj = new DJCore('token_2232');
            (dj as unknown as { ai: { generateSchedule: () => Promise<ScheduleItem[]> } }).ai = {
                generateSchedule: async () => [
                    { start: '23:12', end: '23:00', query: 'ocean walk', queries: ['ocean walk'] },
                    { start: '23:00', end: '01:00', query: 'piano jazz', queries: ['piano jazz'] },
                ],
            };

            const schedule = await dj.createSchedule('海を散歩したい気分に合う音楽を。今夜23時からはピアノのJazzを聴きたいです。');
            assert.strictEqual(schedule[0].start, '22:32');
            assert.strictEqual(schedule[0].end, '23:00');
            assert.strictEqual(schedule[1].start, '23:00');
        });

        it('handles Trap 2A from non-zero startIdx, avoids double playTracks on mobile wake continuation, guards 1-track sessions, and supports Next/Prev/Carryover Resume', async (t) => {
            const baseNow = new Date(2026, 10, 15, 21, 0, 0, 0).getTime();
            t.mock.timers.enable({ apis: ['Date'], now: baseNow });

            const batch1 = [
                makeTrack({ id: 'n_0', uri: 'spotify:track:n_0', name: 'N0', artistName: 'A', duration_ms: 180_000 }),
                makeTrack({ id: 'n_1', uri: 'spotify:track:n_1', name: 'N1', artistName: 'A', duration_ms: 180_000 }),
                makeTrack({ id: 'n_2', uri: 'spotify:track:n_2', name: 'N2', artistName: 'A', duration_ms: 180_000 }),
                makeTrack({ id: 'n_3', uri: 'spotify:track:n_3', name: 'N3', artistName: 'A', duration_ms: 180_000 }),
            ];
            const batch2 = [
                makeTrack({ id: 'm_0', uri: 'spotify:track:m_0', name: 'M0', artistName: 'B', duration_ms: 180_000 }),
                makeTrack({ id: 'm_1', uri: 'spotify:track:m_1', name: 'M1', artistName: 'B', duration_ms: 180_000 }),
            ];

            let playbackState: SpotifyApi.CurrentPlaybackResponse | null = null;
            const startedUrisHistory: string[][] = [];
            let bareResumeCalls = 0;
            const mobileDevice: SpotifyApi.UserDevice = {
                id: 'pixel_10',
                name: 'Pixel 10 Pro XL',
                type: 'Smartphone',
                is_active: true,
                is_restricted: false,
                volume_percent: 80,
            };

            const dj = new DJCore('token_edge_cases');
            const internal = dj as unknown as {
                spotify: {
                    getMyCurrentPlaybackState: () => Promise<SpotifyApi.CurrentPlaybackResponse | null>;
                };
                playerClient: {
                    getDevices: () => Promise<SpotifyApi.UserDevice[]>;
                    resolveTargetDevice: () => Promise<string>;
                    startPlaybackOnDevice: (deviceId: string, uris: string[]) => Promise<{
                        confirmedPlaying: boolean;
                        targetTrackLoaded: boolean;
                        targetDeviceId: string;
                        isMobileTarget: boolean;
                    }>;
                    resume: () => Promise<{ ok: boolean; status?: number }>;
                    next: () => Promise<{ ok: boolean; status?: number }>;
                    ensurePlaybackModes: () => Promise<void>;
                    clearLastError: () => void;
                    getLastError: () => null;
                };
                mobileResumeVerifyDelayMs: number;
                mobileResumeRetryDelayMs: number;
                canWakeLocalMobileSpotify: () => boolean;
                searchTracks: () => Promise<Track[]>;
            };

            internal.mobileResumeVerifyDelayMs = 0;
            internal.mobileResumeRetryDelayMs = 0;
            internal.canWakeLocalMobileSpotify = () => true;
            internal.playerClient.ensurePlaybackModes = async () => {};
            internal.playerClient.getDevices = async () => [mobileDevice];
            internal.playerClient.resolveTargetDevice = async () => 'pixel_10';
            internal.playerClient.startPlaybackOnDevice = async (_deviceId: string, uris: string[]) => {
                startedUrisHistory.push(uris);
                return {
                    confirmedPlaying: true,
                    targetTrackLoaded: true,
                    targetDeviceId: 'pixel_10',
                    isMobileTarget: true,
                };
            };
            internal.playerClient.resume = async () => {
                bareResumeCalls++;
                playbackState = playbackState
                    ? ({ ...playbackState, is_playing: true, progress_ms: 12_000 } as SpotifyApi.CurrentPlaybackResponse)
                    : null;
                return { ok: true, status: 204 };
            };
            let rawNextCalls = 0;
            internal.playerClient.next = async () => {
                rawNextCalls++;
                return { ok: true, status: 204 };
            };
            internal.playerClient.clearLastError = () => {};
            internal.playerClient.getLastError = () => null;
            internal.spotify.getMyCurrentPlaybackState = async () => playbackState;
            internal.searchTracks = async () => batch2;

            dj.setSchedule([{ start: '21:00', end: '23:00', query: 'night ballad', queries: ['night ballad'] }]);
            (dj as unknown as { lastQuery: string }).lastQuery = 'night ballad';

            // 1. Start session at non-zero index (`startIdx = 2`, i.e., user tapped `n_2` in Up Next)
            dj.getSessionCache().setSessionTracks(batch1, true, 0);
            await dj.playFromQueueIndex(2, batch1);
            assert.deepStrictEqual(startedUrisHistory[0], ['spotify:track:n_2', 'spotify:track:n_3']);

            // Confirm `n_3` playing
            t.mock.timers.setTime(baseNow + 190_000);
            playbackState = {
                is_playing: true,
                progress_ms: 40_000,
                item: batch1[3],
                context: null,
                device: mobileDevice,
            } as unknown as SpotifyApi.CurrentPlaybackResponse;
            await dj.getPlaybackState();

            // Spotify finishes `[n_2, n_3]` and resets paused (`0ms`) onto `n_2` (`sessionIndex === 2`, NOT `0`!):
            // Trap 2A must detect exhaustion at `batchOriginSessionIndex === 2` instead of rewinding to `n_2`!
            t.mock.timers.setTime(baseNow + 360_000);
            playbackState = {
                is_playing: false,
                progress_ms: 0,
                item: batch1[2],
                context: null,
                device: mobileDevice,
            } as unknown as SpotifyApi.CurrentPlaybackResponse;
            await dj.getPlaybackState();
            assert.strictEqual(dj.getSessionCache().isBatchExhausted(), true);
            assert.strictEqual(dj.getSessionCache().getSessionStartIndex(), 3);

            // 2. `stageNavigationForMobileWake({ type: 'next' })` + `dj.resume({ fromMobileWake: true })`:
            //    Must preserve `batchExhausted = true` and call `startPlaybackOnDevice` (`playTracks`) EXACTLY ONCE (not twice!)
            dj.stageNavigationForMobileWake({ type: 'next' });
            assert.strictEqual(dj.getSessionCache().isBatchExhausted(), true);
            startedUrisHistory.length = 0;
            const wakeRes = await dj.resume({ fromMobileWake: true });
            assert.strictEqual(wakeRes.ok, true);
            assert.strictEqual(startedUrisHistory.length, 1);
            assert.deepStrictEqual(startedUrisHistory[0], ['spotify:track:m_0', 'spotify:track:m_1']);

            // 3. Pressing `dj.previous()` and `dj.next()` when `batchExhausted === true`
            t.mock.timers.setTime(baseNow + 550_000);
            playbackState = {
                is_playing: true,
                progress_ms: 30_000,
                item: batch2[1],
                context: null,
                device: mobileDevice,
            } as unknown as SpotifyApi.CurrentPlaybackResponse;
            await dj.getPlaybackState();
            dj.getSessionCache().setBatchExhausted(true);
            startedUrisHistory.length = 0;
            const prevOnExhausted = await dj.previous();
            assert.strictEqual(prevOnExhausted.ok, true);
            assert.deepStrictEqual(startedUrisHistory[0], ['spotify:track:m_0', 'spotify:track:m_1']);

            dj.getSessionCache().setSessionStartIndex(1);
            dj.getSessionCache().setBatchExhausted(true);
            const batch3 = [makeTrack({ id: 'k_0', uri: 'spotify:track:k_0', name: 'K0', artistName: 'C', duration_ms: 240_000 })];
            internal.searchTracks = async () => batch3;
            startedUrisHistory.length = 0;
            const nextOnExhausted = await dj.next();
            assert.strictEqual(nextOnExhausted.ok, true);
            assert.strictEqual(rawNextCalls, 0);
            assert.strictEqual(startedUrisHistory.length, 1);
            assert.deepStrictEqual(startedUrisHistory[0], ['spotify:track:k_0']);

            // 4. Single-track session (`k_0`, 240s): manual external song pick 5s after confirmation MUST yield to external takeover!
            t.mock.timers.setTime(baseNow + 560_000);
            playbackState = {
                is_playing: true,
                progress_ms: 5_000,
                item: batch3[0],
                context: null,
                device: mobileDevice,
            } as unknown as SpotifyApi.CurrentPlaybackResponse;
            await dj.getPlaybackState();
            assert.strictEqual(dj.hasConfirmedPlayback(), true);

            t.mock.timers.setTime(baseNow + 565_000);
            const userManualSong = makeTrack({ id: 'user_song', uri: 'spotify:track:user_song', name: 'User Song', artistName: 'User' });
            playbackState = {
                is_playing: true,
                progress_ms: 1_000,
                item: userManualSong,
                context: null,
                device: mobileDevice,
            } as unknown as SpotifyApi.CurrentPlaybackResponse;
            await dj.getPlaybackState();
            assert.strictEqual(dj.isSessionPlaybackActive(), false);

            // 5. Resuming while paused on a known Auto-Refill carryover track resumes it in place via `playerClient.resume`
            dj.getSessionCache().activateDJSession(batch2, true, 0);
            t.mock.timers.setTime(baseNow + 600_000);
            playbackState = {
                is_playing: true,
                progress_ms: 20_000,
                item: batch2[0],
                context: null,
                device: mobileDevice,
            } as unknown as SpotifyApi.CurrentPlaybackResponse;
            await dj.getPlaybackState();

            const carryoverTrack = makeTrack({ id: 'carry_resume', uri: 'spotify:track:carry_resume', name: 'Carryover', artistName: 'D' });
            dj.getSessionCache().recordRefillQueuedTrack(carryoverTrack, baseNow + 600_000);
            playbackState = {
                is_playing: false,
                progress_ms: 45_000,
                item: carryoverTrack,
                context: null,
                device: mobileDevice,
            } as unknown as SpotifyApi.CurrentPlaybackResponse;
            startedUrisHistory.length = 0;
            bareResumeCalls = 0;
            const resumeCarryRes = await dj.resume();
            assert.strictEqual(resumeCarryRes.ok, true);
            assert.strictEqual(bareResumeCalls, 1);
            assert.strictEqual(startedUrisHistory.length, 0);
        });
    });
});

