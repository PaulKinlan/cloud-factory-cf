export interface CliParsedArgs {
  command: 'run' | 'worker' | 'studio' | 'review' | 'webhook' | 'audit' | 'help' | 'version';
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
  prNumber?: number;
  commitSha?: string;
  token?: string;
  dryRun?: boolean;
  strict?: boolean;
  url?: string;
  secret?: string;
  event?: string;
  payload?: string;
  drain?: boolean;
  controlKey?: string;
  deliveryId?: string;
  status?: string;
  json?: boolean;
}

export interface CliIo {
  stdout: (msg: string) => void;
  stderr: (msg: string) => void;
}

export interface CommandContext {
  cwd: string;
  owner?: string;
  name?: string;
  io: CliIo;
}
