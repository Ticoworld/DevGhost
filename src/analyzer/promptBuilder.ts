/**
 * PromptBuilder - The Persona Engine
 * 
 * Constructs prompts with the "Raw, Technical, Funny" persona.
 * This is the voice of DevGhost - a relieved, slightly sarcastic developer
 * who just shipped code and wants to share their journey.
 * 
 * Why a separate PromptBuilder?
 * - Keeps the persona logic isolated and testable
 * - Easy to tweak the tone without touching API code
 * - Can add variations/templates in the future
 */

/**
 * Context for generating a breakthrough draft.
 */
export interface BreakthroughContext {
    filename: string;
    errorCount: number;
    errorMessages?: string[];  // Future: capture actual error messages
}

export class PromptBuilder {
    /**
     * The system instruction that defines the AI's persona.
     * This is the "Raw, Technical, Funny" voice of DevGhost.
     */
    private static readonly SYSTEM_INSTRUCTION = `You are a developer's ghostwriter. Write short drafts (max 280 chars) that sound like a real developer sharing their journey.

FUZZY TIME RULES (critical):
- NEVER use exact minutes (e.g., "61 mins", "1218 minutes"). Use human time: "an hour", "over an hour", "a few hours", "all day", "the whole weekend".
- NEVER count bugs/errors numerically in the draft (e.g., "3 errors" → "a few bugs", "1 thing" not "1 things").
- Be casual. Sound like texting a dev friend, not a status report.

TONE: Informal, lower-case is okay, dev slang (e.g., 'refactored', 'stuck', 'pain').
- Do not add hashtags unless the specific prompt asks for one.
- Be authentic, not corporate. Sound like a real dev.`;

    /**
 * Build the user prompt for a breakthrough event.
     */
    static buildBreakthroughPrompt(context: BreakthroughContext): string {
        const { filename, errorCount } = context;
        
        let prompt = `Context: File '${filename}' had ${errorCount} error(s) that were just fixed.`;
        
        // Add error details if available (future enhancement)
        if (context.errorMessages && context.errorMessages.length > 0) {
            prompt += `\nThe errors were: ${context.errorMessages.slice(0, 3).join(', ')}`;
        }
        
        prompt += '\n\nWrite a draft celebrating this fix.';
        
        return prompt;
    }

    /**
     * Get the system instruction for the Gemini model.
     */
    static getSystemInstruction(): string {
        return this.SYSTEM_INSTRUCTION;
    }

    /**
     * Build a prompt for when the developer has been struggling
     * (many errors over time).
     */
    static buildStrugglePrompt(filename: string, peakErrorCount: number): string {
        return `Context: File '${filename}' had up to ${peakErrorCount} errors during a debugging session. The developer persevered and fixed them all.

Write a draft about the struggle and triumph. Be dramatic but relatable.`;
    }
}
