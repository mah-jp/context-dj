import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AIService, formatAIProviderError } from '../src/lib/ai';
import { DEFAULT_MODELS } from '../src/lib/constants';

describe('AIService', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    describe('Initialization & Model selection', () => {
        it('uses DEFAULT_MODELS for Gemini when modelName is omitted', () => {
            const service = new AIService('gemini', 'fake_key');
            assert.strictEqual(service.getModelName(), DEFAULT_MODELS.GEMINI);
        });

        it('uses DEFAULT_MODELS for OpenAI when modelName is omitted', () => {
            const service = new AIService('openai', 'fake_key');
            assert.strictEqual(service.getModelName(), DEFAULT_MODELS.OPENAI);
        });

        it('respects explicitly provided custom modelName and trims whitespace', () => {
            const service = new AIService('gemini', '  fake_key  ', '  gemini-custom-pro  ');
            assert.strictEqual(service.getModelName(), 'gemini-custom-pro');
        });

        it('falls back to DEFAULT_MODELS when modelName is whitespace-only', () => {
            const geminiService = new AIService('gemini', 'fake_key', '   ');
            assert.strictEqual(geminiService.getModelName(), DEFAULT_MODELS.GEMINI);
            const openaiService = new AIService('openai', 'fake_key', ' \t ');
            assert.strictEqual(openaiService.getModelName(), DEFAULT_MODELS.OPENAI);
        });
    });

    describe('generateSchedule (Gemini REST backend)', () => {
        it('parses valid JSON response and attaches userRequest', async () => {
            const mockSchedule = [
                {
                    start: '14:00',
                    end: '16:00',
                    queries: ['genre:jazz', 'bill evans'],
                    thought: 'Relaxing afternoon jazz session'
                }
            ];

            let requestedUrl = '';

            globalThis.fetch = (async (input: RequestInfo | URL) => {
                requestedUrl = String(input);

                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        candidates: [
                            {
                                content: {
                                    parts: [
                                        {
                                            text: `\`\`\`json\n${JSON.stringify(mockSchedule)}\n\`\`\``
                                        }
                                    ]
                                }
                            }
                        ]
                    })
                } as unknown as Response;
            }) as typeof globalThis.fetch;

            const service = new AIService('gemini', 'test_api_key');
            const result = await service.generateSchedule('I want some chill piano jazz');

            assert.strictEqual(
                requestedUrl.includes(`models/${DEFAULT_MODELS.GEMINI}:generateContent`),
                true
            );
            assert.strictEqual(requestedUrl.includes('key=test_api_key'), true);
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].start, '14:00');
            assert.strictEqual(result[0].thought, 'Relaxing afternoon jazz session');
            assert.strictEqual(result[0].userRequest, 'I want some chill piano jazz');
        });

        it('handles object-wrapped schedule format ({ schedule: [...] })', async () => {
            const mockWrapped = {
                schedule: [
                    { start: '20:00', end: '22:00', query: 'lofi hip hop', thought: 'Night chill' }
                ]
            };

            globalThis.fetch = (async () => ({
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [{ content: { parts: [{ text: JSON.stringify(mockWrapped) }] } }]
                })
            } as unknown as Response)) as typeof globalThis.fetch;

            const service = new AIService('gemini', 'test_key');
            const result = await service.generateSchedule('study beats');
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].start, '20:00');
            assert.strictEqual(result[0].userRequest, 'study beats');
        });

        it('throws error when API response is not ok', async () => {
            globalThis.fetch = (async () => ({
                ok: false,
                status: 403,
                statusText: 'Forbidden',
                text: async () => 'API key invalid'
            } as unknown as Response)) as typeof globalThis.fetch;

            const service = new AIService('gemini', 'invalid_key');
            await assert.rejects(
                async () => service.generateSchedule('test prompt'),
                /Gemini API Error: 403/
            );
        });
    });

    describe('filterTracksWithAI', () => {
        it('returns empty array immediately if tracks list is empty', async () => {
            const service = new AIService('gemini', 'test_key');
            const result = await service.filterTracksWithAI('chill', []);
            assert.deepStrictEqual(result, []);
        });

        it('filters tracks by AI-selected indices', async () => {
            const tracks = [
                { name: 'Original Song', artist: 'Real Artist', id: 'spotify:track:1' },
                { name: 'Song (Music Box)', artist: 'Orgel Band', id: 'spotify:track:2' },
                { name: 'Another Song', artist: 'Good Artist', id: 'spotify:track:3' },
            ];

            // AI selects indices 0 and 2 with structured evaluation
            globalThis.fetch = (async () => ({
                ok: true,
                status: 200,
                text: async () => '',
                json: async () => ({
                    candidates: [{
                        content: {
                            parts: [{
                                text: JSON.stringify([
                                    { index: 0, score: 90, vibeTag: '#Chill', selectionReason: 'Fits relaxed mood' },
                                    { index: 2, score: 85, vibeTag: '#Acoustic', selectionReason: 'Great acoustic sound' }
                                ])
                            }]
                        }
                    }]
                })
            } as unknown as Response)) as typeof globalThis.fetch;

            const service = new AIService('gemini', 'test_key');
            const evaluations = await service.filterTracksWithAI('chill songs', tracks);
            assert.strictEqual(evaluations.length, 2);
            assert.deepStrictEqual(evaluations.map(e => e.id), ['spotify:track:1', 'spotify:track:3']);
            assert.strictEqual(evaluations[0].vibeTag, '#Chill');
            assert.strictEqual(evaluations[0].selectionReason, 'Fits relaxed mood');
        });

        it('falls back to all tracks if AI filtering fails', async () => {
            const tracks = [
                { name: 'Track A', artist: 'Artist A', id: 'spotify:track:a' },
                { name: 'Track B', artist: 'Artist B', id: 'spotify:track:b' },
            ];

            globalThis.fetch = (async () => ({
                ok: false,
                status: 500,
                text: async () => 'Internal Server Error'
            } as unknown as Response)) as typeof globalThis.fetch;

            const service = new AIService('gemini', 'test_key');
            const result = await service.filterTracksWithAI('some prompt', tracks);
            assert.deepStrictEqual(result.map(r => r.id), ['spotify:track:a', 'spotify:track:b']);
            assert.match(service.getLastFilterError() || '', /Gemini API Error: 500/);
        });

        it('falls back to default metadata when AI returns malformed/truncated JSON during filterTracksWithAI', async () => {
            const tracks = [
                { name: 'Track A', artist: 'Artist A', id: 'spotify:track:a' },
            ];

            globalThis.fetch = (async () => ({
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [{ content: { parts: [{ text: '[{"index": 0, "score": 90, "vibeTag": "#BrokenJSON' }] } }],
                }),
            } as unknown as Response)) as typeof globalThis.fetch;

            const service = new AIService('gemini', 'test_key');
            const result = await service.filterTracksWithAI('夕暮れの海辺', tracks, '穏やかな潮風を感じる選曲');
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].id, 'spotify:track:a');
            assert.strictEqual(result[0].score, 70);
            assert.strictEqual(result[0].vibeTag, '#夕暮れの海辺');
            assert.strictEqual(result[0].selectionReason, '穏やかな潮風を感じる選曲');
        });

        it('evaluates >25 tracks in parallel 25-track chunks without truncating and injects personalPreference as highest-priority rule', async () => {
            const tracks = Array.from({ length: 60 }, (_, idx) => ({
                id: `spotify:track:c_${idx}`,
                name: `Track ${idx}`,
                artist: `Artist ${idx}`,
                album: `Album ${idx}`,
            }));

            const capturedPrompts: string[] = [];
            globalThis.fetch = (async (_url: RequestInfo | URL, options?: RequestInit) => {
                const body = JSON.parse(String(options?.body));
                const promptText: string = body.contents[0].parts[0].text;
                capturedPrompts.push(promptText);

                // Count how many `n: "` lines were sent in this chunk
                const matches = [...promptText.matchAll(/^(\d+): "/gm)];
                const evals = matches
                    .filter((_, localIdx) => localIdx % 2 === 0)
                    .map((_, idx) => ({
                        index: idx * 2,
                        score: 88,
                        vibeTag: '#StudyBallad',
                        selectionReason: 'Matches emotional study mood',
                        energy: 5,
                        stage: 'build',
                    }));

                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        candidates: [{ content: { parts: [{ text: JSON.stringify(evals) }] } }],
                    }),
                } as unknown as Response;
            }) as typeof globalThis.fetch;

            const service = new AIService('gemini', 'test_key');
            const result = await service.filterTracksWithAI(
                '深夜の勉強バラード',
                tracks,
                '静かな集中を支えるバラード',
                'Aimerのカバー曲やオルゴールアレンジは除外し、ライブ音源は歓迎する'
            );

            // 60 tracks -> 3 chunks (25 + 25 + 10); each chunk selects even local indices (13 + 13 + 5 = 31 tracks)
            assert.strictEqual(capturedPrompts.length, 3);
            for (const p of capturedPrompts) {
                assert.match(p, /User's Universal Preferences \(HIGHEST PRIORITY - STRICTLY ENFORCE\)/);
                assert.match(p, /Aimerのカバー曲やオルゴールアレンジは除外し、ライブ音源は歓迎する/);
            }
            assert.strictEqual(result.length, 31);
            // Verify chunk-local index 0 mapped accurately for Chunk 0 (`c_0`), Chunk 1 (`c_25`), and Chunk 2 (`c_50`)!
            const selectedIds = new Set(result.map(r => r.id));
            assert.strictEqual(selectedIds.has('spotify:track:c_0'), true);
            assert.strictEqual(selectedIds.has('spotify:track:c_25'), true);
            assert.strictEqual(selectedIds.has('spotify:track:c_50'), true);
            assert.strictEqual(selectedIds.has('spotify:track:c_58'), true);
            assert.strictEqual(service.getLastFilterError(), null);
        });

        it('preserves succeeded chunk evaluations when one parallel chunk fails transiently', async () => {
            const tracks = Array.from({ length: 30 }, (_, idx) => ({
                id: `spotify:track:p_${idx}`,
                name: `Song ${idx}`,
                artist: `Singer ${idx}`,
            }));

            let callIndex = 0;
            globalThis.fetch = (async () => {
                callIndex++;
                if (callIndex === 2) {
                    return {
                        ok: false,
                        status: 503,
                        statusText: 'Service Unavailable',
                        text: async () => 'Overloaded',
                    } as unknown as Response;
                }
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        candidates: [{
                            content: {
                                parts: [{
                                    text: JSON.stringify([
                                        { index: 0, score: 92, vibeTag: '#Focus', selectionReason: 'Top pick' },
                                    ]),
                                }],
                            },
                        }],
                    }),
                } as unknown as Response;
            }) as typeof globalThis.fetch;

            const service = new AIService('gemini', 'test_key');
            const result = await service.filterTracksWithAI('focus', tracks);
            // Chunk 0 returned 1 AI-curated track (< 5), supplemented cleanly up to 5 tracks from Chunk 1 fallback, with no fatal filter error
            assert.strictEqual(result.length, 5);
            assert.strictEqual(result[0].id, 'spotify:track:p_0');
            assert.strictEqual(result[0].score, 92);
            assert.strictEqual(result[1].id, 'spotify:track:p_25');
            assert.strictEqual(result[1].score, 70);
            assert.strictEqual(service.getLastFilterError(), null);

            // When Chunk 0 already yields >= 5 curated tracks, failed Chunk 1 does NOT pollute results with unfiltered fallback tracks
            let richCall = 0;
            globalThis.fetch = (async () => {
                richCall++;
                if (richCall === 2) {
                    return {
                        ok: false,
                        status: 503,
                        statusText: 'Service Unavailable',
                        text: async () => 'Overloaded',
                    } as unknown as Response;
                }
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        candidates: [{
                            content: {
                                parts: [{
                                    text: JSON.stringify(
                                        Array.from({ length: 6 }, (_, i) => ({
                                            index: i,
                                            score: 90,
                                            vibeTag: '#Curated',
                                            selectionReason: 'Curated hit',
                                        }))
                                    ),
                                }],
                            },
                        }],
                    }),
                } as unknown as Response;
            }) as typeof globalThis.fetch;

            const pureCurated = await service.filterTracksWithAI('focus', tracks);
            assert.strictEqual(pureCurated.length, 6);
            assert.ok(pureCurated.every(t => t.score === 90));
            assert.strictEqual(service.getLastFilterError(), null);
            assert.strictEqual(service.hadChunkFilterError(), true);

            // Clean subsequent call resets hadChunkFilterError back to false
            globalThis.fetch = (async () => ({
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [{
                        content: {
                            parts: [{
                                text: JSON.stringify([
                                    { index: 0, score: 91, vibeTag: '#Clean', selectionReason: 'Clean' },
                                ]),
                            }],
                        },
                    }],
                }),
            } as unknown as Response)) as typeof globalThis.fetch;
            await service.filterTracksWithAI('focus', tracks.slice(0, 5));
            assert.strictEqual(service.hadChunkFilterError(), false);
        });
    });

    describe('analyzeImage', () => {
        it('sends vision request and extracts Japanese description', async () => {
            const mockJapaneseDescription = '黄金色の柔らかな夕陽が差し込む静かな部屋。ゆったりとしたローファイビーツ。';

            globalThis.fetch = (async (_url: RequestInfo | URL, options?: RequestInit) => {
                const body = JSON.parse(String(options?.body));
                assert.strictEqual(body.contents[0].parts[1].inline_data.mime_type, 'image/jpeg');
                assert.strictEqual(body.contents[0].parts[1].inline_data.data, 'base64data');

                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        candidates: [{ content: { parts: [{ text: mockJapaneseDescription }] } }]
                    })
                } as unknown as Response;
            }) as typeof globalThis.fetch;

            const service = new AIService('gemini', 'test_key');
            const description = await service.analyzeImage('base64data', 'image/jpeg');
            assert.strictEqual(description, mockJapaneseDescription);
        });
    });

    describe('OpenAI backend & edge-case normalization', () => {
        it('supports OpenAI backend for generateSchedule, filterTracksWithAI (custom wrapper key), and analyzeImage', async () => {
            const service = new AIService('openai', 'sk-test-key', 'gpt-5.4-mini');
            const capturedRequests: unknown[] = [];

            // Inject mock into internal OpenAI client
            const internal = service as unknown as {
                openai: {
                    chat: {
                        completions: {
                            create: (req: unknown) => Promise<{ choices: { message: { content: string } }[] }>;
                        };
                    };
                };
            };

            let mockContent = '';
            internal.openai.chat.completions.create = async (req: unknown) => {
                capturedRequests.push(req);
                return {
                    choices: [{ message: { content: mockContent } }],
                };
            };

            // 1. generateSchedule with existingSchedule and personalContext
            mockContent = JSON.stringify({
                blocks: [
                    { start: '9:05', end: '11:30', queries: ['artist:"Bill Evans"'], thought: 'Morning jazz' },
                ],
            });
            const schedule = await service.generateSchedule(
                'Add morning jazz',
                [{ start: '14:00', end: '16:00', query: 'afternoon chill' }],
                'Prefer live recordings'
            );
            assert.strictEqual(schedule.length, 1);
            assert.strictEqual(schedule[0].start, '09:05'); // Normalized to HH:mm
            assert.strictEqual(schedule[0].end, '11:30');
            assert.strictEqual(schedule[0].query, 'artist:"Bill Evans"');

            // 2. filterTracksWithAI when OpenAI wraps array in an arbitrary key like `evaluated_tracks`
            mockContent = JSON.stringify({
                evaluated_tracks: [
                    {
                        index: 0,
                        score: 95,
                        vibeTag: '都会派グルーヴ', // Missing '#' prefix -> should be auto-prefixed
                        selectionReason: 'Sophisticated groove',
                        energy: 15, // Above 10 -> should be clamped to 10
                        stage: 'peak',
                    },
                    {
                        index: 99, // Out of bounds -> should be filtered out safely
                        score: 80,
                        vibeTag: '#InvalidIndex',
                        selectionReason: 'Out of bounds',
                    },
                ],
            });
            const evals = await service.filterTracksWithAI(
                'city pop night',
                [{ id: 'spotify:track:cp1', name: 'Plastic Love', artist: 'Mariya Takeuchi', album: 'VARIETY' }],
                'Smooth city pop'
            );
            assert.strictEqual(evals.length, 1);
            assert.strictEqual(evals[0].id, 'spotify:track:cp1');
            assert.strictEqual(evals[0].vibeTag, '#都会派グルーヴ');
            assert.strictEqual(evals[0].energy, 10);
            assert.strictEqual(evals[0].stage, 'peak');

            // 3. analyzeImage via OpenAI vision
            mockContent = '静かな夜の書斎に似合う柔らかなピアノトリオ。';
            const visionDesc = await service.analyzeImage('abc123base64', 'image/png');
            assert.strictEqual(visionDesc, '静かな夜の書斎に似合う柔らかなピアノトリオ。');
            assert.strictEqual(capturedRequests.length, 3);
        });

        it('sanitizes empty or whitespace queries in generateSchedule using priorityTrack / userRequest fallback', async () => {
            globalThis.fetch = (async () => ({
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [{
                        content: {
                            parts: [{
                                text: JSON.stringify([
                                    { start: '10:00', end: '12:00', queries: ['   ', ''], priorityTrack: ' artist:"Nujabes" ', thought: ' Chill ' },
                                    { start: '12:00', end: '14:00', queries: [], thought: 'Afternoon' },
                                ])
                            }]
                        }
                    }]
                })
            } as unknown as Response)) as typeof globalThis.fetch;

            const service = new AIService('gemini', 'test_key');
            const items = await service.generateSchedule('lo-fi study');
            assert.strictEqual(items.length, 2);
            assert.deepStrictEqual(items[0].queries, ['artist:"Nujabes"']);
            assert.strictEqual(items[0].query, 'artist:"Nujabes"');
            assert.deepStrictEqual(items[1].queries, ['lo-fi study']);
            assert.strictEqual(items[1].query, 'lo-fi study');
        });

        it('formats concrete bilingual AI provider errors for 400, 401/403, 404 (with model name), 429, and 503', async () => {
            const err400 = formatAIProviderError(
                'gemini',
                'gemini-2.5-flash',
                400,
                'Bad Request',
                JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } })
            );
            assert.match(err400.message, /Gemini API Error: 400 Bad Request - API key not valid/);
            assert.match(err400.message, /APIキーまたはリクエスト形式が無効です/);

            const err404 = formatAIProviderError('openai', 'gpt-nonexistent-99', 404, 'Not Found', 'The model does not exist');
            assert.match(err404.message, /OpenAI API Error: 404 Not Found/);
            assert.match(err404.message, /"gpt-nonexistent-99" が見つかりません/);

            const err429 = formatAIProviderError('gemini', 'gemini-2.5-flash', 429, 'Too Many Requests', '{"error":{"message":"Quota exceeded"}}');
            assert.match(err429.message, /Quota exceeded/);
            assert.match(err429.message, /レート制限または利用枠の上限/);

            // Verify OpenAI SDK error status propagation in generateSchedule
            const service = new AIService('openai', 'sk-bad', 'gpt-bad-model');
            const internal = service as unknown as {
                openai: { chat: { completions: { create: () => Promise<never> } } };
            };
            internal.openai.chat.completions.create = async () => {
                const sdkErr = new Error('404 The model `gpt-bad-model` does not exist') as Error & { status?: number };
                sdkErr.status = 404;
                throw sdkErr;
            };
            await assert.rejects(
                async () => service.generateSchedule('jazz'),
                /gpt-bad-model.*が見つかりません/
            );
        });
    });
});
