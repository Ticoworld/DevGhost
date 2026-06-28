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
    finishReason?: string | null;
    visibleOutputTokens?: number | null;
    thoughtsTokenCount?: number | null;
    totalTokenCount?: number | null;
    promptTokenCount?: number | null;
    structuredResponse?: boolean;
}

const POST_RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        post: { type: 'string' },
    },
    required: ['post'],
} as const;

const SYSTEM_INSTRUCTION = [
    'You are DevGhost, a developer ghostwriter with a calm, specific build-in-public voice.',
    'Write one complete post from the evidence provided.',
    'Return only valid JSON matching {"post":"..."} and nothing else.',
    'Keep the post under 280 characters.',
    'Use 1-2 complete sentences.',
    'Be concrete: mention the actual change and the result.',
    'Do not write headlines, bullets, labels, file paths, code fragments, or setup lines.',
    'Do not invent details that are not supported by the evidence.',
    'Sound human, direct, and natural.',
].join('\n');

type RetryReason = 'shape' | 'max_tokens';

interface ResponseMetadata {
    finishReason: string | null;
    promptTokenCount: number | null;
    visibleOutputTokens: number | null;
    thoughtsTokenCount: number | null;
    totalTokenCount: number | null;
    modelVersion: string | null;
}

interface DraftAttemptResult extends ResponseMetadata {
    text: string;
    structuredResponse: boolean;
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

function buildThinkingConfig(modelName: string): Record<string, unknown> | undefined {
    const normalized = modelName.trim().toLowerCase();
    if (normalized.startsWith('gemini-3')) {
        return {
            thinkingLevel: 'low',
        };
    }

    if (normalized.startsWith('gemini-2.5')) {
        return {
            thinkingBudget: 0,
        };
    }

    return undefined;
}

function buildGenerationConfig(modelName: string, retryReason?: RetryReason): Record<string, unknown> {
    const normalized = modelName.trim().toLowerCase();
    const isGemini3x = normalized.startsWith('gemini-3');

    const config: Record<string, unknown> = {
        maxOutputTokens: 1024,
        responseMimeType: 'application/json',
        responseSchema: POST_RESPONSE_SCHEMA,
    };

    if (!isGemini3x) {
        config.temperature = retryReason ? 0.55 : 0.65;
        config.topP = 0.9;
        config.candidateCount = 1;
    }

    const thinkingConfig = buildThinkingConfig(modelName);
    if (thinkingConfig) {
        config.thinkingConfig = thinkingConfig;
    }

    return config;
}

function buildRetryPromptNote(retryReason?: RetryReason): string[] {
    if (!retryReason) {
        return [];
    }

    if (retryReason === 'max_tokens') {
        return [
            'This is a retry after the previous attempt was cut off by the token limit.',
            'Finish the thought cleanly in one or two complete sentences.',
            'Do not start over with a headline or leave the sentence hanging.',
            '',
        ];
    }

    return [
        'This is a retry after the previous attempt looked like a headline, setup line, or fragment.',
        'Write one complete post with a concrete change and result.',
        'Do not return a file path, filename, label, code token, or dangling backtick.',
        '',
    ];
}

function extractResponseMetadata(data: unknown): ResponseMetadata {
    const candidate = data as {
        candidates?: Array<{
            finishReason?: string;
        }>;
        usageMetadata?: {
            promptTokenCount?: number;
            candidatesTokenCount?: number;
            totalTokenCount?: number;
            thoughtsTokenCount?: number;
        };
        modelVersion?: string;
    };

    return {
        finishReason: candidate.candidates?.[0]?.finishReason ?? null,
        promptTokenCount: candidate.usageMetadata?.promptTokenCount ?? null,
        visibleOutputTokens: candidate.usageMetadata?.candidatesTokenCount ?? null,
        thoughtsTokenCount: candidate.usageMetadata?.thoughtsTokenCount ?? null,
        totalTokenCount: candidate.usageMetadata?.totalTokenCount ?? null,
        modelVersion: candidate.modelVersion ?? null,
    };
}

function extractCandidateText(data: unknown): string {
    const candidate = data as {
        candidates?: Array<{
            content?: {
                parts?: Array<{ text?: string }>;
            };
        }>;
    };

    return candidate.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('')?.trim() ?? '';
}

function parseStructuredPost(text: string): { text: string; structuredResponse: boolean } {
    const trimmed = text.trim();
    if (!trimmed) {
        return { text: '', structuredResponse: false };
    }

    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (typeof parsed === 'string') {
            return { text: parsed.trim(), structuredResponse: true };
        }

        if (parsed && typeof parsed === 'object') {
            const post = (parsed as { post?: unknown }).post;
            if (typeof post === 'string') {
                return { text: post.trim(), structuredResponse: true };
            }
        }
    } catch {
        // Fall through to the raw text fallback below.
    }

    return {
        text: trimmed,
        structuredResponse: false,
    };
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
        `supportingChangedRelativePaths:`,
        changedRelativePaths,
    ].join('\n');
}

function renderPrompt(request: DraftRequest, repetition: RepetitionSnapshot, options?: { retryAttempted?: boolean; retryReason?: RetryReason }): string {
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
    const commitEvidenceBlock = renderCommitEvidence(request.commitEvidence);
    const retryNote = buildRetryPromptNote(options?.retryReason);
    const examples = [
        'Good examples of the shape:',
        '- Got the backup panel aligned with real restore behavior. The UI now matches what backups can actually do.',
        '- Added repetition memory so the same angle does not keep resurfacing across sessions.',
        '- Tightened the CLI doctor/status path and added tests so the checks are easier to trust.',
    ];

    return [
        'You are DevGhost Cloud.',
        'Write one complete build-in-public post for a developer sharing progress.',
        'Return only valid JSON matching {"post":"..."} and nothing else.',
        'Keep it under 280 characters.',
        'Use 1-2 complete sentences.',
        'Do not mention that you are an AI.',
        'Do not mention internal rules, logging, or hidden metadata.',
        'Prefer a specific, fresh angle over a generic recap.',
        'If commit evidence is present, use it first even for MANUAL_INTENT requests.',
        'Commit evidence overrides stale focus or project summary when they conflict.',
        'Mention one concrete change and one concrete result when possible.',
        'Do not write a headline, setup line, or vague status note.',
        'Do not write bullets, labels, file paths, code fragments, or dangling backticks.',
        'Do not repeat the recent topics or angles if you can avoid it.',
        'Write a natural-language post with a concrete outcome.',
        ...retryNote,
        ...(options?.retryAttempted
            ? [
                'Do not end mid-sentence.',
            ]
            : []),
        '',
        ...examples,
        '',
        `triggerType: ${request.triggerType}`,
        `commitEvidence:`,
        commitEvidenceBlock,
        `selectedDiffExcerpts (transient only):`,
        diffExcerpts || '(none)',
        `commitMessages:`,
        commitMessages,
        `supportingChangedRelativePathCount: ${changedPathCount}`,
        `fileTypeSummary: ${renderFileTypeSummary(request)}`,
        `projectName: ${projectName}`,
        `projectSummary: ${projectSummary}`,
        `currentFocus: ${currentFocus}`,
        `sessionDurationMinutes: ${sessionDuration}`,
        `activeSymbols:`,
        activeSymbols,
        `failedCommandNames:`,
        failedCommands,
        `successfulCommandNames:`,
        successfulCommands,
        `frictionSummary: ${frictionSummary}`,
        `recentTopicTags: ${recentTopicTags}`,
        `recentAngles: ${recentAngles}`,
        `avoidTopics: ${avoidTopics}`,
        `avoidAngles: ${avoidAngles}`,
        `phrasesToAvoid:`,
        phrasesToAvoid,
        `contextBytes: ${estimatedBytes}`,
        '',
        'Write the final post now.',
    ].join('\n');
}

async function requestDraft(request: DraftRequest, repetition: RepetitionSnapshot, retryReason?: RetryReason): Promise<DraftAttemptResult> {
    const apiKey = assertGeminiKey();
    const modelName = getModelName();
    const prompt = renderPrompt(request, repetition, { retryAttempted: Boolean(retryReason), retryReason });
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
                    systemInstruction: {
                        role: 'system',
                        parts: [{ text: SYSTEM_INSTRUCTION }],
                    },
                    contents: [
                        {
                            role: 'user',
                            parts: [{ text: prompt }],
                        },
                    ],
                    generationConfig: buildGenerationConfig(modelName, retryReason),
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
        const metadata = extractResponseMetadata(data);
        const parsed = parseStructuredPost(extractCandidateText(data));
        return {
            ...metadata,
            text: parsed.text,
            structuredResponse: parsed.structuredResponse,
        };
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
    const firstDraft = await requestDraft(request, repetition);
    if (firstDraft.finishReason === 'MAX_TOKENS') {
        const retryDraft = await requestDraft(request, repetition, 'max_tokens');
        if (retryDraft.finishReason === 'MAX_TOKENS') {
            throw providerError('Gemini returned a truncated draft.', {
                reason: 'max_tokens',
                retryAttempted: true,
                finishReason: retryDraft.finishReason,
                visibleOutputTokens: retryDraft.visibleOutputTokens,
                thoughtsTokenCount: retryDraft.thoughtsTokenCount,
                totalTokenCount: retryDraft.totalTokenCount,
                promptTokenCount: retryDraft.promptTokenCount,
                modelName,
            });
        }

        const cleanedRetry = cleanDraftText(retryDraft.text);
        const retryFailure = classifyDraftShapeFailure(cleanedRetry);
        if (retryFailure !== null) {
            throw providerError('Gemini returned an invalid post shape.', {
                reason: toInvalidPostShapeReasonCode(retryFailure),
                invalidReason: retryFailure,
                retryAttempted: true,
                finishReason: retryDraft.finishReason,
                visibleOutputTokens: retryDraft.visibleOutputTokens,
                thoughtsTokenCount: retryDraft.thoughtsTokenCount,
                totalTokenCount: retryDraft.totalTokenCount,
                promptTokenCount: retryDraft.promptTokenCount,
                modelName,
            });
        }

        return {
            draftText: cleanedRetry,
            modelName,
            retryAttempted: true,
            finishReason: retryDraft.finishReason,
            visibleOutputTokens: retryDraft.visibleOutputTokens,
            thoughtsTokenCount: retryDraft.thoughtsTokenCount,
            totalTokenCount: retryDraft.totalTokenCount,
            promptTokenCount: retryDraft.promptTokenCount,
            structuredResponse: retryDraft.structuredResponse,
        };
    }

    const firstCleaned = cleanDraftText(firstDraft.text);
    const firstFailure = classifyDraftShapeFailure(firstCleaned);
    if (firstFailure === null) {
        return {
            draftText: firstCleaned,
            modelName,
            retryAttempted: false,
            finishReason: firstDraft.finishReason,
            visibleOutputTokens: firstDraft.visibleOutputTokens,
            thoughtsTokenCount: firstDraft.thoughtsTokenCount,
            totalTokenCount: firstDraft.totalTokenCount,
            promptTokenCount: firstDraft.promptTokenCount,
            structuredResponse: firstDraft.structuredResponse,
        };
    }

    const retryDraft = await requestDraft(request, repetition, 'shape');
    if (retryDraft.finishReason === 'MAX_TOKENS') {
        throw providerError('Gemini returned a truncated draft.', {
            reason: 'max_tokens',
            retryAttempted: true,
            finishReason: retryDraft.finishReason,
            visibleOutputTokens: retryDraft.visibleOutputTokens,
            thoughtsTokenCount: retryDraft.thoughtsTokenCount,
            totalTokenCount: retryDraft.totalTokenCount,
            promptTokenCount: retryDraft.promptTokenCount,
            modelName,
        });
    }

    const retryCleaned = cleanDraftText(retryDraft.text);
    const retryFailure = classifyDraftShapeFailure(retryCleaned);
    if (retryFailure !== null) {
        throw providerError('Gemini returned an invalid post shape.', {
            reason: toInvalidPostShapeReasonCode(retryFailure),
            invalidReason: retryFailure,
            retryAttempted: true,
            finishReason: retryDraft.finishReason,
            visibleOutputTokens: retryDraft.visibleOutputTokens,
            thoughtsTokenCount: retryDraft.thoughtsTokenCount,
            totalTokenCount: retryDraft.totalTokenCount,
            promptTokenCount: retryDraft.promptTokenCount,
            modelName,
        });
    }

    return {
        draftText: retryCleaned,
        modelName,
        retryAttempted: true,
        finishReason: retryDraft.finishReason,
        visibleOutputTokens: retryDraft.visibleOutputTokens,
        thoughtsTokenCount: retryDraft.thoughtsTokenCount,
        totalTokenCount: retryDraft.totalTokenCount,
        promptTokenCount: retryDraft.promptTokenCount,
        structuredResponse: retryDraft.structuredResponse,
    };
}
