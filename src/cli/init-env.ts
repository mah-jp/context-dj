import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

if (typeof window === 'undefined') {
    (globalThis as any).window = globalThis;
}

if (!(globalThis as any).localStorage) {
    const memory = new Map<string, string>();
    (globalThis as any).localStorage = {
        getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string) => memory.set(key, String(value)),
        removeItem: (key: string) => memory.delete(key),
        clear: () => memory.clear(),
        get length() { return memory.size; },
        key: (index: number) => Array.from(memory.keys())[index] ?? null,
    };
}

if (!(globalThis as any).XMLHttpRequest) {
    (globalThis as any).XMLHttpRequest = require('xhr2');
}

export {};
