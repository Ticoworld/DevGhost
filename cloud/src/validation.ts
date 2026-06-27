import * as path from 'path';
import {
    API_ERROR_CODES,
    MAX_ACTIVE_SYMBOLS,
    MAX_ACTIVE_SYMBOL_CHARS,
    MAX_CHANGED_PATHS,
    MAX_CHANGED_PATH_CHARS,
    MAX_CLIENT_VERSION_CHARS,
    MAX_COMMAND_NAME_CHARS,
    MAX_COMMIT_MESSAGE_CHARS,
    MAX_COMMIT_MESSAGES,
    MAX_COMMIT_EVIDENCE_REASON_CHARS,
    MAX_COMMIT_EVIDENCE_REASONS,
    MAX_COMMIT_WORK_TYPE_CHARS,
    MAX_CURRENT_FOCUS_CHARS,
    MAX_DIFF_EXCERPT_CHARS,
    MAX_DIFF_EXCERPT_LABEL_CHARS,
    MAX_DIFF_EXCERPT_PATH_CHARS,
    MAX_FRICTION_SUMMARY_CHARS,
    MAX_PHRASE_CHARS,
    MAX_PHRASES_TO_AVOID,
    MAX_PROJECT_NAME_CHARS,
    MAX_PROJECT_SUMMARY_CHARS,
    MAX_RECENT_ANGLES,
    MAX_RECENT_TOPIC_TAGS,
    MAX_FAILED_COMMANDS,
    MAX_REQUEST_CONTEXT_BYTES,
    MAX_SELECTED_DIFF_EXCERPTS,
    MAX_SESSION_DURATION_MINUTES,
    MAX_TOTAL_DIFF_EXCERPT_CHARS,
    MAX_TOPIC_TAG_CHARS,
    UUID_PATTERN,
    type CommitEvidence,
    type ApiRequestLike,
    type DiffExcerpt,
    type DraftRequest,
    type FeedbackRequest,
    type FileTypeSummary,
    type QuotaQuery,
    DISMISS_REASONS,
    FEEDBACK_TYPES,
    MAX_ANGLE_CHARS,
    TRIGGER_TYPES,
} from './contracts';
import { badRequest, contextTooLarge, invalidDeviceId, sanitizationRequired } from './errors';
import { findUnsafeFindings } from './redaction';

function parseJsonBody(body: unknown): unknown {
    if (typeof body === 'string') {
        try {
            return JSON.parse(body);
        } catch {
            throw badRequest('Request body must be valid JSON.');
        }
    }
    return body;
}

function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw badRequest(`${label} must be a JSON object.`);
    }
    return value as Record<string, unknown>;
}

function assertExactKeys(value: unknown, allowedKeys: readonly string[], label: string): Record<string, unknown> {
    const obj = assertPlainObject(value, label);
    for (const key of Object.keys(obj)) {
        if (!allowedKeys.includes(key)) {
            throw badRequest(`${label} contains unknown field "${key}".`);
        }
    }
    return obj;
}

function parseTrimmedString(value: unknown, label: string, maxChars: number, options?: { required?: boolean }): string | undefined {
    if (value === undefined || value === null) {
        if (options?.required) {
            throw badRequest(`${label} is required.`);
        }
        return undefined;
    }

    if (typeof value !== 'string') {
        throw badRequest(`${label} must be a string.`);
    }

    const trimmed = value.trim();
    if (options?.required && trimmed.length === 0) {
        throw badRequest(`${label} is required.`);
    }
    if (trimmed.length > maxChars) {
        throw badRequest(`${label} is too long.`);
    }
    return trimmed;
}

function parseInteger(value: unknown, label: string, min: number, max: number, options?: { required?: boolean }): number | undefined {
    if (value === undefined || value === null) {
        if (options?.required) {
            throw badRequest(`${label} is required.`);
        }
        return undefined;
    }

    if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw badRequest(`${label} must be an integer.`);
    }
    if (value < min || value > max) {
        throw badRequest(`${label} is out of range.`);
    }
    return value;
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
    const parsed = parseTrimmedString(value, label, 64, { required: true });
    if (!parsed || !allowed.includes(parsed as T)) {
        throw badRequest(`${label} is not supported.`);
    }
    return parsed as T;
}

function parseStringArray(value: unknown, label: string, maxItems: number, maxChars: number): string[] | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!Array.isArray(value)) {
        throw badRequest(`${label} must be an array.`);
    }
    if (value.length > maxItems) {
        throw badRequest(`${label} is too long.`);
    }
    return value.map((entry, index) => {
        const item = parseTrimmedString(entry, `${label}[${index}]`, maxChars, { required: true });
        return item as string;
    });
}

function parseRelativePathArray(value: unknown, label: string, maxItems: number, maxChars: number): string[] | undefined {
    const entries = parseStringArray(value, label, maxItems, maxChars);
    if (!entries) {
        return undefined;
    }

    return entries.map((entry, index) => parseRelativePath(entry, `${label}[${index}]`, maxChars));
}

function parseDiffExcerpts(value: unknown): DiffExcerpt[] | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!Array.isArray(value)) {
        throw badRequest('selectedDiffExcerpts must be an array.');
    }
    if (value.length > MAX_SELECTED_DIFF_EXCERPTS) {
        throw badRequest('selectedDiffExcerpts is too long.');
    }

    const excerpts = value.map((entry, index) => {
        const obj = assertExactKeys(entry, ['path', 'excerpt', 'label'], `selectedDiffExcerpts[${index}]`);
        const excerptPath = parseRelativePath(obj.path, `selectedDiffExcerpts[${index}].path`, MAX_DIFF_EXCERPT_PATH_CHARS);
        const excerpt = parseTrimmedString(obj.excerpt, `selectedDiffExcerpts[${index}].excerpt`, MAX_DIFF_EXCERPT_CHARS, { required: true });
        const label = parseTrimmedString(obj.label, `selectedDiffExcerpts[${index}].label`, MAX_DIFF_EXCERPT_LABEL_CHARS);
        return {
            path: excerptPath as string,
            excerpt: excerpt as string,
            label,
        };
    });
    const totalChars = excerpts.reduce(
        (sum, entry) => sum + entry.path.length + entry.excerpt.length + (entry.label?.length ?? 0),
        0
    );
    if (totalChars > MAX_TOTAL_DIFF_EXCERPT_CHARS) {
        throw contextTooLarge('selectedDiffExcerpts is too large.');
    }
    return excerpts;
}

function parseCommitEvidence(value: unknown): CommitEvidence | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    const obj = assertExactKeys(
        value,
        [
            'commitMessage',
            'changedRelativePaths',
            'additions',
            'deletions',
            'workType',
            'changedFileCount',
            'signalReasons',
            'gateReasons',
            'diffExcerptCount',
            'diffExcerptChars',
            'selectedDiffExcerpts',
        ],
        'commitEvidence'
    );

    const commitMessage = parseTrimmedString(obj.commitMessage, 'commitEvidence.commitMessage', MAX_COMMIT_MESSAGE_CHARS);
    const changedRelativePaths = parseRelativePathArray(obj.changedRelativePaths, 'commitEvidence.changedRelativePaths', MAX_CHANGED_PATHS, MAX_CHANGED_PATH_CHARS);
    const additions = parseInteger(obj.additions, 'commitEvidence.additions', 0, 1_000_000);
    const deletions = parseInteger(obj.deletions, 'commitEvidence.deletions', 0, 1_000_000);
    const workType = parseTrimmedString(obj.workType, 'commitEvidence.workType', MAX_COMMIT_WORK_TYPE_CHARS);
    const changedFileCount = parseInteger(obj.changedFileCount, 'commitEvidence.changedFileCount', 0, 1_000_000);
    const signalReasons = parseStringArray(obj.signalReasons, 'commitEvidence.signalReasons', MAX_COMMIT_EVIDENCE_REASONS, MAX_COMMIT_EVIDENCE_REASON_CHARS);
    const gateReasons = parseStringArray(obj.gateReasons, 'commitEvidence.gateReasons', MAX_COMMIT_EVIDENCE_REASONS, MAX_COMMIT_EVIDENCE_REASON_CHARS);
    const diffExcerptCount = parseInteger(obj.diffExcerptCount, 'commitEvidence.diffExcerptCount', 0, MAX_SELECTED_DIFF_EXCERPTS);
    const diffExcerptChars = parseInteger(obj.diffExcerptChars, 'commitEvidence.diffExcerptChars', 0, MAX_TOTAL_DIFF_EXCERPT_CHARS);
    const selectedDiffExcerpts = parseDiffExcerpts(obj.selectedDiffExcerpts);

    if (commitMessage) {
        ensureSafeStrings('commitEvidence.commitMessage', commitMessage);
    }
    if (changedRelativePaths) {
        for (const [index, value] of changedRelativePaths.entries()) {
            ensureSafeStrings(`commitEvidence.changedRelativePaths[${index}]`, value);
        }
    }
    if (workType) {
        ensureSafeStrings('commitEvidence.workType', workType);
    }
    for (const [index, value] of (signalReasons ?? []).entries()) {
        ensureSafeStrings(`commitEvidence.signalReasons[${index}]`, value);
    }
    for (const [index, value] of (gateReasons ?? []).entries()) {
        ensureSafeStrings(`commitEvidence.gateReasons[${index}]`, value);
    }

    if (
        commitMessage === undefined &&
        changedRelativePaths === undefined &&
        additions === undefined &&
        deletions === undefined &&
        workType === undefined &&
        changedFileCount === undefined &&
        signalReasons === undefined &&
        gateReasons === undefined &&
        diffExcerptCount === undefined &&
        diffExcerptChars === undefined &&
        selectedDiffExcerpts === undefined
    ) {
        return undefined;
    }

    return {
        commitMessage,
        changedRelativePaths,
        additions,
        deletions,
        workType,
        changedFileCount,
        signalReasons,
        gateReasons,
        diffExcerptCount,
        diffExcerptChars,
        selectedDiffExcerpts,
    };
}

function parseRelativePath(value: unknown, label: string, maxChars: number): string {
    const parsed = parseTrimmedString(value, label, maxChars, { required: true });
    if (!parsed) {
        throw badRequest(`${label} is required.`);
    }

    const normalized = parsed.replace(/\\/g, '/');
    if (path.posix.isAbsolute(normalized)) {
        throw sanitizationRequired(`${label} must be relative.`);
    }
    if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith('~')) {
        throw sanitizationRequired(`${label} must be relative.`);
    }
    const segments = normalized.split('/');
    if (segments.some((segment) => segment === '..' || segment === '.')) {
        throw sanitizationRequired(`${label} must not traverse directories.`);
    }

    return normalized;
}

function ensureSafeStrings(fieldPath: string, value: string): void {
    const findings = findUnsafeFindings(value, fieldPath);
    if (findings.length > 0) {
        throw sanitizationRequired('Request contains unsafe content.', {
            field: fieldPath,
            reason: findings[0]?.reason,
        });
    }
}

function parseFileTypeSummary(value: unknown): FileTypeSummary | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    const obj = assertExactKeys(
        value,
        ['totalChangedFiles', 'sourceFiles', 'configFiles', 'docsFiles', 'styleFiles', 'generatedFiles', 'noiseFiles', 'featurePathMatches'],
        'fileTypeSummary'
    );

    const totalChangedFiles = parseInteger(obj.totalChangedFiles, 'fileTypeSummary.totalChangedFiles', 0, 10_000, { required: true });
    const sourceFiles = parseInteger(obj.sourceFiles, 'fileTypeSummary.sourceFiles', 0, 10_000, { required: true });
    const configFiles = parseInteger(obj.configFiles, 'fileTypeSummary.configFiles', 0, 10_000, { required: true });
    const docsFiles = parseInteger(obj.docsFiles, 'fileTypeSummary.docsFiles', 0, 10_000, { required: true });
    const styleFiles = parseInteger(obj.styleFiles, 'fileTypeSummary.styleFiles', 0, 10_000, { required: true });
    const generatedFiles = parseInteger(obj.generatedFiles, 'fileTypeSummary.generatedFiles', 0, 10_000, { required: true });
    const noiseFiles = parseInteger(obj.noiseFiles, 'fileTypeSummary.noiseFiles', 0, 10_000, { required: true });
    const featurePathMatches = parseInteger(obj.featurePathMatches, 'fileTypeSummary.featurePathMatches', 0, 10_000, { required: true });

    return {
        totalChangedFiles: totalChangedFiles as number,
        sourceFiles: sourceFiles as number,
        configFiles: configFiles as number,
        docsFiles: docsFiles as number,
        styleFiles: styleFiles as number,
        generatedFiles: generatedFiles as number,
        noiseFiles: noiseFiles as number,
        featurePathMatches: featurePathMatches as number,
    };
}

function isSupportedErrorCode(value: string): boolean {
    return API_ERROR_CODES.includes(value as (typeof API_ERROR_CODES)[number]);
}

function inspectDraftRequestForUnsafeContent(request: DraftRequest): void {
    const strings: Array<[string, string | undefined]> = [
        ['projectName', request.projectName],
        ['projectSummary', request.projectSummary],
        ['currentFocus', request.currentFocus],
        ['frictionSummary', request.frictionSummary],
        ['clientVersion', request.clientVersion],
        ['triggerType', request.triggerType],
    ];

    for (const [field, value] of strings) {
        if (value) {
            ensureSafeStrings(field, value);
        }
    }

    for (const [index, message] of (request.commitMessages ?? []).entries()) {
        ensureSafeStrings(`commitMessages[${index}]`, message);
    }
    for (const [index, value] of (request.changedRelativePaths ?? []).entries()) {
        ensureSafeStrings(`changedRelativePaths[${index}]`, value);
    }
    for (const [index, value] of (request.activeSymbols ?? []).entries()) {
        ensureSafeStrings(`activeSymbols[${index}]`, value);
    }
    for (const [index, value] of (request.failedCommandNames ?? []).entries()) {
        ensureSafeStrings(`failedCommandNames[${index}]`, value);
    }
    for (const [index, value] of (request.successfulCommandNames ?? []).entries()) {
        ensureSafeStrings(`successfulCommandNames[${index}]`, value);
    }
    for (const [index, value] of (request.recentTopicTags ?? []).entries()) {
        ensureSafeStrings(`recentTopicTags[${index}]`, value);
    }
    for (const [index, value] of (request.recentAngles ?? []).entries()) {
        ensureSafeStrings(`recentAngles[${index}]`, value);
    }
    for (const [index, value] of (request.phrasesToAvoid ?? []).entries()) {
        ensureSafeStrings(`phrasesToAvoid[${index}]`, value);
    }
    for (const [index, excerpt] of (request.selectedDiffExcerpts ?? []).entries()) {
        ensureSafeStrings(`selectedDiffExcerpts[${index}].path`, excerpt.path);
        ensureSafeStrings(`selectedDiffExcerpts[${index}].excerpt`, excerpt.excerpt);
        if (excerpt.label) {
            ensureSafeStrings(`selectedDiffExcerpts[${index}].label`, excerpt.label);
        }
    }
    if (request.commitEvidence?.commitMessage) {
        ensureSafeStrings('commitEvidence.commitMessage', request.commitEvidence.commitMessage);
    }
    for (const [index, value] of (request.commitEvidence?.changedRelativePaths ?? []).entries()) {
        ensureSafeStrings(`commitEvidence.changedRelativePaths[${index}]`, value);
    }
    if (request.commitEvidence?.workType) {
        ensureSafeStrings('commitEvidence.workType', request.commitEvidence.workType);
    }
    for (const [index, value] of (request.commitEvidence?.signalReasons ?? []).entries()) {
        ensureSafeStrings(`commitEvidence.signalReasons[${index}]`, value);
    }
    for (const [index, value] of (request.commitEvidence?.gateReasons ?? []).entries()) {
        ensureSafeStrings(`commitEvidence.gateReasons[${index}]`, value);
    }
    for (const [index, excerpt] of (request.commitEvidence?.selectedDiffExcerpts ?? []).entries()) {
        ensureSafeStrings(`commitEvidence.selectedDiffExcerpts[${index}].path`, excerpt.path);
        ensureSafeStrings(`commitEvidence.selectedDiffExcerpts[${index}].excerpt`, excerpt.excerpt);
        if (excerpt.label) {
            ensureSafeStrings(`commitEvidence.selectedDiffExcerpts[${index}].label`, excerpt.label);
        }
    }
}

function estimateRequestSize(request: DraftRequest): number {
    return Buffer.byteLength(JSON.stringify(request), 'utf8');
}

export function normalizeRequestBody(body: unknown): unknown {
    return parseJsonBody(body);
}

export function parseQuotaQuery(input: unknown): QuotaQuery {
    const source = assertExactKeys(input, ['deviceId', 'clientVersion'], 'quota query');
    const deviceId = parseTrimmedString(source.deviceId, 'deviceId', 64, { required: true });
    if (!deviceId || !UUID_PATTERN.test(deviceId)) {
        throw invalidDeviceId();
    }
    const clientVersion = parseTrimmedString(source.clientVersion, 'clientVersion', MAX_CLIENT_VERSION_CHARS);
    return {
        deviceId,
        clientVersion,
    };
}

export function parseDraftRequest(input: unknown): DraftRequest {
    const source = assertExactKeys(
        input,
        [
            'deviceId',
            'requestId',
            'clientVersion',
            'triggerType',
            'projectName',
            'projectSummary',
            'currentFocus',
            'sessionDurationMinutes',
            'commitMessages',
            'changedRelativePaths',
            'fileTypeSummary',
            'activeSymbols',
            'failedCommandNames',
            'successfulCommandNames',
            'frictionSummary',
            'selectedDiffExcerpts',
            'recentTopicTags',
            'recentAngles',
            'phrasesToAvoid',
            'commitEvidence',
        ],
        'draft request'
    );

    const deviceId = parseTrimmedString(source.deviceId, 'deviceId', 64, { required: true });
    const requestId = parseTrimmedString(source.requestId, 'requestId', 64, { required: true });
    const clientVersion = parseTrimmedString(source.clientVersion, 'clientVersion', MAX_CLIENT_VERSION_CHARS, { required: true });
    const triggerType = parseEnum(source.triggerType, TRIGGER_TYPES, 'triggerType');
    const projectName = parseTrimmedString(source.projectName, 'projectName', MAX_PROJECT_NAME_CHARS);
    const projectSummary = parseTrimmedString(source.projectSummary, 'projectSummary', MAX_PROJECT_SUMMARY_CHARS, { required: true });
    const currentFocus = parseTrimmedString(source.currentFocus, 'currentFocus', MAX_CURRENT_FOCUS_CHARS);
    const sessionDurationMinutes = parseInteger(source.sessionDurationMinutes, 'sessionDurationMinutes', 0, MAX_SESSION_DURATION_MINUTES);
    const commitMessages = parseStringArray(source.commitMessages, 'commitMessages', MAX_COMMIT_MESSAGES, MAX_COMMIT_MESSAGE_CHARS);
    const changedRelativePaths = parseStringArray(source.changedRelativePaths, 'changedRelativePaths', MAX_CHANGED_PATHS, MAX_CHANGED_PATH_CHARS);
    const fileTypeSummary = parseFileTypeSummary(source.fileTypeSummary);
    const activeSymbols = parseStringArray(source.activeSymbols, 'activeSymbols', MAX_ACTIVE_SYMBOLS, MAX_ACTIVE_SYMBOL_CHARS);
    const failedCommandNames = parseStringArray(source.failedCommandNames, 'failedCommandNames', MAX_FAILED_COMMANDS, MAX_COMMAND_NAME_CHARS);
    const successfulCommandNames = parseStringArray(source.successfulCommandNames, 'successfulCommandNames', MAX_FAILED_COMMANDS, MAX_COMMAND_NAME_CHARS);
    const frictionSummary = parseTrimmedString(source.frictionSummary, 'frictionSummary', MAX_FRICTION_SUMMARY_CHARS);
    const selectedDiffExcerpts = parseDiffExcerpts(source.selectedDiffExcerpts);
    const recentTopicTags = parseStringArray(source.recentTopicTags, 'recentTopicTags', MAX_RECENT_TOPIC_TAGS, MAX_TOPIC_TAG_CHARS);
    const recentAngles = parseStringArray(source.recentAngles, 'recentAngles', MAX_RECENT_ANGLES, MAX_ANGLE_CHARS);
    const phrasesToAvoid = parseStringArray(source.phrasesToAvoid, 'phrasesToAvoid', MAX_PHRASES_TO_AVOID, MAX_PHRASE_CHARS);
    const commitEvidence = parseCommitEvidence(source.commitEvidence);

    if (!deviceId || !UUID_PATTERN.test(deviceId)) {
        throw invalidDeviceId();
    }
    if (!requestId || !UUID_PATTERN.test(requestId)) {
        throw badRequest('requestId is invalid.');
    }

    const request: DraftRequest = {
        deviceId,
        requestId,
        clientVersion: clientVersion as string,
        triggerType,
        projectName,
        projectSummary: projectSummary as string,
        currentFocus,
        sessionDurationMinutes,
        commitMessages,
        changedRelativePaths,
        fileTypeSummary,
        activeSymbols,
        failedCommandNames,
        successfulCommandNames,
        frictionSummary,
        selectedDiffExcerpts,
        recentTopicTags,
        recentAngles,
        phrasesToAvoid,
        commitEvidence,
    };

    inspectDraftRequestForUnsafeContent(request);

    const totalBytes = estimateRequestSize(request);
    if (totalBytes > MAX_REQUEST_CONTEXT_BYTES) {
        throw contextTooLarge();
    }

    return request;
}

export function parseFeedbackRequest(input: unknown): FeedbackRequest {
    const source = assertExactKeys(
        input,
        [
            'deviceId',
            'requestId',
            'draftId',
            'clientVersion',
            'triggerType',
            'feedbackType',
            'topicTag',
            'angle',
            'timestampUtc',
            'dismissReason',
            'errorCode',
        ],
        'feedback request'
    );

    const deviceId = parseTrimmedString(source.deviceId, 'deviceId', 64, { required: true }) as string;
    const requestId = parseTrimmedString(source.requestId, 'requestId', 64, { required: true }) as string;
    const draftId = parseTrimmedString(source.draftId, 'draftId', 64, { required: true }) as string;
    const clientVersion = parseTrimmedString(source.clientVersion, 'clientVersion', MAX_CLIENT_VERSION_CHARS);
    const triggerType = parseEnum(source.triggerType, TRIGGER_TYPES, 'triggerType');
    const feedbackType = parseEnum(source.feedbackType, FEEDBACK_TYPES, 'feedbackType');
    const topicTag = parseTrimmedString(source.topicTag, 'topicTag', MAX_TOPIC_TAG_CHARS, { required: true }) as string;
    const angle = parseTrimmedString(source.angle, 'angle', MAX_ANGLE_CHARS, { required: true }) as string;
    const timestampUtc = parseTrimmedString(source.timestampUtc, 'timestampUtc', 64, { required: true }) as string;
    const dismissReason = source.dismissReason === undefined || source.dismissReason === null
        ? undefined
        : parseEnum(source.dismissReason, DISMISS_REASONS, 'dismissReason');
    const errorCode = source.errorCode === undefined || source.errorCode === null
        ? undefined
        : parseTrimmedString(source.errorCode, 'errorCode', 64, { required: true });

    if (!deviceId || !UUID_PATTERN.test(deviceId)) {
        throw invalidDeviceId();
    }
    if (!requestId || !UUID_PATTERN.test(requestId)) {
        throw badRequest('requestId is invalid.');
    }
    if (!draftId || !UUID_PATTERN.test(draftId)) {
        throw badRequest('draftId is invalid.');
    }
    if (Number.isNaN(Date.parse(timestampUtc))) {
        throw badRequest('timestampUtc is invalid.');
    }
    if (feedbackType === 'dismissed' && !dismissReason) {
        throw badRequest('dismissReason is required when feedbackType is dismissed.');
    }
    if (feedbackType !== 'dismissed' && dismissReason) {
        throw badRequest('dismissReason is only allowed when feedbackType is dismissed.');
    }

    if (errorCode && !isSupportedErrorCode(errorCode)) {
        throw badRequest('errorCode is not supported.');
    }

    const request: FeedbackRequest = {
        deviceId,
        requestId,
        draftId,
        clientVersion,
        triggerType,
        feedbackType,
        topicTag,
        angle,
        timestampUtc,
        dismissReason,
        errorCode: errorCode as FeedbackRequest['errorCode'],
    };

    inspectDraftRequestForUnsafeContent({
        deviceId,
        requestId,
        clientVersion: clientVersion ?? '',
        triggerType,
        projectSummary: `${feedbackType} feedback for ${topicTag}`,
        projectName: undefined,
        currentFocus: undefined,
        commitMessages: [topicTag, angle],
        changedRelativePaths: [],
        activeSymbols: [],
        failedCommandNames: [],
        successfulCommandNames: [],
        frictionSummary: undefined,
        selectedDiffExcerpts: [],
        recentTopicTags: [topicTag],
        recentAngles: [angle],
        phrasesToAvoid: [],
    });

    return request;
}

export function parseApiRequestBody(request: ApiRequestLike): unknown {
    return normalizeRequestBody(request.body);
}
