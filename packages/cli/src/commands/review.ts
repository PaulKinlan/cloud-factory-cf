import { runPrReview } from '../dogfood/pr-reviewer.ts';
import type { CliParsedArgs, CommandContext } from '../types.ts';

export async function handleReviewCommand(
  parsed: CliParsedArgs,
  context: CommandContext,
): Promise<number> {
  const { cwd, owner, name, io } = context;

  try {
    io.stdout(`[factory-cloud review] Starting PR review analysis in ${cwd}...`);
    const result = await runPrReview({
      cwd,
      repo: owner && name ? { owner, name } : undefined,
      prNumber: parsed.prNumber,
      commitSha: parsed.commitSha,
      eventFile: parsed.eventFile,
      githubToken: parsed.token,
      dryRun: parsed.dryRun,
      outPath: parsed.outPath,
      strict: parsed.strict,
      io,
    });

    io.stdout(`[factory-cloud review] Verdict: ${result.verdict} (${result.findings.length} finding(s))`);
    if (parsed.strict && (result.verdict !== 'APPROVE' || result.findings.length > 0)) {
      return 1;
    }
    return 0;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    io.stderr(`[factory-cloud review] Error during PR review: ${msg}`);
    return 1;
  }
}
