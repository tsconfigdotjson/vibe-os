import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { type MemoryLimits, parseSize } from "./memory.ts";

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

  /**
   * The colour an installed PWA paints its window chrome with.
   *
   * Configurable because it is the fastest way to tell two installed instances
   * apart. A laptop, a staging box and the real one all look identical in a
   * dock otherwise, and installing the wrong one is the kind of mistake you
   * only notice after typing into it.
   */
  themeColor: string;

  /** Where the WebSocket bridge points. Defaults to this machine's sshd. */
  sshHost: string;
  sshPort: number;
  /**
   * `host` or `host:port` to print in the ssh commands offered for popping a
   * terminal out to a real one.
   *
   * Unset is the common case and the good default: the host the browser used to
   * reach the desktop is almost always the host sshd answers on, and unlike
   * `sshHost` (`127.0.0.1`, where the bridge dials) it is something a person on
   * another machine can actually type. Set this when the two really do differ —
   * a reverse proxy in front of the web port, or sshd on a non-standard port.
   */
  sshAdvertise?: string;
  /** Unix user the browser logs in as, and the certificate principal. */
  user: string;

  stateDir: string;
  webRoot: string;
  /** Absolute path to the built web assets, or null if not built. */
  workspace: string;

  /** null disables the gate entirely (with a loud warning at startup). */
  token: string | null;
  /**
   * Names, beyond the ones the server works out for itself, that a request may
   * use to reach it when there is no token. See `hostAllowed` in auth.ts.
   */
  allowedHosts: string[];
  certTtlSeconds: number;
  /**
   * Keep each window in a dtach session so it survives a reload. Auto-detected
   * from whether dtach is installed, unless forced.
   */
  sessions: boolean;
  /**
   * The MemoryHigh and MemoryMax each window's scope gets unless its profile
   * says otherwise, and the MemorySwapMax every window gets. All null (`--no-memory-limit`) starts windows without a
   * scope at all.
   */
  memory: MemoryLimits;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** server/config.ts -> dist/web */
const DEFAULT_WEB_ROOT = path.resolve(HERE, "..", "dist", "web");

export const OPTION_SPEC = {
  port: { type: "string" as const },
  host: { type: "string" as const },
  domain: { type: "string" as const },
  "tls-port": { type: "string" as const },
  email: { type: "string" as const },
  "acme-staging": { type: "boolean" as const },
  "ssh-host": { type: "string" as const },
  "ssh-port": { type: "string" as const },
  "ssh-advertise": { type: "string" as const },
  user: { type: "string" as const },
  "state-dir": { type: "string" as const },
  "web-root": { type: "string" as const },
  workspace: { type: "string" as const },
  token: { type: "string" as const },
  "no-token": { type: "boolean" as const },
  "allowed-host": { type: "string" as const, multiple: true },
  "cert-ttl": { type: "string" as const },
  "theme-color": { type: "string" as const },
  sessions: { type: "boolean" as const },
  "no-sessions": { type: "boolean" as const },
  "memory-high": { type: "string" as const },
  "memory-max": { type: "string" as const },
  "memory-swap-max": { type: "string" as const },
  "no-memory-limit": { type: "boolean" as const },
  // doctor only, same reasoning as the install-browser block below: parseArgs
  // is strict, so a flag it has never heard of is an error.
  reap: { type: "boolean" as const },
  // setup only, for the same reason.
  yes: { type: "boolean" as const, short: "y" },
  firewall: { type: "boolean" as const },
  hermes: { type: "boolean" as const },
  cursor: { type: "boolean" as const },
  // install-browser only. Kept here because parseArgs is strict, and a flag it
  // has never heard of is an error rather than something a subcommand can read.
  geometry: { type: "string" as const },
  display: { type: "string" as const },
  "vnc-port": { type: "string" as const },
  "cdp-port": { type: "string" as const },
  "restart-at": { type: "string" as const },
  "no-restart": { type: "boolean" as const },
  "vnc-password": { type: "string" as const },
  "no-vnc-password": { type: "boolean" as const },
  help: { type: "boolean" as const, short: "h" },
  version: { type: "boolean" as const, short: "v" },
};

export type RawOptions = Partial<
  Record<Exclude<keyof typeof OPTION_SPEC, "allowed-host">, string | boolean>
> & { "allowed-host"?: string[] };

/**
 * Flags that mean "generate one" when given no value.
 *
 * `--vnc-password` joins `--token` here for a reason beyond symmetry: a password
 * typed on a command line lands in shell history and in `ps`, so the bare form
 * that generates and prints one is the form worth reaching for.
 */
const OPTIONAL_VALUE_FLAGS = ["--token", "--vnc-password"];

/**
 * Makes a bare `--token` mean "generate one".
 *
 * That is what the help text has always promised — `--token [value]` — and what
 * the VPS instructions tell people to type, but `parseArgs` has no notion of an
 * optional value: a string option with nothing after it is an error, and the
 * error talks about ambiguity rather than saying what to do. Rewriting it to
 * `--token=` here is the whole fix, and it is done before parsing so everything
 * downstream still sees one shape.
 */
function allowBareToken(argv: string[]): string[] {
  return argv.map((arg, i) => {
    if (!OPTIONAL_VALUE_FLAGS.includes(arg)) return arg;
    const next = argv[i + 1];
    return next === undefined || next.startsWith("-") ? `${arg}=` : arg;
  });
}

export function parseCliArgs(argv: string[]): {
  values: RawOptions;
  positionals: string[];
} {
  const { values, positionals } = parseArgs({
    args: allowBareToken(argv),
    options: OPTION_SPEC,
    allowPositionals: true,
    strict: true,
  });
  return { values: values as RawOptions, positionals };
}

/**
 * The user this process runs as.
 *
 * Bun's `os.userInfo().username` comes from `$USER`, and reads "unknown" when
 * that is unset, which `docker exec`, cron and some `su` invocations all do.
 * `id` asks the passwd database for the real uid instead.
 */
async function currentUser(): Promise<string> {
  const name = os.userInfo().username;
  if (name && name !== "unknown") return name;
  try {
    const { stdout } = await run("id", ["-un"], { timeout: 5_000 });
    return stdout.trim() || name;
  } catch {
    return name;
  }
}

async function hasDtach(): Promise<boolean> {
  try {
    // dtach exits non-zero with no mode, so its usage text is the liveness
    // check; `--help` is not a flag it accepts either.
    await run("dtach", ["--help"], { timeout: 5_000 });
    return true;
  } catch (err) {
    return (
      (err as { stdout?: string })?.stdout?.includes("dtach - version") === true
    );
  }
}

/**
 * A CSS hex colour, which is all the manifest and the meta tag accept.
 *
 * Validated rather than passed through: it lands in a JSON document and in an
 * HTML attribute, and "whatever the operator typed" is not something either
 * should be asked to carry.
 */
/**
 * A neutral slate, deliberately not the cyan accent.
 *
 * The accent already means "this is the thing you are pointing at" inside the
 * app; reusing it for the window chrome would make the chrome look active.
 */
const DEFAULT_THEME = "#1c2128";

function hexColour(value: unknown, label: string): string {
  const colour = String(value).trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(colour))
    throw new Error(`invalid --${label}: ${colour} is not a #rrggbb colour`);
  return colour.toLowerCase();
}

/**
 * A Unix username, as `ssh-keygen -n` will read it.
 *
 * That flag takes a comma-separated *list*, so `--user vibe,root` would quietly
 * mint certificates valid for root as well. Operator-supplied rather than
 * attacker-supplied, so this is a footgun rather than a hole — but the check is
 * one line, and the same value is interpolated into doctor's `-C user=…` spec,
 * where a comma corrupts the connection string too.
 */
function userName(value: unknown, label: string): string {
  const name = String(value);
  if (!/^[a-z_][a-z0-9_-]*\$?$/.test(name))
    throw new Error(`invalid --${label}: ${name}`);
  return name;
}

/**
 * Defaults that leave room for one runaway on a small box and change nothing
 * on a large one: on 4 GB a window is throttled at 1.6 GB and killed at 2 GB.
 */
export const DEFAULT_MEMORY_HIGH = "40%";
export const DEFAULT_MEMORY_MAX = "50%";
/** Of RAM, as systemd reads it: about 400 MB of swap per window on 4 GB. */
export const DEFAULT_MEMORY_SWAP_MAX = "10%";

function memoryLimits(values: RawOptions): MemoryLimits {
  if (flag(values["no-memory-limit"] ?? process.env.VIBE_OS_NO_MEMORY_LIMIT))
    return { high: null, max: null, swapMax: null };
  return {
    high: parseSize(
      values["memory-high"] ??
        process.env.VIBE_OS_MEMORY_HIGH ??
        DEFAULT_MEMORY_HIGH,
      "--memory-high",
    ),
    max: parseSize(
      values["memory-max"] ??
        process.env.VIBE_OS_MEMORY_MAX ??
        DEFAULT_MEMORY_MAX,
      "--memory-max",
    ),
    swapMax: parseSize(
      values["memory-swap-max"] ??
        process.env.VIBE_OS_MEMORY_SWAP_MAX ??
        DEFAULT_MEMORY_SWAP_MAX,
      "--memory-swap-max",
    ),
  };
}

function num(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  // `Number("")` is 0, which used to pass this guard and make Bun bind a random
  // ephemeral port — while the banner printed that port as the URL. Fractions
  // and out-of-range values were accepted just as quietly.
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`invalid --${label}: ${String(value)}`);
  return n;
}

/** Ports specifically: the same rules, plus the range one can actually bind. */
function port_(value: unknown, fallback: number, label: string): number {
  const n = num(value, fallback, label);
  if (n < 1 || n > 65535)
    throw new Error(`invalid --${label}: ${String(value)} is not a port`);
  return n;
}

/**
 * A boolean from a flag or an environment variable.
 *
 * `Boolean(x)` is wrong for the environment half: every non-empty string is
 * true, so `VIBE_OS_ACME_STAGING=0` and `=false` both turned staging *on* —
 * which quietly points certificate issuance at Let's Encrypt's staging CA and
 * produces a certificate no browser trusts.
 */
function flag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return false;
  const v = String(value).trim().toLowerCase();
  return !(v === "" || v === "0" || v === "false" || v === "no" || v === "off");
}

interface PersistedConfig {
  token?: string | null;
  [key: string]: unknown;
}

export async function loadPersisted(
  stateDir: string,
): Promise<PersistedConfig> {
  try {
    return JSON.parse(
      await readFile(path.join(stateDir, "config.json"), "utf8"),
    ) as PersistedConfig;
  } catch {
    return {};
  }
}

export async function savePersisted(
  stateDir: string,
  patch: PersistedConfig,
): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const current = await loadPersisted(stateDir);
  await writeFile(
    path.join(stateDir, "config.json"),
    `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
}

export async function resolveConfig(values: RawOptions): Promise<Config> {
  const stateDir = String(
    values["state-dir"] ??
      process.env.VIBE_OS_STATE_DIR ??
      path.join(os.homedir(), ".vibe-os"),
  );
  const persisted = await loadPersisted(stateDir);

  // A token unless told otherwise: --no-token, or VIBE_OS_NO_TOKEN for the
  // container. Given none, the one from the last run, or a new one.
  let token: string | null;
  if (flag(values["no-token"] ?? process.env.VIBE_OS_NO_TOKEN)) {
    token = null;
  } else if (typeof values.token === "string" && values.token.length > 0) {
    token = values.token;
  } else if (process.env.VIBE_OS_TOKEN) {
    token = process.env.VIBE_OS_TOKEN;
  } else {
    token = persisted.token ?? randomBytes(24).toString("base64url");
  }

  const allowedHosts = [
    ...(values["allowed-host"] ?? []),
    ...(process.env.VIBE_OS_ALLOWED_HOSTS?.split(",") ?? []),
  ]
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  const sessions = values["no-sessions"]
    ? false
    : values.sessions
      ? true
      : await hasDtach();

  return {
    port: port_(values.port ?? process.env.VIBE_OS_PORT, 80, "port"),
    host: String(values.host ?? process.env.VIBE_OS_HOST ?? "0.0.0.0"),
    domain:
      (values.domain as string) ?? process.env.VIBE_OS_DOMAIN ?? undefined,
    tlsPort: port_(
      values["tls-port"] ?? process.env.VIBE_OS_TLS_PORT,
      443,
      "tls-port",
    ),
    acmeEmail:
      (values.email as string) ?? process.env.VIBE_OS_ACME_EMAIL ?? undefined,
    acmeStaging: flag(
      values["acme-staging"] ?? process.env.VIBE_OS_ACME_STAGING,
    ),
    themeColor: hexColour(
      values["theme-color"] ?? process.env.VIBE_OS_THEME_COLOR ?? DEFAULT_THEME,
      "theme-color",
    ),
    sshHost: String(
      values["ssh-host"] ?? process.env.VIBE_OS_SSH_HOST ?? "127.0.0.1",
    ),
    sshPort: port_(
      values["ssh-port"] ?? process.env.VIBE_OS_SSH_PORT,
      22,
      "ssh-port",
    ),
    sshAdvertise:
      (values["ssh-advertise"] as string) ??
      process.env.VIBE_OS_SSH_ADVERTISE ??
      undefined,
    user: userName(
      values.user ?? process.env.VIBE_OS_USER ?? (await currentUser()),
      "user",
    ),
    stateDir,
    webRoot: path.resolve(
      String(
        values["web-root"] ?? process.env.VIBE_OS_WEB_ROOT ?? DEFAULT_WEB_ROOT,
      ),
    ),
    workspace: path.resolve(
      String(
        values.workspace ??
          process.env.VIBE_OS_WORKSPACE ??
          path.join(os.homedir(), "workspace"),
      ),
    ),
    token,
    allowedHosts,
    certTtlSeconds: num(
      values["cert-ttl"] ?? process.env.VIBE_OS_CERT_TTL,
      12 * 60 * 60,
      "cert-ttl",
    ),
    sessions,
    memory: memoryLimits(values),
  };
}
