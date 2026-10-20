/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cybershoora Pvt. Ltd. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { LLMClient } from '../agent/LLMClient.js';

export class ShooraInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    private llmClient: LLMClient;
    private isEnabled: boolean = true;
    private statusBarItem: vscode.StatusBarItem;
    private lastRequestTime: number = 0;
    private debounceTimeout?: NodeJS.Timeout;

    constructor() {
        this.llmClient = new LLMClient();

        // Create Status Bar Item to toggle AI Autocomplete
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.command = 'shoora.toggleAutocomplete';
        this.updateStatusBar();
        this.statusBarItem.show();
    }

    public getStatusBarItem(): vscode.StatusBarItem {
        return this.statusBarItem;
    }

    public toggle(): boolean {
        this.isEnabled = !this.isEnabled;
        this.updateStatusBar();
        vscode.window.showInformationMessage(`SHOORA AI Autocomplete (Tab): ${this.isEnabled ? 'ENABLED' : 'DISABLED'}`);
        return this.isEnabled;
    }

    private updateStatusBar() {
        if (this.isEnabled) {
            this.statusBarItem.text = '$(sparkle) Shoora Auto: ON';
            this.statusBarItem.tooltip = 'SHOORA AI Autocomplete is active. Click to disable.';
        } else {
            this.statusBarItem.text = '$(circle-slash) Shoora Auto: OFF';
            this.statusBarItem.tooltip = 'SHOORA AI Autocomplete is paused. Click to enable.';
        }
    }

    public async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | null | undefined> {
        if (!this.isEnabled) return null;

        // Skip comments or completely blank files if needed
        const currentLine = document.lineAt(position.line).text;
        const linePrefix = currentLine.substring(0, position.character);

        // Don't trigger if line prefix is empty whitespace only
        if (linePrefix.trim().length === 0 && position.line === 0) {
            return null;
        }

        // Debounce to prevent flooding on rapid typing
        const now = Date.now();
        if (now - this.lastRequestTime < 350) {
            return null;
        }
        this.lastRequestTime = now;

        // Gather prefix (up to 30 lines before cursor)
        const startLine = Math.max(0, position.line - 30);
        const prefixRange = new vscode.Range(new vscode.Position(startLine, 0), position);
        const prefixText = document.getText(prefixRange);

        // Gather suffix (up to 15 lines after cursor)
        const endLine = Math.min(document.lineCount - 1, position.line + 15);
        const suffixRange = new vscode.Range(position, new vscode.Position(endLine, document.lineAt(endLine).text.length));
        const suffixText = document.getText(suffixRange);

        try {
            const systemPrompt = `You are an ultra-fast inline code autocomplete engine for SHOORA TETHER IDE.
Your task is to predict and complete the code at the exact cursor position.
RULES:
1. Return ONLY the immediate code to insert at cursor.
2. DO NOT repeat the prefix code that already exists.
3. DO NOT output markdown, fences, or explanations.
4. Keep suggestions concise (1 to 4 lines).`;

            const userPrompt = `File: ${document.fileName}
Language: ${document.languageId}

[Code before cursor]:
${prefixText}
<CURSOR>
[Code after cursor]:
${suffixText}

Provide only the completion text starting right from <CURSOR>:`;

            if (token.isCancellationRequested) return null;

            let completion = await this.llmClient.generateText(userPrompt, systemPrompt);
            completion = this.cleanCompletionText(completion, linePrefix);

            if (!completion || token.isCancellationRequested) return null;

            const item = new vscode.InlineCompletionItem(
                completion,
                new vscode.Range(position, position)
            );

            return [item];
        } catch {
            return null;
        }
    }

    private cleanCompletionText(text: string, currentPrefix: string): string {
        let cleaned = text;
        // Strip markdown fences
        if (cleaned.startsWith('```')) {
            const firstNl = cleaned.indexOf('\n');
            if (firstNl !== -1) cleaned = cleaned.substring(firstNl + 1);
        }
        if (cleaned.endsWith('```')) {
            cleaned = cleaned.substring(0, cleaned.length - 3);
        }
        cleaned = cleaned.trimEnd();

        // If completion accidentally repeats the current line prefix, remove it
        const trimmedPrefix = currentPrefix.trim();
        if (trimmedPrefix && cleaned.startsWith(trimmedPrefix)) {
            cleaned = cleaned.substring(trimmedPrefix.length);
        }

        return cleaned;
    }
}
