import {
    DEFAULT_GEMINI_MODEL,
    MAX_ACTIVE_SYMBOL_CHARS,
    MAX_CHANGED_PATH_CHARS,
    MAX_COMMAND_NAME_CHARS,
    MAX_COMMIT_MESSAGE_CHARS,
    MAX_COMMIT_EVIDENCE_REASON_CHARS,
    MAX_COMMIT_EVIDENCE_REASONS,
    MAX_COMMIT_WORK_TYPE_CHARS,
    MAX_CURRENT_FOCUS_CHARS,
    MAX_DIFF_EXCERPT_CHARS,
    MAX_DIFF_EXCERPT_LABEL_CHARS,
    MAX_DIFF_EXCERPT_PATH_CHARS,
    MAX_FRICTION_SUMMARY_CHARS,
    MAX_PHRASE_CHARS,
    MAX_PROJECT_NAME_CHARS,
    MAX_PROJECT_SUMMARY_CHARS,
    MAX_REQUEST_CONTEXT_BYTES,
    MAX_SELECTED_DIFF_EXCERPTS,
    MAX_TOTAL_DIFF_EXCERPT_CHARS,
    type CommitEvidence,
    type DraftRequest,
} from './contracts';
import { providerError, providerRateLimited, upstreamTimeout } from './errors';
import { redactTextForPrompt } from './redaction';
import type { RepetitionSnapshot } from './repetition';
import { classifyDraftShapeFailure, cleanDraftText, toInvalidPostShapeReasonCode } from './postShape';

export interface GeminiDraftResult {
    draftText: string;
    modelName: string;
    retryAttempted?: boolean;
}

function assertGeminiKey(): string {
    const key = process.env.GEMINI_API_KEY?.trim();
    if (!key) {
        throw providerError('GEMINI_API_KEY is not configured.');
    }
    return key;
}

function getModelName(): string {
    return process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
}

function renderFileTypeSummary(request: DraftRequest): string {
    const summary = request.fileTypeSummary;
    if (!summary) return '(not provided)';
    return [
        `total=${summary.totalChangedFiles}`,
        `source=${summary.sourceFiles}`,
        `config=${summary.configFiles}`,
        `docs=${summary.docsFiles}`,
        `style=${summary.styleFiles}`,
        `generated=${summary.generatedFiles}`,
        `noise=${summary.noiseFiles}`,
        `featurePaths=${summary.featurePathMatches}`,
    ].join(', ');
}

function renderList(values: string[] | undefined, maxChars: number): string {
    return (values ?? []).map((entry) => `- ${redactTextForPrompt(entry).slice(0, maxChars)}`).join('\n') || '(none)';
}

function renderCommitEvidence(evidence: CommitEvidence | undefined): string {
    if (!evidence) {
        return '(none)';
    }

    const commitMessage = evidence.commitMessage
        ? redactTextForPrompt(evidence.commitMessage).slice(0, MAX_COMMIT_MESSAGE_CHARS)
        : '(not provided)';
    const workType = evidence.workType
        ? redactTextForPrompt(evidence.workType).slice(0, MAX_COMMIT_WORK_TYPE_CHARS)
        : '(not provided)';
    const changedFileCount = evidence.changedFileCount ?? '(not provided)';
    const additions = evidence.additions ?? '(not provided)';
    const deletions = evidence.deletions ?? '(not provided)';
    const diffExcerptCount = evidence.diffExcerptCount ?? '(not provided)';
    const diffExcerptChars = evidence.diffExcerptChars ?? '(not provided)';

    const changedRelativePaths = renderList(evidence.changedRelativePaths, MAX_CHANGED_PATH_CHARS);
    const signalReasons = renderList(evidence.signalReasons?.slice(0, MAX_COMMIT_EVIDENCE_REASONS), MAX_COMMIT_EVIDENCE_REASON_CHARS);
    const gateReasons = renderList(evidence.gateReasons?.slice(0, MAX_COMMIT_EVIDENCE_REASONS), MAX_COMMIT_EVIDENCE_REASON_CHARS);
    const selectedDiffExcerpts = (evidence.selectedDiffExcerpts ?? [])
        .slice(0, MAX_SELECTED_DIFF_EXCERPTS)
        .map((excerpt, index) => {
            const label = excerpt.label ? ` (${redactTextForPrompt(excerpt.label).slice(0, MAX_DIFF_EXCERPT_LABEL_CHARS)})` : '';
            const path = redactTextForPrompt(excerpt.path).slice(0, MAX_DIFF_EXCERPT_PATH_CHARS);
            const body = redactTextForPrompt(excerpt.excerpt).slice(0, MAX_DIFF_EXCERPT_CHARS);
            return [`EXCERPT ${index + 1}${label}`, `path: ${path}`, body].join('\n');
        })
        .join('\n\n')
        .slice(0, MAX_TOTAL_DIFF_EXCERPT_CHARS);

    return [
        'commitEvidence (transient only):',
        `commitMessage: ${commitMessage}`,
        `workType: ${workType}`,
        `additions: ${additions}`,
        `deletions: ${deletions}`,
        `changedFileCount: ${changedFileCount}`,
        `signalReasons:`,
        signalReasons,
        `gateReasons:`,
        gateReasons,
        `diffExcerptCount: ${diffExcerptCount}`,
        `diffExcerptChars: ${diffExcerptChars}`,
        `selectedDiffExcerpts:`,
        selectedDiffExcerpts || '(none)',
        `supportingChangedRelativePaths:`,
        changedRelativePaths,
    ].join('\n');
}

function renderPrompt(request: DraftRequest, repetition: RepetitionSnapshot, options?: { retryAttempted?: boolean }): string {
    const diffExcerpts = (request.selectedDiffExcerpts ?? [])
        .slice(0, MAX_SELECTED_DIFF_EXCERPTS)
        .map((excerpt, index) => {
            const label = excerpt.label ? ` (${redactTextForPrompt(excerpt.label).slice(0, MAX_DIFF_EXCERPT_LABEL_CHARS)})` : '';
            const path = redactTextForPrompt(excerpt.path).slice(0, MAX_DIFF_EXCERPT_PATH_CHARS);
            const body = redactTextForPrompt(excerpt.excerpt).slice(0, MAX_DIFF_EXCERPT_CHARS);
            return [`EXCERPT ${index + 1}${label}`, `path: ${path}`, body].join('\n');
        })
        .join('\n\n')
        .slice(0, MAX_TOTAL_DIFF_EXCERPT_CHARS);

    const commitMessages = (request.commitMessages ?? []).map((entry) => `- ${redactTextForPrompt(entry).slice(0, MAX_COMMIT_MESSAGE_CHARS)}`).join('\n') || '(none)';
    const changedPathCount = request.changedRelativePaths?.length ?? 0;
    const activeSymbols = (request.activeSymbols ?? []).map((entry) => `- ${redactTextForPrompt(entry).slice(0, MAX_ACTIVE_SYMBOL_CHARS)}`).join('\n') || '(none)';
    const failedCommands = (request.failedCommandNames ?? []).map((entry) => `- ${redactTextForPrompt(entry).slice(0, MAX_COMMAND_NAME_CHARS)}`).join('\n') || '(none)';
    const successfulCommands = (request.successfulCommandNames ?? []).map((entry) => `- ${redactTextForPrompt(entry).slice(0, MAX_COMMAND_NAME_CHARS)}`).join('\n') || '(none)';
    const phrasesToAvoid = (request.phrasesToAvoid ?? []).map((entry) => `- ${redactTextForPrompt(entry).slice(0, MAX_PHRASE_CHARS)}`).join('\n') || '(none)';
    const recentTopicTags = (request.recentTopicTags ?? []).join(', ') || '(none)';
    const recentAngles = (request.recentAngles ?? []).join(', ') || '(none)';
    const avoidTopics = repetition.avoidTopics.join(', ') || '(none)';
    const avoidAngles = repetition.avoidAngles.join(', ') || '(none)';

    const currentFocus = request.currentFocus ? redactTextForPrompt(request.currentFocus).slice(0, MAX_CURRENT_FOCUS_CHARS) : '(not provided)';
    const frictionSummary = request.frictionSummary ? redactTextForPrompt(request.frictionSummary).slice(0, MAX_FRICTION_SUMMARY_CHARS) : '(not provided)';
    const projectName = request.projectName ? redactTextForPrompt(request.projectName).slice(0, MAX_PROJECT_NAME_CHARS) : '(not provided)';
    const projectSummary = redactTextForPrompt(request.projectSummary).slice(0, MAX_PROJECT_SUMMARY_CHARS);
    const contextBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
    const estimatedBytes = Math.min(contextBytes, MAX_REQUEST_CONTEXT_BYTES);
    const sessionDuration = request.sessionDurationMinutes ?? '(not provided)';

    return [
        'You are DevGhost Cloud.',
        'Write one short human draft for a developer sharing progress.',
        'Return only the draft text.',
        'Keep it under 280 characters.',
        'Do not mention that you are an AI.',
        'Do not mention internal rules, logging, or hidden metadata.',
        'Prefer a specific, fresh angle over a generic recap.',
        'If commit evidence is present, use it first and mention one concrete change or result from it.',
        'Do not write a headline, setup line, or vague status note.',
        'Do not repeat the recent topics or angles if you can avoid it.',
        'Never output only a file path, filename, code symbol, heading, or label.',
        'Do not end inside a code token or leave a dangling backtick.',
        'Write a natural-language post.',
        ...(options?.retryAttempted
            ? [
                'This is a retry.',
                'The last output was invalid because it was a headline, setup line, or fragment instead of a concrete post.',
                'Do not return a file path, filename, heading, label, code token, dangling backtick, cut-off fragment, or vague status note.',
                'Write exactly one natural-language sentence about a concrete change or result.',
                '',
            ]
            : []),
        '',
        ...(request.triggerType === 'COMMIT_DETECTED'
            ? [
                'This is a commit-triggered post.',
                'Use the commit message, work type, additions/deletions, signal reasons, gate reasons, and diff excerpt summary first.',
                'Treat changed file paths as supporting evidence only.',
                'Mention one concrete change from the provided commit evidence or diff excerpts.',
                'Avoid generic openings like "Just shipped...", "Made some updates...", "Improved the app...", "Working on the project...", and "Pushed some changes."',
                'Do not invent details that are not present in the evidence.',
                '',
            ]
            : []),
        `triggerType: ${request.triggerType}`,
        `projectName: ${projectName}`,
        `projectSummary: ${projectSummary}`,
        `currentFocus: ${currentFocus}`,
        `sessionDurationMinutes: ${sessionDuration}`,
        `commitEvidence:`,
        renderCommitEvidence(request.commitEvidence),
        `commitMessages:`,
        commitMessages,
        `supportingChangedRelativePathCount: ${changedPathCount}`,
        `fileTypeSummary: ${renderFileTypeSummary(request)}`,
        `activeSymbols:`,
        activeSymbols,
        `failedCommandNames:`,
        failedCommands,
        `successfulCommandNames:`,
        successfulCommands,
        `frictionSummary: ${frictionSummary}`,
        `selectedDiffExcerpts (transient only):`,
        diffExcerpts || '(none)',
        `recentTopicTags: ${recentTopicTags}`,
        `recentAngles: ${recentAngles}`,
        `avoidTopics: ${avoidTopics}`,
        `avoidAngles: ${avoidAngles}`,
        `phrasesToAvoid:`,
        phrasesToAvoid,
        `contextBytes: ${estimatedBytes}`,
        '',
        'Write the draft now.',
    ].join('\n');
}

function extractTextFromResponse(data: unknown): string {
    const candidate = data as {
        candidates?: Array<{
            content?: {
                parts?: Array<{ text?: string }>;
            };
        }>;
        error?: unknown;
    };

    const text = candidate.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
    return text.trim();
}

async function requestDraft(request: DraftRequest, repetition: RepetitionSnapshot, commitRetry = false): Promise<string> {
    const apiKey = assertGeminiKey();
    const modelName = getModelName();
    const prompt = renderPrompt(request, repetition, { retryAttempted: commitRetry });
    const controller = new AbortController();
    const timeoutMs = 25_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`,
            {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    contents: [
                        {
                            role: 'user',
                            parts: [{ text: prompt }],
                        },
                    ],
                    generationConfig: {
                        temperature: commitRetry
                            ? (request.triggerType === 'COMMIT_DETECTED' ? 0.45 : 0.65)
                            : (request.triggerType === 'COMMIT_DETECTED' ? 0.65 : 0.8),
                        topP: 0.95,
                        maxOutputTokens: 160,
                    },
                }),
            }
        );

        if (!response.ok) {
            if (response.status === 429) {
                throw providerRateLimited('Gemini rate limited the request.');
            }
            if (response.status === 408 || response.status === 504) {
                throw upstreamTimeout('Gemini timed out.');
            }
            throw providerError(`Gemini request failed with status ${response.status}.`);
        }

        const data = await response.json();
        return cleanDraftText(extractTextFromResponse(data));
    } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
            throw upstreamTimeout('Gemini timed out.');
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

export async function generateDraft(request: DraftRequest, repetition: RepetitionSnapshot): Promise<GeminiDraftResult> {
    const modelName = getModelName();
    const firstDraft = await requestDraft(request, repetition, false);
    const firstFailure = classifyDraftShapeFailure(firstDraft);
    if (firstFailure === null) {
        return {
            draftText: firstDraft,
            modelName,
            retryAttempted: false,
        };
    }

    const retryDraft = await requestDraft(request, repetition, true);
    const retryFailure = classifyDraftShapeFailure(retryDraft);
    if (retryFailure !== null) {
        throw providerError('Gemini returned an invalid post shape.', {
            reason: toInvalidPostShapeReasonCode(retryFailure),
        });
    }

    return {
        draftText: retryDraft,
        modelName,
        retryAttempted: true,
    };
}
