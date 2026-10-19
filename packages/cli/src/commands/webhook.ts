import { sendWebhook } from '../dogfood/webhook-sender.ts';
import type { CliParsedArgs, CommandContext } from '../types.ts';

export async function handleWebhookCommand(
  parsed: CliParsedArgs,
  context: CommandContext,
): Promise<number> {
  const { owner, name, io } = context;

  if (!parsed.url) {
    io.stderr('Error: missing --url for webhook command.');
    return 1;
  }
  if (!parsed.secret) {
    io.stderr('Error: missing --secret for webhook command.');
    return 1;
  }
  const eventType = parsed.event ?? 'pull_request';
  if (!owner || !name) {
    io.stderr('Error: missing --repo <owner/name> for webhook command.');
    return 1;
  }
  const payload = parsed.payload ?? parsed.eventFile;
  if (!payload) {
    io.stderr('Error: missing --payload <json_or_file> for webhook command.');
    return 1;
  }

  try {
    const result = await sendWebhook({
      url: parsed.url,
      owner,
      repo: name,
      secret: parsed.secret,
      event: eventType,
      payload,
      drain: parsed.drain,
      controlKey: parsed.controlKey,
      io,
    });
    return result.ok ? 0 : 1;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    io.stderr(`[factory-cloud webhook] Error: ${msg}`);
    return 1;
  }
}
