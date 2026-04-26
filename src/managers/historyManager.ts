import * as vscode from 'vscode';

/** workspaceState key for history events (broadcasted posts + session events). Isolated per workspace. */
const WORKSPACE_STATE_KEY = 'devghost.history';

/**
 * History event types for logging.
 */
export type HistoryEventType =
    | 'SESSION_START'
    | 'SESSION_END'
    | 'COMMIT'
    | 'STRUGGLE_DETECTED'
    | 'WIN'
    | 'FOCUS_SET'
    | 'FOCUS_SHIFT'
    | 'POST_DRAFTED';

/**
 * A single history event entry.
 */
export interface HistoryEvent {
    type: HistoryEventType;
    timestamp: string;
    data?: {
        message?: string;
        command?: string;
        duration?: number;
        count?: number;
        focus?: string;
        from?: string;
        to?: string;
    };
}

/**
 * HistoryManager - The "Black Box" Recorder
 *
 * Phase 7: Persistent Memory via workspaceState (no local files).
 *
 * Features:
 * - Events stored in VS Code workspaceState (isolated per workspace)
 * - Warm-up: Detects when you return after a long absence
 * - History: Stores your coding journey for AI context
 */
export class HistoryManager implements vscode.Disposable {
    private outputChannel: vscode.OutputChannel;
    private workspaceState: vscode.Memento;
    private initialized: boolean = false;

    private readonly WARMUP_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours

    private onWarmupCallback: ((summary: string, lastEvents: HistoryEvent[]) => void) | null = null;
    private events: HistoryEvent[] = [];

    constructor(workspaceState: vscode.Memento, outputChannel: vscode.OutputChannel) {
        this.workspaceState = workspaceState;
        this.outputChannel = outputChannel;
    }

    /**
     * Initialize the HistoryManager from workspaceState.
     */
    async initialize(): Promise<boolean> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

        if (!workspaceFolder) {
            this.outputChannel.appendLine('[DevGhost] No workspace folder. History disabled.');
            return false;
        }

        try {
            const raw = this.workspaceState.get<HistoryEvent[]>(WORKSPACE_STATE_KEY);
            this.events = Array.isArray(raw) ? [...raw] : [];

            await this.checkWarmup();

            this.logEvent('SESSION_START');

            this.initialized = true;
            this.outputChannel.appendLine('[DevGhost] ✓ History manager initialized');
            return true;
        } catch (error) {
            this.outputChannel.appendLine(`[DevGhost] History init error: ${error}`);
            return false;
        }
    }

    /**
     * Persist events array to workspaceState.
     */
    private async setEventsArray(events: HistoryEvent[]): Promise<void> {
        await this.workspaceState.update(WORKSPACE_STATE_KEY, events);
    }

    /**
     * Log an event (in-memory + async persist to workspaceState).
     */
    logEvent(type: HistoryEventType, data?: HistoryEvent['data']): void {
        const event: HistoryEvent = {
            type,
            timestamp: new Date().toISOString(),
        };

        if (data) {
            event.data = data;
        }

        this.events.push(event);
        this.setEventsArray(this.events).catch((error) => {
            this.outputChannel.appendLine(`[DevGhost] Error persisting history: ${error}`);
        });
    }

    /**
     * Phase 2: Daily rate limit (rolling 24 hours).
     * Returns false if there are 3+ POST_DRAFTED events in the last 24 hours.
     */
    canPostToday(): boolean {
        const now = Date.now();
        const windowMs = 24 * 60 * 60 * 1000;
        const recentPosts = this.events.filter((e) => {
            if (e.type !== 'POST_DRAFTED') return false;
            const ts = Date.parse(e.timestamp);
            if (Number.isNaN(ts)) return false;
            return now - ts < windowMs;
        });
        return recentPosts.length < 3;
    }

    /**
     * Check if we should trigger a warm-up (returning after long absence).
     */
    private async checkWarmup(): Promise<void> {
        const lastEvents = this.events.slice(-20);

        if (lastEvents.length === 0) {
            return;
        }

        const lastSessionEnd = [...lastEvents].reverse().find((e) => e.type === 'SESSION_END');

        if (!lastSessionEnd) {
            return;
        }

        const lastEndTime = new Date(lastSessionEnd.timestamp).getTime();
        const timeSinceLastSession = Date.now() - lastEndTime;

        if (timeSinceLastSession > this.WARMUP_THRESHOLD_MS) {
            const hours = Math.floor(timeSinceLastSession / (1000 * 60 * 60));
            this.outputChannel.appendLine(`[DevGhost] Welcome back! Last session was ${hours} hours ago.`);

            if (this.onWarmupCallback) {
                const summary = this.buildSessionSummary(lastEvents);
                this.onWarmupCallback(summary, lastEvents);
            }
        }
    }

    private buildSessionSummary(events: HistoryEvent[]): string {
        const commits = events.filter((e) => e.type === 'COMMIT');
        const struggles = events.filter((e) => e.type === 'STRUGGLE_DETECTED');
        const wins = events.filter((e) => e.type === 'WIN');

        const parts: string[] = [];

        if (commits.length > 0) {
            const lastCommit = commits[commits.length - 1];
            parts.push(`Last commit: "${lastCommit.data?.message || 'unknown'}"`);
        }

        if (struggles.length > 0) {
            parts.push(`${struggles.length} struggles recorded`);
        }

        if (wins.length > 0) {
            parts.push(`${wins.length} wins`);
        }

        return parts.join('. ') || 'No recent activity recorded.';
    }

    /**
     * Get the last N events from history.
     */
    getLastEvents(count: number = 20): HistoryEvent[] {
        return this.events.slice(-count);
    }

    onWarmup(callback: (summary: string, lastEvents: HistoryEvent[]) => void): void {
        this.onWarmupCallback = callback;
    }

    logCommit(message: string): void {
        this.logEvent('COMMIT', { message });
    }

    logStruggle(command: string, count: number = 1): void {
        this.logEvent('STRUGGLE_DETECTED', { command, count });
    }

    logWin(message: string, duration?: number): void {
        this.logEvent('WIN', { message, duration });
    }

    logFocus(focus: string, from?: string): void {
        if (from) {
            this.logEvent('FOCUS_SHIFT', { focus, from, to: focus });
        } else {
            this.logEvent('FOCUS_SET', { focus });
        }
    }

    /**
     * Clear all persisted project history for the current workspace.
     */
    async resetHistory(): Promise<void> {
        this.events = [];
        await this.setEventsArray([]);
        this.outputChannel.appendLine('[DevGhost] History reset');
    }

    getHistoryForAI(limit: number = 10): string {
        const events = this.getLastEvents(limit);
        if (events.length === 0) return 'No recent history.';
        return events.map(e => {
            const time = new Date(e.timestamp).toLocaleString();
            switch (e.type) {
                case 'COMMIT': return `[${time}] Committed: "${e.data?.message}"`;
                case 'STRUGGLE_DETECTED': return `[${time}] Struggled with: ${e.data?.command}`;
                case 'WIN': return `[${time}] Won: "${e.data?.message}"`;
                case 'SESSION_START': return `[${time}] Session started`;
                case 'SESSION_END': return `[${time}] Session ended`;
                default: return `[${time}] ${e.type}`;
            }
        }).join('\n');
    }

    isReady(): boolean {
        return this.initialized;
    }

    dispose(): void {
        if (this.initialized) {
            this.logEvent('SESSION_END');
        }
    }
}
