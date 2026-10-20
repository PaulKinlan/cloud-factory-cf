import { runPrReview } from '../dogfood/pr-reviewer.ts';
import type { CliParsedArgs, CommandContext } from '../types.ts';

export async function handleReviewCommand(
  parsed: CliParsedArgs,
  context: CommandContext,
): Promise<number> {
  const { cwd, owner, name, io } = context;

  try {
    io.stdout(`[factory-cloud review] Starting PR review analysis in ${cwd}...`);
    // Only an explicit --repo may pin the review target. The CLI's local/local-repo
    // default exists for offline use, and passing it here is how a real pull request
    // came to be reviewed against a repository that does not exist
    // (cloud-factory-cf-n2h0): the event paints the target otherwise.
    const explicitRepo = parsed.repo && owner && name ? { owner, name } : undefined;
    const result = await runPrReview({
      cwd,
      repo: explicitRepo,
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
