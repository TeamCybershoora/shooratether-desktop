/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cybershoora Pvt. Ltd. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export interface GitHubUser {
    login: string;
    id: number;
    avatar_url: string;
    html_url: string;
    name?: string;
    email?: string;
}

export interface GitHubRepo {
    id: number;
    name: string;
    full_name: string;
    owner: { login: string; avatar_url: string };
    private: boolean;
    html_url: string;
    clone_url: string;
    default_branch: string;
    description?: string;
}

export interface GitHubPullRequest {
    number: number;
    title: string;
    state: string;
    html_url: string;
    user: { login: string; avatar_url: string };
    created_at: string;
    head: { ref: string };
    base: { ref: string };
}

export interface GitHubWorkflowRun {
    id: number;
    name: string;
    status: string; // "queued", "in_progress", "completed"
    conclusion?: string; // "success", "failure", "cancelled", etc.
    html_url: string;
    created_at: string;
    head_branch: string;
    head_sha: string;
}

export class GitHubService {
    private static instance: GitHubService;

    public static getInstance(): GitHubService {
        if (!GitHubService.instance) {
            GitHubService.instance = new GitHubService();
        }
        return GitHubService.instance;
    }

    constructor() {}

    /**
     * Get or request a valid GitHub authentication token.
     */
    public async getSession(createIfNone = false): Promise<vscode.AuthenticationSession | undefined> {
        try {
            return await vscode.authentication.getSession(
                'github',
                ['repo', 'workflow', 'read:user', 'user:email'],
                { createIfNone }
            );
        } catch (err) {
            console.warn('GitHub session acquisition error:', err);
            return undefined;
        }
    }

    /**
     * Check if user is logged into GitHub.
     */
    public async isAuthenticated(): Promise<boolean> {
        const session = await this.getSession(false);
        return !!session?.accessToken;
    }

    /**
     * Helper to make authenticated requests to GitHub API.
     */
    private async request<T>(endpoint: string, options: RequestInit = {}, promptAuth = false): Promise<T> {
        const session = await this.getSession(promptAuth);
        if (!session?.accessToken) {
            throw new Error('Not authenticated with GitHub. Please connect your GitHub account.');
        }

        const url = endpoint.startsWith('https://') ? endpoint : `https://api.github.com${endpoint}`;
        const headers: Record<string, string> = {
            'Accept': 'application/vnd.github.v3+json',
            'Authorization': `Bearer ${session.accessToken}`,
            'User-Agent': 'ShooraTether-Desktop-IDE',
            ...(options.headers as Record<string, string> || {})
        };

        if (options.body && typeof options.body === 'string') {
            headers['Content-Type'] = 'application/json';
        }

        const res = await fetch(url, { ...options, headers });
        if (!res.ok) {
            const errBody = await res.text();
            throw new Error(`GitHub API Error (${res.status}): ${errBody}`);
        }

        if (res.status === 204) {
            return {} as T;
        }

        return await res.json() as T;
    }

    /**
     * Get details of currently authenticated user.
     */
    public async getCurrentUser(): Promise<GitHubUser> {
        return await this.request<GitHubUser>('/user', {}, true);
    }

    /**
     * List repositories belonging to the authenticated user.
     */
    public async listUserRepositories(visibility: 'all' | 'public' | 'private' = 'all'): Promise<GitHubRepo[]> {
        return await this.request<GitHubRepo[]>(`/user/repos?visibility=${visibility}&sort=updated&per_page=30`);
    }

    /**
     * Create a new GitHub repository.
     */
    public async createRepository(options: {
        name: string;
        description?: string;
        private?: boolean;
        autoInit?: boolean;
    }): Promise<GitHubRepo> {
        const body = {
            name: options.name.trim().replace(/\s+/g, '-'),
            description: options.description || '',
            private: options.private !== false, // default private
            auto_init: options.autoInit || false
        };

        return await this.request<GitHubRepo>('/user/repos', {
            method: 'POST',
            body: JSON.stringify(body)
        }, true);
    }

    /**
     * Create a new Pull Request.
     */
    public async createPullRequest(options: {
        owner: string;
        repo: string;
        title: string;
        body?: string;
        head: string;
        base?: string;
    }): Promise<GitHubPullRequest> {
        const body = {
            title: options.title,
            body: options.body || '',
            head: options.head,
            base: options.base || 'main'
        };

        return await this.request<GitHubPullRequest>(`/repos/${options.owner}/${options.repo}/pulls`, {
            method: 'POST',
            body: JSON.stringify(body)
        }, true);
    }

    /**
     * List Pull Requests on a repository.
     */
    public async listPullRequests(owner: string, repo: string, state: 'open' | 'closed' | 'all' = 'open'): Promise<GitHubPullRequest[]> {
        return await this.request<GitHubPullRequest[]>(`/repos/${owner}/${repo}/pulls?state=${state}&per_page=20`);
    }

    /**
     * List recent GitHub Actions workflow runs.
     */
    public async getWorkflowRuns(owner: string, repo: string): Promise<GitHubWorkflowRun[]> {
        const res = await this.request<{ workflow_runs: GitHubWorkflowRun[] }>(`/repos/${owner}/${repo}/actions/runs?per_page=15`);
        return res.workflow_runs || [];
    }

    /**
     * Parse owner and repository name from a git remote URL.
     * Supports:
     * - https://github.com/owner/repo.git
     * - git@github.com:owner/repo.git
     */
    public parseGitHubRemote(remoteUrl: string): { owner: string; repo: string } | undefined {
        const httpsMatch = remoteUrl.match(/github\.com\/([^/]+)\/([^/.]+)(\.git)?/i);
        if (httpsMatch) {
            return { owner: httpsMatch[1], repo: httpsMatch[2] };
        }
        const sshMatch = remoteUrl.match(/github\.com:([^/]+)\/([^/.]+)(\.git)?/i);
        if (sshMatch) {
            return { owner: sshMatch[1], repo: sshMatch[2] };
        }
        return undefined;
    }
}
