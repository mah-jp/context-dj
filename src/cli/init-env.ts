import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const g = globalThis as Record<string, unknown>;

if (typeof window === 'undefined') {
    g.window = globalThis;
}

if (!g.localStorage) {
    const memory = new Map<string, string>();
    g.localStorage = {
        getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string) => memory.set(key, String(value)),
        removeItem: (key: string) => memory.delete(key),
        clear: () => memory.clear(),
        get length() { return memory.size; },
        key: (index: number) => Array.from(memory.keys())[index] ?? null,
    };
}

if (!g.XMLHttpRequest) {
    g.XMLHttpRequest = require('xhr2');
}

export {};
