import { Pool, neonConfig } from '@neondatabase/serverless';
import { internalError } from './errors';

neonConfig.fetchConnectionCache = true;

type QueryResult<T> = {
    rows: T[];
    rowCount: number;
};

export interface DbClient {
    query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
    release(): void;
}

let pool: Pool | null = null;

function getDatabaseUrl(): string {
    const value = process.env.DATABASE_URL?.trim();
    if (!value) {
        throw internalError('DATABASE_URL is not configured.');
    }
    return value;
}

export function getPool(): Pool {
    if (!pool) {
        pool = new Pool({
            connectionString: getDatabaseUrl(),
        });
    }
    return pool;
}

export async function query<T = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    const result = (await getPool().query(text, params as any)) as unknown as QueryResult<T>;
    return result.rows;
}

export async function withTransaction<T>(callback: (client: DbClient) => Promise<T>): Promise<T> {
    const client = (await getPool().connect()) as DbClient;
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch {
            // Ignore rollback errors.
        }
        throw error;
    } finally {
        client.release();
    }
}

export async function ensureDevice(client: DbClient, deviceId: string, clientVersion?: string): Promise<void> {
    await client.query(
        `
        insert into devices (
            id,
            created_at,
            last_seen_at,
            first_seen_client_version,
            last_seen_client_version
        )
        values ($1, now(), now(), $2, $2)
        on conflict (id) do update
        set
            last_seen_at = excluded.last_seen_at,
            last_seen_client_version = coalesce(excluded.last_seen_client_version, devices.last_seen_client_version)
        `,
        [deviceId, clientVersion ?? null]
    );
}

export async function touchDevice(deviceId: string, clientVersion?: string): Promise<void> {
    await withTransaction(async (client) => {
        await ensureDevice(client, deviceId, clientVersion);
    });
}

export interface DraftEventRow {
    id: string;
    device_id: string;
    request_id: string;
    trigger_type: string;
    topic_tag: string;
    angle: string;
    model_name: string;
    draft_length_chars: number;
    context_bytes: number;
    excerpt_count: number;
    excerpt_chars: number;
    client_version: string | null;
    created_at: string;
}

export interface FeedbackEventRow {
    id: string;
    device_id: string;
    request_id: string;
    draft_event_id: string;
    feedback_type: string;
    trigger_type: string;
    topic_tag: string;
    angle: string;
    dismiss_reason: string | null;
    error_code: string | null;
    client_version: string | null;
    created_at: string;
}

export interface TopicAngleMemoryRow {
    device_id: string;
    topic_tag: string;
    angle: string;
    success_count: number;
    copied_count: number;
    opened_x_count: number;
    dismissed_count: number;
    last_feedback_type: string | null;
    first_seen_at: string;
    last_seen_at: string;
}

export async function findDraftEventByRequestId(deviceId: string, requestId: string): Promise<DraftEventRow | null> {
    const rows = await query<DraftEventRow>(
        `
        select *
        from draft_events
        where device_id = $1 and request_id = $2
        limit 1
        `,
        [deviceId, requestId]
    );
    return rows[0] ?? null;
}

export async function findDraftEventById(deviceId: string, draftId: string): Promise<DraftEventRow | null> {
    const rows = await query<DraftEventRow>(
        `
        select *
        from draft_events
        where device_id = $1 and id = $2
        limit 1
        `,
        [deviceId, draftId]
    );
    return rows[0] ?? null;
}

export async function findDraftEventByIdAndRequestId(
    deviceId: string,
    draftId: string,
    requestId: string
): Promise<DraftEventRow | null> {
    const rows = await query<DraftEventRow>(
        `
        select *
        from draft_events
        where device_id = $1 and id = $2 and request_id = $3
        limit 1
        `,
        [deviceId, draftId, requestId]
    );
    return rows[0] ?? null;
}

export async function listRecentTopicAngleMemory(deviceId: string, limit = 12): Promise<TopicAngleMemoryRow[]> {
    return query<TopicAngleMemoryRow>(
        `
        select *
        from topic_angle_memory
        where device_id = $1
        order by last_seen_at desc, success_count desc, copied_count desc
        limit $2
        `,
        [deviceId, limit]
    );
}

export async function upsertTopicAngleMemory(
    client: DbClient,
    params: {
        deviceId: string;
        topicTag: string;
        angle: string;
        feedbackType?: 'copied' | 'opened_x' | 'dismissed';
    }
): Promise<void> {
    await client.query(
        `
        insert into topic_angle_memory (
            device_id,
            topic_tag,
            angle,
            success_count,
            copied_count,
            opened_x_count,
            dismissed_count,
            last_feedback_type,
            first_seen_at,
            last_seen_at
        )
        values (
            $1,
            $2,
            $3,
            case when $4::text is null then 1 else 0 end,
            case when $4::text = 'copied' then 1 else 0 end,
            case when $4::text = 'opened_x' then 1 else 0 end,
            case when $4::text = 'dismissed' then 1 else 0 end,
            $4::text,
            now(),
            now()
        )
        on conflict (device_id, topic_tag, angle) do update
        set
            success_count = topic_angle_memory.success_count + case when excluded.last_feedback_type is null then 1 else 0 end,
            copied_count = topic_angle_memory.copied_count + case when excluded.last_feedback_type = 'copied' then 1 else 0 end,
            opened_x_count = topic_angle_memory.opened_x_count + case when excluded.last_feedback_type = 'opened_x' then 1 else 0 end,
            dismissed_count = topic_angle_memory.dismissed_count + case when excluded.last_feedback_type = 'dismissed' then 1 else 0 end,
            last_feedback_type = coalesce(excluded.last_feedback_type, topic_angle_memory.last_feedback_type),
            last_seen_at = now()
        `,
        [params.deviceId, params.topicTag, params.angle, params.feedbackType ?? null]
    );
}

export async function insertDraftEvent(
    client: DbClient,
    params: {
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
): Promise<boolean> {
    const result = await client.query<{ id: string }>(
        `
        insert into draft_events (
            id,
            request_id,
            device_id,
            trigger_type,
            topic_tag,
            angle,
            model_name,
            draft_length_chars,
            context_bytes,
            excerpt_count,
            excerpt_chars,
            client_version,
            created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
        on conflict (device_id, request_id) do nothing
        returning id
        `,
        [
            params.draftId,
            params.requestId,
            params.deviceId,
            params.triggerType,
            params.topicTag,
            params.angle,
            params.modelName,
            params.draftLengthChars,
            params.contextBytes,
            params.excerptCount,
            params.excerptChars,
            params.clientVersion ?? null,
        ]
    );
    return result.rowCount > 0;
}

export async function insertFeedbackEvent(
    client: DbClient,
    params: {
        feedbackId: string;
        requestId: string;
        deviceId: string;
        draftEventId: string;
        feedbackType: string;
        triggerType: string;
        topicTag: string;
        angle: string;
        dismissReason?: string;
        errorCode?: string;
        clientVersion?: string;
        timestampUtc: string;
    }
): Promise<boolean> {
    const result = await client.query<{ id: string }>(
        `
        insert into feedback_events (
            id,
            request_id,
            device_id,
            draft_event_id,
            feedback_type,
            trigger_type,
            topic_tag,
            angle,
            dismiss_reason,
            error_code,
            client_version,
            created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        on conflict (device_id, request_id) do nothing
        returning id
        `,
        [
            params.feedbackId,
            params.requestId,
            params.deviceId,
            params.draftEventId,
            params.feedbackType,
            params.triggerType,
            params.topicTag,
            params.angle,
            params.dismissReason ?? null,
            params.errorCode ?? null,
            params.clientVersion ?? null,
            params.timestampUtc,
        ]
    );
    return result.rowCount > 0;
}
