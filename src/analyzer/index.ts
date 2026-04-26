/**
 * Analyzer Module - The "Brain" of DevGhost
 * 
 * This module contains all AI-related functionality:
 * - KeyManager: Secure API key storage
 * - PromptBuilder: The "Raw, Technical, Funny" persona
 * - GeminiService: AI content generation
 * - DiffManager: Phase 8 - Git diff reader
 */

export { KeyManager } from './keyManager';
export { PromptBuilder, BreakthroughContext } from './promptBuilder';
export { GeminiService } from './gemini';
export { DiffManager } from './diffManager';
export { sanitizeGeminiPayload, shouldSkipSensitivePath } from './aiSanitizer';
export type { ProjectContext } from './gemini';
export type { DiffSummary } from './diffManager';
