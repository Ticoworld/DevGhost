import { randomUUID } from 'crypto';
import { type ApiRequestLike, type ApiResponseLike, type FeedbackResponse } from '../src/contracts';
import { badRequest, duplicateEvent, draftNotFound, isApiError, sendError, sendJson } from '../src/errors';
import { logError, logInfo, logWarn } from '../src/logging';
import { findDraftEventByIdAndRequestId, insertFeedbackEvent, ensureDevice, withTransaction } from '../src/neon';
import { recordTopicAngleFeedback } from '../src/repetition';
import { parseApiRequestBody, parseFeedbackRequest } from '../src/validation';

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

export default async function handler(req: ApiRequestLike, res: ApiResponseLike): Promise<void> {
    const startedAt = Date.now();
    const method = (req.method ?? 'POST').toUpperCase();

    if (method !== 'POST') {
        rejectMethodNotAllowed(res);
        return;
    }

    try {
        const request = parseFeedbackRequest(parseApiRequestBody(req));
        const draftEvent = await findDraftEventByIdAndRequestId(request.deviceId, request.draftId, request.requestId);
        if (!draftEvent) {
            throw draftNotFound();
        }
        if (
            draftEvent.trigger_type !== request.triggerType ||
            draftEvent.topic_tag !== request.topicTag ||
            draftEvent.angle !== request.angle
        ) {
            throw badRequest('Feedback metadata does not match the draft event.');
        }

        const feedbackId = randomUUID();
        await withTransaction(async (client) => {
            await ensureDevice(client, request.deviceId, request.clientVersion);

            const inserted = await insertFeedbackEvent(client, {
                feedbackId,
                requestId: request.requestId,
                deviceId: request.deviceId,
                draftEventId: draftEvent.id,
                feedbackType: request.feedbackType,
                triggerType: draftEvent.trigger_type,
                topicTag: draftEvent.topic_tag,
                angle: draftEvent.angle,
                dismissReason: request.dismissReason,
                errorCode: request.errorCode,
                clientVersion: request.clientVersion,
                timestampUtc: request.timestampUtc,
            });

            if (!inserted) {
                throw duplicateEvent();
            }

            await recordTopicAngleFeedback(client, {
                deviceId: request.deviceId,
                topicTag: draftEvent.topic_tag,
                angle: draftEvent.angle,
                feedbackType: request.feedbackType,
            });
        });

        const response: FeedbackResponse = {
            ok: true,
            requestId: request.requestId,
            draftId: request.draftId,
            feedbackType: request.feedbackType,
            topicTag: draftEvent.topic_tag,
            angle: draftEvent.angle,
        };

        logInfo('Feedback recorded', {
            route: '/api/feedback',
            requestId: request.requestId,
            deviceId: request.deviceId,
            feedbackType: request.feedbackType,
            triggerType: request.triggerType,
            durationMs: Date.now() - startedAt,
        });

        sendJson(res, 200, response);
    } catch (error) {
        if (isApiError(error)) {
            const meta = {
                route: '/api/feedback',
                errorCode: error.code,
                status: error.statusCode,
                durationMs: Date.now() - startedAt,
            };
            if (error.statusCode >= 500) {
                logError('Feedback request failed', meta);
            } else {
                logWarn('Feedback request failed', meta);
            }
        } else {
            logError('Feedback request crashed', {
                route: '/api/feedback',
                durationMs: Date.now() - startedAt,
            });
        }

        sendError(res, error);
    }
}
