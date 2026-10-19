import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { AgentStudio, type AgentManifest, STANDARD_SINK_TYPES } from '@factory-cloud/sdk';
import { createLocalTools } from '../tools/local-tools.ts';
import type { CliParsedArgs, CommandContext } from '../types.ts';

export async function handleStudioCommand(
  parsed: CliParsedArgs,
  context: CommandContext,
): Promise<number> {
  const { cwd, owner, name, io } = context;
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
      availableSinks: [...STANDARD_SINK_TYPES],
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

  return 0;
}
