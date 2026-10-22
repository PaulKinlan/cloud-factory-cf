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
  sandbox?: 'bwrap' | 'none';
  sandboxNetwork?: 'host' | 'none';
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
    if (/[><]/.test(cmd)) {
      throw new Error("Command containment violation: shell redirection ('>', '<') is not permitted; use write_file/read_file");
    }

    if (/[\$`]/.test(cmd)) {
      throw new Error("Command containment violation: shell variable expansion ('$') and command substitution ('`') are not permitted");
    }

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

  function escapeArg(arg: string): string {
    return "'" + arg.replace(/'/g, "'\\''") + "'";
  }

  const execCommandTool: ToolDefinition = {
    name: 'exec_command',
    description:
      'Execute a shell command within the local workspace directory. Under sandbox mode (default: bubblewrap), confines the filesystem to the workspace and isolates network namespaces (sandboxNetwork: "host" | "none"). When sandboxNetwork is "none", network namespaces are unshared (--unshare-net blocking IP/loopback/metadata egress) and pre-existing host Unix domain sockets within the workspace are masked with /dev/null.',
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
      const timeout = typeof params.timeoutMs === 'number' ? params.timeoutMs : commandTimeoutMs;
      const realRoot = await fs.realpath(rootDir).catch(() => rootDir);
      const sandboxMode = options.sandbox ?? 'bwrap';
      const networkMode = options.sandboxNetwork ?? 'host';

      if (sandboxMode === 'bwrap') {
        const hasBwrap = await fs
          .stat('/usr/bin/bwrap')
          .then(() => true)
          .catch(() => false);

        if (!hasBwrap) {
          throw new Error(
            'Sandbox unavailable: bubblewrap (/usr/bin/bwrap) is required for exec_command isolation but is not installed on this system. Failing closed to prevent unisolated command execution.',
          );
        }

        const bwrapArgs: string[] = [
          '/usr/bin/bwrap',
          '--unshare-pid',
          '--die-with-parent',
          '--ro-bind',
          '/usr',
          '/usr',
          '--symlink',
          'usr/bin',
          '/bin',
          '--symlink',
          'usr/lib',
          '/lib',
          '--symlink',
          'usr/lib64',
          '/lib64',
          '--dev',
          '/dev',
          '--proc',
          '/proc',
          '--tmpfs',
          '/tmp',
          '--tmpfs',
          '/home',
        ];

        if (networkMode === 'none') {
          bwrapArgs.push('--unshare-net');
        }

        // Read-only mount ONLY the node executable itself rather than its parent directory (fixes cloud-factory-cf-buy)
        const realExec = await fs.realpath(process.execPath).catch(() => process.execPath);
        bwrapArgs.push('--ro-bind', realExec, realExec);
        if (realExec !== process.execPath) {
          bwrapArgs.push('--ro-bind', process.execPath, process.execPath);
        }

        // Mount DNS/SSL configuration read-only if present and network is enabled
        if (networkMode !== 'none') {
          const hasEtcResolv = await fs
            .stat('/etc/resolv.conf')
            .then(() => true)
            .catch(() => false);
          if (hasEtcResolv) {
            bwrapArgs.push('--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf');
          }
          const hasEtcSsl = await fs
            .stat('/etc/ssl')
            .then(() => true)
            .catch(() => false);
          if (hasEtcSsl) {
            bwrapArgs.push('--ro-bind', '/etc/ssl', '/etc/ssl');
          }
        }

        // Mount workspace root read-write only
        bwrapArgs.push('--bind', realRoot, realRoot);

        // When network isolation is requested, mask any pre-existing host Unix domain sockets within the workspace (fixes cloud-factory-cf-5vuu)
        if (networkMode === 'none') {
          const scanSockets = async (dir: string): Promise<string[]> => {
            const found: string[] = [];
            const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              if (entry.isSocket()) {
                found.push(fullPath);
              } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
                const sub = await scanSockets(fullPath);
                found.push(...sub);
              }
            }
            return found;
          };
          const hostSockets = await scanSockets(realRoot);
          for (const sock of hostSockets) {
            bwrapArgs.push('--ro-bind', '/dev/null', sock);
          }
        }

        bwrapArgs.push('--chdir', realRoot);
        bwrapArgs.push('--', '/bin/sh', '-c', cmdStr);

        const bwrapCmd = bwrapArgs.map((arg) => escapeArg(arg)).join(' ');
        const { stdout, stderr } = await execAsync(bwrapCmd, {
          cwd: realRoot,
          timeout,
          maxBuffer: 5 * 1024 * 1024,
          env: {
            PATH: process.env.PATH ?? '/bin:/usr/bin',
            HOME: realRoot,
            TMPDIR: realRoot,
            TEMP: realRoot,
            TMP: realRoot,
          },
        });
        return { stdout, stderr, exitCode: 0 };
      }

      // Unsandboxed mode (requires explicit sandbox: 'none' opt-out)
      validateCommandContainment(cmdStr);
      const { stdout, stderr } = await execAsync(cmdStr, {
        cwd: realRoot,
        timeout,
        maxBuffer: 5 * 1024 * 1024,
        env: {
          PATH: process.env.PATH ?? '/bin:/usr/bin',
          HOME: realRoot,
          TMPDIR: realRoot,
          TEMP: realRoot,
          TMP: realRoot,
        },
      });
      return { stdout, stderr, exitCode: 0 };
    },
  };

  return [readFileTool, writeFileTool, listFilesTool, execCommandTool];
}
