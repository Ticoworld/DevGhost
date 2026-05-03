import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ContextManager, SessionManager, GitManager, HistoryManager, WorkSignalManager, CommitAnalysis, AutomaticDraftDecision } from './managers';
import { KeyManager, GeminiService } from './analyzer';
import { scanProjectEnvironment } from './analyzer/projectScanner';

/**
 * DevGhost 2.0 - Session-Based "Build in Public" Automation
 * 
 * THE PIVOT: We no longer track syntax errors (that was spam).
 * Instead, we track TIME + STRUGGLE + CONTEXT + GIT.
 * 
 * Architecture:
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │                          DevGhost 2.0                                  │
 * ├────────────────────────────────────────────────────────────────────────┤
 * │  ContextManager  │  SessionManager  │  GitManager   │  GeminiService   │
 * │  (workspaceState)│  (Commands)      │  (Commits)    │  (AI Tweets)     │
 * │                  │                  │               │                  │
 * │  "What are you   │  "What failed?   │  "What did    │  "Let me write   │
 * │   building?"     │   What worked?"  │   you commit?"│   that story"    │
 * └────────────────────────────────────────────────────────────────────────┘
 */

// Global references
let outputChannel: vscode.OutputChannel | undefined;
let contextManager: ContextManager | undefined;
let sessionManager: SessionManager | undefined;
let gitManager: GitManager | undefined;
let historyManager: HistoryManager | undefined;
let workSignalManager: WorkSignalManager | undefined;
let keyManager: KeyManager | undefined;
let geminiService: GeminiService | undefined;
let workspaceState: vscode.Memento | undefined;
let lastAutomaticDraftDecision: { eventKey: string; decision: AutomaticDraftDecision } | null = null;

// Phase 8: Agentic Intelligence
import { AgenticBrain } from './agent/AgenticBrain';
import { AgentTools } from './agent/AgentTools';

let agenticBrain: AgenticBrain | undefined;

/** Resolves when API key has been loaded from SecretStorage and Gemini (if any) is initialized. Ensures handlers do not run before key load in packaged VSIX. */
let geminiReadyPromise: Promise<void> = Promise.resolve();

// Phase 6A: (legacy) snooze tracking removed in Phase 3

const CONTROL_STATE_KEY = 'devghost.controlState';
const AUTO_DRAFT_STATE_KEY = 'devghost.autoDraftState';
const AUTO_DRAFT_SNOOZE_MS = 30 * 60 * 1000;
const AUTO_DRAFT_HANDLED_LIMIT = 100;
const AUTO_DRAFT_PROMPT_TEXT = 'DevGhost noticed something worth sharing from your recent work.';

type ControlState = {
    paused: boolean;
    pausedAt: string | null;
};

type AutoDraftState = {
    snoozedUntil: number;
    handledEventKeys: string[];
};

function getControlState(): ControlState {
    return workspaceState?.get<ControlState>(CONTROL_STATE_KEY, {
        paused: false,
        pausedAt: null,
    }) ?? {
        paused: false,
        pausedAt: null,
    };
}

async function updateControlState(updater: (state: ControlState) => ControlState): Promise<void> {
    if (!workspaceState) return;
    await workspaceState.update(CONTROL_STATE_KEY, updater(getControlState()));
}

function isDevGhostPaused(): boolean {
    return getControlState().paused;
}

async function setDevGhostPaused(paused: boolean): Promise<void> {
    await updateControlState(() => ({
        paused,
        pausedAt: paused ? new Date().toISOString() : null,
    }));
}

function getAutoDraftState(): AutoDraftState {
    return workspaceState?.get<AutoDraftState>(AUTO_DRAFT_STATE_KEY, {
        snoozedUntil: 0,
        handledEventKeys: [],
    }) ?? {
        snoozedUntil: 0,
        handledEventKeys: [],
    };
}

async function updateAutoDraftState(updater: (state: AutoDraftState) => AutoDraftState): Promise<void> {
    if (!workspaceState) return;
    await workspaceState.update(AUTO_DRAFT_STATE_KEY, updater(getAutoDraftState()));
}

async function markAutoDraftHandled(eventKey: string): Promise<void> {
    await updateAutoDraftState((state) => {
        const nextKeys = state.handledEventKeys.includes(eventKey)
            ? state.handledEventKeys
            : [...state.handledEventKeys, eventKey];
        return {
            snoozedUntil: state.snoozedUntil,
            handledEventKeys: nextKeys.slice(-AUTO_DRAFT_HANDLED_LIMIT),
        };
    });
}

async function snoozeAutoDraftPrompts(): Promise<void> {
    await updateAutoDraftState((state) => ({
        snoozedUntil: Date.now() + AUTO_DRAFT_SNOOZE_MS,
        handledEventKeys: state.handledEventKeys.slice(-AUTO_DRAFT_HANDLED_LIMIT),
    }));
}

function getAutoDraftSuppressionReason(eventKey: string): 'snoozed' | 'handled' | null {
    const state = getAutoDraftState();
    if (Date.now() < state.snoozedUntil) {
        return 'snoozed';
    }
    if (state.handledEventKeys.includes(eventKey)) {
        return 'handled';
    }
    return null;
}

function logSanitization(event: {
    label: string;
    redactedSensitiveLines: number;
    removedSensitiveFiles: number;
    shortenedPaths: number;
    truncated: boolean;
}): void {
    outputChannel?.appendLine(
        `[DevGhost] Sanitized ${event.label} before Gemini (${event.redactedSensitiveLines} sensitive lines, ${event.removedSensitiveFiles} sensitive files, ${event.shortenedPaths} shortened paths${event.truncated ? ', truncated' : ''}).`
    );
}

function canDraftPostOrWarn(isManual?: boolean): boolean {
    if (isManual === true) return true;
    if (!historyManager) return true;
    const ok = historyManager.canPostToday();
    if (!ok) {
        outputChannel?.appendLine('[DevGhost] ⚠️ Daily draft limit reached (3 drafts / 24h). Aborting AI draft.');
    }
    return ok;
}

function rememberAutomaticDraftDecision(eventKey: string, decision: AutomaticDraftDecision): void {
    lastAutomaticDraftDecision = { eventKey, decision };
}

function consumeAutomaticDraftDecision(eventKey: string): AutomaticDraftDecision | null {
    if (lastAutomaticDraftDecision?.eventKey !== eventKey) {
        return null;
    }

    const decision = lastAutomaticDraftDecision.decision;
    lastAutomaticDraftDecision = null;
    return decision;
}

type CommitFileCategory = 'source' | 'config' | 'docs' | 'style' | 'generated' | 'other';

function classifyCommitFile(filePath: string): CommitFileCategory {
    if (!filePath) return 'other';

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

    if (['.md', '.rst', '.txt'].includes(ext) || /(^|\/)(readme|changelog|license)(\.[^.]+)?$/.test(basename)) {
        return 'docs';
    }

    if (['.css', '.scss', '.sass', '.less'].includes(ext)) {
        return 'style';
    }

    if (['.json', '.yaml', '.yml', '.toml', '.ini', '.env'].includes(ext) || /(^|\/)package\.json$/.test(normalized) || /\.env(\..+)?$/.test(basename)) {
        return 'config';
    }

    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.cpp', '.c', '.h', '.hpp', '.cs', '.kt', '.swift', '.rb', '.php', '.sql'].includes(ext)) {
        return 'source';
    }

    if (/(route|routes|api|component|components|page|pages|command|commands|config|controller|service|hook|hooks|store|module|modules|layout|screen|feature|features|middleware)/i.test(normalized)) {
        return 'source';
    }

    return 'other';
}

function buildCompactCommitSummary(analysis: CommitAnalysis): { compactDiffSummary: string; fileCategories: string } {
    const counts: Record<CommitFileCategory, number> = {
        source: 0,
        config: 0,
        docs: 0,
        style: 0,
        generated: 0,
        other: 0,
    };

    const topFiles = (analysis.changedFiles ?? []).slice(0, 8).map((filePath) => {
        const category = classifyCommitFile(filePath);
        counts[category]++;
        return `${filePath} (${category})`;
    });

    for (const filePath of (analysis.changedFiles ?? []).slice(topFiles.length)) {
        const category = classifyCommitFile(filePath);
        counts[category]++;
    }

    const fileCategories = (Object.entries(counts) as Array<[CommitFileCategory, number]>)
        .filter(([, count]) => count > 0)
        .map(([category, count]) => `${category}: ${count}`)
        .join(', ') || 'none';

    const topFilesText = topFiles.length > 0 ? topFiles.join(', ') : 'none';
    const compactDiffSummary = `+${analysis.additions} / -${analysis.deletions} across ${analysis.filesChanged} files; file mix: ${fileCategories}; top files: ${topFilesText}`;

    return {
        compactDiffSummary,
        fileCategories,
    };
}

function inferWhyItMatters(analysis: CommitAnalysis): string {
    const fileBlob = (analysis.changedFiles ?? []).join(' ').toLowerCase();

    if (/(src\/(agent|managers|extension|analyzer)|worksignalmanager|gitmanager|sessionmanager|agenticbrain)/i.test(fileBlob)) {
        return 'it changes core drafting or signal-tracking behavior, so future drafts should reflect real work more accurately.';
    }

    if (analysis.workType === 'feature') {
        return 'it adds product behavior that users can feel.';
    }

    if (analysis.workType === 'bugfix') {
        return 'it fixes a workflow problem that was blocking progress.';
    }

    if (analysis.workType === 'refactor') {
        return 'it reorganizes code to make the system easier to maintain.';
    }

    return 'why not clear from available evidence';
}

function inferUserFacingResult(analysis: CommitAnalysis): string {
    const fileBlob = (analysis.changedFiles ?? []).join(' ').toLowerCase();

    if (/(src\/(agent|managers|extension|analyzer)|worksignalmanager|gitmanager|sessionmanager|agenticbrain)/i.test(fileBlob)) {
        return 'review-first draft behavior should mirror the work signal more accurately.';
    }

    if (analysis.workType === 'feature') {
        return 'users should get a new or improved behavior from this change.';
    }

    if (analysis.workType === 'bugfix') {
        return 'a visible problem in the workflow should be reduced.';
    }

    return 'why not clear from available evidence';
}

// Phase 3: Terminal friction breakthrough — failure streak persisted in workspaceState (key below)
const TERMINAL_FAILURE_STREAK_KEY = 'devghost.terminalFailureStreak';

/**
 * Resolve workspace root for git/agent operations.
 * Hierarchy: active file → workspace folder → ask user (monorepo-safe).
 */
function resolveWorkspaceRoot(): string {
    // 1. Best: active editor's file - walk up to find .git
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor?.document?.uri) {
        let dir = path.dirname(activeEditor.document.uri.fsPath);
        while (dir && dir !== path.dirname(dir)) {
            if (fs.existsSync(path.join(dir, '.git'))) {
                return dir;
            }
            dir = path.dirname(dir);
        }
    }

    // 2. Fallback: first workspace folder - walk down to find .git if needed
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceFolder) {
        if (fs.existsSync(path.join(workspaceFolder, '.git'))) {
            return workspaceFolder;
        }
        // Check subfolders for monorepo (e.g. workspace is parent, .git in backend/)
        try {
            const entries = fs.readdirSync(workspaceFolder, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const subPath = path.join(workspaceFolder, entry.name);
                    if (fs.existsSync(path.join(subPath, '.git'))) {
                        return subPath;
                    }
                }
            }
        } catch {
            // Ignore read errors
        }
        return workspaceFolder; // Use as-is if no .git found
    }

    return '';
}

/**
 * Get top 3 most-modified files from git diff --stat and return their diffs (for DEEP_WORK_WRAP_UP).
 * Each element is "=== path ===\n<diff>".
 */
async function getTop3DiffsForDeepWork(workspaceRoot: string): Promise<string[]> {
    const cp = require('child_process');
    let statOut = '';
    try {
        statOut = cp.execSync('git diff --stat HEAD', { cwd: workspaceRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 });
    } catch {
        return [];
    }
    const lines = statOut.split('\n').filter((l: string) => l.trim().length > 0);
    const entries: { path: string; changes: number }[] = [];
    for (const line of lines) {
        const pipeIdx = line.lastIndexOf('|');
        if (pipeIdx === -1) continue;
        const pathPart = line.slice(0, pipeIdx).trim();
        const numPart = line.slice(pipeIdx + 1).trim();
        const numMatch = numPart.match(/\d+/);
        const changes = numMatch ? parseInt(numMatch[0], 10) : 0;
        if (pathPart) entries.push({ path: pathPart, changes });
    }
    entries.sort((a, b) => b.changes - a.changes);
    const top3 = entries.slice(0, 3).map((e) => e.path);
    const result: string[] = [];
    for (const p of top3) {
        try {
            const diff = cp.execSync('git', ['diff', 'HEAD', '--', p], {
                cwd: workspaceRoot,
                encoding: 'utf-8',
                maxBuffer: 512 * 1024,
            });
            result.push(`=== ${p} ===\n${diff}`);
        } catch {
            result.push(`=== ${p} ===\n(no diff)`);
        }
    }
    return result;
}

type DraftFlowOptions = {
    label: string;
    createDraft: () => Promise<string | null>;
    automatic?: boolean;
    eventKey?: string;
    onOpen?: () => Promise<void> | void;
};

type AutomaticDraftGateOptions = {
    trigger: 'PROJECT_LAUNCH' | 'PROJECT_RESUME' | 'FRICTION_BREAKTHROUGH' | 'DEEP_WORK_WRAP_UP' | 'WARMUP_RETURN' | 'SILENCE_BREAKER' | 'COMMIT_DETECTED' | 'FOCUS_INTENT';
    eventKey: string;
    label: string;
    hints?: {
        recentCommits?: string[];
        failedCommands?: string[];
        successCommand?: string;
        durationMinutes?: number;
        strugglesCount?: number;
        commitAnalysis?: CommitAnalysis;
    };
};

async function allowAutomaticDraft(options: AutomaticDraftGateOptions): Promise<boolean> {
    if (isDevGhostPaused()) {
        outputChannel?.appendLine(`[DevGhost] Auto draft skipped (${options.label}): DevGhost is paused.`);
        return false;
    }

    const tracker = workSignalManager;
    const apiKey = await keyManager?.getApiKey();
    if (!apiKey) {
        outputChannel?.appendLine(`[DevGhost] Auto draft skipped (${options.label}): AI key is not ready.`);
        return false;
    }

    if (!tracker) {
        outputChannel?.appendLine(`[DevGhost] Auto draft skipped (${options.label}): local signal tracker is unavailable.`);
        return false;
    }

    const workspaceRoot = resolveWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const config = contextManager?.getConfig();
    const currentFocus = config?.currentFocus || '';
    const focusAgeMinutes = contextManager?.getStruggleDurationMinutes() || 0;
    const sessionMinutes = sessionManager?.getSessionDurationMinutes() || 0;
    const hasBaselineSummary = contextManager?.hasBaselineSummary() ?? false;
    const canPostToday = historyManager?.canPostToday() ?? true;
    const decision = tracker.evaluateAutomaticDraft({
        trigger: options.trigger,
        eventKey: options.eventKey,
        workspaceRoot,
        projectName: config?.projectName || 'your project',
        currentFocus,
        focusAgeMinutes,
        sessionMinutes,
        hasBaselineSummary,
        canPostToday,
        hints: options.hints,
    });
    rememberAutomaticDraftDecision(options.eventKey, decision);

    if (!decision.allowed) {
        outputChannel?.appendLine(`[DevGhost] Auto draft skipped (${options.label}): score ${decision.score}/${decision.threshold} | ${decision.blockers.join('; ')}`);
        return false;
    }

    outputChannel?.appendLine(`[DevGhost] Auto draft score ${decision.score}/${decision.threshold} (${options.label}): ${decision.reasons.join('; ')}`);
    return true;
}

async function openXDraft(draft: string): Promise<boolean> {
    const encodedDraft = encodeURIComponent(draft);
    const draftUrl = `https://twitter.com/intent/tweet?text=${encodedDraft}`;

    try {
        return await vscode.env.openExternal(vscode.Uri.parse(draftUrl));
    } catch (error) {
        outputChannel?.appendLine(`[DevGhost] Failed to open X draft: ${error}`);
        return false;
    }
}

async function showDraftReview(draft: string, options?: { onOpen?: () => Promise<void> | void }): Promise<void> {
    const selection = await vscode.window.showInformationMessage(
        draft,
        'Copy draft',
        'Open X draft',
        'Dismiss'
    );

    if (selection === 'Copy draft') {
        await vscode.env.clipboard.writeText(draft);
        await vscode.window.showInformationMessage('Draft copied to clipboard.');
        return;
    }

    if (selection === 'Open X draft') {
        const opened = await openXDraft(draft);
        if (!opened) {
            vscode.window.showErrorMessage('DevGhost could not open the X draft.');
            return;
        }

        historyManager?.logEvent('POST_DRAFTED', { message: draft });
        await options?.onOpen?.();
    }
}

async function ensureGeminiReady(options: { explicit: boolean; reason: string; forceRefresh?: boolean }): Promise<boolean> {
    if (!geminiService) {
        return false;
    }

    if (geminiService.isInitialized()) {
        return true;
    }

    if (isDevGhostPaused() && !options.explicit) {
        outputChannel?.appendLine(`[DevGhost] AI setup skipped (${options.reason}): DevGhost is paused.`);
        return false;
    }

    const apiKey = await keyManager?.getApiKey();
    if (!apiKey) {
        if (options.explicit) {
            await checkApiKeyOnStartup();
        } else {
            outputChannel?.appendLine(`[DevGhost] AI setup skipped (${options.reason}): AI key is not ready.`);
        }
        return false;
    }

    try {
        await geminiService.initialize(apiKey);
        const count = geminiService.getDiscoveredModelsCount() || 0;
        const configured = vscode.workspace.getConfiguration('devghost').get<string>('model', 'auto');
        const resolved = await geminiService.resolveBestModel(options.forceRefresh ?? false);
        if (count === 0) {
            outputChannel?.appendLine('[DevGhost] Model discovery returned 0 compatible models.');
            outputChannel?.appendLine(`[DevGhost] Trying fallback model: ${resolved}`);
            
            // Validate the fallback model
            try {
                await geminiService.validateModel(resolved, false);
                outputChannel?.appendLine(`[DevGhost] Fallback model validated: ${resolved}`);
            } catch (vError) {
                const vMsg = vError instanceof Error ? vError.message : String(vError);
                outputChannel?.appendLine(`[DevGhost] Fallback model validation failed: ${vMsg}`);
                throw new Error('No compatible AI model is available for this key.');
            }
        } else {
            outputChannel?.appendLine(`[DevGhost] Discovered ${count} compatible AI models`);
            outputChannel?.appendLine(`[DevGhost] Configured model: ${configured}`);
            outputChannel?.appendLine(`[DevGhost] Selected model: ${resolved}`);
        }
        return true;
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        outputChannel?.appendLine(`[DevGhost] AI setup failed (${options.reason}): ${errMsg}`);
        if (options.explicit) {
            if (/no compatible gemini model/i.test(errMsg) || /no compatible ai model/i.test(errMsg)) {
                vscode.window.showErrorMessage('DevGhost: No compatible AI model is available for this key.');
            } else if (/401|403|invalid|unauthorized/i.test(errMsg)) {
                vscode.window.showErrorMessage('DevGhost: This AI key is invalid.');
            } else if (/429|quota exceeded/i.test(errMsg)) {
                vscode.window.showErrorMessage('DevGhost: This AI key has no available usage left.');
            } else {
                vscode.window.showErrorMessage('DevGhost: DevGhost could not reach the AI service.');
            }
        }
        return false;
    }
}

function noteManualActionWhilePaused(): void {
    if (!isDevGhostPaused()) {
        return;
    }

    void vscode.window.showInformationMessage('DevGhost is paused, but you can still create a draft manually.');
}

async function runDraftFlow(options: DraftFlowOptions): Promise<void> {
    if (options.automatic) {
        const eventKey = options.eventKey || options.label;
        const suppressionReason = getAutoDraftSuppressionReason(eventKey);
        if (suppressionReason) {
            outputChannel?.appendLine(
                suppressionReason === 'snoozed'
                    ? `[DevGhost] Auto draft skipped (${options.label}): snooze is active.`
                    : `[DevGhost] Auto draft skipped (${options.label}): event already handled.`
            );
            return;
        }

        await markAutoDraftHandled(eventKey);
        workSignalManager?.recordAutomaticSuggestion(eventKey);

        const selection = await vscode.window.showInformationMessage(
            AUTO_DRAFT_PROMPT_TEXT,
            'Review draft',
            'Dismiss',
            'Snooze'
        );

        if (selection === 'Snooze') {
            await snoozeAutoDraftPrompts();
            outputChannel?.appendLine('[DevGhost] Auto draft prompts snoozed for 30 minutes.');
            return;
        }

        if (selection !== 'Review draft') {
            return;
        }
    }

    const ready = await ensureGeminiReady({
        explicit: !options.automatic,
        reason: options.label,
    });
    if (!ready) {
        return;
    }

    let draft: string | null;
    try {
        draft = await options.createDraft();
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        outputChannel?.appendLine(`[DevGhost] ${options.label} failed: ${errMsg}`);
        if (/no compatible gemini model/i.test(errMsg) || /no compatible ai model/i.test(errMsg)) {
            vscode.window.showErrorMessage('DevGhost: No compatible AI model is available for this key.');
        } else if (/429|quota exceeded/i.test(errMsg)) {
            vscode.window.showErrorMessage('DevGhost: This AI key has no available usage left.');
        } else if (!options.automatic) {
            vscode.window.showErrorMessage('DevGhost: DevGhost could not reach the AI service.');
        }
        return;
    }
    if (!draft) {
        outputChannel?.appendLine(`[DevGhost] ${options.label}: API unavailable.`);
        return;
    }

    await showDraftReview(draft, { onOpen: options.onOpen });
}

async function handleBreakthroughDraft(durationMinutes: number, failureCount: number, command: string): Promise<void> {
    if (!agenticBrain) {
        return;
    }

    const eventKey = `friction:${command}:${failureCount}:${Math.floor(durationMinutes / 5)}`;
    if (!await allowAutomaticDraft({
        trigger: 'FRICTION_BREAKTHROUGH',
        eventKey,
        label: 'Breakthrough draft',
        hints: {
            failedCommands: sessionManager?.getActiveStruggles(),
            successCommand: command,
            durationMinutes,
            strugglesCount: failureCount,
        },
    })) {
        return;
    }

    await geminiReadyPromise;

    await runDraftFlow({
        automatic: true,
        eventKey,
        label: 'Breakthrough draft',
        createDraft: async () => {
            const baseline = contextManager?.getBaselineSummary() || 'No baseline summary available.';
            const failedCommands = sessionManager?.getActiveStruggles() || [];
            const result = await agenticBrain?.process_trigger('FRICTION_BREAKTHROUGH', {
                baselineSummary: baseline,
                failedCommands,
                successCommand: command,
            } as any);

            if (!result?.ok) {
                if (result) {
                    outputChannel?.appendLine(`[DevGhost] Recent fix draft failed: ${result.message}`);
                }
                return null;
            }

            return result.tweet;
        },
    });
}

/**
 * Extension activation.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // Create output channel
    outputChannel = vscode.window.createOutputChannel('DevGhost Logs');
    context.subscriptions.push(outputChannel);

    // Welcome message
    const version = vscode.extensions.getExtension('devghost.devghost')?.packageJSON.version || '3.3.5';
    outputChannel.appendLine('═══════════════════════════════════════════════════');
    outputChannel.appendLine(`  DevGhost ${version} - Quiet build-in-public companion`);
    outputChannel.appendLine('═══════════════════════════════════════════════════');
    outputChannel.appendLine('');
    outputChannel.appendLine('Watching real coding activity and drafting only when there is enough signal.');
    outputChannel.appendLine('Now tracking: COMMITS + CONTEXT + STORY');
    outputChannel.appendLine('');

    // Initialize the Context Manager (The Brain) — uses workspaceState only
    contextManager = new ContextManager(context.workspaceState, outputChannel);
    await contextManager.initialize();

    context.subscriptions.push(contextManager);
    workspaceState = context.workspaceState;
    workSignalManager = new WorkSignalManager(context.workspaceState, outputChannel);
    workSignalManager.recordFocus(contextManager.getConfig()?.currentFocus || '');
    workSignalManager.recordActiveFile(vscode.window.activeTextEditor?.document ?? null);

    // Phase 10: Model Audit
    const configuredModel = vscode.workspace.getConfiguration('devghost').get<string>('model', 'auto');
    outputChannel.appendLine(`[DevGhost] Configured model: ${configuredModel}`);

    // Initialize the Session Manager (The Nervous System)
    sessionManager = new SessionManager(outputChannel);
    context.subscriptions.push(sessionManager);

    // Initialize the Git Manager (The Historian)
    gitManager = new GitManager(outputChannel, sessionManager.getSession().startTime);
    gitManager.initialize();
    context.subscriptions.push(gitManager);

    // Record commits for history/silence tracking (no automatic AI drafting on commit)
    gitManager.onCommit((analysis) => {
        handleCommitDetected(analysis);
    });

    const activeEditorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
            workSignalManager?.recordActiveFile(editor.document);
        }
    });
    context.subscriptions.push(activeEditorListener);
    if (vscode.window.activeTextEditor) {
        workSignalManager?.recordActiveFile(vscode.window.activeTextEditor.document);
    }

    const textChangeListener = vscode.workspace.onDidChangeTextDocument((event) => {
        workSignalManager?.recordTextChange(event.document);
    });
    context.subscriptions.push(textChangeListener);

    const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
        void workSignalManager?.recordSave(document);
    });
    context.subscriptions.push(saveListener);

    const taskListener = vscode.tasks.onDidEndTaskProcess((event) => {
        const taskName = event.execution.task.name || 'task';
        workSignalManager?.recordTerminalExecution(taskName, event.exitCode, 'task');
    });
    context.subscriptions.push(taskListener);

    // Initialize Gemini (for AI-generated drafts)
    keyManager = new KeyManager(context);
    geminiService = new GeminiService();
    geminiService.setSanitizationReporter((event) => {
        logSanitization(event);
    });
    geminiService.setFallbackReporter(({ kind, reason, errorMessage }) => {
        outputChannel?.appendLine(`[DevGhost] Gemini API (${kind}): ${reason}${errorMessage ? ` - ${errorMessage}` : ''}`);
        if (reason === 'ERROR' && errorMessage && (String(errorMessage).includes('404') || String(errorMessage).includes('401'))) {
            vscode.window.showErrorMessage('DevGhost: No compatible AI model is available for this key.');
        }
    });

    // Load API key from SecretStorage before any handler runs (fixes VSIX: key not ready on first commit)
    geminiReadyPromise = initializeGeminiFromStorage().then(() => checkApiKeyOnStartup());

    // Phase 7: Initialize History Manager (workspaceState only) — before handshake so we can log draft review events
    historyManager = new HistoryManager(context.workspaceState, outputChannel);
    historyManager.onWarmup(async (summary, lastEvents) => {
        handleWarmup(summary, lastEvents);
    });
    historyManager.initialize();
    context.subscriptions.push(historyManager);

    // Phase 8: Initialize draft engine before handshake so we can run PROJECT_LAUNCH / PROJECT_RESUME
    const workspaceRootForBrain = resolveWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const agentTools = new AgentTools(historyManager, workspaceRootForBrain);
    agenticBrain = new AgenticBrain(geminiService, agentTools);

    // Phase 2: New-workspace handshake — ask for explicit setup before any baseline generation
    if (!contextManager.hasContext()) {
        const choice = await vscode.window.showInformationMessage(
            'Set up DevGhost for this project? This helps DevGhost understand what you are building before it suggests drafts.',
            { modal: true },
            'Set up',
            'Not now'
        );

        if (choice === 'Set up') {
            const created = await contextManager.createConfig();
            if (!created) {
                return;
            }

            const workspaceRoot = resolveWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
            const scan = await scanProjectEnvironment(workspaceRoot);

            const apiKey = await keyManager?.getApiKey();
            if (!apiKey) {
                await checkApiKeyOnStartup();
                return;
            }

            if (!await ensureGeminiReady({
                explicit: true,
                reason: 'project setup',
            })) {
                return;
            }

            const introPrompt = [
                'You are DevGhost, an assistant that helps developers build in public.',
                'Using ONLY the scanned environment data below, write a Day One project baseline summary.',
                'Focus on: tech stack, architecture hints, what kind of product this is, and what a reasonable first public narrative would be.',
                'Output format:',
                '- 1 short paragraph (max 5 sentences)',
                '- then 4-7 bullet points for stack + major folders',
                '- end with one sentence that sounds like a human dev starting Day One (#BuildInPublic allowed)',
                '',
                scan,
            ].join('\n');

            let baseline = await geminiService?.generateBaselineFromScan(introPrompt);

            if (!baseline || baseline.trim().length === 0) {
                baseline = `Baseline generation unavailable (no API key / API error).\n\n${scan}`;
            }

            await contextManager.setBaselineSummary(baseline);
            workSignalManager?.recordFocus(contextManager?.getConfig()?.currentFocus || '');
        }
    }

    // Register commands
    registerCommands(context);

    // Phase 7: Set up Silence Breaker handler
    const session = sessionManager;
    if (!session) return;

    session.onSilence((durationMinutes, strugglesCount) => {
        handleSilenceDetected(durationMinutes, strugglesCount);
    });

    session.onBreakthrough((durationMinutes, failureCount, command) => {
        void handleBreakthroughDraft(durationMinutes, failureCount, command);
    });

    // Deep work wrap-up: after the configured active-coding threshold, suggest a review-first draft
    session.onDeepWorkWrapUp(async () => {
        const brain = agenticBrain;
        const workspaceRoot = resolveWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const eventKey = `deep-work:${workspaceRoot || 'workspace'}:${session.getSession().startTime.toISOString()}`;
        if (!brain || !workspaceRoot) return;
        if (!await allowAutomaticDraft({
            trigger: 'DEEP_WORK_WRAP_UP',
            eventKey,
            label: 'Deep work draft',
        })) {
            return;
        }

        await geminiReadyPromise;
        await runDraftFlow({
            automatic: true,
            eventKey,
            label: 'Deep work draft',
            createDraft: async () => {
                const top3Diffs = await getTop3DiffsForDeepWork(workspaceRoot);
                const baseline = contextManager?.getBaselineSummary() || 'No baseline summary available.';
                const result = await brain.process_trigger('DEEP_WORK_WRAP_UP', {
                    baselineSummary: baseline,
                    top3Diffs,
                } as any);
                return result.ok ? result.tweet : null;
            },
        });
    });

    // Phase 3: Friction breakthrough (3+ terminal failures then a success)
    try {
        const frictionListener = vscode.window.onDidEndTerminalShellExecution(
            async (event: vscode.TerminalShellExecutionEndEvent) => {
                const exitCode = event.exitCode;
                if (exitCode === undefined) return;

                const commandLine = event.execution.commandLine;
                const command = commandLine?.value || 'unknown';
                workSignalManager?.recordTerminalExecution(command.trim(), exitCode, event.terminal.name);

                const ws = context.workspaceState;
                if (exitCode !== 0) {
                    const failures = ws.get<string[]>(TERMINAL_FAILURE_STREAK_KEY, []);
                    failures.push(command.trim());
                    if (failures.length > 20) failures.shift();
                    await ws.update(TERMINAL_FAILURE_STREAK_KEY, failures);
                    return;
                }

                const failures = ws.get<string[]>(TERMINAL_FAILURE_STREAK_KEY, []);
                if (failures.length >= 3) {
                    const failedCommands = [...failures];
                    await ws.update(TERMINAL_FAILURE_STREAK_KEY, []);
                    await geminiReadyPromise;

                    await handleBreakthroughDraft(
                        sessionManager?.getSessionDurationMinutes() || 0,
                        failedCommands.length,
                        command.trim()
                    );
                } else {
                    await ws.update(TERMINAL_FAILURE_STREAK_KEY, []);
                }
            }
        );
        context.subscriptions.push(frictionListener);
        outputChannel.appendLine('[DevGhost] ✓ Friction breakthrough tracking enabled');
    } catch {
        outputChannel.appendLine('[DevGhost] ⚠️ Shell Integration not available (friction breakthrough disabled)');
    }

    outputChannel.appendLine('[DevGhost] DevGhost is watching this workspace.');
    outputChannel.appendLine('');

    // Phase 6B: Ask focus on open, then offer a review-first draft
    setTimeout(async () => {
        const focus = await contextManager?.askFocusOnOpen();
        if (focus) {
            workSignalManager?.recordFocus(focus);
        }
        if (focus) {
            const config = contextManager?.getConfig();
            const projectName = config?.projectName || 'my project';
            const eventKey = `focus-intent:${projectName}:${focus}`;
            await geminiReadyPromise;
            if (!await allowAutomaticDraft({
                trigger: 'FOCUS_INTENT',
                eventKey,
                label: 'Focus draft',
            })) {
                return;
            }

            const gemini = geminiService;
            if (!gemini?.isInitialized()) {
                return;
            }

            await runDraftFlow({
                automatic: true,
                eventKey,
                label: 'Focus draft',
                createDraft: async () => {
                    const context = {
                        projectName,
                        mission: config?.mission,
                        currentFocus: focus,
                        tone: (config?.tone || 'raw') as 'raw' | 'professional' | 'funny' | 'technical',
                    };
                    return await gemini.generateIntentTweet(context, focus);
                },
            });
        }
    }, 2000);
}

/**
 * Register all DevGhost commands.
 */
function registerCommands(context: vscode.ExtensionContext): void {
    // Command: Initialize project context
    const initCommand = vscode.commands.registerCommand('devghost.initialize', async () => {
        await contextManager?.createConfig();
        workSignalManager?.recordFocus(contextManager?.getConfig()?.currentFocus || '');
    });
    context.subscriptions.push(initCommand);

    // Command: Set current focus
    const setFocusCommand = vscode.commands.registerCommand('devghost.setFocus', async () => {
        await contextManager?.setFocus();
        workSignalManager?.recordFocus(contextManager?.getConfig()?.currentFocus || '');
    });
    context.subscriptions.push(setFocusCommand);

    // Command: Pause DevGhost
    const pauseCommand = vscode.commands.registerCommand('devghost.pause', async () => {
        await setDevGhostPaused(true);
        outputChannel?.appendLine('[DevGhost] DevGhost is paused. It will not suggest drafts until you resume it.');
        vscode.window.showInformationMessage('DevGhost is paused. It will not suggest drafts until you resume it.');
    });
    context.subscriptions.push(pauseCommand);

    // Command: Resume DevGhost
    const resumeCommand = vscode.commands.registerCommand('devghost.resume', async () => {
        await setDevGhostPaused(false);
        outputChannel?.appendLine('[DevGhost] DevGhost is watching this workspace.');
        vscode.window.showInformationMessage('DevGhost is watching this workspace.');
    });
    context.subscriptions.push(resumeCommand);

    // Command: Show logs
    const showLogsCommand = vscode.commands.registerCommand('devghost.showLogs', () => {
        outputChannel?.show(true);
    });
    context.subscriptions.push(showLogsCommand);

    // Command: Reset project context
    const resetProjectContextCommand = vscode.commands.registerCommand('devghost.resetProjectContext', async () => {
        if (!contextManager?.hasContext()) {
            vscode.window.showInformationMessage('DevGhost: No project context is set yet.');
            return;
        }

        const selection = await vscode.window.showInformationMessage(
            'Reset DevGhost setup for this workspace?',
            { modal: true },
            'Reset',
            'Cancel'
        );

        if (selection !== 'Reset') {
            return;
        }

        await contextManager?.resetProjectContext();
        await historyManager?.resetHistory();
        workSignalManager?.recordFocus('');
        outputChannel?.appendLine('[DevGhost] Project context reset.');
        vscode.window.showInformationMessage('Project context reset.');
    });
    context.subscriptions.push(resetProjectContextCommand);

    // Command: Clear AI key
    const clearAiKeyCommand = vscode.commands.registerCommand('devghost.clearApiKey', async () => {
        const selection = await vscode.window.showInformationMessage(
            'Clear the AI key stored for DevGhost?',
            { modal: true },
            'Clear key',
            'Cancel'
        );

        if (selection !== 'Clear key') {
            return;
        }

        await keyManager?.deleteApiKey();
        geminiService?.clear();
        outputChannel?.appendLine('[DevGhost] AI key cleared.');
        vscode.window.showInformationMessage('AI key cleared.');
    });
    context.subscriptions.push(clearAiKeyCommand);

    // Command: Reset recent activity
    const resetRecentActivityCommand = vscode.commands.registerCommand('devghost.resetRecentActivity', async () => {
        const selection = await vscode.window.showInformationMessage(
            'Reset recent DevGhost activity for this workspace?',
            { modal: true },
            'Reset',
            'Cancel'
        );

        if (selection !== 'Reset') {
            return;
        }

        sessionManager?.resetTracking();
        workSignalManager?.resetLocalSignals();
        await updateAutoDraftState(() => ({
            snoozedUntil: 0,
            handledEventKeys: [],
        }));
        await context.workspaceState.update(TERMINAL_FAILURE_STREAK_KEY, []);
        outputChannel?.appendLine('[DevGhost] Recent activity reset.');
        vscode.window.showInformationMessage('Recent activity reset.');
    });
    context.subscriptions.push(resetRecentActivityCommand);

    // Command: Add AI key
    const setApiKeyCommand = vscode.commands.registerCommand('devghost.setApiKey', async () => {
        const apiKey = await vscode.window.showInputBox({
            prompt: 'Enter your AI key',
            password: true,
            placeHolder: 'AIza...',
            ignoreFocusOut: true,
        });

        if (apiKey) {
            await keyManager?.setApiKey(apiKey);
            
            // Runtime Re-initialization
            await geminiService?.initialize(apiKey);
            const configured = vscode.workspace.getConfiguration('devghost').get<string>('model', 'auto');
            const selected = await geminiService?.resolveBestModel();
            outputChannel?.appendLine(`[DevGhost] Configured model: ${configured}`);
            outputChannel?.appendLine(`[DevGhost] Selected model: ${selected}`);
            
            outputChannel?.appendLine('[DevGhost] AI key saved. Validating...');
            
            try {
                const isValid = await geminiService?.validateKey();
                if (isValid) {
                    outputChannel?.appendLine('[DevGhost] AI setup looks good.');
                    vscode.window.showInformationMessage('DevGhost: AI setup looks good.');
                } else {
                    outputChannel?.appendLine('[DevGhost] AI setup could not be verified.');
                    vscode.window.showWarningMessage('DevGhost: AI setup could not be verified.');
                }
            } catch (error: any) {
                const errMsg = error?.message || String(error);
                outputChannel?.appendLine(`[DevGhost] AI key validation failed: ${errMsg}`);
                if (/no compatible gemini model/i.test(errMsg) || /no compatible ai model/i.test(errMsg)) {
                    vscode.window.showErrorMessage('DevGhost: No compatible AI model is available for this key.');
                } else if (/401|403|invalid|unauthorized/i.test(errMsg)) {
                    vscode.window.showErrorMessage('DevGhost: This AI key is invalid.');
                } else if (/429|quota exceeded/i.test(errMsg)) {
                    vscode.window.showErrorMessage('DevGhost: This AI key has no available usage left.');
                } else {
                    vscode.window.showErrorMessage('DevGhost: DevGhost could not reach the AI service.');
                }
            }
        }
    });
    context.subscriptions.push(setApiKeyCommand);

    // Command: Draft a win (manual trigger)
    const iWonCommand = vscode.commands.registerCommand('devghost.iWon', async () => {
        await handleManualWin();
    });
    context.subscriptions.push(iWonCommand);

    // Manual fallback: draft from recent work in the active file
    const shareGrindCommand = vscode.commands.registerCommand('devghost.shareGrind', async () => {
        noteManualActionWhilePaused();
        if (!agenticBrain) {
            vscode.window.showWarningMessage('DevGhost is not ready yet.');
            return;
        }
        if (!canDraftPostOrWarn(true)) {
            return;
        }

        if (!await ensureGeminiReady({
            explicit: true,
            reason: 'manual recent work',
        })) {
            return;
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('DevGhost: Open a file first so DevGhost can see your work.');
            return;
        }

        const workspaceRoot = resolveWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        if (!workspaceRoot) {
            vscode.window.showWarningMessage('DevGhost: No workspace root found.');
            return;
        }

        const activeFilePath = editor.document.uri.fsPath;
        const activeFileName = path.basename(activeFilePath);

        // AST structural reader: extract function/class/interface names to save API tokens
        let fileStructure: string[] = [];
        try {
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                editor.document.uri
            ) ?? [];
            function collectNames(syms: vscode.DocumentSymbol[]): void {
                for (const s of syms) {
                    const k = s.kind;
                    if (k === vscode.SymbolKind.Function || k === vscode.SymbolKind.Class || k === vscode.SymbolKind.Interface) {
                        fileStructure.push(s.name);
                    }
                    if (s.children?.length) collectNames(s.children);
                }
            }
            collectNames(symbols);
        } catch {
            // Language server may be slow or unavailable
        }

        let diff = '';
        try {
            const cp = require('child_process');
            diff = cp.execSync('git diff HEAD', { cwd: workspaceRoot, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
        } catch (error: any) {
            diff = `Error running git diff HEAD: ${error?.message || String(error)}`;
        }

        // Keep payload small for the model
        const truncatedDiff = diff.length > 8000 ? diff.slice(0, 8000) + '\n... (truncated)' : diff;

        const baseline = contextManager?.getBaselineSummary() || 'No baseline summary available.';

        const result = await agenticBrain.process_trigger('MANUAL_INTENT', {
            baselineSummary: baseline,
            activeFileName,
            uncommittedDiff: truncatedDiff,
            fileStructure,
        } as any);

        if (!result.ok) {
            outputChannel?.appendLine(`[DevGhost] Draft generation failed: ${result.message}`);
            if (result.reason === 'NO_KEY') {
                vscode.window.showWarningMessage(`DevGhost: ${result.message}`);
            }
            return;
        }

        await showDraftReview(result.tweet);
    });
    // Phase 9: Check AI setup (support)
    const checkAiConnectionCommand = vscode.commands.registerCommand('devghost.checkAiConnection', async () => {
            outputChannel?.show(true);
            outputChannel?.appendLine('[DevGhost] Checking AI setup...');

        const apiKey = await keyManager?.getApiKey();
        if (!apiKey) {
            outputChannel?.appendLine('[DevGhost] AI client not initialized.');
            vscode.window.showErrorMessage('DevGhost: Add an AI key first.');
            return;
        }

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "DevGhost: Checking AI setup...",
                cancellable: false
            }, async () => {
                if (!await ensureGeminiReady({
                    explicit: true,
                    reason: 'AI setup',
                    forceRefresh: true,
                })) {
                    return;
                }

                // ensureGeminiReady already logged discovery and validation details.
                const isValid = await geminiService?.validateKey();
                if (isValid) {
                    outputChannel?.appendLine('[DevGhost] AI setup looks good.');
                    vscode.window.showInformationMessage('DevGhost: AI setup looks good.');
                }
            });
        } catch (error: any) {
            const errMsg = error?.message || String(error);
            const isUnavailable = errMsg.toLowerCase().includes('model not found') || 
                                  errMsg.toLowerCase().includes('not available') ||
                                  errMsg.toLowerCase().includes('not found') ||
                                  errMsg.toLowerCase().includes('no compatible gemini model') ||
                                  errMsg.toLowerCase().includes('no compatible ai model');
            
            if (isUnavailable) {
                outputChannel?.appendLine('[DevGhost] No compatible AI model was found for this key.');
                vscode.window.showErrorMessage('DevGhost: No compatible AI model is available for this key.');
            } else if (errMsg.includes('429') || errMsg.toLowerCase().includes('quota exceeded')) {
                const cleanMsg = "This AI key has no available usage left.";
                outputChannel?.appendLine(`[DevGhost] ❌ ${cleanMsg}`);
                outputChannel?.appendLine(`[DevGhost] Raw error: ${errMsg}`);
                vscode.window.showErrorMessage(`DevGhost: ${cleanMsg}`);
            } else {
                outputChannel?.appendLine(`[DevGhost] AI setup failed: ${errMsg}`);
                outputChannel?.appendLine(`[DevGhost] Raw error: ${errMsg}`);
                if (errMsg.toLowerCase().includes('no compatible gemini model') || errMsg.toLowerCase().includes('no compatible ai model')) {
                    vscode.window.showErrorMessage('DevGhost: No compatible AI model is available for this key.');
                } else {
                    vscode.window.showErrorMessage('DevGhost: DevGhost could not reach the AI service.');
                }
            }
        }
    });
    context.subscriptions.push(checkAiConnectionCommand);

    context.subscriptions.push(shareGrindCommand);
}

/**
 * Handle manual "I won!" trigger.
 */
async function handleManualWin(): Promise<void> {
    const config = contextManager?.getConfig();
    
    if (!config) {
        vscode.window.showWarningMessage('DevGhost: Set up the project first.');
        return;
    }

    noteManualActionWhilePaused();

    // Ask what they solved
    const conquest = await vscode.window.showInputBox({
        prompt: 'What did you just solve?',
        placeHolder: 'e.g., Fixed the auth flow, WebSocket finally stable, API integration done',
        value: config.currentFocus,
    });

    if (!conquest) return;

    const durationMinutes = contextManager?.getStruggleDurationMinutes() || 0;
    await runDraftFlow({
        automatic: false,
        label: 'Win draft',
        createDraft: async () => {
            if (!geminiService?.isInitialized()) {
                return null;
            }

            if (!canDraftPostOrWarn()) {
                return null;
            }

            try {
                return await geminiService.generateBreakthroughTweet({
                    filename: conquest,
                    errorCount: 0,
                });
            } catch (error) {
                outputChannel?.appendLine('[DevGhost] Win draft: API error.');
                return null;
            }
        },
        onOpen: () => contextManager?.recordWin(conquest, durationMinutes),
    });
}

// ═══════════════════════════════════════════════════════════════
// PHASE 7: Memory Core Handlers
// ═══════════════════════════════════════════════════════════════

/**
 * Handle warm-up event (returning after 4+ hours).
 */
async function handleWarmup(summary: string, lastEvents: any[]): Promise<void> {
    const config = contextManager?.getConfig();
    const projectName = config?.projectName || 'your project';
    const eventKey = `warmup:${projectName}:${lastEvents.find((event) => event.type === 'SESSION_END')?.timestamp || summary}`;
    const recentCommits = lastEvents
        .filter((event) => event.type === 'COMMIT')
        .map((event) => event.data?.message)
        .filter((message): message is string => typeof message === 'string' && message.trim().length > 0)
        .slice(-5);
    await geminiReadyPromise;
    if (!await allowAutomaticDraft({
        trigger: 'WARMUP_RETURN',
        eventKey,
        label: 'Return draft',
        hints: {
            recentCommits,
        },
    })) {
        return;
    }

    if (!await ensureGeminiReady({
        explicit: false,
        reason: 'return draft',
    })) {
        return;
    }

    // Try to get AI summary
    let aiSummary = summary;
    if (geminiService?.isInitialized() && historyManager) {
        const historyStr = historyManager.getHistoryForAI(10);
        aiSummary = await geminiService.generateWarmupSummary(projectName, historyStr);
    }

    await geminiReadyPromise;
    await runDraftFlow({
        automatic: true,
        eventKey,
        label: 'Return draft',
        createDraft: async () => {
            const currentFocus = config?.currentFocus;
            outputChannel?.appendLine('[DevGhost] Generating return draft...');
            return await geminiService?.generateReturningTweet(projectName, aiSummary, currentFocus) ?? null;
        },
    });

    outputChannel?.appendLine(`[DevGhost] Warm-up: ${aiSummary}`);
}

/**
 * Handle silence detection (60+ mins with no commits + struggles).
 */
async function handleSilenceDetected(durationMinutes: number, strugglesCount: number): Promise<void> {
    const config = contextManager?.getConfig();
    const projectName = config?.projectName || 'my project';
    const eventKey = `silence:${projectName}:${durationMinutes}:${strugglesCount}:${config?.currentFocus || 'no-focus'}`;
    await geminiReadyPromise;
    if (!await allowAutomaticDraft({
        trigger: 'SILENCE_BREAKER',
        eventKey,
        label: 'Recent work draft',
        hints: {
            durationMinutes,
            strugglesCount,
            failedCommands: sessionManager?.getActiveStruggles(),
        },
    })) {
        return;
    }

    await runDraftFlow({
        automatic: true,
        eventKey,
        label: 'Recent work draft',
        createDraft: async () => {
            const context = {
                projectName,
                mission: config?.mission,
                currentFocus: config?.currentFocus,
                tone: config?.tone || 'raw' as const,
            };

            const struggles = sessionManager?.getActiveStruggles() || [];

            vscode.window.setStatusBarMessage('DevGhost is preparing a draft from recent work...', 3000);
            outputChannel?.appendLine('[DevGhost] Generating draft from recent work...');

            return await geminiService?.generateGrindPost(
                context,
                durationMinutes,
                strugglesCount,
                struggles
            ) ?? null;
        },
    });
}

// ═══════════════════════════════════════════════════════════════
// PHASE 7: Commit Recording (no auto AI)
// ═══════════════════════════════════════════════════════════════

/**
 * Handle any commit detection.
 * Phase 8: AI analyzes commit and decides if it's worth a draft.
 * Phase 7: Log commit events.
 */
async function handleCommitDetected(analysis: CommitAnalysis): Promise<void> {
    // Record commit for history + silence tracking (no automatic AI drafting on commit).
    historyManager?.logCommit(analysis.message);
    workSignalManager?.recordCommit(analysis);

    // Tell SessionManager about commit (resets silence timer)
    sessionManager?.recordCommit();

    // Log the commit event to context state
    await contextManager?.logEvent('commit', analysis.message);

    // Check if we should infer a focus shift
    const focusResult = await contextManager?.inferFocusFromCommit(analysis.message);
    if (focusResult?.shouldAsk) {
        setTimeout(async () => {
            await contextManager?.handleFocusShift(focusResult.inferredFocus);
            workSignalManager?.recordFocus(contextManager?.getConfig()?.currentFocus || focusResult.inferredFocus);
        }, 500);
    }

    // Phase 9: Evaluate if this commit is worth a draft
    const eventKey = `commit:${analysis.repoRoot}:${analysis.hash}`;
    if (!await allowAutomaticDraft({
        trigger: 'COMMIT_DETECTED',
        eventKey,
        label: 'Commit draft',
        hints: { commitAnalysis: analysis }
    })) {
        return;
    }

    const scoreDecision = consumeAutomaticDraftDecision(eventKey);
    const currentFocus = contextManager?.getConfig()?.currentFocus || '';
    const freshTerminalFriction = sessionManager?.getRecentFrictionSummary(30) || undefined;
    const touchedSymbols = workSignalManager?.getRecentTouchedSymbols(10) || [];
    const { compactDiffSummary, fileCategories } = buildCompactCommitSummary(analysis);
    const compactDiffStat = analysis.diffStat ? analysis.diffStat.split('\n').slice(0, 12).join('\n') : undefined;
    const whyItMatters = inferWhyItMatters(analysis);
    const userFacingResult = inferUserFacingResult(analysis);

    await runDraftFlow({
        automatic: true,
        eventKey,
        label: 'Commit draft',
        createDraft: async () => {
            if (!agenticBrain) return null;
            
            const baseline = contextManager?.getBaselineSummary() || '(no project context)';
            
            // Build the story context
            const result = await agenticBrain.process_trigger('COMMIT_DETECTED', {
                baselineSummary: baseline,
                commitMessage: analysis.message,
                changedFiles: analysis.changedFiles,
                additions: analysis.additions,
                deletions: analysis.deletions,
                workType: analysis.workType || 'refactor',
                sessionMinutes: analysis.sessionMinutes,
                diffStat: compactDiffStat,
                focus: currentFocus,
                terminalFriction: freshTerminalFriction,
                scoreReasons: scoreDecision?.reasons?.slice(0, 8),
                touchedSymbols,
                compactDiffSummary,
                fileCategories,
                whyItMatters,
                userFacingResult,
            });

            return result.ok ? result.tweet : null;
        }
    });
}

// Phase 5 commit-driven drafting removed in Phase 3.

/**
 * Initialize Gemini with stored API key.
 * Also initializes the draft engine for Phase 8 intelligence.
 */
async function initializeGeminiFromStorage(): Promise<void> {
    const apiKey = await keyManager?.getApiKey();
    const hasProjectContext = contextManager?.hasContext() ?? false;
    if (apiKey && geminiService && hasProjectContext) {
        if (isDevGhostPaused()) {
            outputChannel?.appendLine('[DevGhost] DevGhost is paused. AI setup will resume when you resume it.');
            return;
        }

        const ready = await ensureGeminiReady({
            explicit: false,
            reason: 'startup',
        });
        if (ready) {
            outputChannel?.appendLine('[DevGhost] ✓ DevGhost is ready');
        }
    } else if (apiKey && geminiService && !hasProjectContext) {
        outputChannel?.appendLine('[DevGhost] AI key loaded. Set up the project to generate a baseline.');
    } else {
        outputChannel?.appendLine('[DevGhost] DevGhost needs an AI key to draft updates.');
    }
}

// ═══════════════════════════════════════════════════════════════
// PHASE 9: Brain Check - API Key Notifications
// ═══════════════════════════════════════════════════════════════

/**
 * Check if API key is set on startup.
 * Shows a warning notification if missing, with a button to set it.
 */
async function checkApiKeyOnStartup(): Promise<void> {
    const hasKey = await keyManager?.hasApiKey();
    
    if (!hasKey) {
        outputChannel?.appendLine('[DevGhost] DevGhost needs an AI key to draft updates.');
        
        const selection = await vscode.window.showWarningMessage(
            'DevGhost needs an AI key to draft updates.',
            'Add AI key',
            'Not now'
        );
        
        if (selection === 'Add AI key') {
            vscode.commands.executeCommand('devghost.setApiKey');
        }
    }
}

/**
 * Extension deactivation.
 */
export function deactivate(): void {
    outputChannel?.appendLine('[DevGhost] Goodbye! Keep building. 👻');
}

