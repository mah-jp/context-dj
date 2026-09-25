#!/usr/bin/env node
import './init-env';
import React from 'react';
import { render } from 'ink';
import { loadConfig, isConfigured, getConfigPath } from './config';
import { runInteractiveSetup } from './setup';
import { DJRunner } from './dj-runner';
import { App } from './ui/App';

async function main() {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        console.log(`
ContextDJ 🎧 - AI Music Curator (CUI)

Usage:
  npm run cli                             Launch interactive TUI dashboard (ideal for tmux)
  npm run cli -- "Music request..."       Launch TUI and immediately curate for request
  npm run cli -- setup                    Run initial Spotify & AI onboarding setup
  npm run cli -- --config                 Show configuration file path
  npm run cli -- --help                   Show this help message

Hotkeys inside TUI (when input is empty):
  [Space]     Play / Pause toggle
  [n]         Next track
  [p]         Previous track
  [q/Ctrl+C]  Quit
`);
        process.exit(0);
    }

    if (args.includes('--config')) {
        console.log(`Config path: ${getConfigPath()}`);
        process.exit(0);
    }

    // Force setup
    if (args[0] === 'setup') {
        await runInteractiveSetup();
        process.exit(0);
    }

    // Check configuration
    let config = loadConfig();
    if (!isConfigured(config)) {
        console.log('Configuration is incomplete or missing.');
        config = await runInteractiveSetup();
    }

    // Gather initial request prompt if any non-flag arguments are present
    const initialPrompt = args.filter(a => !a.startsWith('-')).join(' ').trim();

    // Redirect console logs to a debug log file during TUI mode to avoid breaking Ink rendering
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    try {
        const runner = await DJRunner.create(config || undefined);

        const fsModule = await import('node:fs');
        const pathModule = await import('node:path');
        const utilModule = await import('node:util');
        const { getConfigDir } = await import('./config');

        const logFile = pathModule.join(getConfigDir(), 'debug.log');

        const appendLog = (level: string, logArgs: unknown[]) => {
            const text = logArgs.map(a => (typeof a === 'string' ? a : utilModule.inspect(a))).join(' ');
            try {
                fsModule.appendFileSync(logFile, `[${new Date().toISOString()}] [${level}] ${text}\n`);
            } catch {}
        };

        console.log = (...logArgs: unknown[]) => {
            appendLog('INFO', logArgs);
        };
        console.warn = (...logArgs: unknown[]) => {
            appendLog('WARN', logArgs);
        };
        console.error = (...logArgs: unknown[]) => {
            appendLog('ERROR', logArgs);
        };

        const { waitUntilExit } = render(React.createElement(App, { runner, initialPrompt }));
        await waitUntilExit();
    } catch (e) {
        console.log = origLog;
        console.warn = origWarn;
        console.error = origError;
        console.error('\x1b[31mFatal error starting ContextDJ:\x1b[0m', e);
        process.exit(1);
    } finally {
        console.log = origLog;
        console.warn = origWarn;
        console.error = origError;
    }
}

main().catch((err) => {
    console.error('Unhandled CLI Error:', err);
    process.exit(1);
});
