import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Memo: (Deprecated)
// Web API Reference: References / Tracks / Get Recommendations | Spotify for Developers https://developer.spotify.com/documentation/web-api/reference/get-recommendations

// Prompt Template (Ported from prompt_template.txt)
const SYSTEM_PROMPT = `
# Role
You are an excellent DJ assistant. Analyze the user's natural language instructions and return a list of "Start Time (HH:MM)", "End Time (HH:MM)", "Spotify Search Queries", and a short "DJ Thought" in JSON format.
# Rules
1.**Create Schedule**:New schedule from instructions.
2.**Future Only**:If "future only", skip current time slot.
3.**JSON Only**:Raw JSON output only.
# Output Format
[{"start":"00:00","end":"14:00","queries":["chill instrumental","artist:Bill Evans","genre:jazz"],"thought":"Morning chill jazz."},{"start":"14:00","end":"23:59","queries":["upbeat dance","genre:house","artist:Daft Punk"],"thought":"Afternoon energy."}]
# Search Syntax
- \`genre:\`: "genre:jazz"
- \`year:\`: "year:1980-1989"
- \`artist:\`: "artist:Queen"
# Constraints
- **Time**: 24-hour (HH:MM).
- **Language**: English queries for Spotify.
- **Multiple Queries & Diversity**: Provide 3-5 specific queries. **Do NOT** repeat keywords. **DO** use knowledge to translate moods to specific artists/genres.
    - Ex: "Relaxing" -> ["relaxing piano", "artist:\"Brian Eno\"", "artist:\"Nujabes\" instrumental", "genre:jazz artist:\"Bill Evans\""]
- **Artist Specificity**: If specific artist requested, ALL queries must include it.
    - Correct: "artist:\"TM Network\" Get Wild"
    - Incorrect: "artist:TM Network Get Wild"
- **Cultural Context**: Prioritize culturally associated songs (e.g. memes/commercials).
    - Ex: "Music for eating crab" -> ["artist:PUFFY Nagisa ni Matsuwaru Etcetera"]
- **Query Strategy**: Specific song/artist associations first, then broader genre/mood. Mix "Safe Hits" and "Tasteful Selections".
- **DJ Thought**: explain choices in "thought". DJ persona. If User=JP, Thought=JP.
`;

export interface ScheduleItem {
    start: string;
    end: string;
    query: string;
    queries?: string[]; // Optional: support multiple queries
    thought?: string; // DJ's reasoning/comment
}

export class AIService {
    private openai?: OpenAI;
    private storedKey?: string; // API Key for REST usage
    private backend: 'openai' | 'gemini' = 'gemini';
    private modelName: string = 'gemini-2.5-flash';

    constructor(backend: 'openai' | 'gemini', apiKey: string, modelName?: string) {
        this.backend = backend;
        if (modelName) {
            this.modelName = modelName;
        } else if (backend === 'openai') {
            this.modelName = 'gpt-4o-mini';
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
        const timeStr = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
        const dateStr = now.toLocaleDateString('ja-JP', { weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' });

        let contextInfo = `Current Date: ${dateStr}\nCurrent Time: ${timeStr}\nUser Request: ${userRequest}`;

        if (personalContext && personalContext.trim().length > 0) {
            contextInfo += `\n\n# User Personal Preferences (HIGH PRIORITY)\nPerform the task while strictly adhering to the following user preferences:\n${personalContext}`;
        }

        if (currentSchedule && currentSchedule.length > 0) {
            contextInfo += `\n\nExisting Schedule:\n${JSON.stringify(currentSchedule)}`;
            contextInfo += `\n\nInstruction: Merge the new User Request into the Existing Schedule. 
            - If the new request conflicts with an existing time slot, prioritize the new request for that specific time range.
            - Keep existing slots that do not conflict.
            - If the new request is "from 15:00", split any existing slot spanning across 15:00 (e.g. 14:00-16:00 becomes 14:00-15:00 (old) and 15:00-16:00 (new)).
            - Return the COMPLETE updated schedule.`;
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
                return schedule;
            } else if (typeof schedule === 'object') {
                // Handle { schedule: [...] } or similar
                return schedule.schedule || schedule.items || schedule.list || [];
            }
            return [];

        } catch (error) {
            console.error('AI Generation Error:', error);
            throw error;
        }
    }
}
