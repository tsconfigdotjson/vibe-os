import { parseArgs } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const run = promisify(execFile);

export interface Config {
  /** Port for plain HTTP. Also serves ACME challenges when a domain is set. */
  port: number;
  host: string;
  /** When set, provisions a Let's Encrypt certificate and serves HTTPS too. */
  domain?: string;
  tlsPort: number;
  acmeEmail?: string;
  acmeStaging: boolean;

  /** Where the WebSocket bridge points. Defaults to this machine's sshd. */
  sshHost: string;
  sshPort: number;
  /** Unix user the browser logs in as, and the certificate principal. */
  user: string;

  stateDir: string;
  webRoot: string;
  /** Absolute path to the built web assets, or null if not built. */
  workspace: string;

  /** null disables the gate entirely (with a loud warning at startup). */
  token: string | null;
  certTtlSeconds: number;
  /** Wrap each pane in `tmux new-session -A`. Auto-detected unless forced. */
  tmux: boolean;
  /** Restyle the tmux status bar to match the desktop. Session-scoped. */
  tmuxTheme: boolean;
  /** Show tmux's own status bar inside each window. */
  tmuxStatus: boolean;

  open: boolean;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** server/config.ts -> dist/web */
const DEFAULT_WEB_ROOT = path.resolve(HERE, '..', 'dist', 'web');

export const OPTION_SPEC = {
  port: { type: 'string' as const },
  host: { type: 'string' as const },
  domain: { type: 'string' as const },
  'tls-port': { type: 'string' as const },
  email: { type: 'string' as const },
  'acme-staging': { type: 'boolean' as const },
  'ssh-host': { type: 'string' as const },
  'ssh-port': { type: 'string' as const },
  user: { type: 'string' as const },
  'state-dir': { type: 'string' as const },
  'web-root': { type: 'string' as const },
  workspace: { type: 'string' as const },
  token: { type: 'string' as const },
  'no-token': { type: 'boolean' as const },
  'cert-ttl': { type: 'string' as const },
  tmux: { type: 'boolean' as const },
  'no-tmux': { type: 'boolean' as const },
  'no-tmux-theme': { type: 'boolean' as const },
  'tmux-status': { type: 'boolean' as const },
  open: { type: 'boolean' as const },
  help: { type: 'boolean' as const, short: 'h' },
  version: { type: 'boolean' as const, short: 'v' },
};

export type RawOptions = Partial<Record<keyof typeof OPTION_SPEC, string | boolean>>;

export function parseCliArgs(argv: string[]): { values: RawOptions; positionals: string[] } {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTION_SPEC,
    allowPositionals: true,
    strict: true,
  });
  return { values: values as RawOptions, positionals };
}

async function hasTmux(): Promise<boolean> {
  try {
    await run('tmux', ['-V'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function num(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid --${label}: ${String(value)}`);
  return n;
}

interface PersistedConfig {
  token?: string | null;
  [key: string]: unknown;
}

export async function loadPersisted(stateDir: string): Promise<PersistedConfig> {
  try {
    return JSON.parse(await readFile(path.join(stateDir, 'config.json'), 'utf8')) as PersistedConfig;
  } catch {
    return {};
  }
}

export async function savePersisted(stateDir: string, patch: PersistedConfig): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const current = await loadPersisted(stateDir);
  await writeFile(path.join(stateDir, 'config.json'), `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function resolveConfig(values: RawOptions): Promise<Config> {
  const stateDir = String(values['state-dir'] ?? process.env.VIBE_OS_STATE_DIR ?? path.join(os.homedir(), '.vibe-os'));
  const persisted = await loadPersisted(stateDir);

  // --token with no value means "generate one"; --no-token means "no gate".
  let token: string | null;
  if (values['no-token']) {
    token = null;
  } else if (typeof values.token === 'string' && values.token.length > 0) {
    token = values.token;
  } else if (process.env.VIBE_OS_TOKEN) {
    token = process.env.VIBE_OS_TOKEN;
  } else if (values.token === '' || values.token === true) {
    token = persisted.token ?? randomBytes(24).toString('base64url');
  } else {
    token = persisted.token ?? null;
  }

  const tmux = values['no-tmux'] ? false : values.tmux ? true : await hasTmux();

  return {
    port: num(values.port ?? process.env.VIBE_OS_PORT, 80, 'port'),
    host: String(values.host ?? process.env.VIBE_OS_HOST ?? '0.0.0.0'),
    domain: (values.domain as string) ?? process.env.VIBE_OS_DOMAIN ?? undefined,
    tlsPort: num(values['tls-port'], 443, 'tls-port'),
    acmeEmail: (values.email as string) ?? process.env.VIBE_OS_ACME_EMAIL ?? undefined,
    acmeStaging: Boolean(values['acme-staging'] ?? process.env.VIBE_OS_ACME_STAGING),
    sshHost: String(values['ssh-host'] ?? process.env.VIBE_OS_SSH_HOST ?? '127.0.0.1'),
    sshPort: num(values['ssh-port'] ?? process.env.VIBE_OS_SSH_PORT, 22, 'ssh-port'),
    user: String(values.user ?? process.env.VIBE_OS_USER ?? os.userInfo().username),
    stateDir,
    webRoot: path.resolve(String(values['web-root'] ?? process.env.VIBE_OS_WEB_ROOT ?? DEFAULT_WEB_ROOT)),
    workspace: path.resolve(String(values.workspace ?? process.env.VIBE_OS_WORKSPACE ?? path.join(os.homedir(), 'workspace'))),
    token,
    certTtlSeconds: num(values['cert-ttl'], 12 * 60 * 60, 'cert-ttl'),
    tmux,
    tmuxTheme: !values['no-tmux-theme'],
    tmuxStatus: Boolean(values['tmux-status']),
    open: Boolean(values.open),
  };
}
