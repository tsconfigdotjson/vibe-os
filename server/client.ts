// The CLI verbs that drive a running server: `ls`, `workspace`, `open`,
// `output`, `wait`, `events`, `close`.
//
// Every one of them goes through the HTTP API rather than the database, so the
// same command works on the box and from anywhere else with `--url` and
// `--token`, and does exactly what the API does for any other client.

import { readFile } from "node:fs/promises";
import type {
  Profile,
  SendResult,
  WaitResult,
  WindowSummary,
  WorkspaceSummary,
} from "../shared/wire.ts";
import { loadPersisted, type RawOptions } from "./config.ts";
import { color, describeError, log } from "./log.ts";
import { MAX_WAIT_S, UNTIL } from "./ops.ts";

export interface Remote {
  url: string;
  token: string | null;
}

interface ProjectRow {
  id: string;
  name: string;
  path: string;
}

/**
 * Where the server is, and the token to show it.
 *
 * On the box both come from the state dir, where `start` records the address
 * it bound and the token it requires. `--port` overrides the address. With `--url` the remembered token is
 * not used, since it belongs to this box and not to the one named.
 */
export async function resolveRemote(
  values: RawOptions,
  local: { port: number; stateDir: string },
): Promise<Remote> {
  const given = (values.url as string | undefined) ?? process.env.VIBE_OS_URL;
  const persisted = given ? {} : await loadPersisted(local.stateDir);
  const recorded =
    typeof persisted.localUrl === "string" ? persisted.localUrl : null;
  const url = (
    given ??
    (values.port === undefined && recorded
      ? recorded
      : `http://127.0.0.1:${local.port}`)
  ).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url))
    throw new Error(`--url must start with http:// or https://, not ${url}`);

  let token: string | null = null;
  if (typeof values.token === "string" && values.token !== "")
    token = values.token;
  else if (process.env.VIBE_OS_TOKEN) token = process.env.VIBE_OS_TOKEN;
  else if (!given) token = persisted.token ?? null;
  return { url, token };
}

/** Thrown for an answer the server gave, as opposed to not reaching it. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** The headers every call carries: the token, if there is one. */
const authHeaders = (remote: Remote): Record<string, string> =>
  remote.token ? { authorization: `Bearer ${remote.token}` } : {};

export async function request<T>(
  remote: Remote,
  method: string,
  route: string,
  body?: unknown,
): Promise<T> {
  const headers = authHeaders(remote);
  if (body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${remote.url}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      // A wait holds the request open for up to four minutes on purpose.
      timeout: false,
    } as RequestInit);
  } catch (err) {
    throw new Error(
      `could not reach vibe-os at ${remote.url}: ${describeError(err)}`,
    );
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { error: text.trim() || res.statusText };
  }
  if (!res.ok) {
    const detail = (parsed as { error?: unknown }).error;
    const message =
      res.status === 401
        ? `${remote.url} wants a token: pass --token or set VIBE_OS_TOKEN`
        : typeof detail === "string"
          ? detail
          : `${method} ${route} answered ${res.status}`;
    throw new ApiError(message, res.status, parsed as Record<string, unknown>);
  }
  return parsed as T;
}

// ── finding things by name ───────────────────────────────────────────────────

/** A project by id, name or path. */
export function findProject(projects: ProjectRow[], name: string): ProjectRow {
  const found = projects.find(
    (p) => p.id === name || p.name === name || p.path === name,
  );
  if (found) return found;
  throw new Error(
    projects.length === 0
      ? `no project called ${name}: this box has no projects yet`
      : `no project called ${name}. Projects: ${projects.map((p) => p.name).join(", ")}`,
  );
}

/**
 * A workspace by id, name, or `project/name`.
 *
 * Names are three random words, so two projects sharing one is unlikely, and
 * an error that asks for the project is better than guessing.
 */
export function findWorkspace(
  all: WorkspaceSummary[],
  name: string,
): WorkspaceSummary {
  const byId = all.find((w) => w.id === name);
  if (byId) return byId;
  const slash = name.lastIndexOf("/");
  const matches =
    slash === -1
      ? all.filter((w) => w.name === name)
      : all.filter(
          (w) =>
            w.name === name.slice(slash + 1) &&
            w.project === name.slice(0, slash),
        );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1)
    throw new Error(
      `${name} is in more than one project: ${matches.map((w) => `${w.project}/${w.name}`).join(", ")}`,
    );
  throw new Error(`no workspace called ${name}`);
}

/** A profile by id or by name, ignoring case. */
export function findProfile(profiles: Profile[], name: string): Profile {
  const lower = name.toLowerCase();
  const found = profiles.find(
    (p) => p.id === name || p.name.toLowerCase() === lower,
  );
  if (found) return found;
  throw new Error(
    profiles.length === 0
      ? `no profile called ${name}: this project has no profiles`
      : `no profile called ${name}. Profiles: ${profiles.map((p) => p.name).join(", ")}`,
  );
}

/** A window by id or by ref, with or without the `vibe-` prefix. */
export function findWindow(
  windows: WindowSummary[],
  name: string,
): WindowSummary {
  const ref = name.replace(/^vibe-/, "");
  const found = windows.find((w) => w.id === name || w.ref === ref);
  if (found) return found;
  throw new Error(`no window called ${name}`);
}

/** `--blank key=value`, repeatable, into an object. */
export function parseBlanks(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at <= 0) throw new Error(`--blank wants label=value, not ${pair}`);
    out[pair.slice(0, at).trim()] = pair.slice(at + 1);
  }
  return out;
}

// ── the verbs ────────────────────────────────────────────────────────────────

const print = (values: RawOptions, data: unknown, human: () => void) => {
  if (values.json) console.log(JSON.stringify(data, null, 2));
  else human();
};

/** A window's state, padded to one width so the columns line up. */
function stateLabel(state: WindowSummary["state"]): string {
  const text = (state ?? "stopped").padEnd(8);
  if (state === "busy") return color.green(text);
  if (state === "question") return color.yellow(text);
  if (state === "idle") return text;
  return color.dim(text);
}

async function ls(remote: Remote, values: RawOptions): Promise<number> {
  const windows = await request<WindowSummary[]>(remote, "GET", "/api/windows");
  print(values, windows, () => {
    if (windows.length === 0) {
      console.log("no windows");
      return;
    }
    for (const w of windows) {
      const role = w.role ?? color.dim("terminal");
      console.log(
        `${stateLabel(w.state)}  ${w.ref.padEnd(30)} ${role.padEnd(20)} ${color.dim(`${w.project}/${w.workspace}`)}${w.label ? `  ${w.label}` : ""}`,
      );
    }
  });
  return 0;
}

async function workspace(
  remote: Remote,
  values: RawOptions,
  args: string[],
): Promise<number> {
  const [verb, projectName] = args;
  if (verb === "ls") {
    const all = await request<WorkspaceSummary[]>(
      remote,
      "GET",
      "/api/workspaces",
    );
    const shown = projectName
      ? all.filter(
          (w) => w.project === projectName || w.projectId === projectName,
        )
      : all;
    print(values, shown, () => {
      for (const w of shown)
        console.log(`${w.project}/${w.name}  ${color.dim(w.path)}`);
    });
    return 0;
  }
  if (verb !== "new" || !projectName) {
    log.error("usage: vibe-os workspace new <project> [--from <branch>]");
    return 1;
  }

  const project = findProject(
    await request<ProjectRow[]>(remote, "GET", "/api/projects"),
    projectName,
  );
  const created = await request<{
    id: string;
    name: string;
    path: string;
    base: string;
    warning: string | null;
  }>(
    remote,
    "POST",
    `/api/projects/${encodeURIComponent(project.id)}/workspaces`,
    { name: values.name, from: values.from },
  );
  if (created.warning) log.warn(created.warning);
  print(values, created, () => {
    console.log(`${project.name}/${created.name}`);
    console.log(color.dim(`  ${created.path}, from ${created.base}`));
  });
  return 0;
}

/** `--prompt -` reads the prompt from stdin, for text too long for argv. */
async function promptText(values: RawOptions): Promise<string | undefined> {
  if (values.prompt === undefined) return undefined;
  const given = String(values.prompt);
  if (given !== "-") return given;
  return await readFile("/dev/stdin", "utf8");
}

async function open(
  remote: Remote,
  values: RawOptions,
  name: string | undefined,
): Promise<number> {
  if (!name) {
    log.error(
      "usage: vibe-os open <workspace> [--profile <name>] [--prompt <text>] [--blank label=value]",
    );
    return 1;
  }
  const text = await promptText(values);
  const blanks = parseBlanks(values.blank ?? []);
  const hasBlanks = Object.keys(blanks).length > 0;
  if (text !== undefined && hasBlanks)
    throw new Error(
      "--blank fills the profile's prompt, and --prompt replaces it: use one",
    );

  const ws = findWorkspace(
    await request<WorkspaceSummary[]>(remote, "GET", "/api/workspaces"),
    name,
  );
  let profileId: string | undefined;
  if (values.profile) {
    profileId = findProfile(
      await request<Profile[]>(
        remote,
        "GET",
        `/api/projects/${encodeURIComponent(ws.projectId)}/profiles`,
      ),
      String(values.profile),
    ).id;
  } else if (hasBlanks) {
    throw new Error("--blank needs --profile, whose prompt it fills");
  }

  // One call: the server creates the window, starts it, waits for it to be
  // ready and pastes, and takes the window back out if it cannot start.
  const send = text !== undefined || hasBlanks;
  type Opened = Partial<SendResult> & {
    window: WindowSummary;
    reused?: boolean;
  };
  let result: Opened;
  try {
    result = await request<Opened>(
      remote,
      "POST",
      `/api/workspaces/${encodeURIComponent(ws.id)}/windows`,
      {
        profileId,
        force: values.force === true,
        label: values.label,
        reuse: values.reuse === true ? true : undefined,
        start: true,
        prompt: text,
        blanks: hasBlanks ? blanks : undefined,
        submit: send ? values.submit === true : undefined,
      },
    );
  } catch (err) {
    if (err instanceof ApiError && err.body.capacity === true)
      throw new Error(`${err.message}\nPass --force to open it anyway.`);
    throw err;
  }

  const { window } = result;
  print(values, values.json ? result : window, () => {
    console.log(window.ref);
    console.log(
      color.dim(
        `  ${window.role ?? "terminal"} in ${window.project}/${window.workspace}${result.reused ? ", already open" : ""}${send && result.delivered ? (values.submit ? ", prompt submitted" : ", prompt pasted") : ""}`,
      ),
    );
  });
  // A reused window that was running already had its prompt.
  if (result.reused && result.delivered === undefined) return 0;
  if (send && !result.delivered) {
    log.error(
      `${window.ref} is open, but the prompt was not sent: ${result.reason ?? result.state}.` +
        ` See it with: vibe-os output ${window.ref}`,
    );
    return 1;
  }
  return 0;
}

async function output(
  remote: Remote,
  values: RawOptions,
  name: string | undefined,
): Promise<number> {
  if (!name) {
    log.error("usage: vibe-os output <window> [--lines <n>] [--follow]");
    return 1;
  }
  const win = findWindow(
    await request<WindowSummary[]>(remote, "GET", "/api/windows"),
    name,
  );
  if (values.follow) return follow(remote, values, win);
  const lines =
    values.lines === undefined
      ? ""
      : `?lines=${encodeURIComponent(String(values.lines))}`;
  const out = await request<{ text: string; state: WindowSummary["state"] }>(
    remote,
    "GET",
    `/api/windows/${encodeURIComponent(win.id)}/output${lines}`,
  );
  print(values, out, () => console.log(out.text));
  return 0;
}

/** How often `output --follow` looks for new lines. */
const FOLLOW_MS = 1_000;

interface Output {
  text: string;
  state: WindowSummary["state"];
  cursor: number;
  screen?: string;
}

/**
 * Prints a window's output and then each line as it scrolls into the history,
 * until the window stops or this is interrupted.
 *
 * The screen itself is redrawn in place, so it is printed when the window goes
 * quiet, and only if it changed: that is the answer an agent left at its
 * prompt. Rows already printed that way are not printed again when they
 * scroll into the history.
 */
async function follow(
  remote: Remote,
  values: RawOptions,
  win: WindowSummary,
): Promise<number> {
  const route = `/api/windows/${encodeURIComponent(win.id)}/output`;
  const lines = String(values.lines ?? 50);
  let shown: string[] = [];
  let echo: string[] = [];
  const printScreen = (screen: string) => {
    shown = screen === "" ? [] : screen.split("\n");
    echo = [...shown];
    if (screen) console.log(screen);
  };
  const printHistory = (text: string) => {
    if (text === "") return;
    for (const line of text.split("\n")) {
      if (echo.length > 0 && echo[0] === line) {
        echo.shift();
        continue;
      }
      echo = [];
      console.log(line);
    }
  };

  const first = await request<Output>(
    remote,
    "GET",
    `${route}?after=0&lines=${encodeURIComponent(lines)}`,
  );
  if (values.json) console.log(JSON.stringify(first));
  else {
    printHistory(first.text);
    printScreen(first.screen ?? "");
  }
  let cursor = first.cursor;
  let state = first.state;
  for (;;) {
    await Bun.sleep(FOLLOW_MS);
    let out: Output;
    try {
      out = await request<Output>(remote, "GET", `${route}?after=${cursor}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        log.info(`${win.ref} is not running`);
        return 0;
      }
      throw err;
    }
    if (values.json) {
      if (out.text || out.state !== state) console.log(JSON.stringify(out));
    } else {
      printHistory(out.text);
      const screen = out.screen ?? "";
      if (
        out.state !== "busy" &&
        state === "busy" &&
        screen !== shown.join("\n")
      ) {
        console.log(color.dim(`── ${win.ref} is ${out.state} ──`));
        printScreen(screen);
      }
    }
    cursor = out.cursor;
    state = out.state;
    if (state === "asleep") return 0;
  }
}

/**
 * Waits for windows to settle. Exits 0 when one did, 2 when time ran out, and
 * 1 when a window is not running (or anything else went wrong).
 */
async function wait(
  remote: Remote,
  values: RawOptions,
  names: string[],
): Promise<number> {
  if (names.length === 0) {
    log.error(
      "usage: vibe-os wait <window...> [--until settled|idle|question|change] [--timeout <s>] [--turn] [--background]",
    );
    return 1;
  }
  const until = values.until === undefined ? "settled" : String(values.until);
  if (!(UNTIL as readonly string[]).includes(until))
    throw new Error(`--until must be one of ${UNTIL.join(", ")}`);
  const timeout = values.timeout === undefined ? 60 : Number(values.timeout);
  if (!Number.isInteger(timeout) || timeout < 1)
    throw new Error("--timeout must be a whole number of seconds");

  const all = await request<WindowSummary[]>(remote, "GET", "/api/windows");
  const refs = names.map((n) => findWindow(all, n).ref);
  const query = new URLSearchParams({ refs: refs.join(","), until });
  if (values.turn) query.set("turn", "1");
  if (values.background) query.set("background", "1");
  if (values.lines !== undefined) query.set("lines", String(values.lines));

  // A wait longer than one request may be is several in a row.
  let left = timeout;
  let result: WaitResult;
  for (;;) {
    const chunk = Math.min(left, MAX_WAIT_S);
    query.set("timeout", String(chunk));
    result = await request<WaitResult>(
      remote,
      "GET",
      `/api/windows/wait?${query}`,
    );
    left -= chunk;
    const stopped = result.state === null || result.state === "asleep";
    if (result.reached || stopped || left <= 0) break;
  }

  print(values, result, () => {
    const secs = Math.round(result.waitedMs / 1000);
    console.log(
      result.reached
        ? `${result.ref} ${result.state}`
        : result.state === null
          ? `${result.ref} is not running`
          : `timed out after ${timeout}s: ${result.ref} is ${result.state}`,
    );
    if (result.reached) console.log(color.dim(`  after ${secs}s`));
    if (result.background)
      console.log(
        color.dim(
          "  a background command is still running; --background waits for it",
        ),
      );
    if (result.text) console.log(result.text);
  });
  if (result.reached) return 0;
  return result.state === null || result.state === "asleep" ? 1 : 2;
}

/**
 * Prints window events as JSON lines until interrupted. Window names given
 * narrow it to those windows, and `--label` to windows with that label.
 */
async function events(
  remote: Remote,
  values: RawOptions,
  names: string[],
): Promise<number> {
  const query = new URLSearchParams();
  if (names.length > 0) {
    const all = await request<WindowSummary[]>(remote, "GET", "/api/windows");
    query.set("refs", names.map((n) => findWindow(all, n).ref).join(","));
  }
  if (values.label !== undefined) query.set("label", String(values.label));
  let res: Response;
  try {
    res = await fetch(`${remote.url}/api/events?${query}`, {
      headers: { ...authHeaders(remote), accept: "text/event-stream" },
      redirect: "manual",
      timeout: false,
    } as RequestInit);
  } catch (err) {
    throw new Error(
      `could not reach vibe-os at ${remote.url}: ${describeError(err)}`,
    );
  }
  if (res.status === 401)
    throw new Error(
      `${remote.url} wants a token: pass --token or set VIBE_OS_TOKEN`,
    );
  if (!res.ok || !res.body)
    throw new Error(`GET /api/events answered ${res.status}`);
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of res.body) {
    pending += decoder.decode(chunk, { stream: true });
    let end = pending.indexOf("\n");
    while (end !== -1) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (line.startsWith("data: ")) console.log(line.slice("data: ".length));
      end = pending.indexOf("\n");
    }
  }
  log.info("the server closed the event stream");
  return 0;
}

async function close(
  remote: Remote,
  name: string | undefined,
): Promise<number> {
  if (!name) {
    log.error("usage: vibe-os close <window>");
    return 1;
  }
  const win = findWindow(
    await request<WindowSummary[]>(remote, "GET", "/api/windows"),
    name,
  );
  await request(remote, "DELETE", `/api/windows/${encodeURIComponent(win.id)}`);
  console.log(`closed ${win.ref}`);
  return 0;
}

/** Runs one client verb. Errors are printed here, as one line. */
export async function runClient(
  command: "ls" | "workspace" | "open" | "output" | "close" | "wait" | "events",
  args: string[],
  values: RawOptions,
  local: { port: number; stateDir: string },
): Promise<number> {
  try {
    const remote = await resolveRemote(values, local);
    switch (command) {
      case "ls":
        return await ls(remote, values);
      case "workspace":
        return await workspace(remote, values, args);
      case "open":
        return await open(remote, values, args[0]);
      case "output":
        return await output(remote, values, args[0]);
      case "close":
        return await close(remote, args[0]);
      case "wait":
        return await wait(remote, values, args);
      case "events":
        return await events(remote, values, args);
    }
  } catch (err) {
    log.error(describeError(err));
    return 1;
  }
}
