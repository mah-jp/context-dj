import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TrackSessionCache } from '../src/lib/track-session-cache';
import { Track } from '../src/lib/types';

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

describe('TrackSessionCache', () => {
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

    it('tracks played songs by URI and normalized trackKey', () => {
        const cache = new TrackSessionCache();
        const t1 = makeTrack({
            id: '1',
            uri: 'spotify:track:1',
            name: 'Sparkle',
            artistName: 'Tatsuro Yamashita'
        });
        const t1Relinked = makeTrack({
            id: '2',
            uri: 'spotify:track:2',
            name: 'Sparkle - 2023 Remaster',
            artistName: 'Tatsuro Yamashita'
        });

        assert.strictEqual(cache.isTrackPlayedInSession(t1), false);
        cache.markTrackPlayed(t1);
        assert.strictEqual(cache.isTrackPlayedInSession(t1), true);
        assert.strictEqual(cache.isTrackPlayedInSession(t1Relinked), true);

        cache.resetSessionPlayedHistory();
        assert.strictEqual(cache.isTrackPlayedInSession(t1), false);
    });

    it('persists and enriches metadata across URI, ID, and trackKey', () => {
        const cache = new TrackSessionCache();
        const original = makeTrack({
            id: 'orig1',
            uri: 'spotify:track:orig1',
            name: 'Plastic Love',
            artistName: 'Mariya Takeuchi',
            selectionReason: 'Iconic city pop groove',
            vibeTag: '#CityPop',
            stage: 'peak'
        });
        cache.cacheTrackMetadata([original]);

        const relinked = makeTrack({
            id: 'relinked99',
            uri: 'spotify:track:relinked99',
            name: 'Plastic Love (Remastered)',
            artistName: 'Mariya Takeuchi'
        });
        const enriched = cache.enrichTrackWithCachedMetadata(relinked);
        assert.strictEqual(enriched.selectionReason, 'Iconic city pop groove');
        assert.strictEqual(enriched.vibeTag, '#CityPop');
        assert.strictEqual(enriched.stage, 'peak');
    });

    it('returns empty array from getSessionTracksFromCurrent when activeTrack is external and clears session tracks cleanly', () => {
        const cache = new TrackSessionCache();
        const t1 = makeTrack({ id: '1', uri: 'spotify:track:1', name: 'Song 1', artistName: 'Artist 1' });
        const t2 = makeTrack({ id: '2', uri: 'spotify:track:2', name: 'Song 2', artistName: 'Artist 2' });
        const external = makeTrack({ id: 'ext', uri: 'spotify:track:ext', name: 'External Song', artistName: 'Other Artist' });

        cache.setSessionTracks([t1, t2], true);
        assert.strictEqual(cache.getSessionTracksFromCurrent(t1).length, 1);
        assert.strictEqual(cache.getSessionTracksFromCurrent(t1)[0].id, '2');

        // External track not in session -> must return [] instead of stale slice(1)
        assert.deepStrictEqual(cache.getSessionTracksFromCurrent(external), []);

        cache.clearSessionTracks(true);
        assert.deepStrictEqual(cache.getSessionTracks(), []);
        assert.strictEqual(store['dj_current_session_tracks'], undefined);
    });
});
