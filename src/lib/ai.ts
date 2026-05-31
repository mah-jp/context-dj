import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Memo: (Deprecated)
// Web API Reference: References / Tracks / Get Recommendations | Spotify for Developers https://developer.spotify.com/documentation/web-api/reference/get-recommendations

// Prompt Template
const SYSTEM_PROMPT = `
# Role
You are an excellent DJ assistant. Analyze the user's natural language instructions and return a list of "Start Time (HH:MM)", "End Time (HH:MM)", "Spotify Search Queries", and a short "DJ Thought" in JSON format.
# Rules
1.**Immediate Response**: If the user's request is a general mood or activity (e.g., "I want to eat crab", "Chill time"), **ACT IMMEDIATELY**. The first item in the schedule **MUST** start from the "Current Time" provided in the context. Do NOT wait for a "typical" time (like 12:00 for lunch) unless explicitly requested.
2.**Create Schedule**: New schedule from instructions. Overwrite/merge logic applies.
3.**Future Only**: If the user explicitly says "future only" or "tonight", you may skip the current time.
4.**JSON Only**: Raw JSON output only.
# Output Format
[{"start":"HH:MM (Current or Requested)","end":"HH:MM","queries":["query1","query2"],"priorityTrack":"optional","thought":"DJ comment"}]
# Search Syntax
- \`genre:\`: "genre:jazz"
- \`year:\`: "year:1980-1989"
- \`artist:\`: "artist:Queen"
# Constraints
- **Time**: 24-hour (HH:MM). **CRITICAL**: The first block should almost always start at the current time to start music now.
- **Language**: 
    - **Search Queries**: **HYBRID STRATEGY**.
      - **Generic Terms (Genre/Mood/Vibes)**: ALWAYS include **English** keywords.
      - **Specific Artists/Songs**: Use their **Native Language**.
      - **Mix**: Provide a mix of both.
    - **DJ Thought**: **DETECT** the language used in the "User Request". The \`thought\` field **MUST** be written in that same language.
- **Multiple Queries & Diversity**: Provide 3-5 specific queries. Do NOT repeat keywords.
- **Priority Track**: If a specific song or iconic association exists (e.g. "Crab" -> "渚にまつわるエトセトラ"), set "priorityTrack".
- **Query Strategy**: Specific song/artist associations first, then broader genre/mood.
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
                    model: this.modelName, // Cost effective
                });
                responseText = completion.choices[0].message.content || '[]';

            } else if (this.backend === 'gemini') {
                // Direct REST API call to debug/bypass SDK issues
                const apiKey = this.storedKey;

                // 2. Generate Content
                // Use Flash model to avoid 429 Rate Limits on free tier (Pro quota is strict)
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
                        }]
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

            // Cleanup response (remove markdown if present)
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
Evaluate if the following songs match the User's Request and the DJ's Intent by estimating their audio characteristics.
Since the official Audio Features API is unavailable, you must use your internal knowledge to judge each track.

# Criteria for "GOOD FIT"
1. **Artist Match (STRICT)**: If the user explicitly mentions an artist, prioritize or strictly require them. Do NOT replace them with similar artists unless the request is broad.
2. **Genre & Style**: Does it belong to the requested genre?
3. **Estimated BPM & Energy**: Does the tempo and intensity match?
4. **Vibe Match**: Overall, would a professional DJ play this song in this context?

# Input
- User Request: "${userRequest}"
${thought ? `- DJ Intent: "${thought}"` : ''}
- Found Tracks:
${trackListStr}

# Output Format
Return ONLY a JSON array of indices (numbers) for songs that are a "GOOD FIT".
Crucial: If a specific artist was requested, 80-100% of your selection should ideally be from that artist.
Example: [1, 4, 7]
`;

        try {
            let responseText = '';
            if (this.backend === 'openai' && this.openai) {
                const completion = await this.openai.chat.completions.create({
                    messages: [{ role: "user", content: prompt }],
                    model: this.modelName,
                });
                responseText = completion.choices[0].message.content || '[]';
            } else if (this.backend === 'gemini') {
                const apiKey = this.storedKey;
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}:generateContent?key=${apiKey}`;
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }]
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
Analyze this image for music curation. 
Instructions:
- Describe the scene realistically, artistically, and musically.
- OUTPUT ONLY a single, evocative sentence in Japanese.
- DO NOT include headers (e.g., "1.", "Realism:"), preambles, or any other text.
- Example: "海辺の夕暮れ、暖かなオレンジの光に包まれた静かなジャズが流れるカフェの雰囲気。"
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
