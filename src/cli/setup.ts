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
    console.log('\n【 Step 2/3: AI Provider (BYOK) 】');
    console.log('Select your AI provider for music curation:');
    console.log('  1) Google Gemini (Recommended, Default)');
    console.log('  2) OpenAI (GPT-4o)');

    let providerChoice = await promptLine('Choose provider [1 or 2, default: 1]: ');
    if (providerChoice !== '2') {
        providerChoice = '1';
    }

    const aiProvider: AIProvider = providerChoice === '2' ? 'openai' : 'gemini';
    const defaultModel = aiProvider === 'openai' ? DEFAULT_MODELS.OPENAI : DEFAULT_MODELS.GEMINI;

    let apiKey = currentConfig?.aiApiKey;
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

    const finalConfig = saveConfig({
        spotifyClientId: clientId,
        aiProvider,
        aiApiKey: apiKey,
        aiModel: defaultModel,
        ...(personalContext ? { personalContext } : {})
    });

    console.log('\n' + '━'.repeat(64));
    console.log('\x1b[32m✔ Setup complete! Configuration saved.\x1b[0m');
    console.log('━'.repeat(64) + '\n');

    return finalConfig;
}
