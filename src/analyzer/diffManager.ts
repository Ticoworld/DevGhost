import * as vscode from 'vscode';
import * as child_process from 'child_process';

/**
 * Diff summary for a commit.
 */
export interface DiffSummary {
    hash: string;
    message: string;
    filesChanged: string[];
    additions: number;
    deletions: number;
    /** Summarized diff content (truncated if too long) */
    summary: string;
    /** Full diff (only if < 2000 chars) */
    fullDiff?: string;
}

/**
 * DiffManager - The Code Reader
 * 
 * Phase 8: Agentic Intelligence
 * 
 * Reads actual code changes from Git to give AI context about
 * WHAT changed, not just THAT something changed.
 */
export class DiffManager {
    private outputChannel: vscode.OutputChannel;

    // Files to exclude from diff analysis (noise)
    private readonly EXCLUDED_FILES = [
        'package-lock.json',
        'yarn.lock',
        'pnpm-lock.yaml',
        'node_modules/',
        '.next/',
        'dist/',
        'build/',
    ];

    // Max diff size before summarizing
    private readonly MAX_DIFF_CHARS = 2000;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    /**
     * Get a summary of the commit diff.
     */
    async getCommitDiff(commitHash: string): Promise<DiffSummary | null> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceFolder) return null;

        try {
            // Get commit message
            const message = await this.runGitCommand(workspaceFolder, [
                'log', '-1', '--format=%s', commitHash
            ]);

            // Get file stats
            const statOutput = await this.runGitCommand(workspaceFolder, [
                'show', '--stat', '--format=', commitHash
            ]);

            // Parse stats
            const { filesChanged, additions, deletions } = this.parseStats(statOutput);

            // Filter out excluded files
            const relevantFiles = filesChanged.filter(f => 
                !this.EXCLUDED_FILES.some(excluded => f.includes(excluded))
            );

            if (relevantFiles.length === 0) {
                return {
                    hash: commitHash.substring(0, 7),
                    message: message.trim(),
                    filesChanged: [],
                    additions: 0,
                    deletions: 0,
                    summary: 'Only lockfiles or build artifacts changed.',
                };
            }

            // Get the actual diff (unified format, minimal context)
            const diffOutput = await this.runGitCommand(workspaceFolder, [
                'show', '--unified=0', '--format=', commitHash,
                '--', ...relevantFiles.slice(0, 5)  // Limit to 5 files
            ]);

            // Build summary
            const summary = this.buildSummary(relevantFiles, additions, deletions, diffOutput);

            return {
                hash: commitHash.substring(0, 7),
                message: message.trim(),
                filesChanged: relevantFiles,
                additions,
                deletions,
                summary,
                fullDiff: diffOutput.length < this.MAX_DIFF_CHARS ? diffOutput : undefined,
            };

        } catch (error) {
            this.outputChannel.appendLine(`[DevGhost] DiffManager error: ${error}`);
            return null;
        }
    }

    /**
     * Parse git stat output.
     */
    private parseStats(statOutput: string): { filesChanged: string[]; additions: number; deletions: number } {
        const lines = statOutput.trim().split('\n');
        const filesChanged: string[] = [];
        let additions = 0;
        let deletions = 0;

        for (const line of lines) {
            // Match file change lines: " file.ts | 10 +++---"
            const fileMatch = line.match(/^\s*(.+?)\s+\|\s+(\d+)/);
            if (fileMatch) {
                filesChanged.push(fileMatch[1].trim());
            }

            // Match summary line: "5 files changed, 100 insertions(+), 50 deletions(-)"
            const addMatch = line.match(/(\d+)\s+insertion/);
            const delMatch = line.match(/(\d+)\s+deletion/);
            if (addMatch) additions = parseInt(addMatch[1]);
            if (delMatch) deletions = parseInt(delMatch[1]);
        }

        return { filesChanged, additions, deletions };
    }

    /**
     * Build a smart summary of the diff.
     */
    private buildSummary(files: string[], additions: number, deletions: number, diff: string): string {
        const parts: string[] = [];

        // File overview
        if (files.length === 1) {
            parts.push(`Modified ${files[0]}`);
        } else if (files.length <= 3) {
            parts.push(`Modified ${files.join(', ')}`);
        } else {
            parts.push(`Modified ${files.length} files including ${files.slice(0, 2).join(', ')}`);
        }

        // Change volume
        parts.push(`(+${additions}/-${deletions} lines)`);

        // If diff is small, include key changes
        if (diff.length < this.MAX_DIFF_CHARS) {
            // Extract function/class names from diff
            const functionMatches = diff.match(/^\+.*(?:function|class|const|export)\s+(\w+)/gm);
            if (functionMatches && functionMatches.length > 0) {
                const names = functionMatches
                    .slice(0, 3)
                    .map(m => m.replace(/^\+.*(?:function|class|const|export)\s+/, ''))
                    .join(', ');
                parts.push(`Added: ${names}`);
            }
        }

        return parts.join(' ');
    }

    /**
     * Run a git command and return output.
     */
    private runGitCommand(cwd: string, args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            child_process.execFile('git', args, { cwd, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
                if (error) {
                    reject(stderr || error.message);
                } else {
                    resolve(stdout);
                }
            });
        });
    }
}
