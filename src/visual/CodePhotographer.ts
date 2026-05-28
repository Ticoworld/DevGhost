import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as shiki from 'shiki';

// Canvas is optional - gracefully handle if not installed
let canvas: any = null;
try {
    canvas = require('canvas');
} catch (e) {
    console.log('[CodePhotographer] Canvas not available, will use HTML fallback');
}

/**
 * CodePhotographer - Generates Carbon-style code screenshots
 * 
 * Phase 9A: The Visual Engine
 * Creates beautiful, shareable code images for build-in-public drafts.
 */
export class CodePhotographer {
    private highlighter: shiki.Highlighter | null = null;
    private snapshotsDir: string;

    constructor(workspaceRoot: string, snapshotsDir?: string) {
        this.snapshotsDir = snapshotsDir ?? path.join(workspaceRoot, 'snapshots');
    }

    /**
     * Initialize Shiki highlighter (lazy load).
     */
    private async getHighlighter(): Promise<shiki.Highlighter> {
        if (!this.highlighter) {
            this.highlighter = await shiki.createHighlighter({
                themes: ['github-dark'],
                langs: ['typescript', 'javascript', 'tsx', 'jsx', 'python', 'rust', 'go', 'java', 'cpp', 'c', 'html', 'css', 'json', 'yaml', 'markdown']
            });
        }
        return this.highlighter;
    }

    /**
     * Generate a Carbon-style code image.
     * 
     * @param code The code to render
     * @param language Programming language (for syntax highlighting)
     * @param filename File name to display in window title
     * @returns Path to generated image file
     */
    async generateCodeImage(
        code: string,
        language: string,
        filename: string
    ): Promise<string> {
        console.log(`[CodePhotographer] Generating image for ${filename} (${language})`);

        if (!fs.existsSync(this.snapshotsDir)) {
            fs.mkdirSync(this.snapshotsDir, { recursive: true });
        }

        const highlighter = await this.getHighlighter();
        const html = highlighter.codeToHtml(code, {
            lang: language as any,
            theme: 'github-dark'
        });

        if (canvas && canvas.createCanvas) {
            return await this.generateWithCanvas(code, language, filename, html, this.snapshotsDir);
        } else {
            return await this.generateHTMLFallback(code, language, filename, html, this.snapshotsDir);
        }
    }

    /**
     * Generate image using canvas (if available).
     */
    private async generateWithCanvas(
        code: string,
        _language: string,
        filename: string,
        html: string,
        snapshotsDir: string
    ): Promise<string> {
        const tokens = this.parseShikiHTML(html);

        // Canvas dimensions (Twitter-optimized)
        const width = 1200;
        const height = 800;
        const windowPadding = 50;
        const codePadding = 40;

        const canvasInstance = canvas.createCanvas(width, height);
        const ctx = canvasInstance.getContext('2d');

        // Draw gradient background (Carbon-style purple/blue)
        const bgGradient = ctx.createLinearGradient(0, 0, width, height);
        bgGradient.addColorStop(0, '#667eea'); // Purple
        bgGradient.addColorStop(1, '#764ba2'); // Dark purple
        ctx.fillStyle = bgGradient;
        ctx.fillRect(0, 0, width, height);

        // Draw window container (macOS style)
        const windowX = windowPadding;
        const windowY = windowPadding;
        const windowWidth = width - (windowPadding * 2);
        const windowHeight = height - (windowPadding * 2);

        // Window background (dark)
        ctx.fillStyle = '#1e1e1e';
        this.roundRect(ctx, windowX, windowY, windowWidth, windowHeight, 12);
        ctx.fill();

        // Draw window chrome (macOS traffic lights)
        const trafficLightY = windowY + 20;
        const trafficLightRadius = 6;
        const trafficLightSpacing = 20;

        // Red
        ctx.fillStyle = '#ff5f56';
        ctx.beginPath();
        ctx.arc(windowX + 20, trafficLightY, trafficLightRadius, 0, Math.PI * 2);
        ctx.fill();

        // Yellow
        ctx.fillStyle = '#ffbd2e';
        ctx.beginPath();
        ctx.arc(windowX + 20 + trafficLightSpacing, trafficLightY, trafficLightRadius, 0, Math.PI * 2);
        ctx.fill();

        // Green
        ctx.fillStyle = '#27c93f';
        ctx.beginPath();
        ctx.arc(windowX + 20 + (trafficLightSpacing * 2), trafficLightY, trafficLightRadius, 0, Math.PI * 2);
        ctx.fill();

        // Draw filename
        ctx.fillStyle = '#888';
        ctx.font = '14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.fillText(filename, windowX + 80, trafficLightY + 5);

        // Code area
        const codeX = windowX + codePadding;
        const codeY = windowY + 60;
        const codeHeight = windowHeight - 80;

        // Draw code with syntax highlighting
        const fontSize = 16;
        const lineHeight = 24;
        const fontFamily = 'JetBrains Mono, "Fira Code", Consolas, monospace';

        ctx.font = `${fontSize}px ${fontFamily}`;
        ctx.textBaseline = 'top';

        let currentY = codeY;
        const maxLines = Math.floor(codeHeight / lineHeight);
        const lines = code.split('\n').slice(0, maxLines);

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineTokens = tokens[i] || [{ text: line, color: '#d4d4d4' }];

            let currentX = codeX;

            for (const token of lineTokens) {
                ctx.fillStyle = token.color || '#d4d4d4';
                ctx.fillText(token.text, currentX, currentY);
                currentX += ctx.measureText(token.text).width;
            }

            currentY += lineHeight;

            if (currentY > codeY + codeHeight) break;
        }

        // Draw drop shadow effect
        ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
        ctx.shadowBlur = 20;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 10;

        // Save image
        const imagePath = path.join(snapshotsDir, `code-${Date.now()}.png`);
        const buffer = canvasInstance.toBuffer('image/png');
        fs.writeFileSync(imagePath, buffer);

        console.log(`[CodePhotographer] [OK] Image saved: ${imagePath}`);
        return imagePath;
    }

    /**
     * Fallback: Generate HTML file (user can screenshot manually or we'll improve this later).
     */
    private async generateHTMLFallback(
        _code: string,
        _language: string,
        filename: string,
        html: string,
        snapshotsDir: string
    ): Promise<string> {
        // Generate beautiful HTML with Carbon-style styling
        const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=1200, initial-scale=1.0">
    <title>${filename} - DevGhost Code Snapshot</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            padding: 50px;
        }
        .window {
            background: #1e1e1e;
            border-radius: 12px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
            width: 1100px;
            overflow: hidden;
        }
        .window-header {
            background: #2d2d2d;
            padding: 15px 20px;
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .traffic-lights {
            display: flex;
            gap: 8px;
        }
        .traffic-light {
            width: 12px;
            height: 12px;
            border-radius: 50%;
        }
        .red { background: #ff5f56; }
        .yellow { background: #ffbd2e; }
        .green { background: #27c93f; }
        .filename {
            color: #888;
            font-size: 14px;
            margin-left: 10px;
        }
        .code-container {
            padding: 40px;
            overflow-x: auto;
        }
        pre {
            margin: 0;
            font-size: 16px;
            line-height: 24px;
        }
        code {
            font-family: inherit;
        }
    </style>
</head>
<body>
    <div class="window">
        <div class="window-header">
            <div class="traffic-lights">
                <div class="traffic-light red"></div>
                <div class="traffic-light yellow"></div>
                <div class="traffic-light green"></div>
            </div>
            <span class="filename">${filename}</span>
        </div>
        <div class="code-container">
            ${html}
        </div>
    </div>
</body>
</html>`;

        const htmlPath = path.join(snapshotsDir, `code-${Date.now()}.html`);
        fs.writeFileSync(htmlPath, htmlContent);

        console.log(`[CodePhotographer] [OK] HTML saved: ${htmlPath}`);
        console.log(`[CodePhotographer] [INFO] Opening HTML in default browser (Canvas not available - using safe mode)`);

        // Open HTML in default browser (platform-specific)
        const cp = require('child_process');
        const platform = process.platform;
        
        try {
            if (platform === 'win32') {
                // Windows: use 'start' command
                cp.exec(`start "" "${htmlPath}"`);
            } else if (platform === 'darwin') {
                // macOS: use 'open' command
                cp.exec(`open "${htmlPath}"`);
            } else {
                // Linux: use 'xdg-open' command
                cp.exec(`xdg-open "${htmlPath}"`);
            }
            console.log(`[CodePhotographer] [OK] HTML opened in browser`);
        } catch (error) {
            console.error(`[CodePhotographer] [WARN] Failed to open browser: ${error}`);
            // Fallback: open in VS Code
            const uri = vscode.Uri.file(htmlPath);
            await vscode.commands.executeCommand('vscode.open', uri);
        }

        // Return the HTML path (extension.ts will handle this differently)
        return htmlPath;
    }

    /**
     * Parse Shiki HTML output into tokens with colors.
     * Shiki outputs HTML like: <span style="color: #...">text</span>
     */
    private parseShikiHTML(html: string): Array<Array<{ text: string; color: string }>> {
        const lines: Array<Array<{ text: string; color: string }>> = [];
        const htmlLines = html.split('\n');

        for (const htmlLine of htmlLines) {
            const tokens: Array<{ text: string; color: string }> = [];
            
            // Match all spans with style attributes
            const spanRegex = /<span[^>]*style="color:\s*([^"]+)"[^>]*>([^<]*)<\/span>/g;
            let match;
            let lastIndex = 0;

            while ((match = spanRegex.exec(htmlLine)) !== null) {
                // Add any text before this span
                if (match.index > lastIndex) {
                    const beforeText = htmlLine.substring(lastIndex, match.index).replace(/<[^>]*>/g, '');
                    if (beforeText) {
                        tokens.push({ text: beforeText, color: '#d4d4d4' });
                    }
                }

                const color = this.cssColorToHex(match[1]);
                const text = match[2];
                tokens.push({ text, color });
                lastIndex = match.index + match[0].length;
            }

            // Add remaining text after last span
            if (lastIndex < htmlLine.length) {
                const afterText = htmlLine.substring(lastIndex).replace(/<[^>]*>/g, '');
                if (afterText) {
                    tokens.push({ text: afterText, color: '#d4d4d4' });
                }
            }

            // If no tokens found, use plain text
            if (tokens.length === 0) {
                const plainText = htmlLine.replace(/<[^>]*>/g, '');
                if (plainText) {
                    tokens.push({ text: plainText, color: '#d4d4d4' });
                }
            }

            lines.push(tokens);
        }

        return lines;
    }

    /**
     * Convert CSS color to hex.
     */
    private cssColorToHex(cssColor: string): string {
        cssColor = cssColor.trim();

        // Already hex
        if (cssColor.startsWith('#')) {
            return cssColor;
        }

        // RGB/RGBA
        const rgbMatch = cssColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        if (rgbMatch) {
            const r = parseInt(rgbMatch[1]);
            const g = parseInt(rgbMatch[2]);
            const b = parseInt(rgbMatch[3]);
            return `#${[r, g, b].map(x => x.toString(16).padStart(2, '0')).join('')}`;
        }

        // Named colors (basic)
        const namedColors: { [key: string]: string } = {
            'white': '#ffffff',
            'black': '#000000',
            'red': '#ff0000',
            'green': '#00ff00',
            'blue': '#0000ff',
            'yellow': '#ffff00',
            'cyan': '#00ffff',
            'magenta': '#ff00ff'
        };

        return namedColors[cssColor.toLowerCase()] || '#d4d4d4';
    }

    /**
     * Copy image to clipboard (platform-specific).
     */
    async copyImageToClipboard(imagePath: string): Promise<void> {
        // Check if it's an HTML file (fallback mode)
        if (imagePath.endsWith('.html')) {
            console.log(`[CodePhotographer] [INFO] HTML file opened in browser. Ready for screenshot.`);
            // HTML already opened in browser by generateHTMLFallback
            // Just show a friendly message
            vscode.window.showInformationMessage(
                `[SNAPSHOT] Code preview opened in browser! Press Win+Shift+S (Windows) or Cmd+Shift+4 (Mac) to screenshot, then paste in Twitter.`,
                'Open File Location'
            ).then(selection => {
                if (selection === 'Open File Location') {
                    vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(imagePath));
                }
            });
            return;
        }

        // It's a PNG image - copy to clipboard
        const cp = require('child_process');
        const platform = process.platform;

        try {
            if (platform === 'win32') {
                // Windows: use PowerShell to copy image
                const script = `
                    Add-Type -AssemblyName System.Windows.Forms
                    $img = [System.Drawing.Image]::FromFile("${imagePath.replace(/\\/g, '/')}")
                    $bmp = New-Object System.Drawing.Bitmap($img)
                    [System.Windows.Forms.Clipboard]::SetImage($bmp)
                    $img.Dispose()
                `;
                cp.execSync(`powershell -Command "${script}"`, { encoding: 'utf-8' });
            } else if (platform === 'darwin') {
                // macOS: use pbcopy with image
                cp.execSync(`osascript -e 'set the clipboard to (read file POSIX file "${imagePath}" as «class PNGf»)'`);
            } else {
                // Linux: use xclip
                cp.execSync(`xclip -selection clipboard -t image/png -i "${imagePath}"`);
            }
            console.log(`[CodePhotographer] [OK] Image copied to clipboard`);
        } catch (error) {
            console.error(`[CodePhotographer] [WARN] Failed to copy to clipboard: ${error}`);
            // Fallback: show file path
            vscode.window.showInformationMessage(`Image saved: ${imagePath}`);
        }
    }

    /**
     * Helper: Draw rounded rectangle.
     */
    private roundRect(
        ctx: any, // CanvasRenderingContext2D (from optional canvas)
        x: number,
        y: number,
        width: number,
        height: number,
        radius: number
    ): void {
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + width - radius, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        ctx.lineTo(x + radius, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
    }
}
