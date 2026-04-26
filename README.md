# DevGhost

DevGhost is a VS Code-style extension that watches real coding activity and suggests build-in-public drafts when it notices meaningful progress.

## What it does

- Watches project context and local work signals
- Detects meaningful progress, friction, and recovery
- Suggests a draft for review first
- Lets you copy a draft or open an X draft only after you choose it
- Never posts automatically

## What it does not do

- Does not post automatically
- Does not make manual drafting the main flow
- Does not send every edit or save to AI
- Does not replace your review
- Does not support cloud mode yet
- Does not manage billing

## Privacy and trust

- You bring your own AI key for now
- The key is stored in VS Code SecretStorage
- Selected workspace context may be sent to the AI provider
- DevGhost sanitizes obvious secrets, sensitive files, and private paths before AI calls
- Test on a personal or non-sensitive repo first
- DevGhost never posts automatically

## Supported editors

- VS Code
- Cursor
- Antigravity

## Local development

```bash
npm install
npm run compile
```

- Press `F5` in VS Code to launch the Extension Development Host
- Run `npm run package` to build a VSIX

## Tester quick start

1. Install the VSIX.
2. Open a personal repo.
3. Add your AI key.
4. Set up the project.
5. Set your current focus.
6. Code normally.
7. Review any draft DevGhost suggests.
