import * as path from 'node:path';
import type { CliParsedArgs, CliIo, CommandContext } from './types.ts';
import {
  handleRunCommand,
  handleWorkerCommand,
  handleStudioCommand,
  handleReviewCommand,
  handleWebhookCommand,
} from './commands/index.ts';

export type { CliParsedArgs, CliIo, CommandContext };

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
  let command: 'run' | 'worker' | 'studio' | 'review' | 'webhook' | 'help' | 'version' = 'run';
  let studioAction: 'author' | 'test' | 'list' | undefined;
  let remaining = rest;

  if (first === 'run') {
    command = 'run';
  } else if (first === 'worker' || first === 'poll') {
    command = 'worker';
  } else if (first === 'review') {
    command = 'review';
  } else if (first === 'webhook') {
    command = 'webhook';
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
  let prNumber: number | undefined;
  let commitSha: string | undefined;
  let token: string | undefined;
  let dryRun: boolean | undefined;
  let strict: boolean | undefined;
  let url: string | undefined;
  let secret: string | undefined;
  let event: string | undefined;
  let payload: string | undefined;
  let drain: boolean | undefined;
  let controlKey: string | undefined;
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
    } else if (arg === '--event-file' && i + 1 < remaining.length) {
      eventFile = remaining[++i];
    } else if (arg === '--event-type' && i + 1 < remaining.length) {
      event = remaining[++i];
    } else if (arg === '--event' && i + 1 < remaining.length) {
      if (command === 'webhook') {
        event = remaining[++i];
      } else {
        eventFile = remaining[++i];
      }
    } else if (arg === '--out' && i + 1 < remaining.length) {
      outPath = remaining[++i];
    } else if (arg === '--install') {
      install = true;
    } else if (arg === '--pr' && i + 1 < remaining.length) {
      prNumber = Number.parseInt(remaining[++i]!, 10);
    } else if (arg === '--commit' && i + 1 < remaining.length) {
      commitSha = remaining[++i];
    } else if (arg === '--token' && i + 1 < remaining.length) {
      token = remaining[++i];
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--strict') {
      strict = true;
    } else if (arg === '--url' && i + 1 < remaining.length) {
      url = remaining[++i];
    } else if (arg === '--secret' && i + 1 < remaining.length) {
      secret = remaining[++i];
    } else if (arg === '--payload' && i + 1 < remaining.length) {
      payload = remaining[++i];
    } else if (arg === '--drain') {
      drain = true;
    } else if (arg === '--control-key' && i + 1 < remaining.length) {
      controlKey = remaining[++i];
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
    prNumber,
    commitSha,
    token,
    dryRun,
    strict,
    url,
    secret,
    event,
    payload,
    drain,
    controlKey,
  };
}

export function printHelp(): string {
  return `factory-cloud - Cloud Factory CF Dual-Runtime CLI

USAGE:
  factory-cloud run [prompt] [options]       Execute an agent run locally
  factory-cloud worker [options]             Run a local queue worker polling RepoCoordinator
  factory-cloud review [options]             Self-hosted PR reviewer agent (dogfooding)
  factory-cloud webhook [options]            Dispatch signed GitHub webhook to Worker & drain
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
  --event <path>         Path to event payload JSON file (studio test / review)
  --out <path>           Output file path for authored manifest or review summary
  --pr <number>          Pull Request number for review command
  --commit <sha>         Commit SHA for review command
  --token <token>        GitHub personal access token for PR review
  --dry-run              Dry run mode (do not post PR review externally)
  --strict               Fail with exit 1 if review recommends changes
  --url <url>            Cloud Factory worker base URL (webhook command)
  --secret <secret>      HMAC secret for webhook verification
  --event-type <type>    GitHub event type (e.g. pull_request, push)
  --payload <json/file>  Webhook payload JSON string or file path
  --drain                Trigger queue drain after posting webhook
  --control-key <key>    Bearer control key for queue drain
`;
}

export async function runCli(
  args: readonly string[],
  io: CliIo = {
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
  const [owner, name] = parsed.repo
    ? parsed.repo.split('/')
    : ['local', 'local-repo'];

  const context: CommandContext = { cwd, owner, name, io };

  switch (parsed.command) {
    case 'run':
      return handleRunCommand(parsed, context);
    case 'worker':
      return handleWorkerCommand(parsed, context);
    case 'studio':
      return handleStudioCommand(parsed, context);
    case 'review':
      return handleReviewCommand(parsed, context);
    case 'webhook':
      return handleWebhookCommand(parsed, context);
    default:
      return 0;
  }
}
