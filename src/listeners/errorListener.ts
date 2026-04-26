import * as vscode from 'vscode';

/**
 * ErrorListener - "The Ears" of DevGhost
 * 
 * This class monitors VS Code's diagnostic system to detect compilation errors,
 * linting issues, and other problems in the developer's code. It acts as the
 * "nervous system" that senses when the developer is struggling with errors.
 * 
 * Why this approach?
 * - vscode.languages.onDidChangeDiagnostics is the canonical way to listen for
 *   all diagnostic changes across the entire workspace
 * - Debouncing prevents spam during active typing (LSP fires many events)
 * - Focusing on the active file keeps the signal relevant to what the dev is working on
 */
export class ErrorListener implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private outputChannel: vscode.OutputChannel;
    
    // Track error state for breakthrough detection
    private currentErrorCount: number = 0;
    private previousErrorCount: number = 0;
    
    // Debounce timer to avoid logging on every keystroke
    // 2 seconds gives enough time for the LSP to settle after typing stops
    private debounceTimer: NodeJS.Timeout | undefined;
    private readonly DEBOUNCE_MS = 2000;

    // Callback for when error count changes (used by SaveListener for breakthrough detection)
    private onErrorCountChangeCallback: ((current: number, previous: number) => void) | undefined;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        this.initialize();
    }

    /**
     * Subscribe to VS Code's diagnostic change events.
     * 
     * Why onDidChangeDiagnostics?
     * - It captures ALL diagnostic sources: TypeScript, ESLint, language servers, etc.
     * - It fires whenever any diagnostic in the workspace changes
     * - More reliable than trying to poll or use file watchers
     */
    private initialize(): void {
        // Subscribe to diagnostic changes across the entire workspace
        const diagnosticSubscription = vscode.languages.onDidChangeDiagnostics(
            (event: vscode.DiagnosticChangeEvent) => {
                this.handleDiagnosticChange(event);
            }
        );

        this.disposables.push(diagnosticSubscription);
        this.outputChannel.appendLine('[DevGhost] Error listener initialized - monitoring for diagnostics');
    }

    /**
     * Handle diagnostic changes with debouncing.
     * 
     * Why debounce?
     * - During active typing, diagnostics change rapidly (every keystroke)
     * - We only care about the "settled" state after the developer pauses
     * - 2 seconds is long enough to know typing has stopped, short enough to feel responsive
     */
    private handleDiagnosticChange(_event: vscode.DiagnosticChangeEvent): void {
        // Clear any existing timer - we restart the countdown on each change
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        // Start a new timer - only process after 2 seconds of quiet
        this.debounceTimer = setTimeout(() => {
            this.processCurrentDiagnostics();
        }, this.DEBOUNCE_MS);
    }

    /**
     * Process diagnostics for the currently active file.
     * 
     * Why focus on the active file?
     * - The developer is actively working on this file
     * - Errors in other files are less relevant to their current "struggle"
     * - Keeps the content generation focused and specific
     */
    private processCurrentDiagnostics(): void {
        const activeEditor = vscode.window.activeTextEditor;
        
        if (!activeEditor) {
            // No active editor - nothing to monitor
            return;
        }

        const uri = activeEditor.document.uri;
        const diagnostics = vscode.languages.getDiagnostics(uri);

        // Filter to only Error severity (ignore warnings, hints, info)
        // We want to track real problems, not style suggestions
        const errorCount = diagnostics.filter(
            (diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error
        ).length;

        // Store previous count before updating (for breakthrough detection)
        this.previousErrorCount = this.currentErrorCount;
        this.currentErrorCount = errorCount;

        // Only log if there are actual errors to report
        if (errorCount > 0) {
            const filename = this.getFilename(uri);
            this.outputChannel.appendLine(
                `[DevGhost] Detected ${errorCount} error(s) in ${filename}`
            );
        }

        // Notify listeners about the count change (for breakthrough detection)
        if (this.onErrorCountChangeCallback) {
            this.onErrorCountChangeCallback(this.currentErrorCount, this.previousErrorCount);
        }
    }

    /**
     * Extract just the filename from a URI for cleaner logging.
     */
    private getFilename(uri: vscode.Uri): string {
        const parts = uri.fsPath.split(/[/\\]/);
        return parts[parts.length - 1] || uri.fsPath;
    }

    /**
     * Get the current error count for the active file.
     * Used by SaveListener for breakthrough detection.
     */
    public getCurrentErrorCount(): number {
        return this.currentErrorCount;
    }

    /**
     * Get the previous error count (before the last change).
     * Used for detecting when errors drop to zero.
     */
    public getPreviousErrorCount(): number {
        return this.previousErrorCount;
    }

    /**
     * Register a callback for when error counts change.
     * This enables loose coupling between ErrorListener and SaveListener.
     */
    public onErrorCountChange(callback: (current: number, previous: number) => void): void {
        this.onErrorCountChangeCallback = callback;
    }

    /**
     * Force a check of current diagnostics.
     * Useful when a file is saved and we need immediate error count.
     */
    public checkCurrentDiagnostics(): { current: number; previous: number } {
        const activeEditor = vscode.window.activeTextEditor;
        
        if (!activeEditor) {
            return { current: 0, previous: this.previousErrorCount };
        }

        const uri = activeEditor.document.uri;
        const diagnostics = vscode.languages.getDiagnostics(uri);

        const errorCount = diagnostics.filter(
            (diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error
        ).length;

        return { current: errorCount, previous: this.previousErrorCount };
    }

    /**
     * Clean up subscriptions when the extension is deactivated.
     * VS Code calls dispose() on all registered disposables.
     */
    public dispose(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        
        this.disposables.forEach((d) => d.dispose());
        this.disposables = [];
    }
}
