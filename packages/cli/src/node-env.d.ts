interface ProcessEnv {
  [key: string]: string | undefined;
}

interface Process {
  env: ProcessEnv;
  cwd(): string;
  exit(code?: number): never;
  argv: string[];
  on?(event: string, listener: (...args: any[]) => void): this;
  once?(event: string, listener: (...args: any[]) => void): this;
  off?(event: string, listener: (...args: any[]) => void): this;
}

declare var process: Process;

declare module 'node:path' {
  export const sep: string;
  export function resolve(...paths: string[]): string;
  export function join(...paths: string[]): string;
  export function dirname(p: string): string;
  export function basename(p: string): string;
}

declare module 'node:fs/promises' {
  export interface Dirent {
    name: string;
    isFile(): boolean;
    isDirectory(): boolean;
  }
  export interface Stats {
    size: number;
    isDirectory(): boolean;
    isFile(): boolean;
  }
  export function stat(path: string): Promise<Stats>;
  export function realpath(path: string): Promise<string>;
  export function readFile(path: string, encoding: string): Promise<string>;
  export function writeFile(path: string, data: string, encoding: string): Promise<void>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function symlink(target: string, path: string): Promise<void>;
}

declare module 'node:child_process' {
  export function exec(
    command: string,
    options: {
      cwd?: string;
      timeout?: number;
      maxBuffer?: number;
      env?: Record<string, string | undefined>;
    },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ): void;
}

declare module 'node:util' {
  export function promisify(fn: any): (...args: any[]) => Promise<{ stdout: string; stderr: string }>;
}

declare module 'node:os' {
  export function tmpdir(): string;
}
