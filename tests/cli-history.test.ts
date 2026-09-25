import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RequestHistory } from '../src/cli/history';

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
});
