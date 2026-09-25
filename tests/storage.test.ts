import test, { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    getStorageItem,
    setStorageItem,
    removeStorageItem,
    getStoredJSON,
    setStoredJSON,
} from '../src/lib/storage';

describe('storage', () => {
    // Mock localStorage for Node.js environment
    const storageMock = (() => {
        let store: Record<string, string> = {};
        return {
            getItem: (key: string) => store[key] ?? null,
            setItem: (key: string, value: string) => {
                store[key] = String(value);
            },
            removeItem: (key: string) => {
                delete store[key];
            },
            clear: () => {
                store = {};
            },
        };
    })();

    beforeEach(() => {
        storageMock.clear();
        (globalThis as any).window = { localStorage: storageMock };
        (globalThis as any).localStorage = storageMock;
    });

    describe('getStorageItem & setStorageItem', () => {
        it('returns fallback when item is not set', () => {
            assert.strictEqual(getStorageItem('non_existent', 'default_val'), 'default_val');
        });

        it('saves and retrieves items correctly', () => {
            setStorageItem('test_key', 'hello_world');
            assert.strictEqual(getStorageItem('test_key'), 'hello_world');
        });

        it('removes stored items', () => {
            setStorageItem('test_key', 'hello_world');
            removeStorageItem('test_key');
            assert.strictEqual(getStorageItem('test_key', 'fallback'), 'fallback');
        });
    });

    describe('getStoredJSON & setStoredJSON', () => {
        it('returns fallback when key does not exist', () => {
            const fallback = { a: 1 };
            assert.deepStrictEqual(getStoredJSON('json_key', fallback), fallback);
        });

        it('stores and parses JSON objects and arrays correctly', () => {
            const data = [{ id: 1, name: 'Item 1' }, { id: 2, name: 'Item 2' }];
            setStoredJSON('json_list', data);
            assert.deepStrictEqual(getStoredJSON('json_list', []), data);
        });

        it('handles corrupted JSON gracefully by returning fallback', () => {
            setStorageItem('corrupted_json', '{ bad json ...');
            assert.deepStrictEqual(getStoredJSON('corrupted_json', { safe: true }), { safe: true });
        });
    });
});
