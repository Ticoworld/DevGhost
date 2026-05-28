import * as vscode from 'vscode';
import { ErrorListener } from './errorListener';
import { GeminiService, BreakthroughContext } from '../analyzer';

/**
 * SaveListener - The "Breakthrough" Detector
 * 
 * This class monitors file saves and cross-references with the error state
 * to detect "breakthrough" moments - when a developer fixes their errors.
 * 
 * Key insight: TypeScript updates diagnostics in REAL-TIME as you type.
 * So by the time you save, errors might already be 0. We need to track
 * "recent errors" - if we HAD errors in the last few seconds and now
 * have 0, that's a breakthrough!
 */
export class SaveListener implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private outputChannel: vscode.OutputChannel;
    private errorListener: ErrorListener;
    private geminiService: GeminiService | null = null;

    // Track recent errors per file (for breakthrough detection)
    // Maps file path -> { errorCount, timestamp }
    private recentErrors: Map<string, { count: number; timestamp: number }> = new Map();
    
    // How long to remember errors (5 seconds)
    private readonly ERROR_MEMORY_MS = 5000;

    // Callback to notify when a draft is generated
    private onTweetGeneratedCallback: ((tweet: string, context: BreakthroughContext) => void) | null = null;

    constructor(outputChannel: vscode.OutputChannel, errorListener: ErrorListener) {
        this.outputChannel = outputChannel;
        this.errorListener = errorListener;
        this.initialize();
    }

    /**
     * Set the Gemini service for AI content generation.
     */
    setGeminiService(service: GeminiService): void {
        this.geminiService = service;
    }

    /**
     * Register a callback for when a draft is generated.
     */
    onTweetGenerated(callback: (tweet: string, context: BreakthroughContext) => void): void {
        this.onTweetGeneratedCallback = callback;
    }

    private initialize(): void {
        // Listen for document save events
        const saveSubscription = vscode.workspace.onDidSaveTextDocument(
            (document: vscode.TextDocument) => {
                this.handleDocumentSave(document);
            }
        );

        this.disposables.push(saveSubscription);

        // Listen to error count changes to track recent errors
        this.errorListener.onErrorCountChange((current, previous) => {
            this.handleErrorCountChange(current, previous);
        });

        // Also watch diagnostics directly for the active file
        const diagnosticSubscription = vscode.languages.onDidChangeDiagnostics((e) => {
            this.trackDiagnosticChanges(e);
        });
        this.disposables.push(diagnosticSubscription);

        this.outputChannel.appendLine('[DevGhost] Save listener initialized - watching for breakthroughs');
    }

    /**
     * Track diagnostic changes to remember recent errors.
     */
    private trackDiagnosticChanges(event: vscode.DiagnosticChangeEvent): void {
        const now = Date.now();
        
        for (const uri of event.uris) {
            const diagnostics = vscode.languages.getDiagnostics(uri);
            const errorCount = diagnostics.filter(
                (d) => d.severity === vscode.DiagnosticSeverity.Error
            ).length;

            const filePath = uri.fsPath;
            
            // If there are errors, remember them
            if (errorCount > 0) {
                const existing = this.recentErrors.get(filePath);
                // Keep the highest error count we've seen
                if (!existing || errorCount >= existing.count) {
                    this.recentErrors.set(filePath, { count: errorCount, timestamp: now });
                }
            }
        }
    }

    /**
     * Track error count changes from the ErrorListener.
     */
    private handleErrorCountChange(current: number, previous: number): void {
        if (current === 0 && previous > 0) {
            this.outputChannel.appendLine(
                `[DevGhost] Errors cleared! (was ${previous}, now ${current})`
            );
        }
        
        // Update recent errors for active file
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && previous > 0) {
            const filePath = activeEditor.document.uri.fsPath;
            this.recentErrors.set(filePath, { 
                count: previous, 
                timestamp: Date.now() 
            });
        }
    }

    /**
     * Handle document save and check for breakthrough conditions.
     */
    private handleDocumentSave(document: vscode.TextDocument): void {
        if (document.uri.scheme !== 'file') {
            return;
        }

        const filename = this.getFilename(document.uri);
        const filePath = document.uri.fsPath;
        const uri = document.uri;
        
        // Get current error count
        const diagnostics = vscode.languages.getDiagnostics(uri);
        const currentErrorCount = diagnostics.filter(
            (d) => d.severity === vscode.DiagnosticSeverity.Error
        ).length;

        // Check if we had recent errors for this file
        const recentError = this.recentErrors.get(filePath);
        const now = Date.now();
        const hadRecentErrors = recentError && 
            (now - recentError.timestamp) < this.ERROR_MEMORY_MS &&
            recentError.count > 0;
        
        this.outputChannel.appendLine(
            `[DevGhost] File saved: ${filename} (current: ${currentErrorCount}, recent: ${recentError?.count ?? 0})`
        );

        // Wait for TypeScript to settle, then check
        setTimeout(() => {
            this.checkBreakthroughAfterSave(uri, filename, recentError?.count ?? 0, hadRecentErrors ?? false);
        }, 500);
    }

    /**
     * Check for breakthrough after TypeScript has finished recompiling.
     */
    private checkBreakthroughAfterSave(
        uri: vscode.Uri, 
        filename: string, 
        recentErrorCount: number,
        hadRecentErrors: boolean
    ): void {
        const diagnostics = vscode.languages.getDiagnostics(uri);
        const currentErrors = diagnostics.filter(
            (d) => d.severity === vscode.DiagnosticSeverity.Error
        ).length;

        this.outputChannel.appendLine(
            `[DevGhost] After recompile: ${filename} now has ${currentErrors} error(s)`
        );

        // BREAKTHROUGH: had errors recently, now have 0
        if (currentErrors === 0 && hadRecentErrors && recentErrorCount > 0) {
            // Clear the recent errors for this file (already handled)
            this.recentErrors.delete(uri.fsPath);
            this.triggerBreakthrough(filename, recentErrorCount);
        }
    }

    /**
     * Handle a detected breakthrough.
     */
    private async triggerBreakthrough(filename: string, previousErrorCount: number): Promise<void> {
        this.outputChannel.appendLine('');
        this.outputChannel.appendLine('## [BREAKTHROUGH DETECTED]');
        this.outputChannel.appendLine(`   BREAKTHROUGH DETECTED in ${filename}!`);
        this.outputChannel.appendLine(`   Fixed ${previousErrorCount} error(s)`);
        this.outputChannel.appendLine('--------------------------');
        this.outputChannel.appendLine('');

        if (this.geminiService && this.geminiService.isInitialized()) {
            await this.generateContent(filename, previousErrorCount);
        } else {
            this.outputChannel.appendLine('[DevGhost] Gemini not configured. Run "DevGhost: Add AI Key" to enable AI drafts.');
        }
    }

    /**
     * Generate content using Gemini AI.
     */
    private async generateContent(filename: string, errorCount: number): Promise<void> {
        this.outputChannel.appendLine('[DevGhost] Generating draft with Gemini...');

        const context: BreakthroughContext = {
            filename,
            errorCount,
        };

        try {
            const tweet = await this.geminiService!.generateBreakthroughTweet(context);

            this.outputChannel.appendLine('');
            this.outputChannel.appendLine('Generated Draft:');
        this.outputChannel.appendLine('--- Generated Draft ---');
            this.outputChannel.appendLine(tweet);
        this.outputChannel.appendLine('-----------------------');
            this.outputChannel.appendLine('');

            if (this.onTweetGeneratedCallback) {
                this.onTweetGeneratedCallback(tweet, context);
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.outputChannel.appendLine(`[DevGhost] [ERROR] Gemini failed: ${errorMessage}`);
            
            // Use fallback draft so user can still review
            const fallbackTweet = this.generateFallbackTweet(filename, errorCount);
            this.outputChannel.appendLine('[DevGhost] Using fallback draft instead...');
            this.outputChannel.appendLine('');
            this.outputChannel.appendLine('Fallback Draft:');
            this.outputChannel.appendLine('--- Fallback Draft ---');
            this.outputChannel.appendLine(fallbackTweet);
            this.outputChannel.appendLine('----------------------');
            this.outputChannel.appendLine('');

            if (this.onTweetGeneratedCallback) {
                this.onTweetGeneratedCallback(fallbackTweet, context);
            }
        }
    }

    /**
     * Generate a fallback draft when Gemini is unavailable.
     */
    private generateFallbackTweet(filename: string, errorCount: number): string {
        const templates = [
            `just mass-executed ${errorCount} error(s) in ${filename}. mass murderer vibes but make it dev 💀 #BuildInPublic`,
            `debugging ${filename}: fixed ${errorCount} error(s). my brain cells didn't survive but the code did 🫠 #BuildInPublic`,
            `${errorCount} error(s) down in ${filename}. who said programming is relaxing? #BuildInPublic`,
            `finally shipped ${filename} after ${errorCount} error(s). the struggle was real 😮‍💨 #BuildInPublic`,
        ];
        return templates[Math.floor(Math.random() * templates.length)];
    }

    private getFilename(uri: vscode.Uri): string {
        const parts = uri.fsPath.split(/[/\\]/);
        return parts[parts.length - 1] || uri.fsPath;
    }

    public dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.disposables = [];
        this.recentErrors.clear();
    }
}
