# DevGhost

DevGhost is a VS Code extension that watches real coding activity and suggests build-in-public drafts when it detects meaningful progress. Every draft is shown for review first. DevGhost never posts automatically.

This is a beta build.

## What it does

- Watches local coding signals: file edits, saves, terminal commands, commit activity, and session timing
- Scores your session locally before deciding whether a draft is worth suggesting
- Suggests a draft for review when the signal is strong enough
- Lets you copy a draft or open a draft on X only after you choose to
- Never posts automatically

## What it does not do

- Does not post to X, Twitter, or any platform automatically
- Does not send code or context to AI on every save or edit
- Does not have a cloud mode
- Does not manage billing or API quotas
- Does not replace your judgment

## What DevGhost watches locally

DevGhost tracks the following signals in memory and in VS Code's workspaceState for the current workspace:

- Which files you edit and save (file paths and language IDs, not file content)
- Terminal command exit codes (success or failure) to detect friction and recovery
- Session timing and active coding duration
- Git commit hashes, messages, and file change counts (read from your local git repo)
- Your current focus and project name (which you set manually)

DevGhost does not read file content line by line. When you choose to generate a draft, selected context is assembled and sent to Gemini. See below.

## What gets sent to Gemini

When you trigger a draft (manually or after DevGhost decides the signal is strong enough), the following may be sent to the Gemini API:

- Your current project name and goal
- Your current focus
- Recent commit message and basic change stats (additions, deletions, file count)
- A summary of recently touched file types (not file content)
- Your baseline project summary (which you generated when setting up the project)

DevGhost does **not** send raw file diffs or full source code unless you explicitly generate a baseline that includes them.

DevGhost sanitizes obvious secrets (API keys, passwords, env-style patterns) and skips files in sensitive paths before assembling context. However, sanitization is not a guarantee. **Use DevGhost on personal or non-client repos until you are comfortable with what is being sent.**

## Privacy and trust

- You bring your own Gemini API key
- The key is stored in VS Code's SecretStorage — not in any file, not in logs, not sent anywhere by DevGhost
- Drafts are always shown for review before any action is taken
- DevGhost never posts automatically
- There is no cloud sync or external DevGhost server
- DevGhost does not sell or share your data

## How to clear your AI key

Run `DevGhost: Clear AI Key` from the command palette. The key is removed from SecretStorage immediately.

## How to reset project context and activity

- `DevGhost: Reset Project Context` — clears the project setup and baseline summary for this workspace
- `DevGhost: Reset Recent Activity` — clears the in-memory session signals without affecting the project setup

## Supported editors

- VS Code
- Cursor
- Antigravity

## Known limitations

- Requires a personal Gemini API key (free tier available)
- Sanitization reduces risk but does not guarantee all sensitive content is excluded
- No cloud sync
- No billing management
- No posting to any platform

## Quick start

1. Install the VSIX.
2. Open a personal repo.
3. Run `DevGhost: Add AI Key` and enter your Gemini key.
4. Run `DevGhost: Set Up Project` to set up your project context.
5. Run `DevGhost: Set Current Focus` to tell DevGhost what you are working on.
6. Code normally.
7. When DevGhost detects enough signal, it will suggest a draft for review.

## Local development

```bash
npm install
npm run compile
```

- Press `F5` in VS Code to launch the Extension Development Host
- Run `npm run package` to build a VSIX
