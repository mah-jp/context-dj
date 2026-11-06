import { Track } from './types';
import { PLAYBACK_CONSTANTS } from './constants';
import { generateTrackKey } from './dj-utils';

/**
 * Extracts explicit target artist names from a list of Spotify search queries.
 * Supports quoted multi-word names (e.g. `artist:"Bill Evans"`, `artist:"B'z"`, `artist:'Guns N' Roses'`)
 * and unquoted tokens (`artist:Nujabes`, `artist:B'z`), deduplicating across queries.
 */
export function extractTargetArtists(queries: string[]): string[] {
    const seen = new Set<string>();
    const artistPattern = /artist:\s*(?:"([^"]+)"|'([^']+)'|([^\s"]+))/gi;

    for (const q of queries) {
        for (const match of q.matchAll(artistPattern)) {
            const rawName = (match[1] ?? match[2] ?? match[3] ?? '').trim().toLowerCase();
            if (rawName) {
                seen.add(rawName);
            }
        }
    }
    return Array.from(seen);
}

function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesArtistTarget(artistName: string, targetName: string): boolean {
    if (!artistName || !targetName) return false;
    if (artistName === targetName) return true;
    // Prevent single-character false positives
    if (targetName.length < 2) return false;

    const isAsciiTarget = /^[\x00-\x7F]+$/.test(targetName);
    if (isAsciiTarget) {
        const boundaryPattern = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(targetName)}(?:$|[^a-z0-9])`, 'i');
        return boundaryPattern.test(artistName);
    }

    return artistName.includes(targetName);
}

/**
 * Checks whether any artist on a track matches one of the target artists.
 * Guards against empty artist strings and partial-word false positives (e.g. "Eve" inside "Steve Aoki").
 */
export function isTrackByTargetArtist(track: Track, targetArtists: string[]): boolean {
    if (!targetArtists || targetArtists.length === 0) return false;
    const validTargets = targetArtists.map(ta => ta.trim().toLowerCase()).filter(Boolean);
    if (validTargets.length === 0) return false;

    const artists = Array.isArray(track.artists) ? track.artists : [];
    for (const artist of artists) {
        const aName = (artist?.name || '').trim().toLowerCase();
        if (!aName) continue;
        if (validTargets.some(ta => matchesArtistTarget(aName, ta))) {
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
        const sliced = cappedInput.slice(0, maxFinalTracks).map((t, idx) => ({
            ...t,
            energy: typeof t.energy === 'number' ? t.energy : 5,
            stage: t.stage || (idx === 0 ? ('intro' as const) : ('outro' as const)),
        }));
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
    const populatedStageCount = [intro, build, peak, outro].filter(b => b.length > 0).length;

    if (total === 3 && populatedStageCount <= 2) {
        const sortedByEnergy = [...prepared].sort((a, b) => (a.energy ?? 5) - (b.energy ?? 5));
        outro = [{ ...sortedByEnergy[0], stage: 'outro' as const }];
        intro = [{ ...sortedByEnergy[1], stage: 'intro' as const }];
        build = [];
        peak = [{ ...sortedByEnergy[2], stage: 'peak' as const }];
    } else if (total >= 4 && populatedStageCount < 4) {
        const hasExplicitStageVariety =
            cappedInput.filter(t => Boolean(t.stage)).length >= Math.ceil(total * 0.5) &&
            populatedStageCount >= 2;

        if (!hasExplicitStageVariety) {
            // Uncategorized or uniform-stage tracks: distribute across all 4 stages by energy
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
        } else {
            // Preserve explicit AI stage assignments and borrow only for missing stage(s) from the largest bucket
            const buckets: { name: 'intro' | 'build' | 'peak' | 'outro'; list: typeof prepared }[] = [
                { name: 'intro', list: intro },
                { name: 'build', list: build },
                { name: 'peak', list: peak },
                { name: 'outro', list: outro },
            ];
            for (const targetBucket of buckets) {
                if (targetBucket.list.length === 0) {
                    const donor = [...buckets]
                        .filter(b => b.list.length > 1)
                        .sort((a, b) => b.list.length - a.list.length)[0];
                    if (donor) {
                        donor.list.sort((a, b) => (a.energy ?? 5) - (b.energy ?? 5));
                        const takeLowest = targetBucket.name === 'outro' || targetBucket.name === 'intro';
                        const borrowed = takeLowest ? donor.list.shift()! : donor.list.pop()!;
                        targetBucket.list.push({ ...borrowed, stage: targetBucket.name });
                    }
                }
            }
        }
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
