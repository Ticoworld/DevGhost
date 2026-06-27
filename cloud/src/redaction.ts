const SECRET_PATTERNS: RegExp[] = [
    /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
    /\b(?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[pbar]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})\b/,
    /\b(?:eyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9._-]{8,}\.[a-zA-Z0-9._-]{8,})\b/,
    /\b(?:postgres|mysql|mongodb|redis|amqp|amqps):\/\/[^\s"'`<>]+/i,
    /\bDATABASE_URL\b\s*[:=]/i,
    /\b(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|CLIENT_SECRET|ACCESS_KEY)\b\s*[:=]/i,
];

const ABSOLUTE_PATH_PATTERNS: RegExp[] = [
    /(?:^|[\s"'`(])[A-Za-z]:[\\/][^\s"'`<>]+/,
    /(?:^|[\s"'`(])\/(?:Users|home|private|var|tmp|opt|mnt|srv|Library)\//i,
    /\\\\[^\\\s]+\\[^\\\s]+/,
];

const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

const GENERATED_SEGMENTS = [
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
    '/.git/',
    '\\.git\\',
];

export interface UnsafeFinding {
    fieldPath: string;
    reason: string;
}

export function redactTextForPrompt(value: string): string {
    let text = String(value ?? '');
    text = text.replace(/\r\n/g, '\n');
    text = text.replace(CONTROL_CHAR_PATTERN, '');
    for (const pattern of SECRET_PATTERNS) {
        text = text.replace(pattern, '[REDACTED]');
    }
    for (const pattern of ABSOLUTE_PATH_PATTERNS) {
        text = text.replace(pattern, ' [PATH]');
    }
    return text.trim();
}

export function findUnsafeFindings(value: string, fieldPath: string): UnsafeFinding[] {
    const findings: UnsafeFinding[] = [];
    const text = String(value ?? '');

    if (CONTROL_CHAR_PATTERN.test(text)) {
        findings.push({ fieldPath, reason: 'contains control characters' });
    }

    for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(text)) {
            findings.push({ fieldPath, reason: 'contains secret-like content' });
            break;
        }
    }

    for (const pattern of ABSOLUTE_PATH_PATTERNS) {
        if (pattern.test(text)) {
            findings.push({ fieldPath, reason: 'contains absolute path content' });
            break;
        }
    }

    const lower = text.toLowerCase();
    if (GENERATED_SEGMENTS.some((segment) => lower.includes(segment.toLowerCase()))) {
        findings.push({ fieldPath, reason: 'references generated or build output files' });
    }

    return findings;
}

export function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}
