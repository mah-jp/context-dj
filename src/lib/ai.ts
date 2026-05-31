import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';

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
- **Query Density & Variety**: Provide 3 to 5 distinct, non-repetitive search queries per block. Do not repeat the same keywords within a block.
- **Priority Track**: If the user explicitly requests a specific song or artist, or if a block has an iconic starting track (e.g., "Crab" -> "渚にまつわるエトセトラ"), specify it in the priorityTrack field with a precise query (e.g., track:"Plastic Love" artist:"Mariya Takeuchi").

# DJ Thought Rules
- Detect the language of the user's request. Write the thought field in that exact language.
- Speak in a friendly, sophisticated, and passionate radio-DJ tone. Explain the vibe of the selection and the flow of the transition.
`;

export interface ScheduleItem {
    start: string;
    end: string;
    query: string;
    queries?: string[]; // Optional: support multiple queries
    priorityTrack?: string; // Optional: query for a specific song to play first
    thought?: string; // DJ's reasoning/comment
    userRequest?: string; // Original user instruction for context
}

export class AIService {
    private openai?: OpenAI;
    private storedKey?: string; // API Key for REST usage
    private backend: 'openai' | 'gemini' = 'gemini';
    private modelName: string = 'gemini-3.5-flash';

    constructor(backend: 'openai' | 'gemini', apiKey: string, modelName?: string) {
        this.backend = backend;
        if (modelName) {
            this.modelName = modelName;
        } else if (backend === 'openai') {
            this.modelName = 'gpt-5.4-mini';
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
            } else if (typeof schedule === 'object') {
                const list = schedule.schedule || schedule.items || schedule.list || [];
                return list.map((item: any) => ({ ...item, userRequest }));
            }
            return [];

        } catch (error) {
            console.error('AI Generation Error:', error);
            throw error;
        }
    }

    async filterTracksWithAI(userRequest: string, tracks: { name: string, artist: string, id: string }[], thought?: string): Promise<string[]> {
        if (tracks.length === 0) return [];

        const trackListStr = tracks.map((t, i) => `${i}: ${t.name} - ${t.artist}`).join('\n');
        const prompt = `
# Role
You are a music critic and expert DJ assistant.

# Task
Evaluate if the following candidate tracks from Spotify match the User's Request and the DJ's Intent.
Since the official Spotify Audio Features API is unavailable, you must use your internal knowledge of the songs to judge each track.

# Criteria for "GOOD FIT"
1. **Negative Filtering (CRITICAL)**:
   - Exclude "music box" (オルゴール), "karaoke" (カラオケ), "instrumental cover" (カバー) of popular songs (unless explicitly requested). We want the original artist's track.
   - Exclude low-quality live recordings or audiobooks/podcasts that slipped into search results.
2. **Artist Match (STRICT)**:
   - If the user explicitly mentions an artist, prioritize or strictly require them. Keep their tracks (80-100% of selection) and exclude cover versions by other artists.
3. **Estimated Audio Profile Alignment**:
   - Estimate the BPM, Energy (intensity), Valence (mood/brightness), and instrumentation of the tracks based on your internal knowledge.
   - Ensure the track matches the tempo and vibe described in the DJ Intent (e.g., do not keep high-energy electronic music if the vibe is "calm piano jazz").

# Input
- User Request: "${userRequest}"
${thought ? `- DJ Intent: "${thought}"` : ''}
- Found Tracks:
${trackListStr}
`;

        try {
            let responseText = '';
            if (this.backend === 'openai' && this.openai) {
                const completion = await this.openai.chat.completions.create({
                    messages: [{ role: "user", content: prompt }],
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
                            responseSchema: {
                                type: "array",
                                description: "Array of indices representing tracks that match the criteria.",
                                items: { type: "integer" }
                            }
                        }
                    })
                });
                if (!response.ok) throw new Error(`Gemini API Error: ${response.status}`);
                const data = await response.json();
                responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
            }

            const cleanJson = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
            const indices = JSON.parse(cleanJson);

            if (Array.isArray(indices)) {
                return indices
                    .filter(i => typeof i === 'number' && i >= 0 && i < tracks.length)
                    .map(i => tracks[i].id);
            }
            return tracks.map(t => t.id); // Fallback to all if failed
        } catch (error) {
            console.error('AI Filtering Error:', error);
            return tracks.map(t => t.id); // Fallback
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
                    model: (this.modelName.includes('gpt-4') || this.modelName.includes('gpt-5')) ? this.modelName : "gpt-5.4-mini",
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
