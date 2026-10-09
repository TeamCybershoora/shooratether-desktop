/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cybershoora Pvt. Ltd. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GitHubService, GitHubUser, GitHubPullRequest, GitHubWorkflowRun } from '../github/GitHubService.js';
import { GitService, GitStatusSummary } from '../git/GitService.js';

export class GitHubViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'shoora.githubView';
    private _view?: vscode.WebviewView;
    private githubService = GitHubService.getInstance();
    private gitService = new GitService();

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtmlForWebview();

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'login':
                    await this.handleLogin();
                    break;
                case 'refresh':
                    await this.refreshData();
                    break;
                case 'createRepo':
                    await this.promptCreateRepo();
                    break;
                case 'createPR':
                    await this.promptCreatePR();
                    break;
                case 'push':
                    await this.handlePush();
                    break;
                case 'openUrl':
                    if (data.url) {
                        vscode.env.openExternal(vscode.Uri.parse(data.url));
                    }
                    break;
            }
        });

        // Initial load
        this.refreshData();
    }

    private async handleLogin() {
        const session = await this.githubService.getSession(true);
        if (session) {
            vscode.window.showInformationMessage(`✓ Signed in to GitHub as ${session.account.label}`);
            await this.refreshData();
        }
    }

    public async refreshData() {
        if (!this._view) return;

        let user: GitHubUser | undefined;
        let isAuth = false;
        try {
            isAuth = await this.githubService.isAuthenticated();
            if (isAuth) {
                user = await this.githubService.getCurrentUser();
            }
        } catch {}

        let gitStatus: GitStatusSummary | undefined;
        try {
            gitStatus = await this.gitService.getStatus();
        } catch {}

        let currentRepo: { owner: string; repo: string } | undefined;
        let prs: GitHubPullRequest[] = [];
        let workflowRuns: GitHubWorkflowRun[] = [];

        if (gitStatus?.remotes) {
            for (const r of gitStatus.remotes) {
                const parsed = this.githubService.parseGitHubRemote(r.url);
                if (parsed) {
                    currentRepo = parsed;
                    break;
                }
            }
        }

        if (isAuth && currentRepo) {
            try {
                prs = await this.githubService.listPullRequests(currentRepo.owner, currentRepo.repo, 'open');
            } catch {}
            try {
                workflowRuns = await this.githubService.getWorkflowRuns(currentRepo.owner, currentRepo.repo);
            } catch {}
        }

        this._view.webview.postMessage({
            type: 'stateUpdate',
            data: {
                isAuth,
                user,
                gitStatus,
                currentRepo,
                prs,
                workflowRuns: workflowRuns.slice(0, 6)
            }
        });
    }

    private async promptCreateRepo() {
        const root = vscode.workspace.workspaceFolders?.[0]?.name || 'my-project';
        const name = await vscode.window.showInputBox({
            prompt: 'Enter repository name',
            value: root.toLowerCase().replace(/[^a-z0-9_-]/g, '-')
        });
        if (!name) return;

        const isPrivate = await vscode.window.showQuickPick(['Private', 'Public'], {
            placeHolder: 'Repository visibility'
        }) === 'Private';

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Creating GitHub repository "${name}"...`,
            cancellable: false
        }, async () => {
            try {
                const repo = await this.githubService.createRepository({ name, private: isPrivate });
                if (!this.gitService.isRepo()) {
                    await this.gitService.init();
                }
                const status = await this.gitService.getStatus();
                if (!status.isClean || status.stagedCount > 0 || status.unstagedCount > 0 || status.untrackedCount > 0) {
                    await this.gitService.commit('Initial commit by SHOORA TETHER', true);
                }
                await this.gitService.addRemote('origin', repo.clone_url);
                await this.gitService.push('origin', status.currentBranch || 'main', true);

                vscode.window.showInformationMessage(`✓ Repository created & pushed: ${repo.html_url}`);
                await this.refreshData();
            } catch (err: any) {
                vscode.window.showErrorMessage(`GitHub Error: ${err.message || err}`);
            }
        });
    }

    private async promptCreatePR() {
        const gitStatus = await this.gitService.getStatus();
        const head = gitStatus.currentBranch;
        if (!head || head === 'main' || head === 'master') {
            vscode.window.showWarningMessage('Please switch to a feature branch before opening a Pull Request.');
            return;
        }

        const title = await vscode.window.showInputBox({
            prompt: `Pull Request title (merging ${head} -> main)`,
            value: `feat: ${head.replace(/[-_]/g, ' ')}`
        });
        if (!title) return;

        let repoInfo: { owner: string; repo: string } | undefined;
        for (const r of gitStatus.remotes) {
            repoInfo = this.githubService.parseGitHubRemote(r.url);
            if (repoInfo) break;
        }

        if (!repoInfo) {
            vscode.window.showErrorMessage('No GitHub remote found in git configuration.');
            return;
        }

        try {
            const pr = await this.githubService.createPullRequest({
                owner: repoInfo.owner,
                repo: repoInfo.repo,
                title,
                head,
                base: 'main'
            });
            vscode.window.showInformationMessage(`✓ Pull Request #${pr.number} created: ${pr.html_url}`);
            await this.refreshData();
        } catch (err: any) {
            vscode.window.showErrorMessage(`PR Error: ${err.message || err}`);
        }
    }

    private async handlePush() {
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Pushing changes to GitHub...',
                cancellable: false
            }, async () => {
                const res = await this.gitService.push();
                vscode.window.showInformationMessage(res);
                await this.refreshData();
            });
        } catch (err: any) {
            vscode.window.showErrorMessage(`Push failed: ${err.message || err}`);
        }
    }

    private _getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      background: var(--vscode-sideBar-background);
      color: var(--vscode-foreground);
      margin: 0;
      padding: 10px;
      font-size: 12px;
      line-height: 1.4;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      border-bottom: 1px solid var(--vscode-sideBar-border);
      padding-bottom: 8px;
    }
    .title {
      font-weight: 600;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .section {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.08));
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 10px;
    }
    .section-title {
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .user-pill {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .avatar {
      width: 24px;
      height: 24px;
      border-radius: 50%;
    }
    .btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      padding: 6px 12px;
      cursor: pointer;
      font-weight: 500;
      font-size: 11.5px;
      width: 100%;
      box-sizing: border-box;
      text-align: center;
      margin-top: 6px;
    }
    .btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground, rgba(255,255,255,0.1));
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    }
    .btn-secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(255,255,255,0.18));
    }
    .row {
      display: flex;
      justify-content: space-between;
      padding: 3px 0;
      color: var(--vscode-descriptionForeground);
    }
    .row-val {
      color: var(--vscode-foreground);
      font-weight: 500;
    }
    .item-card {
      background: rgba(0, 0, 0, 0.2);
      border-radius: 4px;
      padding: 6px 8px;
      margin-top: 5px;
      cursor: pointer;
    }
    .item-card:hover {
      background: rgba(255, 255, 255, 0.05);
    }
    .status-badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 10px;
      font-size: 10px;
      font-weight: 600;
    }
    .status-success { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
    .status-failure { background: rgba(239, 68, 68, 0.2); color: #f87171; }
    .status-in_progress { background: rgba(234, 179, 8, 0.2); color: #facc15; }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">🐙 GitHub Control</div>
    <button class="btn btn-secondary" style="width:auto; padding:2px 8px; margin:0;" id="refreshBtn">↻</button>
  </div>

  <!-- Account Status -->
  <div class="section" id="authSection">
    <div class="section-title">Account</div>
    <div id="authContent">Checking connection...</div>
  </div>

  <!-- Repository Info -->
  <div class="section" id="repoSection">
    <div class="section-title">Repository</div>
    <div id="repoContent">Loading repository details...</div>
  </div>

  <!-- Pull Requests -->
  <div class="section" id="prSection">
    <div class="section-title">
      <span>Pull Requests</span>
      <span id="prCount">(0)</span>
    </div>
    <div id="prContent">No open Pull Requests.</div>
    <button class="btn btn-secondary" id="createPrBtn">Create Pull Request</button>
  </div>

  <!-- CI/CD Workflows -->
  <div class="section" id="actionsSection">
    <div class="section-title">GitHub Actions</div>
    <div id="actionsContent">No recent workflow runs.</div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    document.getElementById('refreshBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });
    document.getElementById('createPrBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'createPR' });
    });

    window.addEventListener('message', (event) => {
      const data = event.data;
      if (data.type === 'stateUpdate') {
        renderState(data.data);
      }
    });

    function renderState(state) {
      // 1. Account
      const authEl = document.getElementById('authContent');
      if (state.isAuth && state.user) {
        authEl.innerHTML = '<div class="user-pill">' +
          '<img class="avatar" src="' + state.user.avatar_url + '" />' +
          '<div><b>@' + escapeHtml(state.user.login) + '</b><br/><span style="font-size:10.5px; opacity:0.8;">' + escapeHtml(state.user.name || '') + '</span></div>' +
        '</div>';
      } else {
        authEl.innerHTML = '<div>Not connected to GitHub</div>' +
          '<button class="btn" id="connectBtn">Connect GitHub Account</button>';
        document.getElementById('connectBtn')?.addEventListener('click', () => {
          vscode.postMessage({ type: 'login' });
        });
      }

      // 2. Repository
      const repoEl = document.getElementById('repoContent');
      if (state.currentRepo) {
        repoEl.innerHTML = '<div class="row"><span>Repo:</span><span class="row-val"><a href="#" id="viewRepoLink">' + escapeHtml(state.currentRepo.owner + '/' + state.currentRepo.repo) + '</a></span></div>' +
          '<div class="row"><span>Branch:</span><span class="row-val">' + escapeHtml(state.gitStatus?.currentBranch || 'main') + '</span></div>' +
          '<div class="row"><span>Sync:</span><span class="row-val">' + (state.gitStatus?.aheadCount ? '↑' + state.gitStatus.aheadCount : '') + (state.gitStatus?.behindCount ? ' ↓' + state.gitStatus.behindCount : '') + (state.gitStatus?.isClean ? ' Synced' : ' Modified') + '</span></div>' +
          '<button class="btn btn-secondary" id="pushBtn">Push Changes</button>';

        document.getElementById('viewRepoLink')?.addEventListener('click', () => {
          vscode.postMessage({ type: 'openUrl', url: 'https://github.com/' + state.currentRepo.owner + '/' + state.currentRepo.repo });
        });
        document.getElementById('pushBtn')?.addEventListener('click', () => {
          vscode.postMessage({ type: 'push' });
        });
      } else {
        repoEl.innerHTML = '<div style="margin-bottom:6px; color:var(--vscode-descriptionForeground);">No GitHub remote connected to this workspace.</div>' +
          '<button class="btn" id="createRepoBtn">+ Create GitHub Repository & Push</button>';
        document.getElementById('createRepoBtn')?.addEventListener('click', () => {
          vscode.postMessage({ type: 'createRepo' });
        });
      }

      // 3. PRs
      const prEl = document.getElementById('prContent');
      const prCountEl = document.getElementById('prCount');
      if (state.prs && state.prs.length > 0) {
        prCountEl.textContent = '(' + state.prs.length + ')';
        prEl.innerHTML = state.prs.map(p => 
          '<div class="item-card" onclick="openUrl(\'' + p.html_url + '\')">' +
            '<b>#' + p.number + ' ' + escapeHtml(p.title) + '</b><br/>' +
            '<span style="font-size:10.5px; opacity:0.8;">' + escapeHtml(p.head.ref) + ' → ' + escapeHtml(p.base.ref) + ' by @' + escapeHtml(p.user.login) + '</span>' +
          '</div>'
        ).join('');
      } else {
        prCountEl.textContent = '(0)';
        prEl.innerHTML = '<div style="opacity:0.8; font-size:11px;">No open Pull Requests</div>';
      }

      // 4. Actions
      const actEl = document.getElementById('actionsContent');
      if (state.workflowRuns && state.workflowRuns.length > 0) {
        actEl.innerHTML = state.workflowRuns.map(r => {
          const badgeClass = 'status-' + (r.conclusion || r.status);
          const label = r.conclusion ? r.conclusion.toUpperCase() : r.status.toUpperCase();
          return '<div class="item-card" onclick="openUrl(\'' + r.html_url + '\')">' +
            '<div style="display:flex; justify-content:space-between; align-items:center;">' +
              '<b>' + escapeHtml(r.name) + '</b>' +
              '<span class="status-badge ' + badgeClass + '">' + label + '</span>' +
            '</div>' +
            '<span style="font-size:10.5px; opacity:0.8;">' + escapeHtml(r.head_branch) + ' (' + r.head_sha.substring(0, 7) + ')</span>' +
          '</div>';
        }).join('');
      } else {
        actEl.innerHTML = '<div style="opacity:0.8; font-size:11px;">No GitHub Actions runs found.</div>';
      }
    }

    function openUrl(url) {
      vscode.postMessage({ type: 'openUrl', url });
    }

    function escapeHtml(unsafe) {
      return (unsafe || '').replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }
  </script>
</body>
</html>`;
    }
}
