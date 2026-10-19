import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { AgentStudio, type AgentManifest } from '@factory-cloud/sdk';
import { LocalAgentRunner } from './runner/local-runner.ts';
import { QueueWorker } from './worker/queue-worker.ts';
import { createLocalTools } from './tools/local-tools.ts';

export interface CliParsedArgs {
  command: 'run' | 'worker' | 'studio' | 'help' | 'version';
  studioAction?: 'author' | 'test' | 'list';
  prompt?: string;
  cwd?: string;
  repo?: string;
  coordinator?: string;
  limit?: number;
  interval?: number;
  extensions?: string[];
  once?: boolean;
  manifestPath?: string;
  eventFile?: string;
  outPath?: string;
  install?: boolean;
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
  let command: 'run' | 'worker' | 'studio' | 'help' | 'version' = 'run';
  let studioAction: 'author' | 'test' | 'list' | undefined;
  let remaining = rest;

  if (first === 'run') {
    command = 'run';
  } else if (first === 'worker' || first === 'poll') {
    command = 'worker';
  } else if (first === 'studio') {
    command = 'studio';
    if (rest.length > 0 && !rest[0]!.startsWith('-')) {
      const sub = rest[0]!.toLowerCase();
      if (sub === 'author' || sub === 'test' || sub === 'list') {
        studioAction = sub;
        remaining = rest.slice(1);
      }
    }
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
  let manifestPath: string | undefined;
  let eventFile: string | undefined;
  let outPath: string | undefined;
  let install: boolean | undefined;
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
    } else if (arg === '--manifest' && i + 1 < remaining.length) {
      manifestPath = remaining[++i];
    } else if (arg === '--event' && i + 1 < remaining.length) {
      eventFile = remaining[++i];
    } else if (arg === '--out' && i + 1 < remaining.length) {
      outPath = remaining[++i];
    } else if (arg === '--install') {
      install = true;
    } else if (!arg.startsWith('-')) {
      if (command === 'studio' && studioAction === 'test' && !manifestPath) {
        manifestPath = arg;
      } else if (!prompt) {
        prompt = arg;
      }
    }
  }

  return {
    command,
    studioAction,
    prompt,
    cwd,
    repo,
    coordinator,
    limit,
    interval,
    extensions,
    once,
    manifestPath,
    eventFile,
    outPath,
    install,
  };
}

export function printHelp(): string {
  return `factory-cloud - Cloud Factory CF Dual-Runtime CLI

USAGE:
  factory-cloud run [prompt] [options]       Execute an agent run locally
  factory-cloud worker [options]             Run a local queue worker polling RepoCoordinator
  factory-cloud studio author <prompt>       Synthesize agent manifest from natural language
  factory-cloud studio test <manifest.json>  Simulate agent execution in test harness
  factory-cloud studio list [options]        List installed agents
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
  --manifest <path>      Path to agent manifest file (studio test)
  --event <path>         Path to event payload JSON file (studio test)
  --out <path>           Output file path for authored manifest (studio author)
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

  if (parsed.command === 'studio') {
    const studio = new AgentStudio();
    const action = parsed.studioAction ?? 'author';

    const defaultCliPermissions = [
      { service: 'github', action: 'repo.read' },
      { service: 'github', action: 'issue.comment' },
      { service: 'github', action: 'pr.comment' },
      { service: 'github', action: 'pr.review' },
      { service: 'gitlab', action: 'project.read' },
      { service: 'gitlab', action: 'mr.comment' },
    ];

    if (action === 'author') {
      if (!parsed.prompt) {
        io.stderr(
          'Error: missing prompt for studio author. Usage: factory-cloud studio author "<prompt>"',
        );
        return 1;
      }
      const localTools = createLocalTools({ cwd });
      io.stdout('[factory-cloud studio] Grounding prompt against control plane...');
      const manifest = await studio.author(parsed.prompt, {
        availableTools: localTools,
        availablePermissions: defaultCliPermissions,
        availableSinks: ['github-pr-review', 'github-issue', 'beads-task', 'cloud-telemetry'],
        repoContext: { owner: owner ?? 'local', repo: name ?? 'local-repo' },
      });

      const jsonStr = JSON.stringify(manifest, null, 2);
      if (parsed.outPath) {
        const outResolved = path.resolve(cwd, parsed.outPath);
        await fs.writeFile(outResolved, jsonStr, 'utf8');
        io.stdout(`[factory-cloud studio] Saved manifest to ${outResolved}`);
      } else {
        io.stdout(`[factory-cloud studio] Authored Agent Manifest:\n${jsonStr}`);
      }

      if (parsed.install) {
        const localAgentsDir = path.resolve(cwd, '.factory', 'agents');
        await fs.mkdir(localAgentsDir, { recursive: true });
        const installPath = path.join(localAgentsDir, `${manifest.name}.json`);
        await fs.writeFile(installPath, jsonStr, 'utf8');
        io.stdout(`[factory-cloud studio] Installed agent to ${installPath}`);
      }
      return 0;
    }

    if (action === 'test') {
      if (!parsed.manifestPath) {
        io.stderr(
          'Error: missing manifest path for studio test. Usage: factory-cloud studio test <manifest.json>',
        );
        return 1;
      }
      const manifestResolved = path.resolve(cwd, parsed.manifestPath);
      let manifest: AgentManifest;
      try {
        const raw = await fs.readFile(manifestResolved, 'utf8');
        manifest = JSON.parse(raw) as AgentManifest;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        io.stderr(`[factory-cloud studio] Failed to read manifest: ${msg}`);
        return 1;
      }

      if (!manifest || typeof manifest !== 'object') {
        io.stderr('[factory-cloud studio] Error: manifest must be a valid JSON object');
        return 1;
      }
      if (!manifest.name || typeof manifest.name !== 'string') {
        io.stderr('[factory-cloud studio] Error: manifest is missing required field "name"');
        return 1;
      }
      if (!manifest.prompt || typeof manifest.prompt !== 'string') {
        io.stderr('[factory-cloud studio] Error: manifest is missing required field "prompt"');
        return 1;
      }
      if (manifest.tools !== undefined && !Array.isArray(manifest.tools)) {
        io.stderr('[factory-cloud studio] Error: manifest field "tools" must be an array');
        return 1;
      }
      if (Array.isArray(manifest.tools)) {
        for (const tool of manifest.tools) {
          if (typeof tool !== 'string' || !tool) {
            io.stderr(
              '[factory-cloud studio] Error: manifest field "tools" must contain string tool names',
            );
            return 1;
          }
        }
      }
      if (manifest.capabilities !== undefined && !Array.isArray(manifest.capabilities)) {
        io.stderr(
          '[factory-cloud studio] Error: manifest field "capabilities" must be an array',
        );
        return 1;
      }
      if (Array.isArray(manifest.capabilities)) {
        for (const cap of manifest.capabilities) {
          if (
            !cap ||
            typeof cap !== 'object' ||
            typeof (cap as any).service !== 'string' ||
            !(cap as any).service ||
            typeof (cap as any).action !== 'string' ||
            !(cap as any).action
          ) {
            io.stderr(
              '[factory-cloud studio] Error: manifest field "capabilities" must contain objects with string service and action',
            );
            return 1;
          }
        }
      }
      if (manifest.sinks !== undefined && !Array.isArray(manifest.sinks)) {
        io.stderr('[factory-cloud studio] Error: manifest field "sinks" must be an array');
        return 1;
      }
      if (Array.isArray(manifest.sinks)) {
        for (const sink of manifest.sinks) {
          if (
            !sink ||
            typeof sink !== 'object' ||
            typeof (sink as any).type !== 'string' ||
            !(sink as any).type
          ) {
            io.stderr(
              '[factory-cloud studio] Error: manifest field "sinks" must contain objects with string type',
            );
            return 1;
          }
        }
      }
      if (manifest.triggers !== undefined && !Array.isArray(manifest.triggers)) {
        io.stderr(
          '[factory-cloud studio] Error: manifest field "triggers" must be an array',
        );
        return 1;
      }
      if (Array.isArray(manifest.triggers)) {
        for (const trigger of manifest.triggers) {
          if (
            !trigger ||
            typeof trigger !== 'object' ||
            typeof (trigger as any).event !== 'string' ||
            !(trigger as any).event
          ) {
            io.stderr(
              '[factory-cloud studio] Error: manifest field "triggers" must contain objects with string event',
            );
            return 1;
          }
        }
      }

      let event: Record<string, unknown> | undefined;
      if (parsed.eventFile) {
        try {
          const rawEvent = await fs.readFile(path.resolve(cwd, parsed.eventFile), 'utf8');
          event = JSON.parse(rawEvent) as Record<string, unknown>;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          io.stderr(`[factory-cloud studio] Failed to read event file: ${msg}`);
          return 1;
        }
      }

      const localTools = createLocalTools({ cwd });
      io.stdout(`[factory-cloud studio] Running test simulation for agent "${manifest.name}"...`);
      const result = await studio.simulate(
        {
          manifest,
          event: event ?? { type: 'test.simulated' },
          promptInput: parsed.prompt,
        },
        {
          tools: localTools,
          allowedCapabilities: defaultCliPermissions,
        },
      );

      io.stdout(
        `[factory-cloud studio] Simulation ${result.status} in ${result.durationMs}ms (tool calls: ${result.toolCalls.length}, sink actions: ${result.sinkActions.length})`,
      );
      if (result.error) {
        io.stderr(`[factory-cloud studio] Error: ${result.error}`);
      }
      return result.status === 'completed' ? 0 : 1;
    }

    if (action === 'list') {
      const agents: { name: string; version: string; description?: string; source: string }[] = [];

      // 1. Inspect local .factory/agents/ directory
      const localAgentsDir = path.resolve(cwd, '.factory', 'agents');
      try {
        const entries = await fs.readdir(localAgentsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith('.json')) {
            try {
              const content = await fs.readFile(path.join(localAgentsDir, entry.name), 'utf8');
              const parsedManifest = JSON.parse(content) as AgentManifest;
              if (parsedManifest.name) {
                agents.push({
                  name: parsedManifest.name,
                  version: parsedManifest.version || '0.1.0',
                  description: parsedManifest.description,
                  source: `local (.factory/agents/${entry.name})`,
                });
              }
            } catch {
              // ignore invalid files
            }
          }
        }
      } catch {
        // directory does not exist
      }

      // 2. Query coordinator if coordinator URL provided
      if (parsed.coordinator) {
        try {
          const res = await fetch(`${parsed.coordinator}/memory?prefix=agents:`, {
            signal: AbortSignal.timeout(2000),
          });
          if (res.ok) {
            const data = (await res.json()) as {
              ok: boolean;
              entries?: { key: string; value: unknown }[];
            };
            if (data.entries) {
              for (const entry of data.entries) {
                const val =
                  (entry.value as { manifest?: AgentManifest; value?: AgentManifest })?.manifest ??
                  (entry.value as { manifest?: AgentManifest; value?: AgentManifest })?.value ??
                  (entry.value as AgentManifest);
                if (val && typeof val === 'object' && 'name' in val) {
                  agents.push({
                    name: (val as AgentManifest).name,
                    version: (val as AgentManifest).version || '0.1.0',
                    description: (val as AgentManifest).description,
                    source: `coordinator (${parsed.coordinator})`,
                  });
                }
              }
            }
          }
        } catch {
          // coordinator not reachable
        }
      }

      io.stdout('[factory-cloud studio] Installed agents:');
      if (agents.length === 0) {
        io.stdout('  (none installed in local scope)');
      } else {
        for (const ag of agents) {
          io.stdout(
            `  - ${ag.name}@${ag.version} [${ag.source}]${ag.description ? `: ${ag.description}` : ''}`,
          );
        }
      }
      return 0;
    }
  }

  return 0;
}
