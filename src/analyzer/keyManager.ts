import * as vscode from 'vscode';

/**
 * KeyManager - Secure API Key Storage
 * 
 * Uses VS Code's SecretStorage API to securely store the Gemini API key.
 * The key is encrypted and stored in the operating system's secure storage
 * (Windows Credential Manager, macOS Keychain, Linux Secret Service).
 * 
 * Why SecretStorage?
 * - Keys are encrypted at rest
 * - Never stored in settings.json or source code
 * - Follows VS Code's security best practices
 */
export class KeyManager {
    private static readonly SECRET_KEY = 'devghost.gemini.apiKey';
    private secretStorage: vscode.SecretStorage;

    constructor(context: vscode.ExtensionContext) {
        this.secretStorage = context.secrets;
    }

    /**
     * Store the Gemini API key securely.
     */
    async setApiKey(apiKey: string): Promise<void> {
        await this.secretStorage.store(KeyManager.SECRET_KEY, apiKey);
    }

    /**
     * Retrieve the stored Gemini API key.
     * Returns undefined if no key is stored.
     */
    async getApiKey(): Promise<string | undefined> {
        return await this.secretStorage.get(KeyManager.SECRET_KEY);
    }

    /**
     * Check if an API key is stored.
     */
    async hasApiKey(): Promise<boolean> {
        const key = await this.getApiKey();
        return key !== undefined && key.length > 0;
    }

    /**
     * Delete the stored API key.
     */
    async deleteApiKey(): Promise<void> {
        await this.secretStorage.delete(KeyManager.SECRET_KEY);
    }
}
