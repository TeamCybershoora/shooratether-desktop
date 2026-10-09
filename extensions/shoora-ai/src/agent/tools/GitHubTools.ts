/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cybershoora Pvt. Ltd. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { AgentContext, IAgentTool, ToolResult } from '../types.js';
import { GitHubService } from '../../github/GitHubService.js';
import { GitService } from '../../git/GitService.js';

const gitService = new GitService();
const githubService = GitHubService.getInstance();

/**
 * Helper to get current repo owner and name from git remotes.
 */
async function resolveCurrentRepoInfo(): Promise<{ owner: string; repo: string } | undefined> {
    const status = await gitService.getStatus();
    for (const remote of status.remotes) {
        const info = githubService.parseGitHubRemote(remote.url);
        if (info) return info;
    }
    return undefined;
}

/**
 * Tool: github_auth_status
 */
export const GitHubAuthStatusTool: IAgentTool = {
    name: 'github_auth_status',
    description: 'Check GitHub connection status and get authenticated user information.',
    category: 'github',
    securityLevel: 'safe',
    parameters: {
        type: 'object',
        properties: {}
    },
    async execute(_args: any, _context: AgentContext): Promise<ToolResult> {
        try {
            const isAuth = await githubService.isAuthenticated();
            if (!isAuth) {
                return {
                    success: false,
                    output: 'Not authenticated with GitHub. Call github_connect or sign in via VS Code Accounts.',
                    metadata: { authenticated: false }
                };
            }

            const user = await githubService.getCurrentUser();
            return {
                success: true,
                output: `Authenticated as GitHub user: @${user.login} (${user.name || user.login}) - ${user.html_url}`,
                metadata: { authenticated: true, user }
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
 * Tool: github_create_repository
 */
export const GitHubCreateRepositoryTool: IAgentTool = {
    name: 'github_create_repository',
    description: 'Create a new GitHub repository for the current project, configure origin remote, and push the code.',
    category: 'github',
    securityLevel: 'sensitive',
    parameters: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: 'The name of the new GitHub repository (e.g. "my-dashboard").'
            },
            description: {
                type: 'string',
                description: 'Optional description of the repository.'
            },
            private: {
                type: 'boolean',
                description: 'Whether the repository should be private. Defaults to true.'
            },
            pushCurrentCode: {
                type: 'boolean',
                description: 'Whether to automatically commit and push the current workspace code to the new repository (defaults to true).'
            }
        },
        required: ['name']
    },
    async execute(args: { name: string; description?: string; private?: boolean; pushCurrentCode?: boolean }, context: AgentContext): Promise<ToolResult> {
        try {
            context.log(`Creating GitHub repository: ${args.name}`);
            const repo = await githubService.createRepository({
                name: args.name,
                description: args.description,
                private: args.private !== false
            });

            const stepsLog: string[] = [
                `✓ Created GitHub repository: ${repo.full_name} (${repo.private ? 'Private' : 'Public'})`,
                `  URL: ${repo.html_url}`
            ];

            if (args.pushCurrentCode !== false) {
                // Initialize Git if needed
                if (!gitService.isRepo()) {
                    await gitService.init();
                    stepsLog.push(`✓ Initialized local Git repository.`);
                }

                // Check status
                const status = await gitService.getStatus();
                if (!status.isClean || status.stagedCount > 0 || status.unstagedCount > 0 || status.untrackedCount > 0) {
                    await gitService.commit('Initial commit by SHOORA TETHER', true);
                    stepsLog.push(`✓ Committed workspace files.`);
                }

                // Set origin remote
                await gitService.addRemote('origin', repo.clone_url);
                stepsLog.push(`✓ Configured origin remote: ${repo.clone_url}`);

                // Push to origin
                try {
                    await gitService.push('origin', status.currentBranch || 'main', true);
                    stepsLog.push(`✓ Successfully pushed code to origin/${status.currentBranch || 'main'}`);
                } catch (pushErr: any) {
                    stepsLog.push(`⚠️ Push note: ${pushErr.message || pushErr}`);
                }
            }

            return {
                success: true,
                output: stepsLog.join('\n'),
                metadata: repo
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
 * Tool: github_create_pull_request
 */
export const GitHubCreatePullRequestTool: IAgentTool = {
    name: 'github_create_pull_request',
    description: 'Open a Pull Request on GitHub from current branch to base branch.',
    category: 'github',
    securityLevel: 'sensitive',
    parameters: {
        type: 'object',
        properties: {
            title: {
                type: 'string',
                description: 'The title of the Pull Request.'
            },
            body: {
                type: 'string',
                description: 'Detailed description / summary of changes in the PR.'
            },
            head: {
                type: 'string',
                description: 'The branch containing the changes (defaults to current branch).'
            },
            base: {
                type: 'string',
                description: 'The branch you want to merge into (defaults to "main").'
            }
        },
        required: ['title']
    },
    async execute(args: { title: string; body?: string; head?: string; base?: string }, context: AgentContext): Promise<ToolResult> {
        try {
            const repoInfo = await resolveCurrentRepoInfo();
            if (!repoInfo) {
                return {
                    success: false,
                    output: '',
                    error: 'Could not determine GitHub repository. Make sure a GitHub remote is configured in git remote -v.'
                };
            }

            const status = await gitService.getStatus();
            const headBranch = args.head || status.currentBranch || 'main';
            const baseBranch = args.base || 'main';

            context.log(`Opening PR on ${repoInfo.owner}/${repoInfo.repo}: ${headBranch} -> ${baseBranch}`);
            const pr = await githubService.createPullRequest({
                owner: repoInfo.owner,
                repo: repoInfo.repo,
                title: args.title,
                body: args.body,
                head: headBranch,
                base: baseBranch
            });

            return {
                success: true,
                output: `✓ Pull Request #${pr.number} created successfully!\nTitle: ${pr.title}\nURL: ${pr.html_url}\nState: ${pr.state}\nMerging ${headBranch} into ${baseBranch}`,
                metadata: pr
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
 * Tool: github_list_pull_requests
 */
export const GitHubListPullRequestsTool: IAgentTool = {
    name: 'github_list_pull_requests',
    description: 'List Pull Requests for the current GitHub repository.',
    category: 'github',
    securityLevel: 'safe',
    parameters: {
        type: 'object',
        properties: {
            state: {
                type: 'string',
                description: 'Filter by state: "open", "closed", or "all" (defaults to "open").',
                enum: ['open', 'closed', 'all']
            }
        }
    },
    async execute(args: { state?: 'open' | 'closed' | 'all' }, _context: AgentContext): Promise<ToolResult> {
        try {
            const repoInfo = await resolveCurrentRepoInfo();
            if (!repoInfo) {
                return {
                    success: false,
                    output: '',
                    error: 'No GitHub remote configured in current workspace.'
                };
            }

            const prs = await githubService.listPullRequests(repoInfo.owner, repoInfo.repo, args.state || 'open');
            if (prs.length === 0) {
                return {
                    success: true,
                    output: `No ${args.state || 'open'} Pull Requests found for ${repoInfo.owner}/${repoInfo.repo}.`
                };
            }

            const list = prs.map(p => `#${p.number} [${p.state.toUpperCase()}] ${p.title} (by @${p.user.login})\n  Branch: ${p.head.ref} -> ${p.base.ref}\n  URL: ${p.html_url}`).join('\n\n');
            return {
                success: true,
                output: list,
                metadata: prs
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
 * Tool: github_get_actions_status
 */
export const GitHubGetActionsStatusTool: IAgentTool = {
    name: 'github_get_actions_status',
    description: 'Inspect recent GitHub Actions CI/CD runs and their pass/fail status.',
    category: 'github',
    securityLevel: 'safe',
    parameters: {
        type: 'object',
        properties: {}
    },
    async execute(_args: any, _context: AgentContext): Promise<ToolResult> {
        try {
            const repoInfo = await resolveCurrentRepoInfo();
            if (!repoInfo) {
                return {
                    success: false,
                    output: '',
                    error: 'No GitHub remote configured in current workspace.'
                };
            }

            const runs = await githubService.getWorkflowRuns(repoInfo.owner, repoInfo.repo);
            if (runs.length === 0) {
                return {
                    success: true,
                    output: `No GitHub Actions workflow runs found for ${repoInfo.owner}/${repoInfo.repo}.`
                };
            }

            const formatted = runs.slice(0, 10).map(r => {
                const icon = r.conclusion === 'success' ? '✓ PASS' : (r.conclusion === 'failure' ? '✗ FAIL' : `⏳ ${r.status.toUpperCase()}`);
                return `[${icon}] ${r.name} (#${r.id})\n  Branch: ${r.head_branch} | Commit: ${r.head_sha.substring(0, 7)}\n  URL: ${r.html_url}`;
            }).join('\n\n');

            return {
                success: true,
                output: `Recent GitHub Actions Runs for ${repoInfo.owner}/${repoInfo.repo}:\n\n${formatted}`,
                metadata: runs
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

export const GITHUB_TOOLS: IAgentTool[] = [
    GitHubAuthStatusTool,
    GitHubCreateRepositoryTool,
    GitHubCreatePullRequestTool,
    GitHubListPullRequestsTool,
    GitHubGetActionsStatusTool
];
