import * as path from 'path';
import * as vscode from 'vscode';
import { execFileSync } from 'child_process';
import { sanitizeGeminiPayload, shouldSkipSensitivePath } from '../analyzer/aiSanitizer';
import type { ContextManager } from '../managers/contextManager';
import type { HistoryManager, HistoryEvent } from '../managers/historyManager';
import type { SessionManager } from '../managers/sessionManager';
import type { WorkSignalManager } from '../managers/workSignalManager';
import {
    MAX_COMMIT_EVIDENCE_REASON_CHARS,
    MAX_COMMIT_EVIDENCE_REASONS,
    MAX_ACTIVE_SYMBOLS,
    MAX_ACTIVE_SYMBOL_CHARS,
    MAX_ANGLE_CHARS,
    MAX_CHANGED_PATHS,
    MAX_CLIENT_VERSION_CHARS,
    MAX_COMMAND_NAME_CHARS,
    MAX_COMMIT_MESSAGE_CHARS,
    MAX_COMMIT_MESSAGES,
    MAX_CURRENT_FOCUS_CHARS,
    MAX_DIFF_EXCERPT_CHARS,
    MAX_DIFF_EXCERPT_LABEL_CHARS,
    MAX_DIFF_EXCERPT_PATH_CHARS,
    MAX_FRICTION_SUMMARY_CHARS,
    MAX_PHRASE_CHARS,
    MAX_PHRASES_TO_AVOID,
    MAX_PROJECT_NAME_CHARS,
    MAX_PROJECT_SUMMARY_CHARS,
    MAX_COMMIT_WORK_TYPE_CHARS,
    MAX_RECENT_ANGLES,
    MAX_RECENT_TOPIC_TAGS,
    MAX_FAILED_COMMANDS,
    MAX_SELECTED_DIFF_EXCERPTS,
    MAX_SESSION_DURATION_MINUTES,
    MAX_TOTAL_DIFF_EXCERPT_CHARS,
    MAX_TOPIC_TAG_CHARS,
    type CommitEvidence,
    type DiffExcerpt,
    type DraftRequest,
    type FileTypeSummary,
    type TriggerType,
} from './contracts';
import type { CommitAnalysis } from '../managers/gitManager';
import type { RepetitionSnapshot } from './repetitionMemory';

type FileCategory = 'source' | 'config' | 'docs' | 'style' | 'generated' | 'noise' | 'other';

export interface CloudDraftBuildInput {
    triggerType: TriggerType;
    deviceId: string;
    requestId: string;
    clientVersion: string;
    workspaceRoot: string;
    contextManager?: ContextManager;
    historyManager?: HistoryManager;
    sessionManager?: SessionManager;
    workSignalManager?: WorkSignalManager;
    repetitionSnapshot?: RepetitionSnapshot;
    triggerEvidence?: CommitEvidence;
}

export interface CloudDraftBuildResult {
    request: DraftRequest;
    contextBytes: number;
    excerptCount: number;
    excerptChars: number;
    changedRelativePathsCount: number;
    activeSymbolsCount: number;
    failedCommandNamesCount: number;
    successfulCommandNamesCount: number;
}

function unique(values: string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clip(value: string, maxChars: number): string {
    return value.length > maxChars ? value.slice(0, maxChars) : value;
}

function sanitizeValue(value: string | undefined, maxChars: number, workspaceRoot?: string): string | undefined {
    if (!value) {
        return undefined;
    }

    const sanitized = sanitizeGeminiPayload(value, {
        workspaceRoot,
        maxLength: maxChars,
    }).text.trim();

    return sanitized.length > 0 ? clip(sanitized, maxChars) : undefined;
}

function normalizeReason(value: string | undefined, workspaceRoot?: string): string | undefined {
    const sanitized = sanitizeValue(value, MAX_COMMIT_EVIDENCE_REASON_CHARS, workspaceRoot);
    if (!sanitized) {
        return undefined;
    }

    return sanitized
        .replace(/\s+[+-]\d+$/u, '')
        .replace(/\s+\d+\/\d+\s+below threshold$/iu, '')
        .trim();
}

function normalizeReasons(values: string[] | undefined, workspaceRoot?: string): string[] | undefined {
    if (!values || values.length === 0) {
        return undefined;
    }

    return unique(
        values
            .map((value) => normalizeReason(value, workspaceRoot))
            .filter((value): value is string => Boolean(value))
    ).slice(0, MAX_COMMIT_EVIDENCE_REASONS);
}

function summarizeCommandName(command: string | undefined): string | undefined {
    if (!command) {
        return undefined;
    }

    const sanitized = sanitizeGeminiPayload(command, {
        maxLength: MAX_COMMAND_NAME_CHARS,
    }).text.trim();
    if (!sanitized) {
        return undefined;
    }

    const firstSegment = sanitized.split('&&')[0].split(';')[0].trim();
    const tokens = firstSegment.split(/\s+/).filter(Boolean);
    const summary = tokens.slice(0, Math.min(tokens.length, 4)).join(' ');
    return summary.length > 0 ? clip(summary, MAX_COMMAND_NAME_CHARS) : undefined;
}

function normalizeRelativePath(root: string, absolutePath: string): string | null {
    const rel = path.relative(root, absolutePath).replace(/\\/g, '/').trim();
    if (!rel || rel.startsWith('..') || path.posix.isAbsolute(rel)) {
        return null;
    }
    return rel;
}

function classifyFilePath(filePath: string): FileCategory {
    if (!filePath) {
        return 'other';
    }

    if (shouldSkipSensitivePath(filePath)) {
        return 'noise';
    }

    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    const basename = path.posix.basename(normalized);
    const ext = path.posix.extname(normalized);

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

function summarizeFileTypes(paths: string[]): FileTypeSummary {
    let sourceFiles = 0;
    let configFiles = 0;
    let docsFiles = 0;
    let styleFiles = 0;
    let generatedFiles = 0;
    let noiseFiles = 0;
    let featurePathMatches = 0;

    for (const filePath of paths) {
        const category = classifyFilePath(filePath);
        switch (category) {
            case 'source':
                sourceFiles++;
                break;
            case 'config':
                configFiles++;
                break;
            case 'docs':
                docsFiles++;
                break;
            case 'style':
                styleFiles++;
                break;
            case 'generated':
                generatedFiles++;
                break;
            default:
                noiseFiles++;
                break;
        }

        if (category === 'source' && /(route|routes|api|component|components|page|pages|command|commands|config|controller|service|hook|hooks|store|module|modules|layout|screen|feature|features|middleware)/i.test(filePath)) {
            featurePathMatches++;
        }
    }

    return {
        totalChangedFiles: paths.length,
        sourceFiles,
        configFiles,
        docsFiles,
        styleFiles,
        generatedFiles,
        noiseFiles,
        featurePathMatches,
    };
}

function parseChangedPathsFromGit(workspaceRoot: string): string[] {
    if (!workspaceRoot) {
        return [];
    }

    try {
        const raw = execFileSync('git', ['status', '--porcelain'], {
            cwd: workspaceRoot,
            encoding: 'utf-8',
            maxBuffer: 256 * 1024,
        }) as string;

        return raw
            .split('\n')
            .map((line) => line.trimEnd())
            .filter(Boolean)
            .map((line) => line.slice(3).trim())
            .map((entry) => {
                const target = entry.includes(' -> ') ? entry.split(' -> ').pop() ?? entry : entry;
                return target.replace(/\\/g, '/');
            });
    } catch {
        return [];
    }
}

function toSafeRelativePaths(workspaceRoot: string, paths: string[]): string[] {
    return unique(
        paths
            .map((value) => {
                const normalized = value.replace(/\\/g, '/').trim();
                if (!normalized) {
                    return null;
                }

                if (path.posix.isAbsolute(normalized)) {
                    return normalizeRelativePath(workspaceRoot, normalized);
                }

                if (normalized.startsWith('..')) {
                    return null;
                }

                return normalized;
            })
            .filter((value): value is string => Boolean(value))
            .filter((value) => !shouldSkipSensitivePath(value))
    ).slice(0, MAX_CHANGED_PATHS);
}

function collectCommitMessages(historyManager?: HistoryManager): string[] {
    if (!historyManager) {
        return [];
    }

    const events = historyManager.getLastEvents(20);
    const commits = events.filter((event) => event.type === 'COMMIT');
    return unique(
        commits
            .map((event: HistoryEvent) => event.data?.message)
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            .map((message) => sanitizeValue(message, MAX_COMMIT_MESSAGE_CHARS))
            .filter((value): value is string => Boolean(value))
    ).slice(0, MAX_COMMIT_MESSAGES);
}

function collectFailedCommandNames(sessionManager?: SessionManager): string[] {
    if (!sessionManager) {
        return [];
    }

    return unique(
        sessionManager
            .getActiveStruggles()
            .map((command) => summarizeCommandName(command))
            .filter((value): value is string => Boolean(value))
    ).slice(0, MAX_FAILED_COMMANDS);
}

function collectSuccessfulCommandNames(workSignalManager?: WorkSignalManager): string[] {
    if (!workSignalManager) {
        return [];
    }

    return unique(
        workSignalManager
            .getRecentSuccessfulCommandNames(MAX_FAILED_COMMANDS)
            .map((command) => summarizeCommandName(command))
            .filter((value): value is string => Boolean(value))
    ).slice(0, MAX_FAILED_COMMANDS);
}

async function collectDocumentSymbols(editor: vscode.TextEditor | undefined): Promise<string[]> {
    if (!editor) {
        return [];
    }

    try {
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            editor.document.uri
        );

        if (!Array.isArray(symbols) || symbols.length === 0) {
            return [];
        }

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
                    const cleaned = sanitizeValue(item.name, MAX_ACTIVE_SYMBOL_CHARS);
                    if (cleaned) {
                        names.push(cleaned);
                    }
                }
                if (item.children.length > 0) {
                    visit(item.children);
                }
            }
        };

        visit(symbols);
        return unique(names).slice(0, MAX_ACTIVE_SYMBOLS);
    } catch {
        return [];
    }
}

async function collectActiveSymbols(workSignalManager?: WorkSignalManager): Promise<string[]> {
    const editor = vscode.window.activeTextEditor;
    const editorSymbols = await collectDocumentSymbols(editor);
    const trackedSymbols = workSignalManager?.getRecentTouchedSymbols(MAX_ACTIVE_SYMBOLS) ?? [];
    return unique([
        ...trackedSymbols,
        ...editorSymbols,
    ]).slice(0, MAX_ACTIVE_SYMBOLS);
}

function collectSelectedDiffExcerptPaths(changedPaths: string[], activeRelativePath?: string | null): string[] {
    const ordered = unique([
        ...(activeRelativePath ? [activeRelativePath] : []),
        ...changedPaths,
    ]);

    const scored = ordered.map((filePath, index) => {
        const category = classifyFilePath(filePath);
        const categoryScore = category === 'source' ? 40 : category === 'config' ? 30 : category === 'docs' ? 20 : category === 'style' ? 15 : 5;
        return {
            filePath,
            score: categoryScore + Math.max(0, 20 - index),
        };
    });

    return scored
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.filePath)
        .slice(0, MAX_SELECTED_DIFF_EXCERPTS);
}

function collectDiffExcerpt(workspaceRoot: string, relativePath: string, label: string): DiffExcerpt | null {
    if (!workspaceRoot || !relativePath) {
        return null;
    }

    if (shouldSkipSensitivePath(relativePath)) {
        return null;
    }

    try {
        const raw = execFileSync('git', ['diff', 'HEAD', '--unified=2', '--', relativePath], {
            cwd: workspaceRoot,
            encoding: 'utf-8',
            maxBuffer: 512 * 1024,
        }) as string;

        const sanitized = sanitizeGeminiPayload(raw, {
            workspaceRoot,
            maxLength: MAX_DIFF_EXCERPT_CHARS,
        }).text.trim();

        if (!sanitized) {
            return null;
        }

        return {
            path: relativePath.slice(0, MAX_DIFF_EXCERPT_PATH_CHARS),
            excerpt: clip(sanitized, MAX_DIFF_EXCERPT_CHARS),
            label: clip(label, MAX_DIFF_EXCERPT_LABEL_CHARS),
        };
    } catch {
        return null;
    }
}

function collectCommitDiffExcerpt(workspaceRoot: string, commitHash: string, relativePath: string, label: string): DiffExcerpt | null {
    if (!workspaceRoot || !commitHash || !relativePath) {
        return null;
    }

    if (shouldSkipSensitivePath(relativePath)) {
        return null;
    }

    try {
        const raw = execFileSync('git', ['show', '--unified=2', '--format=', commitHash, '--', relativePath], {
            cwd: workspaceRoot,
            encoding: 'utf-8',
            maxBuffer: 512 * 1024,
        }) as string;

        const sanitized = sanitizeGeminiPayload(raw, {
            workspaceRoot,
            maxLength: MAX_DIFF_EXCERPT_CHARS,
        }).text.trim();

        if (!sanitized) {
            return null;
        }

        return {
            path: relativePath.slice(0, MAX_DIFF_EXCERPT_PATH_CHARS),
            excerpt: clip(sanitized, MAX_DIFF_EXCERPT_CHARS),
            label: clip(label, MAX_DIFF_EXCERPT_LABEL_CHARS),
        };
    } catch {
        return null;
    }
}

export interface CommitEvidenceBuildInput {
    workspaceRoot: string;
    commitAnalysis: CommitAnalysis;
    signalReasons?: string[];
    gateReasons?: string[];
}

export function buildCommitEvidence(input: CommitEvidenceBuildInput): CommitEvidence {
    const changedRelativePaths = toSafeRelativePaths(input.workspaceRoot, input.commitAnalysis.changedFiles ?? []);
    const selectedPaths = collectSelectedDiffExcerptPaths(changedRelativePaths, null);
    const selectedDiffExcerptsByPath = new Map<string, DiffExcerpt>();

    for (const relativePath of selectedPaths) {
        const category = classifyFilePath(relativePath);
        const label = category === 'source' ? 'source' : category;
        const excerpt = collectCommitDiffExcerpt(input.workspaceRoot, input.commitAnalysis.hash, relativePath, label);
        if (excerpt && !selectedDiffExcerptsByPath.has(excerpt.path)) {
            selectedDiffExcerptsByPath.set(excerpt.path, excerpt);
        }
    }

    const selectedDiffExcerpts = [...selectedDiffExcerptsByPath.values()].slice(0, MAX_SELECTED_DIFF_EXCERPTS);
    let diffExcerptChars = selectedDiffExcerpts.reduce((sum, excerpt) => sum + excerpt.path.length + excerpt.excerpt.length + (excerpt.label?.length ?? 0), 0);
    if (diffExcerptChars > MAX_TOTAL_DIFF_EXCERPT_CHARS) {
        const trimmed: DiffExcerpt[] = [];
        let running = 0;
        for (const excerpt of selectedDiffExcerpts) {
            const size = excerpt.path.length + excerpt.excerpt.length + (excerpt.label?.length ?? 0);
            if (running + size > MAX_TOTAL_DIFF_EXCERPT_CHARS) {
                break;
            }
            trimmed.push(excerpt);
            running += size;
        }
        diffExcerptChars = running;
        selectedDiffExcerpts.splice(0, selectedDiffExcerpts.length, ...trimmed);
    }

    const additions = Math.max(0, input.commitAnalysis.additions || 0);
    const deletions = Math.max(0, input.commitAnalysis.deletions || 0);
    const workType = sanitizeValue(input.commitAnalysis.workType, MAX_COMMIT_WORK_TYPE_CHARS, input.workspaceRoot);

    return {
        commitMessage: sanitizeValue(input.commitAnalysis.message, MAX_COMMIT_MESSAGE_CHARS, input.workspaceRoot),
        changedRelativePaths,
        additions,
        deletions,
        workType,
        changedFileCount: Math.max(0, input.commitAnalysis.filesChanged || changedRelativePaths.length),
        signalReasons: normalizeReasons(input.signalReasons, input.workspaceRoot),
        gateReasons: normalizeReasons(input.gateReasons, input.workspaceRoot),
        diffExcerptCount: selectedDiffExcerpts.length,
        diffExcerptChars,
        selectedDiffExcerpts,
    };
}

function buildProjectSummary(input: CloudDraftBuildInput, changedPaths: string[]): string {
    const config = input.contextManager?.getConfig();
    const workspaceName = input.workspaceRoot ? path.basename(input.workspaceRoot.replace(/\\/g, '/')) : 'workspace';
    const projectName = sanitizeValue(config?.projectName || workspaceName, MAX_PROJECT_NAME_CHARS, input.workspaceRoot);
    const mission = sanitizeValue(config?.mission, MAX_PROJECT_NAME_CHARS, input.workspaceRoot);
    const baseline = sanitizeValue(input.contextManager?.getBaselineSummary() || '', MAX_PROJECT_SUMMARY_CHARS, input.workspaceRoot);
    const activeFileHint = changedPaths[0] ? `Recent file: ${changedPaths[0]}` : '';

    const summaryParts = [
        projectName ? `Project: ${projectName}` : `Workspace: ${workspaceName}`,
        mission ? `Mission: ${mission}` : '',
        baseline ? `Baseline: ${baseline}` : '',
        activeFileHint,
    ].filter(Boolean);

    const summary = summaryParts.join('\n');
    return clip(summary, MAX_PROJECT_SUMMARY_CHARS);
}

function buildCurrentFocus(input: CloudDraftBuildInput): string | undefined {
    const focus = sanitizeValue(input.contextManager?.getConfig()?.currentFocus || '', MAX_CURRENT_FOCUS_CHARS, input.workspaceRoot);
    return focus || undefined;
}

function buildFrictionSummary(input: CloudDraftBuildInput): string | undefined {
    const summary = sanitizeValue(input.sessionManager?.getRecentFrictionSummary(30) || '', MAX_FRICTION_SUMMARY_CHARS, input.workspaceRoot);
    return summary || undefined;
}

function buildFileTypeSummary(changedPaths: string[]): FileTypeSummary {
    return summarizeFileTypes(changedPaths);
}

function buildContextBytes(request: DraftRequest): number {
    return Buffer.byteLength(JSON.stringify(request), 'utf8');
}

export async function buildCloudDraftRequest(input: CloudDraftBuildInput): Promise<CloudDraftBuildResult> {
    const commitEvidence = input.triggerEvidence;
    const hasCommitEvidence = !!commitEvidence;
    const changedPaths = hasCommitEvidence
        ? toSafeRelativePaths(input.workspaceRoot, commitEvidence?.changedRelativePaths ?? [])
        : toSafeRelativePaths(input.workspaceRoot, parseChangedPathsFromGit(input.workspaceRoot));

    const selectedDiffExcerpts = hasCommitEvidence
        ? [...(commitEvidence?.selectedDiffExcerpts ?? [])].slice(0, MAX_SELECTED_DIFF_EXCERPTS)
        : (() => {
            const activeRelativePath = (() => {
                const activeEditor = vscode.window.activeTextEditor;
                if (!activeEditor) {
                    return null;
                }
                const rel = normalizeRelativePath(input.workspaceRoot, activeEditor.document.uri.fsPath);
                return rel && !shouldSkipSensitivePath(rel) ? rel : null;
            })();

            const excerptPaths = collectSelectedDiffExcerptPaths(changedPaths, activeRelativePath);
            const selectedDiffExcerptsByPath = new Map<string, DiffExcerpt>();
            for (const relativePath of excerptPaths) {
                const category = classifyFilePath(relativePath);
                const label = category === 'source' ? 'source' : category;
                const excerpt = collectDiffExcerpt(input.workspaceRoot, relativePath, label);
                if (excerpt && !selectedDiffExcerptsByPath.has(excerpt.path)) {
                    selectedDiffExcerptsByPath.set(excerpt.path, excerpt);
                }
            }
            return [...selectedDiffExcerptsByPath.values()].slice(0, MAX_SELECTED_DIFF_EXCERPTS);
        })();

    let excerptChars = selectedDiffExcerpts.reduce((sum, excerpt) => sum + excerpt.path.length + excerpt.excerpt.length + (excerpt.label?.length ?? 0), 0);
    if (excerptChars > MAX_TOTAL_DIFF_EXCERPT_CHARS) {
        const trimmed: DiffExcerpt[] = [];
        let running = 0;
        for (const excerpt of selectedDiffExcerpts) {
            const size = excerpt.path.length + excerpt.excerpt.length + (excerpt.label?.length ?? 0);
            if (running + size > MAX_TOTAL_DIFF_EXCERPT_CHARS) {
                break;
            }
            trimmed.push(excerpt);
            running += size;
        }
        excerptChars = running;
        selectedDiffExcerpts.splice(0, selectedDiffExcerpts.length, ...trimmed);
    }

    const repetitionSnapshot = input.repetitionSnapshot ?? {
        recentTopicTags: [],
        recentAngles: [],
        phrasesToAvoid: [],
    };

    const request: DraftRequest = {
        deviceId: input.deviceId,
        requestId: input.requestId,
        clientVersion: clip(input.clientVersion.trim(), MAX_CLIENT_VERSION_CHARS),
        triggerType: input.triggerType,
        projectName: sanitizeValue(input.contextManager?.getConfig()?.projectName || path.basename(input.workspaceRoot) || undefined, MAX_PROJECT_NAME_CHARS, input.workspaceRoot),
        projectSummary: buildProjectSummary(input, changedPaths),
        currentFocus: buildCurrentFocus(input),
        sessionDurationMinutes: Math.min(MAX_SESSION_DURATION_MINUTES, Math.max(0, input.sessionManager?.getSessionDurationMinutes() ?? 0)),
        commitMessages: unique([
            sanitizeValue(commitEvidence?.commitMessage, MAX_COMMIT_MESSAGE_CHARS, input.workspaceRoot),
            ...collectCommitMessages(input.historyManager),
        ].filter((value): value is string => typeof value === 'string' && value.length > 0)).slice(0, MAX_COMMIT_MESSAGES),
        changedRelativePaths: changedPaths,
        fileTypeSummary: buildFileTypeSummary(changedPaths),
        activeSymbols: await collectActiveSymbols(input.workSignalManager),
        failedCommandNames: collectFailedCommandNames(input.sessionManager),
        successfulCommandNames: collectSuccessfulCommandNames(input.workSignalManager),
        frictionSummary: buildFrictionSummary(input),
        selectedDiffExcerpts,
        recentTopicTags: unique(repetitionSnapshot.recentTopicTags
            .map((value) => sanitizeValue(value, MAX_TOPIC_TAG_CHARS, input.workspaceRoot))
            .filter((value): value is string => Boolean(value)))
            .slice(0, MAX_RECENT_TOPIC_TAGS),
        recentAngles: unique(repetitionSnapshot.recentAngles
            .map((value) => sanitizeValue(value, MAX_ANGLE_CHARS, input.workspaceRoot))
            .filter((value): value is string => Boolean(value)))
            .slice(0, MAX_RECENT_ANGLES),
        phrasesToAvoid: unique(repetitionSnapshot.phrasesToAvoid
            .map((value) => sanitizeValue(value, MAX_PHRASE_CHARS, input.workspaceRoot))
            .filter((value): value is string => Boolean(value)))
            .slice(0, MAX_PHRASES_TO_AVOID),
        commitEvidence: commitEvidence ? {
            commitMessage: sanitizeValue(commitEvidence.commitMessage, MAX_COMMIT_MESSAGE_CHARS, input.workspaceRoot),
            changedRelativePaths: changedPaths,
            additions: Math.max(0, commitEvidence.additions || 0),
            deletions: Math.max(0, commitEvidence.deletions || 0),
            workType: sanitizeValue(commitEvidence.workType, MAX_COMMIT_WORK_TYPE_CHARS, input.workspaceRoot),
            changedFileCount: Math.max(0, commitEvidence.changedFileCount || changedPaths.length),
            signalReasons: normalizeReasons(commitEvidence.signalReasons, input.workspaceRoot),
            gateReasons: normalizeReasons(commitEvidence.gateReasons, input.workspaceRoot),
            diffExcerptCount: selectedDiffExcerpts.length,
            diffExcerptChars: excerptChars,
            selectedDiffExcerpts,
        } : undefined,
    };

    const contextBytes = buildContextBytes(request);
    return {
        request,
        contextBytes,
        excerptCount: selectedDiffExcerpts.length,
        excerptChars,
        changedRelativePathsCount: changedPaths.length,
        activeSymbolsCount: request.activeSymbols?.length ?? 0,
        failedCommandNamesCount: request.failedCommandNames?.length ?? 0,
        successfulCommandNamesCount: request.successfulCommandNames?.length ?? 0,
    };
}
