import { randomUUID } from 'crypto';
import {
    FREE_DRAFT_LIMIT,
    ROLLING_QUOTA_WINDOW_MS,
    type QuotaSnapshot,
} from './contracts';
import { duplicateEvent, quotaExceeded } from './errors';
import {
    ensureDevice,
    type DbClient,
    insertDraftEvent,
    query,
    touchDevice,
    upsertTopicAngleMemory,
    withTransaction,
} from './neon';

type DraftQuotaRow = {
    used: number;
    oldest_created_at: string | null;
};

function isTruthyEnv(value: string | undefined): boolean {
    return !!value && /^(1|true|yes|on)$/i.test(value.trim());
}

function getDraftLimit(): number {
    if (isTruthyEnv(process.env.DEVGHOST_QA_NO_QUOTA)) {
        return 999;
    }

    const configuredLimit = process.env.DEVGHOST_FREE_DAILY_LIMIT?.trim();
    if (configuredLimit) {
        const parsed = Number(configuredLimit);
        if (Number.isInteger(parsed) && parsed > 0) {
            return parsed;
        }
    }

    return FREE_DRAFT_LIMIT;
}

function buildQuotaSnapshot(used: number, oldestCreatedAt: string | null): QuotaSnapshot {
    const limit = getDraftLimit();
    const remaining = Math.max(limit - used, 0);
    const windowStartUtc = new Date(Date.now() - ROLLING_QUOTA_WINDOW_MS).toISOString();
    const resetAtUtc = oldestCreatedAt
        ? new Date(new Date(oldestCreatedAt).getTime() + ROLLING_QUOTA_WINDOW_MS).toISOString()
        : new Date(Date.now() + ROLLING_QUOTA_WINDOW_MS).toISOString();

    return {
        limit,
        used,
        remaining,
        windowStartUtc,
        resetAtUtc,
        canGenerate: remaining > 0,
    };
}

export async function getQuotaSnapshot(deviceId: string, clientVersion?: string): Promise<QuotaSnapshot> {
    await touchDevice(deviceId, clientVersion);

    const rows = await query<DraftQuotaRow>(
        `
        select
            count(*)::int as used,
            min(created_at)::text as oldest_created_at
        from draft_events
        where device_id = $1
          and created_at >= now() - ($2 * interval '1 millisecond')
        `,
        [deviceId, ROLLING_QUOTA_WINDOW_MS]
    );

    return buildQuotaSnapshot(rows[0]?.used ?? 0, rows[0]?.oldest_created_at ?? null);
}

export interface RecordSuccessfulDraftParams {
    draftId: string;
    requestId: string;
    deviceId: string;
    triggerType: string;
    topicTag: string;
    angle: string;
    modelName: string;
    draftLengthChars: number;
    contextBytes: number;
    excerptCount: number;
    excerptChars: number;
    clientVersion?: string;
}

export interface RecordedDraftResult {
    draftId: string;
    quota: QuotaSnapshot;
}

export async function recordSuccessfulDraft(params: RecordSuccessfulDraftParams): Promise<RecordedDraftResult> {
    return withTransaction<RecordedDraftResult>(async (client: DbClient) => {
        await ensureDevice(client, params.deviceId, params.clientVersion);
        await client.query('select pg_advisory_xact_lock(hashtext($1)::bigint)', [params.deviceId]);

        const duplicate = await client.query<{ id: string }>(
            `
            select id
            from draft_events
            where device_id = $1 and request_id = $2
            limit 1
            `,
            [params.deviceId, params.requestId]
        );
        if (duplicate.rows[0]) {
            throw duplicateEvent();
        }

        const snapshot = await getQuotaSnapshotForClient(client, params.deviceId);
        if (!snapshot.canGenerate) {
            throw quotaExceeded();
        }

        const draftId = params.draftId || randomUUID();
        const inserted = await insertDraftEvent(client, {
            ...params,
            draftId,
        });
        if (!inserted) {
            throw duplicateEvent();
        }

        await upsertTopicAngleMemory(client, {
            deviceId: params.deviceId,
            topicTag: params.topicTag,
            angle: params.angle,
        });

        const nextUsed = snapshot.used + 1;
        const nextRemaining = Math.max(getDraftLimit() - nextUsed, 0);
        return {
            draftId,
            quota: {
                ...snapshot,
                used: nextUsed,
                remaining: nextRemaining,
                canGenerate: nextRemaining > 0,
            },
        };
    });
}

export async function getQuotaSnapshotForClient(client: DbClient, deviceId: string): Promise<QuotaSnapshot> {
    const result = await client.query<DraftQuotaRow>(
        `
        select
            count(*)::int as used,
            min(created_at)::text as oldest_created_at
        from draft_events
        where device_id = $1
          and created_at >= now() - ($2 * interval '1 millisecond')
        `,
        [deviceId, ROLLING_QUOTA_WINDOW_MS]
    );

    return buildQuotaSnapshot(result.rows[0]?.used ?? 0, result.rows[0]?.oldest_created_at ?? null);
}
