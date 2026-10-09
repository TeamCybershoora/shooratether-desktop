/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cybershoora Pvt. Ltd. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Deployment life cycle status
 */
export type DeploymentStatus = 'idle' | 'building' | 'deploying' | 'live' | 'failed' | 'rollback';

/**
 * Stage health or step status
 */
export type StageStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface DeploymentStages {
    build: StageStatus;
    deploy: StageStatus;
    health: StageStatus;
}

export interface DeploymentRecord {
    id: string;
    version: string;
    timestamp: number;
    provider: string;
    status: DeploymentStatus;
    url?: string;
    commitHash?: string;
    commitMessage?: string;
    stages: DeploymentStages;
    durationMs?: number;
    errorMessage?: string;
    logSnippet?: string;
}

export interface CloudLogEntry {
    timestamp: number;
    level: 'info' | 'warn' | 'error';
    message: string;
    stage?: 'build' | 'deploy' | 'health';
}

export interface DeployOptions {
    targetEnvironment?: 'production' | 'staging' | 'preview';
    buildCommand?: string;
    envVars?: Record<string, string>;
    port?: number;
}

export interface HealthCheckResult {
    url: string;
    healthy: boolean;
    statusCode?: number;
    responseTimeMs?: number;
    message: string;
}

/**
 * Provider-agnostic interface for Cloud providers (AWS, Vercel, Azure, GCP, Docker, etc.)
 */
export interface ICloudProvider {
    readonly id: string;
    readonly name: string;
    readonly icon: string;

    /**
     * Checks if credentials / configuration are available for this provider.
     */
    isConnected(): Promise<boolean>;

    /**
     * Gets summary connection details (e.g., account ID, region, project name).
     */
    getConnectionInfo(): Promise<{ connected: boolean; details?: string; region?: string }>;

    /**
     * Starts a deployment for the current workspace.
     */
    deploy(workspaceRoot: string, options?: DeployOptions, onProgress?: (stage: keyof DeploymentStages, status: StageStatus, log: string) => void): Promise<DeploymentRecord>;

    /**
     * Retrieves the latest deployment status.
     */
    getStatus(workspaceRoot: string): Promise<DeploymentRecord | undefined>;

    /**
     * Retrieves deployment history.
     */
    getHistory(workspaceRoot: string, limit?: number): Promise<DeploymentRecord[]>;

    /**
     * Fetches recent build or runtime logs for a deployment.
     */
    getLogs(workspaceRoot: string, deploymentId?: string, limit?: number): Promise<CloudLogEntry[]>;

    /**
     * Rolls back to a previous deployment.
     */
    rollback(workspaceRoot: string, targetDeploymentId?: string): Promise<DeploymentRecord>;

    /**
     * Health check for active production / live endpoint.
     */
    checkHealth(url?: string): Promise<HealthCheckResult>;
}
