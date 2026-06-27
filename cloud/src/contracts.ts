export const FREE_DRAFT_LIMIT = 3;
export const ROLLING_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const TRIGGER_TYPES = [
    'MANUAL_INTENT',
    'FRICTION_BREAKTHROUGH',
    'PROJECT_LAUNCH',
    'PROJECT_RESUME',
    'DEEP_WORK_WRAP_UP',
    'WARMUP_RETURN',
    'SILENCE_BREAKER',
    'COMMIT_DETECTED',
    'FOCUS_INTENT',
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const FEEDBACK_TYPES = ['copied', 'opened_x', 'dismissed'] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

export const DISMISS_REASONS = [
    'too_generic',
    'too_repetitive',
    'wrong_tone',
    'sensitive',
    'not_relevant',
    'other',
] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

export const API_ERROR_CODES = [
    'BAD_REQUEST',
    'INVALID_DEVICE_ID',
    'CONTEXT_TOO_LARGE',
    'SANITIZATION_REQUIRED',
    'QUOTA_EXCEEDED',
    'REPETITIVE_CONTEXT',
    'DRAFT_NOT_FOUND',
    'DUPLICATE_EVENT',
    'PROVIDER_RATE_LIMITED',
    'UPSTREAM_TIMEOUT',
    'PROVIDER_ERROR',
    'INTERNAL_ERROR',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const MAX_REQUEST_CONTEXT_BYTES = 20_000;
export const MAX_DRAFT_TEXT_CHARS = 280;
export const MAX_PROJECT_NAME_CHARS = 120;
export const MAX_PROJECT_SUMMARY_CHARS = 800;
export const MAX_CURRENT_FOCUS_CHARS = 160;
export const MAX_CLIENT_VERSION_CHARS = 48;
export const MAX_COMMIT_MESSAGES = 5;
export const MAX_COMMIT_MESSAGE_CHARS = 160;
export const MAX_COMMIT_EVIDENCE_REASONS = 8;
export const MAX_COMMIT_EVIDENCE_REASON_CHARS = 120;
export const MAX_COMMIT_WORK_TYPE_CHARS = 32;
export const MAX_CHANGED_PATHS = 20;
export const MAX_CHANGED_PATH_CHARS = 140;
export const MAX_ACTIVE_SYMBOLS = 12;
export const MAX_ACTIVE_SYMBOL_CHARS = 80;
export const MAX_FAILED_COMMANDS = 8;
export const MAX_COMMAND_NAME_CHARS = 80;
export const MAX_FRICTION_SUMMARY_CHARS = 280;
export const MAX_SELECTED_DIFF_EXCERPTS = 4;
export const MAX_DIFF_EXCERPT_PATH_CHARS = 160;
export const MAX_DIFF_EXCERPT_LABEL_CHARS = 80;
export const MAX_DIFF_EXCERPT_CHARS = 2_000;
export const MAX_TOTAL_DIFF_EXCERPT_CHARS = 6_000;
export const MAX_RECENT_TOPIC_TAGS = 6;
export const MAX_TOPIC_TAG_CHARS = 32;
export const MAX_RECENT_ANGLES = 5;
export const MAX_ANGLE_CHARS = 40;
export const MAX_PHRASES_TO_AVOID = 10;
export const MAX_PHRASE_CHARS = 64;
export const MAX_SESSION_DURATION_MINUTES = 10_080;

export interface FileTypeSummary {
    totalChangedFiles: number;
    sourceFiles: number;
    configFiles: number;
    docsFiles: number;
    styleFiles: number;
    generatedFiles: number;
    noiseFiles: number;
    featurePathMatches: number;
}

export interface DiffExcerpt {
    path: string;
    excerpt: string;
    label?: string;
}

export interface CommitEvidence {
    commitMessage?: string;
    changedRelativePaths?: string[];
    additions?: number;
    deletions?: number;
    workType?: string;
    changedFileCount?: number;
    signalReasons?: string[];
    gateReasons?: string[];
    diffExcerptCount?: number;
    diffExcerptChars?: number;
    selectedDiffExcerpts?: DiffExcerpt[];
}

export interface DraftRequest {
    deviceId: string;
    requestId: string;
    clientVersion: string;
    triggerType: TriggerType;
    projectName?: string;
    projectSummary: string;
    currentFocus?: string;
    sessionDurationMinutes?: number;
    commitMessages?: string[];
    changedRelativePaths?: string[];
    fileTypeSummary?: FileTypeSummary;
    activeSymbols?: string[];
    failedCommandNames?: string[];
    successfulCommandNames?: string[];
    frictionSummary?: string;
    selectedDiffExcerpts?: DiffExcerpt[];
    recentTopicTags?: string[];
    recentAngles?: string[];
    phrasesToAvoid?: string[];
    commitEvidence?: CommitEvidence;
}

export interface QuotaQuery {
    deviceId: string;
    clientVersion?: string;
}

export interface QuotaSnapshot {
    limit: number;
    used: number;
    remaining: number;
    windowStartUtc: string;
    resetAtUtc: string;
    canGenerate: boolean;
}

export interface QuotaResponse {
    ok: true;
    deviceId: string;
    quota: QuotaSnapshot;
}

export interface DraftResponse {
    ok: true;
    requestId: string;
    draftId: string;
    draftText: string;
    topicTag: string;
    angle: string;
    quota: QuotaSnapshot;
}

export interface FeedbackRequest {
    deviceId: string;
    requestId: string;
    draftId: string;
    clientVersion?: string;
    triggerType: TriggerType;
    feedbackType: FeedbackType;
    topicTag: string;
    angle: string;
    timestampUtc: string;
    dismissReason?: DismissReason;
    errorCode?: ApiErrorCode;
}

export interface FeedbackResponse {
    ok: true;
    requestId: string;
    draftId: string;
    feedbackType: FeedbackType;
    topicTag: string;
    angle: string;
}

export interface ApiRequestLike {
    method?: string;
    body?: unknown;
    query?: Record<string, unknown>;
}

export interface ApiResponseLike {
    status(code: number): ApiResponseLike;
    setHeader(name: string, value: string): void;
    json(body: unknown): void;
    send(body: unknown): void;
}
