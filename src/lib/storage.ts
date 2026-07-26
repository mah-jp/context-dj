/**
 * Type-safe and SSR-safe utility for interacting with browser localStorage.
 */

export function getStorageItem(key: string, fallback: string = ''): string {
    if (typeof window === 'undefined') return fallback;
    try {
        const value = localStorage.getItem(key);
        return value !== null ? value : fallback;
    } catch (e) {
        console.error(`[Storage] Failed to read key "${key}":`, e);
        return fallback;
    }
}

export function setStorageItem(key: string, value: string): void {
    if (typeof window === 'undefined') return;
    try {
        localStorage.setItem(key, value);
    } catch (e) {
        console.error(`[Storage] Failed to set key "${key}":`, e);
    }
}

export function removeStorageItem(key: string): void {
    if (typeof window === 'undefined') return;
    try {
        localStorage.removeItem(key);
    } catch (e) {
        console.error(`[Storage] Failed to remove key "${key}":`, e);
    }
}

export function getStoredJSON<T>(key: string, fallback: T): T {
    if (typeof window === 'undefined') return fallback;
    try {
        const item = localStorage.getItem(key);
        if (item === null) return fallback;
        return JSON.parse(item) as T;
    } catch (e) {
        console.error(`[Storage] Failed to parse JSON for key "${key}":`, e);
        return fallback;
    }
}

export function setStoredJSON<T>(key: string, value: T): void {
    if (typeof window === 'undefined') return;
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
        console.error(`[Storage] Failed to stringify JSON for key "${key}":`, e);
    }
}
