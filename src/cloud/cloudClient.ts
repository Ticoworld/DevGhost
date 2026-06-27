import {
    API_ERROR_CODES,
    type DraftRequest,
    type DraftResponse,
    type FeedbackRequest,
    type FeedbackResponse,
    type QuotaQuery,
    type QuotaResponse,
} from './contracts';
import { CloudClientError, type CloudErrorCode } from './errors';

interface RequestHeaders {
    deviceId?: string;
    clientVersion?: string;
    requestId?: string;
    triggerType?: string;
}

interface BackendErrorEnvelope {
    ok?: false;
    error?: {
        code?: string;
        message?: string;
        details?: Record<string, unknown>;
    };
}

function isApiErrorCode(value: string | undefined): value is (typeof API_ERROR_CODES)[number] {
    return !!value && API_ERROR_CODES.includes(value as (typeof API_ERROR_CODES)[number]);
}

function mapStatusToErrorCode(status: number): CloudErrorCode {
    switch (status) {
        case 400:
            return 'BAD_REQUEST';
        case 404:
            return 'DRAFT_NOT_FOUND';
        case 409:
            return 'DUPLICATE_EVENT';
        case 413:
            return 'CONTEXT_TOO_LARGE';
        case 422:
            return 'SANITIZATION_REQUIRED';
        case 429:
            return 'QUOTA_EXCEEDED';
        case 500:
            return 'INTERNAL_ERROR';
        case 502:
            return 'PROVIDER_ERROR';
        case 503:
            return 'PROVIDER_RATE_LIMITED';
        case 504:
            return 'UPSTREAM_TIMEOUT';
        default:
            return 'INTERNAL_ERROR';
    }
}

function buildHeaders(headers?: RequestHeaders): Record<string, string> {
    const result: Record<string, string> = {
        Accept: 'application/json',
    };

    if (headers?.deviceId) {
        result['X-DevGhost-Device-Id'] = headers.deviceId;
    }
    if (headers?.clientVersion) {
        result['X-DevGhost-Client-Version'] = headers.clientVersion;
    }
    if (headers?.requestId) {
        result['X-DevGhost-Request-Id'] = headers.requestId;
    }
    if (headers?.triggerType) {
        result['X-DevGhost-Trigger-Type'] = headers.triggerType;
    }

    return result;
}

export class CloudClient {
    private readonly baseUrl: URL;
    private readonly timeoutMs: number;

    constructor(baseUrl: string, timeoutMs: number = 30_000) {
        const trimmed = baseUrl.trim();
        if (!trimmed) {
            throw new CloudClientError('MISSING_BASE_URL', 'Cloud backend URL is missing.');
        }

        try {
            this.baseUrl = new URL(trimmed);
        } catch {
            throw new CloudClientError('INVALID_BASE_URL', 'Cloud backend URL is invalid.');
        }
        this.timeoutMs = timeoutMs;
    }

    async getQuota(query: QuotaQuery): Promise<QuotaResponse> {
        const url = new URL('/api/quota', this.baseUrl);
        url.searchParams.set('deviceId', query.deviceId);
        if (query.clientVersion) {
            url.searchParams.set('clientVersion', query.clientVersion);
        }

        return this.requestJson<QuotaResponse>('GET', url, undefined, {
            deviceId: query.deviceId,
            clientVersion: query.clientVersion,
        });
    }

    async postDraft(request: DraftRequest): Promise<DraftResponse> {
        const url = new URL('/api/draft', this.baseUrl);
        return this.requestJson<DraftResponse>('POST', url, request, {
            deviceId: request.deviceId,
            clientVersion: request.clientVersion,
            requestId: request.requestId,
            triggerType: request.triggerType,
        });
    }

    async postFeedback(request: FeedbackRequest): Promise<FeedbackResponse> {
        const url = new URL('/api/feedback', this.baseUrl);
        return this.requestJson<FeedbackResponse>('POST', url, request, {
            deviceId: request.deviceId,
            clientVersion: request.clientVersion,
            requestId: request.requestId,
            triggerType: request.triggerType,
        });
    }

    private async requestJson<TResponse>(
        method: 'GET' | 'POST',
        url: URL,
        body: unknown,
        headers?: RequestHeaders
    ): Promise<TResponse> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const response = await fetch(url.toString(), {
                method,
                headers: {
                    ...buildHeaders(headers),
                    ...(method === 'POST' ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
                },
                body: method === 'POST' ? JSON.stringify(body) : undefined,
                signal: controller.signal,
            });

            const raw = await response.text();
            const parsed = raw.trim().length > 0 ? this.tryParseJson(raw) : null;

            if (!response.ok) {
                throw this.buildApiError(response.status, parsed);
            }

            if (!parsed || typeof parsed !== 'object' || (parsed as { ok?: unknown }).ok !== true) {
                throw new CloudClientError('INVALID_RESPONSE', 'DevGhost Cloud returned an unexpected response.', response.status);
            }

            return parsed as TResponse;
        } catch (error) {
            if (error instanceof CloudClientError) {
                throw error;
            }

            if (this.isAbortError(error)) {
                throw new CloudClientError('REQUEST_ABORTED', 'Cloud request was cancelled.');
            }

            throw new CloudClientError('NETWORK_ERROR', 'Could not reach DevGhost Cloud.');
        } finally {
            clearTimeout(timeout);
        }
    }

    private buildApiError(status: number, parsed: unknown): CloudClientError {
        const envelope = parsed as BackendErrorEnvelope | null;
        const code = envelope?.error?.code;
        const details = envelope?.error?.details;
        const normalizedCode = isApiErrorCode(code) ? code : mapStatusToErrorCode(status);
        const message = envelope?.error?.message || 'Cloud draft failed.';
        return new CloudClientError(normalizedCode, message, status, details);
    }

    private tryParseJson(raw: string): unknown {
        try {
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    private isAbortError(error: unknown): boolean {
        if (!error || typeof error !== 'object') {
            return false;
        }

        const name = (error as { name?: unknown }).name;
        return name === 'AbortError';
    }
}
