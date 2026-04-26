
import { HistoryManager } from '../managers/historyManager';


/**
 * AgentTools - the local context tools for DevGhost
 * 
 * Provides local, zero-cost tools for the AI to understand the world.
 * - Eyes: Read git diffs
 * - Ears: Query history logs
 * - Proprioception: Session stats
 */
export class AgentTools {
    constructor(
        private historyManager: HistoryManager,

        private workspaceRoot: string
    ) {}

    /**
     * Tool Definitions for Gemini
     */
    static getToolDefinitions() {
        return [
            {
                name: "read_git_diff",
                description: "Reads the LATEST COMMIT's changes. Use this to understand WHAT the user just built or deleted. Returns the commit message and diff.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        detailLevel: {
                            type: "STRING",
                            description: "Either 'summary' (files changed + stats) or 'full' (actual code changes). Default to 'summary' unless you need to see the actual code.",
                            enum: ["summary", "full"]
                        }
                    }
                }
            },
            {
                name: "query_history",
                description: "Searches the developer's history for a specific topic/keyword. Use this to find out if they have been struggling with 'auth' or 'css' or 'database' recently.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        topic: {
                            type: "STRING",
                            description: "The keyword to search for (e.g., 'auth', 'error', 'fix', 'deploy')."
                        }
                    },
                    required: ["topic"]
                }
            },
            {
                name: "get_session_stats",
                description: "Get current session statistics (duration, struggle count, etc.). Use this to know if it's been a long session or a quick win.",
                parameters: {
                    type: "OBJECT",
                    properties: {}
                }
            },
            {
                name: "analyze_commit_files",
                description: "Analyzes all files changed in the latest commit. Returns file paths, types, and line counts. Use this to decide which file is the 'hero' (most important) and what type of visual to generate (code screenshot vs UI screenshot).",
                parameters: {
                    type: "OBJECT",
                    properties: {}
                }
            }
        ];
    }

    // ═══════════════════════════════════════════════════════════════
    // Implementation
    // ═══════════════════════════════════════════════════════════════

    /**
     * READ_GIT_DIFF
     * Executes `git log/show HEAD` to see what's IN the latest commit.
     * (Not `git diff HEAD` which shows uncommitted changes - empty after commit!)
     * @param repoRootOverride - if provided (e.g. from commit event), run git in this repo root.
     */
    async read_git_diff(args: { detailLevel?: 'summary' | 'full' }, repoRootOverride?: string): Promise<string> {
        const detail = args.detailLevel || 'summary';
        const cwd = repoRootOverride || this.workspaceRoot;
        // Use `git log -1 --stat` for summary (shows files changed without full diff)
        // Use `git show HEAD` for full (includes actual code changes)
        const command = detail === 'summary' 
            ? ['log', '-1', '--stat', 'HEAD']   // Commit info + file stats (no code diff)
            : ['show', 'HEAD'];                  // Full diff with code
        
        try {
            // We reuse the verify private method technique or just allow public access if possible.
            // Since GitManager encapsulates the logic, we might need a public expose or just run it ourselves if we have the path.
            // Ideally, we ask GitManager. But GitManager might not have a raw "run command" public API.
            // Let's rely on child_process directly for the agent to be "raw" and fast, 
            // OR add a method to GitManager. 
            // Users instructions said "Do NOT modify existing Plumbing... unless explicitly instructed".
            // So we will run git directly here since we have workspaceRoot.
            
            const cp = require('child_process');
            return new Promise((resolve) => {
                cp.execFile('git', command, { cwd }, (error: any, stdout: string) => {
                    if (error) {
                        resolve(`Error reading diff: ${error.message}`);
                    } else {
                        if (stdout.length > 5000 && detail === 'full') {
                            resolve(stdout.substring(0, 5000) + "\n... (Truncated for token limit)");
                        } else {
                            resolve(stdout || "No changes detected.");
                        }
                    }
                });
            });

        } catch (error: any) {
            return `Failed to read git diff: ${error.message}`;
        }
    }

    /**
     * QUERY_HISTORY
     * Searches history via HistoryManager (workspaceState-backed).
     */
    async query_history(args: { topic: string }): Promise<string> {
        try {
            const events = this.historyManager.getLastEvents(500);
            const regex = new RegExp(args.topic, 'i');
            const matches: string[] = [];

            for (const event of [...events].reverse()) {
                const line = JSON.stringify(event);
                if (regex.test(line)) {
                    matches.push(line);
                    if (matches.length >= 5) break;
                }
            }

            return matches.length > 0
                ? matches.join('\n')
                : `No events found related to "${args.topic}".`;
        } catch (error: any) {
            return `Error querying history: ${error.message}`;
        }
    }

    /**
     * GET_SESSION_STATS
     * Asks HistoryManager for recent events.
     */
    async get_session_stats(): Promise<string> {
        try {
            const events = this.historyManager.getLastEvents(50); // Get last 50 to cover session
            
            // Calculate session duration
            const lastStart = [...events].reverse().find(e => e.type === 'SESSION_START');
            let duration = "Unknown";
            if (lastStart) {
                const startTime = new Date(lastStart.timestamp).getTime();
                const diffMins = Math.floor((Date.now() - startTime) / 60000);
                duration = `${diffMins} minutes`;
            }

            // Count recent struggles
            const struggles = events.filter(e => e.type === 'STRUGGLE_DETECTED').length;
            const wins = events.filter(e => e.type === 'WIN').length;

            return JSON.stringify({
                status: "Active",
                duration: duration,
                recent_struggles: struggles,
                recent_wins: wins,
                last_event: events[events.length - 1]?.type || "None"
            }, null, 2);

        } catch (error: any) {
            return `Error getting stats: ${error.message}`;
        }
    }

    /**
     * ANALYZE_COMMIT_FILES
     * Returns all changed files with metadata to help AI decide what to screenshot.
     * @param repoRootOverride - if provided (e.g. from commit event), run git in this repo root.
     */
    async analyze_commit_files(repoRootOverride?: string): Promise<string> {
        const cwd = repoRootOverride || this.workspaceRoot;
        try {
            const cp = require('child_process');
            
            // Get commit stats
            const statOutput = cp.execSync(`git show HEAD --stat`, {
                cwd,
                encoding: 'utf-8'
            });

            const files: Array<{
                path: string;
                linesChanged: number;
                type: 'code' | 'ui' | 'config' | 'other';
                extension: string;
            }> = [];

            // Parse file stats (format: "file.ts | 50 +++++++++++++++++++++++++++++++++++++++++++++++++++")
            const lines = statOutput.split('\n');
            for (const line of lines) {
                // Correct format: " path/to/file.ts | 50 +++++++++++++++"
                const match = line.match(/^\s*(.+?)\s+\|\s+(\d+)\s+[+\-]+/);
                if (match) {
                    const filePath = match[1].trim();
                    const linesChanged = parseInt(match[2]);
                    const ext = filePath.substring(filePath.lastIndexOf('.'));
                    
                    let type: 'code' | 'ui' | 'config' | 'other' = 'other';
                    if (['.tsx', '.jsx', '.css', '.html', '.vue', '.svelte'].includes(ext)) {
                        type = 'ui';
                    } else if (['.ts', '.js', '.py', '.rs', '.go', '.java', '.cpp', '.c'].includes(ext)) {
                        type = 'code';
                    } else if (['.json', '.yaml', '.yml', '.toml', '.env'].includes(ext)) {
                        type = 'config';
                    }

                    files.push({
                        path: filePath,
                        linesChanged,
                        type,
                        extension: ext
                    });
                }
            }

            return JSON.stringify({
                files: files,
                totalFiles: files.length,
                uiFiles: files.filter(f => f.type === 'ui'),
                codeFiles: files.filter(f => f.type === 'code'),
                suggestion: files.length > 0 
                    ? this.generateVisualSuggestion(files)
                    : "No files changed"
            }, null, 2);

        } catch (error: any) {
            return `Error analyzing files: ${error.message}`;
        }
    }

    /**
     * Generate a suggestion for what type of visual to create.
     */
    private generateVisualSuggestion(files: Array<{ type: string; linesChanged: number; path: string }>): string {
        const uiFiles = files.filter(f => f.type === 'ui');
        const codeFiles = files.filter(f => f.type === 'code');
        
        if (uiFiles.length > 0 && uiFiles.some(f => f.linesChanged > 20)) {
            return "UI_CHANGE: Consider suggesting a UI screenshot (landing page, component preview) instead of code screenshot.";
        }
        
        if (codeFiles.length > 0) {
            // Find the most interesting code file (not just biggest)
            const heroFile = codeFiles.reduce((prev, curr) => {
                // Prefer files with meaningful names (not config, not test)
                const prevScore = this.scoreFileImportance(prev.path, prev.linesChanged);
                const currScore = this.scoreFileImportance(curr.path, curr.linesChanged);
                return currScore > prevScore ? curr : prev;
            });
            
            return `CODE_CHANGE: Hero file is likely "${heroFile.path}" (${heroFile.linesChanged} lines). Generate code screenshot.`;
        }
        
        return "MIXED: Multiple file types changed. Let AI decide based on commit message.";
    }

    /**
     * Score file importance (higher = more interesting for screenshot).
     */
    private scoreFileImportance(path: string, linesChanged: number): number {
        let score = linesChanged;
        
        // Boost: Feature files, components, main logic
        if (path.includes('component') || path.includes('feature') || path.includes('page')) {
            score += 50;
        }
        
        // Penalize: Config, test, generated files
        if (path.includes('config') || path.includes('test') || path.includes('spec') || path.includes('generated')) {
            score -= 30;
        }
        
        // Boost: Main entry points
        if (path.includes('index') || path.includes('main') || path.includes('app')) {
            score += 20;
        }
        
        return score;
    }
}
