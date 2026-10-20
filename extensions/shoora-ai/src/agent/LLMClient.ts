/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cybershoora Pvt. Ltd. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AgentMessage, AgentToolCall } from './types.js';
import { ToolRegistry } from './ToolRegistry.js';

export interface LLMResponse {
    content: string;
    toolCalls?: AgentToolCall[];
}

export class LLMClient {
    constructor() {}

    public async call(messages: AgentMessage[], toolRegistry: ToolRegistry): Promise<LLMResponse> {
        const config = vscode.workspace.getConfiguration('shoora');
        const provider = config.get<string>('provider', 'gemini');
        const apiKey = config.get<string>('apiKey', '');
        const model = config.get<string>('model', 'gemini-1.5-flash');
        const ollamaUrl = config.get<string>('ollamaEndpoint', 'http://localhost:11434');

        switch (provider) {
            case 'gemini':
                return await this.callGemini(messages, toolRegistry, apiKey, model);
            case 'openai':
                return await this.callOpenAI(messages, toolRegistry, apiKey, model);
            case 'claude':
                return await this.callClaude(messages, toolRegistry, apiKey, model);
            case 'ollama':
                return await this.callOllama(messages, toolRegistry, ollamaUrl, model);
            default:
                throw new Error(`Unsupported AI Provider: ${provider}`);
        }
    }

    // =========================================================================
    // Google Gemini Provider
    // =========================================================================
    private async callGemini(messages: AgentMessage[], toolRegistry: ToolRegistry, apiKey: string, model: string): Promise<LLMResponse> {
        if (!apiKey) {
            throw new Error('Please set your Google Gemini API Key in Settings (shoora.apiKey).');
        }

        const functionDeclarations = toolRegistry.getGeminiToolDefinitions().map(tool => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
        }));

        // Convert messages to Gemini contents format
        const contents: any[] = [];
        let systemInstruction: any = undefined;

        for (const msg of messages) {
            if (msg.role === 'system') {
                systemInstruction = { parts: [{ text: msg.content }] };
            } else if (msg.role === 'user') {
                contents.push({ role: 'user', parts: [{ text: msg.content }] });
            } else if (msg.role === 'assistant') {
                const parts: any[] = [];
                if (msg.content) {
                    parts.push({ text: msg.content });
                }
                if (msg.toolCalls && msg.toolCalls.length > 0) {
                    for (const call of msg.toolCalls) {
                        parts.push({
                            functionCall: {
                                name: call.name,
                                args: call.arguments
                            }
                        });
                    }
                }
                contents.push({ role: 'model', parts });
            } else if (msg.role === 'tool') {
                contents.push({
                    role: 'function',
                    parts: [{
                        functionResponse: {
                            name: msg.name || 'tool_result',
                            response: { output: msg.content }
                        }
                    }]
                });
            }
        }

        const body: any = {
            contents,
            tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined
        };
        if (systemInstruction) {
            body.systemInstruction = systemInstruction;
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Gemini API Error (${res.status}): ${errText}`);
        }

        const data: any = await res.json();
        const candidate = data.candidates?.[0];
        if (!candidate) {
            return { content: 'No response generated.' };
        }

        const parts = candidate.content?.parts || [];
        let textContent = '';
        const toolCalls: AgentToolCall[] = [];

        for (const part of parts) {
            if (part.text) {
                textContent += part.text;
            }
            if (part.functionCall) {
                toolCalls.push({
                    id: `call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                    name: part.functionCall.name,
                    arguments: part.functionCall.args || {}
                });
            }
        }

        return { content: textContent, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
    }

    // =========================================================================
    // OpenAI Provider
    // =========================================================================
    private async callOpenAI(messages: AgentMessage[], toolRegistry: ToolRegistry, apiKey: string, model: string): Promise<LLMResponse> {
        if (!apiKey) {
            throw new Error('Please set your OpenAI API Key in Settings (shoora.apiKey).');
        }

        const tools = toolRegistry.getOpenAIToolDefinitions();

        const formattedMessages = messages.map(msg => {
            if (msg.role === 'tool') {
                return {
                    role: 'tool',
                    tool_call_id: msg.toolCallId || 'call_default',
                    content: msg.content
                };
            }
            if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
                return {
                    role: 'assistant',
                    content: msg.content || null,
                    tool_calls: msg.toolCalls.map(tc => ({
                        id: tc.id,
                        type: 'function',
                        function: {
                            name: tc.name,
                            arguments: JSON.stringify(tc.arguments)
                        }
                    }))
                };
            }
            return {
                role: msg.role,
                content: msg.content
            };
        });

        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: model.startsWith('gpt') ? model : 'gpt-4o-mini',
                messages: formattedMessages,
                tools: tools.length > 0 ? tools : undefined
            })
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`OpenAI API Error (${res.status}): ${err}`);
        }

        const data: any = await res.json();
        const choice = data.choices?.[0]?.message;
        if (!choice) return { content: 'No response generated.' };

        const toolCalls: AgentToolCall[] = [];
        if (choice.tool_calls) {
            for (const tc of choice.tool_calls) {
                let args = {};
                try { args = JSON.parse(tc.function.arguments); } catch {}
                toolCalls.push({
                    id: tc.id,
                    name: tc.function.name,
                    arguments: args
                });
            }
        }

        return {
            content: choice.content || '',
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined
        };
    }

    // =========================================================================
    // Anthropic Claude Provider
    // =========================================================================
    private async callClaude(messages: AgentMessage[], toolRegistry: ToolRegistry, apiKey: string, model: string): Promise<LLMResponse> {
        if (!apiKey) {
            throw new Error('Please set your Anthropic API Key in Settings (shoora.apiKey).');
        }

        const tools = toolRegistry.getClaudeToolDefinitions();
        let systemPrompt = '';
        const claudeMessages: any[] = [];

        for (const msg of messages) {
            if (msg.role === 'system') {
                systemPrompt += msg.content + '\n';
            } else if (msg.role === 'tool') {
                claudeMessages.push({
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: msg.toolCallId || 'tool_1',
                        content: msg.content
                    }]
                });
            } else if (msg.role === 'assistant' && msg.toolCalls) {
                const contents: any[] = [];
                if (msg.content) contents.push({ type: 'text', text: msg.content });
                for (const tc of msg.toolCalls) {
                    contents.push({
                        type: 'tool_use',
                        id: tc.id,
                        name: tc.name,
                        input: tc.arguments
                    });
                }
                claudeMessages.push({ role: 'assistant', content: contents });
            } else {
                claudeMessages.push({ role: msg.role, content: msg.content });
            }
        }

        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: model.startsWith('claude') ? model : 'claude-3-5-sonnet-20241022',
                max_tokens: 4096,
                system: systemPrompt || undefined,
                messages: claudeMessages,
                tools: tools.length > 0 ? tools : undefined
            })
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Claude API Error (${res.status}): ${err}`);
        }

        const data: any = await res.json();
        let content = '';
        const toolCalls: AgentToolCall[] = [];

        for (const item of data.content || []) {
            if (item.type === 'text') {
                content += item.text;
            } else if (item.type === 'tool_use') {
                toolCalls.push({
                    id: item.id,
                    name: item.name,
                    arguments: item.input || {}
                });
            }
        }

        return { content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
    }

    // =========================================================================
    // Local Ollama Provider (Prompt-Engineered Function Calling)
    // =========================================================================
    private async callOllama(messages: AgentMessage[], toolRegistry: ToolRegistry, ollamaUrl: string, model: string): Promise<LLMResponse> {
        const toolsDesc = toolRegistry.getPromptDescription();
        const systemAddon = `\nYou have access to the following tools:\n${toolsDesc}\n\nTo call a tool, reply ONLY with a JSON object in this format:\n{"tool": "tool_name", "arguments": { ... }}\nIf no tool is needed, respond with standard text.`;

        const prompt = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n') + systemAddon;

        const res = await fetch(`${ollamaUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: model || 'codellama',
                prompt,
                stream: false
            })
        });

        if (!res.ok) {
            throw new Error(`Ollama Error: Could not connect to Ollama at ${ollamaUrl}`);
        }

        const data: any = await res.json();
        const responseText = data.response || '';

        // Attempt JSON tool parsing
        try {
            const trimmed = responseText.trim();
            if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                const parsed = JSON.parse(trimmed);
                if (parsed.tool && parsed.arguments) {
                    return {
                        content: '',
                        toolCalls: [{
                            id: `call_${Date.now()}`,
                            name: parsed.tool,
                            arguments: parsed.arguments
                        }]
                    };
                }
            }
        } catch {}

        return { content: responseText };
    }

    public async generateText(prompt: string, systemPrompt?: string): Promise<string> {
        const emptyRegistry = new ToolRegistry();
        const messages: AgentMessage[] = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }
        messages.push({ role: 'user', content: prompt });
        try {
            const res = await this.call(messages, emptyRegistry);
            return res.content;
        } catch (err: any) {
            return `// SHOORA AI: ${err.message || 'Could not generate code.'}`;
        }
    }
}
