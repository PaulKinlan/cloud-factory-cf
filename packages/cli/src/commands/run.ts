import * as path from 'node:path';
import { LocalAgentRunner } from '../runner/local-runner.ts';
import type { CliParsedArgs, CommandContext } from '../types.ts';

export async function handleRunCommand(
  parsed: CliParsedArgs,
  context: CommandContext,
): Promise<number> {
  const { cwd, owner, name, io } = context;

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
