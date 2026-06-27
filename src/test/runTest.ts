import * as fs from 'fs';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
    const repoRoot = path.resolve(__dirname, '../..');
    const extensionDevelopmentPath = path.resolve(repoRoot, '.vscode-test/devghost-test-extension');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    const packageJsonPath = path.join(repoRoot, 'package.json');
    const repoOutPath = path.join(repoRoot, 'out');
    const extensionOutPath = path.join(extensionDevelopmentPath, 'out');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
        name: string;
        displayName: string;
        publisher: string;
        version: string;
        engines: { vscode: string };
    };

    fs.rmSync(extensionDevelopmentPath, { recursive: true, force: true });
    fs.mkdirSync(extensionDevelopmentPath, { recursive: true });
    fs.cpSync(repoOutPath, extensionOutPath, { recursive: true });
    fs.writeFileSync(path.join(extensionDevelopmentPath, 'package.json'), JSON.stringify({
        name: packageJson.name,
        displayName: packageJson.displayName,
        publisher: packageJson.publisher,
        version: packageJson.version,
        main: './out/extension.js',
        engines: packageJson.engines,
        activationEvents: [],
    }, null, 2));
    fs.mkdirSync(path.dirname(extensionTestsPath), { recursive: true });

    await runTests({
        extensionDevelopmentPath,
        extensionTestsPath,
        version: '1.85.2',
    });
}

main().catch((error: unknown) => {
    console.error('Failed to run DevGhost tests.');
    console.error(error);
    process.exit(1);
});
