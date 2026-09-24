import OpenAI from 'openai';
import { DEFAULT_MODELS } from './constants';
import { AIProvider, ScheduleItem, TrackEvaluation } from './types';

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
- **Priority Track**: If the user explicitly requests a specific song or artist, or if a block has an iconic starting track (e.g., "Crab" -> "渚にまつわるエトセトラ"), specify it in the priorityTrack field with a precise query (e.g., track:"Plastic Love" artist:"Mariya Takeuchi").

# DJ Thought Rules
- Detect the language of the user's request. Write the thought field in that exact language.
- Speak in a friendly, sophisticated, and passionate radio-DJ tone. Explain the vibe of the selection and the flow of the transition.
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
            if (Array.isArray(schedule)) {
                return schedule.map(item => ({ ...item, userRequest }));
            } else if (typeof schedule === 'object' && schedule !== null) {
                const scheduleObj = schedule as { schedule?: ScheduleItem[]; items?: ScheduleItem[]; list?: ScheduleItem[] };
                const list = scheduleObj.schedule || scheduleObj.items || scheduleObj.list || [];
                return list.map(item => ({ ...item, userRequest }));
            }
            return [];

        } catch (error) {
            console.error('AI Generation Error:', error);
            throw error;
        }
    }

    async filterTracksWithAI(userRequest: string, tracks: { name: string, artist: string, id: string }[], thought?: string): Promise<TrackEvaluation[]> {
        if (tracks.length === 0) return [];

        // Limit candidates to 25 to prevent token exhaustion and ensure fast, robust response
        const candidatesToEval = tracks.slice(0, 25);
        const trackListStr = candidatesToEval.map((t, i) => `${i}: ${t.name} - ${t.artist}`).join('\n');
        const prompt = `
# Role
You are an expert music critic and radio DJ assistant.

# Task
Evaluate if the following candidate tracks from Spotify match the User's Request and the DJ's Intent.
Since the official Spotify Audio Features API is unavailable, you must use your internal musical knowledge to judge each track.

# Criteria for Evaluation
1. **Negative Filtering (CRITICAL)**:
   - Exclude "music box" (オルゴール), "karaoke" (カラオケ), "instrumental cover" (カバー) of popular songs (unless explicitly requested). We want the original artist's track.
   - Exclude low-quality live recordings or audiobooks/podcasts that slipped into search results.
2. **Artist Match (STRICT)**:
   - If the user explicitly mentions an artist, prioritize or strictly require them. Give their original tracks 90-100 score and exclude cover versions by other artists.
3. **Estimated Audio Profile & Vibe Alignment**:
   - Estimate the BPM, Energy, and Mood of the track.
   - Ensure the track matches the tempo and vibe described in the DJ Intent (e.g., do not keep high-energy electronic music if the vibe is "calm piano jazz").

# Output Requirements
For each acceptable track (score >= 50):
- index: Track index from the list (integer).
- score: Integer between 0 and 100 representing fit (90-100: perfect iconic fit, 70-89: great fit, 50-69: acceptable vibe). Exclude tracks scoring below 50.
- vibeTag: A short Japanese hashtag describing the vibe (e.g. "#夕暮れチル", "#都会派グルーヴ", "#爽快アコースティック", "#深夜の静寂").
- selectionReason: A concise one-sentence reason in Japanese explaining why this song fits the context and how its sound/instrumentation aligns with the mood.
- estimatedBpm: Estimated tempo in BPM (integer, e.g. 84, 120).

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
                        { role: "system", content: "You evaluate music candidates and output JSON containing an array of evaluated tracks with fields: index, score, vibeTag, selectionReason, estimatedBpm." },
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
                                        estimatedBpm: { type: "integer" }
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
                    estimatedBpm: item.estimatedBpm
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
