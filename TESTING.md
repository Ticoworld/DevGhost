# DevGhost Testing Guide

This is for one trusted technical tester using VS Code, Cursor, or Antigravity on a personal or non-sensitive repo.

## Who should test

- Someone comfortable installing a VSIX
- Someone with a working Gemini or other supported AI key
- Someone willing to test on a repo that does not contain client secrets or private code

## Install the VSIX

### Windows or Linux

1. Open the Command Palette with `Ctrl + Shift + P`.
2. Run `Extensions: Install from VSIX`.
3. Pick the DevGhost `.vsix` file.

### Mac

1. Open the Command Palette with `Cmd + Shift + P`.
2. Run `Extensions: Install from VSIX`.
3. Pick the DevGhost `.vsix` file.

## Main test flow

1. Install the VSIX.
2. Open a personal repo.
3. Add your AI key with `DevGhost: Add AI Key`.
4. Set up the project with `DevGhost: Set Up Project`.
5. Set your current focus with `DevGhost: Set Current Focus`.
6. Code normally and let DevGhost watch for meaningful progress.
7. If DevGhost suggests a draft, review it first.
8. Use `Copy draft` or `Open X draft` only if you want to.
9. Send feedback.

## If something breaks

- Run `DevGhost: Show Logs`.
- Run `DevGhost: Check AI Setup`.
- Send the exact error text and what you were doing.

## Feedback questions

- Was setup clear?
- Did DevGhost interrupt too much?
- Did you understand what it was doing?
- Did it feel trustworthy?
- Did the draft feel human?
- Did the draft match your work?
- Did any wording confuse you?
- Did anything break?
- Would you keep it installed?

## Safety warning

- Do not test on client repos or private sensitive repos yet.
- Do not paste company secrets into prompts or feedback.
- DevGhost sanitizes inputs, but this is still early testing.
