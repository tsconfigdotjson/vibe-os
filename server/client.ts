// The CLI verbs that drive a running server: `ls`, `workspace`, `open`,
// `output`, `close`.
//
// Every one of them goes through the HTTP API rather than the database, so the
// same command works on the box and from anywhere else with `--url` and
// `--token`, and does exactly what the API does for any other client.

import { readFile } from "node:fs/promises";
import type {
  Profile,
  SendResult,
  WindowSummary,
  WorkspaceSummary,
} from "../shared/wire.ts";
import { loadPersisted, type RawOptions } from "./config.ts";
import { color, describeError, log } from "./log.ts";

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

export async function request<T>(
  remote: Remote,
  method: string,
  route: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (remote.token) headers.authorization = `Bearer ${remote.token}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${remote.url}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
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
  type Opened = Partial<SendResult> & { window: WindowSummary };
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
        `  ${window.role ?? "terminal"} in ${window.project}/${window.workspace}${send && result.delivered ? (values.submit ? ", prompt submitted" : ", prompt pasted") : ""}`,
      ),
    );
  });
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
    log.error("usage: vibe-os output <window> [--lines <n>]");
    return 1;
  }
  const win = findWindow(
    await request<WindowSummary[]>(remote, "GET", "/api/windows"),
    name,
  );
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
  command: "ls" | "workspace" | "open" | "output" | "close",
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
    }
  } catch (err) {
    log.error(describeError(err));
    return 1;
  }
}
