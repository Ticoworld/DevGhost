import * as path from 'path';
import * as vscode from 'vscode';
import { execFileSync } from 'child_process';
import { shouldSkipSensitivePath } from '../analyzer/aiSanitizer';
import type { CommitAnalysis } from './gitManager';

const AUTO_DRAFT_SCORE_THRESHOLD = 70;
const AUTO_DRAFT_COOLDOWN_MINUTES = 45;
const BURST_RESET_MINUTES = 10;
const STABILITY_PAUSE_MINUTES = 8;
type FileCategory = 'source' | 'config' | 'docs' | 'style' | 'generated' | 'noise' | 'other';

export type AutomaticDraftTrigger =
    | 'PROJECT_LAUNCH'
    | 'PROJECT_RESUME'
    | 'FRICTION_BREAKTHROUGH'
    | 'DEEP_WORK_WRAP_UP'
    | 'WARMUP_RETURN'
    | 'SILENCE_BREAKER'
    | 'COMMIT_DETECTED'
    | 'FOCUS_INTENT';

export interface AutomaticDraftHints {
    recentCommits?: string[];
    failedCommands?: string[];
    successCommand?: string;
    durationMinutes?: number;
    strugglesCount?: number;
    commitAnalysis?: CommitAnalysis;
}

export interface AutomaticDraftInput {
    trigger: AutomaticDraftTrigger;
    eventKey: string;
    workspaceRoot: string;
    projectName: string;
    currentFocus: string;
    focusAgeMinutes: number;
    sessionMinutes: number;
    hasBaselineSummary: boolean;
    canPostToday: boolean;
    hints?: AutomaticDraftHints;
}

export interface AutomaticDraftDecision {
    allowed: boolean;
    score: number;
    threshold: number;
    reasons: string[];
    blockers: string[];
    burstStable: boolean;
}

interface AutoDraftMeta {
    lastSuggestedAt: number | null;
    lastEventKey: string | null;
}

interface FileTouchStats {
    filePath: string;
    touches: number;
    saves: number;
    activeHits: number;
    firstTouchedAt: number;
    lastTouchedAt: number;
    languageId: string;
    category: FileCategory;
    symbols: Set<string>;
}

interface CommandStats {
    failures: number;
    successes: number;
    lastFailureAt: number | null;
    lastSuccessAt: number | null;
    recovered: boolean;
}

interface GitStatusSummary {
    totalChanged: number;
    sourceCount: number;
    configCount: number;
    docsCount: number;
    styleCount: number;
    generatedCount: number;
    noiseCount: number;
    featurePathCount: number;
    stagedCount: number;
    unstagedCount: number;
    untrackedCount: number;
}

interface SignalSnapshot {
    uniqueFileCount: number;
    sourceFileCount: number;
    configFileCount: number;
    docsFileCount: number;
    styleFileCount: number;
    generatedFileCount: number;
    noiseFileCount: number;
    symbolCount: number;
    repeatedFileTouchCount: number;
    activeFileCount: number;
    savedFileCount: number;
    editCount: number;
    terminalFailureCount: number;
    terminalSuccessCount: number;
    recoveryCount: number;
    buildValidationSuccessCount: number;
    commitCount: number;
    featurePathCount: number;
    focusKnown: boolean;
    focusAgeMinutes: number;
    sessionMinutes: number;
    timeSinceLastActivityMinutes: number;
    burstDurationMinutes: number;
    burstFileCount: number;
    burstSourceFileCount: number;
    burstHasStabilitySignal: boolean;
    burstPauseStable: boolean;
    onlyNoiseFilesChanged: boolean;
    onlyFormattingOrDocsChanged: boolean;
    likelyMassiveBurst: boolean;
    hasBuildStabilitySignal: boolean;
    hasCommitSignal: boolean;
    hasRecoverySignal: boolean;
    stagedCount: number | null;
    unstagedCount: number | null;
    untrackedCount: number | null;
    recentAutoSuggestionMinutes: number | null;
}

const IGNORED_COMMANDS = [
    'cd',
    'ls',
    'dir',
    'clear',
    'cls',
    'pwd',
    'echo',
    'cat',
    'type',
    'history',
    'which',
    'where',
    'whoami',
    'exit',
    'alias',
    'export',
    'set',
    'env',
    'printenv',
    'man',
    'help',
    'less',
    'more',
    'head',
    'tail',
];

const SOURCE_EXTENSIONS = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.py',
    '.rs',
    '.go',
    '.java',
    '.cpp',
    '.c',
    '.h',
    '.hpp',
    '.cs',
    '.kt',
    '.swift',
    '.rb',
    '.php',
    '.sql',
]);

const STYLE_EXTENSIONS = new Set(['.css', '.scss', '.sass', '.less']);
const CONFIG_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.toml', '.ini', '.env']);
const DOC_EXTENSIONS = new Set(['.md', '.rst', '.txt']);
const FEATURE_PATH_PATTERNS = /(route|routes|api|component|components|page|pages|command|commands|config|controller|service|hook|hooks|store|module|modules|layout|screen|feature|features|middleware)/i;
const BUILD_VALIDATION_PATTERNS = /\b((npm|pnpm|yarn|bun)\s+(run\s+)?(build|test|compile|package)\b|(npm|pnpm|yarn|bun)\s+(build|test|compile|package)\b|jest|vitest|mocha|pytest|cargo\s+test|go\s+test|dotnet\s+test|mvn\s+test|gradle\s+test)\b/i;

export class WorkSignalManager {
    private readonly workspaceState: vscode.Memento;
    private readonly timeline: Array<{ kind: string; timestamp: number }> = [];
    private readonly fileStats = new Map<string, FileTouchStats>();
    private readonly commandStats = new Map<string, CommandStats>();
    private readonly symbolCaptureCooldown = new Map<string, number>();
    private readonly autoMetaKey = 'devghost.workSignalAutoMeta';
    private readonly autoMeta: AutoDraftMeta;
    private currentFocus = '';
    private focusSinceAt = 0;
    private lastActivityAt = 0;
    private burstStartedAt = 0;
    private burstLastActivityAt = 0;
    private burstTouchedFiles = new Set<string>();
    private burstTouchedSourceFiles = new Set<string>();
    private burstTouchedSymbols = new Set<string>();
    private burstBuildValidationSuccesses = 0;
    private sessionCommitCount = 0;
    private burstHasRecoverySignal = false;

    constructor(workspaceState: vscode.Memento, _outputChannel?: vscode.OutputChannel) {
        this.workspaceState = workspaceState;
        this.autoMeta = workspaceState.get<AutoDraftMeta>(this.autoMetaKey, {
            lastSuggestedAt: null,
            lastEventKey: null,
        }) ?? {
            lastSuggestedAt: null,
            lastEventKey: null,
        };
    }

    recordActiveFile(document: vscode.TextDocument | undefined | null): void {
        if (!document || document.uri.scheme !== 'file') return;
        const filePath = document.uri.fsPath;
        if (shouldSkipSensitivePath(filePath)) return;
        this.touchFile(filePath, document.languageId, 'active');
    }

    recordTextChange(document: vscode.TextDocument): void {
        if (document.uri.scheme !== 'file') return;
        const filePath = document.uri.fsPath;
        if (shouldSkipSensitivePath(filePath)) return;
        this.touchFile(filePath, document.languageId, 'edit');
    }

    async recordSave(document: vscode.TextDocument): Promise<void> {
        if (document.uri.scheme !== 'file') return;
        const filePath = document.uri.fsPath;
        if (shouldSkipSensitivePath(filePath)) return;
        this.touchFile(filePath, document.languageId, 'save');
        await this.captureSymbols(document);
    }

    recordTerminalExecution(command: string, exitCode: number | undefined, _terminalName?: string): void {
        if (exitCode === undefined) return;
        const normalized = this.normalizeCommand(command);
        if (!normalized) return;
        const baseCommand = normalized.split(/\s+/)[0];
        if (this.isIgnoredCommand(baseCommand, normalized)) return;

        this.advanceBurst(Date.now());

        const now = Date.now();
        const stats = this.commandStats.get(normalized) ?? {
            failures: 0,
            successes: 0,
            lastFailureAt: null,
            lastSuccessAt: null,
            recovered: false,
        };

        if (exitCode === 0) {
            stats.successes++;
            stats.lastSuccessAt = now;
            if (stats.failures > 0) {
                stats.recovered = true;
                this.burstHasRecoverySignal = true;
            }
            if (this.isBuildValidationCommand(normalized)) {
                this.burstBuildValidationSuccesses++;
                this.burstHasRecoverySignal = true;
            }
        } else {
            stats.failures++;
            stats.lastFailureAt = now;
        }

        this.commandStats.set(normalized, stats);
        this.lastActivityAt = now;
        this.burstLastActivityAt = now;
        this.timeline.push({ kind: exitCode === 0 ? 'terminal_success' : 'terminal_failure', timestamp: now });
        this.trimTimeline();
    }

    recordCommit(_analysis: CommitAnalysis): void {
        const now = Date.now();
        this.advanceBurst(now);
        this.lastActivityAt = now;
        this.burstLastActivityAt = now;
        this.sessionCommitCount++;
        this.burstHasRecoverySignal = true;
        this.timeline.push({ kind: 'commit', timestamp: now });
        this.trimTimeline();
    }

    recordFocus(focus: string): void {
        const trimmed = focus.trim();
        const now = Date.now();
        if (!trimmed) {
            this.currentFocus = '';
            this.focusSinceAt = 0;
            return;
        }

        if (trimmed !== this.currentFocus) {
            this.currentFocus = trimmed;
            this.focusSinceAt = now;
            this.timeline.push({ kind: 'focus', timestamp: now });
            this.trimTimeline();
        } else if (this.focusSinceAt === 0) {
            this.focusSinceAt = now;
        }
    }

    recordAutomaticSuggestion(eventKey: string): void {
        const now = Date.now();
        this.autoMeta.lastSuggestedAt = now;
        this.autoMeta.lastEventKey = eventKey;
        void this.workspaceState.update(this.autoMetaKey, this.autoMeta).then(
            () => undefined,
            () => undefined
        );
        this.timeline.push({ kind: 'auto_draft', timestamp: now });
        this.trimTimeline();
    }

    resetLocalSignals(): void {
        this.fileStats.clear();
        this.commandStats.clear();
        this.symbolCaptureCooldown.clear();
        this.timeline.length = 0;
        this.burstStartedAt = 0;
        this.burstLastActivityAt = 0;
        this.burstTouchedFiles = new Set<string>();
        this.burstTouchedSourceFiles = new Set<string>();
        this.burstTouchedSymbols = new Set<string>();
        this.burstBuildValidationSuccesses = 0;
        this.sessionCommitCount = 0;
        this.burstHasRecoverySignal = false;
        this.lastActivityAt = 0;
        this.autoMeta.lastSuggestedAt = null;
        this.autoMeta.lastEventKey = null;
        void this.workspaceState.update(this.autoMetaKey, this.autoMeta).then(
            () => undefined,
            () => undefined
        );
    }

    getMinutesSinceLastAutomaticSuggestion(now: number = Date.now()): number | null {
        if (!this.autoMeta.lastSuggestedAt) return null;
        return Math.floor((now - this.autoMeta.lastSuggestedAt) / 60000);
    }

    evaluateAutomaticDraft(input: AutomaticDraftInput): AutomaticDraftDecision {
        const now = Date.now();
        const snapshot = this.buildSnapshot(now, input.focusAgeMinutes, input.sessionMinutes, input.workspaceRoot, input.hints);

        const reasons: string[] = [];
        const blockers: string[] = [];
        let score = 0;

        if (!input.canPostToday) {
            blockers.push('daily draft limit reached');
        }

        if (!input.hasBaselineSummary) {
            blockers.push('project context is not ready');
        }

        if (!input.currentFocus.trim() && input.sessionMinutes < 20 && snapshot.commitCount === 0 && snapshot.recoveryCount === 0) {
            blockers.push('not enough focus or session context yet');
        }

        const recentAutoSuggestionMinutes = snapshot.recentAutoSuggestionMinutes;
        if (recentAutoSuggestionMinutes !== null && recentAutoSuggestionMinutes < AUTO_DRAFT_COOLDOWN_MINUTES) {
            blockers.push(`auto draft cooldown active (${recentAutoSuggestionMinutes}m since last suggestion)`);
        }

        if (snapshot.onlyNoiseFilesChanged && input.trigger !== 'COMMIT_DETECTED') {
            blockers.push('only generated, lock, or build output files changed');
        }

        if (snapshot.likelyMassiveBurst && !snapshot.burstHasStabilitySignal && input.trigger !== 'COMMIT_DETECTED') {
            blockers.push('recent burst is not stable yet');
        }

        score += this.triggerBaseScore(input.trigger);
        reasons.push(`${input.trigger.toLowerCase().replace(/_/g, ' ')} trigger +${this.triggerBaseScore(input.trigger)}`);

        if (snapshot.hasRecoverySignal) {
            score += 60;
            reasons.push('failed command later succeeded +60');
        }

        if (snapshot.hasBuildStabilitySignal) {
            score += 50;
            reasons.push('build, test, or package passed +50');
        }

        const isDocsFocused = this.isDocsFocused(input.currentFocus);
        const commit = input.hints?.commitAnalysis;
        const isMeaningfulCommit = commit && (
            commit.workType === 'feature' || 
            commit.workType === 'bugfix' || 
            commit.workType === 'security' ||
            snapshot.sourceFileCount > 0 ||
            snapshot.configFileCount > 0
        );

        if (snapshot.hasCommitSignal) {
            if (isMeaningfulCommit) {
                score += 50;
                reasons.push('meaningful commit evidence +50');
            } else if (input.trigger === 'COMMIT_DETECTED') {
                score += 15;
                reasons.push('maintenance/docs commit +15');
            } else {
                score += 30;
                reasons.push('commit signal in session +30');
            }
        }

        if (snapshot.featurePathCount > 0) {
            score += 40;
            reasons.push('route, API, component, or config work detected +40');
        }

        if (input.focusAgeMinutes >= 60) {
            score += 35;
            reasons.push('focus steady for 60+ minutes +35');
        }

        if (snapshot.sourceFileCount >= 3) {
            score += 25;
            reasons.push('three or more source files touched +25');
        }

        if (snapshot.repeatedFileTouchCount >= 3) {
            score += 20;
            reasons.push('same file touched repeatedly +20');
        }

        if (input.sessionMinutes >= 45) {
            score += 15;
            reasons.push('session has run for a while +15');
        }

        if (input.sessionMinutes >= 90) {
            score += 10;
            reasons.push('long session bonus +10');
        }

        if (snapshot.symbolCount > 0) {
            score += 10;
            reasons.push('symbols touched +10');
        }

        if (input.currentFocus.trim()) {
            score += 10;
            reasons.push('focus is set +10');
        } else {
            score -= 20;
            reasons.push('focus missing -20');
        }

        if (snapshot.onlyFormattingOrDocsChanged) {
            if (isDocsFocused) {
                score += 10;
                reasons.push('focused docs/readme work +10');
            } else {
                score -= 40;
                reasons.push(input.trigger === 'COMMIT_DETECTED' ? 'commit is docs/formatting only (not focus) -40' : 'changes look like formatting or docs only -40');
            }
        }

        if (snapshot.noiseFileCount > 0 && snapshot.sourceFileCount === 0) {
            score -= 60;
            reasons.push(input.trigger === 'COMMIT_DETECTED' ? 'commit is lockfile/generated noise only -60' : 'generated or lockfile noise dominates -60');
        }

        if (snapshot.recentAutoSuggestionMinutes !== null && snapshot.recentAutoSuggestionMinutes < 60) {
            score -= 60;
            reasons.push('recent automatic draft suggestion -60');
        }

        if (snapshot.burstHasStabilitySignal) {
            reasons.push('burst has a stability signal');
        }

        if (snapshot.timeSinceLastActivityMinutes >= STABILITY_PAUSE_MINUTES) {
            reasons.push(`paused for ${snapshot.timeSinceLastActivityMinutes} minutes`);
        }

        if (input.hints?.recentCommits?.length) {
            const commitBonus = Math.min(20, input.hints.recentCommits.length * 5);
            score += commitBonus;
            reasons.push(`recent commit history +${commitBonus}`);
        }

        if (input.hints?.failedCommands?.length) {
            const failureBonus = Math.min(20, input.hints.failedCommands.length * 4);
            score += failureBonus;
            reasons.push(`recent failed commands +${failureBonus}`);
        }

        if (input.hints?.durationMinutes && input.hints.durationMinutes >= 60) {
            score += 10;
            reasons.push('long-lived friction or work session +10');
        }

        if (input.hints?.strugglesCount && input.hints.strugglesCount >= 3) {
            score += 10;
            reasons.push('multiple struggles recorded +10');
        }

        if (snapshot.onlyNoiseFilesChanged && !snapshot.burstHasStabilitySignal) {
            score = Math.min(score, 20);
        }

        if (!snapshot.burstHasStabilitySignal && snapshot.likelyMassiveBurst) {
            score = Math.min(score, 25);
        }

        if (score < AUTO_DRAFT_SCORE_THRESHOLD) {
            blockers.push(`score ${score}/${AUTO_DRAFT_SCORE_THRESHOLD} below threshold`);
        }

        const allowed = blockers.length === 0 && score >= AUTO_DRAFT_SCORE_THRESHOLD;
        return {
            allowed,
            score,
            threshold: AUTO_DRAFT_SCORE_THRESHOLD,
            reasons: this.uniqueOrdered(reasons),
            blockers: this.uniqueOrdered(blockers),
            burstStable: snapshot.burstHasStabilitySignal,
        };
    }

    getTimelineSummary(limit: number = 12): string {
        const recent = this.timeline.slice(-limit);
        if (recent.length === 0) {
            return 'No recent local signals.';
        }

        return recent
            .map((event) => `[${new Date(event.timestamp).toLocaleTimeString()}] ${event.kind}`)
            .join('\n');
    }

    private buildSnapshot(now: number, focusAgeMinutes: number, sessionMinutes: number, workspaceRoot: string, hints?: AutomaticDraftHints): SignalSnapshot {
        const uniqueFiles = [...this.fileStats.values()];
        const uniqueFileCount = this.fileStats.size;
        const sourceFileCount = uniqueFiles.filter((file) => file.category === 'source').length;
        const configFileCount = uniqueFiles.filter((file) => file.category === 'config').length;
        const docsFileCount = uniqueFiles.filter((file) => file.category === 'docs').length;
        const styleFileCount = uniqueFiles.filter((file) => file.category === 'style').length;
        const generatedFileCount = uniqueFiles.filter((file) => file.category === 'generated').length;
        const noiseFileCount = uniqueFiles.filter((file) => file.category === 'noise').length;
        const symbolCount = uniqueFiles.reduce((sum, file) => sum + file.symbols.size, 0) + this.burstTouchedSymbols.size;
        const repeatedFileTouchCount = uniqueFiles.reduce((max, file) => Math.max(max, file.touches), 0);
        const activeFileCount = uniqueFiles.reduce((sum, file) => sum + file.activeHits, 0);
        const savedFileCount = uniqueFiles.reduce((sum, file) => sum + file.saves, 0);
        const editCount = uniqueFiles.reduce((sum, file) => sum + file.touches, 0);
        const terminalFailureCount = [...this.commandStats.values()].reduce((sum, stats) => sum + stats.failures, 0);
        const terminalSuccessCount = [...this.commandStats.values()].reduce((sum, stats) => sum + stats.successes, 0);
        const recoveryCount = [...this.commandStats.values()].filter((stats) => stats.recovered).length;
        const buildValidationSuccessCount = [...this.commandStats.entries()].filter(([command, stats]) => stats.successes > 0 && this.isBuildValidationCommand(command)).length;
        const commitCount = this.sessionCommitCount;
        const featurePathCount = uniqueFiles.filter((file) => file.category === 'source' && FEATURE_PATH_PATTERNS.test(file.filePath)).length;
        const focusKnown = this.currentFocus.trim().length > 0;
        const burstDurationMinutes = this.burstStartedAt > 0 ? Math.floor((now - this.burstStartedAt) / 60000) : 0;
        const burstFileCount = this.burstTouchedFiles.size;
        const burstSourceFileCount = this.burstTouchedSourceFiles.size;
        const burstHasStabilitySignal = this.burstHasRecoverySignal || this.burstBuildValidationSuccesses > 0 || focusAgeMinutes >= 60 || sessionMinutes >= 90;
        const burstPauseStable = this.burstLastActivityAt > 0 ? (now - this.burstLastActivityAt) >= (STABILITY_PAUSE_MINUTES * 60 * 1000) : false;
        const onlyNoiseFilesChanged = uniqueFileCount > 0 && sourceFileCount === 0 && configFileCount === 0 && docsFileCount === 0 && styleFileCount === 0 && (generatedFileCount > 0 || noiseFileCount > 0);
        const onlyFormattingOrDocsChanged = uniqueFileCount > 0 && sourceFileCount === 0 && generatedFileCount === 0 && noiseFileCount === 0 && (docsFileCount > 0 || styleFileCount > 0 || configFileCount > 0);
        const likelyMassiveBurst = burstFileCount >= 8 && !burstHasStabilitySignal && !burstPauseStable;
        const hasBuildStabilitySignal = this.burstBuildValidationSuccesses > 0 || buildValidationSuccessCount > 0;
        const hasCommitSignal = commitCount > 0;
        const hasRecoverySignal = this.burstHasRecoverySignal || recoveryCount > 0;
        const status = this.readGitStatusSummary(workspaceRoot);

        const snap: SignalSnapshot = {
            uniqueFileCount,
            sourceFileCount,
            configFileCount,
            docsFileCount,
            styleFileCount,
            generatedFileCount,
            noiseFileCount,
            symbolCount,
            repeatedFileTouchCount,
            activeFileCount,
            savedFileCount,
            editCount,
            terminalFailureCount,
            terminalSuccessCount,
            recoveryCount,
            buildValidationSuccessCount,
            commitCount,
            featurePathCount: featurePathCount + (status?.featurePathCount ?? 0),
            focusKnown,
            focusAgeMinutes,
            sessionMinutes,
            timeSinceLastActivityMinutes: this.lastActivityAt > 0 ? Math.floor((now - this.lastActivityAt) / 60000) : 0,
            burstDurationMinutes,
            burstFileCount,
            burstSourceFileCount,
            burstHasStabilitySignal: burstHasStabilitySignal || burstPauseStable,
            burstPauseStable,
            onlyNoiseFilesChanged: onlyNoiseFilesChanged || (status ? status.noiseCount > 0 && status.sourceCount === 0 && status.configCount === 0 && status.docsCount === 0 && status.styleCount === 0 : false),
            onlyFormattingOrDocsChanged: onlyFormattingOrDocsChanged || (status ? status.sourceCount === 0 && status.generatedCount === 0 && status.noiseCount === 0 && (status.docsCount > 0 || status.styleCount > 0 || status.configCount > 0) : false),
            likelyMassiveBurst: likelyMassiveBurst || (status ? status.totalChanged >= 8 && !(status.sourceCount > 0 || status.featurePathCount > 0) : false),
            hasBuildStabilitySignal,
            hasCommitSignal,
            hasRecoverySignal,
            stagedCount: status?.stagedCount ?? null,
            unstagedCount: status?.unstagedCount ?? null,
            untrackedCount: status?.untrackedCount ?? null,
            recentAutoSuggestionMinutes: this.getMinutesSinceLastAutomaticSuggestion(now),
        };

        // If we have a commit analysis, augment the snapshot with its evidence
        if (hints?.commitAnalysis) {
            const commit = hints.commitAnalysis;
            const commitFiles = commit.changedFiles || [];
            
            let commitSourceCount = 0;
            let commitConfigCount = 0;
            let commitDocsCount = 0;
            let commitStyleCount = 0;
            let commitGeneratedCount = 0;
            let commitNoiseCount = 0;
            let commitFeaturePathCount = 0;

            for (const f of commitFiles) {
                const cat = this.classifyFilePath(f);
                if (cat === 'source') commitSourceCount++;
                else if (cat === 'config') commitConfigCount++;
                else if (cat === 'docs') commitDocsCount++;
                else if (cat === 'style') commitStyleCount++;
                else if (cat === 'generated') commitGeneratedCount++;
                else commitNoiseCount++;

                if (cat === 'source' && FEATURE_PATH_PATTERNS.test(f)) {
                    commitFeaturePathCount++;
                }
            }

            snap.sourceFileCount = Math.max(snap.sourceFileCount, commitSourceCount);
            snap.configFileCount = Math.max(snap.configFileCount, commitConfigCount);
            snap.docsFileCount = Math.max(snap.docsFileCount, commitDocsCount);
            snap.styleFileCount = Math.max(snap.styleFileCount, commitStyleCount);
            snap.generatedFileCount = Math.max(snap.generatedFileCount, commitGeneratedCount);
            snap.noiseFileCount = Math.max(snap.noiseFileCount, commitNoiseCount);
            snap.featurePathCount = Math.max(snap.featurePathCount, commitFeaturePathCount);
            snap.commitCount = Math.max(snap.commitCount, 1);
            snap.hasCommitSignal = true;

            // Recalculate 'only' flags using commit evidence
            const total = snap.sourceFileCount + snap.configFileCount + snap.docsFileCount + snap.styleFileCount + snap.generatedFileCount + snap.noiseFileCount;
            if (total > 0) {
                snap.onlyNoiseFilesChanged = snap.sourceFileCount === 0 && snap.configFileCount === 0 && snap.docsFileCount === 0 && snap.styleFileCount === 0 && (snap.generatedFileCount > 0 || snap.noiseFileCount > 0);
                snap.onlyFormattingOrDocsChanged = snap.sourceFileCount === 0 && snap.generatedFileCount === 0 && snap.noiseFileCount === 0 && (snap.docsFileCount > 0 || snap.styleFileCount > 0 || snap.configFileCount > 0);
            }
        }

        return snap;
    }

    private readGitStatusSummary(workspaceRoot: string): GitStatusSummary | null {
        if (!workspaceRoot) return null;

        try {
            const raw = execFileSync('git', ['status', '--porcelain'], {
                cwd: workspaceRoot,
                encoding: 'utf-8',
                maxBuffer: 256 * 1024,
            }) as string;

            const lines = raw.split('\n').map((line) => line.trimEnd()).filter(Boolean);
            if (lines.length === 0) {
                return {
                    totalChanged: 0,
                    sourceCount: 0,
                    configCount: 0,
                    docsCount: 0,
                    styleCount: 0,
                    generatedCount: 0,
                    noiseCount: 0,
                    featurePathCount: 0,
                    stagedCount: 0,
                    unstagedCount: 0,
                    untrackedCount: 0,
                };
            }

            let sourceCount = 0;
            let configCount = 0;
            let docsCount = 0;
            let styleCount = 0;
            let generatedCount = 0;
            let noiseCount = 0;
            let featurePathCount = 0;
            let stagedCount = 0;
            let unstagedCount = 0;
            let untrackedCount = 0;

            for (const line of lines) {
                const status = line.slice(0, 2);
                const rawPath = line.slice(3).trim();
                const filePath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() ?? rawPath : rawPath;
                if (!filePath) continue;
                if (status[0] !== ' ' && status[0] !== '?') stagedCount++;
                if (status[1] !== ' ' && status[1] !== '?') unstagedCount++;
                if (status.includes('?')) untrackedCount++;

                const category = this.classifyFilePath(filePath);
                switch (category) {
                    case 'source':
                        sourceCount++;
                        break;
                    case 'config':
                        configCount++;
                        break;
                    case 'docs':
                        docsCount++;
                        break;
                    case 'style':
                        styleCount++;
                        break;
                    case 'generated':
                        generatedCount++;
                        break;
                    default:
                        noiseCount++;
                        break;
                }

                if (category === 'source' && FEATURE_PATH_PATTERNS.test(filePath)) {
                    featurePathCount++;
                }
            }

            return {
                totalChanged: lines.length,
                sourceCount,
                configCount,
                docsCount,
                styleCount,
                generatedCount,
                noiseCount,
                featurePathCount,
                stagedCount,
                unstagedCount,
                untrackedCount,
            };
        } catch {
            return null;
        }
    }

    private touchFile(filePath: string, languageId: string, kind: 'edit' | 'save' | 'active'): void {
        this.advanceBurst(Date.now());

        const now = Date.now();
        const category = this.classifyFilePath(filePath);
        const fileKey = filePath;
        const current = this.fileStats.get(fileKey) ?? {
            filePath,
            touches: 0,
            saves: 0,
            activeHits: 0,
            firstTouchedAt: now,
            lastTouchedAt: now,
            languageId,
            category,
            symbols: new Set<string>(),
        };

        current.lastTouchedAt = now;
        current.filePath = filePath;
        current.languageId = languageId;
        current.category = category;

        if (kind === 'edit') {
            current.touches++;
        } else if (kind === 'save') {
            current.saves++;
        } else {
            current.activeHits++;
        }

        this.fileStats.set(fileKey, current);
        this.lastActivityAt = now;
        this.burstLastActivityAt = now;
        this.burstTouchedFiles.add(fileKey);
        if (category === 'source') {
            this.burstTouchedSourceFiles.add(fileKey);
        }
        this.timeline.push({ kind, timestamp: now });
        this.trimTimeline();
    }

    private async captureSymbols(document: vscode.TextDocument): Promise<void> {
        const filePath = document.uri.fsPath;
        const now = Date.now();
        const lastCapture = this.symbolCaptureCooldown.get(filePath) ?? 0;
        if (now - lastCapture < 30_000) {
            return;
        }

        this.symbolCaptureCooldown.set(filePath, now);

        try {
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                document.uri
            );

            if (!Array.isArray(symbols) || symbols.length === 0) {
                return;
            }

            const names = this.collectSymbolNames(symbols);
            if (names.length === 0) {
                return;
            }

            const current = this.fileStats.get(filePath);
            if (!current) {
                return;
            }

            for (const name of names) {
                current.symbols.add(name);
                this.burstTouchedSymbols.add(name);
            }
        } catch {
            return;
        }
    }

    private collectSymbolNames(symbols: vscode.DocumentSymbol[]): string[] {
        const names: string[] = [];
        const visit = (items: vscode.DocumentSymbol[]): void => {
            for (const item of items) {
                if (
                    item.kind === vscode.SymbolKind.Function ||
                    item.kind === vscode.SymbolKind.Method ||
                    item.kind === vscode.SymbolKind.Class ||
                    item.kind === vscode.SymbolKind.Interface ||
                    item.kind === vscode.SymbolKind.Enum ||
                    item.kind === vscode.SymbolKind.Module ||
                    item.kind === vscode.SymbolKind.Struct
                ) {
                    names.push(item.name);
                }
                if (item.children.length > 0) {
                    visit(item.children);
                }
            }
        };
        visit(symbols);
        return [...new Set(names)];
    }

    private advanceBurst(now: number): void {
        if (this.burstLastActivityAt > 0 && now - this.burstLastActivityAt > BURST_RESET_MINUTES * 60 * 1000) {
            this.burstStartedAt = now;
            this.burstTouchedFiles = new Set<string>();
            this.burstTouchedSourceFiles = new Set<string>();
            this.burstTouchedSymbols = new Set<string>();
            this.burstBuildValidationSuccesses = 0;
            this.burstHasRecoverySignal = false;
        } else if (this.burstStartedAt === 0) {
            this.burstStartedAt = now;
        }
    }

    private classifyFilePath(filePath: string): FileCategory {
        if (!filePath) return 'other';

        if (shouldSkipSensitivePath(filePath)) {
            return 'noise';
        }

        const normalized = filePath.replace(/\\/g, '/').toLowerCase();
        const basename = path.basename(normalized);
        const ext = path.extname(normalized);

        if (
            normalized.includes('/node_modules/') ||
            normalized.includes('/.git/') ||
            normalized.includes('/dist/') ||
            normalized.includes('/build/') ||
            normalized.includes('/out/') ||
            normalized.includes('/coverage/') ||
            normalized.includes('/.next/') ||
            normalized.includes('/snapshots/') ||
            /^package-lock\.json$/.test(basename) ||
            /^yarn\.lock$/.test(basename) ||
            /^pnpm-lock\.yaml$/.test(basename)
        ) {
            return 'generated';
        }

        if (DOC_EXTENSIONS.has(ext) || /(^|\/)(readme|changelog|license)(\.[^.]+)?$/.test(basename)) {
            return 'docs';
        }

        if (STYLE_EXTENSIONS.has(ext)) {
            return 'style';
        }

        if (CONFIG_EXTENSIONS.has(ext) || /(^|\/)package\.json$/.test(normalized) || /\.env(\..+)?$/.test(basename)) {
            return 'config';
        }

        if (SOURCE_EXTENSIONS.has(ext)) {
            return 'source';
        }

        if (FEATURE_PATH_PATTERNS.test(normalized)) {
            return 'source';
        }

        return 'other';
    }

    private normalizeCommand(command: string): string {
        return String(command ?? '').replace(/\s+/g, ' ').trim();
    }

    private isIgnoredCommand(baseCommand: string, fullCommand: string): boolean {
        if (IGNORED_COMMANDS.some((ignored) => baseCommand === ignored || baseCommand.endsWith('/' + ignored))) {
            return true;
        }

        return /^git\s+(status|diff|show|log|branch|checkout|switch|fetch|pull|push)\b/i.test(fullCommand);
    }

    private isBuildValidationCommand(command: string): boolean {
        return BUILD_VALIDATION_PATTERNS.test(command);
    }

    private triggerBaseScore(trigger: AutomaticDraftTrigger): number {
        switch (trigger) {
            case 'FRICTION_BREAKTHROUGH':
                return 35;
            case 'DEEP_WORK_WRAP_UP':
                return 30;
            case 'SILENCE_BREAKER':
                return 20;
            case 'COMMIT_DETECTED':
                return 30;
            case 'WARMUP_RETURN':
                return 18;
            case 'PROJECT_RESUME':
                return 15;
            case 'PROJECT_LAUNCH':
                return 12;
            case 'FOCUS_INTENT':
                return 8;
            default:
                return 0;
        }
    }

    private isDocsFocused(focus: string): boolean {
        const lower = focus.toLowerCase();
        return lower.includes('doc') || 
               lower.includes('readme') || 
               lower.includes('changelog') || 
               lower.includes('release') || 
               lower.includes('testing') || 
               lower.includes('markdown');
    }

    private uniqueOrdered(values: string[]): string[] {
        const seen = new Set<string>();
        const result: string[] = [];
        for (const value of values) {
            if (!seen.has(value)) {
                seen.add(value);
                result.push(value);
            }
        }
        return result;
    }

    private trimTimeline(): void {
        if (this.timeline.length > 250) {
            this.timeline.splice(0, this.timeline.length - 250);
        }
    }
}
