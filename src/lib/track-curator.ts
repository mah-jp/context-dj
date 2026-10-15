import { Track } from './types';
import { PLAYBACK_CONSTANTS } from './constants';
import { generateTrackKey } from './dj-utils';

/**
 * Extracts explicit target artist names from a list of Spotify search queries.
 */
export function extractTargetArtists(queries: string[]): string[] {
    const targetArtists: string[] = [];
    queries.forEach(q => {
        if (q.includes('artist:')) {
            const parts = q.split('artist:');
            if (parts.length > 1) {
                let rawName = parts[1].trim().toLowerCase();
                const quoteMatch = rawName.match(/["']([^"']+)["']/);
                if (quoteMatch) {
                    rawName = quoteMatch[1];
                }
                targetArtists.push(rawName);
            }
        }
    });
    return targetArtists;
}

/**
 * Deduplicates tracks using normalized track key (title + main artist).
 */
export function deduplicateTracks(tracks: Track[]): Track[] {
    const seenKeys = new Set<string>();
    const uniqueTracks: Track[] = [];

    for (const track of tracks) {
        const key = generateTrackKey(track);
        if (!seenKeys.has(key)) {
            seenKeys.add(key);
            uniqueTracks.push(track);
        }
    }
    return uniqueTracks;
}

export interface TrackFilterResult {
    tracks: Track[];
    targetPreservedCount: number;
    relaxedToMin: boolean;
    revertedToAll: boolean;
}

/**
 * Filters candidate tracks while preserving explicitly requested target artists
 * and applying adaptive popularity thresholds to remaining tracks.
 */
export function filterTracksByPopularityAndArtist(
    tracks: Track[],
    targetArtists: string[] = [],
    preferredPopularity: number = PLAYBACK_CONSTANTS.PREFERRED_TRACK_POPULARITY,
    minPopularity: number = PLAYBACK_CONSTANTS.MIN_TRACK_POPULARITY
): TrackFilterResult {
    const targetTracks: Track[] = [];
    const nonTargetCandidates: Track[] = [];

    if (targetArtists.length > 0) {
        tracks.forEach(t => {
            const aName = (t.artists[0]?.name || '').toLowerCase();
            if (targetArtists.some(ta => aName.includes(ta) || ta.includes(aName))) {
                targetTracks.push(t);
            } else {
                nonTargetCandidates.push(t);
            }
        });
    } else {
        nonTargetCandidates.push(...tracks);
    }

    let filteredTracks = nonTargetCandidates.filter(t => (t.popularity || 0) >= preferredPopularity);
    let relaxedToMin = false;

    if (filteredTracks.length < 5 && nonTargetCandidates.length >= 5) {
        relaxedToMin = true;
        filteredTracks = nonTargetCandidates.filter(t => (t.popularity || 0) >= minPopularity);
    }

    if (filteredTracks.length === 0 && targetTracks.length === 0) {
        return {
            tracks,
            targetPreservedCount: 0,
            relaxedToMin,
            revertedToAll: true,
        };
    }

    return {
        tracks: [...targetTracks, ...filteredTracks],
        targetPreservedCount: targetTracks.length,
        relaxedToMin,
        revertedToAll: false,
    };
}

export interface SequenceResult {
    tracks: Track[];
    stageCounts: {
        intro: number;
        build: number;
        peak: number;
        outro: number;
    };
}

/**
 * Sequences tracks into a 4-stage storytelling arc (Intro -> Build -> Peak -> Outro).
 */
export function sequenceTracksByStory(
    tracks: Track[],
    targetArtists: string[] = [],
    maxFinalTracks: number = 40
): SequenceResult {
    if (tracks.length <= 2) {
        const sliced = tracks.slice(0, maxFinalTracks);
        return {
            tracks: sliced,
            stageCounts: {
                intro: sliced.filter(t => t.stage === 'intro').length,
                build: sliced.filter(t => t.stage === 'build').length,
                peak: sliced.filter(t => t.stage === 'peak').length,
                outro: sliced.filter(t => t.stage === 'outro').length,
            }
        };
    }

    const isTarget = (t: Track): boolean => {
        if (targetArtists.length === 0) return false;
        const aName = (t.artists[0]?.name || '').toLowerCase();
        return targetArtists.some(ta => aName.includes(ta) || ta.includes(aName));
    };

    const prepared = tracks.map(t => {
        const energy = typeof t.energy === 'number' ? t.energy : 5;
        let stage = t.stage;
        if (!stage) {
            if (energy <= 4) stage = 'intro';
            else if (energy <= 7) stage = 'build';
            else stage = 'peak';
        }
        return { ...t, energy, stage };
    });

    let intro = prepared.filter(t => t.stage === 'intro');
    let build = prepared.filter(t => t.stage === 'build');
    let peak = prepared.filter(t => t.stage === 'peak');
    let outro = prepared.filter(t => t.stage === 'outro');

    const total = prepared.length;
    const needsRebalancing = total >= 4 && (intro.length === 0 || peak.length === 0 || (build.length === 0 && outro.length === 0));

    if (needsRebalancing) {
        const sortedByEnergy = [...prepared].sort((a, b) => {
            const diff = (a.energy ?? 5) - (b.energy ?? 5);
            if (diff !== 0) return diff;
            return (b.score ?? 0) - (a.score ?? 0);
        });

        const introCount = Math.max(1, Math.round(total * 0.15));
        const outroCount = Math.max(1, Math.round(total * 0.15));
        const remainingCount = total - introCount - outroCount;
        const buildCount = Math.max(1, Math.floor(remainingCount / 2));

        intro = sortedByEnergy.slice(0, introCount).map(t => ({ ...t, stage: 'intro' as const }));
        build = sortedByEnergy.slice(introCount, introCount + buildCount).map(t => ({ ...t, stage: 'build' as const }));
        peak = sortedByEnergy.slice(introCount + buildCount, total - outroCount).map(t => ({ ...t, stage: 'peak' as const }));
        outro = sortedByEnergy.slice(total - outroCount).map(t => ({ ...t, stage: 'outro' as const }));
    }

    // 1. Intro (起): Target artists first -> High AI score -> Smooth moderate energy
    intro.sort((a, b) => {
        const aT = isTarget(a) ? 1 : 0;
        const bT = isTarget(b) ? 1 : 0;
        if (aT !== bT) return bT - aT;
        if ((b.score ?? 0) !== (a.score ?? 0)) return (b.score ?? 0) - (a.score ?? 0);
        return (a.energy ?? 5) - (b.energy ?? 5);
    });

    // 2. Build (承): Energy rising (low to high) -> BPM rising
    build.sort((a, b) => {
        const aT = isTarget(a) ? 1 : 0;
        const bT = isTarget(b) ? 1 : 0;
        if (aT !== bT) return bT - aT;
        const eDiff = (a.energy ?? 5) - (b.energy ?? 5);
        if (eDiff !== 0) return eDiff;
        return (a.estimatedBpm ?? 100) - (b.estimatedBpm ?? 100);
    });

    // 3. Peak (転): Target artists first -> Highest AI score -> Peak energy
    peak.sort((a, b) => {
        const aT = isTarget(a) ? 1 : 0;
        const bT = isTarget(b) ? 1 : 0;
        if (aT !== bT) return bT - aT;
        if ((b.score ?? 0) !== (a.score ?? 0)) return (b.score ?? 0) - (a.score ?? 0);
        return (b.energy ?? 5) - (a.energy ?? 5);
    });

    // 4. Outro (結): Gradual cooldown (energy descending)
    outro.sort((a, b) => {
        const aT = isTarget(a) ? 1 : 0;
        const bT = isTarget(b) ? 1 : 0;
        if (aT !== bT) return bT - aT;
        return (b.energy ?? 5) - (a.energy ?? 5);
    });

    const sequenced = [...intro, ...build, ...peak, ...outro];
    return {
        tracks: sequenced.slice(0, maxFinalTracks),
        stageCounts: {
            intro: intro.length,
            build: build.length,
            peak: peak.length,
            outro: outro.length,
        },
    };
}
