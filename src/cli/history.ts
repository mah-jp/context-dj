import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from './config';

export function getHistoryPath(): string {
    if (process.env.CONTEXT_DJ_HISTORY) {
        return process.env.CONTEXT_DJ_HISTORY;
    }
    return path.join(getConfigDir(), 'history.json');
}

export class RequestHistory {
    private history: string[] = [];
    private pointer: number = 0;
    private draft: string = '';
    private maxItems: number;
    private filePath: string | null;

    constructor(initialHistory: string[] = [], maxItems = 100, filePath: string | null = null) {
        this.maxItems = maxItems;
        this.filePath = filePath;
        this.history = initialHistory.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
        if (this.history.length > this.maxItems) {
            this.history = this.history.slice(-this.maxItems);
        }
        this.pointer = this.history.length;
    }

    static load(maxItems = 100, filePath: string = getHistoryPath()): RequestHistory {
        try {
            if (fs.existsSync(filePath)) {
                const raw = fs.readFileSync(filePath, 'utf-8');
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    return new RequestHistory(parsed, maxItems, filePath);
                }
            }
        } catch {
            // Ignore load errors and start with clean history
        }
        return new RequestHistory([], maxItems, filePath);
    }

    save(): void {
        if (!this.filePath) return;
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.filePath, JSON.stringify(this.history, null, 2), 'utf-8');
        } catch {
            // Best-effort write
        }
    }

    add(entry: string): void {
        const trimmed = entry.trim();
        if (!trimmed) return;

        // Avoid adding duplicate if identical to the latest entry
        if (this.history.length > 0 && this.history[this.history.length - 1] === trimmed) {
            this.reset();
            return;
        }

        this.history.push(trimmed);
        if (this.history.length > this.maxItems) {
            this.history = this.history.slice(-this.maxItems);
        }
        this.reset();
        this.save();
    }

    reset(): void {
        this.pointer = this.history.length;
        this.draft = '';
    }

    getPrevious(currentInput: string): string | null {
        if (this.history.length === 0) return null;

        // If currently at the bottom (newest entry / draft), save current input as draft
        if (this.pointer === this.history.length) {
            this.draft = currentInput;
        }

        if (this.pointer > 0) {
            this.pointer--;
            return this.history[this.pointer];
        }

        // Already at the oldest item
        return this.history[0];
    }

    getNext(): string | null {
        if (this.history.length === 0) return null;

        if (this.pointer < this.history.length - 1) {
            this.pointer++;
            return this.history[this.pointer];
        }

        if (this.pointer === this.history.length - 1) {
            this.pointer = this.history.length;
            return this.draft; // Restore draft
        }

        // Already at draft/bottom
        return null;
    }

    getItems(): string[] {
        return [...this.history];
    }
}
