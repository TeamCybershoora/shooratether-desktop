/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cybershoora Pvt. Ltd. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AuthService } from './AuthService.js';

export class ShooraUriHandler implements vscode.UriHandler {
    async handleUri(uri: vscode.Uri): Promise<void> {
        // Expected paths: /auth/callback or /callback
        if (uri.path.includes('auth/callback') || uri.path.includes('callback')) {
            const authService = AuthService.getInstance();
            await authService.handleAuthCallback(uri);
        }
    }
}
