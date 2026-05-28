"""
Surgical ASCII log fix for DevGhost 3.3.11 release prep.
Read-fix: replace all unicode/emoji in outputChannel.appendLine calls.
"""
import re

def fix_file(path, replacements):
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        content = f.read()
    for old, new in replacements:
        content = content.replace(old, new)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f'Fixed: {path}')

# ── gitManager.ts ────────────────────────────────────────────────────────────
git_path = 'src/managers/gitManager.ts'
with open(git_path, 'r', encoding='utf-8', errors='replace') as f:
    lines = f.readlines()

new_lines = []
skip_to = -1
for i, line in enumerate(lines):
    lineno = i + 1
    if lineno < skip_to:
        continue
    skip_to = -1

    # Line 98: ✓ Git integration enabled
    if lineno == 98:
        new_lines.append("                this.outputChannel.appendLine('[DevGhost] [OK] Git integration enabled');\n")
    # Line 107: ✓ Git repository detected
    elif lineno == 107:
        new_lines.append("                    this.outputChannel.appendLine('[DevGhost] [OK] Git repository detected');\n")
    # Lines 337–342: COMMIT DETECTED banner (lines 336 is the empty appendLine, keep it)
    elif lineno == 337:
        new_lines.append("        this.outputChannel.appendLine('## [COMMIT DETECTED]');\n")
    elif lineno == 338:
        new_lines.append("        this.outputChannel.appendLine('Hash: ' + analysis.hash);\n")
    elif lineno == 339:
        new_lines.append("        this.outputChannel.appendLine('Message: ' + analysis.message);\n")
    elif lineno == 340:
        new_lines.append("        this.outputChannel.appendLine('Changes: +' + analysis.additions + ' / -' + analysis.deletions + ' (' + analysis.filesChanged + ' files)');\n")
    elif lineno == 341:
        new_lines.append("        this.outputChannel.appendLine('--------------------------');\n")
    elif lineno == 342:
        pass  # skip old closing box line
    # Lines 347–351: PIVOT banner
    elif lineno == 347:
        new_lines.append("            this.outputChannel.appendLine('## [PIVOT DETECTED]');\n")
    elif lineno == 348:
        new_lines.append("            this.outputChannel.appendLine('Heavy refactor: -' + analysis.deletions + ' lines');\n")
    elif lineno == 349:
        new_lines.append("            this.outputChannel.appendLine('What is the new vision?');\n")
    elif lineno == 350:
        new_lines.append("            this.outputChannel.appendLine('--------------------------');\n")
    elif lineno == 351:
        pass  # skip old closing box line
    # Lines 364–368: DEEP WORK banner
    elif lineno == 364:
        new_lines.append("            this.outputChannel.appendLine('## [DEEP WORK SESSION]');\n")
    elif lineno == 365:
        new_lines.append("            this.outputChannel.appendLine(analysis.sessionMinutes + ' minutes of focused work');\n")
    elif lineno == 366:
        new_lines.append("            this.outputChannel.appendLine('Commit recorded. DevGhost will evaluate whether it is worth a draft.');\n")
    elif lineno == 367:
        new_lines.append("            this.outputChannel.appendLine('--------------------------------------------------------------------');\n")
    elif lineno == 368:
        pass  # skip old closing box line
    else:
        new_lines.append(line)

with open(git_path, 'w', encoding='utf-8') as f:
    f.writelines(new_lines)
print(f'Fixed: {git_path}')

# ── sessionManager.ts ─────────────────────────────────────────────────────────
sess_path = 'src/managers/sessionManager.ts'
with open(sess_path, 'r', encoding='utf-8', errors='replace') as f:
    lines = f.readlines()

new_lines = []
for i, line in enumerate(lines):
    lineno = i + 1
    if lineno == 209:
        new_lines.append("            this.outputChannel.appendLine('[DevGhost] [OK] Shell Integration monitoring enabled');\n")
    elif lineno == 211:
        new_lines.append("            this.outputChannel.appendLine('[DevGhost] [WARN] Shell Integration not available');\n")
    elif lineno == 279:
        new_lines.append("        this.outputChannel.appendLine(`[DevGhost] [FAIL] Struggle recorded: \"${this.truncate(event.command, 40)}\"`);\n")
    elif lineno == 294:
        new_lines.append("        this.outputChannel.appendLine(`[DevGhost] [OK] Success (unrelated): \"${this.truncate(event.command, 40)}\"`);\n")
    elif lineno == 314:
        new_lines.append("        this.outputChannel.appendLine('## [VERIFIED WIN]');\n")
    elif lineno == 319:
        new_lines.append("        this.outputChannel.appendLine('--------------------------');\n")
    else:
        new_lines.append(line)

with open(sess_path, 'w', encoding='utf-8') as f:
    f.writelines(new_lines)
print(f'Fixed: {sess_path}')

# ── contextManager.ts ─────────────────────────────────────────────────────────
ctx_path = 'src/managers/contextManager.ts'
with open(ctx_path, 'r', encoding='utf-8', errors='replace') as f:
    content = f.read()
content = content.replace(
    "this.outputChannel.appendLine('[DevGhost] \u2713 Baseline summary saved');",
    "this.outputChannel.appendLine('[DevGhost] [OK] Baseline summary saved');"
)
with open(ctx_path, 'w', encoding='utf-8') as f:
    f.write(content)
print(f'Fixed: {ctx_path}')

# ── saveListener.ts ────────────────────────────────────────────────────────────
save_path = 'src/listeners/saveListener.ts'
with open(save_path, 'r', encoding='utf-8', errors='replace') as f:
    lines = f.readlines()

new_lines = []
for i, line in enumerate(lines):
    lineno = i + 1
    if lineno == 188:
        new_lines.append("        this.outputChannel.appendLine('## [BREAKTHROUGH DETECTED]');\n")
    elif lineno == 191:
        new_lines.append("        this.outputChannel.appendLine('--------------------------');\n")
    elif lineno == 217:
        new_lines.append("        this.outputChannel.appendLine('--- Generated Draft ---');\n")
    elif lineno == 219:
        new_lines.append("        this.outputChannel.appendLine('-----------------------');\n")
    elif lineno == 227:
        new_lines.append("            this.outputChannel.appendLine(`[DevGhost] [ERROR] Gemini failed: ${errorMessage}`);\n")
    elif lineno == 234:
        new_lines.append("            this.outputChannel.appendLine('--- Fallback Draft ---');\n")
    elif lineno == 236:
        new_lines.append("            this.outputChannel.appendLine('----------------------');\n")
    else:
        new_lines.append(line)

with open(save_path, 'w', encoding='utf-8') as f:
    f.writelines(new_lines)
print(f'Fixed: {save_path}')

print('\nAll ASCII log fixes applied.')
