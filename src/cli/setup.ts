import readline from 'node:readline';
import { loadConfig, saveConfig, CLIConfig } from './config';
import { runTerminalAuth } from './auth';
import { AIProvider } from '../lib/types';
import { DEFAULT_MODELS } from '../lib/constants';

function promptLine(promptText: string): Promise<string> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise((resolve) => {
        rl.question(promptText, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

export function resolveSetupAIConfig(
    currentConfig: CLIConfig | null,
    providerChoiceInput: string,
    personalContextInput: string
): {
    aiProvider: AIProvider;
    aiModel: string;
    personalContext?: string;
} {
    const defaultChoice = currentConfig?.aiProvider === 'openai' ? '2' : '1';
    const trimmedChoice = providerChoiceInput.trim() || defaultChoice;
    const aiProvider: AIProvider = trimmedChoice === '2' ? 'openai' : 'gemini';
    const defaultModel = aiProvider === 'openai' ? DEFAULT_MODELS.OPENAI : DEFAULT_MODELS.GEMINI;
    const preservedModel =
        currentConfig?.aiProvider === aiProvider && currentConfig?.aiModel?.trim()
            ? currentConfig.aiModel.trim()
            : defaultModel;
    const trimmedPersonal = personalContextInput.trim();
    const resolvedPersonal = trimmedPersonal || currentConfig?.personalContext;

    return {
        aiProvider,
        aiModel: preservedModel,
        ...(resolvedPersonal ? { personalContext: resolvedPersonal } : {}),
    };
}

export async function runInteractiveSetup(): Promise<CLIConfig> {
    console.log('\n' + '═'.repeat(64));
    console.log('   🎧 Welcome to ContextDJ - Initial Setup');
    console.log('═'.repeat(64));
    console.log('\nThis setup will configure Spotify and your AI provider (BYOK).\n');

    let currentConfig = loadConfig();

    // 1. Spotify Client ID & OAuth
    let clientId = currentConfig?.spotifyClientId;
    if (!clientId) {
        console.log('【 Step 1/3: Spotify Configuration 】');
        console.log('You need a Spotify Client ID from https://developer.spotify.com/dashboard');
        console.log('Important: Ensure "http://127.0.0.1:8888/callback" is added to your app\'s Redirect URIs.');
        while (!clientId) {
            clientId = await promptLine('Enter your Spotify Client ID: ');
            if (!clientId) console.log('Client ID cannot be empty.');
        }
    }

    if (!currentConfig?.spotifyRefreshToken) {
        currentConfig = await runTerminalAuth(clientId);
    }

    // 2. AI Provider Selection
    const defaultProviderChoice = currentConfig?.aiProvider === 'openai' ? '2' : '1';
    console.log('\n【 Step 2/3: AI Provider (BYOK) 】');
    console.log('Select your AI provider for music curation:');
    console.log(`  1) Google Gemini (Recommended, Default: ${DEFAULT_MODELS.GEMINI})`);
    console.log(`  2) OpenAI (Default: ${DEFAULT_MODELS.OPENAI})`);

    const providerChoice = await promptLine(`Choose provider [1 or 2, default: ${defaultProviderChoice}]: `);
    const preliminary = resolveSetupAIConfig(currentConfig, providerChoice, '');
    const aiProvider = preliminary.aiProvider;

    let apiKey = currentConfig?.aiProvider === aiProvider ? currentConfig?.aiApiKey : undefined;
    if (!apiKey) {
        const providerName = aiProvider === 'openai' ? 'OpenAI API Key' : 'Google Gemini API Key';
        while (!apiKey) {
            apiKey = await promptLine(`Enter your ${providerName}: `);
            if (!apiKey) console.log('API Key cannot be empty.');
        }
    }

    // 3. Optional Personal Preferences
    console.log('\n【 Step 3/3: Personal Context (Optional) 】');
    console.log('e.g. "I love 80s City Pop and Acoustic Jazz. Avoid aggressive EDM."');
    const personalContext = await promptLine('Your preferences (leave blank to skip): ');
    const resolvedAI = resolveSetupAIConfig(currentConfig, providerChoice, personalContext);

    const finalConfig = saveConfig({
        spotifyClientId: clientId,
        aiProvider: resolvedAI.aiProvider,
        aiApiKey: apiKey,
        aiModel: resolvedAI.aiModel,
        ...(resolvedAI.personalContext ? { personalContext: resolvedAI.personalContext } : {})
    });

    console.log('\n' + '━'.repeat(64));
    console.log('\x1b[32m✔ Setup complete! Configuration saved.\x1b[0m');
    console.log('━'.repeat(64) + '\n');

    return finalConfig;
}
