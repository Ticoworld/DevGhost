import type { ApiErrorCode, ApiResponseLike } from './contracts';

export class ApiError extends Error {
    readonly code: ApiErrorCode;
    readonly statusCode: number;
    readonly details?: Record<string, unknown>;

    constructor(code: ApiErrorCode, statusCode: number, message: string, details?: Record<string, unknown>) {
        super(message);
        this.name = 'ApiError';
        this.code = code;
        this.statusCode = statusCode;
        this.details = details;
    }
}

export function isApiError(value: unknown): value is ApiError {
    return value instanceof ApiError;
}

export function badRequest(message = 'Request validation failed.', details?: Record<string, unknown>): ApiError {
    return new ApiError('BAD_REQUEST', 400, message, details);
}

export function invalidDeviceId(message = 'Device ID is invalid.', details?: Record<string, unknown>): ApiError {
    return new ApiError('INVALID_DEVICE_ID', 400, message, details);
}

export function contextTooLarge(message = 'Context payload is too large.', details?: Record<string, unknown>): ApiError {
    return new ApiError('CONTEXT_TOO_LARGE', 413, message, details);
}

export function sanitizationRequired(message = 'Request contains unsafe content.', details?: Record<string, unknown>): ApiError {
    return new ApiError('SANITIZATION_REQUIRED', 422, message, details);
}

export function quotaExceeded(message = 'Daily draft limit reached.', details?: Record<string, unknown>): ApiError {
    return new ApiError('QUOTA_EXCEEDED', 429, message, details);
}

export function repetitiveContext(message = 'Request is too similar to recent drafts.', details?: Record<string, unknown>): ApiError {
    return new ApiError('REPETITIVE_CONTEXT', 409, message, details);
}

export function draftNotFound(message = 'Draft was not found.', details?: Record<string, unknown>): ApiError {
    return new ApiError('DRAFT_NOT_FOUND', 404, message, details);
}

export function duplicateEvent(message = 'Request already processed.', details?: Record<string, unknown>): ApiError {
    return new ApiError('DUPLICATE_EVENT', 409, message, details);
}

export function providerRateLimited(message = 'Gemini rate limited the request.', details?: Record<string, unknown>): ApiError {
    return new ApiError('PROVIDER_RATE_LIMITED', 503, message, details);
}

export function upstreamTimeout(message = 'Gemini timed out.', details?: Record<string, unknown>): ApiError {
    return new ApiError('UPSTREAM_TIMEOUT', 504, message, details);
}

export function providerError(message = 'Gemini request failed.', details?: Record<string, unknown>): ApiError {
    return new ApiError('PROVIDER_ERROR', 502, message, details);
}

export function internalError(message = 'Internal server error.', details?: Record<string, unknown>): ApiError {
    return new ApiError('INTERNAL_ERROR', 500, message, details);
}

export function sendJson(res: ApiResponseLike, statusCode: number, body: unknown): void {
    res.status(statusCode);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json(body);
}

export function sendError(res: ApiResponseLike, error: unknown): void {
    if (isApiError(error)) {
        sendJson(res, error.statusCode, {
            ok: false,
            error: {
                code: error.code,
                message: error.message,
                details: error.details,
            },
        });
        return;
    }

    sendJson(res, 500, {
        ok: false,
        error: {
            code: 'INTERNAL_ERROR',
            message: 'Internal server error.',
        },
    });
}
