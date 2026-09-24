import SpotifyWebApi from 'spotify-web-api-js';
import { AIService } from './ai';
import { STORAGE_KEYS, PLAYBACK_CONSTANTS, DEFAULTS } from './constants';
import { AIProvider, ScheduleItem, Track, DJConfig, TrackEvaluation } from './types';
import { getStorageItem, setStorageItem, removeStorageItem, getStoredJSON, setStoredJSON } from './storage';
import { normalizeTrackName, generateTrackKey, isScheduleItemActive, getScheduleItemSignature, getScheduleItemQueries } from './dj-utils';

export type { Track };

export class DJCore {
    private spotify: SpotifyWebApi.SpotifyWebApiJs;
    private ai?: AIService;
    private schedule: ScheduleItem[] = [];
    private processLog: string[] = [];
    private lastQuery: string | null = null;
    private activeDeviceId: string | null = null;
    private currentSessionTracks: Track[] = [];
    private lastPlayTime: number = 0;
    private config: DJConfig = {
        minPopularity: PLAYBACK_CONSTANTS.MIN_TRACK_POPULARITY,
        trackSearchLimit: PLAYBACK_CONSTANTS.TRACK_SEARCH_LIMIT,
        onlyOfficial: false,
        aiFiltering: true
    };
    private onStatusUpdate?: (status: string) => void;
    private trackMetadataCache = new Map<string, {
        score?: number;
        vibeTag?: string;
        selectionReason?: string;
        estimatedBpm?: number;
        contextName?: string;
    }>();

    private cacheTrackMetadata(tracks: Track[]) {
        let changed = false;
        for (const t of tracks) {
            if (!t.uri) continue;
            const existing = this.trackMetadataCache.get(t.uri) || {};
            this.trackMetadataCache.set(t.uri, {
                ...existing,
                ...(t.score !== undefined ? { score: t.score } : {}),
                ...(t.vibeTag ? { vibeTag: t.vibeTag } : {}),
                ...(t.selectionReason ? { selectionReason: t.selectionReason } : {}),
                ...(t.estimatedBpm !== undefined ? { estimatedBpm: t.estimatedBpm } : {}),
                ...(t.contextName ? { contextName: t.contextName } : {}),
            });
            changed = true;
        }

        if (changed) {
            // Persist to localStorage (limit to latest 200 items to avoid quota issues)
            const obj: Record<string, any> = {};
            const entries = Array.from(this.trackMetadataCache.entries());
            const sliced = entries.slice(-200);
            sliced.forEach(([k, v]) => { obj[k] = v; });
            setStoredJSON(STORAGE_KEYS.TRACK_METADATA_CACHE, obj);
        }
    }

    private enrichTrackWithCachedMetadata(track: Track): Track {
        if (!track.uri) return track;
        const cached = this.trackMetadataCache.get(track.uri);
        if (cached) {
            if (cached.score !== undefined && track.score === undefined) track.score = cached.score;
            if (cached.vibeTag && !track.vibeTag) track.vibeTag = cached.vibeTag;
            if (cached.selectionReason && !track.selectionReason) track.selectionReason = cached.selectionReason;
            if (cached.estimatedBpm !== undefined && track.estimatedBpm === undefined) track.estimatedBpm = cached.estimatedBpm;
            if (cached.contextName && !track.contextName) track.contextName = cached.contextName;
        }
        return track;
    }

    constructor(accessToken: string) {
        this.spotify = new SpotifyWebApi();
        this.spotify.setAccessToken(accessToken);

        // Restore state
        this.lastQuery = getStorageItem(STORAGE_KEYS.DJ_LAST_QUERY, null as any);
        const savedFiltering = getStorageItem(STORAGE_KEYS.AI_FILTERING_ENABLED, '');
        this.config.aiFiltering = savedFiltering === '' ? DEFAULTS.AI_FILTERING_ENABLED : savedFiltering === 'true';

        // Restore track metadata cache from localStorage
        const savedCache = getStoredJSON<Record<string, any>>(STORAGE_KEYS.TRACK_METADATA_CACHE, {});
        Object.entries(savedCache).forEach(([uri, meta]) => {
            this.trackMetadataCache.set(uri, meta);
        });
    }

    updateConfig(config: Partial<DJConfig>) {
        this.config = { ...this.config, ...config };
    }

    updateAccessToken(token: string) {
        this.spotify.setAccessToken(token);
    }

    initAI(backend: AIProvider, apiKey: string, modelName?: string) {
        this.ai = new AIService(backend, apiKey, modelName);
    }

    async analyzeImage(base64Image: string, mimeType: string): Promise<string> {
        if (!this.ai) throw new Error("AI service not initialized (AIサービスが初期化されていません)");
        return this.ai.analyzeImage(base64Image, mimeType);
    }

    getProcessLog(): string[] {
        return this.processLog;
    }

    private addLog(message: string) {
        const timestamp = new Date().toLocaleTimeString();
        const msg = `[${timestamp}] ${message}`;
        console.log(msg); // Keep console output
        this.processLog.unshift(msg); // Add to internal log (newest first)
        if (this.processLog.length > 100) this.processLog.pop(); // Limit size
    }

    setStatusCallback(cb: (status: string) => void) {
        this.onStatusUpdate = cb;
    }

    private onTracksPlayed?: (tracks: Track[]) => void;

    setOnTracksPlayedCallback(cb: (tracks: Track[]) => void) {
        this.onTracksPlayed = cb;
    }

    private updateStatus(status: string) {
        if (this.onStatusUpdate) {
            this.onStatusUpdate(status);
        }
    }

    // --- Search & Filtering ---

    async searchTracks(queriesInput: string | string[], priorityQuery?: string, context?: { userRequest?: string, thought?: string, anchorTracks?: string[] }): Promise<Track[]> {
        const queries = Array.isArray(queriesInput) ? queriesInput : [queriesInput];

        // 0. Resolve Priority Track
        const priorityTracks = await this.findPriorityTrack(priorityQuery);

        // 1. Resolve Anchor Tracks (Iconic seeds)
        const anchorTracks = await this.findAnchorTracks(context?.anchorTracks);

        // 2. Parse target artists for strict filtering
        const targetArtists = this.extractTargetArtists(queries);
        if (targetArtists.length > 0) this.addLog(`🎯 Target Artists: ${targetArtists.join(', ')}`);

        // 3. Execute Parallel Search
        const searchTracks = await this.executeParallelSearch(queries);
        const allRawTracks = [...anchorTracks, ...searchTracks];

        if (allRawTracks.length === 0 && priorityTracks.length === 0) {
            this.addLog("❌ No tracks found from Spotify Search");
            return [];
        }

        // 4. Deduplicate
        const uniqueTracks = this.deduplicateTracks(allRawTracks);
        this.addLog(`📊 Found ${allRawTracks.length} raw hits -> ${uniqueTracks.length} unique tracks`);

        // 5. Apply Filters (Strict Artist -> Popularity)
        const filteredTracks = this.applyTrackFilters(uniqueTracks, targetArtists);

        // 6. AI Filtering & Multi-axis Scoring
        const candidates = await this.performAIFiltering(filteredTracks, context);

        // 7. Select Final Set (Shuffle & Pick with Score Weight)
        let finalTracks = this.selectTopTracks(candidates, targetArtists);

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
            } else {
                p.score = p.score || 100;
                p.vibeTag = p.vibeTag || '#オープニング';
                p.selectionReason = p.selectionReason || (context?.thought ? `セッションの幕開けを飾るキートラックとして選曲。` : 'オープニングを飾るキートラックです。');
            }
            finalTracks = finalTracks.filter(t => t.uri !== pUri);
            finalTracks = [p, ...finalTracks];
            this.addLog(`📌 Priority track applied at the top: ${p.name} [${p.vibeTag}]`);
        }

        // Cache all metadata so it persists when Spotify queue is polled
        this.cacheTrackMetadata(finalTracks);

        return finalTracks;
    }

    private async findPriorityTrack(priorityQuery?: string): Promise<Track[]> {
        if (!priorityQuery) return [];

        this.addLog(`🌟 Priority Search: ${priorityQuery}`);
        try {
            const pRes = await this.spotify.searchTracks(priorityQuery, { limit: 1 });
            if (pRes.tracks && pRes.tracks.items.length > 0) {
                const tracks = pRes.tracks.items;
                this.addLog(`✅ Found Priority Track: ${tracks[0].name} (${tracks[0].artists[0].name})`);
                return tracks;
            } else {
                this.addLog(`⚠️ Priority Search returned 0 results for: ${priorityQuery}`);
                return [];
            }
        } catch (e) {
            console.warn("Priority search failed:", e);
            this.addLog(`⚠️ Priority Search Error`);
            return [];
        }
    }

    private async findAnchorTracks(anchorTracks?: string[]): Promise<Track[]> {
        if (!anchorTracks || anchorTracks.length === 0) return [];

        this.addLog(`⚓ Searching Anchor Tracks: ${anchorTracks.join(', ')}`);
        const found: Track[] = [];

        await Promise.all(anchorTracks.map(async (anchor) => {
            try {
                const cleanAnchor = anchor.replace(/["']/g, '');
                const res = await this.spotify.searchTracks(cleanAnchor, { limit: 2 });
                if (res.tracks && res.tracks.items.length > 0) {
                    res.tracks.items.forEach(t => {
                        const track = t as Track;
                        const shortName = anchor.split('-')[0].trim();
                        track.contextName = `Anchor: ${shortName}`;
                        found.push(track);
                    });
                }
            } catch (e) {
                console.warn(`Anchor search failed for ${anchor}:`, e);
            }
        }));

        if (found.length > 0) {
            this.addLog(`⚓ Found ${found.length} anchor tracks.`);
        }
        return found;
    }

    private async performAIFiltering(candidates: Track[], context?: { userRequest?: string, thought?: string }): Promise<Track[]> {
        if (!this.config.aiFiltering || !this.ai || !context || (!context.userRequest && !context.thought)) {
            return candidates;
        }

        this.updateStatus('🤖 AI Filtering... (AIが選曲を精査中...)');
        this.addLog(`🤖 AI Filtering started for ${candidates.length} candidates...`);

        try {
            const topCandidates = candidates.slice(0, 25);
            const trackData = topCandidates.map(t => ({ name: t.name, artist: t.artists[0]?.name || 'Unknown', id: t.uri }));
            const request = context.userRequest || 'Follow the DJ mood';
            const evaluations = await this.ai.filterTracksWithAI(request, trackData, context.thought);

            const evalMap = new Map<string, TrackEvaluation>();
            evaluations.forEach(ev => evalMap.set(ev.id, ev));

            // Merge evaluation data onto candidate tracks
            candidates.forEach(t => {
                const ev = evalMap.get(t.uri);
                if (ev) {
                    t.score = ev.score;
                    t.vibeTag = ev.vibeTag;
                    t.selectionReason = ev.selectionReason;
                    t.estimatedBpm = ev.estimatedBpm;
                }
            });

            this.cacheTrackMetadata(candidates);

            // Minimum track guarantee to prevent short playlist loops (aim for at least 10 tracks)
            const MIN_GUARANTEE = 10;
            const SCORE_THRESHOLD = 60;

            // 1. Primary qualified tracks (score >= 60)
            let qualified = candidates.filter(t => (t.score ?? 0) >= SCORE_THRESHOLD);

            // 2. Relax to score >= 50 if below guarantee
            if (qualified.length < MIN_GUARANTEE && candidates.some(t => t.score !== undefined)) {
                qualified = candidates.filter(t => (t.score ?? 0) >= 50);
            }

            // 3. Guarantee at least MIN_GUARANTEE tracks by topping up with next-best candidates
            if (qualified.length < MIN_GUARANTEE && candidates.length > qualified.length) {
                const remaining = candidates.filter(t => !qualified.some(q => q.uri === t.uri));
                remaining.sort((a, b) => (b.score ?? b.popularity ?? 0) - (a.score ?? a.popularity ?? 0));
                const needed = Math.min(MIN_GUARANTEE - qualified.length, remaining.length);
                const filler = remaining.slice(0, needed);
                qualified = [...qualified, ...filler];
                this.addLog(`🛡️ Min track guarantee: Added ${filler.length} next-best tracks to reach ${qualified.length} songs.`);
            }

            this.addLog(`🤖 AI Filtering: ${candidates.length} -> ${qualified.length} tracks kept.`);
            this.updateStatus('Ready');

            if (qualified.length > 0) {
                // Sort primarily by AI score (descending) so top-rated tracks play first
                qualified.sort((a, b) => (b.score || 0) - (a.score || 0));
                return qualified;
            } else {
                this.addLog(`⚠️ AI Filtering removed ALL tracks. Reverting to original set.`);
                return candidates;
            }
        } catch (e) {
            this.addLog(`⚠️ AI Filtering failed. Using all candidates.`);
            console.error(e);
            this.updateStatus('Ready');
            return candidates;
        }
    }

    private extractTargetArtists(queries: string[]): string[] {
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

    private async executeParallelSearch(queries: string[]): Promise<Track[]> {
        const allRawTracks: Track[] = [];

        await Promise.all(queries.map(async (query) => {
            const cleanQuery = query.replace(/"/g, '').replace(/'/g, '');
            const searchQuery = this.config.onlyOfficial ? `owner:spotify ${cleanQuery}` : cleanQuery;

            try {
                const [trackRes, playlistRes] = await Promise.all([
                    this.spotify.searchTracks(searchQuery, { limit: 30 }), // Increased for more direct artist hits
                    this.spotify.searchPlaylists(searchQuery, { limit: 8 }) // Increased for more curated variety
                ]);

                if (trackRes.tracks && trackRes.tracks.items) {
                    allRawTracks.push(...trackRes.tracks.items);
                }

                if (playlistRes.playlists && playlistRes.playlists.items.length > 0) {
                    // Process top playlists (up to 3) to get curated diversity
                    const targetPlaylists = playlistRes.playlists.items.slice(0, 3);

                    for (const pl of targetPlaylists) {
                        try {
                            const plTracksRes = await this.spotify.getPlaylistTracks(pl.id, { limit: 25 });
                            const extractedTracks = plTracksRes.items
                                .map(item => {
                                    const t = item.track as Track;
                                    if (!t || t.type !== 'track' || !t.id) return null;
                                    t.contextName = `Playlist: ${pl.name}`;
                                    return t;
                                })
                                .filter((t): t is Track => t !== null);

                            this.addLog(`📜 Scanned Playlist: "${pl.name}" (${extractedTracks.length} tracks)`);
                            this.logTrackSamples(extractedTracks);
                            allRawTracks.push(...extractedTracks);
                        } catch (plErr) {
                            console.warn(`⚠️ Failed to load tracks from playlist ${pl.name}:`, plErr);
                        }
                    }
                }
            } catch (error) {
                console.warn(`⚠️ Partial search failed for "${query}":`, error);
            }
        }));

        // Shuffle gently to mix results from different queries
        return allRawTracks.sort(() => Math.random() - 0.5);
    }

    private deduplicateTracks(tracks: Track[]): Track[] {
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

    private applyTrackFilters(tracks: Track[], _targetArtists?: string[]): Track[] {
        const candidates = tracks;

        // Popularity Filtering (Adaptive)
        const PREFERRED_POPULARITY = 15;
        const MIN_POPULARITY = 5;

        // 1. Try Preferred Filter
        let filteredTracks = candidates.filter(t => (t.popularity || 0) >= PREFERRED_POPULARITY);

        if (filteredTracks.length < 5 && candidates.length >= 5) {
            this.addLog(`⚠️ Popularity >= ${PREFERRED_POPULARITY} too strict (${filteredTracks.length} tracks). Relaxing to >= ${MIN_POPULARITY}...`);
            // 2. Try Relaxed Filter
            filteredTracks = candidates.filter(t => (t.popularity || 0) >= MIN_POPULARITY);
        }

        this.addLog(`🔍 Filter: Popularity Check (${filteredTracks.length} / ${candidates.length} kept)`);

        if (filteredTracks.length === 0) {
            this.addLog('⚠️ No tracks matched popularity criteria. Using all candidates.');
            return candidates;
        }

        this.logTrackSamples(filteredTracks);
        return filteredTracks;
    }

    private logTrackSamples(tracks: Track[]) {
        if (tracks.length === 0) return;
        const samples = tracks.slice(0, 3).map(t => `${t.name} (${t.artists[0].name})`).join(', ');
        const more = tracks.length > 3 ? `...and ${tracks.length - 3} more` : '';
        this.addLog(`   👉 [Sample]: ${samples} ${more}`);
    }

    private shuffle<T>(array: T[]): T[] {
        const arr = [...array];
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    private selectTopTracks(tracks: Track[], targetArtists: string[] = []): Track[] {
        const MAX_TOP_TRACKS = 40;

        // Sort to prioritize Target Artists, then AI Score, then Playlists
        const sorted = this.shuffle(tracks).sort((a, b) => {
            const aName = (a.artists[0]?.name || '').toLowerCase();
            const bName = (b.artists[0]?.name || '').toLowerCase();

            const aIsTarget = targetArtists.some(ta => aName.includes(ta)) ? 1 : 0;
            const bIsTarget = targetArtists.some(ta => bName.includes(ta)) ? 1 : 0;

            if (aIsTarget !== bIsTarget) return bIsTarget - aIsTarget;

            // Secondary priority: AI Score if present
            if (a.score !== undefined || b.score !== undefined) {
                return (b.score || 0) - (a.score || 0);
            }

            // Tertiary priority: Playlist tracks (but only if artist doesn't match)
            const aIsPl = a.contextName?.startsWith('Playlist:') ? 1 : 0;
            const bIsPl = b.contextName?.startsWith('Playlist:') ? 1 : 0;
            if (aIsPl !== bIsPl) return bIsPl - aIsPl;

            return 0; // Keep shuffle order
        });

        const sliceCount = Math.min(MAX_TOP_TRACKS, sorted.length);
        return sorted.slice(0, sliceCount);
    }

    // --- Device Management ---

    async getDevices(): Promise<SpotifyApi.UserDevice[]> {
        try {
            const response = await this.spotify.getMyDevices();
            return response.devices;
        } catch (e) {
            console.warn("Failed to fetch devices:", e);
            return [];
        }
    }

    async setActiveDevice(deviceId: string) {
        this.activeDeviceId = deviceId;
        console.log(`📱 Active device set to: ${deviceId}`);

        const token = this.spotify.getAccessToken();
        if (!token) return;

        try {
            const res = await fetch('https://api.spotify.com/v1/me/player', {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                // play: true is NOT enabled by default to avoid startling user, 
                // but transfer will wake up the device.
                body: JSON.stringify({ device_ids: [deviceId] })
            });

            if (!res.ok && res.status !== 204) {
                console.warn(`Transfer playback failed: ${res.status}`);
            } else {
                console.log(`📱 Playback transferred to ${deviceId}`);
            }
        } catch (e) {
            console.error("Failed to transfer playback:", e);
        }
    }

    // --- Playback Control ---

    async playTracks(tracks: Track[]) {
        if (tracks.length === 0) return;

        const uris = tracks.map(t => t.uri);
        let deviceId: string | null = this.activeDeviceId;

        try {
            // Attempt to find device with retry
            for (let attempt = 0; attempt < 3; attempt++) {
                // If we already have a specific target (e.g. Web Player), verify it's active or just use it
                // If explicitly set activeDeviceId is present, we try to use it.
                // However, we might want to verify it still exists if it fails, but for now let's trust the user selection or prior discovery.
                if (deviceId) break;

                const devices = await this.spotify.getMyDevices();
                console.log(`📱 Devices found (attempt ${attempt + 1}):`, devices.devices.map(d => `${d.name} (${d.type}, ${d.is_active ? 'Active' : 'Inactive'})`));

                const activeDevice = devices.devices.find(d => d.is_active);
                deviceId = activeDevice?.id || devices.devices[0]?.id || null;

                if (deviceId) {
                    // Update active device if we found one automatically
                    this.activeDeviceId = deviceId;
                    break;
                }

                // Wait briefly before retry if no device found
                await new Promise(r => setTimeout(r, 1000));
            }

            if (!deviceId) throw new Error("No active device found after retries. Please open Spotify. (再生デバイスが見つかりません。スマホまたはPCでSpotifyを開いてください)");

            console.log(`▶️ Playing ${uris.length} tracks on device ${deviceId}`);

            // Direct Fetch API implementation via helper
            // Note: play endpoint is slightly different (takes query param) so we construct URL here or adapt helper?
            // Actually, safeControlRequest logic is close, but we need query params support.
            // Let's keep it explicit here for clarity but cleaner.

            const token = this.spotify.getAccessToken();
            if (!token) throw new Error("No access token available");

            // DISABLE SHUFFLE before playing to ensure priority track is first
            // Note: This needs to be done on the active device.
            try {
                await fetch(`https://api.spotify.com/v1/me/player/shuffle?state=false&device_id=${deviceId}`, {
                    method: 'PUT',
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                console.log('🔀 Shuffle disabled');
            } catch (e) {
                console.warn('Disable shuffle failed:', e);
            }

            const playUrl = `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`;
            const playBody = JSON.stringify({ uris: uris });

            try {
                const res = await fetch(playUrl, {
                    method: 'PUT',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: playBody
                });

                if (!res.ok) {
                    const errText = await res.text().catch(() => 'No error details');
                    console.error(`Spotify Play API Error: ${res.status} ${res.statusText}`, errText);
                    throw new Error(`Spotify Play Failed: ${res.statusText}`);
                }
                console.log('▶️ Playback started successfully (Fetch)');
                this.currentSessionTracks = tracks;
                this.lastPlayTime = Date.now();
            } catch (e: any) {
                console.error("Spotify Play Error (Fetch):", e);
                throw e;
            }

            // Ensure repeat is off via safe fetch
            // Using a short delay to ensure context is established
            setTimeout(async () => {
                const repeatUrl = `https://api.spotify.com/v1/me/player/repeat?state=off&device_id=${deviceId}`;
                try {
                    await fetch(repeatUrl, {
                        method: 'PUT',
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                } catch (e) { console.warn('Set repeat mode failed (non-critical):', e); }
            }, 500);

        } catch (error) {
            console.error('Playback error:', error);
            throw error;
        }
    }

    private sessionPlayedUris = new Set<string>();
    private sessionPlayedKeys = new Set<string>();
    private isRefilling = false;

    async createSchedule(instruction: string, personalContext?: string) {
        if (!this.ai) throw new Error("AI not initialized (AIが初期化されていません)");

        const schedule = await this.ai.generateSchedule(instruction, this.schedule, personalContext);
        this.schedule = schedule;
        return schedule;
    }

    setSchedule(schedule: ScheduleItem[]) {
        this.schedule = schedule;
    }

    removeScheduleItem(index: number) {
        if (index >= 0 && index < this.schedule.length) {
            this.schedule.splice(index, 1);
            return this.schedule;
        }
        return this.schedule;
    }

    getItemForDate(date: Date): ScheduleItem | null {
        for (const item of this.schedule) {
            if (isScheduleItemActive(item, date)) {
                return item;
            }
        }

        // Fallback: If we have exactly one schedule item
        if (this.schedule.length === 1) {
            return this.schedule[0];
        }

        return null;
    }

    getCurrentItem(): ScheduleItem | null {
        return this.getItemForDate(new Date());
    }

    // Preload storage
    private preloadedResult: { signature: string, tracks: Track[] } | null = null;
    private isPreloading = false;

    async processDJLoop(silentWait: boolean = true) {
        const now = new Date();
        const currentItem = this.getItemForDate(now);

        // 1. Check if we need to PRELOAD for the future (e.g. 60 seconds ahead)
        // Only if we have a schedule with multiple items or time-based logic
        if (this.schedule.length > 1) {
            const PRELOAD_MS = 60 * 1000;
            const futureDate = new Date(now.getTime() + PRELOAD_MS);
            const nextItem = this.getItemForDate(futureDate);

            // If we found a next item, and it is DIFFERENT from what we are playing now/last played
            if (nextItem) {
                const nextSignature = getScheduleItemSignature(nextItem);
                const queries = getScheduleItemQueries(nextItem);

                // If next signature differs from current ACTIVE signature AND we haven't preloaded it yet
                if (nextSignature && nextSignature !== this.lastQuery &&
                    (!this.preloadedResult || this.preloadedResult.signature !== nextSignature)) {

                    if (!this.isPreloading) {
                        console.log(`⏳ Preloading tracks for upcoming schedule: ${nextSignature} `);
                        this.isPreloading = true;

                        // Perform search in background (async)
                        this.searchTracks(queries, nextItem.priorityTrack, {
                            userRequest: nextItem.userRequest,
                            thought: nextItem.thought,
                            anchorTracks: nextItem.anchorTracks
                        }).then(tracks => {
                            console.log(`✅ Preloaded ${tracks.length} tracks for "${nextSignature}"`);
                            this.preloadedResult = {
                                signature: nextSignature,
                                tracks: tracks
                            };
                            this.isPreloading = false;
                        }).catch(err => {
                            console.error("Failed to preload:", err);
                            this.isPreloading = false;
                        });
                    }
                }
            }
        }

        if (!currentItem) return;

        // Resolve query
        const queriesToUse = getScheduleItemQueries(currentItem);
        if (queriesToUse.length === 0) return;

        // Signature for change detection
        const querySignature = getScheduleItemSignature(currentItem);

        // Check if we need to change music
        if (querySignature !== this.lastQuery) {
            console.log(`🎧 DJ Change: ${querySignature} `);
            this.lastQuery = querySignature;
            setStorageItem(STORAGE_KEYS.DJ_LAST_QUERY, querySignature);

            // New Session: Add Separator & reset session-played tracks
            this.addLog("──────── New Session Started ────────");
            this.sessionPlayedUris.clear();
            this.sessionPlayedKeys.clear();

            let tracks: Track[] = [];

            // Search condition: Check if we have any devices to play on
            // This prevents "AI Filtering" (and cost) if the user isn't ready to listen.
            const devices = await this.getDevices();
            if (devices.length === 0) {
                const msg = "⚠️ DJ Search skipped: No available Spotify devices. Please open Spotify.";
                console.log(msg);
                if (!silentWait) {
                    throw new Error("No active Spotify device found. Please open Spotify on your device. (再生デバイスが見つかりません。Spotifyを開いてください)");
                }
                return;
            }

            // Check if we have preloaded tracks for this exact signature
            if (this.preloadedResult && this.preloadedResult.signature === querySignature) {
                console.log(`🚀 Using Preloaded Tracks for ${querySignature}`);
                tracks = this.preloadedResult.tracks;
                this.preloadedResult = null; // Consume
            } else {
                // Normal search
                console.log(`🔎 Performing immediate search for ${querySignature}`);
                tracks = await this.searchTracks(queriesToUse, currentItem.priorityTrack, {
                    userRequest: currentItem.userRequest,
                    thought: currentItem.thought,
                    anchorTracks: currentItem.anchorTracks
                });
            }

            try {
                // Register initial tracks to history
                tracks.forEach(t => {
                    this.sessionPlayedUris.add(t.uri);
                    this.sessionPlayedKeys.add(generateTrackKey(t));
                });

                await this.playTracks(tracks);

                if (this.onTracksPlayed) {
                    this.onTracksPlayed(tracks);
                }
            } catch (e) {
                console.error("Playback failed, reverting DJ state to allow retry on next tick:", e);
                // Revert state so the next loop tick will see this as a 'new' request and try again
                this.lastQuery = null;
                removeStorageItem(STORAGE_KEYS.DJ_LAST_QUERY);
                throw e; // Propagate error so handleSend can show toast, or loop can log it
            }
        } else {
            // Same context: Check for Auto-Refill (Okawari)
            await this.checkAndRefillQueue(queriesToUse, currentItem);
        }
    }

    // --- Auto-Refill Logic ---

    private async checkAndRefillQueue(queries: string[], currentItem: ScheduleItem) {
        if (this.isRefilling) return;

        // 0. Check Playback Status (Don't refill if not playing/active)
        const playback = await this.getPlaybackState();
        if (!playback || !playback.device || !playback.device.is_active) {
            return;
        }

        try {
            // 1. Check Queue Depth
            const queue = await this.getQueue();
            // Threshold: If 2 or fewer tracks remaining (Current + Next 1)
            // Note: getQueue usually returns [Next1, Next2...]. It doesn't include currently playing? 
            // It depends on endpoint behavior. Let's assume queue.length is the 'upcoming' tracks.
            // If length is small, we need more.
            if (queue.length < PLAYBACK_CONSTANTS.MIN_QUEUE_SIZE_FOR_REFILL) {

                // 2. Check Time Remaining (Simplified)
                // Very simple check: If current time is NOT close to end (naive: > 5 mins?)
                // Or simply: If we are still in the valid block, just refill. 
                // The loop handles switching when block ends. So if we are in block, we want music.
                // Refilling near end (e.g. 1 min left) might be wasteful but safe.

                this.isRefilling = true;
                this.addLog("🥣 Queue running low. Auto-Refill (Okawari) started...");

                // 3. Search Again
                const newTracks = await this.searchTracks(queries, undefined, {
                    userRequest: currentItem.userRequest,
                    thought: currentItem.thought,
                    anchorTracks: currentItem.anchorTracks
                }); // No priority track needed for refill usually

                // 4. Filter duplicates (Played in this session OR currently in queue)
                const queueKeys = new Set(queue.map(item => generateTrackKey(item as Track)));

                const candidates = newTracks.filter(t => {
                    const key = generateTrackKey(t);
                    return !this.sessionPlayedUris.has(t.uri) &&
                        !this.sessionPlayedKeys.has(key) &&
                        !queueKeys.has(key);
                });

                // 5. Add to Queue
                const REFILL_COUNT = 5;
                const toAdd = candidates.slice(0, REFILL_COUNT);

                if (toAdd.length > 0) {
                    this.addLog(`🥣 Adding ${toAdd.length} fresh tracks to queue...`);

                    // Add sequentially to preserve order
                    for (const track of toAdd) {
                        await this.addToQueue(track.uri);
                        this.sessionPlayedUris.add(track.uri);
                        this.sessionPlayedKeys.add(generateTrackKey(track));
                        // Brief delay to help Spotify digest order
                        await new Promise(r => setTimeout(r, 200));
                    }
                    this.addLog(`✅ Refill complete.`);
                } else {
                    this.addLog(`⚠️ Refill found no new unique tracks.`);
                    // Optional: If really out of tracks, maybe clear history to allow repeats?
                    // For now, let it be.
                }

                this.isRefilling = false;
            }
        } catch (e) {
            console.warn("Auto-refill failed:", e);
            this.isRefilling = false;
        }
    }

    private async addToQueue(uri: string) {
        return this.safeControlRequest(`queue?uri=${encodeURIComponent(uri)}`, 'POST');
    }

    // --- Queue Management ---

    async getQueue(): Promise<Track[]> {
        try {
            const response = await this.spotify.getGeneric('https://api.spotify.com/v1/me/player/queue');
            const queueItems = (response as { queue?: Track[] })?.queue || [];
            // Filter out non-track items (episodes) to prevent UI crashes
            const tracks = queueItems.filter((item: { type?: string }) => item.type === 'track') as Track[];
            const enriched = tracks.map(t => this.enrichTrackWithCachedMetadata(t));

            const now = Date.now();
            const isRecentPlay = now - this.lastPlayTime < 25000; // 25s window for Spotify sync

            if (enriched.length > 0) {
                // If we recently played tracks, verify Spotify's queue actually contains tracks from our current session
                if (isRecentPlay && this.currentSessionTracks.length > 1) {
                    const sessionUris = new Set(this.currentSessionTracks.map(t => t.uri));
                    const hasSessionTrack = enriched.some(t => sessionUris.has(t.uri));
                    if (!hasSessionTrack) {
                        // Spotify queue is still lagging / showing old playlist; fallback to fresh session tracks
                        console.log("⏳ Spotify queue lagging; showing fresh session tracks");
                        return this.currentSessionTracks.slice(1).map(t => this.enrichTrackWithCachedMetadata(t));
                    }
                }
                return enriched;
            }

            // Fallback: If Spotify returned empty queue (very common on mobile Connect right after play)
            if (this.currentSessionTracks.length > 1) {
                return this.currentSessionTracks.slice(1).map(t => this.enrichTrackWithCachedMetadata(t));
            }

            return [];
        } catch (e) {
            console.warn('Failed to fetch queue:', e);
            if (this.currentSessionTracks.length > 1) {
                return this.currentSessionTracks.slice(1).map(t => this.enrichTrackWithCachedMetadata(t));
            }
            return [];
        }
    }

    async getPlaybackState(): Promise<SpotifyApi.CurrentPlaybackResponse | null> {
        try {
            const state = await this.spotify.getMyCurrentPlaybackState();
            if (state && state.item && state.item.type === 'track') {
                this.enrichTrackWithCachedMetadata(state.item as Track);
                return state;
            }

            // If Spotify has not reported playback yet right after starting play (< 6s)
            const now = Date.now();
            if ((!state || !state.item) && this.lastPlayTime && now - this.lastPlayTime < 6000 && this.currentSessionTracks.length > 0) {
                return {
                    is_playing: true,
                    item: this.enrichTrackWithCachedMetadata(this.currentSessionTracks[0]),
                    device: { id: this.activeDeviceId || 'unknown', name: 'Connecting...', is_active: true } as any
                } as any;
            }

            return state;
        } catch (e) {
            console.warn('Failed to fetch playback state:', e);
            return null;
        }
    }

    // --- Status Inspection ---
    getDJStatus() {
        const currentItem = this.getCurrentItem();
        return {
            currentScheduleItem: currentItem,
            currentQuery: this.lastQuery,
            currentThought: currentItem?.thought || null,
            config: this.config
        };
    }

    // --- Controls ---
    // Replaced library calls with direct fetch to avoid JSON parse errors on 204 responses
    private async safeControlRequest(endpoint: string, method: 'POST' | 'PUT', body?: unknown) {
        const token = this.spotify.getAccessToken();
        if (!token) return;
        try {
            const res = await fetch(`https://api.spotify.com/v1/me/player/${endpoint}`, {
                method,
                headers: { 'Authorization': `Bearer ${token}` },
                ...(body ? { body: JSON.stringify(body), headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } } : {})
            });
            if (!res.ok && res.status !== 204) {
                console.warn(`Control request ${endpoint} failed: ${res.status}`);
            }
        } catch (e) {
            console.error(`Control request ${endpoint} error:`, e);
        }
    }

    async next() { return this.safeControlRequest('next', 'POST'); }
    async previous() { return this.safeControlRequest('previous', 'POST'); }
    async pause() { return this.safeControlRequest('pause', 'PUT'); }
    async resume() { return this.safeControlRequest('play', 'PUT'); }
}
