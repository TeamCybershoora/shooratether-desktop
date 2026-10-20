/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cybershoora Pvt. Ltd. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AgentContext, IAgentTool, ToolResult } from '../types.js';
import { CodebaseIndexer } from '../../indexer/CodebaseIndexer.js';

function resolvePath(filePath: string, context: AgentContext): string {
    if (path.isAbsolute(filePath)) {
        return filePath;
    }
    const root = context.workspaceRoot || (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    if (!root) {
        throw new Error('No workspace folder open.');
    }
    return path.join(root, filePath);
}

/**
 * Tool: read_file
 */
export const ReadFileTool: IAgentTool = {
    name: 'read_file',
    description: 'Read the contents of a file in the workspace. You can optionally specify startLine and endLine.',
    category: 'workspace',
    securityLevel: 'safe',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Relative or absolute path to the file.'
            },
            startLine: {
                type: 'number',
                description: 'Optional 1-indexed starting line number.'
            },
            endLine: {
                type: 'number',
                description: 'Optional 1-indexed ending line number.'
            }
        },
        required: ['path']
    },
    async execute(args: { path: string; startLine?: number; endLine?: number }, context: AgentContext): Promise<ToolResult> {
        const fullPath = resolvePath(args.path, context);
        if (!fs.existsSync(fullPath)) {
            return { success: false, output: '', error: `File not found: ${args.path}` };
        }

        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            return { success: false, output: '', error: `Path is a directory, not a file: ${args.path}` };
        }

        const content = fs.readFileSync(fullPath, 'utf8');
        const lines = content.split(/\r?\n/);

        let resultLines = lines;
        if (args.startLine !== undefined || args.endLine !== undefined) {
            const start = Math.max(0, (args.startLine || 1) - 1);
            const end = args.endLine ? Math.min(lines.length, args.endLine) : lines.length;
            resultLines = lines.slice(start, end);
        }

        return {
            success: true,
            output: resultLines.join('\n'),
            metadata: { totalLines: lines.length, lineCount: resultLines.length }
        };
    }
};

/**
 * Tool: write_file
 */
export const WriteFileTool: IAgentTool = {
    name: 'write_file',
    description: 'Create a new file or completely overwrite an existing file with new content.',
    category: 'workspace',
    securityLevel: 'sensitive',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Relative or absolute path to the file.'
            },
            content: {
                type: 'string',
                description: 'The exact content to write to the file.'
            },
            overwrite: {
                type: 'boolean',
                description: 'Whether to overwrite if file already exists. Defaults to true.'
            }
        },
        required: ['path', 'content']
    },
    async execute(args: { path: string; content: string; overwrite?: boolean }, context: AgentContext): Promise<ToolResult> {
        const fullPath = resolvePath(args.path, context);
        const exists = fs.existsSync(fullPath);
        if (exists && args.overwrite === false) {
            return { success: false, output: '', error: `File already exists: ${args.path}` };
        }

        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(fullPath, args.content, 'utf8');
        return {
            success: true,
            output: `Successfully wrote ${args.content.length} characters to ${args.path}`,
            metadata: { bytes: Buffer.byteLength(args.content, 'utf8'), created: !exists }
        };
    }
};

/**
 * Tool: edit_file
 */
export const EditFileTool: IAgentTool = {
    name: 'edit_file',
    description: 'Replace an exact target snippet of text in an existing file with replacement text.',
    category: 'workspace',
    securityLevel: 'sensitive',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Relative or absolute path to the file.'
            },
            targetContent: {
                type: 'string',
                description: 'The exact text sequence in the file to be replaced.'
            },
            replacementContent: {
                type: 'string',
                description: 'The replacement text.'
            }
        },
        required: ['path', 'targetContent', 'replacementContent']
    },
    async execute(args: { path: string; targetContent: string; replacementContent: string }, context: AgentContext): Promise<ToolResult> {
        const fullPath = resolvePath(args.path, context);
        if (!fs.existsSync(fullPath)) {
            return { success: false, output: '', error: `File not found: ${args.path}` };
        }

        const content = fs.readFileSync(fullPath, 'utf8');
        if (!content.includes(args.targetContent)) {
            return {
                success: false,
                output: '',
                error: `Target content not found in file: ${args.path}. Make sure whitespace and formatting match exactly.`
            };
        }

        const newContent = content.replace(args.targetContent, args.replacementContent);
        fs.writeFileSync(fullPath, newContent, 'utf8');

        return {
            success: true,
            output: `Successfully updated ${args.path}.`
        };
    }
};

/**
 * Tool: list_dir
 */
export const ListDirTool: IAgentTool = {
    name: 'list_dir',
    description: 'List files and directories at the specified path in the workspace.',
    category: 'workspace',
    securityLevel: 'safe',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Directory path to list (defaults to workspace root ".").'
            },
            recursive: {
                type: 'boolean',
                description: 'Whether to list recursively (defaults to false).'
            }
        }
    },
    async execute(args: { path?: string; recursive?: boolean }, context: AgentContext): Promise<ToolResult> {
        const targetPath = resolvePath(args.path || '.', context);
        if (!fs.existsSync(targetPath)) {
            return { success: false, output: '', error: `Directory not found: ${args.path || '.'}` };
        }

        const ignoreDirs = new Set(['node_modules', '.git', '.next', 'dist', 'out', 'build', '.vscode']);

        function scan(dir: string, currentDepth: number, maxDepth: number): string[] {
            if (currentDepth > maxDepth) return [];
            const results: string[] = [];
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (ignoreDirs.has(entry.name)) continue;
                    const full = path.join(dir, entry.name);
                    const rel = path.relative(targetPath, full);
                    if (entry.isDirectory()) {
                        results.push(`${rel}/`);
                        if (args.recursive) {
                            results.push(...scan(full, currentDepth + 1, maxDepth));
                        }
                    } else {
                        results.push(rel);
                    }
                }
            } catch {}
            return results;
        }

        const entries = scan(targetPath, 1, args.recursive ? 4 : 1);
        return {
            success: true,
            output: entries.length > 0 ? entries.join('\n') : '(Empty directory)'
        };
    }
};

/**
 * Tool: search_workspace
 */
export const SearchWorkspaceTool: IAgentTool = {
    name: 'search_workspace',
    description: 'Search for text or regex pattern across workspace files.',
    category: 'workspace',
    securityLevel: 'safe',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'The search string or regex to look for.'
            },
            maxResults: {
                type: 'number',
                description: 'Maximum number of file matches to return (default: 20).'
            }
        },
        required: ['query']
    },
    async execute(args: { query: string; maxResults?: number }, context: AgentContext): Promise<ToolResult> {
        const root = context.workspaceRoot || (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
        if (!root) {
            return { success: false, output: '', error: 'No workspace open.' };
        }

        const max = args.maxResults || 20;
        const matches: string[] = [];
        const ignoreDirs = new Set(['node_modules', '.git', '.next', 'dist', 'out', 'build']);

        function searchDir(dir: string) {
            if (matches.length >= max) return;
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (ignoreDirs.has(entry.name)) continue;
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        searchDir(full);
                    } else if (entry.isFile() && !entry.name.match(/\.(png|jpg|ico|exe|dll|wasm|pdf|zip|tar)$/i)) {
                        try {
                            const content = fs.readFileSync(full, 'utf8');
                            if (content.includes(args.query)) {
                                const rel = path.relative(root, full);
                                matches.push(rel);
                                if (matches.length >= max) return;
                            }
                        } catch {}
                    }
                }
            } catch {}
        }

        searchDir(root);
        return {
            success: true,
            output: matches.length > 0 ? `Matches found in ${matches.length} files:\n${matches.join('\n')}` : `No matches found for "${args.query}".`
        };
    }
};

/**
 * Tool: detect_framework
 */
export const DetectFrameworkTool: IAgentTool = {
    name: 'detect_framework',
    description: 'Inspect the workspace to detect the application framework, runtime, package manager, and build configurations.',
    category: 'workspace',
    securityLevel: 'safe',
    parameters: {
        type: 'object',
        properties: {}
    },
    async execute(_args: any, context: AgentContext): Promise<ToolResult> {
        const root = context.workspaceRoot || (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
        if (!root) {
            return { success: false, output: '', error: 'No workspace open.' };
        }

        const info: Record<string, any> = {
            framework: 'Unknown',
            runtime: 'Unknown',
            packageManager: 'Unknown',
            buildScript: null,
            startScript: null,
            envFiles: [],
            dockerized: false
        };

        // Check Docker
        if (fs.existsSync(path.join(root, 'Dockerfile'))) {
            info.dockerized = true;
        }

        // Check Env files
        const envNames = ['.env', '.env.local', '.env.production', '.env.example'];
        for (const name of envNames) {
            if (fs.existsSync(path.join(root, name))) {
                info.envFiles.push(name);
            }
        }

        // Check Node / JavaScript / TypeScript
        const pkgPath = path.join(root, 'package.json');
        if (fs.existsSync(pkgPath)) {
            info.runtime = 'Node.js';
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

                if (allDeps['next']) info.framework = 'Next.js';
                else if (allDeps['react']) info.framework = 'React';
                else if (allDeps['vue']) info.framework = 'Vue';
                else if (allDeps['@nestjs/core']) info.framework = 'NestJS';
                else if (allDeps['express']) info.framework = 'Express';
                else if (allDeps['fastify']) info.framework = 'Fastify';
                else if (allDeps['svelte'] || allDeps['@sveltejs/kit']) info.framework = 'Svelte';
                else if (allDeps['astro']) info.framework = 'Astro';
                else info.framework = 'Node.js App';

                info.buildScript = pkg.scripts?.build || null;
                info.startScript = pkg.scripts?.start || null;
            } catch {}

            if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) info.packageManager = 'pnpm';
            else if (fs.existsSync(path.join(root, 'yarn.lock'))) info.packageManager = 'yarn';
            else if (fs.existsSync(path.join(root, 'bun.lockb'))) info.packageManager = 'bun';
            else info.packageManager = 'npm';
        }

        // Check Python
        if (fs.existsSync(path.join(root, 'requirements.txt')) || fs.existsSync(path.join(root, 'Pipfile')) || fs.existsSync(path.join(root, 'pyproject.toml'))) {
            info.runtime = 'Python';
            if (fs.existsSync(path.join(root, 'manage.py'))) info.framework = 'Django';
            else {
                const req = fs.existsSync(path.join(root, 'requirements.txt')) ? fs.readFileSync(path.join(root, 'requirements.txt'), 'utf8') : '';
                if (req.includes('fastapi')) info.framework = 'FastAPI';
                else if (req.includes('flask')) info.framework = 'Flask';
                else info.framework = 'Python App';
            }
            info.packageManager = 'pip';
        }

        return {
            success: true,
            output: JSON.stringify(info, null, 2),
            metadata: info
        };
    }
};

/**
 * Tool: codebase_search (Semantic / Symbol RAG Search)
 */
export const CodebaseSearchTool: IAgentTool = {
    name: 'codebase_search',
    description: 'Semantic & symbol RAG search across the entire project workspace. Returns relevant code snippets, line numbers, and file paths.',
    category: 'workspace',
    securityLevel: 'safe',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'The search query or concept (e.g. "auth middleware", "payment database models", "render header")'
            },
            limit: {
                type: 'number',
                description: 'Maximum number of code snippets to return (default: 5)'
            }
        },
        required: ['query']
    },
    async execute(args: { query: string; limit?: number }, _context: AgentContext): Promise<ToolResult> {
        const indexer = CodebaseIndexer.getInstance();
        const results = indexer.search(args.query, args.limit || 5);
        if (results.length === 0) {
            return {
                success: true,
                output: `No matching code snippets found for "${args.query}".`,
                metadata: { count: 0 }
            };
        }
        let formatted = `Found ${results.length} relevant code snippet(s) for "${args.query}":\n\n`;
        for (const r of results) {
            formatted += `[${r.chunk.relativePath}:${r.chunk.startLine}-${r.chunk.endLine}] (Score: ${r.score})\n`;
            formatted += `\`\`\`\n${r.chunk.snippet}\n\`\`\`\n\n`;
        }
        return {
            success: true,
            output: formatted,
            metadata: { count: results.length }
        };
    }
};

export const WORKSPACE_TOOLS: IAgentTool[] = [
    ReadFileTool,
    WriteFileTool,
    EditFileTool,
    ListDirTool,
    SearchWorkspaceTool,
    DetectFrameworkTool,
    CodebaseSearchTool
];
