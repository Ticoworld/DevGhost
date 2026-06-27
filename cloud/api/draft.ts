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

    if (method !== 'POST') {
        rejectMethodNotAllowed(res);
        return;
    }

    try {
        const request = parseDraftRequest(parseApiRequestBody(req));
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

        if (!quotaSnapshot.canGenerate) {
            throw quotaExceeded();
        }

        if (repetition.shouldReject) {
            throw buildRepetitionError(repetition);
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
            modelName: draft.modelName,
            retryAttempted,
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
            const invalidPostShape = error.code === 'PROVIDER_ERROR' && /invalid post shape/i.test(error.message);
            const meta = {
                route: '/api/draft',
                errorCode: error.code,
                status: error.statusCode,
                retryAttempted: invalidPostShape,
                reason: invalidPostShape ? 'invalid_post_shape' : undefined,
                durationMs: Date.now() - startedAt,
            };
            if (invalidPostShape) {
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
