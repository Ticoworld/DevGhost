import * as vscode from 'vscode';
import { type FeedbackType, MAX_ANGLE_CHARS, MAX_PHRASES_TO_AVOID, MAX_PHRASE_CHARS, MAX_RECENT_ANGLES, MAX_RECENT_TOPIC_TAGS, MAX_TOPIC_TAG_CHARS } from './contracts';

const STORAGE_KEY = 'devghost.cloud.repetitionMemory';

interface TopicAngleEntry {
    topicTag: string;
    angle: string;
    lastSeenAtUtc: string;
    successCount: number;
    copiedCount: number;
    openedXCount: number;
    dismissedCount: number;
    lastFeedbackType?: FeedbackType;
}

interface StoredRepetitionMemory {
    entries: TopicAngleEntry[];
    phrasesToAvoid: string[];
}

export interface RepetitionSnapshot {
    recentTopicTags: string[];
    recentAngles: string[];
    phrasesToAvoid: string[];
}

function normalizeToken(value: string, maxChars: number): string {
    return value.trim().toLowerCase().slice(0, maxChars);
}

function unique(values: string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function sortByRecent(entries: TopicAngleEntry[]): TopicAngleEntry[] {
    return [...entries].sort((a, b) => Date.parse(b.lastSeenAtUtc) - Date.parse(a.lastSeenAtUtc));
}

function buildDerivedPhrases(entries: TopicAngleEntry[], seedPhrases: string[]): string[] {
    const phrases = new Set<string>(seedPhrases);

    for (const entry of entries) {
        const pair = `${entry.topicTag} ${entry.angle}`.trim();
        const repeatCount = entry.successCount + entry.copiedCount + entry.openedXCount + entry.dismissedCount;
        if (repeatCount >= 2) {
            phrases.add(pair);
            phrases.add(`same ${entry.topicTag}`);
            phrases.add(`same ${entry.angle}`);
        }
        if (entry.dismissedCount > 0) {
            phrases.add(`avoid ${entry.topicTag} again`);
        }
    }

    return unique([...phrases].map((phrase) => phrase.trim().slice(0, MAX_PHRASE_CHARS))).slice(0, MAX_PHRASES_TO_AVOID);
}

export class CloudRepetitionMemory {
    private state: StoredRepetitionMemory;

    constructor(private readonly storage: vscode.Memento) {
        this.state = storage.get<StoredRepetitionMemory>(STORAGE_KEY, {
            entries: [],
            phrasesToAvoid: [],
        }) ?? {
            entries: [],
            phrasesToAvoid: [],
        };
    }

    getSnapshot(): RepetitionSnapshot {
        const entries = sortByRecent(this.state.entries);
        const recentTopicTags = unique(entries.map((entry) => entry.topicTag)).slice(0, MAX_RECENT_TOPIC_TAGS);
        const recentAngles = unique(entries.map((entry) => entry.angle)).slice(0, MAX_RECENT_ANGLES);
        const phrasesToAvoid = buildDerivedPhrases(entries, this.state.phrasesToAvoid);

        return {
            recentTopicTags,
            recentAngles,
            phrasesToAvoid,
        };
    }

    async recordDraft(topicTag: string, angle: string): Promise<void> {
        this.touch(topicTag, angle, 'success');
        await this.persist();
    }

    async recordFeedback(topicTag: string, angle: string, feedbackType: FeedbackType): Promise<void> {
        this.touch(topicTag, angle, feedbackType);
        if (feedbackType === 'dismissed') {
            const normalizedTopic = normalizeToken(topicTag, MAX_TOPIC_TAG_CHARS);
            const normalizedAngle = normalizeToken(angle, MAX_ANGLE_CHARS);
            this.state.phrasesToAvoid = unique([
                ...this.state.phrasesToAvoid,
                `${normalizedTopic} ${normalizedAngle}`.trim(),
                `avoid ${normalizedTopic} again`,
            ]).slice(0, MAX_PHRASES_TO_AVOID);
        }
        await this.persist();
    }

    private touch(topicTag: string, angle: string, feedbackType: FeedbackType | 'success'): void {
        const normalizedTopicTag = normalizeToken(topicTag, MAX_TOPIC_TAG_CHARS);
        const normalizedAngle = normalizeToken(angle, MAX_ANGLE_CHARS);
        const now = new Date().toISOString();
        const existing = this.state.entries.find((entry) => entry.topicTag === normalizedTopicTag && entry.angle === normalizedAngle);

        if (existing) {
            existing.lastSeenAtUtc = now;
            if (feedbackType === 'success') {
                existing.successCount += 1;
            } else if (feedbackType === 'copied') {
                existing.copiedCount += 1;
                existing.lastFeedbackType = feedbackType;
            } else if (feedbackType === 'opened_x') {
                existing.openedXCount += 1;
                existing.lastFeedbackType = feedbackType;
            } else if (feedbackType === 'dismissed') {
                existing.dismissedCount += 1;
                existing.lastFeedbackType = feedbackType;
            }
        } else {
            this.state.entries.unshift({
                topicTag: normalizedTopicTag,
                angle: normalizedAngle,
                lastSeenAtUtc: now,
                successCount: feedbackType === 'success' ? 1 : 0,
                copiedCount: feedbackType === 'copied' ? 1 : 0,
                openedXCount: feedbackType === 'opened_x' ? 1 : 0,
                dismissedCount: feedbackType === 'dismissed' ? 1 : 0,
                lastFeedbackType: feedbackType === 'success' ? undefined : feedbackType,
            });
        }

        this.state.entries = sortByRecent(this.state.entries).slice(0, 12);
        this.state.phrasesToAvoid = buildDerivedPhrases(this.state.entries, this.state.phrasesToAvoid);
    }

    private async persist(): Promise<void> {
        await this.storage.update(STORAGE_KEY, this.state);
    }
}
