const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const Module = require('module');
const ts = require('typescript');

// QA-only: this harness reads source/git/environment data and prints to stdout.
// It intentionally has no file, database, extension-storage, or logging writes.
Module._extensions['.ts'] = function compileTypeScript(module, filename) {
    const source = fs.readFileSync(filename, 'utf8');
    const { outputText } = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2021,
            esModuleInterop: true,
            allowSyntheticDefaultImports: true,
        },
        fileName: filename,
    });
    module._compile(outputText, filename);
};

const vscodeStub = {
    workspace: {
        getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    },
    window: {
        activeTextEditor: undefined,
        showWarningMessage: async () => 'Not now',
    },
    commands: {
        executeCommand: async () => [],
    },
    SymbolKind: {
        Function: 11,
        Method: 5,
        Class: 4,
        Interface: 10,
        Enum: 9,
        Module: 2,
        Struct: 22,
    },
};

const originalLoad = Module._load;
Module._load = function loadWithVscodeStub(request, parent, isMain) {
    if (request === 'vscode') return vscodeStub;
    return originalLoad.call(this, request, parent, isMain);
};

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLOUD_ROOT = path.resolve(__dirname, '..');

const { AgenticBrain } = require('../../src/agent/AgenticBrain.ts');
const { GeminiService } = require('../../src/analyzer/gemini.ts');
const { buildCloudDraftRequest, buildCommitEvidence } = require('../../src/cloud/contextBuilder.ts');
const { generateDraft } = require('../src/gemini.ts');
const { cleanDraftText, classifyDraftShapeFailure } = require('../src/postShape.ts');
const { PromptBuilder } = require('../../src/analyzer/promptBuilder.ts');

const FIXTURES = {
    'backup-ui': {
        projectName: 'Backup Console',
        baseline: 'A backup dashboard that shows operators what recovery actions are actually available.',
        focus: 'make backup UI match real restore behavior',
        commitMessage: 'align backup UI and copy with actual backup behavior',
        workType: 'bugfix',
        additions: 54,
        deletions: 31,
        changedFiles: ['src/backup/BackupPanel.tsx', 'src/backup/backupStatus.ts', 'src/backup/BackupPanel.test.tsx'],
        activeSymbols: ['BackupPanel', 'getBackupStatus'],
        excerpts: [
            {
                path: 'src/backup/BackupPanel.tsx',
                label: 'backup UI',
                excerpt: "@@ backup status copy @@\n- Backup ready\n+ Show restore controls only when a usable backup exists\n+ Explain when recovery is unavailable",
            },
            {
                path: 'src/backup/BackupPanel.test.tsx',
                label: 'behavior test',
                excerpt: "@@ tests @@\n+ hides restore action when no usable backup exists\n+ explains the real backup state to the operator",
            },
        ],
    },
    'repetition-memory': {
        projectName: 'DevGhost',
        baseline: 'A review-first build-in-public drafting assistant for developers.',
        focus: 'avoid repeating the same post angle across sessions',
        commitMessage: 'add repetition memory across drafting sessions',
        workType: 'feature',
        additions: 142,
        deletions: 18,
        changedFiles: ['src/cloud/repetitionMemory.ts', 'cloud/src/repetition.ts', 'cloud/src/neon.ts'],
        activeSymbols: ['CloudRepetitionMemory', 'buildRepetitionSnapshot', 'upsertTopicAngleMemory'],
        excerpts: [
            {
                path: 'src/cloud/repetitionMemory.ts',
                label: 'session memory',
                excerpt: "@@ repetition memory @@\n+ remember recent topic tags and angles\n+ derive phrases to avoid after repeated or dismissed drafts",
            },
            {
                path: 'cloud/src/repetition.ts',
                label: 'cloud repetition check',
                excerpt: "@@ request scoring @@\n+ compare the current topic and angle with recent successful drafts\n+ steer generation away from repeated angles",
            },
        ],
    },
    'operator-cli': {
        projectName: 'Operator CLI',
        baseline: 'A command-line tool that helps operators inspect service health and configuration.',
        focus: 'make command output and diagnostics trustworthy',
        commitMessage: 'add operator CLI output handling and doctor status tests',
        workType: 'feature',
        additions: 188,
        deletions: 44,
        changedFiles: ['src/cli/commands/doctor.ts', 'src/cli/commands/status.ts', 'src/cli/output.ts', 'test/doctor-status.test.ts'],
        activeSymbols: ['doctorCommand', 'statusCommand', 'formatOperatorOutput'],
        excerpts: [
            {
                path: 'src/cli/output.ts',
                label: 'CLI output',
                excerpt: "@@ command output @@\n+ keep doctor and status output consistent across success and failure paths\n+ return a non-zero exit code when a diagnostic fails",
            },
            {
                path: 'test/doctor-status.test.ts',
                label: 'doctor/status tests',
                excerpt: "@@ tests @@\n+ covers doctor output, status output, command errors, and exit handling",
            },
        ],
    },
    reliability: {
        projectName: 'DevGhost',
        baseline: 'A review-first VS Code extension that turns real coding activity into build-in-public drafts.',
        focus: 'make Cloud generation failures explainable and retryable in QA',
        commitMessage: 'improve Cloud reliability with QA flight recorder, quota mode, and post validation',
        workType: 'feature',
        additions: 352,
        deletions: 132,
        changedFiles: ['src/cloud/postDecisionState.ts', 'src/cloud/contextBuilder.ts', 'src/extension.ts', 'cloud/src/postShape.ts', 'cloud/src/quota.ts'],
        activeSymbols: ['PostDecisionState', 'buildCloudDraftRequest', 'classifyDraftShapeFailure'],
        excerpts: [
            {
                path: 'src/cloud/postDecisionState.ts',
                label: 'QA flight recorder',
                excerpt: "@@ decision metadata @@\n+ record trigger, gate, quota mode, request status, excerpt count, and final acceptance",
            },
            {
                path: 'cloud/src/postShape.ts',
                label: 'post validation',
                excerpt: "@@ invalid post shapes @@\n+ reject path-only output, headline fragments, dangling backticks, and cut-off drafts",
            },
        ],
    },
};

function parseArgs(argv) {
    const args = { fixture: null, commit: null, live: false };
    for (let index = 0; index < argv.length; index++) {
        const value = argv[index];
        if (value === '--fixture') args.fixture = argv[++index];
        else if (value === '--commit') args.commit = argv[++index];
        else if (value === '--live') args.live = true;
    }
    return args;
}

function loadCloudEnvironment() {
    const envPath = path.join(CLOUD_ROOT, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        if (!line || /^\s*#/.test(line)) continue;
        const separator = line.indexOf('=');
        if (separator < 1) continue;
        const key = line.slice(0, separator).trim();
        let value = line.slice(separator + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key === 'GEMINI_API_KEY' || key === 'GEMINI_MODEL') process.env[key] = value;
    }
}

function git(args) {
    return childProcess.execFileSync('git', args, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
    });
}

function analyzeCommit(commitHash) {
    const statsOutput = git(['show', '--stat', '--format=%H%x1f%s%x1f%aI%x1f%cI', commitHash]);
    const nameStatusOutput = git(['show', '--name-status', '--format=', '-M', commitHash]);
    const lines = statsOutput.split(/\r?\n/);
    const headerLine = lines.shift() || '';
    const [fullHash = commitHash, message = 'No message', authorDate = null, committerDate = null] = headerLine.split('\x1f');
    const changedFiles = [];
    const seenChangedFiles = new Set();
    let additions = 0;
    let deletions = 0;
    let filesChanged = 0;
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.includes('file') && line.includes('changed')) {
            filesChanged = Number(line.match(/(\d+)\s+file/)?.[1] ?? filesChanged);
            additions = Number(line.match(/(\d+)\s+insertion/)?.[1] ?? additions);
            deletions = Number(line.match(/(\d+)\s+deletion/)?.[1] ?? deletions);
            continue;
        }
    }

    for (const rawLine of nameStatusOutput.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const parts = line.split(/\t+/).map((part) => part.trim()).filter(Boolean);
        if (parts.length < 2) continue;
        const status = parts[0]?.toUpperCase() || '';
        const filePath = status.startsWith('R') || status.startsWith('C')
            ? parts[2] || parts[1]
            : parts[1];
        if (!filePath || seenChangedFiles.has(filePath)) continue;
        seenChangedFiles.add(filePath);
        changedFiles.push(filePath);
    }
    const lower = message.toLowerCase();
    const workType = lower.startsWith('feat') || lower.includes('add ') ? 'feature'
        : lower.startsWith('fix') || lower.includes('bug') ? 'bugfix'
            : lower.includes('test') ? 'tests'
                : lower.includes('doc') ? 'docs'
                    : 'refactor';
    return {
        hash: fullHash.slice(0, 7),
        message,
        additions,
        deletions,
        filesChanged: filesChanged || changedFiles.length,
        changedFiles,
        isPivot: false,
        isDeepWork: false,
        repoRoot: REPO_ROOT,
        sessionMinutes: 45,
        authorDate,
        committerDate,
        classification: 'fresh_commit',
        diffStat: statsOutput,
        workType,
    };
}

function makeCommitEvidence(fixture) {
    const selectedDiffExcerpts = fixture.excerpts.map((entry) => ({ ...entry }));
    const diffExcerptChars = selectedDiffExcerpts.reduce(
        (sum, entry) => sum + entry.path.length + entry.excerpt.length + (entry.label?.length ?? 0),
        0
    );
    return {
        commitMessage: fixture.commitMessage,
        changedRelativePaths: fixture.changedFiles,
        additions: fixture.additions,
        deletions: fixture.deletions,
        workType: fixture.workType,
        changedFileCount: fixture.changedFiles.length,
        signalReasons: ['meaningful commit evidence', 'commit signal in session'],
        gateReasons: [],
        diffExcerptCount: selectedDiffExcerpts.length,
        diffExcerptChars,
        selectedDiffExcerpts,
    };
}

function fileMix(paths) {
    const source = paths.filter((entry) => /\.(?:ts|tsx|js|jsx|py|go|rs|java)$/i.test(entry)).length;
    const tests = paths.filter((entry) => /(?:test|spec)/i.test(entry)).length;
    return `source: ${source}${tests ? `, tests: ${tests}` : ''}`;
}

function redactKnownSecret(value) {
    const key = process.env.GEMINI_API_KEY || '';
    return key ? String(value).split(key).join('[REDACTED]') : String(value);
}

function printSection(label, value) {
    process.stdout.write(`\n===== ${label} =====\n`);
    process.stdout.write(`${typeof value === 'string' ? redactKnownSecret(value) : JSON.stringify(value, null, 2)}\n`);
}

function extractProviderText(data) {
    return data?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('')?.trim() ?? '';
}

function parseStructuredPostText(text) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) {
        return { text: '', structuredResponse: false };
    }

    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'string') {
            return { text: parsed.trim(), structuredResponse: true };
        }
        if (parsed && typeof parsed === 'object' && typeof parsed.post === 'string') {
            return { text: parsed.post.trim(), structuredResponse: true };
        }
    } catch {
        // fall through
    }

    return { text: trimmed, structuredResponse: false };
}

function extractProviderMetadata(data) {
    const candidate = data?.candidates?.[0] ?? {};
    const parts = candidate?.content?.parts ?? [];
    return {
        finishReason: candidate.finishReason ?? null,
        finishMessage: candidate.finishMessage ?? null,
        partCount: parts.length,
        parts: parts.map((part) => ({
            textChars: typeof part.text === 'string' ? part.text.length : 0,
            thought: part.thought === true,
            hasThoughtSignature: Boolean(part.thoughtSignature),
        })),
        usageMetadata: data?.usageMetadata ?? null,
        modelVersion: data?.modelVersion ?? null,
    };
}

async function buildRequest(fixture, commitHash) {
    let evidence;
    let changedFiles;
    let additions;
    let deletions;
    let workType;
    let commitMessage;
    if (commitHash) {
        const analysis = analyzeCommit(commitHash);
        evidence = buildCommitEvidence({ workspaceRoot: REPO_ROOT, commitAnalysis: analysis });
        changedFiles = analysis.changedFiles;
        additions = analysis.additions;
        deletions = analysis.deletions;
        workType = analysis.workType;
        commitMessage = analysis.message;
    } else {
        evidence = makeCommitEvidence(fixture);
        changedFiles = fixture.changedFiles;
        additions = fixture.additions;
        deletions = fixture.deletions;
        workType = fixture.workType;
        commitMessage = fixture.commitMessage;
    }

    const result = await buildCloudDraftRequest({
        triggerType: 'COMMIT_DETECTED',
        deviceId: '11111111-1111-4111-8111-111111111111',
        requestId: '22222222-2222-4222-8222-222222222222',
        clientVersion: 'qa-local-audit',
        workspaceRoot: REPO_ROOT,
        contextManager: {
            getConfig: () => ({
                projectName: fixture.projectName,
                mission: fixture.baseline,
                currentFocus: fixture.focus,
            }),
            getBaselineSummary: () => fixture.baseline,
        },
        historyManager: { getLastEvents: () => [] },
        sessionManager: {
            getSessionDurationMinutes: () => 45,
            getActiveStruggles: () => [],
            getRecentFrictionSummary: () => '',
        },
        workSignalManager: {
            getRecentTouchedSymbols: () => fixture.activeSymbols,
            getRecentSuccessfulCommandNames: () => [],
        },
        repetitionSnapshot: { recentTopicTags: [], recentAngles: [], phrasesToAvoid: [] },
        triggerEvidence: evidence,
    });

    return {
        request: result.request,
        byokContext: {
            projectName: fixture.projectName,
            baselineSummary: fixture.baseline,
            commitMessage,
            changedFiles,
            additions,
            deletions,
            workType,
            sessionMinutes: 45,
            focus: fixture.focus,
            touchedSymbols: fixture.activeSymbols,
            compactDiffSummary: `+${additions} / -${deletions} across ${changedFiles.length} files; file mix: ${fileMix(changedFiles)}; top files: ${changedFiles.slice(0, 8).join(', ')}`,
            fileCategories: fileMix(changedFiles),
        },
    };
}

async function runByok(byokContext, live) {
    let rawOutput = '';
    let userPrompt = '';
    if (!live) {
        const brain = new AgenticBrain({
            isInitialized: () => true,
            draftFromPrompt: async (prompt) => {
                userPrompt = prompt;
                rawOutput = 'The change now works the way the interface promises. The result is clearer for the people using it.';
                return rawOutput;
            },
        }, {});
        const result = await brain.process_trigger('COMMIT_DETECTED', byokContext);
        return { modelName: 'mock', userPrompt, rawOutput, cleanedOutput: result.ok ? result.tweet : '', result };
    }

    const service = new GeminiService();
    await service.initialize(process.env.GEMINI_API_KEY);
    const originalDraftFromPrompt = service.draftFromPrompt.bind(service);
    service.draftFromPrompt = async (prompt, label) => {
        userPrompt = prompt;
        rawOutput = await originalDraftFromPrompt(prompt, label) ?? '';
        return rawOutput;
    };
    const brain = new AgenticBrain(service, {});
    const result = await brain.process_trigger('COMMIT_DETECTED', byokContext);
    return {
        modelName: service.resolvedModel || 'unknown',
        userPrompt,
        rawOutput,
        cleanedOutput: result.ok ? result.tweet : '',
        result,
    };
}

async function runCloud(request, fixture, live) {
    const realFetch = global.fetch;
    const previousGeminiKey = process.env.GEMINI_API_KEY;
    if (!live) process.env.GEMINI_API_KEY = 'qa-local-mock-key';
    const calls = [];
    let mockCall = 0;
    global.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        const prompt = body?.contents?.[0]?.parts?.[0]?.text ?? '';
        if (!live) {
            const raw = mockCall++ === 0
                ? `${fixture.commitMessage}:`
                : `The latest change makes ${fixture.focus} concrete, so the result now matches what users actually see.`;
            const data = { candidates: [{ content: { parts: [{ text: raw }] } }] };
            calls.push({ prompt, rawResponse: raw, responseJson: data });
            return { ok: true, json: async () => data };
        }

        const response = await realFetch(url, options);
        const data = await response.clone().json();
        calls.push({ prompt, rawResponse: extractProviderText(data), responseJson: data });
        return response;
    };

    try {
        const repetition = {
            topicTag: 'qa-audit',
            angle: 'comparison',
            avoidTopics: [],
            avoidAngles: [],
            score: 0,
            shouldReject: false,
        };
        const result = await generateDraft(request, repetition);
        return { calls, result, finalDecision: 'accepted' };
    } catch (error) {
        return {
            calls,
            result: null,
            finalDecision: 'rejected',
            errorCode: error?.code || error?.name || 'unknown',
            invalidReason: error?.details?.reason || null,
        };
    } finally {
        global.fetch = realFetch;
        if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = previousGeminiKey;
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const fixtureName = args.fixture || (args.commit ? 'reliability' : null);
    if (!fixtureName || !FIXTURES[fixtureName]) {
        process.stderr.write('Use --fixture backup-ui|repetition-memory|operator-cli|reliability [--live], or --commit <hash> [--live].\n');
        process.exitCode = 2;
        return;
    }
    if (args.live) {
        loadCloudEnvironment();
        if (!process.env.GEMINI_API_KEY) {
            process.stderr.write('GEMINI_API_KEY is unavailable for live QA.\n');
            process.exitCode = 2;
            return;
        }
    }

    const fixture = FIXTURES[fixtureName];
    const built = await buildRequest(fixture, args.commit);
    printSection('TRIGGER TYPE', built.request.triggerType);
    printSection('SANITIZED CLOUD REQUEST PAYLOAD', built.request);

    const byok = await runByok(built.byokContext, args.live);
    printSection('BYOK MODEL', byok.modelName);
    printSection('BYOK SYSTEM INSTRUCTION', PromptBuilder.getSystemInstruction());
    printSection('BYOK USER PROMPT', byok.userPrompt);
    printSection('BYOK RAW MODEL OUTPUT', byok.rawOutput);
    printSection('BYOK CLEANED OUTPUT', byok.cleanedOutput);
    printSection('BYOK OUTPUT UNDER CLOUD VALIDATOR', classifyDraftShapeFailure(byok.cleanedOutput));

    const cloud = await runCloud(built.request, fixture, args.live);
    for (const [index, call] of cloud.calls.entries()) {
        printSection(index === 0 ? 'CLOUD FINAL GEMINI PROMPT' : 'CLOUD RETRY PROMPT', call.prompt);
        printSection(index === 0 ? 'CLOUD RAW GEMINI RESPONSE' : 'CLOUD RETRY RAW RESPONSE', call.rawResponse);
        printSection(index === 0 ? 'CLOUD PROVIDER METADATA' : 'CLOUD RETRY PROVIDER METADATA', extractProviderMetadata(call.responseJson));
        const parsed = parseStructuredPostText(call.rawResponse);
        const cleaned = cleanDraftText(parsed.text);
        printSection(index === 0 ? 'CLOUD CLEANED OUTPUT' : 'CLOUD RETRY CLEANED OUTPUT', cleaned);
        printSection(index === 0 ? 'CLOUD VALIDATOR RESULT' : 'CLOUD RETRY VALIDATOR RESULT', classifyDraftShapeFailure(cleaned));
    }
    printSection('FINAL API DECISION', {
        decision: cloud.finalDecision,
        retryAttempted: cloud.calls.length > 1,
        invalidReason: cloud.invalidReason ?? null,
        finalDraft: cloud.result?.draftText ?? null,
        modelName: cloud.result?.modelName ?? process.env.GEMINI_MODEL ?? 'mock',
        finishReason: cloud.result?.finishReason ?? null,
        visibleOutputTokens: cloud.result?.visibleOutputTokens ?? null,
        thoughtsTokenCount: cloud.result?.thoughtsTokenCount ?? null,
        structuredResponse: cloud.result?.structuredResponse ?? null,
    });
}

main().catch((error) => {
    process.stderr.write(`QA harness failed: ${error?.code || error?.name || 'unknown'}\n`);
    process.exitCode = 1;
});
