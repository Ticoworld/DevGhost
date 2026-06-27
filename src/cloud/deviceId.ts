import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

const DEVICE_ID_SECRET_KEY = 'devghost.cloud.deviceId';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string | undefined | null): value is string {
    return typeof value === 'string' && UUID_PATTERN.test(value);
}

export async function getOrCreateCloudDeviceId(context: vscode.ExtensionContext): Promise<string> {
    const existing = await context.secrets.get(DEVICE_ID_SECRET_KEY);
    if (isUuid(existing)) {
        return existing;
    }

    const deviceId = randomUUID();
    await context.secrets.store(DEVICE_ID_SECRET_KEY, deviceId);
    return deviceId;
}

export async function clearCloudDeviceId(context: vscode.ExtensionContext): Promise<void> {
    await context.secrets.delete(DEVICE_ID_SECRET_KEY);
}
