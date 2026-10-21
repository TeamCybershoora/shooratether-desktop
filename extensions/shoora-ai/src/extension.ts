/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cybershoora Pvt. Ltd. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AgentOrchestrator } from './agent/AgentOrchestrator.js';
import { ApprovalRequest } from './agent/types.js';
import { GitHubViewProvider } from './views/GitHubViewProvider.js';
import { CloudViewProvider } from './views/CloudViewProvider.js';
import { ProjectStatusProvider } from './views/ProjectStatusProvider.js';
import { ShooraUnifiedHubViewProvider } from './views/UnifiedHubViewProvider.js';
import { CodebaseIndexer } from './indexer/CodebaseIndexer.js';
import { InlineEditProvider } from './editor/InlineEditProvider.js';
import { ShooraInlineCompletionProvider } from './editor/InlineCompletionProvider.js';
import { AuthService, UserProfile } from './auth/AuthService.js';
import { ShooraUriHandler } from './auth/ShooraUriHandler.js';

let globalOrchestrator: AgentOrchestrator | undefined;
let globalHubProvider: ShooraUnifiedHubViewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
    // 0. Initialize Central Auth & Deep Link URI Handler
    const authService = AuthService.initialize(context);
    const uriHandler = new ShooraUriHandler();
    context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));

    // Status Bar Item for SHOORA User Profile / Auth State
    const authStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    authStatusBarItem.command = 'shoora.auth.showAccount';
    context.subscriptions.push(authStatusBarItem);

    const updateAuthStatusBar = (user: UserProfile | null) => {
        if (user) {
            const planBadge = (user.plan || 'free').toUpperCase();
            const displayName = user.name || user.email.split('@')[0];
            authStatusBarItem.text = `$(account) ${displayName} (${planBadge})`;
            authStatusBarItem.tooltip = `Logged in as ${user.email}\nPlan: ${planBadge}\nProvider: ${user.authProvider}\nClick to manage account.`;
        } else {
            authStatusBarItem.text = `$(sign-in) Sign in to SHOORA`;
            authStatusBarItem.tooltip = `Sign in with Google or GitHub to sync account and quotas.`;
        }
        authStatusBarItem.show();
    };

    authService.onDidChangeUser((user) => {
        updateAuthStatusBar(user);
    });

    // Check & restore existing session from context.secrets
    authService.restoreSession().then(updateAuthStatusBar);

    // Register Auth Commands
    const loginGoogleCmd = vscode.commands.registerCommand('shoora.auth.loginGoogle', async () => {
        await authService.loginWithGoogle();
    });

    const loginGitHubCmd = vscode.commands.registerCommand('shoora.auth.loginGitHub', async () => {
        await authService.loginWithGitHub();
    });

    const logoutCmd = vscode.commands.registerCommand('shoora.auth.logout', async () => {
        const confirm = await vscode.window.showWarningMessage('Are you sure you want to sign out of SHOORA TETHER?', 'Sign Out', 'Cancel');
        if (confirm === 'Sign Out') {
            await authService.logout();
        }
    });

    const showAccountCmd = vscode.commands.registerCommand('shoora.auth.showAccount', async () => {
        const user = authService.getUser();
        if (!user) {
            const choice = await vscode.window.showQuickPick([
                { label: '$(globe) Sign in with Google', description: 'Connect via Google OAuth', id: 'google' },
                { label: '$(github) Sign in with GitHub', description: 'Connect via GitHub OAuth', id: 'github' }
            ], { placeHolder: 'Sign in to SHOORA TETHER' });

            if (choice?.id === 'google') await authService.loginWithGoogle();
            if (choice?.id === 'github') await authService.loginWithGitHub();
        } else {
            const planBadge = (user.plan || 'free').toUpperCase();
            const choice = await vscode.window.showQuickPick([
                { label: `$(account) ${user.name || user.email}`, detail: `Plan: ${planBadge} | Email: ${user.email}`, id: 'info' },
                { label: '$(globe) Open SHOORA Web Dashboard', id: 'dashboard' },
                { label: '$(sign-out) Sign Out', id: 'logout' }
            ], { placeHolder: `SHOORA Account (${user.email})` });

            if (choice?.id === 'dashboard') {
                vscode.env.openExternal(vscode.Uri.parse(authService.getAuthServerUrl()));
            } else if (choice?.id === 'logout') {
                await authService.logout();
            }
        }
    });

    context.subscriptions.push(loginGoogleCmd, loginGitHubCmd, logoutCmd, showAccountCmd);

    const orchestrator = new AgentOrchestrator();
    globalOrchestrator = orchestrator;

    const hubProvider = new ShooraUnifiedHubViewProvider(context.extensionUri, orchestrator);
    globalHubProvider = hubProvider;

    const chatProvider = new ShooraChatViewProvider(context.extensionUri, orchestrator);
    const githubProvider = new GitHubViewProvider(context.extensionUri);
    const cloudProvider = new CloudViewProvider(context.extensionUri);
    const projectStatusProvider = new ProjectStatusProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ShooraUnifiedHubViewProvider.viewType, hubProvider),
        vscode.window.registerWebviewViewProvider(ShooraChatViewProvider.viewType, chatProvider),
        vscode.window.registerWebviewViewProvider(GitHubViewProvider.viewType, githubProvider),
        vscode.window.registerWebviewViewProvider(CloudViewProvider.viewType, cloudProvider),
        vscode.window.registerWebviewViewProvider(ProjectStatusProvider.viewType, projectStatusProvider)
    );

    const ghCreateRepoCmd = vscode.commands.registerCommand('shoora.github.createRepo', async () => {
        vscode.commands.executeCommand('shoora.githubView.focus');
    });

    const ghCreatePRCmd = vscode.commands.registerCommand('shoora.github.createPR', async () => {
        vscode.commands.executeCommand('shoora.githubView.focus');
    });

    const ghRefreshCmd = vscode.commands.registerCommand('shoora.github.refresh', async () => {
        await githubProvider.refreshData();
    });

    const cloudDeployCmd = vscode.commands.registerCommand('shoora.cloud.deploy', async () => {
        vscode.commands.executeCommand('shoora.cloudView.focus');
    });

    const cloudRollbackCmd = vscode.commands.registerCommand('shoora.cloud.rollback', async () => {
        vscode.commands.executeCommand('shoora.cloudView.focus');
    });

    const cloudRefreshCmd = vscode.commands.registerCommand('shoora.cloud.refresh', async () => {
        await cloudProvider.refreshData();
    });

    const projectRefreshCmd = vscode.commands.registerCommand('shoora.project.refresh', async () => {
        await projectStatusProvider.refreshData();
    });

    context.subscriptions.push(
        ghCreateRepoCmd,
        ghCreatePRCmd,
        ghRefreshCmd,
        cloudDeployCmd,
        cloudRollbackCmd,
        cloudRefreshCmd,
        projectRefreshCmd
    );

    // 1. Initialize Codebase Indexer (RAG Search)
    const indexer = CodebaseIndexer.getInstance();
    indexer.indexWorkspace();
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
        indexer.indexWorkspace();
    });

    const reindexCmd = vscode.commands.registerCommand('shoora.reindexCodebase', async () => {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "SHOORA AI: Indexing codebase..."
        }, async () => {
            await indexer.indexWorkspace();
            const stats = indexer.getStats();
            vscode.window.showInformationMessage(`✓ Indexed ${stats.indexedFiles} files (${stats.chunksCount} code chunks).`);
        });
    });

    // 2. Initialize Interactive Inline Edit (Ctrl+K)
    const inlineEditProvider = new InlineEditProvider();
    const inlineEditCmd = vscode.commands.registerCommand('shoora.inlineEdit', async () => {
        await inlineEditProvider.executeInlineEdit();
    });

    // 3. Initialize AI Autocomplete (Tab Ghost Text)
    const inlineCompletionProvider = new ShooraInlineCompletionProvider();
    const inlineCompletionRegistration = vscode.languages.registerInlineCompletionItemProvider(
        { pattern: '**' },
        inlineCompletionProvider
    );

    const toggleAutocompleteCmd = vscode.commands.registerCommand('shoora.toggleAutocomplete', () => {
        inlineCompletionProvider.toggle();
    });

    context.subscriptions.push(
        reindexCmd,
        inlineEditCmd,
        inlineCompletionRegistration,
        inlineCompletionProvider.getStatusBarItem(),
        toggleAutocompleteCmd
    );

    const openChatCmd = vscode.commands.registerCommand('shoora.openChat', () => {
        vscode.commands.executeCommand('shoora.chatView.focus');
    });

    const runAgentTaskCmd = vscode.commands.registerCommand('shoora.runAgentTask', async () => {
        const prompt = await vscode.window.showInputBox({
            prompt: 'Ask Shoora AI Agent to perform a task',
            placeHolder: 'e.g. inspect project and run tests, deploy to AWS, create GitHub repo...'
        });
        if (!prompt) return;
        vscode.commands.executeCommand('shoora.chatView.focus');
        chatProvider.sendCustomMessage(prompt);
    });

    const cancelTaskCmd = vscode.commands.registerCommand('shoora.cancelTask', () => {
        orchestrator.cancel();
        vscode.window.showInformationMessage('Shoora Agent task cancelled.');
    });

    const clearChatCmd = vscode.commands.registerCommand('shoora.clearChat', () => {
        orchestrator.clearHistory();
        chatProvider.resetChat();
        vscode.window.showInformationMessage('Shoora Agent conversation cleared.');
    });

    const explainCmd = vscode.commands.registerCommand('shoora.explainSelection', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const selection = editor.document.getText(editor.selection);
        if (!selection) {
            vscode.window.showWarningMessage('Select some code first.');
            return;
        }
        vscode.commands.executeCommand('shoora.chatView.focus');
        chatProvider.sendCustomMessage(`Explain this code in detail:\n\`\`\`${editor.document.languageId}\n${selection}\n\`\`\``);
    });

    const fixCmd = vscode.commands.registerCommand('shoora.fixSelection', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const selection = editor.document.getText(editor.selection);
        if (!selection) {
            vscode.window.showWarningMessage('Select code to fix.');
            return;
        }
        vscode.commands.executeCommand('shoora.chatView.focus');
        chatProvider.sendCustomMessage(`Find and fix any bugs or issues in this code:\n\`\`\`${editor.document.languageId}\n${selection}\n\`\`\``);
    });

    context.subscriptions.push(
        inlineEditCmd,
        openChatCmd,
        runAgentTaskCmd,
        cancelTaskCmd,
        clearChatCmd,
        explainCmd,
        fixCmd
    );
}

export function deactivate() {
    if (globalOrchestrator) {
        globalOrchestrator.cancel();
    }
}

class ShooraChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'shoora.chatView';
    private _view?: vscode.WebviewView;
    private pendingApprovalResolve?: (approved: boolean) => void;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly orchestrator: AgentOrchestrator
    ) {
        // Wire up approval handler to the webview UI
        this.orchestrator.getSecurityGuard().setCustomHandler((req) => this.handleApprovalRequest(req));

        // Stream live events from the agent orchestrator into the webview
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
            if (data.type === 'sendMessage') {
                try {
                    await this.orchestrator.runTask(data.text);
                } catch (err: any) {
                    this._view?.webview.postMessage({
                        type: 'aiError',
                        error: err?.message || 'Agent encountered an error.'
                    });
                }
            } else if (data.type === 'cancelTask') {
                this.orchestrator.cancel();
            } else if (data.type === 'clearChat') {
                this.orchestrator.clearHistory();
                this._view?.webview.postMessage({ type: 'chatCleared' });
            } else if (data.type === 'approvalResponse') {
                if (this.pendingApprovalResolve) {
                    this.pendingApprovalResolve(data.approved === true);
                    this.pendingApprovalResolve = undefined;
                }
            } else if (data.type === 'insertCode') {
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    editor.edit(editBuilder => {
                        editBuilder.insert(editor.selection.active, data.code);
                    });
                }
            }
        });
    }

    public sendCustomMessage(text: string) {
        this._view?.webview.postMessage({ type: 'autoAsk', text });
    }

    public resetChat() {
        this._view?.webview.postMessage({ type: 'chatCleared' });
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
      display: flex;
      flex-direction: column;
      height: 96vh;
      box-sizing: border-box;
    }
    #header {
      font-weight: 600;
      font-size: 13px;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--vscode-sideBar-border);
      padding-bottom: 8px;
    }
    .header-title {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--vscode-foreground);
    }
    .header-actions {
      display: flex;
      gap: 4px;
    }
    .icon-btn {
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 3px 6px;
      border-radius: 3px;
      font-size: 11px;
    }
    .icon-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
      color: var(--vscode-foreground);
    }
    #messages {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding-bottom: 10px;
    }
    .msg {
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12.5px;
      line-height: 1.45;
      word-break: break-word;
    }
    .user {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      align-self: flex-end;
      max-width: 85%;
    }
    .ai {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.1));
      align-self: flex-start;
      width: 95%;
    }
    .step-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 2px 7px;
      border-radius: 10px;
      margin-bottom: 6px;
      font-weight: 600;
    }
    .tool-card {
      margin: 6px 0;
      padding: 6px 10px;
      background: rgba(255, 255, 255, 0.04);
      border-left: 3px solid var(--vscode-textLink-foreground, #3b82f6);
      border-radius: 0 4px 4px 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11.5px;
    }
    .tool-card.success {
      border-left-color: #22c55e;
    }
    .tool-card.error {
      border-left-color: #ef4444;
    }
    .tool-output {
      max-height: 120px;
      overflow-y: auto;
      white-space: pre-wrap;
      background: rgba(0,0,0,0.2);
      padding: 4px 6px;
      border-radius: 3px;
      margin-top: 4px;
      font-size: 11px;
    }
    .approval-box {
      border: 1px solid #f59e0b;
      background: rgba(245, 158, 11, 0.1);
      border-radius: 6px;
      padding: 10px;
      margin: 8px 0;
    }
    .approval-title {
      font-weight: bold;
      color: #f59e0b;
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .approval-actions {
      display: flex;
      gap: 8px;
      margin-top: 8px;
    }
    .btn-approve {
      background: #16a34a;
      color: #fff;
      border: none;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 600;
      font-size: 11px;
    }
    .btn-reject {
      background: #dc2626;
      color: #fff;
      border: none;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 600;
      font-size: 11px;
    }
    #input-container {
      margin-top: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding-top: 6px;
      border-top: 1px solid var(--vscode-sideBar-border);
    }
    #promptInput {
      width: 100%;
      box-sizing: border-box;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
      resize: none;
      font-family: inherit;
      font-size: 12px;
    }
    #promptInput:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    .action-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      padding: 6px 14px;
      cursor: pointer;
      font-weight: 600;
      font-size: 12px;
    }
    .btn-primary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .btn-cancel {
      background: transparent;
      color: var(--vscode-errorForeground, #ef4444);
      border: 1px solid var(--vscode-errorForeground, #ef4444);
      border-radius: 4px;
      padding: 4px 8px;
      cursor: pointer;
      font-size: 11px;
      display: none;
    }
    pre {
      background: rgba(0, 0, 0, 0.25);
      padding: 6px;
      border-radius: 4px;
      overflow-x: auto;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11.5px;
    }
  </style>
</head>
<body>
  <div id="header">
    <div class="header-title">
      <span>⚡</span>
      <span>SHOORA AI Agent</span>
    </div>
    <div class="header-actions">
      <button class="icon-btn" id="clearBtn" title="Clear Conversation">Clear</button>
    </div>
  </div>

  <div id="messages">
    <div class="msg ai">
      Hello! I am your autonomous <b>SHOORA AI Agent</b>.
      <br/><br/>
      I can help you build, test, manage Git/GitHub, and deploy your project. Ask me anything like:
      <ul>
        <li><i>"Inspect this project and run the tests."</i></li>
        <li><i>"Create a new component with error handling."</i></li>
        <li><i>"Prepare deployment configuration."</i></li>
      </ul>
    </div>
  </div>

  <div id="input-container">
    <textarea id="promptInput" rows="2" placeholder="Tell Shoora Agent what to build, test, or deploy..."></textarea>
    <div class="action-row">
      <button class="btn-cancel" id="cancelBtn">Cancel Task</button>
      <div style="flex:1;"></div>
      <button class="btn-primary" id="sendBtn">Send</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const msgContainer = document.getElementById('messages');
    const input = document.getElementById('promptInput');
    const sendBtn = document.getElementById('sendBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const clearBtn = document.getElementById('clearBtn');

    let currentAiMsgEl = null;

    function send() {
      const text = input.value.trim();
      if (!text) return;
      appendMessage('user', text);
      input.value = '';
      cancelBtn.style.display = 'block';
      vscode.postMessage({ type: 'sendMessage', text });
    }

    sendBtn.addEventListener('click', send);
    cancelBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'cancelTask' });
      cancelBtn.style.display = 'none';
    });
    clearBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'clearChat' });
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    window.addEventListener('message', (event) => {
      const data = event.data;

      if (data.type === 'agentEvent') {
        handleAgentEvent(data.event);
      } else if (data.type === 'approvalRequired') {
        renderApprovalCard(data.request);
      } else if (data.type === 'aiError') {
        cancelBtn.style.display = 'none';
        appendMessage('ai', '❌ ' + data.error);
      } else if (data.type === 'chatCleared') {
        msgContainer.innerHTML = '<div class="msg ai">Conversation reset. Ready for a new task!</div>';
        cancelBtn.style.display = 'none';
      } else if (data.type === 'autoAsk') {
        appendMessage('user', data.text);
        cancelBtn.style.display = 'block';
        vscode.postMessage({ type: 'sendMessage', text: data.text });
      }
    });

    function handleAgentEvent(event) {
      if (!currentAiMsgEl) {
        currentAiMsgEl = document.createElement('div');
        currentAiMsgEl.className = 'msg ai';
        msgContainer.appendChild(currentAiMsgEl);
      }

      if (event.type === 'step_complete' && event.data.status === 'started') {
        const stepEl = document.createElement('div');
        stepEl.className = 'step-badge';
        stepEl.textContent = 'Step ' + event.data.stepNumber;
        currentAiMsgEl.appendChild(stepEl);
      } else if (event.type === 'thought') {
        const p = document.createElement('div');
        p.style.marginBottom = '6px';
        p.innerHTML = escapeHtml(event.data.text).replace(/\\n/g, '<br/>');
        currentAiMsgEl.appendChild(p);
      } else if (event.type === 'tool_start') {
        const card = document.createElement('div');
        card.id = 'tool_' + event.data.id;
        card.className = 'tool-card';
        card.innerHTML = '⚙️ <b>' + event.data.name + '</b><div style="font-size:10.5px; opacity:0.8;">Running...</div>';
        currentAiMsgEl.appendChild(card);
      } else if (event.type === 'tool_result') {
        const card = document.getElementById('tool_' + event.data.id);
        if (card) {
          card.className = 'tool-card ' + (event.data.result.success ? 'success' : 'error');
          const out = event.data.result.output || event.data.result.error || '';
          card.innerHTML = (event.data.result.success ? '✓' : '✗') + ' <b>' + event.data.name + '</b>' +
            '<div class="tool-output">' + escapeHtml(out.substring(0, 1000)) + (out.length > 1000 ? '...' : '') + '</div>';
        }
      } else if (event.type === 'final_answer') {
        cancelBtn.style.display = 'none';
        const finalEl = document.createElement('div');
        finalEl.style.marginTop = '8px';
        finalEl.style.fontWeight = '500';
        finalEl.innerHTML = escapeHtml(event.data.text).replace(/\\n/g, '<br/>');
        currentAiMsgEl.appendChild(finalEl);
        currentAiMsgEl = null; // reset for next interaction
      }

      msgContainer.scrollTop = msgContainer.scrollHeight;
    }

    function renderApprovalCard(request) {
      const box = document.createElement('div');
      box.className = 'approval-box';
      box.innerHTML = '<div class="approval-title">🔒 Approval Required: ' + escapeHtml(request.toolName) + '</div>' +
        '<div style="font-size:11.5px;">' + escapeHtml(request.description) + '</div>' +
        (request.warning ? '<div style="color:#ef4444; font-size:11px; margin-top:4px;">⚠️ ' + escapeHtml(request.warning) + '</div>' : '') +
        '<pre>' + escapeHtml(JSON.stringify(request.arguments, null, 2)) + '</pre>' +
        '<div class="approval-actions">' +
          '<button class="btn-approve" id="approveActionBtn">Approve & Run</button>' +
          '<button class="btn-reject" id="rejectActionBtn">Reject</button>' +
        '</div>';

      msgContainer.appendChild(box);
      msgContainer.scrollTop = msgContainer.scrollHeight;

      box.querySelector('#approveActionBtn').addEventListener('click', () => {
        box.remove();
        vscode.postMessage({ type: 'approvalResponse', approved: true });
      });

      box.querySelector('#rejectActionBtn').addEventListener('click', () => {
        box.remove();
        vscode.postMessage({ type: 'approvalResponse', approved: false });
      });
    }

    function appendMessage(sender, text) {
      const div = document.createElement('div');
      div.className = 'msg ' + sender;
      div.innerHTML = escapeHtml(text).replace(/\\n/g, '<br/>');
      msgContainer.appendChild(div);
      msgContainer.scrollTop = msgContainer.scrollHeight;
      currentAiMsgEl = null;
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
