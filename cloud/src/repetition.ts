import {
    MAX_ANGLE_CHARS,
    MAX_CHANGED_PATH_CHARS,
    MAX_COMMIT_MESSAGE_CHARS,
    MAX_TOPIC_TAG_CHARS,
    type DraftRequest,
} from './contracts';
import { repetitiveContext } from './errors';
import { listRecentTopicAngleMemory, type DbClient, type TopicAngleMemoryRow, upsertTopicAngleMemory } from './neon';

export interface RepetitionSnapshot {
    topicTag: string;
    angle: string;
    avoidTopics: string[];
    avoidAngles: string[];
    score: number;
    shouldReject: boolean;
}

function normalizeTokens(values: string[] | undefined, maxChars: number): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values ?? []) {
        const token = value.trim().toLowerCase().slice(0, maxChars);
        if (!token || seen.has(token)) continue;
        seen.add(token);
        out.push(token);
    }
    return out;
}

function inferTopicFromText(text: string): string | null {
    const lower = text.toLowerCase();
    const rules: Array<[RegExp, string]> = [
        [/\b(auth|signin|login|session|oauth|sso)\b/i, 'auth'],
        [/\b(billing|invoice|subscription|checkout|payment)\b/i, 'billing'],
        [/\b(api|endpoint|route|request|response)\b/i, 'api'],
        [/\b(database|postgres|sql|schema|migration)\b/i, 'database'],
        [/\b(test|spec|vitest|jest|coverage)\b/i, 'tests'],
        [/\b(doc|docs|readme|changelog)\b/i, 'docs'],
        [/\b(ui|ux|design|component|layout|screen)\b/i, 'ui'],
        [/\b(deploy|vercel|release|prod|production)\b/i, 'deploy'],
        [/\b(security|secret|token|key|permission)\b/i, 'security'],
        [/\b(refactor|cleanup|restructure)\b/i, 'refactor'],
    ];

    for (const [pattern, topic] of rules) {
        if (pattern.test(lower)) {
            return topic;
        }
    }
    return null;
}

function inferTopicTag(request: DraftRequest): string {
    const candidates: string[] = [
        request.projectName ?? '',
        request.projectSummary,
        request.currentFocus ?? '',
        request.frictionSummary ?? '',
        request.commitEvidence?.commitMessage ?? '',
        request.commitEvidence?.workType ?? '',
        ...(request.commitMessages ?? []),
        ...(request.changedRelativePaths ?? []),
        ...(request.commitEvidence?.changedRelativePaths ?? []),
        ...(request.activeSymbols ?? []),
        ...(request.failedCommandNames ?? []),
        ...(request.successfulCommandNames ?? []),
        ...(request.commitEvidence?.signalReasons ?? []),
        ...(request.commitEvidence?.gateReasons ?? []),
    ];

    for (const candidate of candidates) {
        const inferred = inferTopicFromText(candidate);
        if (inferred) return inferred;
    }

    switch (request.triggerType) {
        case 'PROJECT_LAUNCH':
            return 'launch';
        case 'PROJECT_RESUME':
        case 'WARMUP_RETURN':
            return 'comeback';
        case 'FRICTION_BREAKTHROUGH':
            return 'bugfix';
        case 'DEEP_WORK_WRAP_UP':
            return 'deep-work';
        case 'SILENCE_BREAKER':
            return 'grind';
        case 'COMMIT_DETECTED':
            return 'shipping';
        case 'FOCUS_INTENT':
            return 'intent';
        case 'MANUAL_INTENT':
        default:
            return 'update';
    }
}

function inferCommitAngle(request: DraftRequest): string {
    const evidenceBlob = [
        request.commitEvidence?.commitMessage,
        request.commitEvidence?.workType,
        request.projectSummary,
        request.currentFocus ?? '',
        request.frictionSummary ?? '',
        ...(request.commitMessages ?? []),
        ...(request.changedRelativePaths ?? []),
        ...(request.commitEvidence?.changedRelativePaths ?? []),
        ...(request.activeSymbols ?? []),
    ].join(' ').toLowerCase();

    if (request.commitEvidence?.workType === 'tests' || /\b(test|tests|spec|vitest|jest|coverage)\b/i.test(evidenceBlob)) {
        return 'tests';
    }

    if (request.commitEvidence?.workType === 'docs' || /\b(doc|docs|documentation|readme|changelog)\b/i.test(evidenceBlob)) {
        return 'docs';
    }

    if (/\b(cli|command|doctor|status|terminal)\b/i.test(evidenceBlob)) {
        return 'cli';
    }

    if (/\b(ui|ux|component|layout|screen|page|view)\b/i.test(evidenceBlob)) {
        return 'ui';
    }

    if (/\b(memory|repetition|remember|draft angle)\b/i.test(evidenceBlob)) {
        return 'memory';
    }

    if (request.commitEvidence?.workType === 'config' || /\b(config|setup|env|initialize)\b/i.test(evidenceBlob)) {
        return 'setup';
    }

    if (request.commitEvidence?.workType === 'bugfix') {
        return 'fix';
    }

    if (request.commitEvidence?.workType === 'feature') {
        return 'shipping';
    }

    if (request.fileTypeSummary?.docsFiles && request.fileTypeSummary.docsFiles >= request.fileTypeSummary.sourceFiles) {
        return 'docs';
    }

    if (request.fileTypeSummary?.styleFiles && request.fileTypeSummary.styleFiles > request.fileTypeSummary.sourceFiles) {
        return 'ui';
    }

    return 'shipping';
}

function inferAngle(request: DraftRequest): string {
    if (request.triggerType === 'FRICTION_BREAKTHROUGH') return 'relief';
    if (request.triggerType === 'PROJECT_LAUNCH') return 'launch';
    if (request.triggerType === 'PROJECT_RESUME' || request.triggerType === 'WARMUP_RETURN') return 'comeback';
    if (request.triggerType === 'DEEP_WORK_WRAP_UP') return 'momentum';
    if (request.triggerType === 'SILENCE_BREAKER') return 'grind';
    if (request.triggerType === 'FOCUS_INTENT') return 'intent';
    if (request.triggerType === 'COMMIT_DETECTED') return inferCommitAngle(request);
    return request.frictionSummary ? 'friction' : 'progress';
}

function computeScore(memory: TopicAngleMemoryRow[], topicTag: string, angle: string, request: DraftRequest): number {
    let score = 0;
    const sameTopic = memory.filter((row) => row.topic_tag === topicTag);
    const samePair = memory.filter((row) => row.topic_tag === topicTag && row.angle === angle);
    score += sameTopic.length * 2;
    score += samePair.length * 4;
    score += normalizeTokens(request.recentTopicTags, MAX_TOPIC_TAG_CHARS).includes(topicTag) ? 4 : 0;
    score += normalizeTokens(request.recentAngles, MAX_ANGLE_CHARS).includes(angle) ? 3 : 0;
    score += normalizeTokens(request.changedRelativePaths, MAX_CHANGED_PATH_CHARS).length > 6 ? 1 : 0;
    score += normalizeTokens(request.commitMessages, MAX_COMMIT_MESSAGE_CHARS).length > 0 ? 1 : 0;
    score += request.frictionSummary ? 1 : 0;
    return score;
}

export async function buildRepetitionSnapshot(deviceId: string, request: DraftRequest): Promise<RepetitionSnapshot> {
    const memory = await listRecentTopicAngleMemory(deviceId, 12);
    const topicTag = inferTopicTag(request).slice(0, MAX_TOPIC_TAG_CHARS);
    const angle = inferAngle(request).slice(0, MAX_ANGLE_CHARS);
    const avoidTopics = [
        ...normalizeTokens(request.recentTopicTags, MAX_TOPIC_TAG_CHARS),
        ...memory.map((row) => row.topic_tag),
    ].filter((value) => value !== topicTag);
    const avoidAngles = [
        ...normalizeTokens(request.recentAngles, MAX_ANGLE_CHARS),
        ...memory.map((row) => row.angle),
    ].filter((value) => value !== angle);
    const score = computeScore(memory, topicTag, angle, request);
    const repeatedPair = memory.some((row) => row.topic_tag === topicTag && row.angle === angle && row.success_count >= 3);
    const shouldReject = repeatedPair && score >= 8;

    return {
        topicTag,
        angle,
        avoidTopics: [...new Set(avoidTopics)].slice(0, 6),
        avoidAngles: [...new Set(avoidAngles)].slice(0, 5),
        score,
        shouldReject,
    };
}

export function buildRepetitionError(snapshot: RepetitionSnapshot): Error {
    return repetitiveContext('Request is too similar to recent drafts.', {
        topicTag: snapshot.topicTag,
        angle: snapshot.angle,
        score: snapshot.score,
    });
}

export async function recordTopicAngleSuccess(
    client: DbClient,
    params: {
        deviceId: string;
        topicTag: string;
        angle: string;
    }
): Promise<void> {
    await upsertTopicAngleMemory(client, {
        deviceId: params.deviceId,
        topicTag: params.topicTag,
        angle: params.angle,
    });
}

export async function recordTopicAngleFeedback(
    client: DbClient,
    params: {
        deviceId: string;
        topicTag: string;
        angle: string;
        feedbackType: 'copied' | 'opened_x' | 'dismissed';
    }
): Promise<void> {
    await upsertTopicAngleMemory(client, {
        deviceId: params.deviceId,
        topicTag: params.topicTag,
        angle: params.angle,
        feedbackType: params.feedbackType,
    });
}
