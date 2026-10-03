import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    const provider = new ShooraChatViewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ShooraChatViewProvider.viewType, provider)
    );

    // Ctrl+K Inline Edit Command (Cursor style)
    const inlineEditCmd = vscode.commands.registerCommand('shoora.inlineEdit', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('Open a file first to use SHOORA Inline Edit.');
            return;
        }

        const selection = editor.selection;
        const selectedText = editor.document.getText(selection);

        const prompt = await vscode.window.showInputBox({
            prompt: 'SHOORA AI (Ctrl+K): Describe the code to generate or modify',
            placeHolder: 'e.g. refactor to async/await, add error handling, generate React component...'
        });

        if (!prompt) return;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "SHOORA AI is generating code...",
            cancellable: false
        }, async () => {
            try {
                const generatedCode = await queryAI(prompt, selectedText, editor.document.languageId);
                await editor.edit(editBuilder => {
                    if (selection.isEmpty) {
                        editBuilder.insert(selection.active, generatedCode);
                    } else {
                        editBuilder.replace(selection, generatedCode);
                    }
                });
                vscode.window.showInformationMessage('✓ Code applied by SHOORA AI');
            } catch (err: any) {
                vscode.window.showErrorMessage(`SHOORA AI Error: ${err.message || err}`);
            }
        });
    });

    const openChatCmd = vscode.commands.registerCommand('shoora.openChat', () => {
        vscode.commands.executeCommand('shoora.chatView.focus');
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
        provider.sendCustomMessage(`Explain this code in detail:\n\`\`\`${editor.document.languageId}\n${selection}\n\`\`\``);
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
        provider.sendCustomMessage(`Find and fix any bugs or issues in this code:\n\`\`\`${editor.document.languageId}\n${selection}\n\`\`\``);
    });

    context.subscriptions.push(inlineEditCmd, openChatCmd, explainCmd, fixCmd);
}

class ShooraChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'shoora.chatView';
    private _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtmlForWebview();

        webviewView.webview.onDidReceiveMessage(async (data) => {
            if (data.type === 'sendMessage') {
                const editor = vscode.window.activeTextEditor;
                const contextCode = editor ? editor.document.getText(editor.selection) : '';
                const languageId = editor ? editor.document.languageId : 'plaintext';

                try {
                    const response = await queryAI(data.text, contextCode, languageId);
                    this._view?.webview.postMessage({ type: 'aiResponse', text: response });
                } catch (err: any) {
                    this._view?.webview.postMessage({ type: 'aiError', error: err.message || 'Failed to get response' });
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

    private _getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family); background: var(--vscode-sideBar-background); color: var(--vscode-foreground); margin: 0; padding: 12px; display: flex; flex-direction: column; height: 95vh; }
    #header { font-weight: bold; font-size: 14px; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--vscode-sideBar-border); padding-bottom: 8px; color: var(--vscode-symbolIcon-colorForeground, #f43f5e); }
    #messages { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding-bottom: 10px; }
    .msg { padding: 8px 12px; border-radius: 6px; font-size: 13px; max-width: 90%; line-height: 1.4; word-break: break-word; }
    .user { background: var(--vscode-button-background); color: var(--vscode-button-foreground); align-self: flex-end; }
    .ai { background: var(--vscode-editor-background); border: 1px solid var(--vscode-editorWidget-border); align-self: flex-start; }
    #input-box { display: flex; gap: 6px; margin-top: 8px; }
    textarea { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 6px; resize: none; font-family: inherit; font-size: 12px; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 6px 12px; cursor: pointer; font-weight: 600; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    pre { background: #18181b; padding: 8px; border-radius: 4px; overflow-x: auto; font-family: var(--vscode-editor-font-family); }
  </style>
</head>
<body>
  <div id="header">⚡ SHOORA TETHER AI</div>
  <div id="messages">
    <div class="msg ai">Hello! I am your native <b>SHOORA AI Assistant</b>. How can I assist you with your code today?</div>
  </div>
  <div id="input-box">
    <textarea id="promptInput" rows="2" placeholder="Ask SHOORA AI (or use Ctrl+K in editor)..."></textarea>
    <button id="sendBtn">Send</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const msgContainer = document.getElementById('messages');
    const input = document.getElementById('promptInput');
    const btn = document.getElementById('sendBtn');

    function send() {
      const text = input.value.trim();
      if (!text) return;
      appendMessage('user', text);
      input.value = '';
      vscode.postMessage({ type: 'sendMessage', text });
    }

    btn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    window.addEventListener('message', (event) => {
      const data = event.data;
      if (data.type === 'aiResponse') {
        appendMessage('ai', data.text);
      } else if (data.type === 'aiError') {
        appendMessage('ai', '⚠️ ' + data.error);
      } else if (data.type === 'autoAsk') {
        appendMessage('user', data.text);
        vscode.postMessage({ type: 'sendMessage', text: data.text });
      }
    });

    function appendMessage(sender, text) {
      const div = document.createElement('div');
      div.className = 'msg ' + sender;
      div.innerHTML = text.replace(/\\n/g, '<br/>');
      msgContainer.appendChild(div);
      msgContainer.scrollTop = msgContainer.scrollHeight;
    }
  </script>
</body>
</html>`;
    }
}

async function queryAI(prompt: string, contextCode: string, languageId: string): Promise<string> {
    const config = vscode.workspace.getConfiguration('shoora');
    const provider = config.get<string>('provider', 'gemini');
    const apiKey = config.get<string>('apiKey', '');
    const model = config.get<string>('model', 'gemini-1.5-flash');
    const ollamaUrl = config.get<string>('ollamaEndpoint', 'http://localhost:11434');

    const fullPrompt = `${contextCode ? `Context Code (${languageId}):\n\`\`\`${languageId}\n${contextCode}\n\`\`\`\n\n` : ''}User Request: ${prompt}`;

    if (provider === 'ollama') {
        const res = await fetch(`${ollamaUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'codellama', prompt: fullPrompt, stream: false })
        });
        const data: any = await res.json();
        return data.response || '';
    }

    if (provider === 'gemini') {
        if (!apiKey) {
            throw new Error('Please set your Google Gemini API Key in Settings (shoora.apiKey).');
        }
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: fullPrompt }] }]
            })
        });
        const data: any = await res.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated.';
    }

    if (provider === 'openai') {
        if (!apiKey) throw new Error('Please set your OpenAI API Key in Settings (shoora.apiKey).');
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: fullPrompt }]
            })
        });
        const data: any = await res.json();
        return data.choices?.[0]?.message?.content || 'No response generated.';
    }

    return "Provider not supported.";
}
