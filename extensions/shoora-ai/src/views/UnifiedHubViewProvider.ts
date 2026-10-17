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
                        await this.orchestrator.runTask(data.text);
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

    private _getHtmlForWebview(): string {
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
  </style>
</head>
<body>
  <!-- Header with Brand & Capsule Navigation -->
  <div class="top-header">
    <div class="brand-row">
      <div class="brand-title">
        <span>⚡</span>
        <span>SHOORA AI CONTROL</span>
      </div>
      <div class="brand-badge">Autonomous</div>
    </div>

    <!-- Capsule Tabs -->
    <div class="tab-bar">
      <button class="tab-btn active" data-tab="tab-agent">🤖 Agent</button>
      <button class="tab-btn" data-tab="tab-status">📊 Status</button>
      <button class="tab-btn" data-tab="tab-cloud">☁️ Cloud</button>
      <button class="tab-btn" data-tab="tab-github">🐙 GitHub</button>
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
          I have 25 integrated tools to help you develop, run tests, commit to GitHub, and deploy to AWS.
          <div style="margin-top: 8px; font-size: 11px; opacity: 0.85;">
            💡 <i>Try: "Inspect project and run tests", "Deploy to AWS", or "Create GitHub PR"</i>
          </div>
        </div>
      </div>

      <div class="chat-input-box">
        <textarea id="promptInput" class="chat-textarea" rows="2" placeholder="Ask Shoora Agent to build, fix, or deploy..."></textarea>
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <button class="btn btn-secondary" id="clearChatBtn" style="width: auto; padding: 4px 8px; font-size: 11px;">Clear</button>
          <div style="flex: 1;"></div>
          <button class="btn" id="sendBtn" style="width: auto; padding: 5px 16px;">Send ➜</button>
        </div>
      </div>
    </div>

    <!-- TAB 2: UNIFIED PROJECT STATUS -->
    <div id="tab-status" class="view-panel">
      <!-- Overview Card -->
      <div class="glass-card">
        <div class="card-title-row">
          <div class="card-title"><span>📁</span><span id="proj-title">Workspace</span></div>
          <button class="btn btn-secondary" id="refreshStatusBtn" style="width:auto; padding:3px 8px; font-size:10px;">🔄</button>
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
        <div class="card-title"><span>🚀</span><span>DELIVERY PIPELINE</span></div>
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
          <a href="#" class="url-link" id="prod-url-link" target="_blank">🔗 Open Live Production</a>
        </div>
      </div>
    </div>

    <!-- TAB 3: CLOUD & AWS DEPLOYMENTS -->
    <div id="tab-cloud" class="view-panel">
      <div class="glass-card">
        <div class="card-title-row">
          <div class="card-title"><span>☁️</span><span id="cloud-provider-name">AWS App Runner</span></div>
          <div class="status-pill live" id="cloud-conn-pill">● Connected</div>
        </div>
        <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 8px;" id="cloud-region-text">
          Region: us-east-1
        </div>
        <div class="btn-group">
          <button class="btn" id="cloudDeployBtn">🚀 Redeploy</button>
          <button class="btn btn-secondary" id="cloudRollbackBtn">⏪ Rollback</button>
          <button class="btn btn-secondary" id="cloudLogsBtn">📜 Logs</button>
        </div>
      </div>

      <!-- Stages & Health -->
      <div class="glass-card">
        <div class="card-title"><span>⚡</span><span>STAGE MONITOR</span></div>
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
          <a href="#" class="url-link" id="cloud-live-url" target="_blank">🔗 Open Deployment URL</a>
        </div>
      </div>
    </div>

    <!-- TAB 4: GITHUB CONTROL -->
    <div id="tab-github" class="view-panel">
      <div class="glass-card">
        <div class="card-title-row">
          <div class="card-title"><span>🐙</span><span>ACCOUNT & REPO</span></div>
          <div class="status-pill live" id="gh-conn-pill">Connected</div>
        </div>
        <div style="font-size: 11.5px; margin-bottom: 8px;" id="gh-repo-name">
          Repository: Connecting...
        </div>
        <div class="btn-group" style="flex-direction: column;">
          <button class="btn" id="ghCreateRepoBtn">➕ Create GitHub Repo & Push</button>
          <button class="btn btn-secondary" id="ghPushBtn">⬆ Push Commits</button>
          <button class="btn btn-secondary" id="ghCreatePRBtn">🔀 Create Pull Request</button>
        </div>
      </div>
    </div>

  </div>

  <script>
    const vscode = acquireVsCodeApi();

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
        appendMsg('ai', '❌ ' + msg.error);
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
        p.innerHTML = '💭 ' + escapeHtml(ev.data.text);
        currentAiCard.appendChild(p);
      } else if (ev.type === 'tool_start') {
        const box = document.createElement('div');
        box.style.padding = '4px 8px';
        box.style.background = 'rgba(0,229,255,0.08)';
        box.style.borderRadius = '4px';
        box.style.margin = '4px 0';
        box.style.fontSize = '11px';
        box.innerHTML = '⚙️ Executing <b>' + ev.data.name + '</b>...';
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
        a.textContent = '🔗 ' + ov.production.url;
        a.onclick = (e) => { e.preventDefault(); vscode.postMessage({ type: 'openUrl', url: ov.production.url }); };
      }

      // Cloud
      document.getElementById('cloud-provider-name').textContent = d.cloud.provider.name;
      document.getElementById('cloud-region-text').textContent = 'Region: ' + d.cloud.provider.region;
      if (d.cloud.latestDeploy?.url) {
        document.getElementById('cloud-live-url-box').style.display = 'block';
        const ca = document.getElementById('cloud-live-url');
        ca.textContent = '🔗 ' + d.cloud.latestDeploy.url;
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
