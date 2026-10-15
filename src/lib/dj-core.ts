import SpotifyWebApi from 'spotify-web-api-js';
import { AIService } from './ai';
import { STORAGE_KEYS, PLAYBACK_CONSTANTS, DEFAULTS } from './constants';
import { AIProvider, ScheduleItem, Track, DJConfig, TrackEvaluation } from './types';
import { getStorageItem, setStorageItem, removeStorageItem } from './storage';
import { generateTrackKey, isScheduleItemActive, getScheduleItemSignature, getScheduleItemQueries, parseTimeToMinutes } from './dj-utils';
import { extractTargetArtists, deduplicateTracks, filterTracksByPopularityAndArtist, sequenceTracksByStory } from './track-curator';
import { TrackSessionCache } from './track-session-cache';
import { SpotifyPlayerClient } from './spotify-player-client';

export type { Track };

export class DJCore {
    private spotify: SpotifyWebApi.SpotifyWebApiJs;
    private playerClient: SpotifyPlayerClient;
    private sessionCache: TrackSessionCache;
    private ai?: AIService;
    private schedule: ScheduleItem[] = [];
    private processLog: string[] = [];
    private lastQuery: string | null = null;
    private lastPlayTime: number = 0;
    private config: DJConfig = {
        minPopularity: PLAYBACK_CONSTANTS.PREFERRED_TRACK_POPULARITY,
        trackSearchLimit: PLAYBACK_CONSTANTS.TRACK_SEARCH_LIMIT,
        onlyOfficial: false,
        aiFiltering: true
    };
    private onStatusUpdate?: (status: string) => void;
    private onTracksPlayed?: (tracks: Track[]) => void;
    private lastPlayingTrack: Track | null = null;
    private isRefilling = false;
    private lastRefillAttemptTime = 0;
    private preloadedResult: { signature: string, tracks: Track[] } | null = null;
    private isPreloading = false;

    constructor(accessToken: string) {
        this.spotify = new SpotifyWebApi();
        this.spotify.setAccessToken(accessToken);
        this.playerClient = new SpotifyPlayerClient(this.spotify);
        this.sessionCache = new TrackSessionCache();

        // Restore state
        this.lastQuery = getStorageItem(STORAGE_KEYS.DJ_LAST_QUERY, '') || null;
        const savedFiltering = getStorageItem(STORAGE_KEYS.AI_FILTERING_ENABLED, '');
        this.config.aiFiltering = savedFiltering === '' ? DEFAULTS.AI_FILTERING_ENABLED : savedFiltering === 'true';
    }

    private get currentSessionTracks(): Track[] {
        return this.sessionCache.getSessionTracks();
    }

    private set currentSessionTracks(tracks: Track[]) {
        this.sessionCache.setSessionTracks(tracks, false);
    }

    enrichTrackWithCachedMetadata(track: Track): Track {
        return this.sessionCache.enrichTrackWithCachedMetadata(track);
    }

    findTrackIndexInSession(track: Track | SpotifyApi.TrackObjectFull): number {
        return this.sessionCache.findTrackIndexInSession(track);
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
        console.log(msg);
        this.processLog.unshift(msg);
        if (this.processLog.length > 100) this.processLog.pop();
    }

    setStatusCallback(cb: (status: string) => void) {
        this.onStatusUpdate = cb;
    }

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
        const targetArtists = extractTargetArtists(queries);
        if (targetArtists.length > 0) this.addLog(`🎯 Target Artists: ${targetArtists.join(', ')}`);

        // 3. Execute Parallel Search
        const searchTracks = await this.executeParallelSearch(queries);
        const allRawTracks = [...anchorTracks, ...searchTracks];

        if (allRawTracks.length === 0 && priorityTracks.length === 0) {
            this.addLog("❌ No tracks found from Spotify Search");
            return [];
        }

        // 4. Deduplicate
        const uniqueTracks = deduplicateTracks(allRawTracks);
        this.addLog(`📊 Found ${allRawTracks.length} raw hits -> ${uniqueTracks.length} unique tracks`);

        // 5. Apply Filters (Strict Artist -> Popularity)
        const filteredTracks = this.applyTrackFilters(uniqueTracks, targetArtists);

        // 6. AI Filtering & Multi-axis Scoring
        const candidates = await this.performAIFiltering(filteredTracks, context);

        // 7. Smart Sequencing (起承転結: Intro -> Build -> Peak -> Outro)
        const { tracks: sequencedTracks, stageCounts } = sequenceTracksByStory(candidates, targetArtists);
        let finalTracks = sequencedTracks;
        if (candidates.length > 2) {
            this.addLog(`🎼 Smart Sequencing (起承転結): Intro (${stageCounts.intro}) → Build (${stageCounts.build}) → Peak (${stageCounts.peak}) → Outro (${stageCounts.outro})`);
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
                p.selectionReason = p.selectionReason || (context?.thought ? `セッションの幕開けを飾るキートラックとして選曲。` : 'オープニングを飾るキートラックです。');
                p.energy = 5;
                p.stage = 'intro';
            }
            finalTracks = finalTracks.filter(t => t.uri !== pUri);
            finalTracks = [p, ...finalTracks];
            this.addLog(`📌 Priority track applied at the top: ${p.name} [${p.vibeTag}] (Stage: Intro)`);
        }

        // Cache all metadata so it persists when Spotify queue is polled
        this.sessionCache.cacheTrackMetadata(finalTracks);

        return finalTracks;
    }

    private async findPriorityTrack(priorityQuery?: string): Promise<Track[]> {
        if (!priorityQuery) return [];

        this.addLog(`🌟 Priority Search: ${priorityQuery}`);
        try {
            const pRes = await this.spotify.searchTracks(priorityQuery, { limit: 5 });
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
                this.addLog(`✅ Found Priority Track: ${bestTrack.name} (${bestTrack.artists[0]?.name})`);
                return [bestTrack];
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
            const trackData = topCandidates.map(t => ({
                name: t.name,
                artist: t.artists.map(a => a.name).join(', ') || t.artists[0]?.name || 'Unknown',
                album: t.album?.name || '',
                id: t.uri
            }));
            const request = context.userRequest || 'Follow the DJ mood';
            const evaluations = await this.ai.filterTracksWithAI(request, trackData, context.thought);

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

            this.sessionCache.cacheTrackMetadata(candidates);

            let qualified = candidates.filter(t => (t.score ?? 0) >= 60);
            if (qualified.length < 5 && candidates.some(t => t.score !== undefined)) {
                qualified = candidates.filter(t => (t.score ?? 0) >= 50);
            }

            this.addLog(`🤖 AI Filtering: ${candidates.length} -> ${qualified.length} tracks kept.`);
            this.updateStatus('Ready');

            if (qualified.length > 0) {
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

    private async executeParallelSearch(queries: string[]): Promise<Track[]> {
        const allRawTracks: Track[] = [];
        const limit = this.config.trackSearchLimit || PLAYBACK_CONSTANTS.TRACK_SEARCH_LIMIT;

        await Promise.all(queries.map(async (query) => {
            const searchQuery = this.config.onlyOfficial ? `owner:spotify ${query}` : query;

            try {
                const [trackResPage1, trackResPage2] = await Promise.all([
                    this.spotify.searchTracks(searchQuery, { limit, offset: 0 }),
                    this.spotify.searchTracks(searchQuery, { limit, offset: limit }).catch(() => null)
                ]);

                if (trackResPage1?.tracks?.items) {
                    allRawTracks.push(...trackResPage1.tracks.items);
                }
                if (trackResPage2?.tracks?.items) {
                    allRawTracks.push(...trackResPage2.tracks.items);
                }
            } catch (error) {
                console.warn(`⚠️ Partial search failed for "${query}":`, error);
            }
        }));

        return allRawTracks.sort(() => Math.random() - 0.5);
    }

    private applyTrackFilters(tracks: Track[], targetArtists: string[] = []): Track[] {
        const preferredPopularity = this.config.minPopularity;
        const minPopularity = Math.min(preferredPopularity, PLAYBACK_CONSTANTS.MIN_TRACK_POPULARITY);

        const result = filterTracksByPopularityAndArtist(tracks, targetArtists, preferredPopularity, minPopularity);

        if (result.targetPreservedCount > 0) {
            this.addLog(`🎯 Preserved ${result.targetPreservedCount} tracks by requested artist(s) without popularity cutoff`);
        }
        if (result.relaxedToMin) {
            this.addLog(`⚠️ Popularity >= ${preferredPopularity} too strict. Relaxing to >= ${minPopularity}...`);
        }
        if (result.revertedToAll) {
            this.addLog('⚠️ No tracks matched popularity criteria. Using all candidates.');
            return result.tracks;
        }

        this.addLog(`🔍 Filter: Popularity Check (${result.tracks.length} / ${tracks.length} kept)`);
        this.logTrackSamples(result.tracks);
        return result.tracks;
    }

    private logTrackSamples(tracks: Track[]) {
        if (tracks.length === 0) return;
        const samples = tracks.slice(0, 3).map(t => `${t.name} (${t.artists[0].name})`).join(', ');
        const more = tracks.length > 3 ? `...and ${tracks.length - 3} more` : '';
        this.addLog(`   👉 [Sample]: ${samples} ${more}`);
    }

    // --- Device & Playback Control ---

    async getDevices(): Promise<SpotifyApi.UserDevice[]> {
        return this.playerClient.getDevices();
    }

    async setActiveDevice(deviceId: string) {
        return this.playerClient.setActiveDevice(deviceId);
    }

    async playTracks(tracks: Track[]) {
        if (tracks.length === 0) return;

        const uris = tracks.map(t => t.uri);

        try {
            const deviceId = await this.playerClient.resolveTargetDevice();
            console.log(`▶️ Playing ${uris.length} tracks on device ${deviceId}`);

            await this.playerClient.startPlaybackOnDevice(deviceId, uris);

            this.sessionCache.setSessionTracks(tracks, true);
            this.lastPlayTime = Date.now();
            if (this.onTracksPlayed) {
                this.onTracksPlayed(tracks);
            }
        } catch (error) {
            console.error('Playback error:', error);
            throw error;
        }
    }

    // --- Schedule Management ---

    async createSchedule(instruction: string, personalContext?: string) {
        if (!this.ai) throw new Error("AI not initialized (AIが初期化されていません)");

        const schedule = await this.ai.generateSchedule(instruction, this.schedule, personalContext);

        // If first item starts slightly in the future (within 3 hours), align with now so playback starts immediately
        if (schedule.length > 0) {
            const now = new Date();
            const nowStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
            const firstStartMins = parseTimeToMinutes(schedule[0].start);
            const nowMins = now.getHours() * 60 + now.getMinutes();

            if (firstStartMins > nowMins && (firstStartMins - nowMins <= 180)) {
                schedule[0].start = nowStr;
            }
        }

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

        if (this.schedule.length === 1) {
            return this.schedule[0];
        }

        return null;
    }

    /**
     * Resolves the effective schedule item to play right now.
     * Guarantees the DJ will not stall silently if a schedule exists.
     */
    getEffectiveItemForPlayback(date: Date = new Date()): ScheduleItem | null {
        if (!this.schedule || this.schedule.length === 0) return null;

        const activeItem = this.getItemForDate(date);
        if (activeItem) return activeItem;

        const currentMins = date.getHours() * 60 + date.getMinutes();
        const firstItem = this.schedule[0];
        const firstStartMins = parseTimeToMinutes(firstItem.start);

        if (currentMins < firstStartMins) {
            return firstItem;
        }

        let bestItem: ScheduleItem = this.schedule[0];
        for (const item of this.schedule) {
            const startMins = parseTimeToMinutes(item.start);
            if (startMins <= currentMins) {
                bestItem = item;
            }
        }
        return bestItem;
    }

    getCurrentItem(): ScheduleItem | null {
        return this.getItemForDate(new Date());
    }

    // --- Main DJ Loop & Preloading ---

    async processDJLoop(silentWait: boolean = true, force: boolean = false) {
        const now = new Date();
        const currentItem = this.getEffectiveItemForPlayback(now);

        // 1. Check if we need to PRELOAD for upcoming schedule (60 seconds ahead)
        if (this.schedule.length > 1) {
            const PRELOAD_MS = 60 * 1000;
            const futureDate = new Date(now.getTime() + PRELOAD_MS);
            const nextItem = this.getItemForDate(futureDate);

            if (nextItem) {
                const nextSignature = getScheduleItemSignature(nextItem);
                const queries = getScheduleItemQueries(nextItem);

                if (nextSignature && nextSignature !== this.lastQuery &&
                    (!this.preloadedResult || this.preloadedResult.signature !== nextSignature)) {

                    if (!this.isPreloading) {
                        console.log(`⏳ Preloading tracks for upcoming schedule: ${nextSignature} `);
                        this.isPreloading = true;

                        this.searchTracks(queries, nextItem.priorityTrack, {
                            userRequest: nextItem.userRequest,
                            thought: nextItem.thought,
                            anchorTracks: nextItem.anchorTracks
                        }).then(tracks => {
                            console.log(`✅ Preloaded ${tracks.length} tracks for "${nextSignature}"`);
                            this.preloadedResult = {
                                signature: nextSignature,
                                tracks
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

        const queriesToUse = getScheduleItemQueries(currentItem);
        if (queriesToUse.length === 0) return;

        const querySignature = getScheduleItemSignature(currentItem);

        // 2. Check if we need to change music
        if (force || querySignature !== this.lastQuery) {
            console.log(`🎧 DJ Change${force ? ' (Forced)' : ''}: ${querySignature} `);
            this.lastQuery = querySignature;
            setStorageItem(STORAGE_KEYS.DJ_LAST_QUERY, querySignature);

            this.addLog("──────── New Session Started ────────");
            this.sessionCache.resetSessionPlayedHistory();

            let tracks: Track[] = [];

            const devices = await this.getDevices();
            if (devices.length === 0) {
                const msg = "No active Spotify device found. Please open Spotify on your device. (再生デバイスが見つかりません。Spotifyを開いてください)";
                console.log(`⚠️ DJ Search skipped: ${msg}`);
                this.updateStatus('⚠️ Please open Spotify (Spotifyを開いてください)');
                this.addLog(`⚠️ ${msg}`);
                if (!silentWait) {
                    throw new Error(msg);
                }
                return;
            }

            if (this.preloadedResult && this.preloadedResult.signature === querySignature) {
                console.log(`🚀 Using Preloaded Tracks for ${querySignature}`);
                tracks = this.preloadedResult.tracks;
                this.preloadedResult = null;
            } else {
                this.updateStatus(`🔎 Searching: ${queriesToUse[0]}... (選曲中...)`);
                console.log(`🔎 Performing immediate search for ${querySignature}`);
                tracks = await this.searchTracks(queriesToUse, currentItem.priorityTrack, {
                    userRequest: currentItem.userRequest,
                    thought: currentItem.thought,
                    anchorTracks: currentItem.anchorTracks
                });
            }

            try {
                this.sessionCache.markTracksPlayed(tracks);

                this.updateStatus('▶️ Starting playback... (再生開始中...)');
                await this.playTracks(tracks);
                this.updateStatus('Ready');

                if (this.onTracksPlayed) {
                    this.onTracksPlayed(tracks);
                }
            } catch (e) {
                console.error("Playback failed, reverting DJ state to allow retry on next tick:", e);
                this.lastQuery = null;
                removeStorageItem(STORAGE_KEYS.DJ_LAST_QUERY);
                throw e;
            }
        } else {
            // Same context: Check for Auto-Refill (Okawari)
            await this.checkAndRefillQueue(queriesToUse, currentItem);
        }
    }

    // --- Auto-Refill Logic ---

    private async checkAndRefillQueue(queries: string[], currentItem: ScheduleItem) {
        if (this.isRefilling) return;

        const now = Date.now();
        const REFILL_COOLDOWN_MS = 60 * 1000;
        if (now - this.lastRefillAttemptTime < REFILL_COOLDOWN_MS) {
            return;
        }

        const playback = await this.getPlaybackState();
        if (!playback || !playback.device || !playback.device.is_active) {
            return;
        }

        try {
            const queue = await this.getQueue();
            if (queue.length < PLAYBACK_CONSTANTS.MIN_QUEUE_SIZE_FOR_REFILL) {
                this.isRefilling = true;
                this.lastRefillAttemptTime = Date.now();
                this.addLog("🥣 Queue running low. Auto-Refill (Okawari) started...");

                const newTracks = await this.searchTracks(queries, undefined, {
                    userRequest: currentItem.userRequest,
                    thought: currentItem.thought,
                    anchorTracks: currentItem.anchorTracks
                });

                const queueKeys = new Set(queue.map(item => generateTrackKey(item as Track)));

                const candidates = newTracks.filter(t => {
                    const key = generateTrackKey(t);
                    return !this.sessionCache.isTrackPlayedInSession(t) && !queueKeys.has(key);
                });

                const REFILL_COUNT = 5;
                const toAdd = candidates.slice(0, REFILL_COUNT);

                if (toAdd.length > 0) {
                    this.addLog(`🥣 Adding ${toAdd.length} fresh tracks to queue...`);

                    for (const track of toAdd) {
                        await this.playerClient.addToQueue(track.uri);
                        this.sessionCache.markTrackPlayed(track);
                        await new Promise(r => setTimeout(r, 200));
                    }
                    this.sessionCache.appendSessionTracks(toAdd);
                    this.addLog(`✅ Refill complete.`);
                } else {
                    this.addLog(`⚠️ Refill found no new unique tracks.`);
                    this.lastRefillAttemptTime = Date.now() + 120 * 1000;
                }

                this.isRefilling = false;
            }
        } catch (e) {
            console.warn("Auto-refill failed:", e);
            this.isRefilling = false;
        }
    }

    // --- Queue & Playback State ---

    async getQueue(currentTrackOverride?: Track | null): Promise<Track[]> {
        const activeTrack = currentTrackOverride || this.lastPlayingTrack;
        const sessionTracks = this.sessionCache.getSessionTracks();

        if (sessionTracks.length > 0) {
            let foundIndex = -1;
            if (activeTrack) {
                foundIndex = this.sessionCache.findTrackIndexInSession(activeTrack);
            }

            if (foundIndex >= 0) {
                return sessionTracks
                    .slice(foundIndex + 1)
                    .map(t => this.sessionCache.enrichTrackWithCachedMetadata(t));
            }

            const now = Date.now();
            if (this.lastPlayTime && now - this.lastPlayTime < 15000) {
                return sessionTracks
                    .slice(1)
                    .map(t => this.sessionCache.enrichTrackWithCachedMetadata(t));
            }

            return this.sessionCache.getSessionTracksFromCurrent(activeTrack);
        }

        try {
            const response = await this.spotify.getGeneric('https://api.spotify.com/v1/me/player/queue') as {
                currently_playing?: Track;
                queue?: Track[];
            } | null;

            const queueItems = response?.queue || [];
            const tracks = queueItems.filter((item: { type?: string }) => item.type === 'track') as Track[];
            let enriched = tracks.map(t => this.sessionCache.enrichTrackWithCachedMetadata(t));

            if (activeTrack && enriched.length > 0) {
                const activeKey = generateTrackKey(activeTrack);
                const activeUri = activeTrack.uri;
                while (enriched.length > 0) {
                    const first = enriched[0];
                    if (first.uri === activeUri || (activeKey && generateTrackKey(first) === activeKey)) {
                        enriched = enriched.slice(1);
                    } else {
                        break;
                    }
                }
            }

            if (enriched.length > 0) {
                return enriched;
            }

            if (sessionTracks.length > 0) {
                return this.sessionCache.getSessionTracksFromCurrent(activeTrack);
            }

            return [];
        } catch (e) {
            console.warn('Failed to fetch queue:', e);
            if (sessionTracks.length > 0) {
                return this.sessionCache.getSessionTracksFromCurrent(activeTrack);
            }
            return [];
        }
    }

    async getPlaybackState(): Promise<SpotifyApi.CurrentPlaybackResponse | null> {
        try {
            const state = await this.spotify.getMyCurrentPlaybackState();
            const now = Date.now();
            const sessionTracks = this.sessionCache.getSessionTracks();

            if (this.lastPlayTime && now - this.lastPlayTime < 6000 && sessionTracks.length > 0) {
                const firstSessionTrack = sessionTracks[0];
                const isPlayingOldTrack = state?.item && this.sessionCache.findTrackIndexInSession(state.item) === -1;
                const isNoTrack = !state || !state.item;

                if (isNoTrack || isPlayingOldTrack) {
                    const enriched = this.sessionCache.enrichTrackWithCachedMetadata(firstSessionTrack);
                    this.lastPlayingTrack = enriched;
                    const fallbackDevice: SpotifyApi.UserDevice = (state && state.device) || {
                        id: this.playerClient.getActiveDeviceId() || 'unknown',
                        is_active: true,
                        is_private_session: false,
                        is_restricted: false,
                        name: 'Connecting...',
                        type: 'Computer',
                        volume_percent: 100
                    };
                    return {
                        ...(state || {}),
                        is_playing: true,
                        item: enriched,
                        device: fallbackDevice
                    } as SpotifyApi.CurrentPlaybackResponse;
                }
            }

            if (state && state.item && state.item.type === 'track') {
                const enriched = this.sessionCache.enrichTrackWithCachedMetadata(state.item as Track);
                state.item = enriched;
                this.lastPlayingTrack = enriched;
                return state;
            }

            if (!state || !state.item) {
                this.lastPlayingTrack = null;
            }

            return state;
        } catch (e) {
            console.warn('Failed to fetch playback state:', e);
            return null;
        }
    }

    // --- Status Inspection & Transport Controls ---

    getLastPlayTime(): number {
        return this.lastPlayTime;
    }

    getDJStatus() {
        const currentItem = this.getCurrentItem();
        return {
            currentScheduleItem: currentItem,
            currentQuery: this.lastQuery,
            currentThought: currentItem?.thought || null,
            config: this.config
        };
    }

    async next() { return this.playerClient.next(); }
    async previous() { return this.playerClient.previous(); }
    async pause() { return this.playerClient.pause(); }
    async resume() { return this.playerClient.resume(); }
}
