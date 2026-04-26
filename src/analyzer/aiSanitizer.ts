const SENSITIVE_LINE_PATTERNS = [
    /API_KEY/i,
    /SECRET/i,
    /TOKEN/i,
    /PRIVATE_KEY/i,
    /PASSWORD/i,
    /BEARER/i,
    /AUTH/i,
    /CLIENT_SECRET/i,
    /ACCESS_KEY/i,
    /GEMINI_API_KEY/i,
    /OPENAI_API_KEY/i,
    /ANTHROPIC_API_KEY/i,
    /DATABASE_URL/i,
    /JWT_SECRET/i,
    /WEBHOOK_SECRET/i,
    /RPC_URL.*key/i,
    /PRIVATE/i,
    /CREDENTIAL/i,
];

const GENERIC_ABSOLUTE_PATH_PATTERNS = [
    /[A-Za-z]:\\[^\s"'`<>|]+(?:\\[^\s"'`<>|]+)+/g,
    /\/(?:Users|home|private|var|tmp|opt|mnt|srv|Library)\/[^\s"'`<>|]+/g,
];

const SENSITIVE_BASENAME_PATTERNS = [
    /^\.env(?:\..+)?$/i,
    /^.*\.pem$/i,
    /^.*\.key$/i,
    /^.*\.crt$/i,
    /^id_rsa$/i,
    /^id_ed25519$/i,
    /^secrets?\..+$/i,
    /^secret\..+$/i,
    /^credentials?\..+$/i,
    /^credential\..+$/i,
    /^service-account\..+$/i,
    /^firebase-adminsdk/i,
    /^\.npmrc$/i,
    /^\.pypirc$/i,
    /^\.netrc$/i,
    /^package-lock\.json$/i,
    /^yarn\.lock$/i,
    /^pnpm-lock\.yaml$/i,
];

const GENERATED_PATH_SEGMENTS = [
    '/.git/',
    '\\.git\\',
    '/node_modules/',
    '\\node_modules\\',
    '/dist/',
    '\\dist\\',
    '/build/',
    '\\build\\',
    '/out/',
    '\\out\\',
    '/coverage/',
    '\\coverage\\',
    '/.next/',
    '\\.next\\',
    '/snapshots/',
    '\\snapshots\\',
];

export interface SanitizationResult {
    text: string;
    changed: boolean;
    redactedSensitiveLines: number;
    removedSensitiveFiles: number;
    shortenedPaths: number;
    truncated: boolean;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePathCandidate(candidate: string): string {
    return candidate
        .trim()
        .replace(/^a\//, '')
        .replace(/^b\//, '')
        .replace(/^["'`]+|["'`]+$/g, '')
        .replace(/^(\[)?(file|path|root):\s*/i, '')
        .replace(/^\.\/+/, '')
        .replace(/\\/g, '/');
}

function getBasename(candidate: string): string {
    const normalized = normalizePathCandidate(candidate);
    const parts = normalized.split('/');
    return (parts[parts.length - 1] || normalized).trim();
}

export function shouldSkipSensitivePath(candidate: string): boolean {
    const normalized = normalizePathCandidate(candidate).toLowerCase();
    if (!normalized) return false;

    if (GENERATED_PATH_SEGMENTS.some((segment) => normalized.includes(segment.toLowerCase()))) {
        return true;
    }

    const basename = getBasename(candidate);
    return SENSITIVE_BASENAME_PATTERNS.some((pattern) => pattern.test(basename));
}

function extractPathCandidate(line: string): string | null {
    const patterns = [
        /^diff --git a\/(.+?) b\/(.+)$/,
        /^===\s+(.+?)\s+===$/,
        /^Index:\s+(.+)$/,
        /^---\s+a\/(.+)$/,
        /^\+\+\+\s+b\/(.+)$/,
        /^File:\s+(.+)$/i,
        /^Active file:\s+(.+)$/i,
        /^Root:\s+(.+)$/i,
        /^path:\s+(.+)$/i,
        /^- \[(?:file|dir|other)\]\s+(.+)$/i,
        /^- File:\s+(.+)$/i,
    ];

    for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match) {
            return match[1];
        }
    }

    return null;
}

function containsSensitiveLine(line: string): boolean {
    return SENSITIVE_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

function shortenAbsolutePaths(line: string, workspaceRoot?: string): { text: string; changed: boolean; shortened: number } {
    let result = line;
    let shortened = 0;

    if (workspaceRoot) {
        const escapedRoot = escapeRegExp(workspaceRoot.replace(/\\/g, '/'));
        const rootRegex = new RegExp(escapedRoot, 'g');
        if (rootRegex.test(result)) {
            result = result.replace(rootRegex, '[WORKSPACE ROOT]');
            shortened++;
        }
        const rootBackslashRegex = new RegExp(escapeRegExp(workspaceRoot), 'g');
        if (rootBackslashRegex.test(result)) {
            result = result.replace(rootBackslashRegex, '[WORKSPACE ROOT]');
            shortened++;
        }
    }

    for (const pattern of GENERIC_ABSOLUTE_PATH_PATTERNS) {
        const matches = result.match(pattern);
        if (matches) {
            shortened += matches.length;
            result = result.replace(pattern, '[LOCAL PATH]');
        }
    }

    return { text: result, changed: result !== line, shortened };
}

function hasBinaryMarkers(line: string): boolean {
    return /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(line);
}

/**
 * Sanitizes any prompt or payload that is about to be sent to Gemini.
 */
export function sanitizeGeminiPayload(
    input: string,
    options?: {
        workspaceRoot?: string;
        maxLength?: number;
    }
): SanitizationResult {
    const workspaceRoot = options?.workspaceRoot;
    const maxLength = options?.maxLength ?? 12000;
    const lines = String(input ?? '').replace(/\r\n/g, '\n').split('\n');

    const sanitized: string[] = [];
    let changed = false;
    let redactedSensitiveLines = 0;
    let removedSensitiveFiles = 0;
    let shortenedPaths = 0;
    let truncated = false;
    let skipSensitiveSection = false;
    let currentLength = 0;

    for (const rawLine of lines) {
        if (currentLength > maxLength) {
            truncated = true;
            break;
        }

        const line = rawLine ?? '';
        const candidate = extractPathCandidate(line);

        if (candidate && shouldSkipSensitivePath(candidate)) {
            changed = true;
            removedSensitiveFiles++;
            skipSensitiveSection = line.startsWith('diff --git') || line.startsWith('=== ') || line.startsWith('Index:');
            const redacted = '[REDACTED SENSITIVE FILE]';
            sanitized.push(redacted);
            currentLength += redacted.length + 1;
            continue;
        }

        if (skipSensitiveSection) {
            const nextCandidate = extractPathCandidate(line);
            if (nextCandidate && !shouldSkipSensitivePath(nextCandidate)) {
                skipSensitiveSection = false;
            } else if (!nextCandidate) {
                continue;
            }
        }

        if (containsSensitiveLine(line)) {
            changed = true;
            redactedSensitiveLines++;
            const redacted = '[REDACTED SENSITIVE LINE]';
            sanitized.push(redacted);
            currentLength += redacted.length + 1;
            continue;
        }

        if (hasBinaryMarkers(line)) {
            changed = true;
            const redacted = '[BINARY CONTENT REMOVED]';
            sanitized.push(redacted);
            currentLength += redacted.length + 1;
            continue;
        }

        const shortened = shortenAbsolutePaths(line, workspaceRoot);
        if (shortened.changed) {
            changed = true;
            shortenedPaths += shortened.shortened;
        }

        sanitized.push(shortened.text);
        currentLength += shortened.text.length + 1;
    }

    let text = sanitized.join('\n');
    if (text.length > maxLength) {
        text = text.slice(0, maxLength).trimEnd() + '\n... [TRUNCATED FOR GEMINI]';
        truncated = true;
        changed = true;
    }

    return {
        text,
        changed,
        redactedSensitiveLines,
        removedSensitiveFiles,
        shortenedPaths,
        truncated,
    };
}
