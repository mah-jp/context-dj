import SpotifyWebApi from 'spotify-web-api-js';
import { AIService, ScheduleItem } from './ai';
import { STORAGE_KEYS } from './constants';

export interface Track extends SpotifyApi.TrackObjectFull {
    contextName?: string;
}

export class DJCore {
    private spotify: SpotifyWebApi.SpotifyWebApiJs;
    private ai?: AIService;
    private schedule: ScheduleItem[] = [];
    private processLog: string[] = [];
    private lastQuery: string | null = null;
    private activeDeviceId: string | null = null;
    private config = {
        minPopularity: 45,
        trackSearchLimit: 40, // Reduced for web perfo
        onlyOfficial: false
    };

    constructor(accessToken: string) {
        this.spotify = new SpotifyWebApi();
        this.spotify.setAccessToken(accessToken);

        // Restore state
        if (typeof window !== 'undefined') {
            this.lastQuery = localStorage.getItem(STORAGE_KEYS.DJ_LAST_QUERY);
        }
    }

    updateAccessToken(token: string) {
        this.spotify.setAccessToken(token);
    }

    initAI(backend: 'openai' | 'gemini', apiKey: string, modelName?: string) {
        this.ai = new AIService(backend, apiKey, modelName);
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

    // --- Utilities ---

    private normalizeTrackName(name: string): string {
        // Remove text within parentheses (e.g. "Song (Remaster)")
        name = name.replace(/\(.*?\)/g, '');
        // Remove text after hyphen if it looks like metadata (e.g. "Song - Remastered 2009")
        // But be careful not to kill "Title - Subtitle" if it's part of the song
        // The previous logic was: name.replace(/\s-\s.*remaster.*/, '') in dedupe
        // The old helper was: name.replace(/\s-\s.*/g, '') -> this is too aggressive!
        // Let's adopt the stricter logic from dedupe but centralized here.
        name = name.replace(/\s-\s.*remaster.*/i, '');

        return name.trim().toLowerCase();
    }

    // --- Search & Filtering ---

    async searchTracks(queriesInput: string | string[], priorityQuery?: string): Promise<Track[]> {
        const queries = Array.isArray(queriesInput) ? queriesInput : [queriesInput];

        // 0. Resolve Priority Track
        let priorityTracks: Track[] = [];
        if (priorityQuery) {
            this.addLog(`🌟 Priority Search: ${priorityQuery}`);
            try {
                const pRes = await this.spotify.searchTracks(priorityQuery, { limit: 1 });
                if (pRes.tracks && pRes.tracks.items.length > 0) {
                    priorityTracks = pRes.tracks.items;
                    this.addLog(`✅ Found Priority Track: ${priorityTracks[0].name} (${priorityTracks[0].artists[0].name})`);
                } else {
                    this.addLog(`⚠️ Priority Search returned 0 results for: ${priorityQuery}`);
                }
            } catch (e) {
                console.warn("Priority search failed:", e);
                this.addLog(`⚠️ Priority Search Error`);
            }
        }

        // 1. Parse target artists for strict filtering
        const targetArtists = this.extractTargetArtists(queries);
        if (targetArtists.length > 0) this.addLog(`🎯 Target Artists: ${targetArtists.join(', ')}`);

        // 2. Execute Parallel Search
        let allRawTracks = await this.executeParallelSearch(queries);

        if (allRawTracks.length === 0 && priorityTracks.length === 0) {
            this.addLog("❌ No tracks found from Spotify Search");
            return [];
        }

        // 3. Deduplicate
        const uniqueTracks = this.deduplicateTracks(allRawTracks);
        this.addLog(`📊 Found ${allRawTracks.length} raw hits -> ${uniqueTracks.length} unique tracks`);

        // 4. Apply Filters (Strict Artist -> Popularity)
        const filteredTracks = this.applyTrackFilters(uniqueTracks, targetArtists);

        // 5. Select Final Set (Shuffle & Pick)
        let finalTracks = this.selectTopTracks(filteredTracks);

        // 6. Merge Priority Track
        if (priorityTracks.length > 0) {
            const pUri = priorityTracks[0].uri;
            finalTracks = finalTracks.filter(t => t.uri !== pUri);
            finalTracks = [...priorityTracks, ...finalTracks];
            this.addLog(`📌 Priority track applied at the top.`);
        }

        return finalTracks;
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
        let allRawTracks: Track[] = [];

        await Promise.all(queries.map(async (query) => {
            const cleanQuery = query.replace(/"/g, '').replace(/'/g, '');
            const searchQuery = this.config.onlyOfficial ? `owner:spotify ${cleanQuery}` : cleanQuery;

            try {
                const [trackRes, playlistRes] = await Promise.all([
                    this.spotify.searchTracks(searchQuery, { limit: this.config.trackSearchLimit }),
                    this.spotify.searchPlaylists(searchQuery, { limit: 2 })
                ]);

                if (trackRes.tracks && trackRes.tracks.items) {
                    allRawTracks.push(...trackRes.tracks.items);
                }

                if (playlistRes.playlists && playlistRes.playlists.items.length > 0) {
                    const bestPlaylist = playlistRes.playlists.items[0];
                    try {
                        const plTracksRes = await this.spotify.getPlaylistTracks(bestPlaylist.id, { limit: 20 });
                        const extractedTracks = plTracksRes.items
                            .map(item => {
                                const t = item.track as Track;
                                // Filter out episodes or local files
                                if (!t || t.type !== 'track' || !t.id) return null;
                                t.contextName = `Playlist: ${bestPlaylist.name}`;
                                return t;
                            })
                            .filter((t): t is Track => t !== null);


                        this.addLog(`📜 Scanned Playlist: "${bestPlaylist.name}" (${extractedTracks.length} tracks)`);
                        this.logTrackSamples(extractedTracks);
                        allRawTracks.push(...extractedTracks);
                    } catch (plErr) {
                        console.warn(`⚠️ Failed to load tracks from playlist ${bestPlaylist.name}:`, plErr);
                    }
                }
            } catch (error) {
                console.warn(`⚠️ Partial search failed for "${query}":`, error);
            }
        }));

        // DO NOT SORT BY POPULARITY HERE. 
        // Just shuffle gently to mix results from different queries
        return allRawTracks.sort(() => Math.random() - 0.5);
    }

    private deduplicateTracks(tracks: Track[]): Track[] {
        const seenKeys = new Set<string>();
        const uniqueTracks: Track[] = [];

        for (const track of tracks) {
            // Use shared normalization
            const cleanName = this.normalizeTrackName(track.name);
            const cleanArtist = track.artists[0]?.name.toLowerCase().trim() || '';
            const key = `${cleanName}|${cleanArtist}`;

            if (!seenKeys.has(key)) {
                seenKeys.add(key);
                uniqueTracks.push(track);
            }
        }
        return uniqueTracks;
    }

    private applyTrackFilters(tracks: Track[], targetArtists: string[]): Track[] {
        let candidates = tracks;

        // Note: We removed Strict Artist Filtering because it was too aggressive for mixed queries.
        // (e.g. "80s hits" + "Queen" -> previously filtered OUT all non-Queen 80s hits)
        // Now we trust the search queries to bring relevant results.

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

    private selectTopTracks(tracks: Track[]): Track[] {
        const MAX_TOP_TRACKS = 40;

        // Shuffle FIRST to ensure Serendipity
        // We do strictly random shuffle here.
        const shuffled = [...tracks].sort(() => Math.random() - 0.5);

        // Then take the top N
        const sliceCount = Math.min(MAX_TOP_TRACKS, shuffled.length);
        const finalSelection = shuffled.slice(0, sliceCount);

        return finalSelection;
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
        // Use 'en-US' with hour12: false for HH:mm comparisons
        const currentTime = date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });

        for (const item of this.schedule) {
            // Handle simple HH:MM comparisons
            if (item.start <= currentTime && currentTime < item.end) {
                return item;
            }
            // Handle date crossing (23:00 - 01:00)
            if (item.start > item.end) {
                if (currentTime >= item.start || currentTime < item.end) {
                    return item;
                }
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

    async processDJLoop() {
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
                const queries = nextItem.queries?.length ? nextItem.queries : (nextItem.query ? [nextItem.query] : []);
                const priorityPart = nextItem.priorityTrack || '';
                const nextSignature = queries.join('|') + (priorityPart ? '|' + priorityPart : '');

                // If next signature differs from current ACTIVE signature AND we haven't preloaded it yet
                if (nextSignature && nextSignature !== this.lastQuery &&
                    (!this.preloadedResult || this.preloadedResult.signature !== nextSignature)) {

                    if (!this.isPreloading) {
                        console.log(`⏳ Preloading tracks for upcoming schedule: ${nextSignature} `);
                        this.isPreloading = true;

                        // Perform search in background (async)
                        this.searchTracks(queries, nextItem.priorityTrack).then(tracks => {
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
        let queriesToUse: string[] = [];
        if (currentItem.queries && currentItem.queries.length > 0) {
            queriesToUse = currentItem.queries;
        } else if (currentItem.query) {
            queriesToUse = [currentItem.query];
        }

        if (queriesToUse.length === 0) return;

        // Signature for change detection
        const querySignature = queriesToUse.join('|') + (currentItem.priorityTrack ? `|${currentItem.priorityTrack}` : '');

        // Check if we need to change music
        if (querySignature !== this.lastQuery) {
            console.log(`🎧 DJ Change: ${querySignature} `);
            this.lastQuery = querySignature;
            if (typeof window !== 'undefined') {
                localStorage.setItem(STORAGE_KEYS.DJ_LAST_QUERY, querySignature);
            }

            // New Session: Clear Log & History
            this.processLog = [];
            this.addLog("▶️ New DJ Request Started");
            this.sessionPlayedUris.clear();

            let tracks: Track[] = [];

            // Check if we have preloaded tracks for this exact signature
            if (this.preloadedResult && this.preloadedResult.signature === querySignature) {
                console.log(`🚀 Using Preloaded Tracks for ${querySignature}`);
                tracks = this.preloadedResult.tracks;
                this.preloadedResult = null; // Consume
            } else {
                // Normal search
                console.log(`🔎 Performing immediate search for ${querySignature}`);
                tracks = await this.searchTracks(queriesToUse, currentItem.priorityTrack);
            }

            try {
                // Register initial tracks to history
                tracks.forEach(t => this.sessionPlayedUris.add(t.uri));

                await this.playTracks(tracks);
            } catch (e) {
                console.error("Playback failed, reverting DJ state to allow retry on next tick:", e);
                // Revert state so the next loop tick will see this as a 'new' request and try again
                this.lastQuery = null;
                if (typeof window !== 'undefined') {
                    localStorage.removeItem(STORAGE_KEYS.DJ_LAST_QUERY);
                }
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

        try {
            // 1. Check Queue Depth
            const queue = await this.getQueue();
            // Threshold: If 2 or fewer tracks remaining (Current + Next 1)
            // Note: getQueue usually returns [Next1, Next2...]. It doesn't include currently playing? 
            // It depends on endpoint behavior. Let's assume queue.length is the 'upcoming' tracks.
            // If length is small, we need more.
            if (queue.length <= 2) {

                // 2. Check Time Remaining (Simplified)
                // Very simple check: If current time is NOT close to end (naive: > 5 mins?)
                // Or simply: If we are still in the valid block, just refill. 
                // The loop handles switching when block ends. So if we are in block, we want music.
                // Refilling near end (e.g. 1 min left) might be wasteful but safe.

                this.isRefilling = true;
                this.addLog("🥣 Queue running low. Auto-Refill (Okawari) started...");

                // 3. Search Again
                const newTracks = await this.searchTracks(queries); // No priority track needed for refill usually

                // 4. Filter duplicates (Played in this session OR currently in queue)
                const queueUris = new Set(queue.map(t => t.uri));
                const candidates = newTracks.filter(t =>
                    !this.sessionPlayedUris.has(t.uri) &&
                    !queueUris.has(t.uri)
                );

                // 5. Add to Queue
                const REFILL_COUNT = 5;
                const toAdd = candidates.slice(0, REFILL_COUNT);

                if (toAdd.length > 0) {
                    this.addLog(`🥣 Adding ${toAdd.length} fresh tracks to queue...`);

                    // Add sequentially to preserve order
                    for (const track of toAdd) {
                        await this.addToQueue(track.uri);
                        this.sessionPlayedUris.add(track.uri);
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
            // Use generic request if method is missing in types
            // @ts-ignore
            const response = await this.spotify.getGeneric('https://api.spotify.com/v1/me/player/queue');
            // @ts-ignore
            const queueItems = response.queue || [];
            // Filter out non-track items (episodes) to prevent UI crashes
            return queueItems.filter((item: any) => item.type === 'track') as Track[];
        } catch (e) {
            console.warn('Failed to fetch queue:', e);
            return [];
        }
    }

    async getPlaybackState(): Promise<SpotifyApi.CurrentPlaybackResponse | null> {
        try {
            return await this.spotify.getMyCurrentPlaybackState();
        } catch (e) {
            console.warn('Failed to fetch playback state:', e);
            return null;
        }
    }

    // --- Status Inspection ---
    getDJStatus() {
        return {
            currentScheduleItem: this.getCurrentItem(),
            currentQuery: this.lastQuery,
            config: this.config
        };
    }



    // --- Controls ---
    // Replaced library calls with direct fetch to avoid JSON parse errors on 204 responses
    private async safeControlRequest(endpoint: string, method: 'POST' | 'PUT', body?: any) {
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
