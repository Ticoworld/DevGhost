import { type ApiRequestLike, type ApiResponseLike, type QuotaResponse } from '../src/contracts';
import { isApiError, sendError, sendJson } from '../src/errors';
import { logError, logInfo, logWarn } from '../src/logging';
import { getQuotaSnapshot } from '../src/quota';
import { parseQuotaQuery } from '../src/validation';

function rejectMethodNotAllowed(res: ApiResponseLike): void {
    res.status(405);
    res.setHeader('Allow', 'GET');
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
    const method = (req.method ?? 'GET').toUpperCase();

    if (method !== 'GET') {
        rejectMethodNotAllowed(res);
        return;
    }

    try {
        const query = parseQuotaQuery(req.query ?? {});
        const quota = await getQuotaSnapshot(query.deviceId, query.clientVersion);
        const response: QuotaResponse = {
            ok: true,
            deviceId: query.deviceId,
            quota,
        };

        logInfo('Quota snapshot served', {
            route: '/api/quota',
            deviceId: query.deviceId,
            quotaRemaining: quota.remaining,
            quotaUsed: quota.used,
            durationMs: Date.now() - startedAt,
        });

        sendJson(res, 200, response);
    } catch (error) {
        if (isApiError(error)) {
            const meta = {
                route: '/api/quota',
                errorCode: error.code,
                status: error.statusCode,
                durationMs: Date.now() - startedAt,
            };
            if (error.statusCode >= 500) {
                logError('Quota request failed', meta);
            } else {
                logWarn('Quota request failed', meta);
            }
        } else {
            logError('Quota request crashed', {
                route: '/api/quota',
                durationMs: Date.now() - startedAt,
            });
        }

        sendError(res, error);
    }
}
