/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cybershoora Pvt. Ltd. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { AgentContext, IAgentTool, ToolResult } from './types.js';

export class ToolRegistry {
    private tools: Map<string, IAgentTool> = new Map();

    constructor() {}

    /**
     * Register a new tool.
     */
    public registerTool(tool: IAgentTool): void {
        this.tools.set(tool.name, tool);
    }

    /**
     * Register multiple tools at once.
     */
    public registerTools(tools: IAgentTool[]): void {
        for (const tool of tools) {
            this.registerTool(tool);
        }
    }

    /**
     * Retrieve tool by name.
     */
    public getTool(name: string): IAgentTool | undefined {
        return this.tools.get(name);
    }

    /**
     * Get all registered tools.
     */
    public getAllTools(): IAgentTool[] {
        return Array.from(this.tools.values());
    }

    /**
     * Format tools into OpenAI / Gemini standard JSON schemas.
     */
    public getOpenAIToolDefinitions(): any[] {
        return this.getAllTools().map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters
            }
        }));
    }

    /**
     * Format tools into Google Gemini function declarations.
     */
    public getGeminiToolDefinitions(): any[] {
        return this.getAllTools().map(tool => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
        }));
    }

    /**
     * Format tools into Claude tool definitions.
     */
    public getClaudeToolDefinitions(): any[] {
        return this.getAllTools().map(tool => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters
        }));
    }

    /**
     * Format tools into markdown prompt text (for local Ollama models).
     */
    public getPromptDescription(): string {
        return this.getAllTools().map(tool => {
            const params = JSON.stringify(tool.parameters.properties || {}, null, 2);
            return `### Tool: \`${tool.name}\` (${tool.securityLevel})
Description: ${tool.description}
Parameters:
\`\`\`json
${params}
\`\`\`
Required: [${(tool.parameters.required || []).join(', ')}]`;
        }).join('\n\n');
    }

    /**
     * Execute a tool by name with safety checks and error handling.
     */
    public async executeTool(name: string, args: Record<string, any>, context: AgentContext): Promise<ToolResult> {
        const tool = this.tools.get(name);
        if (!tool) {
            return {
                success: false,
                output: '',
                error: `Tool "${name}" is not registered.`
            };
        }

        // Check with Security Guard
        const approval = await context.securityGuard.requestApproval({
            toolName: tool.name,
            securityLevel: tool.securityLevel,
            arguments: args,
            description: tool.description,
            warning: tool.securityLevel === 'critical' ? 'This action is potentially destructive or affects production.' : undefined
        });

        if (approval === 'rejected') {
            return {
                success: false,
                output: '',
                error: `Action "${tool.name}" was rejected by the user.`
            };
        }

        try {
            context.log(`Executing tool "${tool.name}" with args: ${JSON.stringify(args)}`);
            const result = await tool.execute(args, context);
            return result;
        } catch (error: any) {
            const errorMessage = error?.message || String(error);
            context.log(`Tool "${tool.name}" failed: ${errorMessage}`);
            return {
                success: false,
                output: '',
                error: `Execution error in "${tool.name}": ${errorMessage}`
            };
        }
    }
}
