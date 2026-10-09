/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cybershoora Pvt. Ltd. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface GitStatusSummary {
    isGitRepo: boolean;
    currentBranch?: string;
    remotes: { name: string; url: string }[];
    isClean: boolean;
    stagedCount: number;
    unstagedCount: number;
    untrackedCount: number;
    aheadCount: number;
    behindCount: number;
    summary: string;
}

export class GitService {
    constructor() {}

    private getWorkspaceRoot(): string {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) {
            throw new Error('No workspace folder is currently open in SHOORA TETHER.');
        }
        return root;
    }

    /**
     * Run a git command in the workspace root with error handling.
     */
    public async execGit(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        const targetDir = cwd || this.getWorkspaceRoot();
        return new Promise((resolve, reject) => {
            cp.execFile('git', args, { cwd: targetDir, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
                const exitCode = err ? (err.code || 1) : 0;
                if (err && typeof exitCode === 'number' && exitCode !== 0) {
                    resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode });
                } else if (err) {
                    reject(err);
                } else {
                    resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 });
                }
            });
        });
    }

    /**
     * Check if current workspace has a git repository.
     */
    public isRepo(): boolean {
        const root = this.getWorkspaceRoot();
        return fs.existsSync(path.join(root, '.git'));
    }

    /**
     * Initialize git in the workspace.
     */
    public async init(): Promise<string> {
        const res = await this.execGit(['init']);
        if (res.exitCode !== 0) {
            throw new Error(`git init failed: ${res.stderr}`);
        }
        return res.stdout || 'Initialized empty Git repository.';
    }

    /**
     * Get detailed status of the workspace.
     */
    public async getStatus(): Promise<GitStatusSummary> {
        if (!this.isRepo()) {
            return {
                isGitRepo: false,
                remotes: [],
                isClean: true,
                stagedCount: 0,
                unstagedCount: 0,
                untrackedCount: 0,
                aheadCount: 0,
                behindCount: 0,
                summary: 'Workspace is not a Git repository.'
            };
        }

        // Branch name
        let currentBranch = 'main';
        const branchRes = await this.execGit(['rev-parse', '--abbrev-ref', 'HEAD']);
        if (branchRes.exitCode === 0 && branchRes.stdout) {
            currentBranch = branchRes.stdout;
        }

        // Remotes
        const remotes: { name: string; url: string }[] = [];
        const remotesRes = await this.execGit(['remote', '-v']);
        if (remotesRes.exitCode === 0 && remotesRes.stdout) {
            const seen = new Set<string>();
            const lines = remotesRes.stdout.split('\n');
            for (const line of lines) {
                const parts = line.split(/\s+/);
                if (parts.length >= 2 && !seen.has(parts[0])) {
                    seen.add(parts[0]);
                    remotes.push({ name: parts[0], url: parts[1] });
                }
            }
        }

        // Porcelains status
        const statusRes = await this.execGit(['status', '--porcelain=v1']);
        let stagedCount = 0;
        let unstagedCount = 0;
        let untrackedCount = 0;

        if (statusRes.exitCode === 0 && statusRes.stdout) {
            const lines = statusRes.stdout.split('\n');
            for (const line of lines) {
                if (!line) continue;
                const index = line[0];
                const worktree = line[1];

                if (index === '?' && worktree === '?') {
                    untrackedCount++;
                } else {
                    if (index !== ' ' && index !== '?') stagedCount++;
                    if (worktree !== ' ' && worktree !== '?') unstagedCount++;
                }
            }
        }

        // Ahead/Behind count
        let aheadCount = 0;
        let behindCount = 0;
        const countRes = await this.execGit(['rev-list', '--left-right', '--count', `${currentBranch}...@{upstream}`]);
        if (countRes.exitCode === 0 && countRes.stdout) {
            const [ahead, behind] = countRes.stdout.split(/\s+/).map(Number);
            aheadCount = isNaN(ahead) ? 0 : ahead;
            behindCount = isNaN(behind) ? 0 : behind;
        }

        const isClean = stagedCount === 0 && unstagedCount === 0 && untrackedCount === 0;
        const summary = isClean
            ? `Working tree clean on branch "${currentBranch}".`
            : `Branch: ${currentBranch} | Staged: ${stagedCount}, Unstaged: ${unstagedCount}, Untracked: ${untrackedCount}`;

        return {
            isGitRepo: true,
            currentBranch,
            remotes,
            isClean,
            stagedCount,
            unstagedCount,
            untrackedCount,
            aheadCount,
            behindCount,
            summary
        };
    }

    /**
     * Create and optionally checkout a new branch.
     */
    public async createBranch(branchName: string, checkout = true): Promise<string> {
        const sanitized = branchName.trim().replace(/\s+/g, '-');
        const args = checkout ? ['checkout', '-b', sanitized] : ['branch', sanitized];
        const res = await this.execGit(args);
        if (res.exitCode !== 0) {
            throw new Error(`Failed to create branch "${sanitized}": ${res.stderr}`);
        }
        return `Switched to a new branch '${sanitized}'.`;
    }

    /**
     * Switch / checkout an existing branch.
     */
    public async checkout(branchName: string): Promise<string> {
        const res = await this.execGit(['checkout', branchName.trim()]);
        if (res.exitCode !== 0) {
            throw new Error(`Failed to checkout "${branchName}": ${res.stderr}`);
        }
        return res.stdout || res.stderr || `Switched to branch '${branchName}'.`;
    }

    /**
     * Stage changes and commit with message.
     */
    public async commit(message: string, stageAll = true): Promise<string> {
        if (!message || !message.trim()) {
            throw new Error('Commit message cannot be empty.');
        }

        if (stageAll) {
            const addRes = await this.execGit(['add', '-A']);
            if (addRes.exitCode !== 0) {
                throw new Error(`git add failed: ${addRes.stderr}`);
            }
        }

        const res = await this.execGit(['commit', '-m', message.trim()]);
        if (res.exitCode !== 0) {
            throw new Error(`git commit failed: ${res.stderr || res.stdout}`);
        }
        return res.stdout || 'Commit successful.';
    }

    /**
     * Push branch to remote.
     */
    public async push(remote = 'origin', branch?: string, setUpstream = true): Promise<string> {
        const currentBranch = branch || (await this.getStatus()).currentBranch || 'main';
        const args = ['push'];
        if (setUpstream) {
            args.push('-u');
        }
        args.push(remote, currentBranch);

        const res = await this.execGit(args);
        if (res.exitCode !== 0) {
            throw new Error(`git push failed: ${res.stderr || res.stdout}`);
        }
        return res.stdout || res.stderr || `Successfully pushed to ${remote}/${currentBranch}.`;
    }

    /**
     * Pull changes from remote.
     */
    public async pull(remote = 'origin', branch?: string): Promise<string> {
        const args = ['pull', remote];
        if (branch) args.push(branch);
        const res = await this.execGit(args);
        if (res.exitCode !== 0) {
            throw new Error(`git pull failed: ${res.stderr || res.stdout}`);
        }
        return res.stdout || 'Already up to date.';
    }

    /**
     * Add a remote URL.
     */
    public async addRemote(name: string, url: string): Promise<string> {
        // If remote already exists, update URL
        const check = await this.execGit(['remote', 'get-url', name]);
        if (check.exitCode === 0) {
            const res = await this.execGit(['remote', 'set-url', name, url]);
            if (res.exitCode !== 0) throw new Error(res.stderr);
            return `Updated remote "${name}" to ${url}`;
        }

        const res = await this.execGit(['remote', 'add', name, url]);
        if (res.exitCode !== 0) {
            throw new Error(`git remote add failed: ${res.stderr}`);
        }
        return `Added remote "${name}" -> ${url}`;
    }

    /**
     * Get diff of changes.
     */
    public async getDiff(staged = false): Promise<string> {
        const args = staged ? ['diff', '--cached'] : ['diff'];
        const res = await this.execGit(args);
        return res.stdout || '(No diff)';
    }
}
