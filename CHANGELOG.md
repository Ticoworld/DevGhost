# Changelog

## 3.3.11 — Beta release candidate

This is a beta build. Not a stable release. Review all drafts before sharing.

### Changes in 3.3.11

- **ASCII-only log output**: All emoji and box-drawing characters removed from output channel logs. Fixes mojibake rendering on Windows hosts.
- **Version bump and packaging hygiene**: Removed dead `canvas` optional dependency. Added `preview: true` flag, keywords, and accurate category tags.
- **Commit story prompt — fact packet voice**: Draft prompts now use a structured fact packet and a plain developer voice rather than a verbose report-style structure.
- **Improved commit voice examples**: Style examples updated to shorter, more natural phrasing.

### What is stable in 3.3.11

- Review-first draft flow: DevGhost always shows a draft for review before any browser handoff. It never posts automatically.
- Startup HEAD baseline guard: Existing commits at extension launch are recorded as baseline and never trigger automatic drafts.
- Signal scoring gate: Local activity is scored before any AI call. Low-signal sessions are skipped.
- API failure logging: Failures are logged cleanly with root cause in the output channel, not exposed in user popups.
- AI key stored in VS Code SecretStorage: The key is never written to disk outside VS Code's own storage.

### Known limitations in 3.3.11

- Requires you to bring your own Gemini API key.
- DevGhost cannot guarantee sanitization of all sensitive content. Use on personal or non-client repos until comfortable.
- No cloud sync.
- No billing management.
- No auto-post to X/Twitter or any platform.
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
