/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cybershoora Pvt. Ltd. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Security classification levels for agent tools.
 * - 'safe': Read-only operations. Auto-executed without interrupting the user.
 * - 'sensitive': File edits, branch creation, safe test runs. Inline approval in UI.
 * - 'critical': Destructive actions (force push, delete repo/file, production deploy, rollback, cloud destroy).
 *               Requires explicit confirmation modal with action preview.
 */
export type SecurityLevel = 'safe' | 'sensitive' | 'critical';

export type ApprovalStatus = 'approved' | 'rejected' | 'auto_approved';

export interface ApprovalRequest {
    toolName: string;
    securityLevel: SecurityLevel;
    arguments: Record<string, any>;
    description: string;
    warning?: string;
}

export interface ISecurityGuard {
    requestApproval(request: ApprovalRequest): Promise<ApprovalStatus>;
}

export interface ToolParameterProperty {
    type: 'string' | 'number' | 'boolean' | 'array' | 'object';
    description: string;
    enum?: string[];
    default?: any;
    items?: {
        type: string;
        description?: string;
    };
}

export interface ToolParametersSchema {
    type: 'object';
    properties: Record<string, ToolParameterProperty>;
    required?: string[];
}

export interface ToolResult {
    success: boolean;
    output: string;
    error?: string;
    metadata?: Record<string, any>;
}

export interface AgentContext {
    workspaceRoot?: string;
    currentEditorFile?: string;
    securityGuard: ISecurityGuard;
    abortSignal?: AbortSignal;
    log: (message: string) => void;
}

export interface IAgentTool {
    readonly name: string;
    readonly description: string;
    readonly category: 'workspace' | 'terminal' | 'git' | 'github' | 'cloud' | 'monitoring';
    readonly parameters: ToolParametersSchema;
    readonly securityLevel: SecurityLevel;
    execute(args: any, context: AgentContext): Promise<ToolResult>;
}

export interface AgentToolCall {
    id: string;
    name: string;
    arguments: Record<string, any>;
}

export interface AgentMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    toolCalls?: AgentToolCall[];
    toolCallId?: string;
    name?: string;
}

export interface AgentStep {
    stepNumber: number;
    thought?: string;
    toolCalls: AgentToolCall[];
    results: ToolResult[];
}

export type AgentEventType =
    | 'thought'
    | 'tool_start'
    | 'approval_request'
    | 'approval_response'
    | 'tool_result'
    | 'step_complete'
    | 'final_answer'
    | 'error';

export interface AgentEvent {
    type: AgentEventType;
    data: any;
    timestamp: number;
}
