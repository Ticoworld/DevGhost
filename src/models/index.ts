/**
 * DevGhost Data Models
 * 
 * These interfaces define the "Soul" of DevGhost 3.1 - the Biographer Architecture.
 * Instead of tracking syntax errors, we track TIME + STRUGGLE + CONTEXT + COMMITS.
 */

/**
 * A single win/achievement from the past.
 */
export interface SessionHistoryEntry {
    /** What was accomplished */
    description: string;
    /** How long it took (in minutes) */
    durationMinutes: number;
    /** When it was completed */
    completedAt: string;
    /** Optional: what was the struggle */
    struggle?: string;
    /** Optional: was this posted to social? */
    posted?: boolean;
}

/**
 * Phase 6D: Session log entry for tracking events.
 */
export interface SessionLogEntry {
    /** Timestamp of the event */
    time: string;
    /** Type of event */
    type: 'focus_set' | 'commit' | 'struggle' | 'focus_shift' | 'post';
    /** Event details */
    value?: string;
    /** For struggles: the command that failed */
    command?: string;
    /** For struggles: how many times it failed */
    count?: number;
    /** For focus shifts: what we shifted from */
    from?: string;
    /** For focus shifts: what we shifted to */
    to?: string;
}

/**
 * The DevGhost project configuration.
 * This is the "Soul" stored in workspaceState (project baseline).
 */
export interface DevGhostConfig {
    /** Name of the project */
    projectName: string;
    
    /** The mission/goal of the project (e.g., "Build a token aggregator for Solana") */
    mission: string;
    
    /** Current focus/struggle (e.g., "Fixing the WebSocket disconnection issue") */
    currentFocus: string;
    
    /** When the current struggle started (ISO timestamp) */
    struggleStartTime: string | null;
    
    /** Tone for generated posts */
    tone: 'raw' | 'professional' | 'funny' | 'technical';
    
    /** History of past wins */
    sessionHistory: SessionHistoryEntry[];

    /** Phase 6D: Session activity log */
    sessionLog?: SessionLogEntry[];

    /** Phase 6B: Last time focus was asked (to avoid asking repeatedly) */
    lastFocusAsked?: string;
}

/**
 * Default config when initializing a new project.
 */
export const DEFAULT_CONFIG: DevGhostConfig = {
    projectName: '',
    mission: '',
    currentFocus: '',
    struggleStartTime: null,
    tone: 'raw',
    sessionHistory: [],
    sessionLog: [],
};

/**
 * Session state tracked during a coding session.
 */
export interface SessionState {
    /** When this session started */
    startTime: Date;
    
    /** Number of terminal failures in this session */
    failureCount: number;
    
    /** Number of terminal successes in this session */
    successCount: number;
    
    /** Whether we've had a success after failures (breakthrough candidate) */
    hadBreakthrough: boolean;
    
    /** The last terminal error message (for context) */
    lastError: string | null;
}
