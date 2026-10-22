/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cybershoora Pvt. Ltd. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AuthService } from './AuthService.js';

export class ShooraUriHandler implements vscode.UriHandler {
    async handleUri(uri: vscode.Uri): Promise<void> {
        const authService = AuthService.getInstance();
        // Expected paths: /auth/callback or /callback
        if (uri.path.includes('auth/callback') || uri.path.includes('callback')) {
            await authService.handleAuthCallback(uri);
        } else if (uri.path.includes('plan/sync') || uri.path.includes('plan/updated')) {
            await authService.syncSubscription();
        }
    }
}
