import * as vscode from 'vscode';
import { SessionState } from '../models';

/**
 * CommandEvent - Records a command execution for smart matching.
 */
interface CommandEvent {
    command: string;       // Full command string (e.g., "npm run build")
    baseCommand: string;   // Base command (e.g., "npm")
    exitCode: number;
    timestamp: number;
    terminalName?: string;
}

/**
 * SessionManager - The "Nervous System" of DevGhost 3.1
 * 
 * Phase 3.5: SMART COMMAND TRACKING
 * Phase 7: SILENCE BREAKER
 * 
 * Now understands causality:
 * - Tracks WHICH commands failed (not just "something failed")
 * - Only triggers WIN when the SAME command succeeds
 * - Filters noise (cd, ls, echo, etc.)
 * - Detects silence periods (no commits for 60+ mins)
 */
export class SessionManager implements vscode.Disposable {
    private outputChannel: vscode.OutputChannel;
    private session: SessionState;
    private disposables: vscode.Disposable[] = [];
    
    // Callback for when a breakthrough is detected
    private onBreakthroughCallback: ((duration: number, failureCount: number, command: string) => void) | null = null;

    // Minimum session duration (in minutes) to consider a breakthrough worth drafting
    private readonly MIN_STRUGGLE_MINUTES = 5;

    // ═══════════════════════════════════════════════════════════════
    // PHASE 3.5: Smart Command Tracking
    // ═══════════════════════════════════════════════════════════════
    
    // Store failed commands for smart matching
    private recentFailures: CommandEvent[] = [];
    
    // Commands to completely ignore (noise)
    private readonly IGNORED_COMMANDS = [
        'cd', 'ls', 'dir', 'clear', 'cls', 'pwd', 'echo', 'cat', 'type',
        'history', 'which', 'where', 'whoami', 'exit', 'alias', 'export',
        'set', 'env', 'printenv', 'man', 'help', 'less', 'more', 'head', 'tail'
    ];

    // Maximum failures to remember (prevent memory bloat)
    private readonly MAX_FAILURES = 50;

    // ═══════════════════════════════════════════════════════════════
    // PHASE 7: Silence Breaker
    // ═══════════════════════════════════════════════════════════════

    // Silence detection settings
    private readonly SILENCE_CHECK_INTERVAL_MS = 60 * 1000;  // Check every minute
    private readonly SILENCE_THRESHOLD_MS = 60 * 60 * 1000;  // 60 minutes
    private silenceCheckTimer: NodeJS.Timeout | null = null;
    private lastCommitTime: number = Date.now();
    private onSilenceCallback: ((duration: number, strugglesCount: number) => void) | null = null;
    private silenceNotified: boolean = false;

    // Deep work session wrap-up: track active coding time from document edits
    private readonly DEFAULT_DEEP_WORK_MINUTES = 90;
    private deepWorkThresholdMinutes: number = this.DEFAULT_DEEP_WORK_MINUTES;
    private deepWorkThresholdMs: number = this.DEFAULT_DEEP_WORK_MINUTES * 60 * 1000;
    private readonly MAX_GAP_MS = 5 * 60 * 1000;  // cap per idle gap so short breaks don't reset
    private lastEditTime: number = 0;
    private totalActiveCodingMs: number = 0;
    private deepWorkWrapUpFired: boolean = false;
    private onDeepWorkWrapUpCallback: (() => void | Promise<void>) | null = null;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        
        // Initialize session state
        this.session = {
            startTime: new Date(),
            failureCount: 0,
            successCount: 0,
            hadBreakthrough: false,
            lastError: null,
        };

        this.refreshDeepWorkThreshold();
        this.initialize();
    }

    private refreshDeepWorkThreshold(): void {
        const configured = vscode.workspace.getConfiguration('devghost').get<number>('deepWorkMinutes', this.DEFAULT_DEEP_WORK_MINUTES);
        const parsed = Number(configured);
        const safeMinutes = Number.isFinite(parsed) ? Math.max(15, Math.floor(parsed)) : this.DEFAULT_DEEP_WORK_MINUTES;
        this.deepWorkThresholdMinutes = safeMinutes;
        this.deepWorkThresholdMs = this.deepWorkThresholdMinutes * 60 * 1000;
    }

    private initialize(): void {
        this.outputChannel.appendLine('');
        this.outputChannel.appendLine(`[DevGhost] Session started at ${this.session.startTime.toLocaleTimeString()}`);
        this.outputChannel.appendLine('[DevGhost] Smart Command Tracking enabled');
        this.outputChannel.appendLine(`[DevGhost] Deep work threshold: ${this.deepWorkThresholdMinutes} minutes`);
        this.outputChannel.appendLine('');

        this.setupTerminalWatcher();
        this.startSilenceBreaker();
        this.setupDeepWorkTracking();

        const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('devghost.deepWorkMinutes')) {
                this.refreshDeepWorkThreshold();
                this.outputChannel.appendLine(`[DevGhost] Deep work threshold updated: ${this.deepWorkThresholdMinutes} minutes`);
            }
        });
        this.disposables.push(configListener);
    }

    /**
     * Deep work wrap-up: track document edits and fire after the configured minutes of active coding time.
     */
    private setupDeepWorkTracking(): void {
        const docListener = vscode.workspace.onDidChangeTextDocument(() => {
            const now = Date.now();
            if (this.lastEditTime > 0) {
                const gap = Math.min(now - this.lastEditTime, this.MAX_GAP_MS);
                this.totalActiveCodingMs += gap;
            }
            this.lastEditTime = now;

            if (!this.deepWorkWrapUpFired && this.totalActiveCodingMs >= this.deepWorkThresholdMs && this.onDeepWorkWrapUpCallback) {
                this.deepWorkWrapUpFired = true;
                this.outputChannel.appendLine(`[DevGhost] Deep work session (${this.deepWorkThresholdMinutes}+ min active coding) - triggering review-first wrap-up`);
                Promise.resolve(this.onDeepWorkWrapUpCallback()).catch((err) => {
                    this.outputChannel.appendLine(`[DevGhost] Deep work wrap-up error: ${err}`);
                });
            }
        });
        this.disposables.push(docListener);
    }

    /**
     * Phase 7: Start the Silence Breaker timer.
     */
    private startSilenceBreaker(): void {
        this.silenceCheckTimer = setInterval(() => {
            this.checkSilence();
        }, this.SILENCE_CHECK_INTERVAL_MS);
    }

    /**
     * Phase 7: Check if user has been quietly working for a while.
     * Triggers notification after 60 mins of no commits + active struggles.
     */
    private checkSilence(): void {
        const timeSinceCommit = Date.now() - this.lastCommitTime;
        const strugglesCount = this.recentFailures.length;

        // Only trigger if: 60+ mins since commit AND has struggles AND not already notified
        if (timeSinceCommit > this.SILENCE_THRESHOLD_MS && 
            strugglesCount > 0 && 
            !this.silenceNotified &&
            this.onSilenceCallback) {
            
            const durationMinutes = Math.floor(timeSinceCommit / 60000);
            this.outputChannel.appendLine(`[DevGhost] Silence detected: ${durationMinutes} mins, ${strugglesCount} struggles`);
            
            this.silenceNotified = true;  // Don't spam
            this.onSilenceCallback(durationMinutes, strugglesCount);
        }
    }

    /**
     * Set up listeners for terminal activity.
     */
    private setupTerminalWatcher(): void {
        // Terminal open/close events
        const terminalCloseListener = vscode.window.onDidCloseTerminal((terminal) => {
            this.outputChannel.appendLine(`[DevGhost] Terminal closed: ${terminal.name}`);
        });
        this.disposables.push(terminalCloseListener);

        const terminalOpenListener = vscode.window.onDidOpenTerminal((terminal) => {
            this.outputChannel.appendLine(`[DevGhost] Terminal opened: ${terminal.name}`);
        });
        this.disposables.push(terminalOpenListener);

        // VS Code task completion
        const taskEndListener = vscode.tasks.onDidEndTaskProcess((event) => {
            const exitCode = event.exitCode;
            const taskName = event.execution.task.name;

            if (exitCode !== undefined) {
                this.processCommand(taskName, exitCode, 'task');
            }
        });
        this.disposables.push(taskEndListener);

        // Shell Integration API
        try {
            const shellExecutionListener = vscode.window.onDidEndTerminalShellExecution(
                (event: vscode.TerminalShellExecutionEndEvent) => {
                    this.handleShellEvent(event);
                }
            );
            this.disposables.push(shellExecutionListener);
            this.outputChannel.appendLine('[DevGhost] [OK] Shell Integration monitoring enabled');
        } catch (error) {
            this.outputChannel.appendLine('[DevGhost] [WARN] Shell Integration not available');
        }
    }

    /**
     * Handle shell execution end events.
     */
    private handleShellEvent(event: vscode.TerminalShellExecutionEndEvent): void {
        const exitCode = event.exitCode;
        
        if (exitCode === undefined) {
            return;
        }

        const commandLine = event.execution.commandLine;
        const command = commandLine?.value || 'unknown';
        const terminalName = event.terminal.name;
        
        this.processCommand(command, exitCode, terminalName);
    }

    // ═══════════════════════════════════════════════════════════════
    // PHASE 3.5: Smart Command Processing
    // ═══════════════════════════════════════════════════════════════

    /**
     * Process a command and determine if it's a struggle or a win.
     * Uses SMART MATCHING - only triggers WIN if same command succeeded.
     */
    private processCommand(command: string, exitCode: number, source: string): void {
        const baseCommand = this.extractBaseCommand(command);
        
        // Filter noise
        if (this.isIgnoredCommand(baseCommand)) {
            return;
        }

        const commandEvent: CommandEvent = {
            command: command.trim(),
            baseCommand,
            exitCode,
            timestamp: Date.now(),
            terminalName: source,
        };

        this.outputChannel.appendLine(`[DevGhost] Command: "${this.truncate(command, 50)}" (exit: ${exitCode})`);

        if (exitCode === 0) {
            this.handleSuccess(commandEvent);
        } else {
            this.handleFailure(commandEvent);
        }
    }

    /**
     * Handle a failed command - record it for future matching.
     */
    private handleFailure(event: CommandEvent): void {
        // Add to failure list
        this.recentFailures.push(event);
        this.session.failureCount++;
        this.session.lastError = `${event.command} (exit ${event.exitCode})`;
        
        // Prevent memory bloat
        if (this.recentFailures.length > this.MAX_FAILURES) {
            this.recentFailures.shift();
        }

        this.outputChannel.appendLine(`[DevGhost] [FAIL] Struggle recorded: "${this.truncate(event.command, 40)}"`);
        this.outputChannel.appendLine(`[DevGhost] Active struggles: ${this.recentFailures.length}`);
    }

    /**
     * Handle a successful command - check if it matches a previous failure.
     */
    private handleSuccess(event: CommandEvent): void {
        this.session.successCount++;

        // SMART MATCHING: Find if this command previously failed
        const matchIndex = this.findMatchingFailure(event);
        
        if (matchIndex === -1) {
            // No matching failure - this is unrelated success
        this.outputChannel.appendLine(`[DevGhost] [OK] Success (unrelated): "${this.truncate(event.command, 40)}"`);
            return;
        }

        // ═══════════════════════════════════════════════════════════════
        // 🎉 VERIFIED WIN! Same command that failed now succeeded!
        // ═══════════════════════════════════════════════════════════════
        
        const matchedFailure = this.recentFailures[matchIndex];
        const durationMs = event.timestamp - matchedFailure.timestamp;
        const durationMinutes = Math.floor(durationMs / 60000);
        const durationSeconds = Math.floor((durationMs % 60000) / 1000);

        // Count how many times this specific command failed
        const failureCount = this.countMatchingFailures(event);

        // Remove all matching failures (they're resolved now)
        this.clearMatchingFailures(event);

        this.outputChannel.appendLine('');
        this.outputChannel.appendLine('## [VERIFIED WIN]');
        this.outputChannel.appendLine('   VERIFIED WIN!');
        this.outputChannel.appendLine(`   Command: "${this.truncate(event.command, 40)}"`);
        this.outputChannel.appendLine(`   Failed ${failureCount}x before succeeding`);
        this.outputChannel.appendLine(`   Time to fix: ${durationMinutes}m ${durationSeconds}s`);
        this.outputChannel.appendLine('--------------------------');
        this.outputChannel.appendLine('');

        // Trigger breakthrough callback
        const sessionMinutes = this.getSessionDurationMinutes();
        
        if (sessionMinutes >= this.MIN_STRUGGLE_MINUTES || failureCount >= 3) {
            this.session.hadBreakthrough = true;

            if (this.onBreakthroughCallback) {
                this.onBreakthroughCallback(sessionMinutes, failureCount, event.command);
            }
        } else {
            this.outputChannel.appendLine(`[DevGhost] (Quick fix - session ${sessionMinutes}min, needs ${this.MIN_STRUGGLE_MINUTES}min for auto-prompt)`);
        }
    }

    /**
     * Find a previous failure that matches this successful command.
     * Returns the index, or -1 if no match.
     */
    private findMatchingFailure(success: CommandEvent): number {
        // Exact match first
        const exactMatch = this.recentFailures.findIndex(
            f => f.command === success.command
        );
        if (exactMatch !== -1) return exactMatch;

        // Base command match (npm run X matches npm run X)
        const baseMatch = this.recentFailures.findIndex(
            f => f.baseCommand === success.baseCommand && 
                 this.getCommandArgs(f.command) === this.getCommandArgs(success.command)
        );
        return baseMatch;
    }

    /**
     * Count how many times this command failed.
     */
    private countMatchingFailures(success: CommandEvent): number {
        return this.recentFailures.filter(
            f => f.command === success.command || 
                 (f.baseCommand === success.baseCommand && 
                  this.getCommandArgs(f.command) === this.getCommandArgs(success.command))
        ).length;
    }

    /**
     * Clear all failures that match this successful command.
     */
    private clearMatchingFailures(success: CommandEvent): void {
        this.recentFailures = this.recentFailures.filter(
            f => f.command !== success.command &&
                 !(f.baseCommand === success.baseCommand && 
                   this.getCommandArgs(f.command) === this.getCommandArgs(success.command))
        );
    }

    // ═══════════════════════════════════════════════════════════════
    // Utility Methods
    // ═══════════════════════════════════════════════════════════════

    /**
     * Extract the base command (first word) from a command string.
     */
    private extractBaseCommand(command: string): string {
        return command.trim().split(/\s+/)[0].toLowerCase();
    }

    /**
     * Get the arguments part of a command (everything after first word).
     */
    private getCommandArgs(command: string): string {
        const parts = command.trim().split(/\s+/);
        return parts.slice(1).join(' ').toLowerCase();
    }

    /**
     * Check if a command should be ignored.
     */
    private isIgnoredCommand(baseCommand: string): boolean {
        return this.IGNORED_COMMANDS.some(ignored => 
            baseCommand === ignored || baseCommand.endsWith('/' + ignored)
        );
    }

    /**
     * Truncate a string for display.
     */
    private truncate(str: string, maxLength: number): string {
        if (str.length <= maxLength) return str;
        return str.substring(0, maxLength) + '...';
    }

    // ═══════════════════════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════════════════════

    /**
     * Register a callback for breakthrough detection.
     * Now includes the command that was fixed!
     */
    onBreakthrough(callback: (durationMinutes: number, failureCount: number, command: string) => void): void {
        this.onBreakthroughCallback = callback;
    }

    /**
     * Phase 7: Register callback for silence detection.
     * Called when user has been coding for 60+ mins without committing.
     */
    onSilence(callback: (durationMinutes: number, strugglesCount: number) => void): void {
        this.onSilenceCallback = callback;
    }

    /**
     * Deep work wrap-up: register callback when user reaches the configured active-coding threshold.
     */
    onDeepWorkWrapUp(callback: () => void | Promise<void>): void {
        this.onDeepWorkWrapUpCallback = callback;
    }

    /**
     * Phase 7: Record that a commit was made (resets silence timer).
     * Called by GitManager when a commit is detected.
     */
    recordCommit(): void {
        this.lastCommitTime = Date.now();
        this.silenceNotified = false;  // Reset notification flag
    }

    /**
     * Get the current session duration in minutes.
     */
    getSessionDurationMinutes(): number {
        const now = new Date();
        return Math.floor((now.getTime() - this.session.startTime.getTime()) / 60000);
    }

    /**
     * Get the current session state.
     */
    getSession(): SessionState {
        return { ...this.session };
    }

    /**
     * Get active struggles (commands that failed and haven't been fixed).
     */
    getActiveStruggles(): string[] {
        return this.recentFailures.map(f => f.command);
    }

    /**
     * Get a summary of recent command failures (friction).
     */
    getRecentFrictionSummary(maxAgeMinutes: number = 30): string | null {
        if (this.recentFailures.length === 0) return null;

        const maxAgeMs = Math.max(0, maxAgeMinutes) * 60 * 1000;
        const now = Date.now();
        const freshFailures = this.recentFailures.filter((failure) => now - failure.timestamp <= maxAgeMs);

        if (freshFailures.length === 0) return null;

        return freshFailures
            .slice(-5)
            .map(f => `- ${f.command} (exit ${f.exitCode})`)
            .join('\n');
    }

    /**
     * Clear local session signal state without touching project context.
     */
    resetTracking(): void {
        this.recentFailures = [];
        this.session.failureCount = 0;
        this.session.successCount = 0;
        this.session.hadBreakthrough = false;
        this.session.lastError = null;
        this.session.startTime = new Date();
        this.lastCommitTime = Date.now();
        this.silenceNotified = false;
        this.deepWorkWrapUpFired = false;
        this.lastEditTime = 0;
        this.totalActiveCodingMs = 0;
        this.outputChannel.appendLine('[DevGhost] Local activity reset');
    }

    /**
     * Manually trigger a win notification (for testing).
     */
    simulateBreakthrough(): void {
        const minutes = this.getSessionDurationMinutes();
        this.outputChannel.appendLine(`[DevGhost] Simulating breakthrough after ${minutes} minutes...`);
        
        if (this.onBreakthroughCallback) {
            this.onBreakthroughCallback(minutes || 60, 5, 'npm run build (simulated)');
        }
    }

    dispose(): void {
        // Clear silence breaker timer
        if (this.silenceCheckTimer) {
            clearInterval(this.silenceCheckTimer);
        }
        this.disposables.forEach(d => d.dispose());
    }
}
