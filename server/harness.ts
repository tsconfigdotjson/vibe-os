// The harnesses a profile can launch, and what each one can be told to do.
//
// A harness is an adapter in `harnesses/`: a spec (the command, the flags the
// editor offers, how to resume) plus optional code for discovery, session
// setup and doctor checks. Adding one is one file and one line in `BUILT_IN`.
//
// A box can add its own without a fork, as data: every
// `<state dir>/harnesses/*.json` is a spec. Those get the generic discovery
// (found on PATH, `--version`, and a login check if the spec names one) and no
// code of their own.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  CUSTOM,
  type HarnessReport,
  type HarnessSpec,
  SHELL,
} from "../shared/harness.ts";
import { claude } from "./harnesses/claude.ts";
import { codex } from "./harnesses/codex.ts";
import { cursor } from "./harnesses/cursor.ts";
import { hermes } from "./harnesses/hermes.ts";
import {
  type Discovery,
  type HarnessAdapter,
  loggedIn,
  output,
  resolveBinary,
  run,
  versionToken,
} from "./harnesses/util.ts";
import { log } from "./log.ts";

export { CLAUDE_INSTALL } from "./harnesses/claude.ts";
export { CODEX_INSTALL } from "./harnesses/codex.ts";
export { CURSOR_INSTALL } from "./harnesses/cursor.ts";
export { HERMES_INSTALL } from "./harnesses/hermes.ts";
export type { HarnessAdapter, HarnessCheck } from "./harnesses/util.ts";

const BUILT_IN: HarnessAdapter[] = [
  claude as HarnessAdapter,
  hermes as HarnessAdapter,
  cursor,
  codex,
];

/** Ids a user file cannot take: the built-ins and the two pseudo-harnesses. */
const RESERVED = new Set([SHELL, CUSTOM, ...BUILT_IN.map((a) => a.spec.id)]);

let userAdapters: HarnessAdapter[] = [];
let problems: { file: string; error: string }[] = [];

/** Where a box's own harness specs live. */
export const harnessDir = (stateDir: string): string =>
  path.join(stateDir, "harnesses");

/**
 * Reads `<state dir>/harnesses/*.json`. Called once per process, by whatever
 * resolves the config, so the server, `vibe-os attach` and doctor all see the
 * same list.
 *
 * Synchronous on purpose: it is a handful of small files read once, and the
 * callers that need the answer (validating a profile, building a window's
 * command) are synchronous. A file that does not parse or validate is skipped
 * and reported by doctor; it never stops the server.
 */
export function loadHarnesses(stateDir: string): void {
  const dir = harnessDir(stateDir);
  const loaded: HarnessAdapter[] = [];
  const found: { file: string; error: string }[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    // no directory is no user harnesses
  }
  for (const file of files) {
    const full = path.join(dir, file);
    try {
      const spec = validateSpec(JSON.parse(readFileSync(full, "utf8")));
      if (RESERVED.has(spec.id)) throw new Error(`id ${spec.id} is taken`);
      if (loaded.some((a) => a.spec.id === spec.id))
        throw new Error(`id ${spec.id} is already defined by another file`);
      loaded.push({ spec });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      found.push({ file: full, error });
      log.warn(`skipping harness ${full}: ${error}`);
    }
  }
  userAdapters = loaded;
  problems = found;
  cache.clear();
}

/** Every harness, built-ins first. */
export const harnesses = (): HarnessAdapter[] => [...BUILT_IN, ...userAdapters];

export const harness = (id: string): HarnessAdapter | undefined =>
  harnesses().find((a) => a.spec.id === id);

/** Whether a profile may name this harness. */
export const isHarness = (id: string): boolean =>
  id === SHELL || id === CUSTOM || harness(id) !== undefined;

/** User files that were skipped, and why. */
export const harnessProblems = () => problems;

// ── validation ───────────────────────────────────────────────────────────────

const ID = /^[a-z][a-z0-9-]{0,31}$/;

function fail(where: string, what: string): never {
  throw new Error(`${where} ${what}`);
}

function string(
  value: unknown,
  where: string,
  required = false,
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim() === "")
    fail(where, "must be a non-empty string");
  if (/[\0\r\n]/.test(value)) fail(where, "cannot span lines");
  return value;
}

function strings(value: unknown, where: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(where, "must be a list of strings");
  return value.map((v, i) => string(v, `${where}[${i}]`, true) as string);
}

function flag(
  value: unknown,
  where: string,
  required = false,
): string | undefined {
  const f = string(value, where, required);
  if (f !== undefined && !f.startsWith("-")) fail(where, "must start with -");
  return f;
}

function flags(value: unknown, where: string): string[] | undefined {
  return strings(value, where)?.map((f) => flag(f, where, true) as string);
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(where, "must be an object");
  return value as Record<string, unknown>;
}

/** Only the keys a spec knows, so a typo is an error rather than ignored. */
function only(o: Record<string, unknown>, keys: string[], where: string) {
  for (const k of Object.keys(o))
    if (!keys.includes(k)) fail(where, `has an unknown key "${k}"`);
}

/**
 * Checks a user-written spec, and returns only what it checked.
 *
 * Strict, because the alternative is a profile that launches the wrong argv
 * with no error anywhere. The mcp field kind and the code hooks are left to
 * built-ins: a JSON file is a command plus its flags.
 */
export function validateSpec(raw: unknown): HarnessSpec {
  const o = object(raw, "the spec");
  only(
    o,
    [
      "id",
      "label",
      "command",
      "paths",
      "leading",
      "resume",
      "install",
      "version",
      "login",
      "defaults",
      "fields",
      "valued",
      "optional",
      "extraPlaceholder",
    ],
    "the spec",
  );
  const id = string(o.id, "id", true) as string;
  if (!ID.test(id))
    fail("id", "must be lowercase letters, digits and dashes, 32 at most");

  let resume: HarnessSpec["resume"];
  if (o.resume !== undefined) {
    const r = object(o.resume, "resume");
    only(r, ["args", "subcommand", "unless"], "resume");
    if (r.subcommand !== undefined && typeof r.subcommand !== "boolean")
      fail("resume.subcommand", "must be true or false");
    resume = {
      args:
        strings(r.args, "resume.args") ?? fail("resume.args", "is required"),
      subcommand: r.subcommand as boolean | undefined,
      unless: flags(r.unless, "resume.unless"),
    };
  }

  let login: HarnessSpec["login"];
  if (o.login !== undefined) {
    const l = object(o.login, "login");
    only(l, ["args", "fix"], "login");
    login = {
      args: strings(l.args, "login.args") ?? fail("login.args", "is required"),
      fix: string(l.fix, "login.fix", true) as string,
    };
  }

  if (!Array.isArray(o.fields)) fail("fields", "must be a list");
  const keys = new Set<string>();
  const fields = o.fields.map((rawField, i): HarnessSpec["fields"][number] => {
    const where = `fields[${i}]`;
    const f = object(rawField, where);
    if (f.kind === "toggle") {
      only(f, ["kind", "flag", "aliases", "label", "hint", "warn"], where);
      return {
        kind: "toggle",
        flag: flag(f.flag, `${where}.flag`, true) as string,
        aliases: flags(f.aliases, `${where}.aliases`),
        label: string(f.label, `${where}.label`, true) as string,
        hint: string(f.hint, `${where}.hint`),
        warn: string(f.warn, `${where}.warn`),
      };
    }
    if (f.kind === "select") {
      only(
        f,
        [
          "kind",
          "key",
          "label",
          "flag",
          "aliases",
          "prefix",
          "options",
          "specials",
          "free",
          "none",
          "placeholder",
          "hint",
        ],
        where,
      );
      const key = string(f.key, `${where}.key`, true) as string;
      if (!/^[a-z][a-z0-9-]*$/.test(key))
        fail(`${where}.key`, "must be lowercase letters, digits and dashes");
      if (keys.has(key)) fail(`${where}.key`, `repeats "${key}"`);
      keys.add(key);
      if (f.free !== undefined && typeof f.free !== "boolean")
        fail(`${where}.free`, "must be true or false");
      const options =
        f.options === undefined
          ? undefined
          : (Array.isArray(f.options)
              ? f.options
              : fail(`${where}.options`, "must be a list")
            ).map((opt, j) => {
              const ow = `${where}.options[${j}]`;
              if (typeof opt === "string")
                return { value: string(opt, ow, true) as string };
              const oo = object(opt, ow);
              only(oo, ["value", "label", "group"], ow);
              return {
                value: string(oo.value, `${ow}.value`, true) as string,
                label: string(oo.label, `${ow}.label`),
                group: string(oo.group, `${ow}.group`),
              };
            });
      const specials =
        f.specials === undefined
          ? undefined
          : (Array.isArray(f.specials)
              ? f.specials
              : fail(`${where}.specials`, "must be a list")
            ).map((s, j) => {
              const sw = `${where}.specials[${j}]`;
              const so = object(s, sw);
              only(so, ["value", "label", "flag", "aliases", "warn"], sw);
              return {
                value: string(so.value, `${sw}.value`, true) as string,
                label: string(so.label, `${sw}.label`, true) as string,
                flag: flag(so.flag, `${sw}.flag`, true) as string,
                aliases: flags(so.aliases, `${sw}.aliases`),
                warn: string(so.warn, `${sw}.warn`),
              };
            });
      const field = {
        kind: "select" as const,
        key,
        label: string(f.label, `${where}.label`, true) as string,
        flag: flag(f.flag, `${where}.flag`),
        aliases: flags(f.aliases, `${where}.aliases`),
        prefix: string(f.prefix, `${where}.prefix`),
        options,
        specials,
        free: f.free as boolean | undefined,
        none: string(f.none, `${where}.none`),
        placeholder: string(f.placeholder, `${where}.placeholder`),
        hint: string(f.hint, `${where}.hint`),
      };
      if (!field.flag && !field.specials?.length)
        fail(where, "needs a flag, specials, or both");
      return field;
    }
    return fail(`${where}.kind`, 'must be "select" or "toggle"');
  });

  return {
    id,
    label: string(o.label, "label", true) as string,
    command: string(o.command, "command", true) as string,
    paths: strings(o.paths, "paths"),
    leading: strings(o.leading, "leading"),
    resume,
    install: string(o.install, "install"),
    version: strings(o.version, "version"),
    login,
    defaults: strings(o.defaults, "defaults"),
    fields,
    valued: flags(o.valued, "valued"),
    optional: flags(o.optional, "optional"),
    extraPlaceholder: string(o.extraPlaceholder, "extraPlaceholder"),
  };
}

// ── discovery ────────────────────────────────────────────────────────────────

/**
 * How long an adapter's own discovery gets before the editor goes without it.
 *
 * Some of it goes to the network (Cursor's model list is the account's), and
 * a hung CLI must not hold up the editor or doctor forever. Past this the
 * report carries what the generic part found and every field falls back to
 * its spec's own options, or free text.
 */
const DISCOVERY_TIMEOUT = 60_000;

interface Found {
  report: HarnessReport;
  detail: unknown;
}

const cache = new Map<string, Promise<Found>>();

const empty = (id: string): HarnessReport => ({
  id,
  available: false,
  version: null,
  loggedIn: null,
  options: {},
  defaults: {},
  notes: [],
});

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

async function find(adapter: HarnessAdapter): Promise<Found> {
  const { spec } = adapter;
  const binary = await resolveBinary(spec.command, spec.paths ?? []);
  if (!binary) {
    log.debug(
      `${spec.command} is not on PATH — ${spec.label} profiles will not launch`,
    );
    return { report: empty(spec.id), detail: undefined };
  }

  // Concurrently: each of these is its own process start, and some harnesses
  // (Hermes is Python) spend seconds getting to the first byte.
  const [version, login, own] = await Promise.all([
    run(binary, spec.version ?? ["--version"], { timeout: 30_000 })
      .then(({ stdout }) => versionToken(stdout))
      .catch(() => null),
    spec.login
      ? output(binary, spec.login.args).then((t) =>
          t === null ? null : loggedIn(t),
        )
      : Promise.resolve(null),
    adapter.discover
      ? withTimeout<Discovery>(
          adapter.discover(binary).catch((err: unknown) => {
            log.warn(`${spec.id} discovery failed: ${String(err)}`);
            return {};
          }),
          DISCOVERY_TIMEOUT,
          {},
        )
      : Promise.resolve<Discovery>({}),
  ]);

  return {
    report: {
      id: spec.id,
      available: true,
      version: own.version !== undefined ? own.version : version,
      loggedIn: login,
      options: own.options ?? {},
      defaults: own.defaults ?? {},
      notes: own.notes ?? [],
    },
    detail: own.detail,
  };
}

/**
 * What the box has for one harness, discovered once.
 *
 * Cached for the life of the process: it describes an installed binary, which
 * does not change under a running server, and a restart is already what
 * happens when someone upgrades it.
 */
export function discover(id: string): Promise<Found> | undefined {
  const adapter = harness(id);
  if (!adapter) return undefined;
  let found = cache.get(id);
  if (!found) {
    found = find(adapter);
    cache.set(id, found);
  }
  return found;
}

/** Every harness's spec, for the editor. */
export const specs = (): HarnessSpec[] => harnesses().map((a) => a.spec);
