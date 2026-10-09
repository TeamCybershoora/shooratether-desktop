/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cybershoora Pvt. Ltd. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AgentContext, AgentEvent, AgentEventType, AgentMessage, AgentStep, ToolResult } from './types.js';
import { ToolRegistry } from './ToolRegistry.js';
import { SecurityGuard } from './SecurityGuard.js';
import { LLMClient } from './LLMClient.js';
import { WORKSPACE_TOOLS } from './tools/WorkspaceTools.js';
import { TERMINAL_TOOLS } from './tools/TerminalTools.js';
import { GIT_TOOLS } from './tools/GitTools.js';
import { GITHUB_TOOLS } from './tools/GitHubTools.js';

export type AgentEventListener = (event: AgentEvent) => void;

export class AgentOrchestrator {
    private toolRegistry: ToolRegistry;
    private securityGuard: SecurityGuard;
    private llmClient: LLMClient;
    private eventListeners: Set<AgentEventListener> = new Set();
    private conversationHistory: AgentMessage[] = [];
    private isRunning = false;
    private abortController?: AbortController;

    constructor() {
        this.toolRegistry = new ToolRegistry();
        this.securityGuard = new SecurityGuard();
        this.llmClient = new LLMClient();

        // Register tools
        this.toolRegistry.registerTools(WORKSPACE_TOOLS);
        this.toolRegistry.registerTools(TERMINAL_TOOLS);
        this.toolRegistry.registerTools(GIT_TOOLS);
        this.toolRegistry.registerTools(GITHUB_TOOLS);
    }

    public getRegistry(): ToolRegistry {
        return this.toolRegistry;
    }

    public getSecurityGuard(): SecurityGuard {
        return this.securityGuard;
    }

    public onEvent(listener: AgentEventListener): vscode.Disposable {
        this.eventListeners.add(listener);
        return {
            dispose: () => this.eventListeners.delete(listener)
        };
    }

    private emit(type: AgentEventType, data: any): void {
        const event: AgentEvent = {
            type,
            data,
            timestamp: Date.now()
        };
        for (const listener of this.eventListeners) {
            try {
                listener(event);
            } catch (err) {
                console.error('Error in agent event listener:', err);
            }
        }
    }

    public cancel(): void {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = undefined;
        }
        this.isRunning = false;
        this.emit('error', 'Task was cancelled by user.');
    }

    public clearHistory(): void {
        this.conversationHistory = [];
    }

    /**
     * Run the autonomous multi-step agent loop.
     */
    public async runTask(userPrompt: string, maxSteps = 15): Promise<string> {
        if (this.isRunning) {
            throw new Error('An agent task is already running. Please cancel or wait for it to complete.');
        }

        this.isRunning = true;
        this.abortController = new AbortController();

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const currentFile = vscode.window.activeTextEditor?.document.uri.fsPath;

        const context: AgentContext = {
            workspaceRoot,
            currentEditorFile: currentFile,
            securityGuard: this.securityGuard,
            abortSignal: this.abortController.signal,
            log: (msg) => console.log(`[ShooraAgent] ${msg}`)
        };

        const systemPrompt = `You are SHOORA AI Agent, a powerful autonomous software engineering and DevOps assistant in SHOORA TETHER IDE.
Workspace Directory: ${workspaceRoot || 'None'}
Active File: ${currentFile || 'None'}

Capabilities:
1. You can inspect the codebase (read, list, search, detect frameworks).
2. You can create and edit files surgically.
3. You can execute shell commands and test suites.
4. You can manage Git, GitHub repositories, pull requests, and CI/CD.
5. You can trigger, monitor, and rollback cloud deployments.

Guidelines:
- Solve the user's task completely by taking concrete actions using the available tools instead of just providing instructions.
- Plan multi-step workflows. Observe the results of each tool before choosing the next action.
- If a command or build fails, read the error output carefully, diagnose the root cause, and apply fixes.
- When finished, summarize all the changes made and the current status clearly for the user.`;

        // Initialize conversation
        if (this.conversationHistory.length === 0) {
            this.conversationHistory.push({ role: 'system', content: systemPrompt });
        }

        this.conversationHistory.push({ role: 'user', content: userPrompt });

        let stepCount = 0;
        let finalResponse = '';

        try {
            while (stepCount < maxSteps) {
                if (this.abortController.signal.aborted) {
                    throw new Error('Task was aborted.');
                }

                stepCount++;
                this.emit('step_complete', { stepNumber: stepCount, status: 'started' });

                // Call LLM
                const response = await this.llmClient.call(this.conversationHistory, this.toolRegistry);

                // If thoughts or textual response emitted
                if (response.content) {
                    this.emit('thought', { stepNumber: stepCount, text: response.content });
                }

                // If no tool calls, model has concluded with its final answer
                if (!response.toolCalls || response.toolCalls.length === 0) {
                    finalResponse = response.content || 'Task completed successfully.';
                    this.conversationHistory.push({ role: 'assistant', content: finalResponse });
                    this.emit('final_answer', { text: finalResponse });
                    break;
                }

                // Add assistant step to history
                this.conversationHistory.push({
                    role: 'assistant',
                    content: response.content,
                    toolCalls: response.toolCalls
                });

                // Execute each tool call
                for (const toolCall of response.toolCalls) {
                    if (this.abortController.signal.aborted) {
                        throw new Error('Task was aborted.');
                    }

                    this.emit('tool_start', {
                        id: toolCall.id,
                        name: toolCall.name,
                        arguments: toolCall.arguments
                    });

                    const result: ToolResult = await this.toolRegistry.executeTool(
                        toolCall.name,
                        toolCall.arguments,
                        context
                    );

                    this.emit('tool_result', {
                        id: toolCall.id,
                        name: toolCall.name,
                        result
                    });

                    // Add tool result to conversation history
                    this.conversationHistory.push({
                        role: 'tool',
                        name: toolCall.name,
                        toolCallId: toolCall.id,
                        content: result.success ? result.output : `ERROR: ${result.error || 'Execution failed'}`
                    });
                }
            }

            if (stepCount >= maxSteps && !finalResponse) {
                finalResponse = 'Agent reached the maximum step limit without concluding. Please review current progress or continue.';
                this.emit('final_answer', { text: finalResponse });
            }

            return finalResponse;
        } catch (error: any) {
            const errorMsg = error?.message || String(error);
            this.emit('error', errorMsg);
            throw error;
        } finally {
            this.isRunning = false;
            this.abortController = undefined;
        }
    }
}
