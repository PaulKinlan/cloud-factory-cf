import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition } from '@factory-cloud/sdk';

const execAsync = promisify(exec);

export interface LocalToolsOptions {
  cwd?: string;
  maxFileSize?: number;
  commandTimeoutMs?: number;
}

export function createLocalTools(options: LocalToolsOptions = {}): readonly ToolDefinition[] {
  const rootDir = path.resolve(options.cwd ?? process.cwd());
  const maxFileSize = options.maxFileSize ?? 1024 * 1024; // 1 MB
  const commandTimeoutMs = options.commandTimeoutMs ?? 30000;

  async function resolveSafePath(filePath: string, allowMissing = false): Promise<string> {
    const realRoot = await fs.realpath(rootDir).catch(() => rootDir);
    const resolved = path.resolve(realRoot, filePath);

    if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) {
      throw new Error(`Path traversal denied: '${filePath}' is outside workspace root`);
    }

    try {
      const realPath = await fs.realpath(resolved);
      if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
        throw new Error(`Path traversal denied: '${filePath}' resolves outside workspace root via symlink`);
      }
      return realPath;
    } catch (err: any) {
      if (allowMissing && (err?.code === 'ENOENT' || String(err).includes('ENOENT'))) {
        // Walk up to find the closest existing ancestor directory
        let current = path.dirname(resolved);
        while (current !== realRoot && current.startsWith(realRoot + path.sep)) {
          try {
            const realCurrent = await fs.realpath(current);
            if (realCurrent !== realRoot && !realCurrent.startsWith(realRoot + path.sep)) {
              throw new Error(`Path traversal denied: '${filePath}' resolves outside workspace root via symlink`);
            }
            return resolved;
          } catch (e: any) {
            if (e?.code === 'ENOENT' || String(e).includes('ENOENT')) {
              current = path.dirname(current);
              continue;
            }
            throw e;
          }
        }
        return resolved;
      }
      throw err;
    }
  }

  const readFileTool: ToolDefinition = {
    name: 'read_file',
    description: 'Read contents of a file within the local workspace directory',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file to read' },
      },
      required: ['path'],
    },
    handler: async (params) => {
      const filePath = await resolveSafePath(params.path as string);
      const stat = await fs.stat(filePath);
      if (stat.size > maxFileSize) {
        throw new Error(`File size ${stat.size} exceeds maximum limit of ${maxFileSize} bytes`);
      }
      const content = await fs.readFile(filePath, 'utf8');
      return { path: params.path, content, size: stat.size };
    },
  };

  const writeFileTool: ToolDefinition = {
    name: 'write_file',
    description: 'Write content to a file within the local workspace directory',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file to write' },
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['path', 'content'],
    },
    handler: async (params) => {
      const filePath = await resolveSafePath(params.path as string, true);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, params.content as string, 'utf8');
      return { path: params.path, written: true };
    },
  };

  const listFilesTool: ToolDefinition = {
    name: 'list_files',
    description: 'List files and directories within a local workspace subdirectory',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Subdirectory path to list (defaults to root)' },
      },
    },
    handler: async (params) => {
      const subPath = typeof params.path === 'string' ? params.path : '.';
      const targetDir = await resolveSafePath(subPath);
      const entries = await fs.readdir(targetDir, { withFileTypes: true });
      return {
        path: subPath,
        entries: entries.map((e: fs.Dirent) => ({
          name: e.name,
          isDirectory: e.isDirectory(),
          isFile: e.isFile(),
        })),
      };
    },
  };

  function validateCommandContainment(cmd: string): void {
    if (/(?:^|\s|\/)\.\.(?:\/|\s|$)/.test(cmd)) {
      throw new Error(`Command containment violation: traversal '..' is not allowed in command`);
    }

    const allowedSystemPrefixes = [
      '/bin/',
      '/usr/bin/',
      '/usr/local/bin/',
      '/dev/null',
      '/dev/zero',
      '/dev/urandom',
      '/dev/stdout',
      '/dev/stderr',
    ];
    const matches = cmd.match(/(?:^|[\s"'=><|;&])(\/[^\s"'><|;&]+)/g);
    if (matches) {
      for (const rawMatch of matches) {
        const cleanPath = rawMatch.replace(/^[=\s"'><|;&]+/, '');
        const isSystem = allowedSystemPrefixes.some((p) => cleanPath === p || cleanPath.startsWith(p));
        const isRoot =
          cleanPath === rootDir ||
          cleanPath.startsWith(rootDir + path.sep) ||
          cleanPath.startsWith(rootDir + '/');
        if (!isSystem && !isRoot) {
          throw new Error(`Command containment violation: path '${cleanPath}' is outside workspace root`);
        }
      }
    }
  }

  const execCommandTool: ToolDefinition = {
    name: 'exec_command',
    description: 'Execute a shell command within the local workspace directory',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command string to execute' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds' },
      },
      required: ['command'],
    },
    handler: async (params) => {
      const cmdStr = params.command as string;
      validateCommandContainment(cmdStr);
      const timeout = typeof params.timeoutMs === 'number' ? params.timeoutMs : commandTimeoutMs;
      const { stdout, stderr } = await execAsync(cmdStr, {
        cwd: rootDir,
        timeout,
        maxBuffer: 5 * 1024 * 1024,
      });
      return { stdout, stderr, exitCode: 0 };
    },
  };

  return [readFileTool, writeFileTool, listFilesTool, execCommandTool];
}
