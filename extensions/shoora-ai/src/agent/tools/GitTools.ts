/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cybershoora Pvt. Ltd. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { AgentContext, IAgentTool, ToolResult } from '../types.js';
import { GitService } from '../../git/GitService.js';

const gitService = new GitService();

/**
 * Tool: git_status
 */
export const GitStatusTool: IAgentTool = {
    name: 'git_status',
    description: 'Get the current Git repository status including current branch, modified/untracked files, and remotes.',
    category: 'git',
    securityLevel: 'safe',
    parameters: {
        type: 'object',
        properties: {}
    },
    async execute(_args: any, _context: AgentContext): Promise<ToolResult> {
        try {
            const status = await gitService.getStatus();
            return {
                success: true,
                output: JSON.stringify(status, null, 2),
                metadata: status
            };
        } catch (err: any) {
            return {
                success: false,
                output: '',
                error: err.message || String(err)
            };
        }
    }
};

/**
 * Tool: git_diff
 */
export const GitDiffTool: IAgentTool = {
    name: 'git_diff',
    description: 'Show git diff of unstaged or staged changes in the workspace.',
    category: 'git',
    securityLevel: 'safe',
    parameters: {
        type: 'object',
        properties: {
            staged: {
                type: 'boolean',
                description: 'Whether to show staged changes diff instead of unstaged. Defaults to false.'
            }
        }
    },
    async execute(args: { staged?: boolean }, _context: AgentContext): Promise<ToolResult> {
        try {
            const diff = await gitService.getDiff(args.staged === true);
            return {
                success: true,
                output: diff
            };
        } catch (err: any) {
            return {
                success: false,
                output: '',
                error: err.message || String(err)
            };
        }
    }
};

/**
 * Tool: git_create_branch
 */
export const GitCreateBranchTool: IAgentTool = {
    name: 'git_create_branch',
    description: 'Create and switch to a new git branch.',
    category: 'git',
    securityLevel: 'sensitive',
    parameters: {
        type: 'object',
        properties: {
            branchName: {
                type: 'string',
                description: 'The name of the new branch (e.g. "feat/add-auth" or "fix/login-bug").'
            },
            checkout: {
                type: 'boolean',
                description: 'Whether to switch to the new branch immediately (default: true).'
            }
        },
        required: ['branchName']
    },
    async execute(args: { branchName: string; checkout?: boolean }, _context: AgentContext): Promise<ToolResult> {
        try {
            const output = await gitService.createBranch(args.branchName, args.checkout !== false);
            return {
                success: true,
                output
            };
        } catch (err: any) {
            return {
                success: false,
                output: '',
                error: err.message || String(err)
            };
        }
    }
};

/**
 * Tool: git_checkout
 */
export const GitCheckoutTool: IAgentTool = {
    name: 'git_checkout',
    description: 'Switch to an existing git branch.',
    category: 'git',
    securityLevel: 'sensitive',
    parameters: {
        type: 'object',
        properties: {
            branchName: {
                type: 'string',
                description: 'The existing branch name to switch to.'
            }
        },
        required: ['branchName']
    },
    async execute(args: { branchName: string }, _context: AgentContext): Promise<ToolResult> {
        try {
            const output = await gitService.checkout(args.branchName);
            return {
                success: true,
                output
            };
        } catch (err: any) {
            return {
                success: false,
                output: '',
                error: err.message || String(err)
            };
        }
    }
};

/**
 * Tool: git_commit
 */
export const GitCommitTool: IAgentTool = {
    name: 'git_commit',
    description: 'Stage modified/untracked files and create a new Git commit with a descriptive message.',
    category: 'git',
    securityLevel: 'sensitive',
    parameters: {
        type: 'object',
        properties: {
            message: {
                type: 'string',
                description: 'The commit message describing the changes made.'
            },
            stageAll: {
                type: 'boolean',
                description: 'Whether to stage all modified and untracked files before committing (default: true).'
            }
        },
        required: ['message']
    },
    async execute(args: { message: string; stageAll?: boolean }, _context: AgentContext): Promise<ToolResult> {
        try {
            const output = await gitService.commit(args.message, args.stageAll !== false);
            return {
                success: true,
                output
            };
        } catch (err: any) {
            return {
                success: false,
                output: '',
                error: err.message || String(err)
            };
        }
    }
};

/**
 * Tool: git_push
 */
export const GitPushTool: IAgentTool = {
    name: 'git_push',
    description: 'Push commits from local branch to the remote repository (e.g. origin/main).',
    category: 'git',
    securityLevel: 'sensitive',
    parameters: {
        type: 'object',
        properties: {
            remote: {
                type: 'string',
                description: 'The remote name (defaults to "origin").'
            },
            branch: {
                type: 'string',
                description: 'The branch to push (defaults to current branch).'
            },
            setUpstream: {
                type: 'boolean',
                description: 'Whether to set tracking upstream branch with -u (default: true).'
            }
        }
    },
    async execute(args: { remote?: string; branch?: string; setUpstream?: boolean }, _context: AgentContext): Promise<ToolResult> {
        try {
            const output = await gitService.push(args.remote || 'origin', args.branch, args.setUpstream !== false);
            return {
                success: true,
                output
            };
        } catch (err: any) {
            return {
                success: false,
                output: '',
                error: err.message || String(err)
            };
        }
    }
};

/**
 * Tool: git_pull
 */
export const GitPullTool: IAgentTool = {
    name: 'git_pull',
    description: 'Fetch and merge changes from the remote repository to current local branch.',
    category: 'git',
    securityLevel: 'sensitive',
    parameters: {
        type: 'object',
        properties: {
            remote: {
                type: 'string',
                description: 'The remote name (defaults to "origin").'
            },
            branch: {
                type: 'string',
                description: 'The remote branch name.'
            }
        }
    },
    async execute(args: { remote?: string; branch?: string }, _context: AgentContext): Promise<ToolResult> {
        try {
            const output = await gitService.pull(args.remote || 'origin', args.branch);
            return {
                success: true,
                output
            };
        } catch (err: any) {
            return {
                success: false,
                output: '',
                error: err.message || String(err)
            };
        }
    }
};

export const GIT_TOOLS: IAgentTool[] = [
    GitStatusTool,
    GitDiffTool,
    GitCreateBranchTool,
    GitCheckoutTool,
    GitCommitTool,
    GitPushTool,
    GitPullTool
];
