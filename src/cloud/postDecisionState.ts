import * as vscode from 'vscode';
import type { TriggerType } from './contracts';

const STORAGE_KEY = 'devghost.cloud.lastPostDecision';
const MAX_RECORD_AGE_MS = 24 * 60 * 60 * 1000;

export type PostDecisionQuotaMode = 'normal' | 'qa';

export type PostDecisionPostReadyChoice = 'review' | 'not_now' | 'pause';
export type PostDecisionReviewChoice = 'copy' | 'open_x' | 'dismiss';

export type PostDecisionBlocker =
    | 'none'
    | 'paused'
    | 'baseline_suppressed'
    | 'already_handled'
    | 'cooldown_active'
    | 'failure_backoff'
    | 'not_enough_context'
    | 'noise_only'
    | 'burst_unstable'
    | 'below_threshold'
    | 'quota_exhausted'
    | 'cloud_invalid_post_shape'
    | 'cloud_rate_limited'
    | 'cloud_timeout'
    | 'cloud_failed'
    | 'request_aborted'
    | 'snoozed'
    | 'retry_backoff'
    | 'max_tokens'
    | 'workspace_missing'
    | 'not_ready';

export type PostDecisionSkipReason =
    | PostDecisionBlocker
    | `invalid_post_shape_${string}`
    | 'repetition_hard_reject'
    | 'provider_timeout'
    | 'provider_rate_limited'
    | 'structured_response_invalid'
    | 'sanitization_required'
    | 'context_too_large'
    | 'duplicate_event'
    | 'manual_cancelled';

export type PostDecisionCloudStatus =
    | 'not_sent'
    | 'sent'
    | 'accepted'
    | 'quota_exhausted'
    | 'rejected'
    | 'failed';

export interface PostDecisionRecord {
    eventId: string;
    triggerType: TriggerType;
    automatic: boolean;
    commitDetected: boolean;
    commitHashShort: string | null;
    gateAllowed: boolean | null;
    gateScore: number | null;
    blocker: PostDecisionBlocker | null;
    quotaMode: PostDecisionQuotaMode;
    quotaRemaining: number | null;
    cooldownActive: boolean;
    qaMode: boolean;
    cooldownChecked: boolean;
    cooldownBlocked: boolean;
    cooldownBypassed: boolean;
    highSignalBypassUsed: boolean;
    qaBypassUsed: boolean;
    failureBackoffApplied: boolean;
    alreadyHandled: boolean;
    baselineSuppressed: boolean;
    focusPresent: boolean;
    projectSummaryPresent: boolean;
    changedFileCount: number;
    additions: number | null;
    deletions: number | null;
    diffExcerptCount: number | null;
    requestSent: boolean;
    cloudStatus: PostDecisionCloudStatus;
    postAccepted: boolean;
    postReadyPromptChoice: PostDecisionPostReadyChoice | null;
    draftReviewChoice: PostDecisionReviewChoice | null;
    skipReason: PostDecisionSkipReason | null;
    timestampUtc: string;
}

export type PostDecisionUpdate = Partial<PostDecisionRecord> & Pick<PostDecisionRecord, 'eventId' | 'triggerType' | 'automatic'>;

interface StoredPostDecision {
    record: PostDecisionRecord;
}

function createDefaultRecord(update: PostDecisionUpdate): PostDecisionRecord {
    return {
        commitDetected: false,
        commitHashShort: null,
        gateAllowed: null,
        gateScore: null,
        blocker: null,
        quotaMode: 'normal',
        quotaRemaining: null,
        cooldownActive: false,
        qaMode: false,
        cooldownChecked: false,
        cooldownBlocked: false,
        cooldownBypassed: false,
        highSignalBypassUsed: false,
        qaBypassUsed: false,
        failureBackoffApplied: false,
        alreadyHandled: false,
        baselineSuppressed: false,
        focusPresent: false,
        projectSummaryPresent: false,
        changedFileCount: 0,
        additions: null,
        deletions: null,
        diffExcerptCount: null,
        requestSent: false,
        cloudStatus: 'not_sent',
        postAccepted: false,
        postReadyPromptChoice: null,
        draftReviewChoice: null,
        skipReason: null,
        timestampUtc: new Date().toISOString(),
        ...update,
        eventId: update.eventId,
        triggerType: update.triggerType,
        automatic: update.automatic,
    };
}

function isFreshEnough(record: PostDecisionRecord): boolean {
    const ageMs = Date.now() - Date.parse(record.timestampUtc);
    return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= MAX_RECORD_AGE_MS;
}

export class PostDecisionState {
    constructor(private readonly storage: vscode.Memento) {}

    getLatest(): PostDecisionRecord | null {
        const stored = this.storage.get<StoredPostDecision | null>(STORAGE_KEY, null);
        if (!stored?.record) {
            return null;
        }

        if (!isFreshEnough(stored.record)) {
            return null;
        }

        return stored.record;
    }

    async upsert(update: PostDecisionUpdate): Promise<PostDecisionRecord> {
        const current = this.getLatest();
        const record = current && current.eventId === update.eventId
            ? {
                ...current,
                ...update,
                timestampUtc: current.timestampUtc,
            }
            : createDefaultRecord(update);

        await this.storage.update(STORAGE_KEY, { record });
        return record;
    }

    async clear(): Promise<void> {
        await this.storage.update(STORAGE_KEY, undefined as unknown as StoredPostDecision);
    }
}

function formatYesNo(value: boolean | null): string {
    if (value === null) {
        return 'n/a';
    }
    return value ? 'yes' : 'no';
}

function formatNumber(value: number | null): string {
    return value === null ? 'n/a' : String(value);
}

function formatChoice(value: string | null): string {
    return value ?? 'n/a';
}

export function buildPostDecisionSummary(record: PostDecisionRecord | null): string[] {
    if (!record) {
        return ['Last post decision: none recorded.'];
    }

    const outcome = record.postAccepted
        ? 'accepted'
        : record.requestSent
            ? 'sent'
            : 'skipped';

    return [
        `Last post decision: ${outcome}`,
        `Trigger: ${record.triggerType}`,
        `Reason: ${record.skipReason ?? record.blocker ?? 'none'}`,
        `Quota mode: ${record.quotaMode}`,
        `Quota remaining: ${formatNumber(record.quotaRemaining)}`,
        `Commit detected: ${formatYesNo(record.commitDetected)}`,
        `Commit hash: ${record.commitHashShort ?? 'n/a'}`,
        `Gate allowed: ${formatYesNo(record.gateAllowed)}`,
        `Gate score: ${formatNumber(record.gateScore)}`,
        `QA mode: ${formatYesNo(record.qaMode)}`,
        `QA bypass used: ${formatYesNo(record.qaBypassUsed)}`,
        `Cooldown checked: ${formatYesNo(record.cooldownChecked)}`,
        `Cooldown blocked: ${formatYesNo(record.cooldownBlocked)}`,
        `Cooldown bypassed: ${formatYesNo(record.cooldownBypassed)}`,
        `High-signal bypass: ${formatYesNo(record.highSignalBypassUsed)}`,
        `Failure backoff: ${formatYesNo(record.failureBackoffApplied)}`,
        `Already handled: ${formatYesNo(record.alreadyHandled)}`,
        `Baseline suppressed: ${formatYesNo(record.baselineSuppressed)}`,
        `Focus present: ${formatYesNo(record.focusPresent)}`,
        `Project summary present: ${formatYesNo(record.projectSummaryPresent)}`,
        `Changed file count: ${record.changedFileCount}`,
        `Additions: ${formatNumber(record.additions)}`,
        `Deletions: ${formatNumber(record.deletions)}`,
        `Diff excerpt count: ${formatNumber(record.diffExcerptCount)}`,
        `Cloud request sent: ${formatYesNo(record.requestSent)}`,
        `Cloud status: ${record.cloudStatus}`,
        `Post accepted: ${formatYesNo(record.postAccepted)}`,
        `Post-ready choice: ${formatChoice(record.postReadyPromptChoice)}`,
        `Review choice: ${formatChoice(record.draftReviewChoice)}`,
        `Timestamp: ${record.timestampUtc}`,
    ];
}
