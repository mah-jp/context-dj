import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AIProvider } from '../lib/types';
import { DEFAULT_MODELS } from '../lib/constants';

export interface CLIConfig {
    spotifyClientId?: string;
    spotifyClientSecret?: string;
    spotifyRefreshToken?: string;
    spotifyAccessToken?: string;
    spotifyExpiresAt?: number;
    aiProvider: AIProvider;
    aiApiKey: string;
    aiModel?: string;
    personalContext?: string;
    defaultDeviceId?: string;
}

export function getConfigDir(): string {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(configHome, 'context-dj');
}

export function getConfigPath(): string {
    if (process.env.CONTEXT_DJ_CONFIG) {
        return process.env.CONTEXT_DJ_CONFIG;
    }
    return path.join(getConfigDir(), 'config.json');
}

export function loadConfig(): CLIConfig | null {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) {
        return null;
    }

    try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<CLIConfig>;
        return {
            spotifyClientId: parsed.spotifyClientId,
            spotifyClientSecret: parsed.spotifyClientSecret,
            spotifyRefreshToken: parsed.spotifyRefreshToken,
            spotifyAccessToken: parsed.spotifyAccessToken,
            spotifyExpiresAt: parsed.spotifyExpiresAt,
            aiProvider: parsed.aiProvider || 'gemini',
            aiApiKey: parsed.aiApiKey || '',
            aiModel: parsed.aiModel || (parsed.aiProvider === 'openai' ? DEFAULT_MODELS.OPENAI : DEFAULT_MODELS.GEMINI),
            personalContext: parsed.personalContext,
            defaultDeviceId: parsed.defaultDeviceId
        };
    } catch (e) {
        console.error(`[Config] Failed to read config from ${configPath}:`, e);
        return null;
    }
}

export function saveConfig(updates: Partial<CLIConfig>): CLIConfig {
    const dir = getConfigDir();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const current = loadConfig() || {
        aiProvider: 'gemini',
        aiApiKey: '',
        aiModel: DEFAULT_MODELS.GEMINI
    };

    const nextConfig: CLIConfig = {
        ...current,
        ...updates
    };

    const configPath = getConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(nextConfig, null, 2), 'utf-8');
    return nextConfig;
}

export function isConfigured(config: CLIConfig | null): boolean {
    if (!config) return false;
    const hasSpotify = !!(config.spotifyClientId && config.spotifyRefreshToken);
    const hasAI = !!(config.aiApiKey && config.aiApiKey.trim().length > 0);
    return hasSpotify && hasAI;
}
