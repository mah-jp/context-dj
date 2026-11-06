import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    extractTargetArtists,
    isTrackByTargetArtist,
    deduplicateTracks,
    filterTracksByPopularityAndArtist,
    sequenceTracksByStory,
} from '../src/lib/track-curator';
import { Track } from '../src/lib/types';

function createMockTrack(overrides: {
    id: string;
    name: string;
    artistName: string;
    popularity?: number;
    stage?: 'intro' | 'build' | 'peak' | 'outro';
    energy?: number;
    estimatedBpm?: number;
    score?: number;
}): Track {
    return {
        id: overrides.id,
        uri: `spotify:track:${overrides.id}`,
        name: overrides.name,
        artists: [{ name: overrides.artistName } as SpotifyApi.ArtistObjectSimplified],
        album: {} as SpotifyApi.AlbumObjectSimplified,
        popularity: overrides.popularity ?? 50,
        stage: overrides.stage,
        energy: overrides.energy,
        estimatedBpm: overrides.estimatedBpm,
        score: overrides.score,
        type: 'track',
    } as unknown as Track;
}

describe('track-curator', () => {
    describe('extractTargetArtists', () => {
        it('extracts quoted and unquoted artist names from queries and deduplicates without swallowing trailing keywords', () => {
            const queries = [
                'artist:"Bill Evans" piano',
                'artist:Nujabes lofi chill',
                'artist:"Bill Evans" trio',
                'genre:jazz chill',
            ];
            const artists = extractTargetArtists(queries);
            assert.deepStrictEqual(artists, ['bill evans', 'nujabes']);
        });
    });

    describe('isTrackByTargetArtist', () => {
        it('matches primary or collaborating artists and does not match empty artist names', () => {
            const emptyArtistTrack = createMockTrack({ id: 'e1', name: 'No Artist', artistName: '' });
            const collabTrack = {
                ...createMockTrack({ id: 'c1', name: 'Battlecry', artistName: 'Shing02' }),
                artists: [
                    { name: 'Shing02' } as SpotifyApi.ArtistObjectSimplified,
                    { name: 'Nujabes' } as SpotifyApi.ArtistObjectSimplified,
                ],
            } as Track;

            assert.strictEqual(isTrackByTargetArtist(emptyArtistTrack, ['nujabes']), false);
            assert.strictEqual(isTrackByTargetArtist(collabTrack, ['nujabes']), true);
        });
    });

    describe('deduplicateTracks', () => {
        it('removes duplicate tracks by normalized title+artist key', () => {
            const tracks = [
                createMockTrack({ id: '1', name: 'Luv(sic)', artistName: 'Nujabes' }),
                createMockTrack({ id: '1', name: 'Luv(sic)', artistName: 'Nujabes' }),
                createMockTrack({ id: '2', name: 'Luv(sic) (Remastered)', artistName: 'Nujabes' }),
                createMockTrack({ id: '3', name: 'Feather', artistName: 'Nujabes' }),
            ];

            const result = deduplicateTracks(tracks);
            assert.strictEqual(result.length, 2);
            assert.strictEqual(result[0].id, '1');
            assert.strictEqual(result[1].id, '3');
        });
    });

    describe('filterTracksByPopularityAndArtist', () => {
        it('filters by preferred popularity and relaxes to minPopularity when fewer than 5 tracks match', () => {
            const tracks = [
                createMockTrack({ id: '1', name: 'Indie 1', artistName: 'Indie', popularity: 10 }),
                createMockTrack({ id: '2', name: 'Indie 2', artistName: 'Indie', popularity: 8 }),
                createMockTrack({ id: '3', name: 'Indie 3', artistName: 'Indie', popularity: 7 }),
                createMockTrack({ id: '4', name: 'Indie 4', artistName: 'Indie', popularity: 6 }),
                createMockTrack({ id: '5', name: 'Too Low', artistName: 'Indie', popularity: 2 }),
            ];

            const result = filterTracksByPopularityAndArtist(tracks, [], 15, 5);
            assert.strictEqual(result.relaxedToMin, true);
            assert.strictEqual(result.revertedToAll, false);
            assert.strictEqual(result.tracks.length, 4);
            assert.deepStrictEqual(result.tracks.map(t => t.id), ['1', '2', '3', '4']);
        });

        it('preserves target artist tracks regardless of popularity', () => {
            const tracks = [
                createMockTrack({ id: '1', name: 'Rare Track', artistName: 'Bill Evans', popularity: 1 }),
                createMockTrack({ id: '2', name: 'Popular Track', artistName: 'Other Artist', popularity: 50 }),
                createMockTrack({ id: '3', name: 'Unpopular Other', artistName: 'Other Artist', popularity: 2 }),
            ];

            const result = filterTracksByPopularityAndArtist(tracks, ['bill evans'], 15, 5);
            assert.strictEqual(result.targetPreservedCount, 1);
            assert.deepStrictEqual(result.tracks.map(t => t.id), ['1', '2']);
        });
    });

    describe('sequenceTracksByStory', () => {
        it('orders tracks by stage (intro -> build -> peak -> outro) and smooths energy/BPM', () => {
            const tracks = [
                createMockTrack({ id: 'outro1', name: 'Outro', artistName: 'A', stage: 'outro', energy: 3, estimatedBpm: 80 }),
                createMockTrack({ id: 'peak1', name: 'Peak', artistName: 'B', stage: 'peak', energy: 9, estimatedBpm: 128 }),
                createMockTrack({ id: 'intro1', name: 'Intro', artistName: 'C', stage: 'intro', energy: 4, estimatedBpm: 95 }),
                createMockTrack({ id: 'build1', name: 'Build', artistName: 'D', stage: 'build', energy: 7, estimatedBpm: 115 }),
            ];

            const result = sequenceTracksByStory(tracks);
            assert.deepStrictEqual(
                result.tracks.map(t => t.id),
                ['intro1', 'build1', 'peak1', 'outro1']
            );
            assert.deepStrictEqual(result.stageCounts, {
                intro: 1,
                build: 1,
                peak: 1,
                outro: 1,
            });
        });

        it('automatically rebalances tracks into 4 stages by energy when stage is missing or uniform', () => {
            const uncategorized = [
                createMockTrack({ id: 't1', name: 'High 1', artistName: 'A', energy: 9, score: 85 }),
                createMockTrack({ id: 't2', name: 'Low 1', artistName: 'B', energy: 2, score: 90 }),
                createMockTrack({ id: 't3', name: 'Mid 1', artistName: 'C', energy: 5, score: 80 }),
                createMockTrack({ id: 't4', name: 'High 2', artistName: 'D', energy: 8, score: 88 }),
                createMockTrack({ id: 't5', name: 'Mid 2', artistName: 'E', energy: 6, score: 75 }),
                createMockTrack({ id: 't6', name: 'Calm Outro', artistName: 'F', energy: 10, score: 70 }),
            ];

            const result = sequenceTracksByStory(uncategorized);
            assert.strictEqual(result.tracks.length, 6);
            assert.ok(result.stageCounts.intro >= 1);
            assert.ok(result.stageCounts.build >= 1);
            assert.ok(result.stageCounts.peak >= 1);
            assert.ok(result.stageCounts.outro >= 1);
            assert.strictEqual(result.tracks[0].stage, 'intro');
            assert.strictEqual(result.tracks[result.tracks.length - 1].stage, 'outro');
        });
    });
});
