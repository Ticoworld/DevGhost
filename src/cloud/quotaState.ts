import * as vscode from 'vscode';
import type { QuotaSnapshot } from './contracts';

const STORAGE_KEY = 'devghost.cloud.quotaState';

interface StoredQuotaState {
    deviceId: string;
    updatedAtUtc: string;
    quota: QuotaSnapshot;
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

    async clear(): Promise<void> {
        await this.storage.update(STORAGE_KEY, null as unknown as StoredQuotaState);
    }
}
