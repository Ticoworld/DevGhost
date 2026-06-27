# DevGhost Testing Guide

This is for one trusted technical tester using VS Code, Cursor, or Antigravity on a personal or non-sensitive repo.

## Who should test

- Someone comfortable installing a VSIX
- Someone willing to test the Cloud-first flow
- Someone with no Gemini API key for the main flow, or someone who wants to validate the legacy commands separately

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
3. Open the workspace and let DevGhost watch your work.
4. If you want to refine context manually, run `DevGhost: Edit Project Details` or `DevGhost: Set Focus`.
5. If you are testing a custom preview or local backend, set `devghost.cloudApiBaseUrl` before drafting.
6. Run `DevGhost: Write a Post Now`.
7. Confirm the post appears in the review-first UI.
8. Use `Copy post`, `Open in Twitter/X`, or `Dismiss` only if you want to.
9. Send feedback.

## Optional legacy check

- If you are specifically validating the old BYOK path, use the hidden legacy commands only for that purpose.
- Do not treat legacy Gemini setup as the main flow.

## If something breaks

- Run `DevGhost: View Logs`.
- If you are testing a custom backend URL, include that value in your report.
- If you are testing a legacy command, say which one you used.
- Send the exact error text and what you were doing.

## Feedback questions

- Was setup clear?
- Did Cloud mode feel trustworthy?
- Did DevGhost interrupt too much?
- Did you understand what it was doing?
- Did the draft feel human?
- Did the draft match your work?
- Did any wording confuse you?
- Did anything break?
- Would you keep it installed?

## Safety warning

- Do not test on client repos or private sensitive repos yet.
- Do not paste company secrets into prompts or feedback.
- DevGhost Cloud sends rich sanitized context, but this is still early testing.
