import { createHash } from 'crypto';
import type { ApiErrorCode, TriggerType } from './contracts';

type LogLevel = 'info' | 'warn' | 'error';

export interface LogMeta {
    route?: string;
    requestId?: string;
    deviceId?: string;
    triggerType?: TriggerType;
    clientVersion?: string;
    quotaMode?: string;
    status?: number;
    errorCode?: ApiErrorCode;
    durationMs?: number;
    quotaRemaining?: number;
    quotaUsed?: number;
    contextBytes?: number;
    excerptCount?: number;
    excerptChars?: number;
    modelName?: string;
    finishReason?: string;
    visibleOutputTokens?: number;
    thoughtsTokenCount?: number;
    reason?: string;
    invalidReason?: string;
    retryAttempted?: boolean;
    field?: string;
    feedbackType?: string;
}

function fingerprint(value: string | undefined): string | undefined {
    if (!value) return undefined;
    return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

function scrub(meta: LogMeta | undefined): Record<string, unknown> | undefined {
    if (!meta) return undefined;

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(meta)) {
        if (value === undefined || value === null) continue;
        if (key === 'requestId' || key === 'deviceId') {
            result[key] = fingerprint(String(value));
            continue;
        }
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            result[key] = value;
        }
    }
    return Object.keys(result).length > 0 ? result : undefined;
}

function emit(level: LogLevel, message: string, meta?: LogMeta): void {
    const safeMeta = scrub(meta);
    const payload = safeMeta ? `${message} ${JSON.stringify(safeMeta)}` : message;
    console[level](`[DevGhost Cloud] ${payload}`);
}

export function logInfo(message: string, meta?: LogMeta): void {
    emit('info', message, meta);
}

export function logWarn(message: string, meta?: LogMeta): void {
    emit('warn', message, meta);
}

export function logError(message: string, meta?: LogMeta): void {
    emit('error', message, meta);
}
