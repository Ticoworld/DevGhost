import type { ApiErrorCode } from './contracts';

export const TRANSPORT_ERROR_CODES = [
    'NETWORK_ERROR',
    'INVALID_RESPONSE',
    'MISSING_BASE_URL',
    'INVALID_BASE_URL',
    'REQUEST_ABORTED',
] as const;
export type TransportErrorCode = (typeof TRANSPORT_ERROR_CODES)[number];
export type CloudErrorCode = ApiErrorCode | TransportErrorCode;

const USER_MESSAGES: Record<CloudErrorCode, string> = {
    BAD_REQUEST: 'Cloud draft request was invalid.',
    INVALID_DEVICE_ID: 'Cloud device ID is invalid.',
    CONTEXT_TOO_LARGE: 'Cloud draft context was too large.',
    SANITIZATION_REQUIRED: 'Cloud draft context contained unsafe content.',
    QUOTA_EXCEEDED: 'Cloud draft limit reached for the last 24 hours.',
    REPETITIVE_CONTEXT: 'This draft looks too similar to recent ones.',
    DRAFT_NOT_FOUND: 'That draft could not be found.',
    DUPLICATE_EVENT: 'That request was already handled.',
    PROVIDER_RATE_LIMITED: 'Cloud AI is busy. Try again in a moment.',
    UPSTREAM_TIMEOUT: 'Cloud AI timed out. Try again.',
    PROVIDER_ERROR: 'Cloud AI returned an error.',
    INTERNAL_ERROR: 'Cloud draft failed.',
    NETWORK_ERROR: 'Could not reach DevGhost Cloud.',
    INVALID_RESPONSE: 'DevGhost Cloud returned an unexpected response.',
    MISSING_BASE_URL: 'Cloud backend URL is missing.',
    INVALID_BASE_URL: 'Cloud backend URL is invalid.',
    REQUEST_ABORTED: 'Cloud request was cancelled.',
};

export class CloudClientError extends Error {
    readonly code: CloudErrorCode;
    readonly statusCode?: number;
    readonly details?: Record<string, unknown>;

    constructor(code: CloudErrorCode, message: string, statusCode?: number, details?: Record<string, unknown>) {
        super(message);
        this.name = 'CloudClientError';
        this.code = code;
        this.statusCode = statusCode;
        this.details = details;
    }
}

export function isCloudClientError(value: unknown): value is CloudClientError {
    return value instanceof CloudClientError;
}

export function getCloudErrorMessage(code: CloudErrorCode): string {
    return USER_MESSAGES[code] ?? 'Cloud draft failed.';
}

export function formatCloudErrorMessage(error: unknown): string {
    if (isCloudClientError(error)) {
        return getCloudErrorMessage(error.code);
    }

    if (typeof error === 'object' && error !== null) {
        const maybeCode = (error as { code?: unknown }).code;
        if (typeof maybeCode === 'string' && maybeCode in USER_MESSAGES) {
            return getCloudErrorMessage(maybeCode as CloudErrorCode);
        }
    }

    return 'Cloud draft failed.';
}
