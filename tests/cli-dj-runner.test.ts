import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DJRunner } from '../src/cli/dj-runner';
import { CLIConfig, loadConfig } from '../src/cli/config';
import { Track } from '../src/lib/dj-core';

describe('CLI DJRunner', () => {
    const baseConfig: CLIConfig = {
        spotifyClientId: 'cid',
        spotifyRefreshToken: 'refresh_token',
        spotifyAccessToken: 'valid_token',
        spotifyExpiresAt: Date.now() + 3600_000,
        aiProvider: 'gemini',
        aiApiKey: 'ai_key',
    };

    beforeEach(() => {
        if (typeof globalThis.localStorage !== 'undefined') {
            globalThis.localStorage.clear();
        }
    });

    it('synchronizes DJCore state/logs and prepends external logs in newest-first order', async () => {
        const runner = new (DJRunner as unknown as { new(cfg: CLIConfig, token: string): DJRunner })(
            { ...baseConfig },
            'valid_token'
        );

        runner.addExternalLog('First external event');
        runner.addExternalLog('Second external event');

        const state = runner.getState();
        assert.strictEqual(state.logs.length, 2);
        assert.ok(state.logs[0].includes('Second external event'));
        assert.ok(state.logs[1].includes('First external event'));
    });

    it('selectDevice updates activeDevice to the selected device even when Spotify API still reports an old device as active', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-dj-runner-test-'));
        const tmpConfigPath = path.join(tmpDir, 'config.json');
        const prevEnv = process.env.CONTEXT_DJ_CONFIG;
        process.env.CONTEXT_DJ_CONFIG = tmpConfigPath;

        try {
            const runner = new (DJRunner as unknown as { new(cfg: CLIConfig, token: string): DJRunner })(
                { ...baseConfig },
                'valid_token'
            );
            const internal = runner as unknown as {
                djCore: {
                    setActiveDevice: (id: string) => Promise<void>;
                    getDevices: () => Promise<SpotifyApi.UserDevice[]>;
                };
                config: CLIConfig;
            };

            let transferredTo = '';
            internal.djCore.setActiveDevice = async (id: string) => {
                transferredTo = id;
            };
            internal.djCore.getDevices = async () => [
                { id: 'dev_old', name: 'Old Speaker', is_active: true } as SpotifyApi.UserDevice,
                { id: 'dev_new', name: 'Headphones', is_active: false } as SpotifyApi.UserDevice,
            ];

            await runner.selectDevice('dev_new');

            assert.strictEqual(transferredTo, 'dev_new');
            assert.strictEqual(internal.config.defaultDeviceId, 'dev_new');
            assert.strictEqual(runner.getState().activeDevice?.id, 'dev_new');
            assert.strictEqual(loadConfig()?.defaultDeviceId, 'dev_new');
        } finally {
            if (prevEnv === undefined) {
                delete process.env.CONTEXT_DJ_CONFIG;
            } else {
                process.env.CONTEXT_DJ_CONFIG = prevEnv;
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('pollPlayback respects convergence guard after transport controls', async () => {
        const runner = new (DJRunner as unknown as { new(cfg: CLIConfig, token: string): DJRunner })(baseConfig, 'valid_token');
        const trackA = {
            id: 'tA',
            uri: 'spotify:track:tA',
            name: 'Track A',
            type: 'track',
            artists: [{ name: 'Artist A' }],
        } as unknown as Track;
        const trackB = {
            id: 'tB',
            uri: 'spotify:track:tB',
            name: 'Track B',
            type: 'track',
            artists: [{ name: 'Artist B' }],
        } as unknown as Track;

        let apiTrack: Track = trackA;
        let pollCalls = 0;

        const internal = runner as unknown as {
            djCore: {
                getPlaybackState: () => Promise<SpotifyApi.CurrentPlaybackResponse | null>;
                next: () => Promise<{ ok: boolean }>;
            };
        };

        internal.djCore.getPlaybackState = async () => {
            pollCalls++;
            // Simulate Spotify transitioning to trackB on the second poll
            if (pollCalls >= 3) {
                apiTrack = trackB;
            }
            return {
                is_playing: true,
                item: apiTrack,
                progress_ms: 1000,
            } as unknown as SpotifyApi.CurrentPlaybackResponse;
        };
        internal.djCore.next = async () => ({ ok: true });

        // Initial poll sets currentTrack to Track A
        await runner.pollPlayback();
        assert.strictEqual(runner.getState().currentTrack?.uri, 'spotify:track:tA');

        // Calling next() polls until Track B arrives
        await runner.next();
        assert.strictEqual(runner.getState().currentTrack?.uri, 'spotify:track:tB');

        // Transient null playback response preserves currentTrack instead of wiping it
        internal.djCore.getPlaybackState = async () => null;
        await runner.pollPlayback();
        assert.strictEqual(runner.getState().currentTrack?.uri, 'spotify:track:tB');
    });
});
