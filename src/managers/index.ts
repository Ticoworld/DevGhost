/**
 * Managers Module - The Core of DevGhost 3.1
 * 
 * ContextManager: Manages project context (workspaceState)
 * SessionManager: Tracks session time and breakthroughs
 * GitManager: Tracks commits and detects pivots
 * HistoryManager: Phase 7 - Persistent memory (workspaceState)
 */

export { ContextManager } from './contextManager';
export { SessionManager } from './sessionManager';
export { GitManager } from './gitManager';
export { HistoryManager } from './historyManager';
export { WorkSignalManager } from './workSignalManager';
export type { CommitAnalysis } from './gitManager';
export type { AutomaticDraftDecision } from './workSignalManager';
export type { HistoryEvent, HistoryEventType } from './historyManager';
