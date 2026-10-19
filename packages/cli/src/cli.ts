import * as path from 'node:path';
import { LocalAgentRunner } from './runner/local-runner.ts';
import { QueueWorker } from './worker/queue-worker.ts';

export interface CliParsedArgs {
  command: 'run' | 'worker' | 'help' | 'version';
  prompt?: string;
  cwd?: string;
  repo?: string;
  coordinator?: string;
  limit?: number;
  interval?: number;
  extensions?: string[];
  once?: boolean;
}

export function parseArgs(args: readonly string[]): CliParsedArgs {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    return { command: 'help' };
  }

  if (args.includes('--version') || args.includes('-v')) {
    return { command: 'version' };
  }

  const first = args[0];
  if (!first) {
    return { command: 'help' };
  }
  const rest = args.slice(1);
  let command: 'run' | 'worker' | 'help' = 'run';
  let remaining = rest;

  if (first === 'run') {
    command = 'run';
  } else if (first === 'worker' || first === 'poll') {
    command = 'worker';
  } else if (first === 'help') {
    return { command: 'help' };
  } else if (first === 'version') {
    return { command: 'version' };
  } else {
    // Treat first argument as prompt if not recognized as subcommand
    remaining = [first, ...rest];
    command = 'run';
  }

  let prompt: string | undefined;
  let cwd: string | undefined;
  let repo: string | undefined;
  let coordinator: string | undefined;
  let limit: number | undefined;
  let interval: number | undefined;
  let once: boolean | undefined;
  const extensions: string[] = [];

  for (let i = 0; i < remaining.length; i++) {
    const arg = remaining[i]!;
    if (arg === '--prompt' && i + 1 < remaining.length) {
      prompt = remaining[++i];
    } else if (arg === '--cwd' && i + 1 < remaining.length) {
      cwd = remaining[++i];
    } else if (arg === '--repo' && i + 1 < remaining.length) {
      repo = remaining[++i];
    } else if (arg === '--coordinator' && i + 1 < remaining.length) {
      coordinator = remaining[++i];
    } else if (arg === '--limit' && i + 1 < remaining.length) {
      limit = Number.parseInt(remaining[++i]!, 10);
    } else if (arg === '--interval' && i + 1 < remaining.length) {
      interval = Number.parseInt(remaining[++i]!, 10);
    } else if (arg === '--extension' && i + 1 < remaining.length) {
      extensions.push(remaining[++i]!);
    } else if (arg === '--once') {
      once = true;
    } else if (!arg.startsWith('-') && !prompt) {
      prompt = arg;
    }
  }

  return {
    command,
    prompt,
    cwd,
    repo,
    coordinator,
    limit,
    interval,
    extensions,
    once,
  };
}

export function printHelp(): string {
  return `factory-cloud - Cloud Factory CF Dual-Runtime CLI

USAGE:
  factory-cloud run [prompt] [options]       Execute an agent run locally
  factory-cloud worker [options]             Run a local queue worker polling RepoCoordinator
  factory-cloud --help                       Show this help message
  factory-cloud --version                    Show version

OPTIONS:
  --cwd <dir>            Local workspace root directory (default: current directory)
  --repo <owner/name>    Repository identifier (e.g. PaulKinlan/cloud-factory-cf)
  --coordinator <url>    Coordinator Durable Object URL (default: http://localhost:8787)
  --limit <n>            Maximum events to claim per batch (default: 5)
  --interval <ms>        Poll interval in milliseconds when idle (default: 1000)
  --once                 Process a single batch and exit (worker command)
  --extension <path>     Path to extension module to load
`;
}

export async function runCli(
  args: readonly string[],
  io: { stdout: (msg: string) => void; stderr: (msg: string) => void } = {
    stdout: console.log,
    stderr: console.error,
  },
): Promise<number> {
  const parsed = parseArgs(args);

  if (parsed.command === 'help') {
    io.stdout(printHelp());
    return 0;
  }

  if (parsed.command === 'version') {
    io.stdout('factory-cloud 0.1.0');
    return 0;
  }

  const cwd = path.resolve(parsed.cwd ?? process.cwd());
  const [owner, name] = parsed.repo ? parsed.repo.split('/') : ['local', 'local-repo'];

  if (parsed.command === 'run') {
    if (!parsed.prompt) {
      io.stderr('Error: missing prompt for run command. Use factory-cloud run "<prompt>".');
      return 1;
    }

    const loadedExtensions = [];
    for (const extPath of parsed.extensions ?? []) {
      try {
        const fullPath = path.resolve(cwd, extPath);
        const mod = (await import(fullPath)) as Record<string, unknown>;
        const ext = mod['default'] ?? mod;
        if (typeof ext === 'function') {
          loadedExtensions.push(ext as any);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        io.stderr(`[factory-cloud] Failed to load extension from ${extPath}: ${msg}`);
        return 1;
      }
    }

    const runner = new LocalAgentRunner({
      cwd,
      repo: { owner: owner ?? 'local', name: name ?? 'local-repo' },
      extensions: loadedExtensions,
    });

    try {
      io.stdout(`[factory-cloud] Starting local agent execution in ${cwd}...`);
      const summary = await runner.run(parsed.prompt);
      if (summary.status !== 'success') {
        io.stderr(`[factory-cloud] Execution failed: ${summary.error ?? 'unknown error'}`);
        return 1;
      }
      io.stdout(`[factory-cloud] Execution completed in ${summary.durationMs}ms`);
      if (summary.output) {
        io.stdout(`[factory-cloud] Output: ${JSON.stringify(summary.output)}`);
      }
      return 0;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      io.stderr(`[factory-cloud] Error executing agent: ${msg}`);
      return 1;
    }
  }

  if (parsed.command === 'worker') {
    const coordinatorUrl = parsed.coordinator ?? 'http://localhost:8787';
    const runner = new LocalAgentRunner({
      cwd,
      repo: { owner: owner ?? 'local', name: name ?? 'local-repo' },
    });

    const worker = new QueueWorker({
      coordinatorUrl,
      runner,
      limit: parsed.limit,
      pollIntervalMs: parsed.interval,
    });

    if (parsed.once) {
      io.stdout(`[factory-cloud] Processing single batch from ${coordinatorUrl}...`);
      const batch = await worker.processNextBatch();
      io.stdout(
        `[factory-cloud] Processed batch: ${batch.claimedCount} claimed, ${batch.successCount} succeeded, ${batch.failCount} failed.`,
      );
      return batch.failCount > 0 ? 1 : 0;
    }

    io.stdout(`[factory-cloud] Starting queue worker daemon polling ${coordinatorUrl}...`);
    const ac = new AbortController();
    const handleSignal = () => {
      io.stdout('[factory-cloud] Stopping queue worker...');
      worker.stop();
      ac.abort();
    };

    if (typeof process !== 'undefined' && process.once) {
      process.once('SIGINT', handleSignal);
      process.once('SIGTERM', handleSignal);
    }

    try {
      await worker.start(ac.signal);
      return 0;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      io.stderr(`[factory-cloud] Worker error: ${msg}`);
      return 1;
    } finally {
      if (typeof process !== 'undefined' && process.off) {
        process.off('SIGINT', handleSignal);
        process.off('SIGTERM', handleSignal);
      }
    }
  }

  return 0;
}
