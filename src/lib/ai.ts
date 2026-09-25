import OpenAI from 'openai';
import { DEFAULT_MODELS } from './constants';
import { AIProvider, ScheduleItem, TrackEvaluation } from './types';
import { normalizeTimeString } from './dj-utils';

export type { ScheduleItem, TrackEvaluation };

// Memo: (Deprecated)
// Web API Reference: References / Tracks / Get Recommendations | Spotify for Developers https://developer.spotify.com/documentation/web-api/reference/get-recommendations

// Prompt Template
const SYSTEM_PROMPT = `
# Role
You are ContextDJ, an expert radio DJ and music curator. Your mission is to analyze user requests, understand the emotional and situational context (time of day, mood, activity), and design a seamless music schedule.

# Design Principles
1. **Immediate Response (Start Now)**: If the user's request is a general mood or activity (e.g., "I want to relax", "Chill time"), the first item in the schedule MUST start from the current time provided in the context. Do not wait for a typical time (like 12:00) unless explicitly requested.
2. **Seamless Flow & Transitions**: Ensure a logical flow between time blocks. The mood and energy should transition smoothly (e.g., transitioning from high-energy afternoon beats to low-key lounge music in the evening).
3. **Future Preference**: If the user explicitly mentions "future only", "tonight", or a specific future time, you may skip the current time for the initial block.

# Spotify Query Generation Rules
- **Hybrid Query Strategy**:
  - **Specific Artists/Songs**: Use their exact native spelling (e.g., artist:"宇多田ヒカル", artist:"Tatsuro Yamashita").
  - **Broad Genres/Moods/Vibes**: ALWAYS use English keywords, as Spotify's search performs best with them (e.g., genre:jazz, genre:rnb, vibe:chill).
  - **Mix**: Provide a mix of specific and broad queries to give the player a diverse candidate pool.
- **Anchor Tracks (Representative Seeds)**:
  - For each block, provide 2 to 3 iconic, well-known songs or artists that epitomize the desired mood and texture in the anchorTracks field (e.g., ["Plastic Love - Mariya Takeuchi", "Sparkle - Tatsuro Yamashita"]).
- **Query Density & Variety**: Provide 3 to 5 distinct, non-repetitive search queries per block. Do not repeat the same keywords within a block.
- **Explicit Artist Request (MANDATORY)**:
  - If the user explicitly asks for a specific artist (e.g., "u-fullさんの曲を聴きたい", "Mr.Childrenが聴きたい"), that artist MUST be the absolute central focus.
  - At least 2 to 3 queries in the block MUST strictly target that artist with exact double quotes (e.g., artist:"u-full", "u-full").
  - Do NOT dilute or replace the requested artist with generic genre queries. The requested artist's tracks must dominate the session.
  - In priorityTrack, specify the exact artist with artist: prefix (e.g., artist:"u-full") so their original song plays first.
- **Priority Track**: If the user explicitly requests a specific song or artist, or if a block has an iconic starting track (e.g., "Crab" -> "渚にまつわるエトセトラ"), specify it in the priorityTrack field with a precise query (e.g., track:"Plastic Love" artist:"Mariya Takeuchi", or artist:"u-full").

# DJ Thought Rules
- Detect the language of the user's request. Write the thought field in that exact language.
- Speak in a friendly, sophisticated, and passionate radio-DJ tone. Explain the vibe of the selection and the flow of the transition.

# Output Format (MANDATORY)
You MUST return valid JSON (either a JSON array of blocks or a JSON object with a "schedule" array).
Each schedule block MUST contain:
- start: 24-hour time in "HH:mm" format (e.g., "14:00", "09:30"). Never use 12-hour or AM/PM.
- end: 24-hour time in "HH:mm" format (e.g., "18:00", "23:00"). Never use 12-hour or AM/PM.
- queries: array of 3 to 5 search strings for Spotify.
- anchorTracks: array of 2 to 3 iconic songs or artists representing the vibe.
- priorityTrack: optional exact track query (e.g. track:"Song" artist:"Artist").
- thought: radio DJ's intent and vibe description in the user's language.
`;

export class AIService {
    private openai?: OpenAI;
    private storedKey?: string; // API Key for REST usage
    private backend: AIProvider = 'gemini';
    private modelName: string = DEFAULT_MODELS.GEMINI;

    constructor(backend: AIProvider, apiKey: string, modelName?: string) {
        this.backend = backend;
        if (modelName) {
            this.modelName = modelName;
        } else if (backend === 'openai') {
            this.modelName = DEFAULT_MODELS.OPENAI;
        }

        if (backend === 'openai') {
            this.openai = new OpenAI({
                apiKey: apiKey,
                dangerouslyAllowBrowser: true // Client-side use
            });
        } else {
            // For REST API usage, store the key directly
            this.storedKey = apiKey;
        }
    }

    async generateSchedule(userRequest: string, currentSchedule?: ScheduleItem[], personalContext?: string): Promise<ScheduleItem[]> {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });
        const timeStr = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });

        const fullContextStr = `${year}-${month}-${day} (${weekday}) ${timeStr}`;
        let contextInfo = `Current Context: ${fullContextStr}\nUser Request: ${userRequest}`;

        if (personalContext && personalContext.trim().length > 0) {
            contextInfo += `\n\n# Preferences (Strict)\n${personalContext}`;
        }

        if (currentSchedule && currentSchedule.length > 0) {
            contextInfo += `\n\nExisting Schedule:\n${JSON.stringify(currentSchedule)}`;
            contextInfo += `\n\n# Task: Merge Request into Schedule
1. **Prioritize New Request**: Overwrite conflicting time slots.
2. **Keep Existing**: Retain non-conflicting slots.
3. **Split Slots**: If needed (e.g. 14:00-16:00 + req@15:00 -> 14-15 (old) & 15-16 (new)).
4. **Output**: Return COMPLETE updated schedule.`;
        }

        try {
            let responseText = '';

            if (this.backend === 'openai' && this.openai) {
                const completion = await this.openai.chat.completions.create({
                    messages: [
                        { role: "system", content: SYSTEM_PROMPT },
                        { role: "user", content: contextInfo }
                    ],
                    model: this.modelName,
                    response_format: { type: "json_object" }
                });
                responseText = completion.choices[0].message.content || '[]';

            } else if (this.backend === 'gemini') {
                // Direct REST API call with Structured Output config
                const apiKey = this.storedKey;
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}:generateContent?key=${apiKey}`;

                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        contents: [{
                            parts: [{
                                text: SYSTEM_PROMPT + "\n\n" + contextInfo
                            }]
                        }],
                        generationConfig: {
                            responseMimeType: "application/json",
                            responseSchema: {
                                type: "array",
                                description: "Timeline schedule of DJ sets.",
                                items: {
                                    type: "object",
                                    properties: {
                                        start: { type: "string" },
                                        end: { type: "string" },
                                        queries: {
                                            type: "array",
                                            items: { type: "string" }
                                        },
                                        anchorTracks: {
                                            type: "array",
                                            description: "2-3 iconic songs or artists that represent the vibe of this block.",
                                            items: { type: "string" }
                                        },
                                        priorityTrack: { type: "string" },
                                        thought: { type: "string" }
                                    },
                                    required: ["start", "end", "queries", "thought"]
                                }
                            }
                        }
                    })
                });

                if (!response.ok) {
                    const errText = await response.text();
                    throw new Error(`Gemini API Error: ${response.status} ${response.statusText} - ${errText} (Gemini APIエラーが発生しました)`);
                }

                const data = await response.json();
                responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            }

            console.log('AI Raw Output:', responseText);

            // Cleanup response (ensure it can be parsed cleanly)
            const cleanJson = responseText
                .replace(/```json/g, '')
                .replace(/```/g, '')
                .trim();

            let schedule;
            try {
                schedule = JSON.parse(cleanJson);
            } catch (parseError) {
                console.error('JSON Parse Failed. Input:', cleanJson);
                throw new Error(`Failed to parse AI response: ${parseError} (AIの応答の解析に失敗しました)`);
            }

            // Normalize
            let list: any[] = [];
            if (Array.isArray(schedule)) {
                list = schedule;
            } else if (typeof schedule === 'object' && schedule !== null) {
                const scheduleObj = schedule as Record<string, any>;
                const candidate = scheduleObj.schedule || scheduleObj.items || scheduleObj.list || scheduleObj.timeline || scheduleObj.blocks || Object.values(scheduleObj).find(v => Array.isArray(v));
                if (Array.isArray(candidate)) {
                    list = candidate;
                }
            }

            return list.map(item => ({
                ...item,
                start: normalizeTimeString(item.start || '00:00'),
                end: normalizeTimeString(item.end || '23:59'),
                queries: Array.isArray(item.queries) && item.queries.length > 0 ? item.queries : (item.query ? [item.query] : []),
                userRequest
            }));

        } catch (error) {
            console.error('AI Generation Error:', error);
            throw error;
        }
    }

    async filterTracksWithAI(userRequest: string, tracks: { name: string, artist: string, album?: string, id: string }[], thought?: string): Promise<TrackEvaluation[]> {
        if (tracks.length === 0) return [];

        // Limit candidates to 25 to prevent token exhaustion and ensure fast, robust response
        const candidatesToEval = tracks.slice(0, 25);
        const trackListStr = candidatesToEval.map((t, i) => `${i}: "${t.name}" by ${t.artist}${t.album ? ` (Album: "${t.album}")` : ''}`).join('\n');
        const prompt = `
# Role
You are an expert music curator, critic, and radio DJ assistant.

# Task
Evaluate if the following candidate tracks from Spotify match the User's Request and the DJ's Intent.
Use your internal musical knowledge and the provided track, artist, and **album names** to make an intelligent, discerning judgment for each track.

# Criteria for Evaluation
1. **Intelligent Quality & Context Verification (CRITICAL)**:
   - Carefully inspect the **track title, artist name, and album title**.
   - Discern between authentic artist releases vs generic production music, advertising/commercial BGM (e.g. "動画広告用音楽", "Music for advertising"), relaxation/sleep loops, sound effect tracks, or practice jam/backing tracks. Exclude or heavily penalize generic non-artist content unless explicitly requested.
   - Exclude "music box" (オルゴール), "karaoke" (カラオケ), and amateur instrumental cover versions of popular songs. We want the original artist's track.
   - Exclude low-quality live bootlegs, audiobooks, or podcasts.
2. **Artist Match (STRICT)**:
   - If the user explicitly mentions an artist, prioritize or strictly require them. Give their original tracks a 90-100 score and exclude cover versions by other artists.
3. **Musical Vibe, Style & Energy Alignment**:
   - Consider the genre, tempo, instrumentation, and emotional intensity. Ensure the track matches the mood described in the User Request and DJ Intent.

# Output Requirements
For each acceptable track (score >= 50):
- index: Track index from the list (integer).
- score: Integer between 0 and 100 representing fit (90-100: perfect iconic fit, 70-89: great fit, 50-69: acceptable vibe). Exclude tracks scoring below 50.
- vibeTag: A short Japanese hashtag describing the vibe (e.g. "#夕暮れチル", "#都会派グルーヴ", "#激情ロックバラード", "#深夜の静寂").
- selectionReason: A concise one-sentence reason in Japanese explaining why this song fits the context and how its sound/instrumentation aligns with the mood.
- estimatedBpm: Estimated tempo in BPM (integer, e.g. 84, 120).
- energy: An integer from 1 to 10 representing musical energy/intensity (1: very calm/ambient, 5: moderate groove, 10: high octane/peak energy).
- stage: The role of this track in a DJ set. Exactly one of: "intro" (opening mood), "build" (rising rhythm/energy), "peak" (climax/anthem), "outro" (smooth cooldown/closing).

# Input
- User Request: "${userRequest.replace(/"/g, "'")}"
${thought ? `- DJ Intent: "${thought.replace(/"/g, "'")}"` : ''}
- Found Tracks:
${trackListStr}
`;

        try {
            let responseText = '';
            if (this.backend === 'openai' && this.openai) {
                const completion = await this.openai.chat.completions.create({
                    messages: [
                        { role: "system", content: "You evaluate music candidates and output JSON containing an array of evaluated tracks with fields: index, score, vibeTag, selectionReason, estimatedBpm, energy, stage." },
                        { role: "user", content: prompt }
                    ],
                    model: this.modelName,
                    response_format: { type: "json_object" }
                });
                responseText = completion.choices[0].message.content || '[]';
            } else if (this.backend === 'gemini') {
                const apiKey = this.storedKey;
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}:generateContent?key=${apiKey}`;
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: {
                            responseMimeType: "application/json",
                            maxOutputTokens: 8192,
                            responseSchema: {
                                type: "array",
                                description: "Array of evaluated tracks matching the criteria.",
                                items: {
                                    type: "object",
                                    properties: {
                                        index: { type: "integer" },
                                        score: { type: "integer" },
                                        vibeTag: { type: "string" },
                                        selectionReason: { type: "string" },
                                        estimatedBpm: { type: "integer" },
                                        energy: { type: "integer", description: "1 to 10 intensity" },
                                        stage: { type: "string", enum: ["intro", "build", "peak", "outro"] }
                                    },
                                    required: ["index", "score", "vibeTag", "selectionReason"]
                                }
                            }
                        }
                    })
                });
                if (!response.ok) {
                    const errDetail = await response.text().catch(() => '');
                    console.error(`Gemini API Error: ${response.status}`, errDetail);
                    throw new Error(`Gemini API Error: ${response.status} ${errDetail}`);
                }
                const data = await response.json();
                responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
            }

            const cleanJson = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
            let parsed: any;
            try {
                parsed = JSON.parse(cleanJson);
            } catch (pe) {
                console.error('Failed to parse AI evaluation JSON:', pe, cleanJson);
                parsed = [];
            }

            let rawItems: any[] = [];
            if (Array.isArray(parsed)) {
                rawItems = parsed;
            } else if (parsed && typeof parsed === 'object') {
                rawItems = parsed.evaluations || parsed.tracks || parsed.matches || parsed.items || [];
            }

            const evaluations: TrackEvaluation[] = rawItems
                .filter(item => typeof item.index === 'number' && item.index >= 0 && item.index < candidatesToEval.length)
                .map(item => ({
                    id: candidatesToEval[item.index].id,
                    score: typeof item.score === 'number' ? item.score : 70,
                    vibeTag: item.vibeTag && item.vibeTag.startsWith('#') ? item.vibeTag : (item.vibeTag ? `#${item.vibeTag}` : '#注目トラック'),
                    selectionReason: item.selectionReason || 'ムードに合わせた選曲です。',
                    estimatedBpm: typeof item.estimatedBpm === 'number' ? item.estimatedBpm : undefined,
                    energy: typeof item.energy === 'number' ? Math.max(1, Math.min(10, item.energy)) : 5,
                    stage: ['intro', 'build', 'peak', 'outro'].includes(item.stage) ? item.stage : undefined
                }));

            return evaluations;
        } catch (error) {
            console.error('AI Filtering Error:', error);
            // Intelligent fallback when API fails
            const cleanReq = userRequest.replace(/[^\w\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g, '').slice(0, 10);
            const fallbackTag = cleanReq ? `#${cleanReq}` : '#名曲セレクト';
            const fallbackReason = thought ? `${thought}` : `${userRequest} の雰囲気に合わせたセレクトです。`;

            return tracks.map(t => ({
                id: t.id,
                score: 70,
                vibeTag: fallbackTag,
                selectionReason: fallbackReason
            }));
        }
    }

    async analyzeImage(base64Image: string, mimeType: string): Promise<string> {
        const VISION_PROMPT = `
Analyze the visual scene in this image and translate its mood into music curation concepts.
Instructions:
- Observe colors, light, textures, emotions, and overall atmosphere.
- Synthesize these visual elements into a future-looking, highly evocative Japanese sentence that describes the scene and directly suggests the appropriate musical texture (e.g., instrumentation, tempo, mood, genre).
- Example: "黄金色の柔らかな夕陽が差し込む静かな部屋。温かみのあるアコースティックギターと、BPM70程度のゆったりとしたローファイビーツが溶け合う穏やかな空間。"
- Output ONLY the sentence. Do not include headers, quotes, or preambles.
`;

        try {
            if (this.backend === 'openai' && this.openai) {
                // OpenAI Vision
                const response = await this.openai.chat.completions.create({
                    model: this.modelName || DEFAULT_MODELS.OPENAI,
                    messages: [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: VISION_PROMPT },
                                {
                                    type: "image_url",
                                    image_url: {
                                        "url": `data:${mimeType};base64,${base64Image}`,
                                    },
                                },
                            ],
                        },
                    ],
                });
                return response.choices[0].message.content || 'No description.';
            } else if (this.backend === 'gemini') {
                // Gemini Vision
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}:generateContent?key=${this.storedKey}`;
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{
                            parts: [
                                { text: VISION_PROMPT },
                                { inline_data: { mime_type: mimeType, data: base64Image } }
                            ]
                        }]
                    })
                });

                if (!response.ok) {
                    const err = await response.text();
                    throw new Error(`Gemini Vision Error: ${response.status} - ${err}`);
                }

                const data = await response.json();
                return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No description.';
            }
        } catch (e) {
            console.error('Vision Analysis Failed:', e);
            throw e;
        }
        return "AI backend not configured for Vision.";
    }
}
