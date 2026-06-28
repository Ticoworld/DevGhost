# Support

## Where to get help

The primary support path is [GitHub Issues](https://github.com/Ticoworld/DevGhost/issues).

Issues use structured templates. When you open a new issue you will be prompted to choose between a **Bug report** and a **Feature request**. The templates guide you through what to include so nothing important is missing.

Open an issue if you hit a bug, something behaves unexpectedly, or you have a question about how the Cloud-first flow works.

For automatic commit or quota questions, include the output from `DevGhost: Show Last Post Decision` if you can reproduce the issue safely. That summary helps explain whether DevGhost skipped, sent, or accepted a draft without exposing raw code or draft text.

## What to include in a bug report

The bug report template will ask for these automatically. If you are filing outside the template, include:

- The version of DevGhost (check the Extensions panel in your editor)
- Your editor: VS Code, Cursor, or Antigravity, and the version
- Your OS and version
- A clear description of what you did and what happened
- The command you ran, such as `DevGhost: Write a Post Now`, `DevGhost: Set Focus`, or a legacy Gemini command
- Whether you changed `devghost.cloudApiBaseUrl`
- The output from `DevGhost: View Logs`
- The output from `DevGhost: Show Last Post Decision` for automatic skips or quota issues
- The exact error text and what you expected to happen

## What NOT to include

Do not paste any of the following into a GitHub issue:

- Your Gemini API key or any other API key
- Passwords, tokens, or secrets of any kind
- Raw code, raw diffs, prompt text, final draft text, terminal output, or absolute paths
- Client code or proprietary code from repos you do not own

If you need to share log output that might contain file paths, review it first and redact anything you are not comfortable making public.

## Privacy or security concerns

If you have a concern about a privacy or security issue, for example you believe DevGhost sent or stored something it should not have, open a GitHub issue and mark it clearly with `[SECURITY]` or `[PRIVACY]` in the title. Mention whether the issue happened in Cloud mode or legacy mode, and provide as much detail as you can without sharing sensitive data.

At this time there is no private email contact. All support goes through GitHub Issues.
