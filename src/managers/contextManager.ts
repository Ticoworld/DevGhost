import * as vscode from 'vscode';
import * as path from 'path';
import { DevGhostConfig, DEFAULT_CONFIG } from '../models';

/** workspaceState key for project baseline (config). Isolated per workspace. */
const WORKSPACE_STATE_KEY = 'devghost.projectBaseline';
/** workspaceState key for generated baseline summary. Isolated per workspace. */
const BASELINE_SUMMARY_KEY = 'devghost.projectBaselineSummary';

/**
 * ContextManager - Project context for DevGhost
 *
 * Manages project context (the "Soul") via VS Code workspaceState.
 * No local files — data is strictly isolated to the currently open workspace.
 *
 * Key Features:
 * - Reads/updates config from workspaceState
 * - Tracks current focus and struggle duration
 */
export class ContextManager implements vscode.Disposable {
    private config: DevGhostConfig | null = null;
    private baselineSummary: string | null = null;
    private workspaceState: vscode.Memento;
    private outputChannel: vscode.OutputChannel;
    private disposables: vscode.Disposable[] = [];

    constructor(workspaceState: vscode.Memento, outputChannel: vscode.OutputChannel) {
        this.workspaceState = workspaceState;
        this.outputChannel = outputChannel;
    }

    /**
     * Initialize the ContextManager from workspaceState.
     */
    async initialize(): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

        if (!workspaceFolder) {
            return;
        }

        await this.loadConfig();
        this.baselineSummary = this.workspaceState.get<string>(BASELINE_SUMMARY_KEY) ?? null;
    }

    /**
     * Load the config from workspaceState.
     */
    private async loadConfig(): Promise<void> {
        try {
            const raw = this.workspaceState.get<DevGhostConfig>(WORKSPACE_STATE_KEY);
            this.config = raw ? { ...DEFAULT_CONFIG, ...raw } : null;
        } catch (error) {
            this.outputChannel.appendLine(`[error] Error loading config: ${error}`);
            this.config = null;
        }
    }

    /**
     * Save the config to workspaceState.
     */
    private async saveConfig(): Promise<void> {
        if (!this.config) return;

        try {
            await this.workspaceState.update(WORKSPACE_STATE_KEY, this.config);
        } catch (error) {
            this.outputChannel.appendLine(`[error] Error saving config: ${error}`);
        }
    }

    /**
     * Create a new config with user input.
     */
    async createConfig(): Promise<boolean> {
        const projectName = await vscode.window.showInputBox({
            prompt: 'Project name',
            placeHolder: 'e.g., billing dashboard, docs site, API service',
            value: this.config?.projectName || undefined,
        });

        if (!projectName) return false;

        const mission = await vscode.window.showInputBox({
            prompt: 'What is the goal for this workspace? (One sentence)',
            placeHolder: 'e.g., ship a cleaner checkout flow',
            value: this.config?.mission || undefined,
        });

        if (!mission) return false;

        const currentFocus = await vscode.window.showInputBox({
            prompt: 'What are you focused on right now? (Optional)',
            placeHolder: 'e.g., fixing login, cleaning dashboard, preparing demo',
            value: this.config?.currentFocus || undefined,
        }) || '';

        const existing = this.config ?? DEFAULT_CONFIG;
        this.config = {
            ...existing,
            projectName,
            mission,
            currentFocus,
            struggleStartTime: currentFocus ? new Date().toISOString() : null,
        };

        await this.saveConfig();

        this.outputChannel.appendLine('Project details saved.');
        this.outputChannel.appendLine('Post suggestions ready.');

        return true;
    }

    /**
     * Phase 7: Initialize with catch-up from git history (when user chooses "Continuing Build" flow later).
     */
    async initializeWithCatchUp(): Promise<void> {
        const created = await this.createConfig();
        if (!created) return;
        await this.seedFromGitHistory();
    }

    /**
     * Read recent git commits and seed session context.
     */
    private async seedFromGitHistory(): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceFolder || !this.config) return;

        try {
            const execSync = require('child_process').execSync;
            const gitLog = execSync('git log -n 5 --oneline', {
                cwd: workspaceFolder,
                encoding: 'utf-8',
            });

            const commits = gitLog.trim().split('\n').filter((line: string) => line.length > 0);

            if (commits.length > 0) {
                const lastCommit = commits[0].replace(/^[a-f0-9]+\s+/, '');
                this.config.currentFocus = `Continuing from: ${lastCommit}`;
                await this.saveConfig();
            }
        } catch (error) {
            this.outputChannel.appendLine(`[error] Could not read git history: ${error}`);
        }
    }

    /**
     * Update the current focus.
     */
    async setFocus(): Promise<void> {
        const focus = await vscode.window.showInputBox({
            prompt: 'What changed or what are you focused on?',
            placeHolder: 'e.g., tightening the CLI checks and eval flow',
            value: this.config?.currentFocus,
        });

        if (focus !== undefined) {
            if (!this.config) {
                this.config = {
                    ...DEFAULT_CONFIG,
                    projectName: this.getWorkspaceName(),
                    mission: '',
                    currentFocus: '',
                    struggleStartTime: null,
                };
            }

            if (focus !== this.config.currentFocus) {
                this.config.struggleStartTime = focus ? new Date().toISOString() : null;
            }

            this.config.currentFocus = focus;
            await this.saveConfig();

            if (focus) {
                this.outputChannel.appendLine('Focus saved.');
            } else {
                this.outputChannel.appendLine('Focus cleared.');
            }
        }
    }

    getConfig(): DevGhostConfig | null {
        return this.config;
    }

    getStruggleDurationMinutes(): number {
        if (!this.config?.struggleStartTime) return 0;

        const start = new Date(this.config.struggleStartTime);
        const now = new Date();
        return Math.floor((now.getTime() - start.getTime()) / 60000);
    }

    async recordWin(description: string, durationMinutes: number): Promise<void> {
        if (!this.config) return;

        this.config.sessionHistory.push({
            description,
            durationMinutes,
            completedAt: new Date().toISOString(),
            struggle: this.config.currentFocus,
            posted: false,
        });

        this.config.currentFocus = '';
        this.config.struggleStartTime = null;

        await this.saveConfig();
    }

    hasContext(): boolean {
        return this.config !== null;
    }

    hasBaselineSummary(): boolean {
        return !!(this.baselineSummary && this.baselineSummary.trim().length > 0);
    }

    getBaselineSummary(): string | null {
        return this.baselineSummary;
    }

    async setBaselineSummary(summary: string): Promise<void> {
        this.baselineSummary = summary;
        await this.workspaceState.update(BASELINE_SUMMARY_KEY, summary);
    }

    /**
     * Clear the current workspace project context and baseline.
     */
    async resetProjectContext(): Promise<void> {
        this.config = null;
        this.baselineSummary = null;

        await this.workspaceState.update(WORKSPACE_STATE_KEY, null as any);
        await this.workspaceState.update(BASELINE_SUMMARY_KEY, null as any);

        this.outputChannel.appendLine('Project context reset.');
    }

    // ═══════════════════════════════════════════════════════════════
    // PHASE 6B: Ask On Open
    // ═══════════════════════════════════════════════════════════════

    async askFocusOnOpen(): Promise<string | undefined> {
        if (!this.config) return undefined;

        if (this.config.currentFocus && this.config.currentFocus.length > 0) {
            return undefined;
        }

        if (this.config.lastFocusAsked) {
            const lastAsked = new Date(this.config.lastFocusAsked);
            const hourAgo = Date.now() - 60 * 60 * 1000;
            if (lastAsked.getTime() > hourAgo) {
                return undefined;
            }
        }

        const focus = await vscode.window.showInputBox({
            prompt: `What changed or what are you focused on in "${this.config.projectName}"?`,
            placeHolder: 'e.g., tightening the CLI checks and eval flow',
            ignoreFocusOut: false,
        });

        if (focus) {
            this.config.currentFocus = focus;
            this.config.struggleStartTime = new Date().toISOString();
            this.config.lastFocusAsked = new Date().toISOString();
            await this.logEvent('focus_set', focus);
            await this.saveConfig();
            this.outputChannel.appendLine('Focus saved.');
            return focus;
        } else {
            this.config.lastFocusAsked = new Date().toISOString();
            await this.saveConfig();
            return undefined;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // PHASE 6C: Auto-Infer Focus from Commits
    // ═══════════════════════════════════════════════════════════════

    private readonly FOCUS_KEYWORDS = [
        'auth', 'login', 'api', 'ui', 'landing', 'dashboard', 'database', 'db',
        'websocket', 'socket', 'payment', 'checkout', 'deploy', 'docker', 'test',
        'responsive', 'mobile', 'dark mode', 'theme', 'navigation', 'header',
        'footer', 'sidebar', 'modal', 'form', 'validation', 'error', 'bug',
        'performance', 'cache', 'security', 'cors', 'config', 'setup',
    ];

    async inferFocusFromCommit(commitMessage: string): Promise<{ shouldAsk: boolean; inferredFocus: string }> {
        if (!this.config) return { shouldAsk: false, inferredFocus: '' };
        if (!this.config.currentFocus?.trim()) return { shouldAsk: false, inferredFocus: '' };

        const messageLower = commitMessage.toLowerCase();

        if (
            messageLower.includes('typo') ||
            messageLower.includes('merge') ||
            messageLower.includes('wip') ||
            messageLower.length < 10
        ) {
            return { shouldAsk: false, inferredFocus: '' };
        }

        let cleanMessage = commitMessage
            .replace(/^(fix|feat|refactor|chore|docs|style|test|perf|ci|build)(\(.+\))?:\s*/i, '')
            .trim();

        const foundKeyword = this.FOCUS_KEYWORDS.find((kw) => messageLower.includes(kw));

        if (!foundKeyword) {
            return { shouldAsk: false, inferredFocus: '' };
        }

        const currentFocusLower = (this.config.currentFocus || '').toLowerCase();
        if (currentFocusLower.includes(foundKeyword)) {
            return { shouldAsk: false, inferredFocus: '' };
        }

        return { shouldAsk: true, inferredFocus: cleanMessage };
    }

    async handleFocusShift(inferredFocus: string): Promise<void> {
        if (!this.config) return;

        const oldFocus = this.config.currentFocus || 'nothing specific';

        const selection = await vscode.window.showInformationMessage(
            `Looks like you changed focus from "${oldFocus}" to "${inferredFocus}"?`,
            'Update focus',
            'Keep current'
        );

        if (selection === 'Update focus') {
            await this.logEvent('focus_shift', inferredFocus, { from: oldFocus, to: inferredFocus });
            this.config.currentFocus = inferredFocus;
            this.config.struggleStartTime = new Date().toISOString();
            await this.saveConfig();
            this.outputChannel.appendLine('Focus shifted.');
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // PHASE 6D: Session Memory (Event Logging)
    // ═══════════════════════════════════════════════════════════════

    async logEvent(
        type: 'focus_set' | 'commit' | 'struggle' | 'focus_shift' | 'post',
        value?: string,
        extra?: { from?: string; to?: string; command?: string; count?: number }
    ): Promise<void> {
        if (!this.config) return;

        if (!this.config.sessionLog) {
            this.config.sessionLog = [];
        }

        const entry: any = {
            time: new Date().toISOString(),
            type,
        };

        if (value) entry.value = value;
        if (extra?.from) entry.from = extra.from;
        if (extra?.to) entry.to = extra.to;
        if (extra?.command) entry.command = extra.command;
        if (extra?.count) entry.count = extra.count;

        this.config.sessionLog.push(entry);

        this.pruneOldLogs();

        await this.saveConfig();
    }

    private pruneOldLogs(): void {
        if (!this.config?.sessionLog) return;

        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

        this.config.sessionLog = this.config.sessionLog.filter((entry) => {
            const entryTime = new Date(entry.time).getTime();
            return entryTime > sevenDaysAgo;
        });
    }

    getRecentLog(limit: number = 10): any[] {
        if (!this.config?.sessionLog) return [];
        return this.config.sessionLog.slice(-limit);
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }

    private getWorkspaceName(): string {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return workspaceFolder ? path.basename(workspaceFolder) : 'workspace';
    }
}
