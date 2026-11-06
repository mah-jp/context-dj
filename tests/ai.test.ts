import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AIService } from '../src/lib/ai';
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

        it('respects explicitly provided custom modelName', () => {
            const service = new AIService('gemini', 'fake_key', 'gemini-custom-pro');
            assert.strictEqual(service.getModelName(), 'gemini-custom-pro');
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
    });
});
