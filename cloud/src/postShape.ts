import { MAX_DRAFT_TEXT_CHARS } from './contracts';

export type DraftShapeInvalidReason =
    | 'empty'
    | 'too_short'
    | 'path_or_filename_only'
    | 'identifier_only'
    | 'punctuation_heavy'
    | 'generic_commit_filler'
    | 'unmatched_backtick'
    | 'code_span_terminal'
    | 'cut_off_fragment';

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

const FRAGMENT_PRECEDING_WORDS = new Set([
    'to',
    'for',
    'with',
    'from',
    'into',
    'around',
    'about',
    'of',
    'the',
    'a',
    'an',
    'in',
    'on',
    'at',
    'by',
    'via',
]);

const TAIL_FRAGMENT_PRECEDING_WORDS = new Set([
    'to',
    'for',
    'with',
    'from',
    'into',
    'around',
    'about',
    'of',
    'in',
    'on',
    'at',
    'by',
    'via',
]);

function stripWrappingDelimiters(text: string): string {
    let value = text.trim();

    while (value.length >= 2) {
        const first = value[0];
        const last = value[value.length - 1];
        if (first !== last || (first !== '"' && first !== '\'' && first !== '`')) {
            break;
        }

        const next = value.slice(1, -1).trim();

        if (next === value) {
            return value;
        }

        value = next;
    }

    return value;
}

function stripTrailingSentencePunctuation(token: string): string {
    return token.replace(/[.!?,"')\];:]+$/g, '');
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

function splitDraftTokens(text: string): string[] {
    return text.split(/\s+/).filter(Boolean);
}

function countAlphabeticChars(value: string): number {
    return (value.match(/[A-Za-z]/g) ?? []).length;
}

function countPunctuationChars(value: string): number {
    return (value.match(/[^\w\s]/g) ?? []).length;
}

function looksLikeIdentifierToken(token: string): boolean {
    if (!token) {
        return false;
    }

    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(token)) {
        return false;
    }

    if (/[._/-]/.test(token)) {
        return false;
    }

    if (/[_$]/.test(token) || /\d/.test(token)) {
        return true;
    }

    if (/[a-z][A-Z]/.test(token)) {
        return true;
    }

    if (/^[A-Z][a-z]+[A-Z]/.test(token)) {
        return true;
    }

    if (/^[A-Z]{2,}[a-z][A-Za-z0-9$]*$/.test(token)) {
        return true;
    }

    return false;
}

function looksLikePathOrFilenameToken(token: string): boolean {
    if (!token) {
        return false;
    }

    if (token.includes('/') || token.includes('\\')) {
        return true;
    }
    if (/^\.+$/.test(token)) {
        return true;
    }
    if (/^[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+$/.test(token)) {
        return true;
    }
    if (/^[A-Za-z0-9._-]+-[A-Za-z0-9._-]+$/.test(token)) {
        return true;
    }
    return false;
}

function hasUnmatchedBacktick(text: string): boolean {
    return (text.match(/`/g) ?? []).length % 2 === 1;
}

function getTrailingCodeSpan(text: string): string | null {
    const match = text.match(/`([^`]+)`\s*$/);
    return match ? match[1].trim() : null;
}

function hasShortPathPhrase(words: string[]): boolean {
    if (words.length === 0 || words.length > 4) {
        return false;
    }

    return words.some((word) => looksLikePathOrFilenameToken(stripTrailingSentencePunctuation(word)));
}

function hasShortIdentifierPhrase(words: string[]): boolean {
    if (words.length === 0 || words.length > 4) {
        return false;
    }

    return words.some((word) => looksLikeIdentifierToken(stripTrailingSentencePunctuation(word)));
}

function looksLikeDanglingTail(text: string): boolean {
    const words = splitDraftTokens(text);
    if (words.length < 3) {
        return false;
    }

    const lastToken = stripTrailingSentencePunctuation(words[words.length - 1] ?? '');
    const previousToken = stripTrailingSentencePunctuation(words[words.length - 2] ?? '').toLowerCase();

    if (!TAIL_FRAGMENT_PRECEDING_WORDS.has(previousToken)) {
        return false;
    }

    return lastToken.length > 0 && lastToken.length <= 4;
}

function looksCutOff(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) {
        return false;
    }

    if (/[.!?]["')\]]?\s*$/.test(trimmed)) {
        return false;
    }

    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (tokens.length < 3) {
        return false;
    }
    if (tokens.length <= 4) {
        return true;
    }

    const lastToken = tokens[tokens.length - 1] ?? '';
    const previousToken = tokens[tokens.length - 2]?.toLowerCase() ?? '';

    if (FRAGMENT_PRECEDING_WORDS.has(lastToken.toLowerCase())) {
        return true;
    }
    if (!FRAGMENT_PRECEDING_WORDS.has(previousToken)) {
        return false;
    }

    return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,15}$/.test(lastToken);
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

    if (/^[^A-Za-z0-9]/.test(text)) {
        return 'cut_off_fragment';
    }

    if (hasUnmatchedBacktick(text)) {
        return 'unmatched_backtick';
    }

    const trailingCodeSpan = getTrailingCodeSpan(text);
    if (trailingCodeSpan) {
        if (looksLikePathOrFilenameToken(trailingCodeSpan)) {
            return 'path_or_filename_only';
        }
        if (looksLikeIdentifierToken(trailingCodeSpan)) {
            return 'identifier_only';
        }
        return 'code_span_terminal';
    }

    const words = splitDraftTokens(text);
    if (hasShortPathPhrase(words)) {
        return 'path_or_filename_only';
    }
    if (hasShortIdentifierPhrase(words)) {
        return 'identifier_only';
    }
    if (looksLikeDanglingTail(text)) {
        return 'cut_off_fragment';
    }
    if (looksCutOff(text)) {
        return 'cut_off_fragment';
    }

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

export function toInvalidPostShapeReasonCode(reason: DraftShapeInvalidReason): string {
    return `invalid_post_shape_${reason}`;
}
