import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import SpotifyWebApi from 'spotify-web-api-js';
import { TrackSearchPipeline } from '../src/lib/track-search-pipeline';
import { TrackSessionCache } from '../src/lib/track-session-cache';
import { AIService } from '../src/lib/ai';
import { DJConfig, Track, TrackEvaluation } from '../src/lib/types';

function makeTrack(overrides: {
    id: string;
    name: string;
    artistName: string;
    popularity?: number;
    uri?: string;
}): Track {
    return {
        id: overrides.id,
        uri: overrides.uri ?? `spotify:track:${overrides.id}`,
        name: overrides.name,
        artists: [{ name: overrides.artistName } as SpotifyApi.ArtistObjectSimplified],
        album: { name: 'Album' } as SpotifyApi.AlbumObjectSimplified,
        popularity: overrides.popularity ?? 50,
        type: 'track',
    } as unknown as Track;
}

describe('TrackSearchPipeline', () => {
    let store: Record<string, string> = {};
    let logs: string[] = [];
    let statuses: string[] = [];
    let config: DJConfig;

    beforeEach(() => {
        store = {};
        logs = [];
        statuses = [];
        config = {
            minPopularity: 20,
            trackSearchLimit: 5,
            onlyOfficial: false,
            aiFiltering: true,
        };
        const localStorageMock = {
            getItem: (key: string) => store[key] ?? null,
            setItem: (key: string, value: string) => { store[key] = String(value); },
            removeItem: (key: string) => { delete store[key]; },
            clear: () => { store = {}; },
        };
        const g = globalThis as Record<string, unknown>;
        g.window = { localStorage: localStorageMock };
        g.localStorage = localStorageMock;
    });

    it('resolves priority track, anchor tracks, parallel search, AI filtering, and story sequencing', async () => {
        const priorityHit = makeTrack({ id: 'prio1', name: 'Opening Theme', artistName: 'Hero Artist', popularity: 80 });
        const anchorHit = makeTrack({ id: 'anc1', name: 'Anchor Song', artistName: 'Anchor Artist', popularity: 75 });
        const searchHits = [
            makeTrack({ id: 's1', name: 'Track One', artistName: 'Artist A', popularity: 60 }),
            makeTrack({ id: 's2', name: 'Track Two', artistName: 'Artist B', popularity: 65 }),
            makeTrack({ id: 's3', name: 'Track Three', artistName: 'Artist C', popularity: 70 }),
            makeTrack({ id: 's4', name: 'Low Pop Track', artistName: 'Artist D', popularity: 2 }),
        ];

        const fakeSpotify = {
            searchTracks: async (query: string, opts?: { offset?: number }) => {
                if (opts?.offset && opts.offset > 0) {
                    return { tracks: { items: [] } };
                }
                if (query.includes('Opening Theme')) {
                    return { tracks: { items: [priorityHit] } };
                }
                if (query.includes('Anchor Song')) {
                    return { tracks: { items: [anchorHit] } };
                }
                return { tracks: { items: searchHits } };
            },
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;

        const fakeAI = {
            filterTracksWithAI: async (): Promise<TrackEvaluation[]> => [
                { id: 'spotify:track:anc1', score: 92, vibeTag: '#AnchorVibe', selectionReason: 'Anchor reason', energy: 4, stage: 'intro' },
                { id: 'spotify:track:s1', score: 85, vibeTag: '#BuildVibe', selectionReason: 'Build reason', energy: 6, stage: 'build' },
                { id: 'spotify:track:s2', score: 95, vibeTag: '#PeakVibe', selectionReason: 'Peak reason', energy: 9, stage: 'peak' },
                { id: 'spotify:track:s3', score: 78, vibeTag: '#OutroVibe', selectionReason: 'Outro reason', energy: 3, stage: 'outro' },
            ],
        } as unknown as AIService;

        const sessionCache = new TrackSessionCache();
        const pipeline = new TrackSearchPipeline({
            getSpotify: () => fakeSpotify,
            getAI: () => fakeAI,
            getConfig: () => config,
            sessionCache,
            addLog: (m) => logs.push(m),
            updateStatus: (s) => statuses.push(s),
        });

        const result = await pipeline.searchTracks(
            ['sunset chill'],
            'Opening Theme artist:"Hero Artist"',
            {
                userRequest: 'Play sunset chill',
                thought: 'Smooth sunset transition',
                anchorTracks: ['Anchor Song - Anchor Artist'],
            }
        );

        // Priority track must be placed at index 0
        assert.strictEqual(result[0].id, 'prio1');
        assert.strictEqual(result[0].stage, 'intro');
        assert.strictEqual(result[0].vibeTag, '#オープニング');

        // Remaining tracks are sequenced by story arc (intro -> build -> peak -> outro)
        assert.deepStrictEqual(
            result.slice(1).map(t => t.id),
            ['anc1', 's1', 's2', 's3']
        );

        // Metadata is cached in TrackSessionCache
        const enriched = sessionCache.enrichTrackWithCachedMetadata(
            makeTrack({ id: 's2', name: 'Track Two', artistName: 'Artist B' })
        );
        assert.strictEqual(enriched.vibeTag, '#PeakVibe');
        assert.strictEqual(enriched.selectionReason, 'Peak reason');
        assert.ok(logs.some(l => l.includes('Priority track applied at the top')));
    });

    it('relaxes AI score threshold to 50 when fewer than 5 tracks score >= 60, and reverts when all are filtered out', async () => {
        const candidates = [
            makeTrack({ id: 'c1', name: 'C1', artistName: 'A1', popularity: 50 }),
            makeTrack({ id: 'c2', name: 'C2', artistName: 'A2', popularity: 50 }),
        ];

        let aiEvaluations: TrackEvaluation[] = [
            { id: 'spotify:track:c1', score: 55, vibeTag: '#Okay', selectionReason: 'Borderline match' },
            { id: 'spotify:track:c2', score: 30, vibeTag: '#Weak', selectionReason: 'Low match' },
        ];

        const fakeAI = {
            filterTracksWithAI: async () => aiEvaluations,
        } as unknown as AIService;

        const sessionCache = new TrackSessionCache();
        const pipeline = new TrackSearchPipeline({
            getSpotify: () => ({} as SpotifyWebApi.SpotifyWebApiJs),
            getAI: () => fakeAI,
            getConfig: () => config,
            sessionCache,
            addLog: (m) => logs.push(m),
            updateStatus: (s) => statuses.push(s),
        });

        // 1. Score 55 is kept via relaxation to >= 50 when < 5 tracks score >= 60
        const relaxedResult = await pipeline.performAIFiltering(
            candidates.map(c => ({ ...c })),
            { userRequest: 'test' }
        );
        assert.strictEqual(relaxedResult.length, 1);
        assert.strictEqual(relaxedResult[0].id, 'c1');

        // 2. When all scores are below 50, reverts to original candidate set
        aiEvaluations = [
            { id: 'spotify:track:c1', score: 20, vibeTag: '#Low', selectionReason: 'No' },
            { id: 'spotify:track:c2', score: 10, vibeTag: '#Low', selectionReason: 'No' },
        ];
        const revertedResult = await pipeline.performAIFiltering(
            candidates.map(c => ({ ...c })),
            { userRequest: 'test' }
        );
        assert.strictEqual(revertedResult.length, 2);
        assert.ok(logs.some(l => l.includes('AI Filtering removed ALL tracks')));

        // 3. When AIService reports a fallback error via getLastFilterError(), logs concrete fallback warning instead of fake success
        let mockFilterErr: string | null = 'Gemini API Error: 429 Too Many Requests';
        const fallbackAI = {
            filterTracksWithAI: async () => [
                { id: 'spotify:track:c1', score: 70, vibeTag: '#test', selectionReason: 'fallback' },
                { id: 'spotify:track:c2', score: 70, vibeTag: '#test', selectionReason: 'fallback' },
            ],
            getLastFilterError: () => mockFilterErr,
        } as unknown as AIService;
        const fallbackPipeline = new TrackSearchPipeline({
            getSpotify: () => ({} as SpotifyWebApi.SpotifyWebApiJs),
            getAI: () => fallbackAI,
            getConfig: () => config,
            sessionCache,
            addLog: (m) => logs.push(m),
            updateStatus: (s) => statuses.push(s),
        });
        logs = [];
        await fallbackPipeline.performAIFiltering(candidates.map(c => ({ ...c })), { userRequest: 'test' });
        assert.ok(logs.some(l => l.includes('⚠️ AI Filtering fallback (Gemini API Error: 429 Too Many Requests)')));
        assert.strictEqual(logs.some(l => l.includes('tracks kept.')), false);
        mockFilterErr = null;
    });

    it('findPriorityTrack matches multi-word quoted artist accurately instead of truncating at whitespace', async () => {
        const coverByMariyaOther = makeTrack({ id: 'cov1', name: 'Plastic Love', artistName: 'Mariya Cover Band' });
        const originalByMariyaTakeuchi = makeTrack({ id: 'orig1', name: 'Plastic Love', artistName: 'Mariya Takeuchi' });

        const fakeSpotify = {
            searchTracks: async () => ({
                tracks: {
                    items: [coverByMariyaOther, originalByMariyaTakeuchi],
                },
            }),
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;

        const pipeline = new TrackSearchPipeline({
            getSpotify: () => fakeSpotify,
            getAI: () => undefined,
            getConfig: () => config,
            sessionCache: new TrackSessionCache(),
            addLog: (m) => logs.push(m),
            updateStatus: (s) => statuses.push(s),
        });

        const found = await pipeline.findPriorityTrack('track:"Plastic Love" artist:"Mariya Takeuchi"');
        assert.strictEqual(found.length, 1);
        assert.strictEqual(found[0].id, 'orig1');
        assert.strictEqual(found[0].artists[0]?.name, 'Mariya Takeuchi');
    });

    it('excludes already-played session tracks before AI filtering and fetches deeper offsets when initial pages are exhausted', async () => {
        const playedTrack1 = makeTrack({ id: 'played_1', name: 'Played One', artistName: 'Artist A', popularity: 80 });
        const playedTrack2 = makeTrack({ id: 'played_2', name: 'Played Two', artistName: 'Artist B', popularity: 80 });
        const freshDeepTrack = makeTrack({ id: 'fresh_deep_1', name: 'Fresh Deep Song', artistName: 'Artist C', popularity: 70 });

        const searchedOffsets: number[] = [];
        const fakeSpotify = {
            searchTracks: async (_query: string, opts?: { offset?: number }) => {
                const offset = opts?.offset ?? 0;
                searchedOffsets.push(offset);
                if (offset < 10) {
                    return { tracks: { items: [playedTrack1, playedTrack2] } };
                }
                return { tracks: { items: [freshDeepTrack] } };
            },
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;

        let aiCandidateIds: string[] = [];
        const fakeAI = {
            filterTracksWithAI: async (_req: string, tracks: { id: string }[]): Promise<TrackEvaluation[]> => {
                aiCandidateIds = tracks.map(t => t.id);
                return tracks.map(t => ({
                    id: t.id,
                    score: 88,
                    vibeTag: '#Fresh',
                    selectionReason: 'Fresh refill track',
                    energy: 5,
                    stage: 'build',
                }));
            },
        } as unknown as AIService;

        const sessionCache = new TrackSessionCache();
        sessionCache.markTracksPlayed([playedTrack1, playedTrack2]);

        const pipeline = new TrackSearchPipeline({
            getSpotify: () => fakeSpotify,
            getAI: () => fakeAI,
            getConfig: () => config,
            sessionCache,
            addLog: (m) => logs.push(m),
            updateStatus: (s) => statuses.push(s),
        });

        const result = await pipeline.searchTracks(['city pop'], undefined, {
            userRequest: 'Play city pop',
            thought: 'Refill fresh tracks',
        });

        // AI filtering only received the fresh unplayed track, not the already-played tracks
        assert.deepStrictEqual(aiCandidateIds, ['spotify:track:fresh_deep_1']);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 'fresh_deep_1');
        // Deeper offset (limit * 2 = 10) was queried because initial pages had < 5 unplayed tracks
        assert.ok(searchedOffsets.includes(10));
    });

    it('fetches deeper offsets during refill even when >= 5 low-popularity leftover tracks remain from initial pages', async () => {
        const playedTrack = makeTrack({ id: 'played_top', name: 'Played Top', artistName: 'Artist A', popularity: 85 });
        const lowPopLeftovers = Array.from({ length: 6 }, (_, i) =>
            makeTrack({ id: `low_${i}`, name: `Low Pop ${i}`, artistName: `Artist L${i}`, popularity: 1 })
        );
        const deepPopularTracks = Array.from({ length: 5 }, (_, i) =>
            makeTrack({ id: `deep_pop_${i}`, name: `Deep Popular ${i}`, artistName: `Artist D${i}`, popularity: 75 })
        );

        const searchedOffsets: number[] = [];
        const fakeSpotify = {
            searchTracks: async (_query: string, opts?: { offset?: number }) => {
                const offset = opts?.offset ?? 0;
                searchedOffsets.push(offset);
                if (offset < 10) {
                    return { tracks: { items: [playedTrack, ...lowPopLeftovers] } };
                }
                return { tracks: { items: deepPopularTracks } };
            },
        } as unknown as SpotifyWebApi.SpotifyWebApiJs;

        const sessionCache = new TrackSessionCache();
        sessionCache.markTrackPlayed(playedTrack);

        const pipeline = new TrackSearchPipeline({
            getSpotify: () => fakeSpotify,
            getAI: () => undefined,
            getConfig: () => config,
            sessionCache,
            addLog: (m) => logs.push(m),
            updateStatus: (s) => statuses.push(s),
        });

        const result = await pipeline.searchTracks(['jazz']);
        assert.ok(searchedOffsets.includes(10));
        assert.ok(result.some(t => t.id.startsWith('deep_pop_')));
        assert.ok(result.every(t => !t.id.startsWith('low_')));
    });
});
