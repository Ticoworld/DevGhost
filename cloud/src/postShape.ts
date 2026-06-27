import { MAX_DRAFT_TEXT_CHARS } from './contracts';

export type DraftShapeInvalidReason =
    | 'empty'
    | 'too_short'
    | 'path_or_filename_only'
    | 'identifier_only'
    | 'punctuation_heavy'
    | 'generic_commit_filler';

const GENERIC_COMMIT_PATTERNS = [
    /\bjust shipped\b/i,
    /\bjust shipped the\b/i,
    /\bmade some updates\b/i,
    /\bmade updates\b/i,
    /\bmade some improvements\b/i,
    /\bimproved the (?:app|project)\b/i,
    /\bworking on the project\b/i,
    /\bworking on the app\b/i,
    /\bpushed some changes\b/i,
    /\bshipped the operator\b/i,
];

function stripWrappingDelimiters(text: string): string {
    let value = text.trim();

    while (value.length >= 2) {
        const next = value
            .replace(/^`+/, '')
            .replace(/`+$/, '')
            .replace(/^["'“”‘’]+/, '')
            .replace(/["'“”‘’]+$/, '')
            .trim();

        if (next === value) {
            return value;
        }

        value = next;
    }

    return value;
}

function normalizeForAnalysis(value: string): string {
    let text = String(value ?? '').trim();
    text = stripWrappingDelimiters(text);
    text = text.replace(/^(?:draft|tweet|output):\s*/i, '').trim();
    text = text.replace(/%23/g, '#').replace(/%20/g, ' ');
    text = text.replace(/\s+/g, ' ');
    if (text.length > MAX_DRAFT_TEXT_CHARS) {
        text = text.slice(0, MAX_DRAFT_TEXT_CHARS).trimEnd();
    }
    return text;
}

function countAlphabeticChars(value: string): number {
    return (value.match(/[A-Za-z]/g) ?? []).length;
}

function countPunctuationChars(value: string): number {
    return (value.match(/[^\w\s]/g) ?? []).length;
}

function looksLikeIdentifierToken(token: string): boolean {
    if (!token) return false;
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(token)) {
        return /[a-z][A-Z]/.test(token) || /[A-Z][a-z]/.test(token) || /[_$]/.test(token) || /\d/.test(token);
    }
    return false;
}

function looksLikePathOrFilenameToken(token: string): boolean {
    if (!token) return false;
    if (token.includes('/') || token.includes('\\')) return true;
    if (/^\.+$/.test(token)) return true;
    if (/^[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+$/.test(token)) return true;
    if (/^[A-Za-z0-9._-]+-[A-Za-z0-9._-]+$/.test(token)) return true;
    return false;
}

export function cleanDraftText(value: string): string {
    return normalizeForAnalysis(value);
}

export function classifyDraftShapeFailure(value: string): DraftShapeInvalidReason | null {
    const text = normalizeForAnalysis(value);
    if (!text) {
        return 'empty';
    }

    if (GENERIC_COMMIT_PATTERNS.some((pattern) => pattern.test(text))) {
        return 'generic_commit_filler';
    }

    const words = text.split(/\s+/).filter(Boolean);
    const alphaChars = countAlphabeticChars(text);
    const punctuationChars = countPunctuationChars(text);
    const punctuationRatio = punctuationChars / Math.max(text.length, 1);

    if (words.length === 1) {
        const token = words[0] ?? '';
        if (looksLikePathOrFilenameToken(token)) {
            return 'path_or_filename_only';
        }
        if (looksLikeIdentifierToken(token)) {
            return 'identifier_only';
        }
        return 'too_short';
    }

    if (alphaChars < 8) {
        return 'too_short';
    }

    if (punctuationRatio > 0.45 && words.length <= 3) {
        return 'punctuation_heavy';
    }

    return null;
}

