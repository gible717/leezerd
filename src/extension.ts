import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';

const START_SECONDS = 0.05;
const PLATFORM = process.platform;

let daemon: ChildProcess | null = null;   // Windows only
let daemonReady = false;                   // Windows only
let lastPlayed = 0;
let soundPath = '';

function getConfig() {
    const cfg = vscode.workspace.getConfiguration('leezerd');
    return {
        enabled:    cfg.get<boolean>('enabled', true),
        cooldownMs: cfg.get<number>('cooldownMs', 0),
    };
}

// ── Windows: persistent PowerShell daemon ──────────────────────────────────
// Loads audio once at startup; each play is a single stdin line — no process
// overhead. Uses MediaOpened event instead of a fixed sleep for fast readiness.
function startWindowsDaemon(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const ps = spawn('powershell', [
            '-NoProfile', '-NonInteractive', '-Command', '-'
        ], { stdio: ['pipe', 'pipe', 'ignore'] });

        daemon = ps;

        if (!ps.stdin || !ps.stdout) {
            reject(new Error('Could not pipe PowerShell stdin/stdout'));
            return;
        }

        // Escape single quotes for PowerShell single-quoted strings
        const safePath = filePath.replace(/'/g, "''");

        // Wait for MediaOpened event instead of a fixed sleep — signals readiness
        // as soon as the file is buffered (typically <200ms for small local files)
        const initCmd =
            `Add-Type -AssemblyName presentationCore; ` +
            `$p = New-Object system.windows.media.mediaplayer; ` +
            `Register-ObjectEvent -InputObject $p -EventName MediaOpened -SourceIdentifier 'MO' | Out-Null; ` +
            `$p.open('${safePath}'); ` +
            `$p.Volume = 1; ` +
            `Wait-Event -SourceIdentifier 'MO' -Timeout 3 | Out-Null; ` +
            `Remove-Event 'MO' -ErrorAction SilentlyContinue; ` +
            `Unregister-Event 'MO' -ErrorAction SilentlyContinue; ` +
            `Write-Host 'READY'\r\n`;

        ps.stdin.write(initCmd);

        const onData = (chunk: Buffer) => {
            if (chunk.toString().includes('READY')) {
                daemonReady = true;
                ps.stdout?.off('data', onData);
                resolve();
            }
        };
        ps.stdout.on('data', onData);
        ps.on('error', reject);
    });
}

function windowsPlay(): void {
    if (!daemonReady || !daemon?.stdin) { return; }
    daemon.stdin.write(
        `$p.Stop(); ` +
        `$p.Position = [System.TimeSpan]::FromSeconds(${START_SECONDS}); ` +
        `$p.Play()\r\n`
    );
}

// ── macOS: afplay (built-in, always available) ─────────────────────────────
function macPlay(): void {
    spawn('afplay', [soundPath], {
        stdio: 'ignore',
        detached: true
    }).unref();
}

// ── Linux: mpg123 ──────────────────────────────────────────────────────────
function linuxPlay(): void {
    spawn('mpg123', ['-q', soundPath], {
        stdio: 'ignore',
        detached: true
    }).unref();
}

function checkMpg123(): Promise<boolean> {
    return new Promise(resolve => {
        const p = spawn('which', ['mpg123'], { stdio: 'ignore' });
        p.on('close', code => resolve(code === 0));
        p.on('error', () => resolve(false));
    });
}

// ── Unified trigger ────────────────────────────────────────────────────────
function triggerPlay(): void {
    if (PLATFORM === 'win32')        { windowsPlay(); }
    else if (PLATFORM === 'darwin')  { macPlay(); }
    else                             { linuxPlay(); }
}

export function activate(context: vscode.ExtensionContext): void {
    soundPath = path.join(context.extensionPath, 'sounds', 'lizard.mp3');

    // Platform-specific startup
    if (PLATFORM === 'win32') {
        startWindowsDaemon(soundPath)
            .then(() => {
                vscode.window.showInformationMessage('Leezerd is ready! Type "l" and unleash the lizard.');
            })
            .catch((err: Error) => {
                vscode.window.showErrorMessage(`Leezerd failed to start: ${err.message}`);
            });

    } else if (PLATFORM === 'darwin') {
        // afplay is always available on macOS — ready immediately
        vscode.window.showInformationMessage('Leezerd is ready! Type "l" and unleash the lizard.');

    } else if (PLATFORM === 'linux') {
        checkMpg123().then(ok => {
            if (ok) {
                vscode.window.showInformationMessage('Leezerd is ready! Type "l" and unleash the lizard.');
            } else {
                vscode.window.showErrorMessage(
                    'Leezerd: mpg123 not found. Install it with: sudo apt install mpg123'
                );
            }
        });

    } else {
        vscode.window.showErrorMessage('Leezerd: unsupported platform.');
    }

    const listener = vscode.workspace.onDidChangeTextDocument(event => {
        const { enabled, cooldownMs } = getConfig();
        if (!enabled) { return; }

        for (const change of event.contentChanges) {
            const typed = change.text;
            if (!typed) { continue; }

            let shouldPlay = false;

            // Trigger 1: any 'l' or 'L' typed
            if (typed === 'l' || typed === 'L') {
                shouldPlay = true;
            }

            // Trigger 2: the word 'lizard' just completed
            if (!shouldPlay) {
                const doc = event.document;
                const insertedLines = typed.split('\n');
                const lastInsertedLine = insertedLines[insertedLines.length - 1];
                const endLine = change.range.start.line + insertedLines.length - 1;
                const endChar = insertedLines.length === 1
                    ? change.range.start.character + lastInsertedLine.length
                    : lastInsertedLine.length;

                if (endLine < doc.lineCount) {
                    const lineText = doc.lineAt(endLine).text;
                    const LIZARD_LEN = 'lizard'.length;
                    if (endChar >= LIZARD_LEN) {
                        const segment = lineText.substring(endChar - LIZARD_LEN, endChar);
                        if (segment.toLowerCase() === 'lizard') {
                            shouldPlay = true;
                        }
                    }
                }
            }

            if (shouldPlay) {
                const now = Date.now();
                if (now - lastPlayed >= cooldownMs) {
                    lastPlayed = now;
                    triggerPlay();
                }
                break;
            }
        }
    });

    context.subscriptions.push(listener);
}

export function deactivate(): void {
    daemonReady = false;
    if (daemon) {
        daemon.stdin?.end();
        daemon.kill();
        daemon = null;
    }
}
