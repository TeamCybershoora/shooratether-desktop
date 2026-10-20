/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cybershoora Pvt. Ltd. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { LLMClient } from '../agent/LLMClient.js';
import { CodebaseIndexer } from '../indexer/CodebaseIndexer.js';

export class InlineEditProvider {
    private llmClient: LLMClient;
    private diffDecorationType: vscode.TextEditorDecorationType;

    constructor() {
        this.llmClient = new LLMClient();
        this.diffDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(16, 185, 129, 0.18)',
            border: '1px solid rgba(16, 185, 129, 0.5)',
            isWholeLine: true,
            overviewRulerColor: 'rgba(16, 185, 129, 0.8)',
            overviewRulerLane: vscode.OverviewRulerLane.Right
        });
    }

    public async executeInlineEdit(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('Please open a file to use SHOORA Inline Edit (Ctrl+K).');
            return;
        }

        const document = editor.document;
        let selection = editor.selection;

        // If no text is selected, select the current line
        if (selection.isEmpty) {
            const line = document.lineAt(selection.active.line);
            selection = new vscode.Selection(line.range.start, line.range.end);
        }

        const originalText = document.getText(selection);

        const prompt = await vscode.window.showInputBox({
            prompt: '⚡ SHOORA AI (Ctrl+K): Describe how to edit or generate code',
            placeHolder: 'e.g. "Add try/catch block", "Refactor to async/await", "Convert to TypeScript interface"...',
            ignoreFocusOut: true
        });

        if (!prompt) return;

        // Optional codebase context injection
        const indexer = CodebaseIndexer.getInstance();
        const relevantChunks = indexer.search(prompt, 2);
        let codebaseContext = '';
        if (relevantChunks.length > 0) {
            codebaseContext = '\nRelevant project references:\n' +
                relevantChunks.map(c => `// ${c.chunk.relativePath}\n${c.chunk.snippet}`).join('\n\n');
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'SHOORA AI (Ctrl+K): Generating code edits...',
            cancellable: true
        }, async (_progress, token) => {
            try {
                const systemPrompt = `You are SHOORA AI, an expert code generator built into SHOORA TETHER IDE.
Return ONLY the raw replacement code for the selected region.
DO NOT wrap your output in markdown code blocks (\`\`\`) unless the code itself requires backticks.
DO NOT include pleasantries or explanations. Only the executable code snippet.`;

                const userPrompt = `File: ${document.fileName}
Language: ${document.languageId}
Selection to edit:
\`\`\`${document.languageId}
${originalText}
\`\`\`
${codebaseContext}

User instruction: ${prompt}

Output replacement code:`;

                if (token.isCancellationRequested) return;

                let generatedCode = await this.llmClient.generateText(userPrompt, systemPrompt);

                // Clean markdown fences if model inadvertently included them
                generatedCode = this.stripMarkdownFences(generatedCode);

                if (token.isCancellationRequested) return;

                // Apply the edit
                await editor.edit(editBuilder => {
                    editBuilder.replace(selection, generatedCode);
                });

                // Calculate the new range for highlight decoration
                const startPos = selection.start;
                const linesAdded = generatedCode.split('\n').length - 1;
                const lastLineLength = generatedCode.split('\n').pop()?.length || 0;
                const endPos = new vscode.Position(
                    startPos.line + linesAdded,
                    linesAdded === 0 ? startPos.character + lastLineLength : lastLineLength
                );
                const newRange = new vscode.Range(startPos, endPos);

                // Highlight the modified region
                editor.setDecorations(this.diffDecorationType, [newRange]);

                // Prompt user for Accept / Reject review
                const choice = await vscode.window.showQuickPick(
                    [
                        { label: '✓ Accept Changes', description: 'Keep the SHOORA AI code edits', action: 'accept' },
                        { label: '✗ Reject Changes', description: 'Revert to original code', action: 'reject' },
                        { label: '🔄 Retry with New Prompt', description: 'Adjust prompt and re-run', action: 'retry' }
                    ],
                    {
                        placeHolder: 'Review SHOORA AI changes: Accept or Reject?',
                        ignoreFocusOut: true
                    }
                );

                editor.setDecorations(this.diffDecorationType, []);

                if (!choice || choice.action === 'reject') {
                    await editor.edit(editBuilder => {
                        editBuilder.replace(newRange, originalText);
                    });
                    vscode.window.showInformationMessage('SHOORA AI edits reverted.');
                } else if (choice.action === 'retry') {
                    await editor.edit(editBuilder => {
                        editBuilder.replace(newRange, originalText);
                    });
                    await this.executeInlineEdit();
                } else {
                    vscode.window.showInformationMessage('✓ SHOORA AI edits accepted.');
                }

            } catch (err: any) {
                editor.setDecorations(this.diffDecorationType, []);
                vscode.window.showErrorMessage(`SHOORA Inline Edit Error: ${err.message || err}`);
            }
        });
    }

    private stripMarkdownFences(text: string): string {
        let trimmed = text.trim();
        if (trimmed.startsWith('```')) {
            const firstNewline = trimmed.indexOf('\n');
            if (firstNewline !== -1) {
                trimmed = trimmed.substring(firstNewline + 1);
            }
        }
        if (trimmed.endsWith('```')) {
            trimmed = trimmed.substring(0, trimmed.length - 3);
        }
        return trimmed;
    }
}
