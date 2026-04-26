'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkgPath = path.join(root, 'package.json');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
// Use current version; no auto-bump so the VSIX matches package.json.
const newVersion = pkg.version;
console.log(`Packaging version ${newVersion}`);

execSync('npm run package', { cwd: root, stdio: 'inherit' });

const vsixName = `devghost-${newVersion}.vsix`;
const clis = [
  { name: 'Cursor', cmd: 'cursor' },
  { name: 'VS Code', cmd: 'code' },
  { name: 'Antigravity', cmd: 'antigravity' },
];
let installed = false;
for (const { name, cmd } of clis) {
  try {
    execSync(`${cmd} --install-extension ${vsixName} --force`, { cwd: root, stdio: 'inherit' });
    console.log(`\nDone. Installed ${vsixName} into ${name}.`);
    installed = true;
    break;
  } catch (_) {}
}
if (!installed) {
  console.log(`\nPackaged ${vsixName}. Install manually:`);
  console.log('  Cursor:       cursor --install-extension ' + vsixName + ' --force');
  console.log('  VS Code:      code --install-extension ' + vsixName + ' --force');
  console.log('  Antigravity:  antigravity --install-extension ' + vsixName + ' --force');
  console.log('  Or in any IDE: Ctrl+Shift+P → "Extensions: Install from VSIX..." → choose the file.');
}
console.log('Reload the window (Ctrl+Shift+P → "Developer: Reload Window") to use the new build.');
