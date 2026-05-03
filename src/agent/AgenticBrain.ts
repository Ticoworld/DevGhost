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
};

export type BrainResult = 
    | { ok: true; tweet: string }
    | { ok: false; reason: "NO_KEY" | "CLIENT_NOT_READY" | "API_ERROR" | "NO_CONTEXT" | "MODEL_EMPTY_RESPONSE"; message: string };

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
                    message: "This AI key has no available usage left." 
                };
            }
            
            return { ok: false, reason: "API_ERROR", message: `DevGhost could not reach the AI service.` };
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
        const scoreReasons = (ctx.scoreReasons ?? []).slice(0, 8).map((reason) => `- ${reason}`).join('\n') || '(not available)';
        const touchedSymbols = (ctx.touchedSymbols ?? []).slice(0, 10).join(', ') || '(not available)';
        
        return [
            'You are DevGhost, an assistant for developers building in public.',
            'Write ONLY the draft text (max 280 chars). No explanations.',
            'If not worth sharing, respond: NULL',
            '',
            'STRICT STYLE RULES:',
            '- Write like a developer casually explaining what actually happened.',
            '- Be specific. Use plain English. No hype. No fake excitement.',
            '- NO: "excited to announce", "love those moments", "sank into deep work", "hyper-focused".',
            '- NO generic motivational captions or forced hashtags.',
            '- Do not write generic shipping updates.',
            '- Do not copy the commit message shape.',
            '- Do not use weak filler phrases like "spent a bit of time", "some new", "a lot better", "hoping this makes", "big update", "lots of changes", "feels good", "laid out", "updated X logic", or "context features" unless the evidence is specific.',
            '- Do not use hashtags.',
            '- Do not invent emotion.',
            '- Do not say "I hope" unless uncertainty is the actual point.',
            '- Write one concrete issue/fix/result.',
            '- Prefer specific files/functions/signals over vague "logic" or "features".',
            '- If evidence is weak, write a smaller factual draft instead of a broader claim.',
            '- Use lower-case where it feels natural for a dev text.',
            '',
            'STRUCTURE PREFERENCE:',
            '- Line 1: what changed, plainly.',
            '- Line 2: what was wrong or why it mattered.',
            '- Line 3: what works differently now.',
            '- Do not force labels like Problem, Solution, or Result.',
            '',
            'PROJECT BASELINE:',
            baseline,
            '',
            'EVENT: COMMIT_DETECTED',
            `Work Type: ${ctx.workType}`,
            `Focus: ${ctx.focus?.trim() || '(none)'}`,
            `Commit Message (evidence only, do not paraphrase): "${ctx.commitMessage}"`,
            `Score Reasons (context only):`,
            scoreReasons,
            `Touched Symbols/Functions: ${touchedSymbols}`,
            `File Categories: ${ctx.fileCategories || '(not inferred)'}`,
            `Compact Diff Summary: ${ctx.compactDiffSummary || '(not clear from available evidence)'}`,
            `Stats: +${ctx.additions} / -${ctx.deletions} lines`,
            `Session Duration: ${ctx.sessionMinutes} minutes`,
            `Why it matters: ${ctx.whyItMatters || 'why not clear from available evidence'}`,
            `User-facing result: ${ctx.userFacingResult || 'why not clear from available evidence'}`,
            '',
            'Changed Files:',
            fileList || '(none)',
            '',
            ctx.diffStat ? `Diff Stat:\n${ctx.diffStat}\n` : '',
            ctx.terminalFriction ? `Fresh terminal friction:\n${ctx.terminalFriction}\n` : '',
            '',
            'Write the draft (specific, evidence-based, no hype, no hashtag):',
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
