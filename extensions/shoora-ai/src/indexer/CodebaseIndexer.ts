/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cybershoora Pvt. Ltd. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface CodebaseChunk {
    filePath: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    snippet: string;
    symbols: string[];
}

export interface SearchResult {
    chunk: CodebaseChunk;
    score: number;
}

export class CodebaseIndexer {
    private static instance: CodebaseIndexer;
    private chunks: CodebaseChunk[] = [];
    private indexedFilesCount: number = 0;
    private isIndexing: boolean = false;
    private lastIndexTime?: Date;

    private readonly IGNORED_DIRS = new Set([
        'node_modules', '.git', '.github', 'dist', 'build', 'out',
        'target', 'vendor', '.gemini', 'coverage', '.vscode', '.idea',
        'bin', 'obj', '.next', '.nuxt', '__pycache__'
    ]);

    private readonly ALLOWED_EXTS = new Set([
        '.ts', '.tsx', '.js', '.jsx', '.json', '.html', '.css', '.scss',
        '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.hpp',
        '.cs', '.php', '.rb', '.md', '.sql', '.yaml', '.yml', '.sh', '.iss'
    ]);

    private constructor() {}

    public static getInstance(): CodebaseIndexer {
        if (!CodebaseIndexer.instance) {
            CodebaseIndexer.instance = new CodebaseIndexer();
        }
        return CodebaseIndexer.instance;
    }

    public async indexWorkspace(progressCallback?: (msg: string) => void): Promise<void> {
        if (this.isIndexing) return;
        this.isIndexing = true;
        this.chunks = [];
        this.indexedFilesCount = 0;

        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                this.isIndexing = false;
                return;
            }

            for (const folder of workspaceFolders) {
                const rootPath = folder.uri.fsPath;
                if (progressCallback) progressCallback(`Indexing ${folder.name}...`);
                await this.scanDirectory(rootPath, rootPath);
            }

            this.lastIndexTime = new Date();
            if (progressCallback) {
                progressCallback(`Indexed ${this.indexedFilesCount} files (${this.chunks.length} chunks).`);
            }
        } finally {
            this.isIndexing = false;
        }
    }

    private async scanDirectory(dir: string, rootDir: string): Promise<void> {
        let entries: fs.Dirent[] = [];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!this.IGNORED_DIRS.has(entry.name)) {
                    await this.scanDirectory(fullPath, rootDir);
                }
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (this.ALLOWED_EXTS.has(ext)) {
                    await this.indexFile(fullPath, rootDir);
                }
            }
        }
    }

    private async indexFile(filePath: string, rootDir: string): Promise<void> {
        try {
            const stat = await fs.promises.stat(filePath);
            if (stat.size > 500 * 1024) return; // Skip files > 500KB

            const content = await fs.promises.readFile(filePath, 'utf8');
            const lines = content.split('\n');
            const relativePath = path.relative(rootDir, filePath).replace(/\\/g, '/');

            this.indexedFilesCount++;

            // Split into overlapping chunks of 40 lines
            const CHUNK_SIZE = 40;
            const CHUNK_STEP = 30;

            for (let i = 0; i < lines.length; i += CHUNK_STEP) {
                const chunkLines = lines.slice(i, i + CHUNK_SIZE);
                const snippet = chunkLines.join('\n').trim();
                if (!snippet) continue;

                // Extract simple symbols (functions, classes, interfaces, vars)
                const symbols = this.extractSymbols(snippet);

                this.chunks.push({
                    filePath,
                    relativePath,
                    startLine: i + 1,
                    endLine: Math.min(i + CHUNK_SIZE, lines.length),
                    snippet,
                    symbols
                });

                if (i + CHUNK_SIZE >= lines.length) break;
            }
        } catch {}
    }

    private extractSymbols(text: string): string[] {
        const symbols: string[] = [];
        const symbolRegex = /(?:function|class|interface|type|const|let|var|def|fn|struct|enum)\s+([A-Za-z0-9_$]+)/g;
        let match;
        while ((match = symbolRegex.exec(text)) !== null) {
            symbols.push(match[1]);
        }
        return symbols;
    }

    public search(query: string, maxResults: number = 6): SearchResult[] {
        if (!query.trim() || this.chunks.length === 0) return [];

        const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
        if (terms.length === 0) return [];

        const results: SearchResult[] = [];

        for (const chunk of this.chunks) {
            let score = 0;
            const lowerSnippet = chunk.snippet.toLowerCase();
            const lowerPath = chunk.relativePath.toLowerCase();

            for (const term of terms) {
                // High score for exact symbol match
                for (const sym of chunk.symbols) {
                    if (sym.toLowerCase() === term) score += 25;
                    else if (sym.toLowerCase().includes(term)) score += 10;
                }

                // Score for file path match
                if (lowerPath.includes(term)) {
                    score += 15;
                }

                // Score for content occurrence
                const occurrences = (lowerSnippet.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
                score += Math.min(occurrences * 3, 20);
            }

            if (score > 0) {
                results.push({ chunk, score });
            }
        }

        results.sort((a, b) => b.score - a.score);
        return results.slice(0, maxResults);
    }

    public formatContextForPrompt(query: string, maxResults: number = 4): string {
        const results = this.search(query, maxResults);
        if (results.length === 0) return '';

        let out = `\n--- Relevant Codebase Context for "${query}" ---\n`;
        for (const res of results) {
            out += `\n[File: ${res.chunk.relativePath} (lines ${res.chunk.startLine}-${res.chunk.endLine})]\n`;
            out += `\`\`\`\n${res.chunk.snippet}\n\`\`\`\n`;
        }
        out += `--- End Codebase Context ---\n`;
        return out;
    }

    public getStats(): { indexedFiles: number; chunksCount: number; isIndexing: boolean; lastIndexTime?: Date } {
        return {
            indexedFiles: this.indexedFilesCount,
            chunksCount: this.chunks.length,
            isIndexing: this.isIndexing,
            lastIndexTime: this.lastIndexTime
        };
    }
}
