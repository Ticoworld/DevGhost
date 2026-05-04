import * as vscode from 'vscode';
import * as child_process from 'child_process';
import { createHash } from 'crypto';

type CommitClassification = 'startup_baseline' | 'historical_existing_commit' | 'fresh_commit';

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
    changedFiles: string[];
    isPivot: boolean;
    isDeepWork: boolean;
    repoRoot: string;
    sessionMinutes: number;
    authorDate?: string | null;
    committerDate?: string | null;
    classification?: CommitClassification;
    diffStat?: string;
    workType?: string;
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
    private readonly workspaceState: vscode.Memento;
    private disposables: vscode.Disposable[] = [];
    private gitApi: any = null;
    private repository: any = null;
    private lastHeadCommit: string | null = null;
    private lastSeenCommitHash: string | null = null;
    private lastSeenCommitKey: string | null = null;
    private baselineEstablished = false;
    private sessionStartTime: Date;

    // Callbacks
    private onPivotCallback: ((analysis: CommitAnalysis) => void) | null = null;
    // Deep Work Win callback removed - now handled in handleCommitDetected after Brain analysis
    private onCommitCallback: ((analysis: CommitAnalysis) => void) | null = null;

    // Thresholds
    private readonly PIVOT_DELETION_THRESHOLD = 100;  // Deletions to consider a pivot
    private readonly DEEP_WORK_MINUTES = 90;          // Minutes for "deep work" labeling in commit analysis
    private readonly COMMIT_GRACE_WINDOW_MS = 5 * 60 * 1000;

    constructor(outputChannel: vscode.OutputChannel, workspaceState: vscode.Memento, sessionStartTime: Date) {
        this.outputChannel = outputChannel;
        this.workspaceState = workspaceState;
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
                this.outputChannel.appendLine('[DevGhost] âœ“ Git integration enabled');
                return true;
            }

            // Watch for repository opening
            this.gitApi.onDidOpenRepository((repo: any) => {
                if (!this.repository) {
                    this.repository = repo;
                    void this.setupRepositoryWatcher();
                    this.outputChannel.appendLine('[DevGhost] âœ“ Git repository detected');
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

        const repoRoot = this.repository.rootUri?.fsPath || '';
        this.lastSeenCommitKey = this.getLastSeenCommitKey(repoRoot);
        this.lastSeenCommitHash = await this.loadLastSeenCommitHash();

        // Record the current HEAD as the startup baseline if it is already available.
        const currentHead = this.repository.state.HEAD?.commit || null;
        if (currentHead) {
            await this.recordCommitAsSeen(currentHead, 'startup_baseline', 'Existing HEAD recorded as baseline');
        } else {
            this.lastHeadCommit = this.lastSeenCommitHash;
        }

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

        const currentHead = this.repository.state.HEAD?.commit || null;
        if (!currentHead) {
            return;
        }

        if (!this.baselineEstablished) {
            await this.recordCommitAsSeen(currentHead, 'startup_baseline', 'Existing HEAD recorded as baseline');
            return;
        }

        if (currentHead === this.lastHeadCommit || currentHead === this.lastSeenCommitHash) {
            this.lastHeadCommit = currentHead;
            return;
        }

        const analysis = await this.analyzeCommit(currentHead);
        if (!analysis) {
            return;
        }

        if (analysis.classification !== 'fresh_commit') {
            await this.recordCommitAsSeen(
                currentHead,
                'historical_existing_commit',
                `Existing commit skipped: ${currentHead.substring(0, 7)} predates this DevGhost session.`
            );
            return;
        }

        await this.recordCommitAsSeen(currentHead, 'fresh_commit');
        this.outputChannel.appendLine(`[DevGhost] New commit detected: ${currentHead.substring(0, 7)}`);
        this.processCommitAnalysis(analysis);
    }

    private async recordCommitAsSeen(
        commitHash: string,
        classification: CommitClassification,
        logMessage?: string
    ): Promise<void> {
        this.lastHeadCommit = commitHash;
        this.lastSeenCommitHash = commitHash;
        this.baselineEstablished = true;

        await this.persistLastSeenCommitHash(commitHash);

        if (classification === 'startup_baseline' && logMessage) {
            this.outputChannel.appendLine(`[DevGhost] ${logMessage}: ${commitHash.substring(0, 7)}`);
        } else if (classification === 'historical_existing_commit' && logMessage) {
            this.outputChannel.appendLine(`[DevGhost] ${logMessage}`);
        }
    }

    private async persistLastSeenCommitHash(commitHash: string): Promise<void> {
        if (!this.lastSeenCommitKey) {
            return;
        }

        try {
            await this.workspaceState.update(this.lastSeenCommitKey, commitHash);
        } catch (error) {
            this.outputChannel.appendLine(`[DevGhost] Error persisting last seen commit: ${error}`);
        }
    }

    private async loadLastSeenCommitHash(): Promise<string | null> {
        if (!this.lastSeenCommitKey) {
            return null;
        }

        return this.workspaceState.get<string | null>(this.lastSeenCommitKey, null) ?? null;
    }

    private getLastSeenCommitKey(repoRoot: string): string {
        const repoKey = createHash('sha1')
            .update((repoRoot || '').replace(/\\/g, '/').toLowerCase())
            .digest('hex');
        return `devghost.lastSeenCommitHash.${repoKey}`;
    }

    /**
     * Analyze a commit to extract stats and detect patterns.
     * Uses the repository root from the Git API (correct for multi-root / monorepo).
     */
    private async analyzeCommit(commitHash: string): Promise<CommitAnalysis | null> {
        if (!this.repository) return null;
        const repoRoot = this.repository.rootUri.fsPath;

        try {
            // Get commit metadata and stats in one pass.
            const statsOutput = await this.runGitCommand(
                repoRoot,
                ['show', '--stat', '--format=%H%x1f%s%x1f%aI%x1f%cI', commitHash]
            );

            const lines = statsOutput.split(/\r?\n/);
            const headerLine = lines.shift() || '';
            const [fullHash = commitHash, message = 'No message', authorDate = null, committerDate = null] = headerLine.split('\x1f');

            // Parse filenames from the stat lines
            // Example line: " src/analyzer/gemini.ts | 24 ++++++++"
            const changedFiles: string[] = [];
            let additions = 0;
            let deletions = 0;
            let filesChanged = 0;

            for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line) continue;

                // Summary line: " 5 files changed, 120 insertions(+), 50 deletions(-)"
                if (line.includes('file') && line.includes('changed')) {
                    const filesMatch = line.match(/(\d+)\s+file/);
                    if (filesMatch) filesChanged = parseInt(filesMatch[1]);

                    const addMatch = line.match(/(\d+)\s+insertion/);
                    if (addMatch) additions = parseInt(addMatch[1]);

                    const delMatch = line.match(/(\d+)\s+deletion/);
                    if (delMatch) deletions = parseInt(delMatch[1]);
                    continue;
                }

                // Stat line: " path/to/file | 10 ++--"
                const pipeIdx = line.indexOf('|');
                if (pipeIdx > 0) {
                    const filePath = line.substring(0, pipeIdx).trim();
                    if (filePath) changedFiles.push(filePath);
                }
            }

            // If summary line failed, use counts from parsed files
            if (filesChanged === 0) filesChanged = changedFiles.length;

            // Determine if this is a pivot
            const isPivot =
                deletions > this.PIVOT_DELETION_THRESHOLD &&
                deletions > additions * 2;

            // Determine if this is a deep work win
            const sessionMinutes = this.getSessionDurationMinutes();
            const isDeepWork = sessionMinutes >= this.DEEP_WORK_MINUTES;

            // Infer work type
            let workType = 'refactor';
            const msgLower = message.toLowerCase();
            if (msgLower.startsWith('feat') || msgLower.includes('add ') || msgLower.includes('new ')) workType = 'feature';
            else if (msgLower.startsWith('fix') || msgLower.includes('bug') || msgLower.includes('issue')) workType = 'bugfix';
            else if (msgLower.includes('security') || msgLower.includes('vuln')) workType = 'security';
            else if (msgLower.includes('doc')) workType = 'docs';
            else if (msgLower.includes('config') || msgLower.includes('env')) workType = 'config';
            else if (msgLower.includes('test')) workType = 'tests';
            else if (msgLower.includes('clean')) workType = 'cleanup';

            const classification = this.classifyCommitFreshness(authorDate, committerDate);

            return {
                hash: (fullHash || commitHash).substring(0, 7),
                message,
                additions,
                deletions,
                filesChanged,
                changedFiles,
                isPivot,
                isDeepWork,
                repoRoot,
                sessionMinutes,
                authorDate: authorDate || null,
                committerDate: committerDate || null,
                classification,
                diffStat: statsOutput,
                workType,
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
        this.outputChannel.appendLine('ðŸ“ â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');
        this.outputChannel.appendLine('   COMMIT DETECTED');
        this.outputChannel.appendLine(`   Hash: ${analysis.hash}`);
        this.outputChannel.appendLine(`   Message: "${analysis.message}"`);
        this.outputChannel.appendLine(`   Changes: +${analysis.additions} / -${analysis.deletions} (${analysis.filesChanged} files)`);
        this.outputChannel.appendLine('â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• ðŸ“');

        // Check for PIVOT
        if (analysis.isPivot) {
            this.outputChannel.appendLine('');
            this.outputChannel.appendLine('ðŸ”¥ â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');
            this.outputChannel.appendLine('   PIVOT DETECTED!');
            this.outputChannel.appendLine(`   Heavy refactor: -${analysis.deletions} lines`);
            this.outputChannel.appendLine('   "What is the new vision?"');
            this.outputChannel.appendLine('â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• ðŸ”¥');
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
            this.outputChannel.appendLine('ðŸ† â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');
            this.outputChannel.appendLine('   DEEP WORK SESSION');
            this.outputChannel.appendLine(`   ${analysis.sessionMinutes} minutes of focused work`);
            this.outputChannel.appendLine('   Commit recorded. DevGhost will evaluate whether it is worth a draft.');
            this.outputChannel.appendLine('â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• ðŸ†');
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

    private classifyCommitFreshness(authorDate: string | null, committerDate: string | null): CommitClassification {
        const timestamp = committerDate || authorDate || null;
        if (!timestamp) {
            return 'historical_existing_commit';
        }

        const parsed = Date.parse(timestamp);
        if (Number.isNaN(parsed)) {
            return 'historical_existing_commit';
        }

        const freshnessThreshold = this.sessionStartTime.getTime() - this.COMMIT_GRACE_WINDOW_MS;
        return parsed >= freshnessThreshold ? 'fresh_commit' : 'historical_existing_commit';
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
