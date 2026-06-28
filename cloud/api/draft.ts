import { randomUUID } from 'crypto';
import { type ApiRequestLike, type ApiResponseLike, type DraftResponse } from '../src/contracts';
import { duplicateEvent, isApiError, quotaExceeded, sendError, sendJson } from '../src/errors';
import { logError, logInfo, logWarn } from '../src/logging';
import { findDraftEventByRequestId } from '../src/neon';
import { buildRepetitionError, buildRepetitionSnapshot } from '../src/repetition';
import { generateDraft } from '../src/gemini';
import { getQuotaSnapshot, recordSuccessfulDraft } from '../src/quota';
import { parseApiRequestBody, parseDraftRequest } from '../src/validation';

function rejectMethodNotAllowed(res: ApiResponseLike): void {
    res.status(405);
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, {
        ok: false,
        error: {
            code: 'BAD_REQUEST',
            message: 'Method not allowed.',
        },
    });
}

function countSelectedDiffExcerptChars(request: ReturnType<typeof parseDraftRequest>): number {
    return (request.selectedDiffExcerpts ?? []).reduce((sum, excerpt) => {
        return sum + excerpt.path.length + excerpt.excerpt.length + (excerpt.label?.length ?? 0);
    }, 0);
}

export default async function handler(req: ApiRequestLike, res: ApiResponseLike): Promise<void> {
    const startedAt = Date.now();
    const method = (req.method ?? 'POST').toUpperCase();
    let request: ReturnType<typeof parseDraftRequest> | null = null;
    let clientVersion: string | undefined;
    let quotaMode: 'normal' | 'qa' = 'normal';

    if (method !== 'POST') {
        rejectMethodNotAllowed(res);
        return;
    }

    try {
        request = parseDraftRequest(parseApiRequestBody(req));
        clientVersion = request.clientVersion;
        const contextBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
        const excerptCount = request.selectedDiffExcerpts?.length ?? 0;
        const excerptChars = countSelectedDiffExcerptChars(request);

        const duplicate = await findDraftEventByRequestId(request.deviceId, request.requestId);
        if (duplicate) {
            throw duplicateEvent();
        }

        const [quotaSnapshot, repetition] = await Promise.all([
            getQuotaSnapshot(request.deviceId, request.clientVersion),
            buildRepetitionSnapshot(request.deviceId, request),
        ]);
        quotaMode = quotaSnapshot.limit > 3 ? 'qa' : 'normal';

        if (!quotaSnapshot.canGenerate) {
            throw quotaExceeded();
        }

        if (repetition.shouldReject && quotaMode !== 'qa') {
            throw buildRepetitionError(repetition);
        }

        if (repetition.shouldReject && quotaMode === 'qa') {
            logInfo('Draft repetition hard reject bypassed for QA mode', {
                route: '/api/draft',
                requestId: request.requestId,
                deviceId: request.deviceId,
                triggerType: request.triggerType,
                clientVersion,
                quotaMode,
                topicTag: repetition.topicTag,
                angle: repetition.angle,
                repetitionScore: repetition.score,
                repetitionShouldReject: repetition.shouldReject,
                repetitionBypassed: true,
                durationMs: Date.now() - startedAt,
            });
        }

        const draftId = randomUUID();
        const draft = await generateDraft(request, repetition);
        const recorded = await recordSuccessfulDraft({
            draftId,
            requestId: request.requestId,
            deviceId: request.deviceId,
            triggerType: request.triggerType,
            topicTag: repetition.topicTag,
            angle: repetition.angle,
            modelName: draft.modelName,
            draftLengthChars: draft.draftText.length,
            contextBytes,
            excerptCount,
            excerptChars,
            clientVersion: request.clientVersion,
        });

        const retryAttempted = draft.retryAttempted ?? false;
        const response: DraftResponse = {
            ok: true,
            requestId: request.requestId,
            draftId: recorded.draftId,
            draftText: draft.draftText,
            topicTag: repetition.topicTag,
            angle: repetition.angle,
            quota: recorded.quota,
        };

        logInfo('Draft generated', {
            route: '/api/draft',
            requestId: request.requestId,
            deviceId: request.deviceId,
            triggerType: request.triggerType,
            clientVersion,
            quotaMode,
            modelName: draft.modelName,
            retryAttempted,
            finishReason: draft.finishReason ?? undefined,
            visibleOutputTokens: draft.visibleOutputTokens ?? undefined,
            thoughtsTokenCount: draft.thoughtsTokenCount ?? undefined,
            quotaRemaining: recorded.quota.remaining,
            quotaUsed: recorded.quota.used,
            contextBytes,
            excerptCount,
            excerptChars,
            durationMs: Date.now() - startedAt,
        });

        sendJson(res, 200, response);
    } catch (error) {
        if (isApiError(error)) {
            const details = error.details ?? {};
            const retryAttempted = Boolean(details.retryAttempted);
            const finishReason = typeof details.finishReason === 'string' ? details.finishReason : undefined;
            const visibleOutputTokens = typeof details.visibleOutputTokens === 'number' ? details.visibleOutputTokens : undefined;
            const thoughtsTokenCount = typeof details.thoughtsTokenCount === 'number' ? details.thoughtsTokenCount : undefined;
            const invalidReason = typeof details.invalidReason === 'string' ? details.invalidReason : undefined;
            const providerFailureReason = error.code === 'PROVIDER_ERROR' && typeof details.reason === 'string'
                ? details.reason
                : null;
            const meta = {
                route: '/api/draft',
                errorCode: error.code,
                status: error.statusCode,
                clientVersion: clientVersion ?? request?.clientVersion,
                quotaMode,
                retryAttempted,
                reason: providerFailureReason ?? undefined,
                invalidReason,
                finishReason,
                visibleOutputTokens,
                thoughtsTokenCount,
                durationMs: Date.now() - startedAt,
            };
            if (providerFailureReason) {
                logWarn('Draft request failed', meta);
            } else if (error.statusCode >= 500) {
                logError('Draft request failed', meta);
            } else {
                logWarn('Draft request failed', meta);
            }
        } else {
            logError('Draft request crashed', {
                route: '/api/draft',
                durationMs: Date.now() - startedAt,
            });
        }

        sendError(res, error);
    }
}
