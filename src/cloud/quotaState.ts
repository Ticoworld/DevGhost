import * as vscode from 'vscode';
import type { QuotaSnapshot } from './contracts';

const STORAGE_KEY = 'devghost.cloud.quotaState';
const NOTICE_KEY = 'devghost.cloud.quotaNoticeState';

interface StoredQuotaState {
    deviceId: string;
    updatedAtUtc: string;
    quota: QuotaSnapshot;
}

interface StoredQuotaNoticeState {
    deviceId: string;
    resetAtUtc: string;
    shownAtUtc: string;
}

export class CloudQuotaState {
    constructor(private readonly storage: vscode.Memento) {}

    getCachedQuota(deviceId: string): QuotaSnapshot | null {
        const stored = this.storage.get<StoredQuotaState | null>(STORAGE_KEY, null);
        if (!stored || stored.deviceId !== deviceId) {
            return null;
        }

        return stored.quota;
    }

    async setCachedQuota(deviceId: string, quota: QuotaSnapshot): Promise<void> {
        const stored: StoredQuotaState = {
            deviceId,
            updatedAtUtc: new Date().toISOString(),
            quota,
        };

        await this.storage.update(STORAGE_KEY, stored);
    }

    async shouldShowQuotaLimitReachedNotice(deviceId: string, resetAtUtc: string): Promise<boolean> {
        const stored = this.storage.get<StoredQuotaNoticeState | null>(NOTICE_KEY, null);
        if (stored && stored.deviceId === deviceId && stored.resetAtUtc === resetAtUtc) {
            return false;
        }

        const next: StoredQuotaNoticeState = {
            deviceId,
            resetAtUtc,
            shownAtUtc: new Date().toISOString(),
        };

        await this.storage.update(NOTICE_KEY, next);
        return true;
    }

    async clear(): Promise<void> {
        await Promise.all([
            this.storage.update(STORAGE_KEY, undefined as unknown as StoredQuotaState),
            this.storage.update(NOTICE_KEY, undefined as unknown as StoredQuotaNoticeState),
        ]);
    }
}
