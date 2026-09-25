import './init-env';
import { DJCore, Track } from '../lib/dj-core';
import { ScheduleItem } from '../lib/types';
import { CLIConfig, loadConfig, saveConfig } from './config';
import { getValidSpotifyToken } from './auth';

export interface DJRunnerState {
    status: string;
    playbackState: SpotifyApi.CurrentPlaybackResponse | null;
    currentTrack: Track | null;
    schedule: ScheduleItem[];
    currentThought: string | null;
    logs: string[];
    devices: SpotifyApi.UserDevice[];
    activeDevice: SpotifyApi.UserDevice | null;
}

export type StateListener = (state: DJRunnerState) => void;

export class DJRunner {
    private djCore: DJCore;
    private config: CLIConfig;
    private state: DJRunnerState;
    private listeners = new Set<StateListener>();
    private loopTimer: NodeJS.Timeout | null = null;
    private pollTimer: NodeJS.Timeout | null = null;
    private isProcessing = false;

    private constructor(config: CLIConfig, token: string) {
        this.config = config;
        this.djCore = new DJCore(token);
        this.djCore.initAI(config.aiProvider, config.aiApiKey, config.aiModel);

        this.state = {
            status: 'Initialized',
            playbackState: null,
            currentTrack: null,
            schedule: [],
            currentThought: null,
            logs: [],
            devices: [],
            activeDevice: null,
        };

        // Attach DJ status hook if supported
        this.djCore.setStatusCallback((status) => {
            this.updateState({ status });
        });
    }

    static async create(customConfig?: CLIConfig): Promise<DJRunner> {
        const config = customConfig || loadConfig();
        if (!config) {
            throw new Error('No configuration found. Please run context-dj setup first.');
        }

        const token = await getValidSpotifyToken(config);
        const runner = new DJRunner(config, token);
        await runner.refreshDevices();
        return runner;
    }

    subscribe(listener: StateListener): () => void {
        this.listeners.add(listener);
        listener(this.state);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private updateState(updates: Partial<DJRunnerState>) {
        this.state = { ...this.state, ...updates };
        this.listeners.forEach((listener) => {
            try {
                listener(this.state);
            } catch (e) {
                console.error('[DJRunner] Listener error:', e);
            }
        });
    }

    getState(): DJRunnerState {
        return this.state;
    }

    addExternalLog(message: string) {
        const timestamp = new Date().toLocaleTimeString();
        const formatted = `[${timestamp}] ${message}`;
        const newLogs = [...this.state.logs.slice(-30), formatted];
        this.updateState({ logs: newLogs });
    }

    async refreshDevices(): Promise<SpotifyApi.UserDevice[]> {
        try {
            const devices = await this.djCore.getDevices();
            const active = devices.find((d) => d.is_active) || devices[0] || null;
            if (active && active.id) {
                this.djCore.setActiveDevice(active.id);
            }
            this.updateState({ devices, activeDevice: active });
            return devices;
        } catch (e) {
            console.error('[DJRunner] Failed to fetch devices:', e);
            return [];
        }
    }

    async selectDevice(deviceId: string) {
        this.djCore.setActiveDevice(deviceId);
        saveConfig({ defaultDeviceId: deviceId });
        await this.refreshDevices();
    }

    async sendRequest(userPrompt: string): Promise<ScheduleItem[]> {
        if (this.isProcessing) {
            throw new Error('Already processing a music request. Please wait a moment.');
        }

        this.isProcessing = true;
        this.updateState({ status: 'Thinking & Curating Schedule... (AI選曲中...)' });

        try {
            await this.ensureFreshToken();
            const schedule = await this.djCore.createSchedule(userPrompt, this.config.personalContext);
            const djStatus = this.djCore.getDJStatus();

            this.updateState({
                schedule,
                currentThought: djStatus.currentThought,
                logs: this.djCore.getProcessLog(),
            });

            // Trigger immediate playback for newly calculated schedule
            this.updateState({ status: 'Searching tracks & starting playback... (再生準備中...)' });
            await this.djCore.processDJLoop(false, true);

            this.updateState({
                status: 'Playing',
                logs: this.djCore.getProcessLog(),
            });

            // Immediately poll playback
            await this.pollPlayback();

            return schedule;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.updateState({
                status: `Error: ${message}`,
                logs: this.djCore.getProcessLog(),
            });
            throw error;
        } finally {
            this.isProcessing = false;
        }
    }

    async pollPlayback() {
        try {
            const playback = await this.djCore.getPlaybackState();
            const track = (playback?.item as Track) || null;
            const djStatus = this.djCore.getDJStatus();

            this.updateState({
                playbackState: playback,
                currentTrack: track,
                currentThought: djStatus.currentThought || this.state.currentThought,
                logs: this.djCore.getProcessLog(),
            });
        } catch (e) {
            // Ignore minor transient poll errors
        }
    }

    startAutoLoop(loopIntervalMs = 30000, pollIntervalMs = 3000) {
        this.stopAutoLoop();

        // 1. Playback status poll (quick interval for progress & title)
        this.pollTimer = setInterval(async () => {
            await this.pollPlayback();
        }, pollIntervalMs);

        // 2. DJ Core check & auto-refill loop (checks schedule transition and empty queues)
        this.loopTimer = setInterval(async () => {
            if (this.isProcessing) return;
            try {
                await this.ensureFreshToken();
                await this.djCore.processDJLoop(true);
            } catch (e) {
                console.error('[DJRunner] Background loop error:', e);
            }
        }, loopIntervalMs);
    }

    stopAutoLoop() {
        if (this.loopTimer) {
            clearInterval(this.loopTimer);
            this.loopTimer = null;
        }
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    private async ensureFreshToken() {
        const freshToken = await getValidSpotifyToken(this.config);
        this.djCore.updateAccessToken(freshToken);
    }

    // Playback control delegates
    async pause() {
        await this.djCore.pause();
        await this.pollPlayback();
    }

    async resume() {
        await this.djCore.resume();
        await this.pollPlayback();
    }

    async togglePlay() {
        if (this.state.playbackState?.is_playing) {
            await this.pause();
        } else {
            await this.resume();
        }
    }

    async next() {
        await this.djCore.next();
        await new Promise((r) => setTimeout(r, 600));
        await this.pollPlayback();
    }

    async previous() {
        await this.djCore.previous();
        await new Promise((r) => setTimeout(r, 600));
        await this.pollPlayback();
    }
}
