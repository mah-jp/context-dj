import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RequestHistory, getHistoryPath } from '../src/cli/history';

describe('CLI RequestHistory', () => {
    it('initializes with empty history and handles navigation safely', () => {
        const history = new RequestHistory([]);
        assert.strictEqual(history.getPrevious('draft'), null);
        assert.strictEqual(history.getNext(), null);
    });

    it('navigates up and down through history items', () => {
        const history = new RequestHistory(['request 1', 'request 2', 'request 3']);

        // First UpArrow: should save draft and return newest item ('request 3')
        assert.strictEqual(history.getPrevious('my new query'), 'request 3');

        // Second UpArrow: should return 'request 2'
        assert.strictEqual(history.getPrevious('request 3'), 'request 2');

        // Third UpArrow: should return oldest item 'request 1'
        assert.strictEqual(history.getPrevious('request 2'), 'request 1');

        // Fourth UpArrow: already at top, remains 'request 1'
        assert.strictEqual(history.getPrevious('request 1'), 'request 1');

        // DownArrow: returns 'request 2'
        assert.strictEqual(history.getNext(), 'request 2');

        // DownArrow: returns 'request 3'
        assert.strictEqual(history.getNext(), 'request 3');

        // DownArrow: returns draft ('my new query')
        assert.strictEqual(history.getNext(), 'my new query');

        // DownArrow again: already at draft/bottom, returns null
        assert.strictEqual(history.getNext(), null);
    });

    it('adds new items, prevents consecutive duplicates, and respects maxItems limit', () => {
        const history = new RequestHistory(['A', 'B'], 3);

        // Add C -> ['A', 'B', 'C']
        history.add('C');
        assert.deepStrictEqual(history.getItems(), ['A', 'B', 'C']);

        // Consecutive duplicate should not be added
        history.add('C');
        assert.deepStrictEqual(history.getItems(), ['A', 'B', 'C']);

        // Add D -> ['B', 'C', 'D'] (since maxItems = 3)
        history.add('D');
        assert.deepStrictEqual(history.getItems(), ['B', 'C', 'D']);

        // Empty string should be ignored
        history.add('   ');
        assert.deepStrictEqual(history.getItems(), ['B', 'C', 'D']);
    });

    it('resets pointer after adding a new item', () => {
        const history = new RequestHistory(['first', 'second']);
        // Browse up
        history.getPrevious('draft'); // 'second'
        history.getPrevious('second'); // 'first'

        // Submit new item
        history.add('third');

        // Next UpArrow should return 'third'
        assert.strictEqual(history.getPrevious(''), 'third');
    });

    it('persists and reloads history via CONTEXT_DJ_HISTORY without touching real home config', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-dj-history-test-'));
        const customHistoryPath = path.join(tmpDir, 'nested', 'history.json');
        const prevEnv = process.env.CONTEXT_DJ_HISTORY;
        process.env.CONTEXT_DJ_HISTORY = customHistoryPath;

        try {
            assert.strictEqual(getHistoryPath(), customHistoryPath);

            // Loading when file does not exist yet returns empty history
            const loadedEmpty = RequestHistory.load(3);
            assert.deepStrictEqual(loadedEmpty.getItems(), []);

            // Adding items persists to customHistoryPath (creating parent directory automatically)
            loadedEmpty.add('morning jazz');
            loadedEmpty.add('evening ambient');
            assert.strictEqual(fs.existsSync(customHistoryPath), true);

            const reloaded = RequestHistory.load(3);
            assert.deepStrictEqual(reloaded.getItems(), ['morning jazz', 'evening ambient']);

            // In-memory constructor (filePath = null) does not overwrite disk file
            const inMemoryOnly = new RequestHistory(['ephemeral']);
            inMemoryOnly.add('ephemeral 2');
            assert.deepStrictEqual(
                JSON.parse(fs.readFileSync(customHistoryPath, 'utf-8')),
                ['morning jazz', 'evening ambient']
            );

            // Corrupted JSON file degrades gracefully to empty history
            fs.writeFileSync(customHistoryPath, '{broken json', 'utf-8');
            const recovered = RequestHistory.load(3);
            assert.deepStrictEqual(recovered.getItems(), []);
        } finally {
            if (prevEnv === undefined) {
                delete process.env.CONTEXT_DJ_HISTORY;
            } else {
                process.env.CONTEXT_DJ_HISTORY = prevEnv;
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
