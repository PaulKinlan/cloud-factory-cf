import { LocalAgentRunner } from '../runner/local-runner.ts';
import { QueueWorker } from '../worker/queue-worker.ts';
import type { CliParsedArgs, CommandContext } from '../types.ts';

export async function handleWorkerCommand(
  parsed: CliParsedArgs,
  context: CommandContext,
): Promise<number> {
  const { cwd, owner, name, io } = context;
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
