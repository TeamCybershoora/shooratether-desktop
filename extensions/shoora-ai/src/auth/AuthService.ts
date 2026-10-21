/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cybershoora Pvt. Ltd. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export interface UserProfile {
    id: number;
    email: string;
    name: string;
    avatarUrl?: string;
    authProvider: 'google' | 'github' | 'email';
    plan: 'free' | 'pro' | 'team' | 'enterprise';
    status: string;
    createdAt?: string;
    planDetails?: {
        id: string;
        displayName: string;
        aiTokenLimit: number;
        features?: any;
    };
}

export class AuthService {
    private static instance: AuthService;
    private static readonly TOKEN_SECRET_KEY = 'shoora.auth.jwtToken';
    private currentUser: UserProfile | null = null;
    private _onDidChangeUser = new vscode.EventEmitter<UserProfile | null>();
    public readonly onDidChangeUser = this._onDidChangeUser.event;

    private constructor(private readonly context: vscode.ExtensionContext) {}

    public static initialize(context: vscode.ExtensionContext): AuthService {
        if (!AuthService.instance) {
            AuthService.instance = new AuthService(context);
        }
        return AuthService.instance;
    }

    public static getInstance(): AuthService {
        if (!AuthService.instance) {
            throw new Error('AuthService has not been initialized with ExtensionContext.');
        }
        return AuthService.instance;
    }

    public getAuthServerUrl(): string {
        const config = vscode.workspace.getConfiguration('shoora');
        return config.get<string>('authServerUrl', 'http://localhost:5000').replace(/\/$/, '');
    }

    /**
     * Initializes session on extension activation.
     */
    public async restoreSession(): Promise<UserProfile | null> {
        try {
            const token = await this.context.secrets.get(AuthService.TOKEN_SECRET_KEY);
            if (!token) {
                this.currentUser = null;
                this._onDidChangeUser.fire(null);
                return null;
            }

            const user = await this.fetchUserProfile(token);
            if (user) {
                this.currentUser = user;
                this._onDidChangeUser.fire(user);
                return user;
            } else {
                // Token invalid or expired, clear it
                await this.context.secrets.delete(AuthService.TOKEN_SECRET_KEY);
                this.currentUser = null;
                this._onDidChangeUser.fire(null);
                return null;
            }
        } catch {
            return null;
        }
    }

    /**
     * Opens browser for Google OAuth Login
     */
    public async loginWithGoogle(): Promise<void> {
        const serverUrl = this.getAuthServerUrl();
        const loginUrl = `${serverUrl}/api/auth/google?source=desktop`;
        await vscode.env.openExternal(vscode.Uri.parse(loginUrl));
    }

    /**
     * Opens browser for GitHub OAuth Login
     */
    public async loginWithGitHub(): Promise<void> {
        const serverUrl = this.getAuthServerUrl();
        const loginUrl = `${serverUrl}/api/auth/github?source=desktop`;
        await vscode.env.openExternal(vscode.Uri.parse(loginUrl));
    }

    /**
     * Handles deep link callback: shooratether://auth/callback?token=...
     * Or vscode://cybershoora.shoora-ai/auth/callback?token=...
     */
    public async handleAuthCallback(uri: vscode.Uri): Promise<boolean> {
        try {
            const queryParams = new URLSearchParams(uri.query);
            const token = queryParams.get('token');

            if (!token) {
                vscode.window.showErrorMessage('SHOORA Authentication failed: No token received in callback.');
                return false;
            }

            // Save token securely in VS Code Keychain / SecretStorage
            await this.context.secrets.store(AuthService.TOKEN_SECRET_KEY, token);

            // Fetch user profile from backend
            const user = await this.fetchUserProfile(token);
            if (!user) {
                vscode.window.showErrorMessage('Failed to fetch user profile from SHOORA Backend API.');
                return false;
            }

            this.currentUser = user;
            this._onDidChangeUser.fire(user);

            vscode.window.showInformationMessage(
                `✓ Welcome, ${user.name || user.email}! Connected to SHOORA TETHER (${(user.plan || 'Free').toUpperCase()} Plan).`
            );
            return true;
        } catch (err: any) {
            vscode.window.showErrorMessage(`SHOORA Auth Callback Error: ${err.message || err}`);
            return false;
        }
    }

    /**
     * Fetches authenticated user profile from backend /api/auth/me
     */
    public async fetchUserProfile(token: string): Promise<UserProfile | null> {
        try {
            const serverUrl = this.getAuthServerUrl();
            const res = await fetch(`${serverUrl}/api/auth/me`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!res.ok) {
                return null;
            }

            const data: any = await res.json();
            if (data.success && data.user) {
                return data.user as UserProfile;
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * Logs out and clears encrypted token.
     */
    public async logout(): Promise<void> {
        try {
            const token = await this.context.secrets.get(AuthService.TOKEN_SECRET_KEY);
            if (token) {
                const serverUrl = this.getAuthServerUrl();
                await fetch(`${serverUrl}/api/auth/logout`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}` }
                }).catch(() => {});
            }

            await this.context.secrets.delete(AuthService.TOKEN_SECRET_KEY);
            this.currentUser = null;
            this._onDidChangeUser.fire(null);
            vscode.window.showInformationMessage('You have been logged out of SHOORA TETHER.');
        } catch (err: any) {
            vscode.window.showErrorMessage(`Logout error: ${err.message || err}`);
        }
    }

    public getUser(): UserProfile | null {
        return this.currentUser;
    }

    public isLoggedIn(): boolean {
        return this.currentUser !== null;
    }

    public async getToken(): Promise<string | undefined> {
        return await this.context.secrets.get(AuthService.TOKEN_SECRET_KEY);
    }
}
