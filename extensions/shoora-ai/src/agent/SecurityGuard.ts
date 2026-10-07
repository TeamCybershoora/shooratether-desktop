/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cybershoora Pvt. Ltd. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ApprovalRequest, ApprovalStatus, ISecurityGuard, SecurityLevel } from './types.js';

export type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean>;

export class SecurityGuard implements ISecurityGuard {
    private customHandler?: ApprovalHandler;

    constructor() {}

    /**
     * Register a custom approval handler (e.g., from the Agent Webview UI)
     */
    public setCustomHandler(handler: ApprovalHandler | undefined): void {
        this.customHandler = handler;
    }

    /**
     * Check safety level and request user confirmation if needed.
     */
    public async requestApproval(request: ApprovalRequest): Promise<ApprovalStatus> {
        // Safe operations: Auto-approved immediately
        if (request.securityLevel === 'safe') {
            return 'auto_approved';
        }

        // Sensitive operations: check settings
        const config = vscode.workspace.getConfiguration('shoora.security');
        const autoApproveSensitive = config.get<boolean>('autoApproveSensitive', false);

        if (request.securityLevel === 'sensitive' && autoApproveSensitive) {
            return 'auto_approved';
        }

        // Delegate to custom UI handler if available (e.g., chat webview approval card)
        if (this.customHandler) {
            try {
                const approved = await this.customHandler(request);
                return approved ? 'approved' : 'rejected';
            } catch {
                return 'rejected';
            }
        }

        // Fallback to native VS Code modal / notification
        return await this.showNativeApprovalDialog(request);
    }

    private async showNativeApprovalDialog(request: ApprovalRequest): Promise<ApprovalStatus> {
        const isCritical = request.securityLevel === 'critical';
        const title = isCritical ? `⚠️ [CRITICAL APPROVAL REQUIRED] Shoora Agent` : `🔒 [Approval Required] Shoora Agent`;
        const actionDetails = this.formatActionDetails(request);
        const warning = request.warning ? `\nWarning: ${request.warning}` : '';
        const message = `${title}\n\nThe agent is requesting to execute: ${request.toolName}\n${request.description}${warning}\n\nDetails:\n${actionDetails}`;

        if (isCritical) {
            // Modal dialog for critical operations
            const selection = await vscode.window.showWarningMessage(
                message,
                { modal: true, detail: `Review parameters:\n${actionDetails}` },
                'Approve & Execute',
                'Reject'
            );
            return selection === 'Approve & Execute' ? 'approved' : 'rejected';
        } else {
            // Notification toast for sensitive operations
            const selection = await vscode.window.showInformationMessage(
                `Shoora Agent: Approve ${request.toolName}? (${request.description})`,
                'Approve',
                'Reject'
            );
            return selection === 'Approve' ? 'approved' : 'rejected';
        }
    }

    private formatActionDetails(request: ApprovalRequest): string {
        try {
            return JSON.stringify(request.arguments, null, 2);
        } catch {
            return String(request.arguments);
        }
    }
}
