import SpotifyWebApi from 'spotify-web-api-js';
import { AIService } from './ai';
import { PLAYBACK_CONSTANTS } from './constants';
import { DJConfig, SearchPipelineContext, Track, TrackEvaluation } from './types';
import {
    extractTargetArtists,
    deduplicateTracks,
    filterTracksByPopularityAndArtist,
    sequenceTracksByStory,
} from './track-curator';
import { TrackSessionCache } from './track-session-cache';

export interface TrackSearchPipelineDeps {
    getSpotify: () => SpotifyWebApi.SpotifyWebApiJs;
    getAI: () => AIService | undefined;
    getConfig: () => DJConfig;
    sessionCache: TrackSessionCache;
    addLog: (message: string) => void;
    updateStatus: (status: string) => void;
    onSpotifyError?: (err: unknown, operation: string) => void;
}

/**
 * Encapsulates the Spotify track search, priority/anchor track resolution,
 * popularity/artist filtering, AI multi-axis evaluation, and 4-stage story sequencing pipeline.
 */
export class TrackSearchPipeline {
    private deps: TrackSearchPipelineDeps;

    constructor(deps: TrackSearchPipelineDeps) {
        this.deps = deps;
    }

    async searchTracks(
        queriesInput: string | string[],
        priorityQuery?: string,
        context?: SearchPipelineContext
    ): Promise<Track[]> {
        const queries = Array.isArray(queriesInput) ? queriesInput : [queriesInput];

        // 0. Resolve Priority Track
        const priorityTracks = await this.findPriorityTrack(priorityQuery);

        // 1. Resolve Anchor Tracks (Iconic seeds)
        const anchorTracks = await this.findAnchorTracks(context?.anchorTracks);

        // 2. Parse target artists for strict filtering
        const targetArtists = extractTargetArtists(queries);
        if (targetArtists.length > 0) {
            this.deps.addLog(`🎯 Target Artists: ${targetArtists.join(', ')}`);
        }

        // 3. Execute Parallel Search
        const searchTracks = await this.executeParallelSearch(queries);
        const allRawTracks = [...anchorTracks, ...searchTracks];

        if (allRawTracks.length === 0 && priorityTracks.length === 0) {
            this.deps.addLog("❌ No tracks found from Spotify Search");
            return [];
        }

        // 4. Deduplicate
        const uniqueTracks = deduplicateTracks(allRawTracks);
        this.deps.addLog(`📊 Found ${allRawTracks.length} raw hits -> ${uniqueTracks.length} unique tracks`);

        // 5. Apply Filters (Strict Artist -> Popularity)
        const filteredTracks = this.applyTrackFilters(uniqueTracks, targetArtists);

        // 6. AI Filtering & Multi-axis Scoring
        const candidates = await this.performAIFiltering(filteredTracks, context);

        // 7. Smart Sequencing (起承転結: Intro -> Build -> Peak -> Outro)
        const { tracks: sequencedTracks, stageCounts } = sequenceTracksByStory(candidates, targetArtists);
        let finalTracks = sequencedTracks;
        if (candidates.length > 2) {
            this.deps.addLog(
                `🎼 Smart Sequencing (起承転結): Intro (${stageCounts.intro}) → Build (${stageCounts.build}) → Peak (${stageCounts.peak}) → Outro (${stageCounts.outro})`
            );
        }

        // 8. Merge Priority Track
        if (priorityTracks.length > 0) {
            const p = priorityTracks[0];
            const pUri = p.uri;
            const evaluated = candidates.find(c => c.uri === pUri);
            if (evaluated) {
                p.score = evaluated.score;
                p.vibeTag = evaluated.vibeTag;
                p.selectionReason = evaluated.selectionReason;
                p.estimatedBpm = evaluated.estimatedBpm;
                p.energy = evaluated.energy;
                p.stage = evaluated.stage || 'intro';
            } else {
                p.score = p.score || 100;
                p.vibeTag = p.vibeTag || '#オープニング';
                p.selectionReason =
                    p.selectionReason ||
                    (context?.thought
                        ? 'セッションの幕開けを飾るキートラックとして選曲。'
                        : 'オープニングを飾るキートラックです。');
                p.energy = 5;
                p.stage = 'intro';
            }
            finalTracks = finalTracks.filter(t => t.uri !== pUri);
            finalTracks = [p, ...finalTracks];
            this.deps.addLog(`📌 Priority track applied at the top: ${p.name} [${p.vibeTag}] (Stage: Intro)`);
        }

        // Cache all metadata so it persists when Spotify queue is polled
        this.deps.sessionCache.cacheTrackMetadata(finalTracks);

        return finalTracks;
    }

    async findPriorityTrack(priorityQuery?: string): Promise<Track[]> {
        if (!priorityQuery) return [];

        this.deps.addLog(`🌟 Priority Search: ${priorityQuery}`);
        try {
            const spotify = this.deps.getSpotify();
            const pRes = await spotify.searchTracks(priorityQuery, { limit: 5 });
            if (pRes.tracks && pRes.tracks.items.length > 0) {
                const tracks = pRes.tracks.items as Track[];

                let targetArtist = '';
                const artistMatch = priorityQuery.match(/artist:\s*["']?([^"'\s]+)["']?/i);
                if (artistMatch) {
                    targetArtist = artistMatch[1].toLowerCase();
                } else {
                    targetArtist = priorityQuery.replace(/["']/g, '').trim().toLowerCase();
                }

                const matched = tracks.find(t => {
                    const aName = (t.artists[0]?.name || '').toLowerCase();
                    return aName.includes(targetArtist) || targetArtist.includes(aName);
                });

                const bestTrack = matched || tracks[0];
                this.deps.addLog(`✅ Found Priority Track: ${bestTrack.name} (${bestTrack.artists[0]?.name})`);
                return [bestTrack];
            } else {
                this.deps.addLog(`⚠️ Priority Search returned 0 results for: ${priorityQuery}`);
                return [];
            }
        } catch (e) {
            this.deps.onSpotifyError?.(e, 'search_priority_track');
            console.warn("Priority search failed:", e);
            this.deps.addLog(`⚠️ Priority Search Error`);
            return [];
        }
    }

    async findAnchorTracks(anchorTracks?: string[]): Promise<Track[]> {
        if (!anchorTracks || anchorTracks.length === 0) return [];

        this.deps.addLog(`⚓ Searching Anchor Tracks: ${anchorTracks.join(', ')}`);
        const found: Track[] = [];
        const spotify = this.deps.getSpotify();

        await Promise.all(anchorTracks.map(async (anchor) => {
            try {
                const cleanAnchor = anchor.replace(/["']/g, '').trim();
                if (!cleanAnchor) return;
                const res = await spotify.searchTracks(cleanAnchor, { limit: 2 });
                if (res.tracks && res.tracks.items.length > 0) {
                    res.tracks.items.forEach(t => {
                        const track = t as Track;
                        const shortName = anchor.split('-')[0].trim();
                        track.contextName = `Anchor: ${shortName}`;
                        found.push(track);
                    });
                }
            } catch (e) {
                this.deps.onSpotifyError?.(e, 'search_anchor_tracks');
                console.warn(`Anchor search failed for ${anchor}:`, e);
            }
        }));

        if (found.length > 0) {
            this.deps.addLog(`⚓ Found ${found.length} anchor tracks.`);
        }
        return found;
    }

    async performAIFiltering(
        candidates: Track[],
        context?: { userRequest?: string; thought?: string }
    ): Promise<Track[]> {
        const config = this.deps.getConfig();
        const ai = this.deps.getAI();

        if (!config.aiFiltering || !ai || !context || (!context.userRequest && !context.thought)) {
            return candidates;
        }

        this.deps.updateStatus('🤖 AI Filtering... (AIが選曲を精査中...)');
        this.deps.addLog(`🤖 AI Filtering started for ${candidates.length} candidates...`);

        try {
            const topCandidates = candidates.slice(0, 25);
            const trackData = topCandidates.map(t => ({
                name: t.name,
                artist: t.artists.map(a => a.name).join(', ') || t.artists[0]?.name || 'Unknown',
                album: t.album?.name || '',
                id: t.uri
            }));
            const request = context.userRequest || 'Follow the DJ mood';
            const evaluations = await ai.filterTracksWithAI(request, trackData, context.thought);

            const evalMap = new Map<string, TrackEvaluation>();
            evaluations.forEach(ev => evalMap.set(ev.id, ev));

            candidates.forEach(t => {
                const ev = evalMap.get(t.uri);
                if (ev) {
                    t.score = ev.score;
                    t.vibeTag = ev.vibeTag;
                    t.selectionReason = ev.selectionReason;
                    t.estimatedBpm = ev.estimatedBpm;
                    t.energy = ev.energy;
                    t.stage = ev.stage;
                }
            });

            this.deps.sessionCache.cacheTrackMetadata(candidates);

            let qualified = candidates.filter(t => (t.score ?? 0) >= 60);
            if (qualified.length < 5 && candidates.some(t => t.score !== undefined)) {
                qualified = candidates.filter(t => (t.score ?? 0) >= 50);
            }

            this.deps.addLog(`🤖 AI Filtering: ${candidates.length} -> ${qualified.length} tracks kept.`);
            this.deps.updateStatus('Ready');

            if (qualified.length > 0) {
                qualified.sort((a, b) => (b.score || 0) - (a.score || 0));
                return qualified;
            } else {
                this.deps.addLog(`⚠️ AI Filtering removed ALL tracks. Reverting to original set.`);
                return candidates;
            }
        } catch (e) {
            this.deps.addLog(`⚠️ AI Filtering failed. Using all candidates.`);
            console.error(e);
            this.deps.updateStatus('Ready');
            return candidates;
        }
    }

    async executeParallelSearch(queries: string[]): Promise<Track[]> {
        const allRawTracks: Track[] = [];
        const config = this.deps.getConfig();
        const spotify = this.deps.getSpotify();
        const limit = config.trackSearchLimit || PLAYBACK_CONSTANTS.TRACK_SEARCH_LIMIT;
        const validQueries = queries.map(q => q.trim()).filter(Boolean);

        await Promise.all(validQueries.map(async (query) => {
            const searchQuery = config.onlyOfficial ? `owner:spotify ${query}` : query;

            try {
                const [trackResPage1, trackResPage2] = await Promise.all([
                    spotify.searchTracks(searchQuery, { limit, offset: 0 }),
                    spotify.searchTracks(searchQuery, { limit, offset: limit }).catch(() => null)
                ]);

                if (trackResPage1?.tracks?.items) {
                    allRawTracks.push(...trackResPage1.tracks.items);
                }
                if (trackResPage2?.tracks?.items) {
                    allRawTracks.push(...trackResPage2.tracks.items);
                }
            } catch (error) {
                this.deps.onSpotifyError?.(error, 'search_tracks');
                console.warn(`⚠️ Partial search failed for "${query}":`, error);
            }
        }));

        return allRawTracks.sort(() => Math.random() - 0.5);
    }

    applyTrackFilters(tracks: Track[], targetArtists: string[] = []): Track[] {
        const config = this.deps.getConfig();
        const preferredPopularity = config.minPopularity;
        const minPopularity = Math.min(preferredPopularity, PLAYBACK_CONSTANTS.MIN_TRACK_POPULARITY);

        const result = filterTracksByPopularityAndArtist(tracks, targetArtists, preferredPopularity, minPopularity);

        if (result.targetPreservedCount > 0) {
            this.deps.addLog(`🎯 Preserved ${result.targetPreservedCount} tracks by requested artist(s) without popularity cutoff`);
        }
        if (result.relaxedToMin) {
            this.deps.addLog(`⚠️ Popularity >= ${preferredPopularity} too strict. Relaxing to >= ${minPopularity}...`);
        }
        if (result.revertedToAll) {
            this.deps.addLog('⚠️ No tracks matched popularity criteria. Using all candidates.');
            return result.tracks;
        }

        this.deps.addLog(`🔍 Filter: Popularity Check (${result.tracks.length} / ${tracks.length} kept)`);
        this.logTrackSamples(result.tracks);
        return result.tracks;
    }

    private logTrackSamples(tracks: Track[]) {
        if (tracks.length === 0) return;
        const samples = tracks.slice(0, 3).map(t => `${t.name} (${t.artists[0]?.name || 'Unknown'})`).join(', ');
        const more = tracks.length > 3 ? `...and ${tracks.length - 3} more` : '';
        this.deps.addLog(`   👉 [Sample]: ${samples} ${more}`);
    }
}
