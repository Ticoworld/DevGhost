import * as vscode from 'vscode';
import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { PromptBuilder, BreakthroughContext } from './promptBuilder';
import { sanitizeGeminiPayload, SanitizationResult } from './aiSanitizer';

/**
 * Project context for intelligent draft generation.
 */
export interface ProjectContext {
    projectName: string;
    mission?: string;
    currentFocus?: string;
    tone: 'raw' | 'professional' | 'funny' | 'technical';
}

/**
 * GeminiService - Draft generation service (Phase 5 Upgrade)
 * 
 * Now with context-aware draft generation:
 * - generateWinPost: For bug fixes and breakthroughs
 * - generatePivotPost: For major refactors
 * - generateDeepWorkPost: For long coding sessions
 */
export class GeminiService {
    private genAI: GoogleGenerativeAI | null = null;
    private model: GenerativeModel | null = null;
    private apiKey: string | null = null;
    private availableModels: string[] = [];
    private resolvedModel: string | null = null;
    private lastDiscoveryTime: number = 0;
    private sanitizationReporter:
        | ((event: {
              label: string;
              redactedSensitiveLines: number;
              removedSensitiveFiles: number;
              shortenedPaths: number;
              truncated: boolean;
          }) => void)
        | null = null;
    
    private fallbackReporter:
        | ((event: {
              kind: 'win' | 'pivot' | 'deepWork' | 'grind' | 'intent';
              reason: 'UNINITIALIZED' | 'ERROR';
              errorMessage?: string;
          }) => void)
        | null = null;

    /**
     * Optional hook to report when we fall back to the generic draft.
     * This lets the extension log the real reason (missing init vs API error).
     */
    setFallbackReporter(
        reporter: (event: {
            kind: 'win' | 'pivot' | 'deepWork' | 'grind' | 'intent';
            reason: 'UNINITIALIZED' | 'ERROR';
            errorMessage?: string;
        }) => void
    ): void {
        this.fallbackReporter = reporter;
    }

    setSanitizationReporter(
        reporter: (event: {
            label: string;
            redactedSensitiveLines: number;
            removedSensitiveFiles: number;
            shortenedPaths: number;
            truncated: boolean;
        }) => void
    ): void {
        this.sanitizationReporter = reporter;
    }

    private reportFallback(
        kind: 'win' | 'pivot' | 'deepWork' | 'grind' | 'intent',
        reason: 'UNINITIALIZED' | 'ERROR',
        error?: unknown
    ): void {
        if (!this.fallbackReporter) return;
        const errorMessage = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
        this.fallbackReporter({ kind, reason, errorMessage });
    }

    /**
     * Get the model name from settings.
     */
    public getModelName(): string {
        const model = vscode.workspace.getConfiguration('devghost').get<string>('model', 'auto');
        return (model || 'auto').trim();
    }

    private isAutoModel(modelName: string): boolean {
        return modelName.trim().toLowerCase() === 'auto';
    }

    private isModelUnavailableError(error: unknown): boolean {
        const errMsg = error instanceof Error ? error.message : String(error);
        return /404|401|model not found|not available|not found|invalid model|permission denied/i.test(errMsg);
    }

    private reportSanitized(label: string, result: SanitizationResult): void {
        if (!this.sanitizationReporter || !result.changed) {
            return;
        }

        this.sanitizationReporter({
            label,
            redactedSensitiveLines: result.redactedSensitiveLines,
            removedSensitiveFiles: result.removedSensitiveFiles,
            shortenedPaths: result.shortenedPaths,
            truncated: result.truncated,
        });
    }

    /**
     * Discover models that support generateContent.
     */
    public async discoverModels(apiKey: string): Promise<string[]> {
        this.apiKey = apiKey;
        return new Promise((resolve) => {
            const https = require('https');
            const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
            
            https.get(url, (res: any) => {
                let data = '';
                res.on('data', (chunk: any) => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.models && Array.isArray(json.models)) {
                            this.availableModels = json.models
                                .filter((m: any) => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
                                .map((m: any) => m.name.replace('models/', ''));
                            this.lastDiscoveryTime = Date.now();
                            resolve(this.availableModels);
                        } else {
                            resolve([]);
                        }
                    } catch {
                        resolve([]);
                    }
                });
            }).on('error', () => {
                resolve([]);
            });
        });
    }

    /**
     * Resolve the best model to use based on discovery and user preference.
     */
    public async resolveBestModel(forceRefresh: boolean = false, excludeModel?: string): Promise<string> {
        if (this.resolvedModel && !forceRefresh) return this.resolvedModel;
        
        if (!this.apiKey) {
            const configured = this.getModelName();
            this.resolvedModel = this.isAutoModel(configured) ? 'gemini-2.0-flash' : configured;
            return this.resolvedModel;
        }

        if (forceRefresh || this.availableModels.length === 0 || (Date.now() - this.lastDiscoveryTime > 3600000)) {
            await this.discoverModels(this.apiKey);
        }

        const configured = this.getModelName();
        const available = excludeModel
            ? this.availableModels.filter((model) => model !== excludeModel)
            : [...this.availableModels];
        
        // 1. If user specified a model and it's available, use it
        if (!this.isAutoModel(configured) && available.includes(configured)) {
            this.resolvedModel = configured;
            return configured;
        }

        // 2. Preference order
        const preferences = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];
        for (const pref of preferences) {
            if (available.includes(pref)) {
                this.resolvedModel = pref;
                return pref;
            }
        }

        // 3. First available 'flash' model
        const flashModel = available.find(m => m.toLowerCase().includes('flash'));
        if (flashModel) {
            this.resolvedModel = flashModel;
            return flashModel;
        }

        // 4. First available model
        if (available.length > 0) {
            this.resolvedModel = available[0];
            return available[0];
        }

        // 5. Hard fallback
        if (this.apiKey) {
            // Note: We use console.log here as a placeholder for internal logging if needed, 
            // but the extension should ideally handle the output channel.
            // However, the requirement is to log clearly when discovery returns 0.
        }
        this.resolvedModel = this.isAutoModel(configured) ? 'gemini-2.0-flash' : configured;
        return this.resolvedModel;
    }

    private async createModel(forceRefresh: boolean = false, excludeModel?: string): Promise<GenerativeModel | null> {
        if (!this.genAI) return null;

        const modelName = await this.resolveBestModel(forceRefresh, excludeModel);
        this.model = this.genAI.getGenerativeModel({
            model: modelName,
            systemInstruction: PromptBuilder.getSystemInstruction(),
        });
        return this.model;
    }

    public async draftFromPrompt(prompt: string, label: string): Promise<string | null> {
        if (!this.genAI) return null;

        const sanitized = sanitizeGeminiPayload(prompt);
        this.reportSanitized(label, sanitized);

        const currentModel = this.model || (await this.createModel(false));
        if (!currentModel) return null;
        const failedModelName = this.resolvedModel || await this.resolveBestModel(false);

        try {
            const result = await currentModel.generateContent(sanitized.text);
            return result.response.text().trim();
        } catch (error) {
            if (!this.isModelUnavailableError(error)) {
                throw error;
            }

            const retryModelName = await this.resolveBestModel(true, failedModelName || undefined);
            if (!retryModelName || retryModelName === failedModelName) {
                throw new Error('No compatible AI model is available for this key.');
            }

            const retryModel = this.genAI.getGenerativeModel({
                model: retryModelName,
                systemInstruction: PromptBuilder.getSystemInstruction(),
            });
            this.model = retryModel;
            this.resolvedModel = retryModelName;

            try {
                const retryResult = await retryModel.generateContent(sanitized.text);
                return retryResult.response.text().trim();
            } catch (retryError) {
                throw retryError;
            }
        }
    }

    /**
     * Initialize the Gemini client with an API key.
     */
    async initialize(apiKey: string): Promise<void> {
        this.apiKey = apiKey;
        this.availableModels = [];
        this.resolvedModel = null;
        this.lastDiscoveryTime = 0;
        this.genAI = new GoogleGenerativeAI(apiKey);

        await this.createModel(true);
    }

    /**
     * Clear the in-memory AI client and cached model discovery.
     */
    clear(): void {
        this.genAI = null;
        this.model = null;
        this.apiKey = null;
        this.availableModels = [];
        this.resolvedModel = null;
        this.lastDiscoveryTime = 0;
    }

    /**
     * Get the count of discovered models.
     */
    public getDiscoveredModelsCount(): number {
        return this.availableModels.length;
    }

    /**
     * Test the API key with a minimal request.
     * Returns true if valid, or throws an error with the provider message.
     */
    async validateKey(): Promise<boolean> {
        const resolvedModel = await this.resolveBestModel(true);
        return this.validateModel(resolvedModel, true);
    }

    /**
     * Validate a specific model ID.
     */
    async validateModel(modelId: string, allowRetry: boolean = true): Promise<boolean> {
        if (!this.genAI) {
            throw new Error('AI client not initialized.');
        }
        try {
            const validationPrompt = sanitizeGeminiPayload('Reply with OK only.');
            const model = this.genAI.getGenerativeModel({
                model: modelId,
            });
            const result = await model.generateContent(validationPrompt.text);
            const text = result.response.text();
            return !!text;
        } catch (error) {
            if (allowRetry && this.isModelUnavailableError(error)) {
                const retryModelId = await this.resolveBestModel(true, modelId);
                if (retryModelId !== modelId) {
                    return this.validateModel(retryModelId, false);
                }
                throw new Error('No compatible AI model is available for this key.');
            }
            throw error;
        }
    }

    /**
     * Check if the service is initialized.
     */
    isInitialized(): boolean {
        return this.model !== null;
    }

    /**
     * Phase 2: Generate a project baseline / stack summary from a raw scan.
     * Returns null if uninitialized or on API error.
     */
    async generateBaselineFromScan(prompt: string): Promise<string | null> {
        if (!this.genAI) {
            return null;
        }
        try {
            const raw = await this.draftFromPrompt(prompt, 'project baseline');
            return raw && raw.trim().length > 0 ? raw.trim() : null;
        } catch {
            return null;
        }
    }

    /**
     * Get a model instance configured for chat/tools.
     * Used by the draft engine.
     */
    async getChatModel(tools?: any[], overrideModel?: string): Promise<GenerativeModel | null> {
        if (!this.genAI) return null;
        
        const modelName = overrideModel || (await this.resolveBestModel());
        
        return this.genAI.getGenerativeModel({
            model: modelName,
            systemInstruction: PromptBuilder.getSystemInstruction(),
            tools: tools ? [{ functionDeclarations: tools }] : undefined
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // PHASE 5: Context-Aware Draft Generation
    // ═══════════════════════════════════════════════════════════════

    /**
     * Generate a win draft after fixing a bug.
     * Tone: Relieved, exhausted, victorious.
     */
    async generateWinPost(
        context: ProjectContext,
        duration: string,
        command: string,
        failureCount: number
    ): Promise<string | null> {
        if (!this.genAI) {
            this.reportFallback('win', 'UNINITIALIZED');
            return null;
        }

        const toneGuide = this.getToneGuide(context.tone);
        
        const prompt = `
Write a short build-in-public draft (under 280 chars) for X.

RAW DATA (use for context, NOT for output):
- Project: ${context.projectName}
- What was fixed: ${command}
- Struggle duration (minutes): ${duration}
- Failed attempts: ${failureCount}

CRITICAL: NEVER echo exact numbers. Use human time ("an hour" not "61 mins"). Use "a few" not "3". Write like a developer casually explaining what happened.

TONE: ${toneGuide}

RULES:
- Be specific and authentic
- Briefly mention the struggle without drama
- Focus on the technical reality
- Under 280 characters!

Write the draft:`;

        try {
            const raw = await this.draftFromPrompt(prompt, 'win draft');
            return raw ? this.cleanTweet(raw) : null;
        } catch (error) {
            this.reportFallback('win', 'ERROR', error);
            return null;
        }
    }

    /**
     * Generate a pivot draft after major refactoring.
     * Tone: Bold, decisive, maybe scary.
     */
    async generatePivotPost(
        context: ProjectContext,
        stats: { additions: number; deletions: number; filesChanged: number },
        commitMessage: string
    ): Promise<string | null> {
        if (!this.genAI) {
            this.reportFallback('pivot', 'UNINITIALIZED');
            return null;
        }

        const toneGuide = this.getToneGuide(context.tone);
        
        const prompt = `
Write a build-in-public draft (under 280 chars) about a project pivot or refactor.

RAW DATA (use for context, NOT for output):
- Project: ${context.projectName}
- Commit message: "${commitMessage}"
- Lines deleted: ${stats.deletions}
- Lines added: ${stats.additions}
- Files changed: ${stats.filesChanged}

CRITICAL: Don't echo exact line counts. Use "a bunch of", "a lot of", "hundreds of" - sound human. Write like a dev explaining a structural change.

TONE: ${toneGuide}
This is a technical transition - moving from old code to new.

RULES:
- Explain the "why" briefly if possible
- Acknowledge the scope of changes
- No hype or over-excitement
- Under 280 characters!

Write the draft:`;

        try {
            const raw = await this.draftFromPrompt(prompt, 'pivot draft');
            return raw ? this.cleanTweet(raw) : null;
        } catch (error) {
            this.reportFallback('pivot', 'ERROR', error);
            return null;
        }
    }

    /**
     * Generate a deep work draft after a long coding session.
     * Tone: Focused, productive, satisfied.
     */
    async generateDeepWorkPost(
        context: ProjectContext,
        sessionMinutes: number,
        commitMessage: string
    ): Promise<string | null> {
        if (!this.genAI) {
            this.reportFallback('deepWork', 'UNINITIALIZED');
            return null;
        }

        const toneGuide = this.getToneGuide(context.tone);
        
        const prompt = `
Write a build-in-public draft (under 280 chars) about a coding session.

RAW DATA (use for context, NOT for output):
- Project: ${context.projectName}
- Session duration (minutes): ${sessionMinutes}
- What was built: "${commitMessage}"

CRITICAL: NEVER use exact minutes. Use human time: "an hour", "a few hours", "all day". Write like a developer sharing progress.

TONE: ${toneGuide}

RULES:
- Be specific about what was worked on
- Mention time in human terms
- No motivational hype
- Under 280 characters!

Write the draft:`;

        try {
            const raw = await this.draftFromPrompt(prompt, 'deep work draft');
            return raw ? this.cleanTweet(raw) : null;
        } catch (error) {
            this.reportFallback('deepWork', 'ERROR', error);
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // Legacy Method (for backwards compatibility)
    // ═══════════════════════════════════════════════════════════════

    /**
     * Generate a draft for a breakthrough event.
     */
    async generateBreakthroughTweet(context: BreakthroughContext): Promise<string> {
        if (!this.genAI) {
            throw new Error('GeminiService not initialized. Set API key first.');
        }

        const prompt = PromptBuilder.buildBreakthroughPrompt(context);

        try {
            const raw = await this.draftFromPrompt(prompt, 'breakthrough draft');
            return raw ? this.cleanTweet(raw) : '';
        } catch (error) {
            throw new Error('DevGhost could not reach the AI service.');
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // PHASE 7: Recent Work & Warm-up Drafts
    // ═══════════════════════════════════════════════════════════════

    /**
     * Generate a recent-work draft for mid-session updates.
     * Used by Silence Breaker when user is deep in the struggle.
     */
    async generateGrindPost(
        context: ProjectContext,
        durationMinutes: number,
        strugglesCount: number,
        struggles: string[]
    ): Promise<string | null> {
        if (!this.genAI) {
            this.reportFallback('grind', 'UNINITIALIZED');
            return null;
        }

        const toneGuide = this.getToneGuide(context.tone);
        const struggleList = struggles.slice(0, 3).join(', ') || 'various challenges';
        
        const prompt = `
Write a short build-in-public draft (under 280 chars) for X.

RAW DATA (use for context, NOT for output):
- Project: ${context.projectName}
- Focus: ${context.currentFocus || 'Working on the project'}
- Session duration (minutes): ${durationMinutes}
- Struggles: ${struggleList}
- Failure count: ${strugglesCount}

CRITICAL: NEVER use exact minutes ("61 mins", "1218 minutes"). Use human time: "an hour", "a few hours", "all day". NEVER say "1 things" or "3 errors" - use "a bug", "a few issues". Sound casual.

SITUATION: The developer is in the middle of a work session. No commits yet. They're fighting through issues.

TONE: ${toneGuide}

RULES:
- Show the raw struggle (no fake positivity)
- Make other devs relate
- It's okay to not have a win yet
- Include #BuildInPublic or #DevLife
- Under 280 characters!

Write the draft:`;

        try {
            const raw = await this.draftFromPrompt(prompt, 'grind draft');
            return raw ? this.cleanTweet(raw) : null;
        } catch (error) {
            this.reportFallback('grind', 'ERROR', error);
            return null;
        }
    }

    /**
     * Generate a focus draft when user sets focus (start of journey).
     * Used by the focus prompt.
     */
    async generateIntentTweet(context: ProjectContext, focus: string): Promise<string | null> {
        if (!this.genAI) {
            this.reportFallback('intent', 'UNINITIALIZED');
            return null;
        }

        const prompt = `
Write a short build-in-public draft (under 280 chars) for X.

RAW DATA:
- Project: ${context.projectName}
- User's intent/focus: "${focus}"

SITUATION: The developer just set their focus. They're about to start working. This is a start-of-journey draft - announcing intent, not a win.

TONE: Casual, determined. Like texting a friend "about to do the thing."

RULES:
- Sound like "about to dive in" not "I will now commence"
- No corporate language
- Include #BuildInPublic
- Under 280 characters!

Write the draft:`;

        try {
            const raw = await this.draftFromPrompt(prompt, 'focus draft');
            return raw ? this.cleanTweet(raw) : null;
        } catch (error) {
            this.reportFallback('intent', 'ERROR', error);
            return null;
        }
    }

    /**
     * Generate a warm-up summary for "Previously on" context.
     * Used when user returns after a long break.
     */
    async generateWarmupSummary(
        projectName: string,
        history: string
    ): Promise<string> {
        if (!this.genAI) {
            return 'Welcome back! Check the logs for your recent history.';
        }

        const prompt = `
Summarize these DevGhost events into a one-sentence "Previously on" recap for the developer.
Make it conversational and brief.

PROJECT: ${projectName}

RECENT HISTORY:
${history}

Write ONE sentence (under 100 chars) that reminds the developer where they left off:`;

        try {
            const raw = await this.draftFromPrompt(prompt, 'warmup summary');
            return raw ? raw.trim().replace(/^["']|["']$/g, '') : 'Welcome back! Ready to continue your journey.';
        } catch (error) {
            return 'Welcome back! Ready to continue your journey.';
        }
    }

    /**
     * Generate a return-to-work draft for the welcome popup.
     * Used when user clicks "Review where I left off?" after coming back.
     * Tone: Back at it, picking up where I left off, no fake hype.
     */
    async generateReturningTweet(
        projectName: string,
        warmupSummary: string,
        currentFocus?: string
    ): Promise<string | null> {
        if (!this.genAI) {
            this.reportFallback('intent', 'UNINITIALIZED');
            return null;
        }

        const focusLine = currentFocus ? `- Current focus: "${currentFocus}"` : '';

        const prompt = `
Write a short build-in-public draft (under 280 chars) for X.

RAW DATA:
- Project: ${projectName}
- Where they left off (summary): "${warmupSummary}"
${focusLine}

SITUATION: The developer just opened the project again after a break. They're sharing that they're back and what they're picking up. This is a return-to-work draft - casual check-in, not a win or a launch.

TONE: Casual, real. Like "back at it" or "picking up where I left off." No hype, no "excited to announce."

RULES:
- Sound like someone sitting down to code again, not a product launch
- No "excited", "thrilled", "finally"
- Include #BuildInPublic
- Under 280 characters!

Write the draft:`;

        try {
            const raw = await this.draftFromPrompt(prompt, 'returning draft');
            return raw ? this.cleanTweet(raw) : null;
        } catch (error) {
            this.reportFallback('intent', 'ERROR', error);
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════════════

    /**
     * Get tone guidance for the AI.
     */
    private getToneGuide(tone: string): string {
        switch (tone) {
            case 'raw':
                return 'Raw and unfiltered. Like texting a dev friend at 2am.';
            case 'professional':
                return 'Professional but human. LinkedIn-friendly without being boring.';
            case 'funny':
                return 'Self-deprecating humor. Laugh at the chaos of coding.';
            case 'technical':
                return 'Technical and detailed. Devs will appreciate the specifics.';
            default:
                return 'Authentic and relatable. A real developer sharing their journey.';
        }
    }

    /**
     * Clean up the generated draft.
     */
    private cleanTweet(text: string, options?: { allowHashtags?: boolean }): string {
        let cleaned = text.trim();
        
        // Remove surrounding quotes if present
        if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
            (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
            cleaned = cleaned.slice(1, -1);
        }

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
            /love those hyper-focused moments/i,
            /just shipped/i,
            /just pushed/i,
            /big update/i,
            /lots of changes/i,
            /feels good/i,
            /laid out/i
        ];
        
        for (const phrase of hypePhrases) {
            cleaned = cleaned.replace(phrase, '').trim();
        }

        if (options?.allowHashtags === false) {
            cleaned = cleaned
                .replace(/(^|\s)#[A-Za-z][A-Za-z0-9_-]*/g, '$1')
                .replace(/\s{2,}/g, ' ')
                .trim();
        }

        // Truncate if over 280 chars
        if (cleaned.length > 280) {
            cleaned = cleaned.substring(0, 277) + '...';
        }

        return cleaned;
    }
}
