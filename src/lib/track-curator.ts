import { Track } from './types';
import { PLAYBACK_CONSTANTS } from './constants';
import { generateTrackKey } from './dj-utils';

/**
 * Extracts explicit target artist names from a list of Spotify search queries.
 * Supports quoted multi-word names (e.g. `artist:"Bill Evans"`) and unquoted tokens (`artist:Nujabes`),
 * deduplicating across queries.
 */
export function extractTargetArtists(queries: string[]): string[] {
    const seen = new Set<string>();
    const artistPattern = /artist:\s*(?:["']([^"']+)["']|([^\s"']+))/gi;

    for (const q of queries) {
        for (const match of q.matchAll(artistPattern)) {
            const rawName = (match[1] ?? match[2] ?? '').trim().toLowerCase();
            if (rawName) {
                seen.add(rawName);
            }
        }
    }
    return Array.from(seen);
}

/**
 * Checks whether any artist on a track matches one of the target artists.
 * Guards against empty artist strings so `"".includes("")` never causes false positives.
 */
export function isTrackByTargetArtist(track: Track, targetArtists: string[]): boolean {
    if (!targetArtists || targetArtists.length === 0) return false;
    const validTargets = targetArtists.map(ta => ta.trim().toLowerCase()).filter(Boolean);
    if (validTargets.length === 0) return false;

    const artists = Array.isArray(track.artists) ? track.artists : [];
    for (const artist of artists) {
        const aName = (artist?.name || '').trim().toLowerCase();
        if (!aName) continue;
        if (validTargets.some(ta => aName.includes(ta) || ta.includes(aName))) {
            return true;
        }
    }
    return false;
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
            if (isTrackByTargetArtist(t, targetArtists)) {
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
    const isTarget = (t: Track): boolean => isTrackByTargetArtist(t, targetArtists);

    const cappedInput = tracks.length > maxFinalTracks
        ? [
            ...tracks.filter(isTarget),
            ...tracks.filter(t => !isTarget(t)),
        ].slice(0, maxFinalTracks)
        : tracks;

    if (cappedInput.length <= 2) {
        const sliced = cappedInput.slice(0, maxFinalTracks);
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

    const prepared = cappedInput.map(t => {
        const energy = typeof t.energy === 'number' ? t.energy : 5;
        let stage = t.stage;
        if (!stage) {
            if (energy <= 3) stage = 'outro';
            else if (energy <= 5) stage = 'intro';
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
    const needsRebalancing = total >= 4 && (intro.length === 0 || build.length === 0 || peak.length === 0 || outro.length === 0);

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

        outro = sortedByEnergy.slice(0, outroCount).map(t => ({ ...t, stage: 'outro' as const }));
        intro = sortedByEnergy.slice(outroCount, outroCount + introCount).map(t => ({ ...t, stage: 'intro' as const }));
        build = sortedByEnergy.slice(outroCount + introCount, outroCount + introCount + buildCount).map(t => ({ ...t, stage: 'build' as const }));
        peak = sortedByEnergy.slice(outroCount + introCount + buildCount).map(t => ({ ...t, stage: 'peak' as const }));
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
