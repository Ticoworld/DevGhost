import * as vscode from 'vscode';
import { GeminiService } from '../analyzer/gemini';
import { AgentTools } from './AgentTools';

type ManualIntentContext = {
    baselineSummary: string;
    activeFileName: string;
    uncommittedDiff: string;
    fileStructure?: string[];
};

type FrictionBreakthroughContext = {
    baselineSummary: string;
    failedCommands: string[];
    successCommand: string;
};

type ProjectLaunchContext = {
    baselineSummary: string;
};

type ProjectResumeContext = {
    baselineSummary: string;
    recentCommits: string[];
};

type DeepWorkWrapUpContext = {
    baselineSummary: string;
    top3Diffs: string[];
};

type CommitStoryContext = {
    projectName: string;
    baselineSummary: string;
    commitMessage: string;
    changedFiles: string[];
    additions: number;
    deletions: number;
    workType: string;
    sessionMinutes: number;
    focus?: string;
    diffStat?: string;
    terminalFriction?: string;
    scoreReasons?: string[];
    touchedSymbols?: string[];
    compactDiffSummary?: string;
    fileCategories?: string;
    whyItMatters?: string;
    userFacingResult?: string;
    focusIsPossiblyStale?: boolean;
    focusConflictNote?: string;
};

export type BrainResult = 
    | { ok: true; tweet: string }
    | { ok: false; reason: "NO_KEY" | "CLIENT_NOT_READY" | "API_ERROR" | "NO_CONTEXT" | "MODEL_EMPTY_RESPONSE"; message: string; technicalError?: string };

/**
 * AgenticBrain - Draft orchestrator
 *
 * Phase 3: Proactive state triggers (no passive commit watcher).
 * Produces drafts for:
 * - MANUAL_INTENT (user-requested live update)
 * - FRICTION_BREAKTHROUGH (3+ terminal failures then success)
 * - PROJECT_LAUNCH (first public draft after handshake "No")
 * - PROJECT_RESUME (catch-up draft after handshake "Yes" with recent commits)
 * - DEEP_WORK_WRAP_UP (120+ min active coding, top 3 file diffs)
 */
export class AgenticBrain {
    private hasShownNoKeyNotification = false;

    constructor(
        private gemini: GeminiService,
        _tools: AgentTools
    ) {}

    async process_trigger(
        triggerType: 'MANUAL_INTENT' | 'FRICTION_BREAKTHROUGH' | 'PROJECT_LAUNCH' | 'PROJECT_RESUME' | 'DEEP_WORK_WRAP_UP' | 'COMMIT_DETECTED',
        context: ManualIntentContext | FrictionBreakthroughContext | ProjectLaunchContext | ProjectResumeContext | DeepWorkWrapUpContext | CommitStoryContext
    ): Promise<BrainResult> {
        if (!this.gemini.isInitialized()) {
            if (!this.hasShownNoKeyNotification) {
                this.hasShownNoKeyNotification = true;
                const selection = await vscode.window.showWarningMessage(
                    'DevGhost needs an AI key to draft updates.',
                    'Add AI key',
                    'Not now'
                );
                if (selection === 'Add AI key') {
                    vscode.commands.executeCommand('devghost.setApiKey');
                }
            }
            return { ok: false, reason: "NO_KEY", message: "DevGhost needs an AI key to draft updates." };
        }

        const baseline = (context.baselineSummary || '').trim();
        if (!baseline) {
            return { ok: false, reason: "NO_CONTEXT", message: "No project context is set up yet." };
        }

        let prompt: string;
        if (triggerType === 'MANUAL_INTENT') {
            prompt = this.buildManualIntentPrompt(baseline, context as ManualIntentContext);
        } else if (triggerType === 'FRICTION_BREAKTHROUGH') {
            prompt = this.buildFrictionBreakthroughPrompt(baseline, context as FrictionBreakthroughContext);
        } else if (triggerType === 'PROJECT_LAUNCH') {
            prompt = this.buildProjectLaunchPrompt(baseline);
        } else if (triggerType === 'PROJECT_RESUME') {
            prompt = this.buildProjectResumePrompt(baseline, context as ProjectResumeContext);
        } else if (triggerType === 'DEEP_WORK_WRAP_UP') {
            prompt = this.buildDeepWorkWrapUpPrompt(baseline, context as DeepWorkWrapUpContext);
        } else {
            prompt = this.buildCommitStoryPrompt(baseline, context as CommitStoryContext);
        }

        try {
            const raw = (await this.gemini.draftFromPrompt(prompt, `agentic:${triggerType}`))?.trim() || '';
            if (!raw || raw.toUpperCase() === 'NULL') {
                return { ok: false, reason: "MODEL_EMPTY_RESPONSE", message: "AI decided this session is not worth a draft." };
            }
            const tweet = this.cleanTweetOutput(raw, {
                allowHashtags: triggerType !== 'COMMIT_DETECTED',
                strictCommitStyle: triggerType === 'COMMIT_DETECTED',
            });
            return tweet ? { ok: true, tweet } : { ok: false, reason: "MODEL_EMPTY_RESPONSE", message: "AI returned an empty or invalid draft." };
        } catch (error: any) {
            const errMsg = error?.message || String(error);
            console.error('[DevGhost] Draft generation error:', error);
            
            // Handle Quota/Rate Limit (429) specifically
            if (errMsg.includes('429') || errMsg.toLowerCase().includes('quota exceeded')) {
                return { 
                    ok: false, 
                    reason: "API_ERROR", 
                    message: "This AI key has no available usage left.",
                    technicalError: errMsg,
                };
            }
            
            return { ok: false, reason: "API_ERROR", message: `DevGhost could not reach the AI service.`, technicalError: errMsg };
        }
    }

    private buildManualIntentPrompt(baseline: string, ctx: ManualIntentContext): string {
        const diff =
            ctx.uncommittedDiff.length > 12000
                ? ctx.uncommittedDiff.slice(0, 12000) + '\n... (truncated)'
                : ctx.uncommittedDiff;

        const structureBlurb =
            (ctx.fileStructure?.length ?? 0) > 0
                ? `File structure (functions/classes/interfaces): ${ctx.fileStructure!.join(', ')}`
                : 'File structure: (unavailable)';

        return [
            'You are DevGhost, an assistant that helps developers build in public.',
            'Write ONLY the draft text (no title, no explanation).',
            'If this is not worth sharing, respond with exactly: NULL',
            '',
            'CONSTRAINTS:',
            '- Under 280 characters',
            '- No code blocks',
            "- Don't paste diff content",
            '- Sound human (mid-session), not a product announcement',
            '- Include #BuildInPublic',
            '',
            'PROJECT BASELINE:',
            baseline,
            '',
            'EVENT: MANUAL_INTENT (user requested a live progress update)',
            `Active file: ${ctx.activeFileName}`,
            structureBlurb,
            '',
            'Uncommitted diff (git diff HEAD, may be truncated):',
            diff,
            '',
            'Write the draft:',
        ].join('\n');
    }

    private buildFrictionBreakthroughPrompt(baseline: string, ctx: FrictionBreakthroughContext): string {
        const failed = ctx.failedCommands.slice(-10).map((c) => `- ${c}`).join('\n') || '(none)';

        return [
            'You are DevGhost, an assistant that helps developers build in public.',
            'Write ONLY the draft text (no title, no explanation).',
            'If this is not worth sharing, respond with exactly: NULL',
            '',
            'CONSTRAINTS:',
            '- Under 280 characters',
            "- Don't use exact counts like \"3 failures\"",
            '- Keep it relatable: terminal pain -> finally works',
            '- Include #BuildInPublic or #DevLife',
            '',
            'PROJECT BASELINE:',
            baseline,
            '',
            'EVENT: FRICTION_BREAKTHROUGH (3+ terminal failures then a success)',
            'Failed commands (sequential non-zero exit codes):',
            failed,
            '',
            `Successful command (exit 0): ${ctx.successCommand}`,
            '',
            'Write the draft:',
        ].join('\n');
    }

    private buildProjectLaunchPrompt(baseline: string): string {
        return [
            'You are DevGhost, an assistant that helps developers build in public.',
            'Write ONLY the draft text (no title, no explanation).',
            'If this is not worth sharing, respond with exactly: NULL',
            '',
            'CONSTRAINTS:',
            '- Under 280 characters',
            '- No code blocks',
            '- Sound like a human dev sharing their first public draft about this project (#BuildInPublic)',
            '',
            'PROJECT BASELINE (Day One):',
            baseline,
            '',
            'EVENT: PROJECT_LAUNCH (developer is preparing a first public draft about this project)',
            '',
            'Write the draft:',
        ].join('\n');
    }

    private buildProjectResumePrompt(baseline: string, ctx: ProjectResumeContext): string {
        const commits = ctx.recentCommits?.length
            ? ctx.recentCommits.map((c) => `- ${c}`).join('\n')
            : '(no recent commits)';
        return [
            'You are DevGhost, an assistant that helps developers build in public.',
            'Write ONLY the draft text (no title, no explanation).',
            'If this is not worth sharing, respond with exactly: NULL',
            '',
            'CONSTRAINTS:',
            '- Under 280 characters',
            '- No code blocks',
            '- Sound like a dev catching their audience up after time away (#BuildInPublic)',
            '',
            'PROJECT BASELINE:',
            baseline,
            '',
            'EVENT: PROJECT_RESUME (developer has shared before; catching up with recent work)',
            'Last 5 commits (lastMilestone context):',
            commits,
            '',
            'Write the draft:',
        ].join('\n');
    }

    private buildDeepWorkWrapUpPrompt(baseline: string, ctx: DeepWorkWrapUpContext): string {
        const diffsBlob = (ctx.top3Diffs ?? []).join('\n\n');
        const truncated = diffsBlob.length > 15000 ? diffsBlob.slice(0, 15000) + '\n... (truncated)' : diffsBlob;
        return [
            'You are DevGhost, an assistant that helps developers build in public.',
            'Write ONLY the draft text (no title, no explanation).',
            'If this is not worth sharing, respond with exactly: NULL',
            '',
            'CONSTRAINTS:',
            '- Under 280 characters',
            '- No code blocks',
            '- Summarize the coding session at a high level (what areas were worked on, what kind of progress)',
            '- Include #BuildInPublic or #DevLife',
            '',
            'PROJECT BASELINE:',
            baseline,
            '',
            'EVENT: DEEP_WORK_WRAP_UP (developer just completed a long focused session; below are the top 3 most-modified files and their diffs)',
            '',
            'Top 3 file diffs (git diff HEAD):',
            truncated || '(no diffs)',
            '',
            'Write the draft:',
        ].join('\n');
    }

    private stripCommitPrefix(text: string): string {
        return (text || '')
            .trim()
            .replace(/^[a-z]+(?:\([^)]+\))?:\s*/i, '')
            .trim();
    }

    private simplifyCommitLanguage(text: string): string {
        const source = this.stripCommitPrefix(text);
        if (!source) return source;

        const replacements: Array<[RegExp, string | ((match: string) => string)]> = [
            [/\bimplemented?\b/gi, 'built'],
            [/\binitialize(?:d|s|ing)?\b/gi, 'set up'],
            [/\benhance(?:d|s|ing)?\b/gi, 'improve'],
            [/\bconfiguration\b/gi, 'setup'],
            [/\bcomponents?\b/gi, (match: string) => (match.toLowerCase().endsWith('s') ? 'parts' : 'part')],
        ];

        let simplified = source;
        for (const [pattern, replacement] of replacements) {
            simplified = simplified.replace(pattern, (match) => typeof replacement === 'function' ? replacement(match) : replacement);
        }

        return simplified.replace(/\s{2,}/g, ' ').trim();
    }

    private summarizeFactPacketBefore(ctx: CommitStoryContext): string {
        const commitBlob = this.simplifyCommitLanguage(ctx.commitMessage).toLowerCase();
        const fileBlob = (ctx.changedFiles ?? []).join(' ').toLowerCase();
        const combined = `${commitBlob} ${fileBlob}`;

        if (/(layout|header|footer|home page|homepage|page|pages|public)/.test(combined)) {
            return 'the public layout pieces were still missing or disconnected';
        }

        if (/(fix|fixed|bug|error|broken|repair|resolve)/.test(commitBlob)) {
            return 'the old behavior was still broken';
        }

        if (/(refactor|rewrite|rework|reorganize)/.test(commitBlob)) {
            return 'the old path was still awkward to follow';
        }

        if (/(setup|set up|start|start up|bootstrap|scaffold)/.test(commitBlob)) {
            return 'the project was still missing this piece';
        }

        if (ctx.workType === 'feature') {
            return 'the feature was still taking shape';
        }

        return 'not clear from available evidence';
    }

    private summarizeFactPacketNow(ctx: CommitStoryContext): string {
        const commitBlob = this.simplifyCommitLanguage(ctx.commitMessage).toLowerCase();
        const fileBlob = (ctx.changedFiles ?? []).join(' ').toLowerCase();
        const combined = `${commitBlob} ${fileBlob}`;

        if (/(layout|header|footer|home page|homepage|page|pages|public)/.test(combined)) {
            return 'the basic public layout is in place now';
        }

        if (/(fix|fixed|bug|error|broken|repair|resolve)/.test(commitBlob)) {
            return 'the issue is fixed now';
        }

        if (/(refactor|rewrite|rework|reorganize)/.test(commitBlob)) {
            return 'the path is easier to follow now';
        }

        if (/(setup|set up|start|start up|bootstrap|scaffold)/.test(commitBlob)) {
            return 'the base is ready for the next step';
        }

        if (ctx.workType === 'feature') {
            return 'the feature is in place now';
        }

        return 'the change is in place now';
    }

    private summarizeFactPacketStillEarly(ctx: CommitStoryContext): string {
        const commitBlob = this.simplifyCommitLanguage(ctx.commitMessage).toLowerCase();
        const fileBlob = (ctx.changedFiles ?? []).join(' ').toLowerCase();
        const combined = `${commitBlob} ${fileBlob}`;

        if (/(layout|header|footer|home page|homepage|page|pages|public)/.test(combined)) {
            return 'the rest of the public pages are still ahead';
        }

        if (ctx.workType === 'feature') {
            return 'the broader flow may still be rough in spots';
        }

        return 'not clear from available evidence';
    }

    private summarizeFactPacketEvidence(ctx: CommitStoryContext): string {
        const fileCount = ctx.changedFiles?.length ?? 0;
        const diffSummary = ctx.compactDiffSummary?.trim() || '';
        const compact = diffSummary.replace(/;\s*top files: .*$/i, '').trim();

        if (compact) {
            return compact;
        }

        if (fileCount > 0) {
            return `+${ctx.additions} / -${ctx.deletions} across ${fileCount} files`;
        }

        return 'current commit and changed files';
    }

    private buildCommitFactPacket(ctx: CommitStoryContext): string[] {
        return [
            `- Project: ${ctx.projectName || '(unknown)'}`,
            `- Change: ${this.simplifyCommitLanguage(ctx.commitMessage) || 'not clear from available evidence'}`,
            `- Before: ${this.summarizeFactPacketBefore(ctx)}`,
            `- Now: ${this.summarizeFactPacketNow(ctx)}`,
            `- Still early: ${this.summarizeFactPacketStillEarly(ctx)}`,
            `- Useful evidence: ${this.summarizeFactPacketEvidence(ctx)}`,
        ];
    }

    private buildCommitStoryPrompt(baseline: string, ctx: CommitStoryContext): string {
        return [
            'Write ONLY the final draft text (max 280 chars). No explanations.',
            'If not worth sharing, respond: NULL',
            '',
            'GROUNDING RULES:',
            '- Current project and current commit are the only source of truth.',
            '- Project is grounding only. The post does not need to mention it.',
            '- Current commit and changed files are truth.',
            '- Baseline is background only.',
            '- If any context conflicts, trust the commit and changed files.',
            '- Current commit evidence overrides stale focus.',
            '- Focus is optional context, not truth.',
            '- Never write about DevGhost unless CURRENT PROJECT is DevGhost.',
            '- Never mention Matterkeep unless CURRENT PROJECT is Matterkeep.',
            '- Never copy names, features, or product ideas from examples.',
            '- Never write about the example project.',
            '- If examples conflict with current commit evidence, ignore the examples.',
            '- Current commit evidence overrides examples.',
            '',
            'FACT PACKET:',
            ...this.buildCommitFactPacket(ctx),
            '',
            'BACKGROUND ONLY:',
            baseline,
            '',
            'WRITE THE FINAL DRAFT LIKE A SHORT NOTE FROM A DEVELOPER TALKING OVER COFFEE.',
            'Rules:',
            '- 2 short sentences, 3 only if needed.',
            '- Simple English.',
            '- No status-report tone.',
            '- No changelog tone.',
            '- No launch or announcement tone.',
            '- No manager update tone.',
            '- No corporate wording.',
            '- No forced excitement.',
            '- No hashtags for commit drafts.',
            '- No file list unless one file or function is the punchline.',
            '- Do not copy the commit message.',
            '- Do not use report words like implemented, initialized, enhanced, optimized, foundation, groundwork, solid shell, or setup complete.',
            '- Prefer: got X working, added X, fixed X, now X works, now X is in place, the page, flow, or app finally has X.',
            '- Output only the final draft.',
            '',
            'NEUTRAL EXAMPLES:',
            'These examples are style only. Never copy their project, feature, or subject matter.',
            '1. Got the first public layout working.',
            '',
            "Header, footer, and the home page structure are in place now, so the rest of the site won't feel like loose pieces.",
            '',
            '2. Fixed a quiet watcher bug.',
            '',
            'It was seeing the event, but not using it to decide whether a draft was worth showing. Now it checks the signal first.',
            '',
            '3. Got the request flow into better shape.',
            '',
            'The old path collected the data, but the next step was still fuzzy. Now each request has a clearer path from submit to review.',
            '',
            'FINAL OUTPUT INSTRUCTION:',
            'Write the draft now.',
        ].join('\n');
    }

    private cleanTweetOutput(text: string, options?: { allowHashtags?: boolean; strictCommitStyle?: boolean }): string | null {
        const finalText = (text || '').trim();
        if (!finalText) return null;
        if (finalText.toUpperCase() === 'NULL') return null;

        const codeBlockMatch = finalText.match(/```(?:text|tweet)?\s*\n?([\s\S]*?)\n?```/);
        let cleaned = codeBlockMatch?.[1]?.trim() || finalText;

        // Strip AI-ish headers
        const wrapperPatterns = [
            /^(?:tweet|draft|output):\s*/i,
            /^here(?:'|\u2019)?s a draft:\s*/i,
            /^here is a draft:\s*/i,
            /^here(?:'|\u2019)?s my draft:\s*/i,
            /^here is my draft:\s*/i,
            /^suggested draft:\s*/i,
        ];

        for (const pattern of wrapperPatterns) {
            cleaned = cleaned.replace(pattern, '').trim();
        }

        cleaned = cleaned.replace(/%23/g, '#').replace(/%20/g, ' ').trim();
        
        // Strip common AI-ish hype phrases
        const hypePhrases = [
            /excited to announce/i,
            /love those moments/i,
            /hyper-focused moments/i,
            /sank into deep work/i,
            /love those hyper-focused moments/i
        ];
        
        for (const phrase of hypePhrases) {
            cleaned = cleaned.replace(phrase, '').trim();
        }

        if (options?.strictCommitStyle) {
            const commitPhrases = [
                /just shipped/i,
                /just pushed/i,
                /big update/i,
                /lots of changes/i,
                /feels good/i,
                /laid out/i
            ];

            for (const phrase of commitPhrases) {
                cleaned = cleaned.replace(phrase, '').trim();
            }
        }

        if (options?.allowHashtags === false) {
            cleaned = cleaned
                .replace(/(^|\s)#[A-Za-z][A-Za-z0-9_-]*/g, '$1')
                .replace(/\s{2,}/g, ' ')
                .trim();
        }

        if (cleaned.length < 10) return null;
        if (cleaned.length > 280) cleaned = cleaned.slice(0, 277).trimEnd() + '...';
        return cleaned;
    }
}
