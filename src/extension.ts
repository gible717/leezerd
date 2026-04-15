import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';

const START_SECONDS = 0.05;

let daemon: ChildProcess | null = null;
let daemonReady = false;
let lastPlayed = 0;

function getConfig() {
    const cfg = vscode.workspace.getConfiguration('leezerd');
    return {
        enabled:    cfg.get<boolean>('enabled', true),
        cooldownMs: cfg.get<number>('cooldownMs', 0),
    };
}

// Spawn a persistent PowerShell process that keeps the audio loaded.
// Sending one line to its stdin triggers an instant seek+play — no startup cost.
function startDaemon(soundPath: string): Promise<void> {
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
        const safePath = soundPath.replace(/'/g, "''");

        // Load media once; signal READY when it's buffered and seekable
        const initCmd =
            `Add-Type -AssemblyName presentationCore; ` +
            `$p = New-Object system.windows.media.mediaplayer; ` +
            `$p.open('${safePath}'); ` +
            `$p.Volume = 1; ` +
            `Start-Sleep -Milliseconds 600; ` +
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

// Each call is a single stdin line — near-instant, no new process overhead
function triggerPlay(): void {
    if (!daemonReady || !daemon?.stdin) { return; }
    const cmd =
        `$p.Stop(); ` +
        `$p.Position = [System.TimeSpan]::FromSeconds(${START_SECONDS}); ` +
        `$p.Play()\r\n`;
    daemon.stdin.write(cmd);
}

export function activate(context: vscode.ExtensionContext): void {
    const soundPath = path.join(context.extensionPath, 'sounds', 'lizard.mp3');

    startDaemon(soundPath)
        .then(() => {
            vscode.window.showInformationMessage('Leezerd is ready! Type "l" and unleash the lizard.');
        })
        .catch((err: Error) => {
            vscode.window.showErrorMessage(`Leezerd failed to start: ${err.message}`);
        });

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
