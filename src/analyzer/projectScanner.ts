import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { shouldSkipSensitivePath } from './aiSanitizer';

type PackageJson = {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
};

/**
 * Reads package.json deps + lists top-level workspace entries.
 * Explicitly ignores: node_modules, .git, dist.
 *
 * Returns a formatted string intended to be pasted into an LLM prompt.
 */
export async function scanProjectEnvironment(workspaceRoot: string): Promise<string> {
    const ignore = new Set([
        'node_modules',
        '.git',
        'dist',
        'build',
        'out',
        'coverage',
        '.next',
        'snapshots',
        'package-lock.json',
        'yarn.lock',
        'pnpm-lock.yaml',
    ]);

    let pkg: PackageJson | null = null;
    const packageJsonPath = path.join(workspaceRoot, 'package.json');
    try {
        if (fs.existsSync(packageJsonPath)) {
            const raw = fs.readFileSync(packageJsonPath, 'utf-8');
            pkg = JSON.parse(raw) as PackageJson;
        }
    } catch {
        pkg = null;
    }

    let entries: Array<{ name: string; kind: 'dir' | 'file' | 'other' }> = [];
    try {
        const dirents = fs.readdirSync(workspaceRoot, { withFileTypes: true });
        entries = dirents
            .filter((d) => !ignore.has(d.name) && !shouldSkipSensitivePath(d.name))
            .map((d) => {
                const kind: 'dir' | 'file' | 'other' = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other';
                return { name: d.name, kind };
            })
            .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
        entries = [];
    }

    const dependencies = pkg?.dependencies ?? {};
    const devDependencies = pkg?.devDependencies ?? {};

    const depsLines = Object.keys(dependencies).length
        ? Object.entries(dependencies)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([name, version]) => `- ${name}: ${version}`)
              .join('\n')
        : '(none)';

    const devDepsLines = Object.keys(devDependencies).length
        ? Object.entries(devDependencies)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([name, version]) => `- ${name}: ${version}`)
              .join('\n')
        : '(none)';

    const entryLines = entries.length
        ? entries.map((e) => `- [${e.kind}] ${e.name}`).join('\n')
        : '(unable to read workspace root)';

    return [
        'DEVGHOST PROJECT SCAN (workspace root)',
        `Root: ${workspaceRoot}`,
        '',
        'package.json',
        `name: ${pkg?.name ?? '(unknown / missing package.json)'}`,
        '',
        'dependencies:',
        depsLines,
        '',
        'devDependencies:',
        devDepsLines,
        '',
        'top-level entries (excluding node_modules, .git, dist):',
        entryLines,
    ].join('\n');
}

/**
 * Returns the last 5 commits from the workspace repo (git log -n 5 --oneline).
 * Used as lastMilestone context when user chooses "Yes, Catch Up AI".
 */
export function getRecentGitHistory(workspaceRoot: string): string[] {
    try {
        const out = execSync('git log -n 5 --oneline', {
            cwd: workspaceRoot,
            encoding: 'utf-8',
            maxBuffer: 4096,
        });
        return out.trim().split('\n').filter(Boolean);
    } catch {
        return [];
    }
}

