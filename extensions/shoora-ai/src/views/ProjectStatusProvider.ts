/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cybershoora Pvt. Ltd. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GitService, GitStatusSummary } from '../git/GitService.js';
import { GitHubService } from '../github/GitHubService.js';
import { CloudRegistry } from '../cloud/CloudRegistry.js';
import { DeploymentRecord } from '../cloud/types.js';

export interface ProjectStatusOverview {
    projectName: string;
    workspaceRoot?: string;
    code: {
        totalFiles: number;
        hasErrors: boolean;
        errorCount: number;
        warningCount: number;
    };
    git: {
        initialized: boolean;
        branch?: string;
        clean: boolean;
        ahead: number;
        behind: number;
    };
    github: {
        connected: boolean;
        user?: string;
        repo?: string;
        ciStatus?: 'success' | 'failure' | 'pending' | 'none';
    };
    build: {
        status: 'success' | 'failed' | 'pending' | 'not_run';
        lastRun?: string;
    };
    deployment: {
        status: 'live' | 'deploying' | 'failed' | 'idle';
        version?: string;
        url?: string;
    };
    production: {
        status: 'live' | 'unhealthy' | 'offline';
        healthText: string;
    };
}

export class ProjectStatusProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'shoora.projectStatusView';
    private _view?: vscode.WebviewView;
    private gitService = new GitService();
    private githubService = GitHubService.getInstance();
    private cloudRegistry = CloudRegistry.getInstance();

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtmlForWebview();

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'refresh':
                    await this.refreshData();
                    break;
                case 'openChatAction':
                    vscode.commands.executeCommand('shoora.chatView.focus');
                    if (data.prompt) {
                        vscode.commands.executeCommand('shoora.runAgentTask', data.prompt);
                    }
                    break;
                case 'openUrl':
                    if (data.url) {
                        vscode.env.openExternal(vscode.Uri.parse(data.url));
                    }
                    break;
            }
        });

        // Listen for diagnostics (problems/errors)
        vscode.languages.onDidChangeDiagnostics(() => {
            this.refreshData();
        });

        this.refreshData();
    }

    public async refreshData() {
        if (!this._view) return;

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const projectName = workspaceRoot ? path.basename(workspaceRoot) : 'No Workspace';

        // Diagnostics / Code health
        const allDiagnostics = vscode.languages.getDiagnostics();
        let errorCount = 0;
        let warningCount = 0;
        for (const [, diags] of allDiagnostics) {
            for (const d of diags) {
                if (d.severity === vscode.DiagnosticSeverity.Error) errorCount++;
                if (d.severity === vscode.DiagnosticSeverity.Warning) warningCount++;
            }
        }

        // Git status
        let gitSummary: GitStatusSummary | undefined;
        if (workspaceRoot) {
            try {
                gitSummary = await this.gitService.getStatus();
            } catch {
                // not git
            }
        }

        // GitHub status
        const ghSession = await this.githubService.getSession();
        let ghUser: string | undefined;
        let ghRepo: string | undefined;
        let ciStatus: 'success' | 'failure' | 'pending' | 'none' = 'none';

        if (ghSession) {
            ghUser = ghSession.account.label;
            const primaryRemote = gitSummary?.remotes?.[0]?.url;
            if (primaryRemote) {
                const parsed = this.githubService.parseGitHubRemote(primaryRemote);
                if (parsed) {
                    ghRepo = `${parsed.owner}/${parsed.repo}`;
                    try {
                        const runs = await this.githubService.getWorkflowRuns(parsed.owner, parsed.repo);
                        if (runs && runs.length > 0) {
                            ciStatus = runs[0].conclusion === 'success' ? 'success' : runs[0].conclusion === 'failure' ? 'failure' : 'pending';
                        }
                    } catch {
                        // ignore API error
                    }
                }
            }
        }

        // Cloud & Deploy
        const provider = this.cloudRegistry.getActiveProvider();
        let latestDeploy: DeploymentRecord | undefined;
        if (workspaceRoot) {
            latestDeploy = await provider.getStatus(workspaceRoot);
        }

        const buildStatus = latestDeploy
            ? latestDeploy.stages.build === 'success' ? 'success' : latestDeploy.stages.build === 'failed' ? 'failed' : 'pending'
            : 'not_run';

        const deployStatus = latestDeploy
            ? latestDeploy.status === 'live' ? 'live' : latestDeploy.status === 'failed' ? 'failed' : 'deploying'
            : 'idle';

        const productionStatus = (latestDeploy && latestDeploy.status === 'live') ? 'live' : 'offline';

        const overview: ProjectStatusOverview = {
            projectName,
            workspaceRoot,
            code: {
                totalFiles: 0,
                hasErrors: errorCount > 0,
                errorCount,
                warningCount
            },
            git: {
                initialized: !!gitSummary?.isGitRepo,
                branch: gitSummary?.currentBranch,
                clean: gitSummary?.isClean ?? true,
                ahead: gitSummary?.aheadCount ?? 0,
                behind: gitSummary?.behindCount ?? 0
            },
            github: {
                connected: !!ghSession,
                user: ghUser,
                repo: ghRepo,
                ciStatus
            },
            build: {
                status: buildStatus,
                lastRun: latestDeploy ? new Date(latestDeploy.timestamp).toLocaleTimeString() : undefined
            },
            deployment: {
                status: deployStatus,
                version: latestDeploy?.version,
                url: latestDeploy?.url
            },
            production: {
                status: productionStatus,
                healthText: productionStatus === 'live' ? '🟢 Live' : '⚪ Offline / Standby'
            }
        };

        this._view.webview.postMessage({
            type: 'overview',
            data: overview
        });
    }

    private _getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        :root {
            --bg-color: var(--vscode-sideBar-background);
            --text-color: var(--vscode-sideBar-foreground);
            --border-color: var(--vscode-sideBarSectionHeader-border, #333333);
            --btn-bg: var(--vscode-button-background);
            --btn-fg: var(--vscode-button-foreground);
            --btn-hover: var(--vscode-button-hoverBackground);
            --green: #2ecc71;
            --red: #e74c3c;
            --yellow: #f1c40f;
            --blue: #3498db;
        }
        body {
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
            font-size: var(--vscode-font-size, 13px);
            color: var(--text-color);
            background-color: var(--bg-color);
            margin: 0;
            padding: 12px;
            box-sizing: border-box;
        }
        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--border-color);
            margin-bottom: 12px;
        }
        .title-group {
            display: flex;
            align-items: center;
            gap: 8px;
            font-weight: 600;
            font-size: 14px;
        }
        .icon-btn {
            background: transparent;
            border: none;
            color: var(--text-color);
            cursor: pointer;
            padding: 4px;
            border-radius: 4px;
            display: flex;
            align-items: center;
            opacity: 0.8;
        }
        .icon-btn:hover {
            opacity: 1;
            background: rgba(255, 255, 255, 0.1);
        }
        .status-table {
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            overflow: hidden;
            margin-bottom: 14px;
        }
        .status-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 12px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        }
        .status-row:last-child {
            border-bottom: none;
        }
        .status-label {
            display: flex;
            align-items: center;
            gap: 8px;
            font-weight: 500;
        }
        .status-pill {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            font-size: 12px;
            font-weight: 600;
        }
        .status-pill.success { color: var(--green); }
        .status-pill.danger { color: var(--red); }
        .status-pill.warn { color: var(--yellow); }
        .status-pill.muted { color: var(--vscode-descriptionForeground, #888); }

        .pipeline-card {
            background: rgba(255, 255, 255, 0.02);
            border: 1px dashed var(--border-color);
            border-radius: 6px;
            padding: 12px;
            text-align: center;
        }
        .pipeline-title {
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground, #888);
            margin-bottom: 8px;
        }
        .pipeline-flow {
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 11px;
            margin-top: 6px;
        }
        .pipeline-node {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 4px;
        }
        .pipeline-circle {
            width: 24px;
            height: 24px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
            font-weight: 600;
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid var(--border-color);
        }
        .pipeline-circle.active {
            background: rgba(46, 204, 113, 0.2);
            border-color: var(--green);
            color: var(--green);
        }
        .pipeline-arrow {
            color: var(--vscode-descriptionForeground, #666);
            font-size: 14px;
        }
        .url-box {
            margin-top: 10px;
            font-size: 11px;
            word-break: break-all;
        }
        .url-link {
            color: var(--vscode-textLink-foreground, #3794ff);
            text-decoration: none;
        }
        .url-link:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="title-group">
            <span>📊</span>
            <span id="proj-title">Project Status</span>
        </div>
        <button class="icon-btn" id="refresh-btn" title="Refresh Overview">🔄</button>
    </div>

    <!-- Unified Matrix -->
    <div class="status-table">
        <div class="status-row">
            <div class="status-label">
                <span>📝</span>
                <span>Code</span>
            </div>
            <div class="status-pill" id="status-code">✓ Clean</div>
        </div>

        <div class="status-row">
            <div class="status-label">
                <span>🌿</span>
                <span>Git</span>
            </div>
            <div class="status-pill" id="status-git">✓ main</div>
        </div>

        <div class="status-row">
            <div class="status-label">
                <span>🐙</span>
                <span>GitHub</span>
            </div>
            <div class="status-pill" id="status-github">✓ Synced</div>
        </div>

        <div class="status-row">
            <div class="status-label">
                <span>🔨</span>
                <span>Build</span>
            </div>
            <div class="status-pill" id="status-build">✓ Ready</div>
        </div>

        <div class="status-row">
            <div class="status-label">
                <span>☁️</span>
                <span>Deployment</span>
            </div>
            <div class="status-pill" id="status-deploy">✓ v1.0.0</div>
        </div>

        <div class="status-row">
            <div class="status-label">
                <span>🚀</span>
                <span>Production</span>
            </div>
            <div class="status-pill" id="status-prod">🟢 Live</div>
        </div>
    </div>

    <!-- Development to Production Pipeline Flow -->
    <div class="pipeline-card">
        <div class="pipeline-title">Delivery Pipeline</div>
        <div class="pipeline-flow">
            <div class="pipeline-node">
                <div class="pipeline-circle active" id="node-code">✓</div>
                <span>Code</span>
            </div>
            <div class="pipeline-arrow">→</div>
            <div class="pipeline-node">
                <div class="pipeline-circle" id="node-git">✓</div>
                <span>Git</span>
            </div>
            <div class="pipeline-arrow">→</div>
            <div class="pipeline-node">
                <div class="pipeline-circle" id="node-github">✓</div>
                <span>GitHub</span>
            </div>
            <div class="pipeline-arrow">→</div>
            <div class="pipeline-node">
                <div class="pipeline-circle" id="node-build">✓</div>
                <span>Build</span>
            </div>
            <div class="pipeline-arrow">→</div>
            <div class="pipeline-node">
                <div class="pipeline-circle" id="node-deploy">✓</div>
                <span>Deploy</span>
            </div>
        </div>
        <div class="url-box" id="url-box" style="display: none;">
            <a href="#" class="url-link" id="url-anchor" target="_blank"></a>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        document.getElementById('refresh-btn').addEventListener('click', () => {
            vscode.postMessage({ type: 'refresh' });
        });

        document.getElementById('url-anchor').addEventListener('click', (e) => {
            e.preventDefault();
            const url = e.target.getAttribute('data-url');
            if (url) {
                vscode.postMessage({ type: 'openUrl', url });
            }
        });

        window.addEventListener('message', (event) => {
            const { type, data } = event.data;
            if (type === 'overview') {
                renderOverview(data);
            }
        });

        function renderOverview(data) {
            document.getElementById('proj-title').textContent = data.projectName;

            // Code
            const codeEl = document.getElementById('status-code');
            const nodeCode = document.getElementById('node-code');
            if (data.code.hasErrors) {
                codeEl.className = 'status-pill danger';
                codeEl.textContent = '✗ ' + data.code.errorCount + ' Errors';
                nodeCode.className = 'pipeline-circle';
            } else {
                codeEl.className = 'status-pill success';
                codeEl.textContent = '✓ Clean';
                nodeCode.className = 'pipeline-circle active';
            }

            // Git
            const gitEl = document.getElementById('status-git');
            const nodeGit = document.getElementById('node-git');
            if (data.git.initialized) {
                gitEl.className = 'status-pill success';
                gitEl.textContent = '✓ ' + (data.git.branch || 'main') + (data.git.ahead > 0 ? ' ↑' + data.git.ahead : '');
                nodeGit.className = 'pipeline-circle active';
            } else {
                gitEl.className = 'status-pill muted';
                gitEl.textContent = '- Not Init';
                nodeGit.className = 'pipeline-circle';
            }

            // GitHub
            const ghEl = document.getElementById('status-github');
            const nodeGithub = document.getElementById('node-github');
            if (data.github.connected) {
                ghEl.className = 'status-pill success';
                ghEl.textContent = '✓ ' + (data.github.repo ? data.github.repo.split('/')[1] : 'Connected');
                nodeGithub.className = 'pipeline-circle active';
            } else {
                ghEl.className = 'status-pill muted';
                ghEl.textContent = '- Not Connected';
                nodeGithub.className = 'pipeline-circle';
            }

            // Build
            const buildEl = document.getElementById('status-build');
            const nodeBuild = document.getElementById('node-build');
            if (data.build.status === 'success') {
                buildEl.className = 'status-pill success';
                buildEl.textContent = '✓ Passed';
                nodeBuild.className = 'pipeline-circle active';
            } else if (data.build.status === 'failed') {
                buildEl.className = 'status-pill danger';
                buildEl.textContent = '✗ Failed';
                nodeBuild.className = 'pipeline-circle';
            } else {
                buildEl.className = 'status-pill muted';
                buildEl.textContent = '- Standby';
                nodeBuild.className = 'pipeline-circle';
            }

            // Deployment
            const deployEl = document.getElementById('status-deploy');
            const nodeDeploy = document.getElementById('node-deploy');
            if (data.deployment.status === 'live') {
                deployEl.className = 'status-pill success';
                deployEl.textContent = '✓ ' + (data.deployment.version || 'v1.0.0');
                nodeDeploy.className = 'pipeline-circle active';
            } else if (data.deployment.status === 'failed') {
                deployEl.className = 'status-pill danger';
                deployEl.textContent = '✗ Failed';
                nodeDeploy.className = 'pipeline-circle';
            } else {
                deployEl.className = 'status-pill muted';
                deployEl.textContent = '- Idle';
                nodeDeploy.className = 'pipeline-circle';
            }

            // Production
            const prodEl = document.getElementById('status-prod');
            const urlBox = document.getElementById('url-box');
            const urlAnchor = document.getElementById('url-anchor');
            if (data.production.status === 'live') {
                prodEl.className = 'status-pill success';
                prodEl.textContent = '🟢 Live';
                if (data.deployment.url) {
                    urlBox.style.display = 'block';
                    urlAnchor.textContent = '🔗 ' + data.deployment.url;
                    urlAnchor.setAttribute('data-url', data.deployment.url);
                }
            } else {
                prodEl.className = 'status-pill muted';
                prodEl.textContent = '⚪ Standby';
                urlBox.style.display = 'none';
            }
        }
    </script>
</body>
</html>`;
    }
}
