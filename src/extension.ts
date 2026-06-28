import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import { ContextManager, SessionManager, GitManager, HistoryManager, WorkSignalManager, CommitAnalysis, AutomaticDraftDecision } from './managers';
import { KeyManager, GeminiService } from './analyzer';
import { scanProjectEnvironment } from './analyzer/projectScanner';
import { CloudClient } from './cloud/cloudClient';
import { buildCloudDraftRequest, buildCommitEvidence, type CloudDraftBuildResult } from './cloud/contextBuilder';
import { formatCloudErrorMessage, isCloudClientError } from './cloud/errors';
import { getOrCreateCloudDeviceId } from './cloud/deviceId';
import { CloudQuotaState } from './cloud/quotaState';
import { CloudRepetitionMemory, type RepetitionSnapshot } from './cloud/repetitionMemory';
import { FREE_DRAFT_LIMIT, type CommitEvidence, type DismissReason, type FeedbackType, type QuotaSnapshot, type TriggerType } from './cloud/contracts';
import { buildPostDecisionSummary, PostDecisionState, type PostDecisionBlocker, type PostDecisionQuotaMode, type PostDecisionSkipReason } from './cloud/postDecisionState';

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
let cloudQuotaState: CloudQuotaState | undefined;
let cloudRepetitionMemory: CloudRepetitionMemory | undefined;
let postDecisionState: PostDecisionState | undefined;
let workspaceState: vscode.Memento | undefined;
let extensionContextRef: vscode.ExtensionContext | undefined;
let lastAutomaticDraftDecision: { eventKey: string; eventId: string; decision: AutomaticDraftDecision } | null = null;
const AUTOMATIC_FAILURE_BACKOFF_MS = 2 * 60 * 1000;
const recentAutomaticDraftFailures = new Map<string, number>();

// Phase 8: Agentic Intelligence
import { AgenticBrain, type BrainResult } from './agent/AgenticBrain';
import { AgentTools } from './agent/AgentTools';

let agenticBrain: AgenticBrain | undefined;

/** Resolves when API key has been loaded from SecretStorage and Gemini (if any) is initialized. Ensures handlers do not run before key load in packaged VSIX. */
let geminiReadyPromise: Promise<void> = Promise.resolve();

// Phase 6A: (legacy) snooze tracking removed in Phase 3

let focusPromptHandledThisSession = false;

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

function buildOpaqueWorkspaceEventKey(prefix: string, workspaceRoot: string, suffix: string): string {
    const normalizedRoot = (workspaceRoot || 'workspace').replace(/\\/g, '/').toLowerCase();
    const workspaceHash = createHash('sha256').update(normalizedRoot).digest('hex').slice(0, 12);
    return `${prefix}:${workspaceHash}:${suffix}`;
}

function recordAutomaticDraftFailure(eventKey: string): void {
    recentAutomaticDraftFailures.set(eventKey, Date.now());
}

function clearAutomaticDraftFailure(eventKey: string): void {
    recentAutomaticDraftFailures.delete(eventKey);
}

function isAutomaticDraftFailureBackoffActive(eventKey: string): boolean {
    const lastFailureAt = recentAutomaticDraftFailures.get(eventKey);
    if (typeof lastFailureAt !== 'number') {
        return false;
    }

    if (Date.now() - lastFailureAt > AUTOMATIC_FAILURE_BACKOFF_MS) {
        recentAutomaticDraftFailures.delete(eventKey);
        return false;
    }

    return true;
}

async function snoozeAutoDraftPrompts(): Promise<void> {
    await updateAutoDraftState((state) => ({
        snoozedUntil: Date.now() + AUTO_DRAFT_SNOOZE_MS,
        handledEventKeys: state.handledEventKeys.slice(-AUTO_DRAFT_HANDLED_LIMIT),
    }));
}

function isTruthyEnv(value: string | undefined): boolean {
    return !!value && /^(1|true|yes|on)$/i.test(value.trim());
}

function detectQuotaMode(quota?: QuotaSnapshot | null): PostDecisionQuotaMode {
    if (quota && quota.limit > FREE_DRAFT_LIMIT) {
        return 'qa';
    }

    if (isTruthyEnv(process.env.DEVGHOST_QA_NO_QUOTA)) {
        return 'qa';
    }

    const configuredLimit = process.env.DEVGHOST_FREE_DAILY_LIMIT?.trim();
    if (configuredLimit) {
        const parsed = Number(configuredLimit);
        if (Number.isInteger(parsed) && parsed > FREE_DRAFT_LIMIT) {
            return 'qa';
        }
    }

    return 'normal';
}

function normalizeAutomaticGateBlocker(blockers: string[] | undefined): PostDecisionBlocker {
    const joined = (blockers ?? []).join(' ').toLowerCase();
    if (!joined) {
        return 'below_threshold';
    }
    if (joined.includes('pause') || joined.includes('paused')) {
        return 'paused';
    }
    if (joined.includes('not enough focus or session context')) {
        return 'not_enough_context';
    }
    if (joined.includes('auto draft cooldown active')) {
        return 'cooldown_active';
    }
    if (joined.includes('only generated, lock, or build output files changed')) {
        return 'noise_only';
    }
    if (joined.includes('recent burst is not stable yet')) {
        return 'burst_unstable';
    }
    if (joined.includes('score ') && joined.includes('below threshold')) {
        return 'below_threshold';
    }
    return 'below_threshold';
}

function normalizeCloudSkipReason(code: string | null): PostDecisionSkipReason {
    if (!code) {
        return 'cloud_failed';
    }

    if (/^invalid_post_shape_/i.test(code)) {
        return code as PostDecisionSkipReason;
    }

    switch (code) {
        case 'max_tokens':
            return 'max_tokens';
        case 'quota_exhausted':
            return 'quota_exhausted';
        case 'cloud_rate_limited':
            return 'cloud_rate_limited';
        case 'cloud_timeout':
            return 'cloud_timeout';
        case 'request_aborted':
            return 'request_aborted';
        case 'cloud_invalid_post_shape':
            return 'cloud_invalid_post_shape';
        case 'cloud_failed':
        case 'cloud_provider_error':
        default:
            return 'cloud_failed';
    }
}

function logStatus(message: string): void {
    outputChannel?.appendLine(message);
}

function logDebug(message: string): void {
    if (vscode.env.logLevel === vscode.LogLevel.Debug || vscode.env.logLevel === vscode.LogLevel.Trace) {
        outputChannel?.appendLine(`[debug] ${message}`);
    }
}

function logError(message: string): void {
    outputChannel?.appendLine(`[error] ${message}`);
}

const QUOTA_RESET_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
});

function formatQuotaResetTime(resetAtUtc: string): string {
    const resetAt = new Date(resetAtUtc);
    if (Number.isNaN(resetAt.getTime())) {
        return resetAtUtc;
    }

    return QUOTA_RESET_TIME_FORMATTER.format(resetAt);
}

async function showQuotaLimitReachedNotice(deviceId: string, quota: QuotaSnapshot, automatic?: boolean): Promise<void> {
    const resetAt = formatQuotaResetTime(quota.resetAtUtc);
    const message = `Post limit reached. New posts available after ${resetAt}.`;

    if (automatic) {
        const shouldShow = await cloudQuotaState?.shouldShowQuotaLimitReachedNotice(deviceId, quota.resetAtUtc) ?? true;
        if (!shouldShow) {
            logDebug(`Post generation skipped: quota exhausted until ${resetAt}.`);
            return;
        }
    }

    logStatus(`Post limit reached until ${resetAt}.`);
    await vscode.window.showInformationMessage(message);
}

function buildCloudBaselineSummary(scan: string): string {
    return scan
        .split(/\r?\n/)
        .filter((line) => !/^Root:\s*/i.test(line))
        .join('\n')
        .trim();
}

async function seedCloudBaselineSummary(workspaceRoot: string): Promise<void> {
    if (!contextManager || !workspaceRoot) {
        return;
    }

    try {
        if (contextManager.hasBaselineSummary()) {
            return;
        }

        const scan = await scanProjectEnvironment(workspaceRoot);
        const baseline = buildCloudBaselineSummary(scan);
        if (baseline.length > 0) {
            await contextManager.setBaselineSummary(baseline);
            logDebug('Cloud project scan saved.');
        }
    } catch {
        logDebug('Cloud project scan could not be saved.');
    }
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
    logDebug(`Sanitized ${event.label} for Cloud (${event.redactedSensitiveLines} sensitive lines, ${event.removedSensitiveFiles} sensitive files, ${event.shortenedPaths} shortened paths${event.truncated ? ', truncated' : ''}).`);
}

function canDraftPostOrWarn(isManual?: boolean): boolean {
    if (isManual === true) return true;
    if (!historyManager) return true;
    const ok = historyManager.canPostToday();
    if (!ok) {
        outputChannel?.appendLine('[warn] Daily post limit reached. Aborting legacy post.');
    }
    return ok;
}

function rememberAutomaticDraftDecision(eventKey: string, eventId: string, decision: AutomaticDraftDecision): void {
    lastAutomaticDraftDecision = { eventKey, eventId, decision };
}

function consumeAutomaticDraftDecision(eventKey: string): { eventId: string; decision: AutomaticDraftDecision } | null {
    if (lastAutomaticDraftDecision?.eventKey !== eventKey) {
        return null;
    }

    const decision = {
        eventId: lastAutomaticDraftDecision.eventId,
        decision: lastAutomaticDraftDecision.decision,
    };
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

function joinNaturalList(items: string[]): string {
    const unique = [...new Set(items.map((item) => item.trim()).filter(Boolean))];
    if (unique.length === 0) return '';
    if (unique.length === 1) return unique[0];
    if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
    return `${unique.slice(0, -1).join(', ')}, and ${unique[unique.length - 1]}`;
}

function isDevGhostProjectName(projectName: string = ''): boolean {
    return projectName.toLowerCase().includes('devghost');
}

function normalizeComparableText(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildFocusConflictNote(focus: string, analysis: CommitAnalysis, fileCategories: string = ''): string | null {
    const trimmedFocus = focus.trim();
    if (!trimmedFocus) {
        return null;
    }

    const normalizedFocus = normalizeComparableText(trimmedFocus);
    if (!normalizedFocus) {
        return null;
    }

    const normalizedEvidence = normalizeComparableText([
        analysis.message,
        ...(analysis.changedFiles ?? []),
        fileCategories,
    ].join(' '));

    if (!normalizedEvidence) {
        return null;
    }

    if (normalizedEvidence.includes(normalizedFocus)) {
        return null;
    }

    const focusNoiseTokens = new Set([
        'the',
        'and',
        'for',
        'with',
        'from',
        'this',
        'that',
        'page',
        'pages',
        'app',
        'project',
        'work',
        'thing',
        'things',
        'update',
        'feature',
        'features',
        'screen',
        'screens',
        'view',
        'views',
    ]);
    const focusTokens = normalizedFocus.split(' ').filter((token) => token.length > 3 && !focusNoiseTokens.has(token));
    if (focusTokens.length === 0) {
        return null;
    }

    if (focusTokens.some((token) => normalizedEvidence.includes(token))) {
        return null;
    }

    return 'possibly stale; commit evidence overrides focus';
}

function inferWhyItMatters(
    analysis: CommitAnalysis,
    scoreReasons: string[] = [],
    fileCategories: string = '',
    projectName: string = ''
): string {
    const fileBlob = (analysis.changedFiles ?? []).join(' ').toLowerCase();
    const reasonBlob = scoreReasons.join(' ').toLowerCase();
    const categoryBlob = fileCategories.toLowerCase();
    const devGhostProject = isDevGhostProjectName(projectName);
    const themes: string[] = [];

    if (/(worksignalmanager|gitmanager)/i.test(fileBlob) || /(meaningful commit evidence|commit signal in session|failed command later succeeded|focus missing)/i.test(reasonBlob)) {
        themes.push(devGhostProject
            ? 'when DevGhost decides work is meaningful enough to suggest a draft'
            : 'the workflow for deciding when a draft is worth suggesting');
    }

    if (/(agenticbrain|promptbuilder|gemini)/i.test(fileBlob)) {
        themes.push('the quality and specificity of generated drafts');
    }

    if (/(keymanager|gemini)/i.test(fileBlob) || (/config/.test(categoryBlob) && /api key|model|validation|fallback/i.test(reasonBlob))) {
        themes.push('AI setup reliability and model selection');
    }

    if (/(contextmanager|sessionmanager|historymanager)/i.test(fileBlob) || /session|focus|history/i.test(reasonBlob)) {
        themes.push(devGhostProject
            ? 'the context DevGhost uses before drafting'
            : 'the context the app uses before drafting');
    }

    if (/extension\.ts/i.test(fileBlob) && /(review|draft|open x)/i.test(`${analysis.message} ${reasonBlob}`)) {
        themes.push(devGhostProject
            ? 'the review-first flow users see before opening an X draft'
            : 'the review-first flow users see before opening a draft');
    }

    if (themes.length > 0) {
        return `This affects ${joinNaturalList(themes.slice(0, 2))}.`;
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

function inferUserFacingResult(
    analysis: CommitAnalysis,
    scoreReasons: string[] = [],
    fileCategories: string = '',
    projectName: string = ''
): string {
    const fileBlob = (analysis.changedFiles ?? []).join(' ').toLowerCase();
    const reasonBlob = scoreReasons.join(' ').toLowerCase();
    const categoryBlob = fileCategories.toLowerCase();
    const devGhostProject = isDevGhostProjectName(projectName);
    const themes: string[] = [];

    if (/(worksignalmanager|gitmanager)/i.test(fileBlob) || /(meaningful commit evidence|commit signal in session|failed command later succeeded|focus missing)/i.test(reasonBlob)) {
        themes.push(devGhostProject
            ? 'DevGhost should be better at deciding when to suggest a draft'
            : 'the app should be better at deciding when to suggest a draft');
    }

    if (/(agenticbrain|promptbuilder|gemini)/i.test(fileBlob)) {
        themes.push('drafts should be more specific and less generic');
    }

    if (/(keymanager|gemini)/i.test(fileBlob) || (/config/.test(categoryBlob) && /api key|model|validation|fallback/i.test(reasonBlob))) {
        themes.push('AI setup should fail or recover more clearly');
    }

    if (/(contextmanager|sessionmanager|historymanager)/i.test(fileBlob) || /session|focus|history/i.test(reasonBlob)) {
        themes.push(devGhostProject
            ? 'DevGhost should have better session context before drafting'
            : 'the app should have better session context before drafting');
    }

    if (/extension\.ts/i.test(fileBlob) && /(review|draft|open x)/i.test(`${analysis.message} ${reasonBlob}`)) {
        themes.push('the review-first flow should feel smoother and safer');
    }

    if (themes.length > 0) {
        return joinNaturalList(themes.slice(0, 2));
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

// Keep the legacy helper set reachable so strict unused checks do not fail while the Cloud path carries the product flow.
const PHASE_1_LEGACY_HELPERS = [
    consumeAutomaticDraftDecision,
    buildCompactCommitSummary,
    joinNaturalList,
    isDevGhostProjectName,
    normalizeComparableText,
    buildFocusConflictNote,
    inferWhyItMatters,
    inferUserFacingResult,
    getTop3DiffsForDeepWork,
];
void PHASE_1_LEGACY_HELPERS;

type DraftFlowOptions = {
    label: string;
    createDraft: () => Promise<DraftFlowOutcome>;
    automatic?: boolean;
    eventKey?: string;
    onOpen?: () => Promise<void> | void;
    offerAddFocus?: boolean;
};

type DraftFlowFailureReason = Exclude<Extract<BrainResult, { ok: false }>['reason'], undefined>;

type DraftFlowFailure = {
    ok: false;
    reason: DraftFlowFailureReason;
    message: string;
    technicalError?: string;
};

type DraftFlowOutcome = string | DraftFlowFailure | null;

type DraftReviewFeedback = {
    feedbackType: FeedbackType;
    dismissReason?: DismissReason;
};

type DraftReviewOptions = {
    onOpen?: () => Promise<void> | void;
    onFeedback?: (feedback: DraftReviewFeedback) => Promise<void> | void;
};

type PostReadyPromptResult = 'review' | 'not_now' | 'pause';

type CloudDraftFlowOptions = {
    automatic?: boolean;
    triggerType: TriggerType;
    eventKey?: string;
    eventId?: string;
    label: string;
    hints?: AutomaticDraftGateOptions['hints'];
    triggerEvidence?: CommitEvidence;
    commitHashShort?: string | null;
    onOpen?: () => Promise<void> | void;
    onFeedback?: (feedback: DraftReviewFeedback) => Promise<void> | void;
};

function isDraftFlowFailure(value: DraftFlowOutcome): value is DraftFlowFailure {
    return !!value && typeof value === 'object' && 'ok' in value && value.ok === false;
}

function formatDraftFailureLogMessage(failure: DraftFlowFailure): string {
    switch (failure.reason) {
        case 'NO_KEY':
            return 'AI key is missing.';
        case 'CLIENT_NOT_READY':
            return 'AI client is not ready.';
        case 'NO_CONTEXT':
            return 'project context is missing.';
        case 'MODEL_EMPTY_RESPONSE':
            return 'AI returned an empty draft.';
        case 'API_ERROR':
            return failure.message || 'AI request failed.';
    }

    return failure.message;
}

function formatDraftFailurePopupMessage(failure: DraftFlowFailure): string {
    switch (failure.reason) {
        case 'NO_KEY':
            return 'AI key is missing.';
        case 'CLIENT_NOT_READY':
            return 'AI client is not ready.';
        case 'NO_CONTEXT':
            return 'project context is missing.';
        case 'MODEL_EMPTY_RESPONSE':
            return 'AI returned an empty draft.';
        case 'API_ERROR':
            return 'AI request failed.';
    }

    return failure.message;
}

type AutomaticDraftGateOptions = {
    trigger: 'PROJECT_LAUNCH' | 'PROJECT_RESUME' | 'FRICTION_BREAKTHROUGH' | 'DEEP_WORK_WRAP_UP' | 'WARMUP_RETURN' | 'SILENCE_BREAKER' | 'COMMIT_DETECTED' | 'FOCUS_INTENT';
    eventKey: string;
    eventId?: string;
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

const COMMIT_FRESHNESS_GRACE_MS = 5 * 60 * 1000;

function isFreshCommitForSession(commitAnalysis: CommitAnalysis): boolean {
    if (commitAnalysis.classification === 'startup_baseline' || commitAnalysis.classification === 'historical_existing_commit') {
        return false;
    }

    if (commitAnalysis.classification === 'fresh_commit') {
        return true;
    }

    const commitTimestamp = commitAnalysis.committerDate || commitAnalysis.authorDate || null;
    if (!commitTimestamp) {
        return false;
    }

    const parsedTimestamp = Date.parse(commitTimestamp);
    if (Number.isNaN(parsedTimestamp)) {
        return false;
    }

    const sessionStartTime = sessionManager?.getSession().startTime;
    if (!sessionStartTime) {
        return false;
    }

    return parsedTimestamp >= (sessionStartTime.getTime() - COMMIT_FRESHNESS_GRACE_MS);
}

async function allowAutomaticDraft(options: AutomaticDraftGateOptions): Promise<boolean> {
    const eventId = options.eventId || randomUUID();
    const commitAnalysis = options.hints?.commitAnalysis;
    const nowIso = new Date().toISOString();
    const baseRecord = {
        eventId,
        triggerType: options.trigger,
        automatic: true,
        commitDetected: options.trigger === 'COMMIT_DETECTED',
        commitHashShort: commitAnalysis?.hash ?? null,
        gateAllowed: null,
        gateScore: null,
        blocker: null,
        quotaMode: detectQuotaMode(),
        quotaRemaining: null,
        cooldownActive: false,
        alreadyHandled: false,
        baselineSuppressed: false,
        focusPresent: Boolean((contextManager?.getConfig()?.currentFocus || '').trim()),
        projectSummaryPresent: Boolean(contextManager?.hasBaselineSummary()),
        changedFileCount: commitAnalysis?.filesChanged ?? 0,
        additions: commitAnalysis?.additions ?? null,
        deletions: commitAnalysis?.deletions ?? null,
        diffExcerptCount: null,
        requestSent: false,
        cloudStatus: 'not_sent' as const,
        postAccepted: false,
        skipReason: null,
        timestampUtc: nowIso,
    };

    if (isAutomaticDraftFailureBackoffActive(options.eventKey)) {
        logDebug(`Auto draft skipped (${options.label}): recent Cloud failure backoff is active.`);
        await postDecisionState?.upsert({
            ...baseRecord,
            gateAllowed: false,
            blocker: 'retry_backoff',
            skipReason: 'retry_backoff',
        });
        return false;
    }

    if (isDevGhostPaused()) {
        logDebug(`Auto draft skipped (${options.label}): DevGhost is paused.`);
        await postDecisionState?.upsert({
            ...baseRecord,
            gateAllowed: false,
            blocker: 'paused',
            skipReason: 'paused',
        });
        return false;
    }

    if (options.trigger === 'COMMIT_DETECTED' && options.hints?.commitAnalysis && !isFreshCommitForSession(options.hints.commitAnalysis)) {
        logDebug(`Auto draft skipped (${options.label}): Existing commit ${options.hints.commitAnalysis.hash} predates this DevGhost session.`);
        await postDecisionState?.upsert({
            ...baseRecord,
            baselineSuppressed: true,
            gateAllowed: false,
            blocker: 'baseline_suppressed',
            skipReason: 'baseline_suppressed',
            commitDetected: true,
            commitHashShort: options.hints.commitAnalysis.hash,
        });
        return false;
    }

    const tracker = workSignalManager;
    if (!tracker) {
        logDebug(`Auto draft skipped (${options.label}): local signal tracker is unavailable.`);
        await postDecisionState?.upsert({
            ...baseRecord,
            gateAllowed: false,
            blocker: 'not_ready',
            skipReason: 'not_ready',
        });
        return false;
    }

    const workspaceRoot = resolveWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const config = contextManager?.getConfig();
    const currentFocus = config?.currentFocus || '';
    const focusAgeMinutes = contextManager?.getStruggleDurationMinutes() || 0;
    const sessionMinutes = sessionManager?.getSessionDurationMinutes() || 0;
    const decision = tracker.evaluateAutomaticDraft({
        trigger: options.trigger,
        eventKey: options.eventKey,
        workspaceRoot,
        projectName: config?.projectName || 'your project',
        currentFocus,
        focusAgeMinutes,
        sessionMinutes,
        hasBaselineSummary: contextManager?.hasBaselineSummary() ?? false,
        canPostToday: true,
        hints: options.hints,
    });
    rememberAutomaticDraftDecision(options.eventKey, eventId, decision);

    if (!decision.allowed) {
        logDebug(`Auto draft skipped (${options.label}): ${decision.score}/${decision.threshold} | ${decision.blockers.join('; ')}`);
        await postDecisionState?.upsert({
            ...baseRecord,
            gateAllowed: false,
            gateScore: decision.score,
            blocker: normalizeAutomaticGateBlocker(decision.blockers),
            cooldownActive: decision.blockers.some((blocker) => /cooldown active/i.test(blocker)),
            skipReason: normalizeAutomaticGateBlocker(decision.blockers),
        });
        return false;
    }

    logDebug(`Auto draft score ${decision.score}/${decision.threshold} (${options.label}): ${decision.reasons.join('; ')}`);
    await postDecisionState?.upsert({
        ...baseRecord,
        gateAllowed: true,
        gateScore: decision.score,
        blocker: null,
        cooldownActive: decision.blockers.some((blocker) => /cooldown active/i.test(blocker)),
        skipReason: null,
    });
    return true;
}

async function openXDraft(draft: string): Promise<boolean> {
    const encodedDraft = encodeURIComponent(draft);
    const draftUrl = `https://twitter.com/intent/tweet?text=${encodedDraft}`;

    try {
        return await vscode.env.openExternal(vscode.Uri.parse(draftUrl));
    } catch (error) {
        logDebug(`Failed to open Twitter/X post: ${error}`);
        return false;
    }
}

async function showPostReadyPrompt(automatic: boolean): Promise<PostReadyPromptResult> {
    const selection = await vscode.window.showInformationMessage(
        automatic ? 'Post ready to review from your recent work.' : 'Post ready to review.',
        ...(automatic
            ? ['Review post', 'Not now', 'Pause suggestions']
            : ['Review post'])
    );

    if (selection === 'Review post') {
        return 'review';
    }

    if (selection === 'Pause suggestions') {
        return 'pause';
    }

    return 'not_now';
}

async function showDraftReview(draft: string, options?: DraftReviewOptions): Promise<void> {
    logStatus('Post ready for review.');
    const selection = await vscode.window.showInformationMessage(
        draft,
        'Copy post',
        'Open in Twitter/X',
        'Dismiss'
    );

    if (selection === 'Copy post') {
        await vscode.env.clipboard.writeText(draft);
        logStatus('Post copied.');
        void Promise.resolve(vscode.window.showInformationMessage('Post copied.')).catch(() => undefined);
        await options?.onFeedback?.({
            feedbackType: 'copied',
        });
        return;
    }

    if (selection === 'Open in Twitter/X') {
        const opened = await openXDraft(draft);
        if (opened !== true) {
            vscode.window.showErrorMessage('DevGhost could not open Twitter/X.');
            return;
        }

        historyManager?.logEvent('POST_DRAFTED');
        logStatus('Opened in Twitter/X.');
        void Promise.resolve(vscode.window.showInformationMessage('Opened in Twitter/X. DevGhost never posts automatically.')).catch(() => undefined);
        await options?.onOpen?.();
        await options?.onFeedback?.({
            feedbackType: 'opened_x',
        });
        return;
    }

    if (selection === 'Dismiss') {
        await options?.onFeedback?.({
            feedbackType: 'dismissed',
            dismissReason: 'other',
        });
    }
}

async function showPrivacyAndDataUse(): Promise<void> {
    const copy = 'DevGhost creates posts using a cleaned summary of recent work. It may send selected sanitized context to DevGhost Cloud when generating a post. Raw code, raw diffs, prompts, provider responses, post text, terminal output, file contents, and absolute paths are not stored. Every post opens for review first. DevGhost never posts automatically.';

    await vscode.window.showInformationMessage(copy, { modal: true }, 'Close');
}

async function ensureGeminiReady(options: { explicit: boolean; reason: string; forceRefresh?: boolean }): Promise<boolean> {
    if (!geminiService) {
        return false;
    }

    if (geminiService.isInitialized()) {
        return true;
    }

    if (isDevGhostPaused() && !options.explicit) {
        logDebug(`AI setup skipped (${options.reason}): DevGhost is paused.`);
        return false;
    }

    const apiKey = await keyManager?.getApiKey();
    if (!apiKey) {
        if (options.explicit) {
            await checkApiKeyOnStartup();
        } else {
            logDebug(`AI setup skipped (${options.reason}): AI key is not ready.`);
        }
        return false;
    }

    try {
        await geminiService.initialize(apiKey);
        const count = geminiService.getDiscoveredModelsCount() || 0;
        const configured = vscode.workspace.getConfiguration('devghost').get<string>('model', 'auto');
        const resolved = await geminiService.resolveBestModel(options.forceRefresh ?? false);
        if (count === 0) {
            logDebug('Model discovery returned 0 compatible models.');
            logDebug(`Trying fallback model: ${resolved}`);
            
            // Validate the fallback model
            try {
                await geminiService.validateModel(resolved, false);
                logDebug(`Fallback model validated: ${resolved}`);
            } catch (vError) {
                const vMsg = vError instanceof Error ? vError.message : String(vError);
                logDebug(`Fallback model validation failed: ${vMsg}`);
                throw new Error('No compatible AI model is available for this key.');
            }
        } else {
            logDebug(`Discovered ${count} compatible AI models`);
            logDebug(`Configured model: ${configured}`);
            logDebug(`Selected model: ${resolved}`);
        }
        return true;
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logDebug(`AI setup failed (${options.reason}): ${errMsg}`);
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

async function maybePromptForFocusBeforeCloudDraft(): Promise<void> {
    const currentFocus = contextManager?.getConfig()?.currentFocus?.trim() || '';
    if (currentFocus.length > 0 || focusPromptHandledThisSession) {
        return;
    }

    focusPromptHandledThisSession = true;
    const selection = await vscode.window.showInformationMessage(
        'Set a focus to make DevGhost posts sharper?',
        'Set focus',
        'Not now'
    );

    if (selection !== 'Set focus') {
        return;
    }

    await contextManager?.setFocus();
    const updatedFocus = contextManager?.getConfig()?.currentFocus?.trim() || '';
    if (updatedFocus) {
        workSignalManager?.recordFocus(updatedFocus);
    }
}

async function runCloudDraftFlow(options: CloudDraftFlowOptions): Promise<void> {
    const autoEventKey = options.eventKey || options.label;
    const automaticDecision = options.automatic ? consumeAutomaticDraftDecision(autoEventKey) : null;
    const eventId = options.eventId || automaticDecision?.eventId || randomUUID();
    const nowIso = new Date().toISOString();
    const commitDetected = Boolean(options.commitHashShort || options.triggerEvidence || options.triggerType === 'COMMIT_DETECTED');
    const currentFocus = contextManager?.getConfig()?.currentFocus?.trim() || '';
    const currentProjectSummaryPresent = Boolean(contextManager?.hasBaselineSummary());
    await postDecisionState?.upsert({
        eventId,
        triggerType: options.triggerType,
        automatic: Boolean(options.automatic),
        commitDetected,
        commitHashShort: options.commitHashShort ?? null,
        gateAllowed: options.automatic ? automaticDecision?.decision.allowed ?? true : null,
        gateScore: automaticDecision?.decision.score ?? null,
        blocker: null,
        quotaMode: detectQuotaMode(),
        quotaRemaining: null,
        cooldownActive: false,
        alreadyHandled: false,
        baselineSuppressed: false,
        focusPresent: Boolean(currentFocus),
        projectSummaryPresent: currentProjectSummaryPresent,
        changedFileCount: options.triggerEvidence?.changedFileCount ?? 0,
        additions: options.triggerEvidence?.additions ?? null,
        deletions: options.triggerEvidence?.deletions ?? null,
        diffExcerptCount: options.triggerEvidence?.diffExcerptCount ?? null,
        requestSent: false,
        cloudStatus: 'not_sent',
        postAccepted: false,
        skipReason: null,
        timestampUtc: nowIso,
    });

    if (options.automatic) {
        const suppressionReason = getAutoDraftSuppressionReason(autoEventKey);
        if (suppressionReason) {
            logDebug(
                suppressionReason === 'snoozed'
                    ? `Auto cloud draft skipped (${options.label}): snooze is active.`
                    : `Auto cloud draft skipped (${options.label}): event already handled.`
            );
            await postDecisionState?.upsert({
                eventId,
                triggerType: options.triggerType,
                automatic: true,
                alreadyHandled: suppressionReason === 'handled',
                cooldownActive: false,
                blocker: suppressionReason === 'snoozed' ? 'snoozed' : 'already_handled',
                skipReason: suppressionReason === 'snoozed' ? 'snoozed' : 'already_handled',
                cloudStatus: 'not_sent',
                requestSent: false,
                postAccepted: false,
            });
            return;
        }
    }

    const extensionContext = extensionContextRef;
    if (!extensionContext) {
        if (!options.automatic) {
            vscode.window.showErrorMessage('DevGhost: Post generation is not ready.');
        }
        await postDecisionState?.upsert({
            eventId,
            triggerType: options.triggerType,
            automatic: Boolean(options.automatic),
            blocker: 'not_ready',
            skipReason: 'not_ready',
            cloudStatus: 'not_sent',
            requestSent: false,
            postAccepted: false,
        });
        return;
    }

    const apiBaseUrl = vscode.workspace.getConfiguration('devghost').get<string>('cloudApiBaseUrl', 'https://cloud-ten-steel.vercel.app');
    let cloudClient: CloudClient;
    try {
        cloudClient = new CloudClient(apiBaseUrl);
    } catch (error) {
        const message = formatCloudErrorMessage(error);
        if (!options.automatic) {
            logError(`Cloud setup failed: ${message}`);
            vscode.window.showErrorMessage(`DevGhost: ${message}`);
        } else {
            logDebug(`Cloud setup failed: ${message}`);
        }
        return;
    }

    const deviceId = await getOrCreateCloudDeviceId(extensionContext);
    const clientVersion = extensionContext.extension.packageJSON?.version || '0.0.0';
    const workspaceRoot = resolveWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    if (!workspaceRoot) {
        if (!options.automatic) {
            vscode.window.showWarningMessage('DevGhost: Open a workspace first.');
        }
        await postDecisionState?.upsert({
            eventId,
            triggerType: options.triggerType,
            automatic: Boolean(options.automatic),
            blocker: 'workspace_missing',
            skipReason: 'workspace_missing',
            cloudStatus: 'not_sent',
            requestSent: false,
            postAccepted: false,
        });
        return;
    }

    try {
        const quotaResponse = await cloudClient.getQuota({
            deviceId,
            clientVersion,
        });

        await cloudQuotaState?.setCachedQuota(deviceId, quotaResponse.quota);
        const quotaMode = detectQuotaMode(quotaResponse.quota);
        await postDecisionState?.upsert({
            eventId,
            triggerType: options.triggerType,
            automatic: Boolean(options.automatic),
            quotaMode,
            quotaRemaining: quotaResponse.quota.remaining,
        });
        if (!quotaResponse.quota.canGenerate) {
            await postDecisionState?.upsert({
                eventId,
                triggerType: options.triggerType,
                automatic: Boolean(options.automatic),
                quotaMode,
                quotaRemaining: quotaResponse.quota.remaining,
                blocker: 'quota_exhausted',
                skipReason: 'quota_exhausted',
                cloudStatus: 'quota_exhausted',
                requestSent: false,
                postAccepted: false,
            });
            await showQuotaLimitReachedNotice(deviceId, quotaResponse.quota, options.automatic);
            return;
        }

        await maybePromptForFocusBeforeCloudDraft();

        const repetitionSnapshot: RepetitionSnapshot | undefined = cloudRepetitionMemory?.getSnapshot();
        const requestId = randomUUID();
        const buildResult: CloudDraftBuildResult = await buildCloudDraftRequest({
            triggerType: options.triggerType,
            deviceId,
            requestId,
            clientVersion,
            workspaceRoot,
            contextManager,
            historyManager,
            sessionManager,
            workSignalManager,
            repetitionSnapshot,
            triggerEvidence: options.triggerEvidence,
        });

        const commitEvidence = buildResult.request.commitEvidence;
        await postDecisionState?.upsert({
            eventId,
            triggerType: options.triggerType,
            automatic: Boolean(options.automatic),
            commitDetected: Boolean(commitEvidence),
            commitHashShort: options.commitHashShort ?? null,
            quotaMode: detectQuotaMode(quotaResponse.quota),
            quotaRemaining: quotaResponse.quota.remaining,
            focusPresent: Boolean(buildResult.request.currentFocus?.trim()),
            projectSummaryPresent: Boolean(buildResult.request.projectSummary?.trim()),
            changedFileCount: commitEvidence?.changedFileCount ?? buildResult.changedRelativePathsCount,
            additions: commitEvidence?.additions ?? null,
            deletions: commitEvidence?.deletions ?? null,
            diffExcerptCount: commitEvidence?.diffExcerptCount ?? buildResult.excerptCount,
        });
        logDebug(
            `Cloud request metadata: triggerType=${options.triggerType} hasFocus=${Boolean(buildResult.request.currentFocus?.trim())} hasProjectSummary=${Boolean(buildResult.request.projectSummary?.trim())} changedFileCount=${commitEvidence?.changedFileCount ?? buildResult.changedRelativePathsCount} additions=${commitEvidence?.additions ?? 0} deletions=${commitEvidence?.deletions ?? 0} diffExcerptCount=${commitEvidence?.diffExcerptCount ?? buildResult.excerptCount} contextBytes=${buildResult.contextBytes}`
        );

        await postDecisionState?.upsert({
            eventId,
            triggerType: options.triggerType,
            automatic: Boolean(options.automatic),
            requestSent: true,
            cloudStatus: 'sent',
        });

        const draftResponse = await cloudClient.postDraft(buildResult.request);

        await cloudQuotaState?.setCachedQuota(deviceId, draftResponse.quota);
        await cloudRepetitionMemory?.recordDraft(draftResponse.topicTag, draftResponse.angle);
        clearAutomaticDraftFailure(autoEventKey);
        if (options.automatic) {
            await markAutoDraftHandled(autoEventKey);
            workSignalManager?.recordAutomaticSuggestion(autoEventKey);
        }
        await postDecisionState?.upsert({
            eventId,
            triggerType: options.triggerType,
            automatic: Boolean(options.automatic),
            quotaMode: detectQuotaMode(draftResponse.quota),
            quotaRemaining: draftResponse.quota.remaining,
            requestSent: true,
            cloudStatus: 'accepted',
            postAccepted: true,
            alreadyHandled: Boolean(options.automatic),
            cooldownActive: Boolean(options.automatic),
            skipReason: null,
        });

        if (options.automatic) {
            const selection = await showPostReadyPrompt(true);
            if (selection === 'pause') {
                await setDevGhostPaused(true);
                void Promise.resolve(vscode.window.showInformationMessage('Suggestions paused.')).catch(() => undefined);
                return;
            }

            if (selection !== 'review') {
                return;
            }
        } else {
            const selection = await showPostReadyPrompt(false);
            if (selection !== 'review') {
                return;
            }
        }

        await showDraftReview(draftResponse.draftText, {
            onOpen: options.onOpen,
            onFeedback: async (feedback) => {
                try {
                    await cloudClient.postFeedback({
                        deviceId,
                        requestId: draftResponse.requestId,
                        draftId: draftResponse.draftId,
                        clientVersion,
                        triggerType: buildResult.request.triggerType,
                        feedbackType: feedback.feedbackType,
                        topicTag: draftResponse.topicTag,
                        angle: draftResponse.angle,
                        timestampUtc: new Date().toISOString(),
                        dismissReason: feedback.dismissReason,
                    });
                    await cloudRepetitionMemory?.recordFeedback(draftResponse.topicTag, draftResponse.angle, feedback.feedbackType);
                    logDebug(`Cloud feedback recorded: ${feedback.feedbackType}`);
                } catch (error) {
                    logDebug(`Cloud feedback not saved: ${formatCloudErrorMessage(error)}`);
                }
            },
        });
    } catch (error) {
        const message = formatCloudErrorMessage(error);
        const cloudErrorCode = isCloudClientError(error) ? error.code : null;
        const providerFailureReason = cloudErrorCode === 'PROVIDER_ERROR' && isCloudClientError(error) && typeof error.details?.reason === 'string'
            ? error.details.reason
            : null;
        const skipReason = providerFailureReason
            ? normalizeCloudSkipReason(providerFailureReason)
            : cloudErrorCode === 'QUOTA_EXCEEDED'
                ? 'quota_exhausted'
                : cloudErrorCode === 'PROVIDER_RATE_LIMITED'
                    ? 'cloud_rate_limited'
                    : cloudErrorCode === 'UPSTREAM_TIMEOUT'
                        ? 'cloud_timeout'
                    : cloudErrorCode === 'REQUEST_ABORTED'
                            ? 'request_aborted'
                            : 'cloud_failed';

        await postDecisionState?.upsert({
            eventId,
            triggerType: options.triggerType,
            automatic: Boolean(options.automatic),
            blocker: providerFailureReason === 'max_tokens'
                ? 'max_tokens'
                : providerFailureReason
                    ? 'cloud_invalid_post_shape'
                : skipReason === 'quota_exhausted'
                    ? 'quota_exhausted'
                    : skipReason === 'cloud_rate_limited'
                        ? 'cloud_rate_limited'
                        : skipReason === 'cloud_timeout'
                            ? 'cloud_timeout'
                            : skipReason === 'request_aborted'
                                ? 'request_aborted'
                                : 'cloud_failed',
            skipReason,
            cloudStatus: cloudErrorCode === 'QUOTA_EXCEEDED'
                ? 'quota_exhausted'
                : providerFailureReason
                    ? 'rejected'
                    : 'failed',
            postAccepted: false,
        });
        if (options.automatic) {
            recordAutomaticDraftFailure(autoEventKey);
        }
        if (!options.automatic) {
            logError(`Post generation failed: ${message}`);
            vscode.window.showErrorMessage(`DevGhost: ${message}`);
        } else {
            logDebug(`Post generation failed: ${message}`);
        }
    }
}

function noteManualActionWhilePaused(): void {
    if (!isDevGhostPaused()) {
        return;
    }

    void vscode.window.showInformationMessage('DevGhost is paused, but you can still write a post manually.');
}

async function runDraftFlow(options: DraftFlowOptions): Promise<void> {
    if (options.automatic) {
        const eventKey = options.eventKey || options.label;
        const suppressionReason = getAutoDraftSuppressionReason(eventKey);
        if (suppressionReason) {
            logDebug(
                suppressionReason === 'snoozed'
                    ? `Auto draft skipped (${options.label}): snooze is active.`
                    : `Auto draft skipped (${options.label}): event already handled.`
            );
            return;
        }

        await markAutoDraftHandled(eventKey);
        workSignalManager?.recordAutomaticSuggestion(eventKey);

        const selection = await vscode.window.showInformationMessage(
            AUTO_DRAFT_PROMPT_TEXT,
            ...(options.offerAddFocus
                ? ['Add focus', 'Review draft', 'Dismiss', 'Snooze']
                : ['Review draft', 'Dismiss', 'Snooze'])
        );

        if (selection === 'Add focus') {
            await contextManager?.setFocus();
            const updatedFocus = contextManager?.getConfig()?.currentFocus?.trim() || '';
            if (updatedFocus) {
                workSignalManager?.recordFocus(updatedFocus);
            }
        }

        if (selection === 'Snooze') {
            await snoozeAutoDraftPrompts();
            logDebug('Auto draft prompts snoozed for 30 minutes.');
            return;
        }

        if (selection !== 'Review draft' && selection !== 'Add focus') {
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

    let draft: DraftFlowOutcome;
    try {
        draft = await options.createDraft();
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logDebug(`${options.label} failed: ${errMsg}`);
        if (/no compatible gemini model/i.test(errMsg) || /no compatible ai model/i.test(errMsg)) {
            vscode.window.showErrorMessage('DevGhost: No compatible AI model is available for this key.');
        } else if (/429|quota exceeded/i.test(errMsg)) {
            vscode.window.showErrorMessage('DevGhost: This AI key has no available usage left.');
        } else if (!options.automatic) {
            vscode.window.showErrorMessage('DevGhost: DevGhost could not reach the AI service.');
        }
        return;
    }
    if (isDraftFlowFailure(draft)) {
        logDebug(`${options.label} failed: ${formatDraftFailureLogMessage(draft)}`);
        if (draft.technicalError) {
            logDebug(`${options.label} raw error: ${draft.technicalError}`);
        }
        if (!options.automatic) {
            vscode.window.showErrorMessage(`DevGhost: ${formatDraftFailurePopupMessage(draft)}`);
        }
        return;
    }
    if (!draft) {
        logDebug(`${options.label}: API unavailable.`);
        return;
    }

    await showDraftReview(draft, { onOpen: options.onOpen });
}

async function runCloudDraftCommand(extensionContext: vscode.ExtensionContext): Promise<void> {
    noteManualActionWhilePaused();
    extensionContextRef = extensionContext;
    const workspaceRoot = resolveWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const manualCommitAnalysis = workspaceRoot ? await gitManager?.getCurrentHeadAnalysis() : null;
    const manualTriggerEvidence = manualCommitAnalysis
        ? buildCommitEvidence({
            workspaceRoot,
            commitAnalysis: manualCommitAnalysis,
        })
        : undefined;
    await runCloudDraftFlow({
        triggerType: 'MANUAL_INTENT',
        label: 'Cloud draft',
        eventId: randomUUID(),
        triggerEvidence: manualTriggerEvidence,
        commitHashShort: manualCommitAnalysis?.hash ?? null,
    });
}

async function handleBreakthroughDraft(durationMinutes: number, failureCount: number, command: string): Promise<void> {
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

    await runCloudDraftFlow({
        automatic: true,
        triggerType: 'FRICTION_BREAKTHROUGH',
        eventKey,
        label: 'Breakthrough draft',
        hints: {
            failedCommands: sessionManager?.getActiveStruggles(),
            successCommand: command,
            durationMinutes,
            strugglesCount: failureCount,
        },
    });
}

/**
 * Extension activation.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    extensionContextRef = context;

    // Create output channel
    outputChannel = vscode.window.createOutputChannel('DevGhost Logs');
    context.subscriptions.push(outputChannel);

    const version = context.extension.packageJSON.version || '3.4.3';
    logStatus(`DevGhost ${version} started.`);

    // Initialize the Context Manager (The Brain) — uses workspaceState only
    contextManager = new ContextManager(context.workspaceState, outputChannel);
    await contextManager.initialize();

    context.subscriptions.push(contextManager);
    workspaceState = context.workspaceState;
    cloudQuotaState = new CloudQuotaState(context.globalState);
    cloudRepetitionMemory = new CloudRepetitionMemory(context.workspaceState);
    postDecisionState = new PostDecisionState(context.workspaceState);
    workSignalManager = new WorkSignalManager(context.workspaceState, outputChannel);
    workSignalManager.recordFocus(contextManager.getConfig()?.currentFocus || '');
    workSignalManager.recordActiveFile(vscode.window.activeTextEditor?.document ?? null);

    const workspaceRoot = resolveWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    if (workspaceRoot) {
        await seedCloudBaselineSummary(workspaceRoot);
        logStatus('Cloud drafts ready.');
        logStatus('Watching this workspace.');
    }

    // Initialize the Session Manager (The Nervous System)
    sessionManager = new SessionManager(outputChannel);
    context.subscriptions.push(sessionManager);

    // Initialize the Git Manager (The Historian)
    gitManager = new GitManager(outputChannel, context.workspaceState, sessionManager.getSession().startTime);
    gitManager.onCommit((analysis) => {
        handleCommitDetected(analysis);
    });
    await gitManager.initialize();
    context.subscriptions.push(gitManager);

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
        logDebug(`Gemini API (${kind}): ${reason}${errorMessage ? ` - ${errorMessage}` : ''}`);
        if (reason === 'ERROR' && errorMessage && (String(errorMessage).includes('404') || String(errorMessage).includes('401'))) {
            vscode.window.showErrorMessage('DevGhost: No compatible AI model is available for this key.');
        }
    });

    // Load legacy Gemini key from SecretStorage before any handler runs.
    geminiReadyPromise = initializeGeminiFromStorage();

    // Phase 7: Initialize History Manager (workspaceState only) — before handshake so we can log draft review events
    historyManager = new HistoryManager(context.workspaceState, outputChannel);
    historyManager.onWarmup(async (summary, lastEvents) => {
        handleWarmup(summary, lastEvents);
    });
    await historyManager.initialize();
    context.subscriptions.push(historyManager);

    // Phase 8: Initialize draft engine before handshake so we can run PROJECT_LAUNCH / PROJECT_RESUME
    const workspaceRootForBrain = resolveWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const agentTools = new AgentTools(historyManager, workspaceRootForBrain);
    agenticBrain = new AgenticBrain(geminiService, agentTools);

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
        const workspaceRoot = resolveWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const eventKey = buildOpaqueWorkspaceEventKey('deep-work', workspaceRoot, session.getSession().startTime.toISOString());
        if (!workspaceRoot) return;
        if (!await allowAutomaticDraft({
            trigger: 'DEEP_WORK_WRAP_UP',
            eventKey,
            label: 'Deep work draft',
        })) {
            return;
        }

        await runCloudDraftFlow({
            automatic: true,
            triggerType: 'DEEP_WORK_WRAP_UP',
            eventKey,
            label: 'Deep work draft',
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
        logDebug('Friction breakthrough tracking enabled');
    } catch {
        logDebug('Shell Integration not available (friction breakthrough disabled)');
    }
}

/**
 * Register all DevGhost commands.
 */
function registerCommands(context: vscode.ExtensionContext): void {
    // Command: Edit project details
    const initCommand = vscode.commands.registerCommand('devghost.initialize', async () => {
        const created = await contextManager?.createConfig();
        if (!created) {
            return;
        }

        const workspaceRoot = resolveWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        await seedCloudBaselineSummary(workspaceRoot);
        workSignalManager?.recordFocus(contextManager?.getConfig()?.currentFocus || '');
    });
    context.subscriptions.push(initCommand);

    // Command: Set focus
    const setFocusCommand = vscode.commands.registerCommand('devghost.setFocus', async () => {
        await contextManager?.setFocus();
        workSignalManager?.recordFocus(contextManager?.getConfig()?.currentFocus || '');
    });
    context.subscriptions.push(setFocusCommand);

    // Command: Pause suggestions
    const pauseCommand = vscode.commands.registerCommand('devghost.pause', async () => {
        await setDevGhostPaused(true);
        vscode.window.showInformationMessage('Suggestions paused.');
    });
    context.subscriptions.push(pauseCommand);

    // Command: Resume suggestions
    const resumeCommand = vscode.commands.registerCommand('devghost.resume', async () => {
        await setDevGhostPaused(false);
        logStatus('Watching this workspace.');
        vscode.window.showInformationMessage('Watching this workspace.');
    });
    context.subscriptions.push(resumeCommand);

    // Command: Show logs
    const showLogsCommand = vscode.commands.registerCommand('devghost.showLogs', () => {
        outputChannel?.show(true);
    });
    context.subscriptions.push(showLogsCommand);

    const showLastPostDecisionCommand = vscode.commands.registerCommand('devghost.showLastPostDecision', async () => {
        const summaryLines = buildPostDecisionSummary(postDecisionState?.getLatest() ?? null);
        outputChannel?.appendLine('Last post decision summary:');
        for (const line of summaryLines) {
            outputChannel?.appendLine(line);
        }
        outputChannel?.show(true);
        await Promise.resolve(vscode.window.showInformationMessage(summaryLines[0] ?? 'No post decision recorded.'));
    });
    context.subscriptions.push(showLastPostDecisionCommand);

    // Command: Privacy & data use
    const privacyCommand = vscode.commands.registerCommand('devghost.privacy', async () => {
        await showPrivacyAndDataUse();
    });
    context.subscriptions.push(privacyCommand);

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
        logStatus('Project context reset.');
        vscode.window.showInformationMessage('Project context reset.');
    });
    context.subscriptions.push(resetProjectContextCommand);

    // Command: Clear legacy AI key
    const clearAiKeyCommand = vscode.commands.registerCommand('devghost.clearApiKey', async () => {
        const selection = await vscode.window.showInformationMessage(
            'Clear the legacy Gemini key stored for DevGhost?',
            { modal: true },
            'Clear key',
            'Cancel'
        );

        if (selection !== 'Clear key') {
            return;
        }

        await keyManager?.deleteApiKey();
        geminiService?.clear();
        outputChannel?.appendLine('[DevGhost] Legacy Gemini key cleared.');
        vscode.window.showInformationMessage('Legacy Gemini key cleared.');
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
        await postDecisionState?.clear();
        await updateAutoDraftState(() => ({
            snoozedUntil: 0,
            handledEventKeys: [],
        }));
        await context.workspaceState.update(TERMINAL_FAILURE_STREAK_KEY, []);
        logStatus('Recent activity reset.');
        vscode.window.showInformationMessage('Recent activity reset.');
    });
    context.subscriptions.push(resetRecentActivityCommand);

    // Command: Add legacy AI key
    const setApiKeyCommand = vscode.commands.registerCommand('devghost.setApiKey', async () => {
        const apiKey = await vscode.window.showInputBox({
            prompt: 'Enter your legacy Gemini API key',
            password: true,
            placeHolder: 'AIza...',
            ignoreFocusOut: true,
        });

        if (apiKey) {
            await keyManager?.setApiKey(apiKey);
            
            // Runtime Re-initialization
            await geminiService?.initialize(apiKey);
            const selected = await geminiService?.resolveBestModel();
            outputChannel?.appendLine(`[DevGhost] Selected model: ${selected}`);
            
            outputChannel?.appendLine('[DevGhost] Legacy Gemini key saved. Validating...');
            
            try {
                const isValid = await geminiService?.validateKey();
                if (isValid) {
                    outputChannel?.appendLine('[DevGhost] Legacy AI setup looks good.');
                    vscode.window.showInformationMessage('DevGhost: Legacy AI setup looks good.');
                } else {
                    outputChannel?.appendLine('[DevGhost] Legacy AI setup could not be verified.');
                    vscode.window.showWarningMessage('DevGhost: Legacy AI setup could not be verified.');
                }
            } catch (error: any) {
                const errMsg = error?.message || String(error);
                outputChannel?.appendLine(`[DevGhost] Legacy AI key validation failed: ${errMsg}`);
                if (/no compatible gemini model/i.test(errMsg) || /no compatible ai model/i.test(errMsg)) {
                    vscode.window.showErrorMessage('DevGhost: No compatible AI model is available for this legacy key.');
                } else if (/401|403|invalid|unauthorized/i.test(errMsg)) {
                    vscode.window.showErrorMessage('DevGhost: This legacy AI key is invalid.');
                } else if (/429|quota exceeded/i.test(errMsg)) {
                    vscode.window.showErrorMessage('DevGhost: This legacy AI key has no available usage left.');
                } else {
                    vscode.window.showErrorMessage('DevGhost: DevGhost could not reach the legacy AI service.');
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
            outputChannel?.appendLine('[DevGhost] Checking legacy AI setup...');

        const apiKey = await keyManager?.getApiKey();
        if (!apiKey) {
            outputChannel?.appendLine('[DevGhost] Legacy AI client not initialized.');
            vscode.window.showErrorMessage('DevGhost: Legacy AI setup is not configured.');
            return;
        }

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "DevGhost: Checking legacy AI setup...",
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
                    outputChannel?.appendLine('[DevGhost] Legacy AI setup looks good.');
                    vscode.window.showInformationMessage('DevGhost: Legacy AI setup looks good.');
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
                vscode.window.showErrorMessage('DevGhost: No compatible AI model is available for this legacy key.');
            } else if (errMsg.includes('429') || errMsg.toLowerCase().includes('quota exceeded')) {
                const cleanMsg = "This legacy AI key has no available usage left.";
                outputChannel?.appendLine(`[DevGhost] [ERROR] ${cleanMsg}`);
                outputChannel?.appendLine(`[DevGhost] Raw error: ${errMsg}`);
                vscode.window.showErrorMessage(`DevGhost: ${cleanMsg}`);
            } else {
                outputChannel?.appendLine(`[DevGhost] Legacy AI setup failed: ${errMsg}`);
                outputChannel?.appendLine(`[DevGhost] Raw error: ${errMsg}`);
                if (errMsg.toLowerCase().includes('no compatible gemini model') || errMsg.toLowerCase().includes('no compatible ai model')) {
                    vscode.window.showErrorMessage('DevGhost: No compatible AI model is available for this legacy key.');
                } else {
                    vscode.window.showErrorMessage('DevGhost: DevGhost could not reach the legacy AI service.');
                }
            }
        }
    });
    context.subscriptions.push(checkAiConnectionCommand);

    const cloudDraftCommand = vscode.commands.registerCommand('devghost.cloudDraft', async () => {
        await runCloudDraftCommand(context);
    });
    context.subscriptions.push(cloudDraftCommand);

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

    await runCloudDraftFlow({
        automatic: true,
        triggerType: 'WARMUP_RETURN',
        eventKey,
        label: 'Return draft',
        hints: {
            recentCommits,
        },
    });
}

/**
 * Handle silence detection (60+ mins with no commits + struggles).
 */
async function handleSilenceDetected(durationMinutes: number, strugglesCount: number): Promise<void> {
    const config = contextManager?.getConfig();
    const projectName = config?.projectName || 'my project';
    const eventKey = `silence:${projectName}:${durationMinutes}:${strugglesCount}:${config?.currentFocus || 'no-focus'}`;
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

    await runCloudDraftFlow({
        automatic: true,
        triggerType: 'SILENCE_BREAKER',
        eventKey,
        label: 'Recent work draft',
        hints: {
            durationMinutes,
            strugglesCount,
            failedCommands: sessionManager?.getActiveStruggles(),
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
    if (!isFreshCommitForSession(analysis)) {
        logDebug(`Existing commit skipped: ${analysis.hash} predates this DevGhost session.`);
        return;
    }

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
    const eventKey = buildOpaqueWorkspaceEventKey('commit', analysis.repoRoot, analysis.hash);
    if (!await allowAutomaticDraft({
        trigger: 'COMMIT_DETECTED',
        eventKey,
        label: 'Commit draft',
        hints: { commitAnalysis: analysis }
    })) {
        return;
    }

    const scoreDecision = consumeAutomaticDraftDecision(eventKey);
    const triggerEvidence = buildCommitEvidence({
        workspaceRoot: analysis.repoRoot,
        commitAnalysis: analysis,
        signalReasons: scoreDecision?.decision.reasons,
        gateReasons: scoreDecision?.decision.blockers,
    });

    await runCloudDraftFlow({
        automatic: true,
        triggerType: 'COMMIT_DETECTED',
        eventKey,
        eventId: scoreDecision?.eventId,
        label: 'Commit draft',
        hints: { commitAnalysis: analysis },
        triggerEvidence,
        commitHashShort: analysis.hash,
    });
}

// Phase 5 commit-driven drafting removed in Phase 3.

/**
 * Load legacy Gemini state without auto-starting the old path.
 * Cloud remains the default, and the legacy path only activates when invoked.
 */
async function initializeGeminiFromStorage(): Promise<void> {
    const apiKey = await keyManager?.getApiKey();
    if (apiKey && geminiService) {
        logDebug('Legacy Gemini key detected.');
    } else {
        logDebug('Post suggestions ready.');
    }
}

// ═══════════════════════════════════════════════════════════════
// PHASE 9: Brain Check - API Key Notifications
// ═══════════════════════════════════════════════════════════════

/**
 * Check whether legacy Gemini setup exists for explicit old-path commands.
 */
async function checkApiKeyOnStartup(): Promise<void> {
    const hasKey = await keyManager?.hasApiKey();
    
    if (!hasKey) {
        outputChannel?.appendLine('[DevGhost] Legacy Gemini setup is not configured.');
        
        const selection = await vscode.window.showWarningMessage(
            'Legacy Gemini setup is not configured.',
            'Open legacy setup',
            'Not now'
        );
        
        if (selection === 'Open legacy setup') {
            vscode.commands.executeCommand('devghost.setApiKey');
        }
    }
}

/**
 * Extension deactivation.
 */
export function deactivate(): void {
    logDebug('DevGhost deactivated.');
}

