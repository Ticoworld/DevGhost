"""
Surgical fix for remaining non-ASCII log lines.
"""
import os, re

def process_file(path, replacements):
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        content = f.read()
    for old, new in replacements:
        content = content.replace(old, new)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f'Fixed: {path}')

process_file('src/visual/CodePhotographer.ts', [
    ('✅ ', '[OK] '),
    ('📄 ', '[INFO] '),
    ('⚠️ ', '[WARN] '),
    ('📸 ', '[SNAPSHOT] '),
    ('«class PNGf»', 'class PNGf') # Non-ascii guillemets
])

process_file('src/managers/sessionManager.ts', [
    ('—', '-') # Em dash
])

process_file('src/managers/contextManager.ts', [
    ('→', '->'),
    ('•', '-')
])

process_file('src/listeners/saveListener.ts', [
    ('dev 💀', 'dev'),
    ('did 🫠', 'did'),
    ('real 😮‍💨', 'real')
])

print('Done.')
