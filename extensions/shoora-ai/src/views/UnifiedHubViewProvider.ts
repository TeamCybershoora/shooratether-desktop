/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cybershoora Pvt. Ltd. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { AgentOrchestrator } from '../agent/AgentOrchestrator.js';
import { ApprovalRequest } from '../agent/types.js';
import { GitService, GitStatusSummary } from '../git/GitService.js';
import { GitHubService } from '../github/GitHubService.js';
import { CloudRegistry } from '../cloud/CloudRegistry.js';
import { DeploymentRecord, CloudLogEntry } from '../cloud/types.js';
import { CodebaseIndexer } from '../indexer/CodebaseIndexer.js';

export class ShooraUnifiedHubViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'shoora.unifiedHubView';
    private _view?: vscode.WebviewView;
    private gitService = new GitService();
    private githubService = GitHubService.getInstance();
    private cloudRegistry = CloudRegistry.getInstance();
    private pendingApprovalResolve?: (approved: boolean) => void;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly orchestrator: AgentOrchestrator
    ) {
        this.orchestrator.getSecurityGuard().setCustomHandler(this.handleApprovalRequest.bind(this));
        this.orchestrator.onEvent((event) => {
            if (this._view) {
                this._view.webview.postMessage({ type: 'agentEvent', event });
            }
        });
    }

    private handleApprovalRequest(req: ApprovalRequest): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            this.pendingApprovalResolve = resolve;
            this._view?.webview.postMessage({
                type: 'approvalRequired',
                request: {
                    toolName: req.toolName,
                    securityLevel: req.securityLevel,
                    description: req.description,
                    arguments: req.arguments,
                    warning: req.warning
                }
            });
        });
    }

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtmlForWebview();

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                // Agent actions
                case 'sendMessage':
                    try {
                        let taskText = data.text;
                        if (taskText.toLowerCase().includes('@codebase')) {
                            const indexer = CodebaseIndexer.getInstance();
                            const cleanQuery = taskText.replace(/@codebase/gi, '').trim();
                            const contextSnippet = indexer.formatContextForPrompt(cleanQuery, 4);
                            taskText = `${cleanQuery}\n${contextSnippet}`;
                        }
                        await this.orchestrator.runTask(taskText);
                    } catch (err: any) {
                        this._view?.webview.postMessage({
                            type: 'aiError',
                            error: err?.message || 'Agent encountered an error.'
                        });
                    }
                    break;
                case 'cancelTask':
                    this.orchestrator.cancel();
                    break;
                case 'clearChat':
                    this.orchestrator.clearHistory();
                    this._view?.webview.postMessage({ type: 'chatCleared' });
                    break;
                case 'approvalResponse':
                    if (this.pendingApprovalResolve) {
                        this.pendingApprovalResolve(data.approved === true);
                        this.pendingApprovalResolve = undefined;
                    }
                    break;

                // Tab data refresh
                case 'refreshAll':
                case 'refreshOverview':
                case 'refreshCloud':
                case 'refreshGit':
                    await this.broadcastAllData();
                    break;

                // GitHub actions
                case 'githubLogin':
                    const session = await this.githubService.getSession(true);
                    if (session) {
                        vscode.window.showInformationMessage(`✓ Signed in to GitHub as ${session.account.label}`);
                        await this.broadcastAllData();
                    }
                    break;
                case 'githubCreateRepo':
                    await this.promptCreateRepo();
                    break;
                case 'githubCreatePR':
                    await this.promptCreatePR();
                    break;
                case 'githubPush':
                    await this.handlePush();
                    break;

                // Cloud actions
                case 'cloudDeploy':
                    await this.handleCloudDeploy();
                    break;
                case 'cloudRollback':
                    await this.handleCloudRollback();
                    break;
                case 'cloudViewLogs':
                    await this.handleCloudViewLogs();
                    break;

                // Common
                case 'openUrl':
                    if (data.url) {
                        vscode.env.openExternal(vscode.Uri.parse(data.url));
                    }
                    break;
            }
        });

        // Listen for workspace diagnostics
        vscode.languages.onDidChangeDiagnostics(() => {
            this.broadcastAllData();
        });

        // Initial broadcast
        this.broadcastAllData();
    }

    public sendCustomMessage(text: string) {
        this._view?.webview.postMessage({ type: 'autoAsk', text });
    }

    public resetChat() {
        this._view?.webview.postMessage({ type: 'chatCleared' });
    }

    public async broadcastAllData() {
        if (!this._view) return;

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const projectName = workspaceRoot ? path.basename(workspaceRoot) : 'No Workspace';

        // Diagnostics
        let errorCount = 0;
        let warningCount = 0;
        for (const [, diags] of vscode.languages.getDiagnostics()) {
            for (const d of diags) {
                if (d.severity === vscode.DiagnosticSeverity.Error) errorCount++;
                if (d.severity === vscode.DiagnosticSeverity.Warning) warningCount++;
            }
        }

        // Git
        let gitSummary: GitStatusSummary | undefined;
        if (workspaceRoot) {
            try {
                gitSummary = await this.gitService.getStatus();
            } catch {
                // not git
            }
        }

        // GitHub
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
                    } catch {}
                }
            }
        }

        // Cloud
        const provider = this.cloudRegistry.getActiveProvider();
        const connection = await provider.getConnectionInfo();
        let latestDeploy: DeploymentRecord | undefined;
        let history: DeploymentRecord[] = [];
        let logs: CloudLogEntry[] = [];

        if (workspaceRoot) {
            latestDeploy = await provider.getStatus(workspaceRoot);
            history = await provider.getHistory(workspaceRoot, 5);
            logs = await provider.getLogs(workspaceRoot, undefined, 20);
        }

        this._view.webview.postMessage({
            type: 'state',
            data: {
                projectName,
                overview: {
                    code: { errorCount, warningCount, isClean: errorCount === 0 },
                    git: {
                        initialized: !!gitSummary?.isGitRepo,
                        branch: gitSummary?.currentBranch,
                        ahead: gitSummary?.aheadCount ?? 0,
                        behind: gitSummary?.behindCount ?? 0,
                        isClean: gitSummary?.isClean ?? true
                    },
                    github: {
                        connected: !!ghSession,
                        user: ghUser,
                        repo: ghRepo,
                        ciStatus
                    },
                    build: {
                        status: latestDeploy ? latestDeploy.stages.build : 'pending',
                        lastRun: latestDeploy ? new Date(latestDeploy.timestamp).toLocaleTimeString() : undefined
                    },
                    deployment: {
                        status: latestDeploy?.status || 'idle',
                        version: latestDeploy?.version || 'v1.0.0',
                        url: latestDeploy?.url
                    },
                    production: {
                        isLive: latestDeploy?.status === 'live',
                        url: latestDeploy?.url
                    }
                },
                cloud: {
                    provider: {
                        name: provider.name,
                        connected: connection.connected,
                        region: connection.region || 'us-east-1',
                        details: connection.details
                    },
                    latestDeploy,
                    history,
                    logs
                },
                github: {
                    connected: !!ghSession,
                    user: ghUser,
                    repo: ghRepo,
                    remotes: gitSummary?.remotes || [],
                    branch: gitSummary?.currentBranch,
                    uncommittedCount: (gitSummary?.stagedCount || 0) + (gitSummary?.unstagedCount || 0)
                }
            }
        });
    }

    private async promptCreateRepo() {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return;

        const defaultName = path.basename(workspaceRoot).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        const repoName = await vscode.window.showInputBox({
            prompt: 'Enter new GitHub repository name',
            value: defaultName
        });
        if (!repoName) return;

        const isPrivate = await vscode.window.showQuickPick(['Private', 'Public'], {
            placeHolder: 'Select repository visibility'
        });
        if (!isPrivate) return;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Creating GitHub repository "${repoName}"...`
        }, async () => {
            try {
                const repo = await this.githubService.createRepository({
                    name: repoName,
                    private: isPrivate === 'Private'
                });
                await this.gitService.init();
                await this.gitService.addRemote('origin', repo.clone_url);
                await this.gitService.commit('Initial commit via SHOORA TETHER');
                await this.gitService.push('origin', 'main', true);
                vscode.window.showInformationMessage(`✓ Repository created & pushed: ${repo.html_url}`);
                await this.broadcastAllData();
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to create repository: ${err.message || err}`);
            }
        });
    }

    private async promptCreatePR() {
        const title = await vscode.window.showInputBox({ prompt: 'Pull Request Title' });
        if (!title) return;

        const status = await this.gitService.getStatus();
        const primaryRemote = status.remotes[0]?.url;
        if (!primaryRemote) return;

        const parsed = this.githubService.parseGitHubRemote(primaryRemote);
        if (!parsed) return;

        try {
            const pr = await this.githubService.createPullRequest({
                owner: parsed.owner,
                repo: parsed.repo,
                title,
                head: status.currentBranch || 'main',
                base: 'main'
            });
            vscode.window.showInformationMessage(`✓ Pull Request #${pr.number} created!`);
            await this.broadcastAllData();
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed: ${err.message || err}`);
        }
    }

    private async handlePush() {
        try {
            const status = await this.gitService.getStatus();
            await this.gitService.push('origin', status.currentBranch || 'main');
            vscode.window.showInformationMessage('✓ Pushed to remote successfully.');
            await this.broadcastAllData();
        } catch (err: any) {
            vscode.window.showErrorMessage(`Push failed: ${err.message || err}`);
        }
    }

    private async handleCloudDeploy() {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return;

        const provider = this.cloudRegistry.getActiveProvider();
        const confirm = await vscode.window.showInformationMessage(
            `Deploy project to ${provider.name}?`,
            { modal: true },
            'Deploy to Production'
        );
        if (confirm !== 'Deploy to Production') return;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `SHOORA Cloud: Deploying to ${provider.name}...`
        }, async (progress) => {
            try {
                progress.report({ message: 'Building & Deploying...' });
                const result = await provider.deploy(workspaceRoot, { targetEnvironment: 'production' });
                if (result.status === 'live') {
                    vscode.window.showInformationMessage(`🚀 Deployment Live: ${result.url}`);
                }
                await this.broadcastAllData();
            } catch (err: any) {
                vscode.window.showErrorMessage(`Deploy error: ${err.message || err}`);
            }
        });
    }

    private async handleCloudRollback() {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return;

        const provider = this.cloudRegistry.getActiveProvider();
        const confirm = await vscode.window.showWarningMessage(
            'Rollback to previous stable version?',
            { modal: true },
            'Rollback Now'
        );
        if (confirm !== 'Rollback Now') return;

        try {
            const rb = await provider.rollback(workspaceRoot);
            vscode.window.showInformationMessage(`✓ Rolled back to ${rb.version}`);
            await this.broadcastAllData();
        } catch (err: any) {
            vscode.window.showErrorMessage(`Rollback failed: ${err.message || err}`);
        }
    }

    private async handleCloudViewLogs() {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return;

        const provider = this.cloudRegistry.getActiveProvider();
        const logs = await provider.getLogs(workspaceRoot, undefined, 50);

        const channel = vscode.window.createOutputChannel(`SHOORA Cloud Logs`);
        channel.clear();
        channel.show();

        for (const log of logs) {
            const time = new Date(log.timestamp).toLocaleTimeString();
            channel.appendLine(`[${time}] [${log.level.toUpperCase()}] ${log.message}`);
        }
    }

    private static readonly ICONS = {
        bolt: `<svg class="svg-icon svg-accent svg-pulse" viewBox="0 0 24 24" fill="none"><defs><linearGradient id="shGradBolt" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#00E5FF"/><stop offset="100%" stop-color="#8B5CF6"/></linearGradient></defs><path d="M13 2L3 14H12L11 22L21 10H12L13 2Z" fill="url(#shGradBolt)" stroke="#00E5FF" stroke-width="1.2" stroke-linejoin="round"/></svg>`,
        agent: `<svg class="svg-icon svg-agent" viewBox="0 0 24 24" fill="none"><defs><linearGradient id="shGradAgent" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#00E5FF"/><stop offset="100%" stop-color="#3B82F6"/></linearGradient></defs><rect x="3" y="10" width="18" height="11" rx="4" fill="rgba(0, 229, 255, 0.12)" stroke="url(#shGradAgent)" stroke-width="1.5"/><circle cx="12" cy="4" r="2" fill="#00E5FF" class="anim-glow"/><line x1="12" y1="6" x2="12" y2="10" stroke="#00E5FF" stroke-width="1.5"/><circle cx="8" cy="15.5" r="1.5" fill="#00E5FF" class="anim-blink"/><circle cx="16" cy="15.5" r="1.5" fill="#00E5FF" class="anim-blink"/><path d="M10 18.5H14" stroke="#00E5FF" stroke-width="1.2" stroke-linecap="round"/></svg>`,
        status: `<svg class="svg-icon svg-status" viewBox="0 0 24 24" fill="none"><defs><linearGradient id="shGradStatus" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#3B82F6"/><stop offset="50%" stop-color="#00E5FF"/><stop offset="100%" stop-color="#10B981"/></linearGradient></defs><rect x="2" y="3" width="20" height="18" rx="4" stroke="rgba(255,255,255,0.2)" stroke-width="1.2" fill="rgba(0,0,0,0.2)"/><path d="M4 12H7L9 7L13 17L15 10L17 12H20" stroke="url(#shGradStatus)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="anim-ecg"/></svg>`,
        cloud: `<svg class="svg-icon svg-cloud" viewBox="0 0 24 24" fill="none"><defs><linearGradient id="shGradCloud" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#38BDF8"/><stop offset="100%" stop-color="#818CF8"/></linearGradient></defs><path class="anim-float" d="M19 12H18.2C17.7 8.6 14.8 6 11.3 6C8.5 6 6 7.8 5.2 10.4C3.4 10.9 2 12.5 2 14.5C2 17 4 19 6.5 19H19C21.2 19 23 17.2 23 15C23 12.8 21.2 12 19 12Z" fill="rgba(56,189,248,0.12)" stroke="url(#shGradCloud)" stroke-width="1.5" stroke-linejoin="round"/><polyline class="anim-upload-arrow" points="12 15 12 11 10 13" stroke="#00E5FF" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
        github: `<svg class="svg-icon svg-github" viewBox="0 0 24 24" fill="none"><line x1="6" y1="5" x2="6" y2="19" stroke="rgba(255,255,255,0.4)" stroke-width="1.8"/><path d="M6 12C12 12 18 10 18 7" stroke="rgba(255,255,255,0.4)" stroke-width="1.8"/><circle cx="6" cy="5" r="2.5" fill="#38BDF8" stroke="#00E5FF" stroke-width="1.2" class="anim-node-1"/><circle cx="6" cy="19" r="2.5" fill="#10B981" stroke="#34D399" stroke-width="1.2"/><circle cx="18" cy="7" r="2.5" fill="#A855F7" stroke="#C084FC" stroke-width="1.2" class="anim-node-2"/></svg>`,
        folder: `<svg class="svg-icon" viewBox="0 0 24 24" fill="none"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" fill="rgba(56,189,248,0.15)" stroke="#38BDF8" stroke-width="1.6"/><line x1="8" y1="13" x2="14" y2="13" stroke="#00E5FF" stroke-width="1.4" stroke-linecap="round"/></svg>`,
        refresh: `<svg class="svg-icon anim-spin-hover" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
        rocket: `<svg class="svg-icon svg-rocket" viewBox="0 0 24 24" fill="none"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" fill="rgba(245,158,11,0.25)" stroke="#F59E0B" stroke-width="1.5"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-2.95 11a22.35 22.35 0 0 1-4.05 2l-3-3z" stroke="#F59E0B" stroke-width="1.6" stroke-linejoin="round"/><circle cx="15.5" cy="8.5" r="1.5" fill="#F59E0B"/><path class="anim-flame" d="M8.5 18.5L5 22" stroke="#EF4444" stroke-width="2.5" stroke-linecap="round"/></svg>`,
        rollback: `<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 19 2 12 11 5 11 19" fill="rgba(255,255,255,0.15)"/><polygon points="22 19 13 12 22 5 22 19" fill="rgba(255,255,255,0.15)"/></svg>`,
        logs: `<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="18" rx="3" stroke="rgba(255,255,255,0.3)" fill="rgba(0,0,0,0.2)"/><polyline points="5 9 8 12 5 15" stroke="#00E5FF"/><line x1="11" y1="15" x2="17" y2="15" stroke="#10B981" stroke-width="2" class="anim-cursor"/></svg>`,
        plus: `<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="#10B981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" stroke="rgba(16,185,129,0.35)" fill="rgba(16,185,129,0.1)"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`,
        push: `<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="#38BDF8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline class="anim-push-arrow" points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="16"/><path d="M5 21H19"/></svg>`,
        pr: `<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="#A855F7" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3" fill="rgba(168,85,247,0.2)"/><circle cx="6" cy="6" r="3" fill="rgba(56,189,248,0.2)" stroke="#38BDF8"/><path d="M13 6H16A2 2 0 0 1 18 8V15"/><line x1="6" y1="9" x2="6" y2="21" stroke="#38BDF8"/></svg>`,
        link: `<svg class="svg-icon svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
        send: `<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2" fill="rgba(255,255,255,0.2)"/></svg>`,
        sparkle: `<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="#00E5FF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" fill="rgba(0,229,255,0.25)" class="anim-sparkle"/></svg>`,
        gear: `<svg class="svg-icon spin-icon" viewBox="0 0 24 24" fill="none" stroke="#00E5FF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
        error: `<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="#EF4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" fill="rgba(239,68,68,0.2)"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`
    };

    private _getHtmlForWebview(): string {
        const ICONS = ShooraUnifiedHubViewProvider.ICONS;
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --bg-color: var(--vscode-sideBar-background);
      --card-bg: rgba(255, 255, 255, 0.035);
      --card-border: rgba(255, 255, 255, 0.08);
      --accent: #00E5FF;
      --accent-gradient: linear-gradient(135deg, #00E5FF 0%, #3B82F6 50%, #8B5CF6 100%);
      --text-main: var(--vscode-foreground);
      --text-muted: var(--vscode-descriptionForeground, #8e9297);
      --green: #10B981;
      --red: #EF4444;
      --amber: #F59E0B;
      --blue: #3B82F6;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      padding: 0;
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
      font-size: var(--vscode-font-size, 12px);
      color: var(--text-main);
      background: var(--bg-color);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* Top Brand Navigation Bar */
    .top-header {
      padding: 12px 14px 10px 14px;
      border-bottom: 1px solid var(--card-border);
      background: rgba(0, 0, 0, 0.15);
      backdrop-filter: blur(8px);
    }

    .brand-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
    }

    .brand-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.5px;
      background: var(--accent-gradient);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .brand-badge {
      font-size: 10px;
      padding: 2px 7px;
      border-radius: 12px;
      background: rgba(0, 229, 255, 0.15);
      color: var(--accent);
      border: 1px solid rgba(0, 229, 255, 0.3);
      font-weight: 600;
    }

    /* Modern Capsule Segmented Tabs */
    .tab-bar {
      display: flex;
      background: rgba(0, 0, 0, 0.25);
      padding: 3px;
      border-radius: 8px;
      gap: 2px;
    }

    .tab-btn {
      flex: 1;
      padding: 6px 4px;
      border: none;
      background: transparent;
      color: var(--text-muted);
      font-size: 11px;
      font-weight: 600;
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .tab-btn:hover {
      color: var(--text-main);
      background: rgba(255, 255, 255, 0.05);
    }

    .tab-btn.active {
      color: #FFFFFF;
      background: rgba(255, 255, 255, 0.14);
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
    }

    /* Content Area */
    .views-wrapper {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      position: relative;
    }

    .view-panel {
      display: none;
      flex-direction: column;
      gap: 12px;
      height: 100%;
    }

    .view-panel.active {
      display: flex;
    }

    /* Professional Glass Cards */
    .glass-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 12px;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }

    .glass-card:hover {
      border-color: rgba(255, 255, 255, 0.15);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    }

    .card-title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
    }

    .card-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    /* Metrics Grid */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
    }

    .metric-box {
      background: rgba(0, 0, 0, 0.2);
      border-radius: 6px;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .metric-label {
      font-size: 10px;
      color: var(--text-muted);
    }

    .metric-value {
      font-size: 13px;
      font-weight: 600;
    }

    /* Modern Pipeline */
    .pipeline-track {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 8px 0;
      padding: 8px;
      background: rgba(0, 0, 0, 0.2);
      border-radius: 6px;
    }

    .pipeline-step {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      color: var(--text-muted);
    }

    .step-circle {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.08);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 10px;
      transition: all 0.2s ease;
    }

    .step-circle.done {
      background: rgba(16, 185, 129, 0.2);
      color: var(--green);
      border: 1px solid var(--green);
    }

    .pipeline-arrow {
      color: var(--card-border);
      font-size: 12px;
    }

    /* Status Pills */
    .status-pill {
      font-size: 10.5px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 12px;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }

    .status-pill.live {
      background: rgba(16, 185, 129, 0.15);
      color: var(--green);
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .status-pill.failed {
      background: rgba(239, 68, 68, 0.15);
      color: var(--red);
      border: 1px solid rgba(239, 68, 68, 0.3);
    }

    .status-pill.pending {
      background: rgba(245, 158, 11, 0.15);
      color: var(--amber);
      border: 1px solid rgba(245, 158, 11, 0.3);
    }

    /* Action Buttons */
    .btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 6px;
      padding: 7px 12px;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.2s ease;
      width: 100%;
    }

    .btn:hover {
      background: var(--vscode-button-hoverBackground);
      transform: translateY(-1px);
    }

    .btn-secondary {
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-main);
    }

    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.14);
    }

    .btn-group {
      display: flex;
      gap: 8px;
    }

    /* Chat Area */
    #chat-messages {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding-bottom: 8px;
    }

    .chat-msg {
      padding: 10px 12px;
      border-radius: 8px;
      line-height: 1.5;
      font-size: 12px;
      max-width: 92%;
      word-break: break-word;
    }

    .chat-msg.user {
      align-self: flex-end;
      background: linear-gradient(135deg, #0077EE 0%, #0055BB 100%);
      color: #FFFFFF;
      border-bottom-right-radius: 2px;
    }

    .chat-msg.ai {
      align-self: flex-start;
      background: rgba(255, 255, 255, 0.045);
      border: 1px solid var(--card-border);
      width: 95%;
      border-bottom-left-radius: 2px;
    }

    .chat-input-box {
      margin-top: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding-top: 8px;
      border-top: 1px solid var(--card-border);
    }

    .chat-textarea {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 6px;
      padding: 8px 10px;
      resize: none;
      font-size: 12px;
      font-family: inherit;
    }

    .chat-textarea:focus {
      outline: 1px solid var(--accent);
    }

    /* Live Output & Logs */
    .log-box {
      background: rgba(0, 0, 0, 0.35);
      border-radius: 6px;
      padding: 8px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      max-height: 150px;
      overflow-y: auto;
      white-space: pre-wrap;
      color: var(--text-muted);
    }

    .url-link {
      color: var(--accent);
      text-decoration: none;
      font-size: 11px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .url-link:hover { text-decoration: underline; }

    /* Animated SVG Icons */
    .svg-icon {
      width: 15px;
      height: 15px;
      display: inline-block;
      vertical-align: middle;
      flex-shrink: 0;
      transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), filter 0.2s ease;
    }
    .svg-icon-lg {
      width: 18px;
      height: 18px;
    }
    .svg-icon-sm {
      width: 13px;
      height: 13px;
    }

    /* Icon Micro Animations */
    .svg-pulse {
      animation: svgPulseAnim 2.8s ease-in-out infinite;
    }
    @keyframes svgPulseAnim {
      0%, 100% { filter: drop-shadow(0 0 2px rgba(0,229,255,0.4)); transform: scale(1); }
      50% { filter: drop-shadow(0 0 8px rgba(0,229,255,0.85)); transform: scale(1.06); }
    }

    .anim-blink {
      animation: svgBlinkAnim 3.8s infinite;
    }
    @keyframes svgBlinkAnim {
      0%, 90%, 100% { opacity: 1; transform: scaleY(1); }
      95% { opacity: 0.15; transform: scaleY(0.15); }
    }

    .anim-glow {
      animation: svgGlowAnim 2.2s ease-in-out infinite;
    }
    @keyframes svgGlowAnim {
      0%, 100% { filter: drop-shadow(0 0 1px #00E5FF); }
      50% { filter: drop-shadow(0 0 6px #00E5FF); }
    }

    .anim-ecg {
      stroke-dasharray: 26;
      stroke-dashoffset: 26;
      animation: svgEcgAnim 2.4s ease-in-out infinite;
    }
    @keyframes svgEcgAnim {
      0% { stroke-dashoffset: 26; }
      50% { stroke-dashoffset: 0; }
      100% { stroke-dashoffset: -26; }
    }

    .anim-float {
      animation: svgFloatAnim 3s ease-in-out infinite;
    }
    @keyframes svgFloatAnim {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-1.5px); }
    }

    .anim-upload-arrow {
      animation: svgArrowAnim 1.8s ease-in-out infinite;
    }
    @keyframes svgArrowAnim {
      0%, 100% { transform: translateY(0); opacity: 0.6; }
      50% { transform: translateY(-2px); opacity: 1; }
    }

    .anim-node-1 {
      animation: svgNodePulse1 2.2s ease-in-out infinite;
    }
    .anim-node-2 {
      animation: svgNodePulse2 2.2s ease-in-out infinite;
    }
    @keyframes svgNodePulse1 {
      0%, 100% { r: 2.2; filter: drop-shadow(0 0 1px #00E5FF); }
      50% { r: 3.2; filter: drop-shadow(0 0 5px #00E5FF); }
    }
    @keyframes svgNodePulse2 {
      0%, 100% { r: 3.2; filter: drop-shadow(0 0 5px #A855F7); }
      50% { r: 2.2; filter: drop-shadow(0 0 1px #A855F7); }
    }

    .anim-flame {
      animation: svgFlameAnim 0.7s ease-in-out infinite alternate;
    }
    @keyframes svgFlameAnim {
      from { opacity: 0.4; stroke-width: 1.5; }
      to { opacity: 1; stroke-width: 3; filter: drop-shadow(0 0 4px #EF4444); }
    }

    .anim-cursor {
      animation: svgCursorAnim 0.9s steps(2, start) infinite;
    }
    @keyframes svgCursorAnim {
      to { visibility: hidden; }
    }

    .anim-push-arrow {
      animation: svgPushAnim 1.6s ease-in-out infinite;
    }
    @keyframes svgPushAnim {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-2px); }
    }

    .anim-sparkle {
      animation: svgSparkleAnim 2s ease-in-out infinite;
    }
    @keyframes svgSparkleAnim {
      0%, 100% { opacity: 0.5; transform: scale(0.95); }
      50% { opacity: 1; transform: scale(1.08); filter: drop-shadow(0 0 4px #00E5FF); }
    }

    .spin-icon {
      animation: svgSpinAnim 2.5s linear infinite;
    }
    @keyframes svgSpinAnim {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .tab-btn:hover .svg-icon,
    .btn:hover .svg-icon {
      transform: scale(1.15);
      filter: drop-shadow(0 0 5px currentColor);
    }

    .anim-spin-hover:hover .svg-icon {
      animation: svgSpinAnim 0.75s cubic-bezier(0.4, 0, 0.2, 1);
    }
  </style>
</head>
<body>
  <!-- Header with Brand & Capsule Navigation -->
  <div class="top-header">
    <div class="brand-row">
      <div class="brand-title">
        ${ICONS.bolt}
        <span>SHOORA AI CONTROL</span>
      </div>
      <div class="brand-badge">Autonomous</div>
    </div>

    <!-- Capsule Tabs with Animated SVG Icons -->
    <div class="tab-bar">
      <button class="tab-btn active" data-tab="tab-agent">${ICONS.agent}<span>Agent</span></button>
      <button class="tab-btn" data-tab="tab-status">${ICONS.status}<span>Status</span></button>
      <button class="tab-btn" data-tab="tab-cloud">${ICONS.cloud}<span>Cloud</span></button>
      <button class="tab-btn" data-tab="tab-github">${ICONS.github}<span>GitHub</span></button>
    </div>
  </div>

  <!-- Panels Container -->
  <div class="views-wrapper">

    <!-- TAB 1: AI AGENT CHAT -->
    <div id="tab-agent" class="view-panel active">
      <div id="chat-messages">
        <div class="chat-msg ai">
          Hello! I am your <b>SHOORA AI Agent</b>.
          <br/><br/>
          I have 26 integrated tools, <b>@codebase RAG search</b>, and inline editor superpowers (<b>Ctrl+K</b> &amp; <b>Tab Autocomplete</b>).
          <div style="margin-top: 8px; font-size: 11px; display: flex; align-items: center; gap: 6px; opacity: 0.85;">
            ${ICONS.sparkle} <i>Try: "@codebase how is auth handled?", "Deploy to AWS", or press Ctrl+K in editor</i>
          </div>
        </div>
      </div>

      <div class="chat-input-box">
        <textarea id="promptInput" class="chat-textarea" rows="2" placeholder="Ask Shoora Agent to build, fix, or deploy..."></textarea>
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <button class="btn btn-secondary" id="clearChatBtn" style="width: auto; padding: 4px 8px; font-size: 11px;">Clear</button>
          <div style="flex: 1;"></div>
          <button class="btn" id="sendBtn" style="width: auto; padding: 5px 16px;"><span>Send</span> ${ICONS.send}</button>
        </div>
      </div>
    </div>

    <!-- TAB 2: UNIFIED PROJECT STATUS -->
    <div id="tab-status" class="view-panel">
      <!-- Overview Card -->
      <div class="glass-card">
        <div class="card-title-row">
          <div class="card-title">${ICONS.folder}<span id="proj-title">Workspace</span></div>
          <button class="btn btn-secondary anim-spin-hover" id="refreshStatusBtn" style="width:auto; padding:3px 7px;" title="Refresh">${ICONS.refresh}</button>
        </div>
        <div class="metrics-grid">
          <div class="metric-box">
            <span class="metric-label">CODE DIAGNOSTICS</span>
            <span class="metric-value" id="status-code">✓ Clean</span>
          </div>
          <div class="metric-box">
            <span class="metric-label">GIT BRANCH</span>
            <span class="metric-value" id="status-git">main</span>
          </div>
          <div class="metric-box">
            <span class="metric-label">GITHUB REPO</span>
            <span class="metric-value" id="status-gh">Synced</span>
          </div>
          <div class="metric-box">
            <span class="metric-label">DEPLOYMENT</span>
            <span class="metric-value" id="status-dep">v1.0.0</span>
          </div>
        </div>
      </div>

      <!-- Pipeline Delivery Card -->
      <div class="glass-card">
        <div class="card-title">${ICONS.rocket}<span>DELIVERY PIPELINE</span></div>
        <div class="pipeline-track">
          <div class="pipeline-step">
            <div class="step-circle done" id="pipe-code">✓</div>
            <span>Code</span>
          </div>
          <div class="pipeline-arrow">→</div>
          <div class="pipeline-step">
            <div class="step-circle" id="pipe-git">✓</div>
            <span>Git</span>
          </div>
          <div class="pipeline-arrow">→</div>
          <div class="pipeline-step">
            <div class="step-circle" id="pipe-gh">✓</div>
            <span>GitHub</span>
          </div>
          <div class="pipeline-arrow">→</div>
          <div class="pipeline-step">
            <div class="step-circle" id="pipe-deploy">✓</div>
            <span>Deploy</span>
          </div>
        </div>
        <div id="prod-url-container" style="margin-top: 8px; display: none;">
          <a href="#" class="url-link" id="prod-url-link" target="_blank">${ICONS.link} <span>Open Live Production</span></a>
        </div>
      </div>
    </div>

    <!-- TAB 3: CLOUD & AWS DEPLOYMENTS -->
    <div id="tab-cloud" class="view-panel">
      <div class="glass-card">
        <div class="card-title-row">
          <div class="card-title">${ICONS.cloud}<span id="cloud-provider-name">AWS App Runner</span></div>
          <div class="status-pill live" id="cloud-conn-pill">● Connected</div>
        </div>
        <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 8px;" id="cloud-region-text">
          Region: us-east-1
        </div>
        <div class="btn-group">
          <button class="btn" id="cloudDeployBtn">${ICONS.rocket}<span>Redeploy</span></button>
          <button class="btn btn-secondary" id="cloudRollbackBtn">${ICONS.rollback}<span>Rollback</span></button>
          <button class="btn btn-secondary" id="cloudLogsBtn">${ICONS.logs}<span>Logs</span></button>
        </div>
      </div>

      <!-- Stages & Health -->
      <div class="glass-card">
        <div class="card-title">${ICONS.bolt}<span>STAGE MONITOR</span></div>
        <div class="metrics-grid" style="margin-top: 8px;">
          <div class="metric-box">
            <span class="metric-label">BUILD</span>
            <span class="metric-value" id="stage-build">✓ Passed</span>
          </div>
          <div class="metric-box">
            <span class="metric-label">DEPLOY</span>
            <span class="metric-value" id="stage-deploy">✓ Active</span>
          </div>
        </div>
        <div id="cloud-live-url-box" style="margin-top: 10px; display: none;">
          <a href="#" class="url-link" id="cloud-live-url" target="_blank">${ICONS.link} <span>Open Deployment URL</span></a>
        </div>
      </div>
    </div>

    <!-- TAB 4: GITHUB CONTROL -->
    <div id="tab-github" class="view-panel">
      <div class="glass-card">
        <div class="card-title-row">
          <div class="card-title">${ICONS.github}<span>ACCOUNT & REPO</span></div>
          <div class="status-pill live" id="gh-conn-pill">Connected</div>
        </div>
        <div style="font-size: 11.5px; margin-bottom: 8px;" id="gh-repo-name">
          Repository: Connecting...
        </div>
        <div class="btn-group" style="flex-direction: column;">
          <button class="btn" id="ghCreateRepoBtn">${ICONS.plus}<span>Create GitHub Repo & Push</span></button>
          <button class="btn btn-secondary" id="ghPushBtn">${ICONS.push}<span>Push Commits</span></button>
          <button class="btn btn-secondary" id="ghCreatePRBtn">${ICONS.pr}<span>Create Pull Request</span></button>
        </div>
      </div>
    </div>

  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const ICONS_MAP = ${JSON.stringify(ICONS)};

    // Tab Switching Logic
    const tabBtns = document.querySelectorAll('.tab-btn');
    const viewPanels = document.querySelectorAll('.view-panel');

    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        viewPanels.forEach(p => p.classList.remove('active'));

        btn.classList.add('active');
        const target = btn.getAttribute('data-tab');
        document.getElementById(target)?.classList.add('active');
      });
    });

    // Chat Logic
    const msgContainer = document.getElementById('chat-messages');
    const input = document.getElementById('promptInput');
    const sendBtn = document.getElementById('sendBtn');
    const clearBtn = document.getElementById('clearChatBtn');

    function send() {
      const text = input.value.trim();
      if (!text) return;
      appendMsg('user', text);
      input.value = '';
      vscode.postMessage({ type: 'sendMessage', text });
    }

    sendBtn.addEventListener('click', send);
    clearBtn.addEventListener('click', () => vscode.postMessage({ type: 'clearChat' }));

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    function appendMsg(role, text) {
      const div = document.createElement('div');
      div.className = 'chat-msg ' + role;
      div.innerHTML = escapeHtml(text).replace(/\\n/g, '<br/>');
      msgContainer.appendChild(div);
      msgContainer.scrollTop = msgContainer.scrollHeight;
      return div;
    }

    function escapeHtml(text) {
      return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Button event listeners
    document.getElementById('refreshStatusBtn').addEventListener('click', () => vscode.postMessage({ type: 'refreshAll' }));
    document.getElementById('cloudDeployBtn').addEventListener('click', () => vscode.postMessage({ type: 'cloudDeploy' }));
    document.getElementById('cloudRollbackBtn').addEventListener('click', () => vscode.postMessage({ type: 'cloudRollback' }));
    document.getElementById('cloudLogsBtn').addEventListener('click', () => vscode.postMessage({ type: 'cloudViewLogs' }));
    document.getElementById('ghCreateRepoBtn').addEventListener('click', () => vscode.postMessage({ type: 'githubCreateRepo' }));
    document.getElementById('ghPushBtn').addEventListener('click', () => vscode.postMessage({ type: 'githubPush' }));
    document.getElementById('ghCreatePRBtn').addEventListener('click', () => vscode.postMessage({ type: 'githubCreatePR' }));

    // Listen to messages from extension
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'state') {
        renderState(msg.data);
      } else if (msg.type === 'chatCleared') {
        msgContainer.innerHTML = '<div class="chat-msg ai">Conversation reset. Ready for a new task!</div>';
      } else if (msg.type === 'aiError') {
        appendMsg('ai', '<span style="display:flex;align-items:center;gap:6px;color:#EF4444;">' + ICONS_MAP.error + ' ' + escapeHtml(msg.error) + '</span>');
      } else if (msg.type === 'agentEvent') {
        renderAgentEvent(msg.event);
      }
    });

    let currentAiCard = null;

    function renderAgentEvent(ev) {
      if (!currentAiCard) {
        currentAiCard = appendMsg('ai', '');
      }

      if (ev.type === 'thought') {
        const p = document.createElement('div');
        p.style.marginBottom = '6px';
        p.style.display = 'flex';
        p.style.alignItems = 'center';
        p.style.gap = '6px';
        p.innerHTML = ICONS_MAP.sparkle + ' <span>' + escapeHtml(ev.data.text) + '</span>';
        currentAiCard.appendChild(p);
      } else if (ev.type === 'tool_start') {
        const box = document.createElement('div');
        box.style.padding = '4px 8px';
        box.style.background = 'rgba(0,229,255,0.08)';
        box.style.borderRadius = '4px';
        box.style.margin = '4px 0';
        box.style.fontSize = '11px';
        box.style.display = 'flex';
        box.style.alignItems = 'center';
        box.style.gap = '6px';
        box.innerHTML = ICONS_MAP.gear + ' <span>Executing <b>' + ev.data.name + '</b>...</span>';
        currentAiCard.appendChild(box);
      } else if (ev.type === 'final_answer') {
        const ans = document.createElement('div');
        ans.style.marginTop = '6px';
        ans.style.fontWeight = '500';
        ans.innerHTML = escapeHtml(ev.data.text).replace(/\\n/g, '<br/>');
        currentAiCard.appendChild(ans);
        currentAiCard = null;
      }
      msgContainer.scrollTop = msgContainer.scrollHeight;
    }

    function renderState(d) {
      document.getElementById('proj-title').textContent = d.projectName;

      // Status
      const ov = d.overview;
      document.getElementById('status-code').textContent = ov.code.isClean ? '✓ Clean' : '✗ ' + ov.code.errorCount + ' Errors';
      document.getElementById('status-git').textContent = ov.git.branch || 'main';
      document.getElementById('status-gh').textContent = ov.github.connected ? '✓ Connected' : '○ Standby';
      document.getElementById('status-dep').textContent = ov.deployment.version;

      if (ov.production.isLive && ov.production.url) {
        document.getElementById('prod-url-container').style.display = 'block';
        const a = document.getElementById('prod-url-link');
        a.innerHTML = ICONS_MAP.link + ' <span>' + escapeHtml(ov.production.url) + '</span>';
        a.onclick = (e) => { e.preventDefault(); vscode.postMessage({ type: 'openUrl', url: ov.production.url }); };
      }

      // Cloud
      document.getElementById('cloud-provider-name').textContent = d.cloud.provider.name;
      document.getElementById('cloud-region-text').textContent = 'Region: ' + d.cloud.provider.region;
      if (d.cloud.latestDeploy?.url) {
        document.getElementById('cloud-live-url-box').style.display = 'block';
        const ca = document.getElementById('cloud-live-url');
        ca.innerHTML = ICONS_MAP.link + ' <span>' + escapeHtml(d.cloud.latestDeploy.url) + '</span>';
        ca.onclick = (e) => { e.preventDefault(); vscode.postMessage({ type: 'openUrl', url: d.cloud.latestDeploy.url }); };
      }

      // GitHub
      document.getElementById('gh-repo-name').textContent = d.github.repo ? 'Repository: ' + d.github.repo : 'No remote repo linked';
    }
  </script>
</body>
</html>`;
    }
}
