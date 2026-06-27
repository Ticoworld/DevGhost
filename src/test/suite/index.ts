import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

type AnyRecord = Record<string, any>;
const smokeLogPath = path.resolve(__dirname, '../smoke-test.log');

function log(message: string): void {
    fs.appendFileSync(smokeLogPath, `${new Date().toISOString()} ${message}\n`);
}

function patchMethod(target: AnyRecord, key: string, replacement: (...args: any[]) => any): () => void {
    const original = target[key];
    target[key] = replacement;
    return () => {
        target[key] = original;
    };
}

async function runSmokeTest(): Promise<void> {
    const restores: Array<() => void> = [];
    log('Smoke test started.');

    const { ContextManager } = require('../../managers/contextManager') as typeof import('../../managers/contextManager');
    const { KeyManager } = require('../../analyzer/keyManager') as typeof import('../../analyzer/keyManager');
    const { GeminiService } = require('../../analyzer/gemini') as typeof import('../../analyzer/gemini');

    try {
        restores.push(patchMethod(ContextManager.prototype as AnyRecord, 'hasContext', () => true));
        restores.push(patchMethod(ContextManager.prototype as AnyRecord, 'askFocusOnOpen', async () => undefined));
        restores.push(patchMethod(KeyManager.prototype as AnyRecord, 'hasApiKey', async () => true));
        restores.push(patchMethod(KeyManager.prototype as AnyRecord, 'getApiKey', async () => 'test-key'));
        restores.push(patchMethod(GeminiService.prototype as AnyRecord, 'isInitialized', () => true));
        restores.push(patchMethod(GeminiService.prototype as AnyRecord, 'initialize', async () => undefined));
        restores.push(patchMethod(GeminiService.prototype as AnyRecord, 'validateKey', async () => true));
        restores.push(patchMethod(GeminiService.prototype as AnyRecord, 'validateModel', async () => true));
        restores.push(patchMethod(GeminiService.prototype as AnyRecord, 'resolveBestModel', async () => 'gemini-2.0-flash'));
        log('Patched startup helpers.');

        const extensionId = 'ticoworld.devghost';
        const extension =
            vscode.extensions.getExtension(extensionId) ??
            vscode.extensions.all.find((candidate) => candidate.id === extensionId || candidate.packageJSON?.name === 'devghost');

        if (!extension) {
            log('Extension was not found.');
            throw new Error('DevGhost extension was not found in the test host.');
        }
        log(`Found extension ${extension.id}.`);
        assert.strictEqual(extension.isActive, false, 'DevGhost should start inactive in the smoke test.');

        log('Activating extension.');
        await extension.activate();
        log('Extension activated.');

        assert.strictEqual(extension.isActive, true, 'DevGhost did not activate.');

        const commands = await vscode.commands.getCommands(true);
        log(`Loaded ${commands.length} commands.`);
        const expectedCommands = [
            'devghost.initialize',
            'devghost.setFocus',
            'devghost.iWon',
            'devghost.showLogs',
            'devghost.setApiKey',
            'devghost.clearApiKey',
            'devghost.pause',
            'devghost.resume',
            'devghost.resetProjectContext',
            'devghost.resetRecentActivity',
            'devghost.shareGrind',
            'devghost.cloudDraft',
            'devghost.checkAiConnection',
        ];

        for (const commandId of expectedCommands) {
            log(`Checking command ${commandId}.`);
            assert.ok(commands.includes(commandId), `Expected command to be registered: ${commandId}`);
        }

        log('Smoke test assertions passed.');
    } finally {
        for (const restore of restores.reverse()) {
            try {
                restore();
            } catch {
                // Ignore restore failures in the smoke harness.
            }
        }
    }
}

export async function run(): Promise<void> {
    await runSmokeTest();
    console.log('DevGhost smoke test passed.');
    log('Smoke test finished successfully.');
}

if (require.main === module) {
    run().catch((error: unknown) => {
        console.error('DevGhost smoke test failed.');
        console.error(error);
        log(`Smoke test failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
        process.exit(1);
    });
}
