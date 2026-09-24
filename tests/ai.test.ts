import test, { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AIService } from '../src/lib/ai.ts';
import { DEFAULT_MODELS } from '../src/lib/constants.ts';
import { ScheduleItem } from '../src/lib/types.ts';

describe('AIService', () => {
    let originalFetch: any;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    describe('Initialization & Model selection', () => {
        it('uses DEFAULT_MODELS for Gemini when modelName is omitted', () => {
            const service = new AIService('gemini', 'fake_key');
            assert.strictEqual((service as any).modelName, DEFAULT_MODELS.GEMINI);
        });

        it('uses DEFAULT_MODELS for OpenAI when modelName is omitted', () => {
            const service = new AIService('openai', 'fake_key');
            assert.strictEqual((service as any).modelName, DEFAULT_MODELS.OPENAI);
        });

        it('respects explicitly provided custom modelName', () => {
            const service = new AIService('gemini', 'fake_key', 'gemini-custom-pro');
            assert.strictEqual((service as any).modelName, 'gemini-custom-pro');
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
            let requestBody: any = null;

            globalThis.fetch = async (url: any, options: any) => {
                requestedUrl = String(url);
                requestBody = JSON.parse(options.body);

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
                } as any;
            };

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

            globalThis.fetch = async () => ({
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [{ content: { parts: [{ text: JSON.stringify(mockWrapped) }] } }]
                })
            } as any);

            const service = new AIService('gemini', 'test_key');
            const result = await service.generateSchedule('study beats');
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].start, '20:00');
            assert.strictEqual(result[0].userRequest, 'study beats');
        });

        it('throws error when API response is not ok', async () => {
            globalThis.fetch = async () => ({
                ok: false,
                status: 403,
                statusText: 'Forbidden',
                text: async () => 'API key invalid'
            } as any);

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
            globalThis.fetch = async () => ({
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
            } as any);

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

            globalThis.fetch = async () => ({
                ok: false,
                status: 500,
                text: async () => 'Internal Server Error'
            } as any);

            const service = new AIService('gemini', 'test_key');
            const result = await service.filterTracksWithAI('some prompt', tracks);
            assert.deepStrictEqual(result.map(r => r.id), ['spotify:track:a', 'spotify:track:b']);
        });
    });

    describe('analyzeImage', () => {
        it('sends vision request and extracts Japanese description', async () => {
            const mockJapaneseDescription = '黄金色の柔らかな夕陽が差し込む静かな部屋。ゆったりとしたローファイビーツ。';

            globalThis.fetch = async (_url: any, options: any) => {
                const body = JSON.parse(options.body);
                assert.strictEqual(body.contents[0].parts[1].inline_data.mime_type, 'image/jpeg');
                assert.strictEqual(body.contents[0].parts[1].inline_data.data, 'base64data');

                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        candidates: [{ content: { parts: [{ text: mockJapaneseDescription }] } }]
                    })
                } as any;
            };

            const service = new AIService('gemini', 'test_key');
            const description = await service.analyzeImage('base64data', 'image/jpeg');
            assert.strictEqual(description, mockJapaneseDescription);
        });
    });
});
