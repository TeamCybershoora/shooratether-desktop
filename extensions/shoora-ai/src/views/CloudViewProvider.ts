/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cybershoora Pvt. Ltd. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CloudRegistry } from '../cloud/CloudRegistry.js';
import { DeploymentRecord, CloudLogEntry } from '../cloud/types.js';

export class CloudViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'shoora.cloudView';
    private _view?: vscode.WebviewView;
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
                case 'deploy':
                    await this.handleDeploy();
                    break;
                case 'redeploy':
                    await this.handleDeploy();
                    break;
                case 'rollback':
                    await this.handleRollback();
                    break;
                case 'viewLogs':
                    await this.handleViewLogs();
                    break;
                case 'openUrl':
                    if (data.url) {
                        vscode.env.openExternal(vscode.Uri.parse(data.url));
                    }
                    break;
                case 'selectProvider':
                    if (data.providerId) {
                        this.cloudRegistry.setActiveProvider(data.providerId);
                        await this.refreshData();
                    }
                    break;
            }
        });

        this.refreshData();
    }

    public async refreshData() {
        if (!this._view) return;

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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

        const providersList = this.cloudRegistry.listProviders();
        const projectName = workspaceRoot ? workspaceRoot.split(/[\/\\]/).pop() || 'Workspace' : 'No Folder Open';

        this._view.webview.postMessage({
            type: 'state',
            data: {
                provider: {
                    id: provider.id,
                    name: provider.name,
                    icon: provider.icon,
                    connected: connection.connected,
                    region: connection.region,
                    details: connection.details
                },
                providersList,
                projectName,
                latestDeploy,
                history,
                logs
            }
        });
    }

    private async handleDeploy() {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            vscode.window.showWarningMessage('Open a project folder to deploy.');
            return;
        }

        const confirm = await vscode.window.showInformationMessage(
            `Confirm Deployment: Deploy project to ${this.cloudRegistry.getActiveProvider().name}?`,
            { modal: true },
            'Deploy to Production'
        );

        if (confirm !== 'Deploy to Production') return;

        const provider = this.cloudRegistry.getActiveProvider();

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `SHOORA Cloud: Deploying to ${provider.name}...`,
            cancellable: false
        }, async (progress) => {
            try {
                progress.report({ message: 'Building & Provisioning...' });
                const result = await provider.deploy(workspaceRoot, { targetEnvironment: 'production' });
                if (result.status === 'live') {
                    vscode.window.showInformationMessage(
                        `🚀 Deployment Live! URL: ${result.url}`,
                        'Open URL'
                    ).then((choice) => {
                        if (choice === 'Open URL' && result.url) {
                            vscode.env.openExternal(vscode.Uri.parse(result.url));
                        }
                    });
                } else {
                    vscode.window.showErrorMessage(`Deployment failed: ${result.errorMessage || 'Check logs'}`);
                }
                await this.refreshData();
            } catch (err: any) {
                vscode.window.showErrorMessage(`Deploy error: ${err.message || err}`);
            }
        });
    }

    private async handleRollback() {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            vscode.window.showWarningMessage('Open a workspace folder to rollback.');
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            'Confirm Rollback: This will redirect production traffic to the previous stable release.',
            { modal: true },
            'Rollback Now'
        );

        if (confirm !== 'Rollback Now') return;

        const provider = this.cloudRegistry.getActiveProvider();
        try {
            const rollback = await provider.rollback(workspaceRoot);
            vscode.window.showInformationMessage(`✓ Successfully rolled back to ${rollback.version}`);
            await this.refreshData();
        } catch (err: any) {
            vscode.window.showErrorMessage(`Rollback failed: ${err.message || err}`);
        }
    }

    private async handleViewLogs() {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return;

        const provider = this.cloudRegistry.getActiveProvider();
        const logs = await provider.getLogs(workspaceRoot, undefined, 50);

        const channel = vscode.window.createOutputChannel(`SHOORA Cloud Logs (${provider.name})`);
        channel.clear();
        channel.show();

        if (logs.length === 0) {
            channel.appendLine('No deployment logs recorded.');
            return;
        }

        for (const log of logs) {
            const time = new Date(log.timestamp).toLocaleTimeString();
            const stage = log.stage ? `[${log.stage.toUpperCase()}] ` : '';
            channel.appendLine(`[${time}] [${log.level.toUpperCase()}] ${stage}${log.message}`);
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
            --text-color: var(--vscode-sideBar-foreground);
            --border-color: var(--vscode-sideBarSectionHeader-border, #333333);
            --btn-bg: var(--vscode-button-background);
            --btn-fg: var(--vscode-button-foreground);
            --btn-hover: var(--vscode-button-hoverBackground);
            --badge-bg: var(--vscode-badge-background);
            --badge-fg: var(--vscode-badge-foreground);
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
        .card {
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 12px;
            margin-bottom: 12px;
        }
        .section-label {
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground, #888);
            margin-bottom: 4px;
        }
        .status-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 8px;
        }
        .status-pill {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            font-size: 11px;
            font-weight: 600;
            padding: 2px 8px;
            border-radius: 12px;
        }
        .status-pill.live {
            background: rgba(46, 204, 113, 0.15);
            color: var(--green);
            border: 1px solid rgba(46, 204, 113, 0.3);
        }
        .status-pill.failed {
            background: rgba(231, 76, 60, 0.15);
            color: var(--red);
            border: 1px solid rgba(231, 76, 60, 0.3);
        }
        .status-pill.deploying {
            background: rgba(241, 196, 15, 0.15);
            color: var(--yellow);
            border: 1px solid rgba(241, 196, 15, 0.3);
        }
        .stages-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 6px;
            background: rgba(0, 0, 0, 0.2);
            padding: 8px;
            border-radius: 4px;
            margin-top: 8px;
            text-align: center;
        }
        .stage-box {
            font-size: 11px;
        }
        .stage-title {
            color: var(--vscode-descriptionForeground, #888);
            font-size: 10px;
            margin-bottom: 2px;
        }
        .stage-badge {
            font-weight: 600;
        }
        .stage-badge.success { color: var(--green); }
        .stage-badge.failed { color: var(--red); }
        .stage-badge.running { color: var(--yellow); }
        .stage-badge.pending { color: var(--vscode-descriptionForeground, #888); }

        .btn-group {
            display: flex;
            gap: 6px;
            margin-top: 10px;
        }
        .btn {
            flex: 1;
            background: var(--btn-bg);
            color: var(--btn-fg);
            border: none;
            padding: 6px 10px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            text-align: center;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 5px;
        }
        .btn:hover {
            background: var(--btn-hover);
        }
        .btn-secondary {
            background: rgba(255, 255, 255, 0.08);
            color: var(--text-color);
        }
        .btn-secondary:hover {
            background: rgba(255, 255, 255, 0.14);
        }
        .url-box {
            margin-top: 8px;
            word-break: break-all;
            font-size: 11px;
        }
        .url-link {
            color: var(--vscode-textLink-foreground, #3794ff);
            text-decoration: none;
        }
        .url-link:hover {
            text-decoration: underline;
        }
        .history-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 0;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            font-size: 12px;
        }
        .history-item:last-child {
            border-bottom: none;
        }
        .pulse-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            display: inline-block;
        }
        .pulse-dot.connected { background: var(--green); }
        .pulse-dot.disconnected { background: var(--red); }
    </style>
</head>
<body>
    <div class="header">
        <div class="title-group">
            <span>☁️</span>
            <span>Cloud & Deployments</span>
        </div>
        <button class="icon-btn" id="refresh-btn" title="Refresh Cloud Status">🔄</button>
    </div>

    <!-- Provider Header Card -->
    <div class="card">
        <div class="status-row">
            <div>
                <div class="section-label">Cloud Provider</div>
                <div style="font-weight: 600; font-size: 13px;" id="provider-name">AWS</div>
            </div>
            <div id="connection-pill" class="status-pill live">
                <span class="pulse-dot connected"></span>
                <span id="connection-text">Connected</span>
            </div>
        </div>
        <div style="font-size: 11px; color: var(--vscode-descriptionForeground);" id="provider-details">
            Region: us-east-1
        </div>
    </div>

    <!-- Project & Production Card -->
    <div class="card">
        <div class="section-label">Project</div>
        <div style="font-weight: 600; font-size: 14px; margin-bottom: 8px;" id="project-name">Loading...</div>

        <div class="status-row">
            <div>
                <div class="section-label">Production Status</div>
                <div id="prod-status-pill" class="status-pill live">🟢 Live</div>
            </div>
            <div style="text-align: right;">
                <div class="section-label">Deployment</div>
                <div style="font-family: monospace; font-size: 12px;" id="deploy-version">v1.0.0</div>
            </div>
        </div>

        <!-- Stage Checklist -->
        <div class="stages-grid">
            <div class="stage-box">
                <div class="stage-title">BUILD</div>
                <div class="stage-badge success" id="stage-build">✓</div>
            </div>
            <div class="stage-box">
                <div class="stage-title">DEPLOY</div>
                <div class="stage-badge success" id="stage-deploy">✓</div>
            </div>
            <div class="stage-box">
                <div class="stage-title">HEALTH</div>
                <div class="stage-badge success" id="stage-health">✓</div>
            </div>
        </div>

        <!-- Live URL -->
        <div class="url-box" id="url-container" style="display: none;">
            <a href="#" class="url-link" id="live-url" target="_blank"></a>
        </div>

        <!-- Actions -->
        <div class="btn-group">
            <button class="btn" id="redeploy-btn">🚀 Redeploy</button>
            <button class="btn btn-secondary" id="logs-btn">📜 View Logs</button>
            <button class="btn btn-secondary" id="rollback-btn" title="Revert to previous release">⏪ Rollback</button>
        </div>
    </div>

    <!-- Recent Deployments -->
    <div class="card">
        <div class="section-label" style="margin-bottom: 8px;">Recent Deployments</div>
        <div id="history-container">
            <div style="color: var(--vscode-descriptionForeground); font-size: 12px;">No deployments yet. Click "Redeploy" to launch.</div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        document.getElementById('refresh-btn').addEventListener('click', () => {
            vscode.postMessage({ type: 'refresh' });
        });

        document.getElementById('redeploy-btn').addEventListener('click', () => {
            vscode.postMessage({ type: 'redeploy' });
        });

        document.getElementById('logs-btn').addEventListener('click', () => {
            vscode.postMessage({ type: 'viewLogs' });
        });

        document.getElementById('rollback-btn').addEventListener('click', () => {
            vscode.postMessage({ type: 'rollback' });
        });

        document.getElementById('live-url').addEventListener('click', (e) => {
            e.preventDefault();
            const url = e.target.getAttribute('data-url');
            if (url) {
                vscode.postMessage({ type: 'openUrl', url });
            }
        });

        window.addEventListener('message', (event) => {
            const { type, data } = event.data;
            if (type === 'state') {
                renderState(data);
            }
        });

        function renderState(data) {
            document.getElementById('project-name').textContent = data.projectName || 'Active Workspace';

            // Provider
            document.getElementById('provider-name').textContent = data.provider.name;
            const connPill = document.getElementById('connection-pill');
            const connText = document.getElementById('connection-text');
            const detailsText = document.getElementById('provider-details');

            if (data.provider.connected) {
                connPill.className = 'status-pill live';
                connPill.querySelector('.pulse-dot').className = 'pulse-dot connected';
                connText.textContent = 'Connected';
            } else {
                connPill.className = 'status-pill failed';
                connPill.querySelector('.pulse-dot').className = 'pulse-dot disconnected';
                connText.textContent = 'Standby';
            }
            detailsText.textContent = (data.provider.details ? data.provider.details + ' • ' : '') + 'Region: ' + (data.provider.region || 'us-east-1');

            // Latest deploy
            const deploy = data.latestDeploy;
            const prodPill = document.getElementById('prod-status-pill');
            const versionEl = document.getElementById('deploy-version');
            const buildEl = document.getElementById('stage-build');
            const deployEl = document.getElementById('stage-deploy');
            const healthEl = document.getElementById('stage-health');
            const urlContainer = document.getElementById('url-container');
            const liveUrl = document.getElementById('live-url');

            if (deploy) {
                versionEl.textContent = deploy.version;
                if (deploy.status === 'live') {
                    prodPill.className = 'status-pill live';
                    prodPill.textContent = '🟢 Live';
                } else if (deploy.status === 'deploying' || deploy.status === 'building') {
                    prodPill.className = 'status-pill deploying';
                    prodPill.textContent = '🟡 ' + deploy.status.toUpperCase();
                } else {
                    prodPill.className = 'status-pill failed';
                    prodPill.textContent = '🔴 Failed';
                }

                setStageBadge(buildEl, deploy.stages.build);
                setStageBadge(deployEl, deploy.stages.deploy);
                setStageBadge(healthEl, deploy.stages.health);

                if (deploy.url) {
                    urlContainer.style.display = 'block';
                    liveUrl.textContent = '🔗 ' + deploy.url;
                    liveUrl.setAttribute('data-url', deploy.url);
                } else {
                    urlContainer.style.display = 'none';
                }
            } else {
                versionEl.textContent = 'v0.0.0';
                prodPill.className = 'status-pill deploying';
                prodPill.textContent = '⚪ Ready';
                setStageBadge(buildEl, 'pending');
                setStageBadge(deployEl, 'pending');
                setStageBadge(healthEl, 'pending');
                urlContainer.style.display = 'none';
            }

            // History
            const histContainer = document.getElementById('history-container');
            if (data.history && data.history.length > 0) {
                histContainer.innerHTML = data.history.map(h => {
                    const statusEmoji = h.status === 'live' ? '🟢' : h.status === 'failed' ? '🔴' : '🟡';
                    const time = new Date(h.timestamp).toLocaleTimeString();
                    return \`
                        <div class="history-item">
                            <div>
                                <span>\${statusEmoji} <strong>\${h.version}</strong></span>
                                <div style="font-size: 10px; color: var(--vscode-descriptionForeground);">\${h.commitHash ? h.commitHash + ' • ' : ''}\${time}</div>
                            </div>
                            <div>
                                <span style="font-size: 11px; text-transform: capitalize;">\${h.status}</span>
                            </div>
                        </div>
                    \`;
                }).join('');
            } else {
                histContainer.innerHTML = '<div style="color: var(--vscode-descriptionForeground); font-size: 12px;">No deployments yet. Click "Redeploy" to launch.</div>';
            }
        }

        function setStageBadge(el, status) {
            el.className = 'stage-badge ' + (status || 'pending');
            if (status === 'success') el.textContent = '✓';
            else if (status === 'failed') el.textContent = '✗';
            else if (status === 'running') el.textContent = '⟳';
            else el.textContent = '-';
        }
    </script>
</body>
</html>`;
    }
}
