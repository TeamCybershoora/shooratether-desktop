/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cybershoora Pvt. Ltd. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { IAgentTool, AgentContext, ToolResult } from '../types.js';
import { CloudRegistry } from '../../cloud/CloudRegistry.js';

export const DeployProjectTool: IAgentTool = {
    name: 'cloud_deploy_project',
    description: 'Deploys the current project/workspace to the cloud provider (AWS App Runner / CloudFront). Runs build, creates live cloud service, and tests health.',
    category: 'cloud',
    securityLevel: 'critical', // Requires user confirmation modal
    parameters: {
        type: 'object',
        properties: {
            environment: {
                type: 'string',
                description: 'Target deployment environment',
                enum: ['production', 'staging', 'preview'],
                default: 'production'
            },
            buildCommand: {
                type: 'string',
                description: 'Optional custom build command (e.g. "npm run build")'
            }
        }
    },
    async execute(args: { environment?: 'production' | 'staging' | 'preview'; buildCommand?: string }, context: AgentContext): Promise<ToolResult> {
        if (!context.workspaceRoot) {
            return {
                success: false,
                output: 'No workspace folder open. Open a project workspace to deploy.'
            };
        }

        try {
            const registry = CloudRegistry.getInstance();
            const provider = registry.getActiveProvider();

            context.log(`Deploying workspace to ${provider.name}...`);
            const result = await provider.deploy(context.workspaceRoot, {
                targetEnvironment: args.environment || 'production',
                buildCommand: args.buildCommand
            }, (stage, status, log) => {
                context.log(`[${stage.toUpperCase()}] ${status}: ${log}`);
            });

            if (result.status === 'live') {
                return {
                    success: true,
                    output: `Successfully deployed to ${provider.name}!\n` +
                        `- Production URL: ${result.url}\n` +
                        `- Version: ${result.version}\n` +
                        `- Status: 🟢 Live\n` +
                        `- Stages: Build (${result.stages.build}) | Deploy (${result.stages.deploy}) | Health (${result.stages.health})\n` +
                        `- Commit: ${result.commitHash || 'workspace head'} (${result.commitMessage || 'latest'})`,
                    metadata: { deployment: result }
                };
            } else {
                return {
                    success: false,
                    output: `Deployment finished with status: ${result.status}\nError: ${result.errorMessage || 'Unknown error'}\n` +
                        `Stages: Build (${result.stages.build}) | Deploy (${result.stages.deploy}) | Health (${result.stages.health})`,
                    metadata: { deployment: result }
                };
            }
        } catch (err: any) {
            return {
                success: false,
                output: `Failed to execute cloud deployment: ${err.message || err}`,
                error: err.message
            };
        }
    }
};

export const GetCloudStatusTool: IAgentTool = {
    name: 'cloud_get_status',
    description: 'Retrieves current cloud provider connection details and the active deployment / production status.',
    category: 'cloud',
    securityLevel: 'safe',
    parameters: {
        type: 'object',
        properties: {}
    },
    async execute(_args: Record<string, any>, context: AgentContext): Promise<ToolResult> {
        if (!context.workspaceRoot) {
            return {
                success: false,
                output: 'No workspace folder open.'
            };
        }

        try {
            const registry = CloudRegistry.getInstance();
            const provider = registry.getActiveProvider();
            const connection = await provider.getConnectionInfo();
            const latestDeploy = await provider.getStatus(context.workspaceRoot);

            let output = `Cloud Provider: ${provider.name}\n` +
                `- Connection: ${connection.connected ? '● Connected' : '○ Not Connected'}\n` +
                `- Region: ${connection.region || 'us-east-1'}\n`;

            if (connection.details) {
                output += `- Details: ${connection.details}\n`;
            }

            if (latestDeploy) {
                const statusEmoji = latestDeploy.status === 'live' ? '🟢 Live' : latestDeploy.status === 'failed' ? '🔴 Failed' : `🟡 ${latestDeploy.status}`;
                output += `\nLatest Deployment:\n` +
                    `- Version: ${latestDeploy.version}\n` +
                    `- Status: ${statusEmoji}\n` +
                    `- URL: ${latestDeploy.url || 'N/A'}\n` +
                    `- Deployed: ${new Date(latestDeploy.timestamp).toLocaleString()}\n` +
                    `- Build: ${latestDeploy.stages.build} | Deploy: ${latestDeploy.stages.deploy} | Health: ${latestDeploy.stages.health}`;
            } else {
                output += `\nLatest Deployment: None recorded yet.`;
            }

            return {
                success: true,
                output,
                metadata: { connection, latestDeploy }
            };
        } catch (err: any) {
            return {
                success: false,
                output: `Failed to retrieve cloud status: ${err.message || err}`,
                error: err.message
            };
        }
    }
};

export const GetCloudLogsTool: IAgentTool = {
    name: 'cloud_get_logs',
    description: 'Fetches recent build, deploy, and runtime logs from the cloud provider.',
    category: 'cloud',
    securityLevel: 'safe',
    parameters: {
        type: 'object',
        properties: {
            limit: {
                type: 'number',
                description: 'Number of log lines to retrieve (default: 30)',
                default: 30
            }
        }
    },
    async execute(args: { limit?: number }, context: AgentContext): Promise<ToolResult> {
        if (!context.workspaceRoot) {
            return {
                success: false,
                output: 'No workspace folder open.'
            };
        }

        try {
            const registry = CloudRegistry.getInstance();
            const provider = registry.getActiveProvider();
            const logs = await provider.getLogs(context.workspaceRoot, undefined, args.limit || 30);

            if (logs.length === 0) {
                return {
                    success: true,
                    output: `No cloud logs found for this project.`
                };
            }

            const formatted = logs.map((l) => {
                const time = new Date(l.timestamp).toLocaleTimeString();
                const stage = l.stage ? `[${l.stage.toUpperCase()}] ` : '';
                return `[${time}] [${l.level.toUpperCase()}] ${stage}${l.message}`;
            }).join('\n');

            return {
                success: true,
                output: `Recent logs (${logs.length} entries):\n\n${formatted}`,
                metadata: { logs }
            };
        } catch (err: any) {
            return {
                success: false,
                output: `Failed to fetch cloud logs: ${err.message || err}`,
                error: err.message
            };
        }
    }
};

export const CloudRollbackTool: IAgentTool = {
    name: 'cloud_rollback',
    description: 'Rolls back production deployment to the previous stable version.',
    category: 'cloud',
    securityLevel: 'critical', // Sensitive production action
    parameters: {
        type: 'object',
        properties: {
            targetDeploymentId: {
                type: 'string',
                description: 'Optional ID of specific deployment to rollback to'
            }
        }
    },
    async execute(args: { targetDeploymentId?: string }, context: AgentContext): Promise<ToolResult> {
        if (!context.workspaceRoot) {
            return {
                success: false,
                output: 'No workspace folder open.'
            };
        }

        try {
            const registry = CloudRegistry.getInstance();
            const provider = registry.getActiveProvider();

            context.log(`Triggering rollback on ${provider.name}...`);
            const rolledBack = await provider.rollback(context.workspaceRoot, args.targetDeploymentId);

            return {
                success: true,
                output: `Rollback completed successfully on ${provider.name}!\n` +
                    `- New Active Version: ${rolledBack.version}\n` +
                    `- Production URL: ${rolledBack.url}\n` +
                    `- Status: 🟢 Live\n` +
                    `- Note: ${rolledBack.commitMessage || 'Traffic diverted to prior stable version.'}`,
                metadata: { rollback: rolledBack }
            };
        } catch (err: any) {
            return {
                success: false,
                output: `Failed to execute rollback: ${err.message || err}`,
                error: err.message
            };
        }
    }
};

export const CloudCheckHealthTool: IAgentTool = {
    name: 'cloud_check_health',
    description: 'Pings the live production URL or an endpoint to verify HTTP availability and latency.',
    category: 'cloud',
    securityLevel: 'safe',
    parameters: {
        type: 'object',
        properties: {
            url: {
                type: 'string',
                description: 'URL to check. If omitted, checks current live deployment endpoint.'
            }
        }
    },
    async execute(args: { url?: string }, context: AgentContext): Promise<ToolResult> {
        try {
            const registry = CloudRegistry.getInstance();
            const provider = registry.getActiveProvider();

            let targetUrl = args.url;
            if (!targetUrl && context.workspaceRoot) {
                const latest = await provider.getStatus(context.workspaceRoot);
                targetUrl = latest?.url;
            }

            if (!targetUrl) {
                return {
                    success: false,
                    output: 'No deployment URL available to health check. Please deploy first or provide a URL.'
                };
            }

            const health = await provider.checkHealth(targetUrl);
            return {
                success: health.healthy,
                output: `Health Check Result for ${health.url}:\n` +
                    `- Healthy: ${health.healthy ? '🟢 YES' : '🔴 NO'}\n` +
                    `- Status Code: ${health.statusCode ?? 'N/A'}\n` +
                    `- Response Time: ${health.responseTimeMs}ms\n` +
                    `- Message: ${health.message}`,
                metadata: { health }
            };
        } catch (err: any) {
            return {
                success: false,
                output: `Health check error: ${err.message || err}`,
                error: err.message
            };
        }
    }
};

export const CLOUD_TOOLS: IAgentTool[] = [
    DeployProjectTool,
    GetCloudStatusTool,
    GetCloudLogsTool,
    CloudRollbackTool,
    CloudCheckHealthTool
];
