const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

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

process.chdir(path.resolve(__dirname, '..'));

const { classifyDraftShapeFailure } = require('../src/postShape.ts');
const { generateDraft } = require('../src/gemini.ts');

function makeRequest() {
    return {
        deviceId: '11111111-1111-4111-8111-111111111111',
        requestId: '22222222-2222-4222-8222-222222222222',
        clientVersion: '3.4.2',
        triggerType: 'COMMIT_DETECTED',
        projectName: 'SalesMemo',
        projectSummary: 'SalesMemo helps the team review payment-question workflows.',
        currentFocus: 'tightening the CLI checks and eval flow',
        sessionDurationMinutes: 42,
        commitMessages: ['refactor smart entry review logic and tests for payment questions'],
        changedRelativePaths: [
            'src/app/smart-entry.tsx',
            'src/lib/__tests__/smartEntryReviewCanvas.test.ts',
            'parser fixtures',
        ],
        fileTypeSummary: {
            totalChangedFiles: 3,
            sourceFiles: 2,
            configFiles: 0,
            docsFiles: 0,
            styleFiles: 0,
            generatedFiles: 0,
            noiseFiles: 0,
            featurePathMatches: 1,
        },
        activeSymbols: ['smart-entry.tsx'],
        failedCommandNames: [],
        successfulCommandNames: [],
        frictionSummary: 'payment questions, follow-up ownership, review presentation, parser fixtures',
        selectedDiffExcerpts: [
            {
                path: 'src/app/smart-entry.tsx',
                excerpt: 'Tightened the review handoff for payment-question flows.',
                label: 'smart entry review logic',
            },
        ],
        recentTopicTags: ['shipping'],
        recentAngles: ['progress'],
        phrasesToAvoid: [],
        commitEvidence: {
            commitMessage: 'refactor smart entry review logic and tests for payment questions',
            changedRelativePaths: [
                'src/app/smart-entry.tsx',
                'src/lib/__tests__/smartEntryReviewCanvas.test.ts',
                'parser fixtures',
            ],
            additions: 120,
            deletions: 40,
            workType: 'refactor/tests',
            changedFileCount: 3,
            signalReasons: ['payment questions', 'follow-up ownership', 'review presentation', 'parser fixtures'],
            gateReasons: ['commit signal'],
            diffExcerptCount: 1,
            diffExcerptChars: 120,
            selectedDiffExcerpts: [
                {
                    path: 'src/app/smart-entry.tsx',
                    excerpt: 'Tightened the review handoff for payment-question flows.',
                    label: 'smart entry review logic',
                },
            ],
        },
    };
}

function makeRepetition() {
    return {
        topicTag: 'shipping',
        angle: 'progress',
        avoidTopics: [],
        avoidAngles: [],
        score: 0,
        shouldReject: false,
    };
}

async function main() {
    assert.equal(classifyDraftShapeFailure('src/app/'), 'path_or_filename_only');
    assert.equal(classifyDraftShapeFailure('`src/app/`'), 'path_or_filename_only');
    assert.equal(classifyDraftShapeFailure('smart-entry.tsx'), 'path_or_filename_only');
    assert.equal(classifyDraftShapeFailure('package.json'), 'path_or_filename_only');
    assert.equal(classifyDraftShapeFailure('smartEntryReviewCanvas'), 'identifier_only');
    assert.equal(classifyDraftShapeFailure('Just shipped the operator'), 'generic_commit_filler');
    assert.equal(classifyDraftShapeFailure('Fixed the memo review flow.'), null);

    process.env.GEMINI_API_KEY = 'test-key';

    let callCount = 0;
    global.fetch = async () => {
        const text = callCount === 0 ? 'src/app/' : 'Fixed the memo review flow.';
        callCount += 1;
        return {
            ok: true,
            json: async () => ({
                candidates: [
                    {
                        content: {
                            parts: [{ text }],
                        },
                    },
                ],
            }),
        };
    };

    const retrySuccess = await generateDraft(makeRequest(), makeRepetition());
    assert.equal(retrySuccess.draftText, 'Fixed the memo review flow.');
    assert.equal(retrySuccess.retryAttempted, true);

    callCount = 0;
    global.fetch = async () => {
        callCount += 1;
        return {
            ok: true,
            json: async () => ({
                candidates: [
                    {
                        content: {
                            parts: [{ text: 'Just shipped the operator' }],
                        },
                    },
                ],
            }),
        };
    };

    await assert.rejects(
        () => generateDraft(makeRequest(), makeRepetition()),
        (error) => Boolean(error && typeof error === 'object' && 'message' in error && /invalid post shape/i.test(String(error.message)))
    );

    console.log('post-shape harness passed');
}

main().catch((error) => {
    console.error('post-shape harness failed');
    console.error(error);
    process.exitCode = 1;
});
