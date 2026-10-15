import { STORAGE_KEYS } from './constants';
import { Track, TrackMetadata } from './types';
import { getStoredJSON, setStoredJSON } from './storage';
import { normalizeTrackName, generateTrackKey } from './dj-utils';

/**
 * Manages track evaluation metadata caching, active session track progression,
 * played history deduplication, and fuzzy track matching across Spotify relinking.
 */
export class TrackSessionCache {
    private trackMetadataCache = new Map<string, TrackMetadata>();
    private currentSessionTracks: Track[] = [];
    private sessionPlayedUris = new Set<string>();
    private sessionPlayedKeys = new Set<string>();

    constructor() {
        // Restore track metadata cache from localStorage
        const savedCache = getStoredJSON<Record<string, TrackMetadata>>(STORAGE_KEYS.TRACK_METADATA_CACHE, {});
        Object.entries(savedCache).forEach(([key, meta]) => {
            this.trackMetadataCache.set(key, meta);
        });

        // Restore current session tracks from localStorage
        const savedSessionTracks = getStoredJSON<Track[]>(STORAGE_KEYS.DJ_CURRENT_SESSION_TRACKS, []);
        if (savedSessionTracks.length > 0) {
            this.currentSessionTracks = savedSessionTracks;
        }
    }

    getSessionTracks(): Track[] {
        return this.currentSessionTracks;
    }

    setSessionTracks(tracks: Track[], persist: boolean = true) {
        this.currentSessionTracks = tracks;
        if (persist) {
            setStoredJSON(STORAGE_KEYS.DJ_CURRENT_SESSION_TRACKS, tracks);
        }
    }

    appendSessionTracks(tracks: Track[]) {
        this.currentSessionTracks.push(...tracks);
        setStoredJSON(STORAGE_KEYS.DJ_CURRENT_SESSION_TRACKS, this.currentSessionTracks);
    }

    resetSessionPlayedHistory() {
        this.sessionPlayedUris.clear();
        this.sessionPlayedKeys.clear();
    }

    markTrackPlayed(track: Track) {
        if (track.uri) {
            this.sessionPlayedUris.add(track.uri);
        }
        const key = generateTrackKey(track);
        if (key) {
            this.sessionPlayedKeys.add(key);
        }
    }

    markTracksPlayed(tracks: Track[]) {
        for (const t of tracks) {
            this.markTrackPlayed(t);
        }
    }

    isTrackPlayedInSession(track: Track): boolean {
        const key = generateTrackKey(track);
        return this.sessionPlayedUris.has(track.uri) || (Boolean(key) && this.sessionPlayedKeys.has(key));
    }

    cacheTrackMetadata(tracks: Track[]) {
        let changed = false;
        for (const t of tracks) {
            if (!t) continue;
            const meta: TrackMetadata = {
                ...(t.score !== undefined ? { score: t.score } : {}),
                ...(t.vibeTag ? { vibeTag: t.vibeTag } : {}),
                ...(t.selectionReason ? { selectionReason: t.selectionReason } : {}),
                ...(t.estimatedBpm !== undefined ? { estimatedBpm: t.estimatedBpm } : {}),
                ...(t.energy !== undefined ? { energy: t.energy } : {}),
                ...(t.stage ? { stage: t.stage } : {}),
                ...(t.contextName ? { contextName: t.contextName } : {}),
            };

            // Register by URI
            if (t.uri) {
                const existing = this.trackMetadataCache.get(t.uri) || {};
                this.trackMetadataCache.set(t.uri, { ...existing, ...meta });
            }
            // Register by ID
            if (t.id) {
                const existing = this.trackMetadataCache.get(t.id) || {};
                this.trackMetadataCache.set(t.id, { ...existing, ...meta });
            }
            // Register by normalized trackKey (title + artist) for robust matching across relinked tracks
            const key = generateTrackKey(t);
            if (key && key !== '|') {
                const existing = this.trackMetadataCache.get(`key:${key}`) || {};
                this.trackMetadataCache.set(`key:${key}`, { ...existing, ...meta });
            }
            changed = true;
        }

        if (changed) {
            // Persist to localStorage (limit to latest 300 items to avoid quota issues)
            const obj: Record<string, TrackMetadata> = {};
            const entries = Array.from(this.trackMetadataCache.entries());
            const sliced = entries.slice(-300);
            sliced.forEach(([k, v]) => { obj[k] = v; });
            setStoredJSON(STORAGE_KEYS.TRACK_METADATA_CACHE, obj);
        }
    }

    enrichTrackWithCachedMetadata(track: Track): Track {
        if (!track) return track;
        const key = generateTrackKey(track);
        let cached: TrackMetadata | undefined = (track.uri ? this.trackMetadataCache.get(track.uri) : undefined)
            || (track.id ? this.trackMetadataCache.get(track.id) : undefined)
            || (key ? this.trackMetadataCache.get(`key:${key}`) : undefined);

        // Fallback: Check currentSessionTracks using robust index finder
        if (!cached && this.currentSessionTracks.length > 0) {
            const idx = this.findTrackIndexInSession(track);
            if (idx >= 0) {
                cached = this.currentSessionTracks[idx];
            }
        }

        if (cached) {
            if (cached.score !== undefined && track.score === undefined) track.score = cached.score;
            if (cached.vibeTag && !track.vibeTag) track.vibeTag = cached.vibeTag;
            if (cached.selectionReason && !track.selectionReason) track.selectionReason = cached.selectionReason;
            if (cached.estimatedBpm !== undefined && track.estimatedBpm === undefined) track.estimatedBpm = cached.estimatedBpm;
            if (cached.energy !== undefined && track.energy === undefined) track.energy = cached.energy;
            if (cached.stage && !track.stage) track.stage = cached.stage;
            if (cached.contextName && !track.contextName) track.contextName = cached.contextName;
        }

        // Fallback: If selectionReason or vibeTag is still missing, search in currentSessionTracks
        // using fuzzy title, normalized artist, and trackKey matching.
        if ((!track.selectionReason || !track.vibeTag) && this.currentSessionTracks.length > 0) {
            const sessionIdx = this.findTrackIndexInSession(track);
            if (sessionIdx >= 0) {
                const sessionTrack = this.currentSessionTracks[sessionIdx];
                if (sessionTrack.selectionReason && !track.selectionReason) track.selectionReason = sessionTrack.selectionReason;
                if (sessionTrack.vibeTag && !track.vibeTag) track.vibeTag = sessionTrack.vibeTag;
                if (sessionTrack.score !== undefined && track.score === undefined) track.score = sessionTrack.score;
                if (sessionTrack.estimatedBpm !== undefined && track.estimatedBpm === undefined) track.estimatedBpm = sessionTrack.estimatedBpm;
                if (sessionTrack.energy !== undefined && track.energy === undefined) track.energy = sessionTrack.energy;
                if (sessionTrack.stage && !track.stage) track.stage = sessionTrack.stage;
                if (sessionTrack.contextName && !track.contextName) track.contextName = sessionTrack.contextName;

                // Auto-heal cache for this track's actual Spotify instance
                this.cacheTrackMetadata([track]);
            }
        }

        return track;
    }

    /**
     * Resolves the index of a track within the current session using URI, ID, TrackKey, and fuzzy title match.
     */
    findTrackIndexInSession(track: Track | SpotifyApi.TrackObjectFull): number {
        if (!track || this.currentSessionTracks.length === 0) return -1;

        const uri = track.uri;
        const id = track.id;
        const trackKey = generateTrackKey(track);
        const normName = normalizeTrackName(track.name);

        // 1. Exact URI or ID match
        let idx = this.currentSessionTracks.findIndex(t =>
            (uri && t.uri === uri) || (id && t.id === id)
        );
        if (idx >= 0) return idx;

        // 2. TrackKey match (Title + Main Artist)
        if (trackKey && trackKey !== '|') {
            idx = this.currentSessionTracks.findIndex(t => generateTrackKey(t) === trackKey);
            if (idx >= 0) return idx;
        }

        // 3. Substring/fuzzy match for titles with special tags or minor artist differences
        const artist = track.artists?.[0]?.name?.toLowerCase()?.trim() || '';
        if (normName && artist) {
            idx = this.currentSessionTracks.findIndex(t => {
                const tNorm = normalizeTrackName(t.name);
                const tArtist = t.artists?.[0]?.name?.toLowerCase()?.trim() || '';
                const nameMatch = tNorm === normName || (tNorm.length > 3 && normName.length > 3 && (tNorm.includes(normName) || normName.includes(tNorm)));
                const artistMatch = tArtist === artist || (tArtist.length > 2 && artist.length > 2 && (tArtist.includes(artist) || artist.includes(tArtist)));
                return nameMatch && artistMatch;
            });
            if (idx >= 0) return idx;
        }

        return -1;
    }

    getSessionTracksFromCurrent(activeTrack?: Track | null): Track[] {
        if (this.currentSessionTracks.length === 0) return [];
        let startIndex = 1;
        if (activeTrack) {
            const foundIndex = this.findTrackIndexInSession(activeTrack);
            if (foundIndex >= 0) {
                startIndex = foundIndex + 1;
            }
        }
        return this.currentSessionTracks.slice(startIndex).map(t => this.enrichTrackWithCachedMetadata(t));
    }
}
