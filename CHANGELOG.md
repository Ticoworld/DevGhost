# Changelog

## 3.4.4 - QA reliability build

- Automatic Cloud draft attempts now leave a metadata-only decision record that can be inspected from the extension.
- A new `Show Last Post Decision` command surfaces the latest skip or accept summary for QA.
- Git startup ordering was tightened so commit callbacks are wired before the Git watcher can settle.
- Manual Cloud drafts now include the latest HEAD commit evidence when it exists.
- Cloud now rejects short headline-only posts more aggressively and retries once with stricter instructions.
- Cloud quota can be put into a QA-friendly high-limit mode through backend configuration.

## 3.4.3 - Quota and post-shape hardening

- Automatic post suggestions now show a calm quota notice once per rolling window instead of going silent.
- Manual post generation still shows quota status clearly when the limit is reached.
- Cloud now rejects malformed post text with dangling backticks, cut-off code fragments, and path-only outputs.
- Invalid post shapes retry once with stricter instructions and then fail safely if they still do not produce a real post.
- The release version was bumped to keep this package distinct from the 3.4.2 test build.

## 3.4.2 - Commit evidence quality fix

- Commit-triggered Cloud posts now receive concrete commit evidence before generation.
- The Cloud prompt now pushes for specific change-based posts instead of generic recap lines.
- Generic commit outputs are retried once and then safely rejected if they are still too vague.
- Focus remains helpful, but it is no longer the only source of truth for commit-triggered posts.
- The focus prompt wording was clarified to better capture what changed.

## 3.4.1 - Release candidate

- Cloud is now the true default for automatic post suggestions.
- Gemini/BYOK is no longer required for normal use.
- Manual command is now `Write a Post Now`.
- User-facing wording now uses post/review/Twitter/X language.
- Visible command surface was cleaned up.
- Privacy/data-use command was added.
- Logs are calmer.

## 3.4.0 - Cloud-first Marketplace release

- DevGhost Cloud is now the default path for new users.
- Users no longer need to bring a Gemini API key to start.
- Cloud drafts use rich sanitized context and give you 3 free generations per rolling 24-hour window.
- DevGhost Cloud stores metadata only in Neon.
- Selected sanitized diff excerpts may be sent transiently when needed for draft quality.
- BYOK commands remain hidden legacy or advanced commands.
- Review-first UX and no-auto-posting remain unchanged.

## Unreleased

## 3.3.11 - Beta release candidate

This is a beta build. Not a stable release. Review all drafts before sharing.

### Changes in 3.3.11

- ASCII-only log output: All emoji and box-drawing characters removed from output channel logs. Fixes mojibake rendering on Windows hosts.
- Version bump and packaging hygiene: Removed dead `canvas` optional dependency. Added `preview: true` flag, keywords, and accurate category tags.
- Commit story prompt - fact packet voice: Draft prompts now use a structured fact packet and a plain developer voice rather than a verbose report-style structure.
- Improved commit voice examples: Style examples updated to shorter, more natural phrasing.

### What is stable in 3.3.11

- Review-first draft flow: DevGhost always shows a draft for review before any browser handoff. It never posts automatically.
- Startup HEAD baseline guard: Existing commits at extension launch are recorded as baseline and never trigger automatic drafts.
- Signal scoring gate: Local activity is scored before any AI call. Low-signal sessions are skipped.
- API failure logging: Failures are logged cleanly with root cause in the output channel, not exposed in user popups.
- Cloud-first onboarding: DevGhost Cloud is the default setup flow, and legacy Gemini/BYOK is no longer part of the main onboarding path.

### Known limitations in 3.3.11

- Cloud drafts are limited to 3 free generations per rolling 24-hour window.
- Sanitization reduces risk but does not guarantee all sensitive content is excluded.
- Legacy Gemini/BYOK commands are hidden from the normal product surface.
- No posting to X/Twitter or any platform.
- Publisher and repository URL are placeholder values. The extension cannot be submitted to the VS Code Marketplace until a real publisher account is registered.

---

## 3.3.9

- Commit freshness analysis: startup HEAD is recorded as baseline so stale commits do not trigger drafts on workspace open.
- Enhanced context handling: improved background summary separation from current commit evidence.

## 3.3.8

- Context handling improvements for drafting process.

## 3.3.6

- Improved commit analysis: better inference of work type and file categories from commit evidence.

## 3.3.5

- Enhanced drafting with commit context and project focus grounding.

## 3.3.2

- Review-first draft flow
- AI key setup and validation
- Auto model discovery and safe model resolution
- Local work signal tracking
- Meaningful-progress scoring for automatic drafts
- Sanitizer and privacy protections before AI calls
- Pause, resume, snooze, reset, and log controls
- VSIX packaging for a trusted tester
