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
            '- Keep it relatable: terminal pain → finally works',
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

    private buildCommitStoryPrompt(baseline: string, ctx: CommitStoryContext): string {
        const fileList = (ctx.changedFiles ?? []).slice(0, 15).map(f => `- ${f}`).join('\n');

        return [
            'Write ONLY the draft text (max 280 chars). No explanations.',
            'If not worth sharing, respond: NULL',
            '',
            'GROUNDING RULES:',
            '- Current project and current commit are the only source of truth.',
            '- Use CURRENT PROJECT only for grounding. You do not have to mention the project name in the post unless it sounds natural.',
            '- Write only about CURRENT PROJECT and CURRENT COMMIT. Never write about DevGhost unless CURRENT PROJECT is DevGhost.',
            '- Background context is optional.',
            '- Background context must never override CURRENT PROJECT or CURRENT COMMIT.',
            '- If background context conflicts with current commit evidence, ignore the background context.',
            '- If background context mentions a different project name, ignore that part.',
            '- Current project and current commit are the source of truth.',
            '- Never copy names, features, or product ideas from examples.',
            '- Never write about the example project.',
            '- Never mention DevGhost unless CURRENT PROJECT is DevGhost.',
            '- Never mention Matterkeep unless CURRENT PROJECT is Matterkeep.',
            '- If examples conflict with current commit evidence, ignore the examples.',
            '- Current commit evidence overrides examples.',
            '- Current commit evidence overrides stale focus.',
            '- Focus is optional context, not truth.',
            '- If focus conflicts with commit evidence, trust the commit.',
            '',
            'CURRENT PROJECT:',
            ctx.projectName,
            'CURRENT COMMIT:',
            ctx.commitMessage,
            '',
            'BACKGROUND CONTEXT, USE ONLY IF CONSISTENT:',
            baseline,
            '',
            'WORK TYPE:',
            ctx.workType,
            '',
            'CHANGED FILES:',
            fileList || '(none)',
            '',
            `COMPACT DIFF: ${ctx.compactDiffSummary || '(not clear from available evidence)'}`,
            `FILE CATEGORIES: ${ctx.fileCategories || '(not inferred)'}`,
            '',
            'WHY THIS MATTERS:',
            ctx.whyItMatters || 'why not clear from available evidence',
            '',
            'USER-FACING RESULT:',
            ctx.userFacingResult || 'why not clear from available evidence',
            '',
            'CURRENT FOCUS (optional):',
            ctx.focus?.trim() || '(none)',
            ctx.focusConflictNote ? `Focus status: ${ctx.focusConflictNote}` : 'Focus status: no conflict detected.',
            '',
            'STYLE RULES:',
            '- Write like a developer sharing a clear progress update.',
            '- Plain, specific, and natural. Not stiff. Not sloppy. Not hype.',
            '- Prefer sentence-case.',
            '- Avoid internal session-summary wording.',
            '- Avoid "this session" unless the time block itself is the story.',
            '- Avoid "wired up" unless it is the most accurate technical phrase.',
            '- Prefer "built", "implemented", "connected", "fixed", "improved", or "made X work" when accurate.',
            '- Match the clarity and plainness of the examples below, not their exact wording.',
            '- One clear delta.',
            '- Before/after contrast when possible.',
            '- One-line payoff.',
            '- Short, natural technical founder/developer tone.',
            '- No forced hashtags.',
            '- No corporate language.',
            '- No generic filler.',
            '- No copying commit messages.',
            '- No file/function names unless they are the punchline.',
            '- Do not list changed files.',
            '- Translate internals into product or user behavior.',
            '- Keep it 2 to 3 short sentences unless the evidence needs less.',
            '- Avoid: spent a bit of time, some new, hoping this makes, feels good, big update, lots of changes, improved X today, it should now be better at, enhanced, optimized, core logic, commit-message-shaped prose.',
            '',
            'NEUTRAL EXAMPLES:',
            'These examples are style examples only. Never copy their project names, product names, features, or subject matter. Use only CURRENT PROJECT and CURRENT COMMIT as factual truth.',
            '1. Built out the main dashboard flow.',
            '',
            'The old screens were still disconnected, so it was hard to see how the admin path worked end to end.',
            '',
            'Now the layout, navigation, and review pages have a real structure to build on.',
            '',
            '2. Fixed a quiet automation issue.',
            '',
            'The watcher was seeing the event, but it was not using it to decide whether the update was worth suggesting.',
            '',
            'Now it checks the signal first, then asks for review before doing anything else.',
            '',
            '3. Tightened the request workflow.',
            '',
            'The old path collected the data, but it did not make the next state clear.',
            '',
            'Now each request has a cleaner path from submission to review.',
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
