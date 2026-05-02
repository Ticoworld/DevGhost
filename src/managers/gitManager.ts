import * as vscode from 'vscode';
import * as child_process from 'child_process';

/**
 * Git commit analysis results.
 * repoRoot: root of the repo where the commit was made (for correct git/history in multi-root).
 * sessionMinutes: duration of current session when commit was made (for deep work messaging).
 */
interface CommitAnalysis {
    hash: string;
    message: string;
    additions: number;
    deletions: number;
    filesChanged: number;
    isPivot: boolean;
    isDeepWork: boolean;
    repoRoot: string;
    sessionMinutes: number;
}

/**
 * GitManager - The "Historian" of DevGhost
 * 
 * Phase 4: Git Integration & Pivot Detection
 * 
 * Detects:
 * - Commits (the ultimate "save point")
 * - Pivots (mass deletions, architectural changes)
 * - Deep work wins (commits after long sessions)
 */
export class GitManager implements vscode.Disposable {
    private outputChannel: vscode.OutputChannel;
    private disposables: vscode.Disposable[] = [];
    private gitApi: any = null;
    private repository: any = null;
    private lastHeadCommit: string | null = null;
    private sessionStartTime: Date;
    private watcherInitialized: boolean = false; // Track if watcher is ready

    // Callbacks
    private onPivotCallback: ((analysis: CommitAnalysis) => void) | null = null;
    // Deep Work Win callback removed - now handled in handleCommitDetected after Brain analysis
    private onCommitCallback: ((analysis: CommitAnalysis) => void) | null = null;

    // Thresholds
    private readonly PIVOT_DELETION_THRESHOLD = 100;  // Deletions to consider a pivot
    private readonly DEEP_WORK_MINUTES = 90;          // Minutes for "deep work" labeling in commit analysis

    constructor(outputChannel: vscode.OutputChannel, sessionStartTime: Date) {
        this.outputChannel = outputChannel;
        this.sessionStartTime = sessionStartTime;
    }

    /**
     * Initialize the Git integration.
     * Must be called after construction.
     */
    async initialize(): Promise<boolean> {
        try {
            // Get the VS Code Git extension
            const gitExtension = vscode.extensions.getExtension('vscode.git');
            
            if (!gitExtension) {
                this.outputChannel.appendLine('[DevGhost] Git extension not found');
                return false;
            }

            // Activate if not already
            if (!gitExtension.isActive) {
                await gitExtension.activate();
            }

            this.gitApi = gitExtension.exports.getAPI(1);

            if (!this.gitApi) {
                this.outputChannel.appendLine('[DevGhost] Could not get Git API');
                return false;
            }

            // Get the first repository
            if (this.gitApi.repositories.length > 0) {
                this.repository = this.gitApi.repositories[0];
                await this.setupRepositoryWatcher();
                this.outputChannel.appendLine('[DevGhost] ✓ Git integration enabled');
                return true;
            }

            // Watch for repository opening
            this.gitApi.onDidOpenRepository((repo: any) => {
                if (!this.repository) {
                    this.repository = repo;
                    this.setupRepositoryWatcher();
                    this.outputChannel.appendLine('[DevGhost] ✓ Git repository detected');
                }
            });

            this.outputChannel.appendLine('[DevGhost] Waiting for Git repository...');
            return true;

        } catch (error) {
            this.outputChannel.appendLine(`[DevGhost] Git initialization error: ${error}`);
            return false;
        }
    }

    /**
     * Set up the watcher for repository state changes.
     */
    private async setupRepositoryWatcher(): Promise<void> {
        if (!this.repository) return;

        // Store the current HEAD
        this.lastHeadCommit = this.repository.state.HEAD?.commit || null;
        
        // Mark as initialized after a short delay (let Git API settle)
        setTimeout(() => {
            this.watcherInitialized = true;
        }, 2000); // 2 second grace period

        // Watch for state changes (commits, checkouts, etc.)
        const stateChangeListener = this.repository.state.onDidChange(async () => {
            await this.handleStateChange();
        });

        this.disposables.push(stateChangeListener);
    }

    /**
     * Handle repository state changes.
     * Detect new commits by watching HEAD.
     */
    private async handleStateChange(): Promise<void> {
        if (!this.repository) return;

        // Ignore state changes during initial setup (prevent false positives on startup)
        if (!this.watcherInitialized) {
            // Update lastHeadCommit silently during initialization
            this.lastHeadCommit = this.repository.state.HEAD?.commit || null;
            return;
        }

        const currentHead = this.repository.state.HEAD?.commit;

        // Check if HEAD changed (new commit)
        if (currentHead && currentHead !== this.lastHeadCommit) {
            this.outputChannel.appendLine(`[DevGhost] New commit detected: ${currentHead.substring(0, 7)}`);
            this.lastHeadCommit = currentHead;

            // Analyze the commit
            const analysis = await this.analyzeCommit(currentHead);
            if (analysis) {
                this.processCommitAnalysis(analysis);
            }
        }
    }

    /**
     * Analyze a commit to extract stats and detect patterns.
     * Uses the repository root from the Git API (correct for multi-root / monorepo).
     */
    private async analyzeCommit(commitHash: string): Promise<CommitAnalysis | null> {
        if (!this.repository) return null;
        const repoRoot = this.repository.rootUri.fsPath;

        try {
            // Get commit stats using git show (run in repo that has this commit)
            const statsOutput = await this.runGitCommand(
                repoRoot,
                ['show', '--stat', '--format=%s', commitHash]
            );

            // Parse the output
            const lines = statsOutput.split('\n');
            const message = lines[0] || 'No message';

            // Parse stats from the summary line (e.g., "5 files changed, 120 insertions(+), 50 deletions(-)")
            let additions = 0;
            let deletions = 0;
            let filesChanged = 0;

            const statsLine = lines[lines.length - 2] || '';
            
            const filesMatch = statsLine.match(/(\d+)\s+file/);
            if (filesMatch) filesChanged = parseInt(filesMatch[1]);

            const addMatch = statsLine.match(/(\d+)\s+insertion/);
            if (addMatch) additions = parseInt(addMatch[1]);

            const delMatch = statsLine.match(/(\d+)\s+deletion/);
            if (delMatch) deletions = parseInt(delMatch[1]);

            // Determine if this is a pivot
            const isPivot = 
                deletions > this.PIVOT_DELETION_THRESHOLD && 
                deletions > additions * 2;

            // Determine if this is a deep work win
            const sessionMinutes = this.getSessionDurationMinutes();
            const isDeepWork = sessionMinutes >= this.DEEP_WORK_MINUTES;

            return {
                hash: commitHash.substring(0, 7),
                message,
                additions,
                deletions,
                filesChanged,
                isPivot,
                isDeepWork,
                repoRoot,
                sessionMinutes,
            };

        } catch (error) {
            this.outputChannel.appendLine(`[DevGhost] Error analyzing commit: ${error}`);
            return null;
        }
    }

    /**
     * Process the commit analysis and trigger appropriate callbacks.
     */
    private processCommitAnalysis(analysis: CommitAnalysis): void {
        this.outputChannel.appendLine('');
        this.outputChannel.appendLine('📝 ═══════════════════════════════════════════');
        this.outputChannel.appendLine('   COMMIT DETECTED');
        this.outputChannel.appendLine(`   Hash: ${analysis.hash}`);
        this.outputChannel.appendLine(`   Message: "${analysis.message}"`);
        this.outputChannel.appendLine(`   Changes: +${analysis.additions} / -${analysis.deletions} (${analysis.filesChanged} files)`);
        this.outputChannel.appendLine('═══════════════════════════════════════════ 📝');

        // Check for PIVOT
        if (analysis.isPivot) {
            this.outputChannel.appendLine('');
            this.outputChannel.appendLine('🔥 ═══════════════════════════════════════════');
            this.outputChannel.appendLine('   PIVOT DETECTED!');
            this.outputChannel.appendLine(`   Heavy refactor: -${analysis.deletions} lines`);
            this.outputChannel.appendLine('   "What is the new vision?"');
            this.outputChannel.appendLine('═══════════════════════════════════════════ 🔥');
            this.outputChannel.appendLine('');

            if (this.onPivotCallback) {
                this.onPivotCallback(analysis);
            }
        }

        // Deep Work Win is now handled in handleCommitDetected after Brain analysis
        // (only prompts if Brain says the commit is significant, not just time-based)
        // We still log it here for visibility, but the popup decision happens after Brain runs
        if (analysis.isDeepWork) {
            this.outputChannel.appendLine('');
            this.outputChannel.appendLine('🏆 ═══════════════════════════════════════════');
            this.outputChannel.appendLine('   DEEP WORK SESSION');
            this.outputChannel.appendLine(`   ${analysis.sessionMinutes} minutes of focused work`);
            this.outputChannel.appendLine('   Commit recorded. DevGhost will evaluate whether it is worth a draft.');
            this.outputChannel.appendLine('═══════════════════════════════════════════ 🏆');
            this.outputChannel.appendLine('');
        }

        // Always trigger general commit callback
        if (this.onCommitCallback) {
            this.onCommitCallback(analysis);
        }

        this.outputChannel.appendLine('');
    }

    /**
     * Run a git command and return the output.
     */
    private runGitCommand(cwd: string, args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            child_process.execFile('git', args, { cwd }, (error, stdout, stderr) => {
                if (error) {
                    reject(stderr || error.message);
                } else {
                    resolve(stdout);
                }
            });
        });
    }

    /**
     * Get session duration in minutes.
     */
    private getSessionDurationMinutes(): number {
        const now = new Date();
        return Math.floor((now.getTime() - this.sessionStartTime.getTime()) / 60000);
    }

    // ═══════════════════════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════════════════════

    /**
     * Register callback for pivot detection.
     */
    onPivot(callback: (analysis: CommitAnalysis) => void): void {
        this.onPivotCallback = callback;
    }

    /**
     * Deep Work Win callback removed - now handled in handleCommitDetected after Brain analysis.
     * This ensures we only prompt if Brain says the commit is significant, not just time-based.
     */

    /**
     * Register callback for any commit.
     */
    onCommit(callback: (analysis: CommitAnalysis) => void): void {
        this.onCommitCallback = callback;
    }

    /**
     * Check if Git is available.
     */
    isAvailable(): boolean {
        return this.repository !== null;
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
    }
}

// Export the CommitAnalysis interface for use in other modules
export type { CommitAnalysis };
