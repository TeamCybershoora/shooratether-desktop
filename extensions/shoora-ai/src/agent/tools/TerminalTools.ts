/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cybershoora Pvt. Ltd. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as cp from 'child_process';
import { AgentContext, IAgentTool, SecurityLevel, ToolResult } from '../types.js';

const DANGEROUS_PATTERNS = [
    /\brm\s+-[rf]{1,2}\b/i,
    /\bdel\s+\/s\s+\/q\b/i,
    /\bformat\s+[a-z]:/i,
    /\bdrop\s+database\b/i,
    /\bdrop\s+table\b/i,
    /\bgit\s+push\b.*(--force|-f)\b/i,
    /\bgit\s+reset\s+--hard\b/i,
    /\bcurl\b.*\|\s*(ba)?sh\b/i,
    /\bwget\b.*\|\s*(ba)?sh\b/i
];

function determineCommandSecurity(command: string): SecurityLevel {
    for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(command)) {
            return 'critical';
        }
    }
    // Read-only or informational commands are safe
    if (/^(git\s+(status|diff|log|branch)|npm\s+(test|run\s+test)|dir|ls|echo|pwd|node\s+-v|python\s+--version)\b/i.test(command.trim())) {
        return 'safe';
    }
    return 'sensitive';
}

/**
 * Tool: run_command
 */
export const RunCommandTool: IAgentTool = {
    name: 'run_command',
    description: 'Execute a terminal shell command in the project workspace root and capture the stdout, stderr, and exit code.',
    category: 'terminal',
    securityLevel: 'sensitive', // dynamically elevated to 'critical' if dangerous command detected
    parameters: {
        type: 'object',
        properties: {
            command: {
                type: 'string',
                description: 'The shell command line string to execute.'
            },
            timeoutSeconds: {
                type: 'number',
                description: 'Timeout in seconds before aborting (default: 60, max: 300).'
            }
        },
        required: ['command']
    },
    async execute(args: { command: string; timeoutSeconds?: number }, context: AgentContext): Promise<ToolResult> {
        const root = context.workspaceRoot || (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath) || process.cwd();
        const timeout = Math.min(Math.max(args.timeoutSeconds || 60, 5), 300) * 1000;

        const effectiveSecurity = determineCommandSecurity(args.command);
        if (effectiveSecurity === 'critical') {
            const approval = await context.securityGuard.requestApproval({
                toolName: 'run_command',
                securityLevel: 'critical',
                arguments: { command: args.command },
                description: `Execute high-risk shell command: "${args.command}"`,
                warning: 'This command matches patterns that can alter, overwrite, or delete data.'
            });

            if (approval === 'rejected') {
                return {
                    success: false,
                    output: '',
                    error: `Command execution rejected by user: "${args.command}"`
                };
            }
        }

        return new Promise<ToolResult>((resolve) => {
            const isWindows = process.platform === 'win32';
            const shell = isWindows ? 'powershell.exe' : '/bin/sh';

            let stdout = '';
            let stderr = '';
            let completed = false;

            const child = cp.spawn(args.command, {
                cwd: root,
                shell,
                env: { ...process.env, CI: 'true', PAGER: 'cat' }
            });

            const timer = setTimeout(() => {
                if (!completed) {
                    completed = true;
                    try { child.kill('SIGTERM'); } catch {}
                    resolve({
                        success: false,
                        output: stdout,
                        error: `Command timed out after ${timeout / 1000} seconds.\nPartial output:\n${stdout}\n${stderr}`
                    });
                }
            }, timeout);

            child.stdout?.on('data', (data) => {
                stdout += data.toString();
                if (stdout.length > 50000) {
                    stdout = stdout.substring(0, 50000) + '\n... [Output truncated at 50KB]';
                }
            });

            child.stderr?.on('data', (data) => {
                stderr += data.toString();
                if (stderr.length > 30000) {
                    stderr = stderr.substring(0, 30000) + '\n... [Stderr truncated at 30KB]';
                }
            });

            child.on('close', (code) => {
                if (completed) return;
                completed = true;
                clearTimeout(timer);

                const success = code === 0;
                const output = (stdout.trim() + (stderr ? '\n' + stderr.trim() : '')).trim();

                resolve({
                    success,
                    output: output || (success ? '(Command completed with exit code 0)' : `(Exited with code ${code})`),
                    error: success ? undefined : `Command failed with exit code ${code}.\n${stderr.trim()}`,
                    metadata: { exitCode: code }
                });
            });

            child.on('error', (err) => {
                if (completed) return;
                completed = true;
                clearTimeout(timer);
                resolve({
                    success: false,
                    output: stdout,
                    error: `Failed to spawn process: ${err.message}`
                });
            });
        });
    }
};

/**
 * Tool: run_tests
 */
export const RunTestsTool: IAgentTool = {
    name: 'run_tests',
    description: 'Execute project test suite (npm test, pytest, etc.) and return test results and errors.',
    category: 'terminal',
    securityLevel: 'safe',
    parameters: {
        type: 'object',
        properties: {
            testCommand: {
                type: 'string',
                description: 'Optional custom test command (e.g. "npm run test:unit"). If omitted, auto-detects from package.json or python test runner.'
            }
        }
    },
    async execute(args: { testCommand?: string }, context: AgentContext): Promise<ToolResult> {
        let cmd = args.testCommand;
        if (!cmd) {
            // Auto detect
            const root = context.workspaceRoot || (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
            const fs = await import('fs');
            const path = await import('path');
            if (root && fs.existsSync(path.join(root, 'package.json'))) {
                cmd = 'npm test';
            } else if (root && (fs.existsSync(path.join(root, 'pytest.ini')) || fs.existsSync(path.join(root, 'tests')))) {
                cmd = 'pytest';
            } else {
                cmd = 'npm test';
            }
        }

        context.log(`Running test command: ${cmd}`);
        return await RunCommandTool.execute({ command: cmd, timeoutSeconds: 120 }, context);
    }
};

export const TERMINAL_TOOLS: IAgentTool[] = [
    RunCommandTool,
    RunTestsTool
];
