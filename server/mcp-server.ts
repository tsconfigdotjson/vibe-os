// The MCP server at /mcp: the stable API as tools, for agents.
//
// Not to be confused with mcp.ts, which finds the MCP servers a profile's
// windows can be given. This is vibe-os itself as an MCP server.
//
// Every tool is a thin wrapper over ops.ts, the same functions the HTTP routes
// call, so a tool and its route cannot drift apart. What the wrapper adds is
// what a model needs and a script does not: names instead of ids, one short
// text summary next to the structured result, and errors that say what to call
// next.
//
// The handler is stateless, as the 2026-07-28 revision is: a window's ref is
// the only handle, and the caller passes it back as an argument. Auth is the
// gate's job (index.ts), in front of this, exactly as for /api.

import {
  type CallToolResult,
  createMcpHandler,
  type McpHttpHandler,
  McpServer,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import pkg from "../package.json" with { type: "json" };
import { parsePrompt } from "../shared/blanks.ts";
import type {
  SendResult,
  WaitResult,
  WindowEvent,
  WindowSummary,
} from "../shared/wire.ts";
import type { AttachTarget } from "./attach.ts";
import { findProfile, findProject, findWorkspace } from "./client.ts";
import type { Db } from "./db.ts";
import { describeError } from "./log.ts";
import { MAX_WAIT_S, OpError, type Ops, UNTIL } from "./ops.ts";
import { listProfiles } from "./profiles.ts";
import { listProjects } from "./projects.ts";

/**
 * The most text one result carries, about 8k tokens.
 *
 * Claude Code warns above 10k tokens of tool output and cuts at 25k, and an
 * agent that reads a window often does not want the whole history anyway.
 */
export const MAX_RESULT_CHARS = 32_000;
/** How often a wait reports progress when nothing has changed. */
export const PROGRESS_MS = 20_000;
const DEFAULT_WAIT_S = 120;
const DEFAULT_WAIT_LINES = 30;
const DEFAULT_READ_LINES = 50;
const DEFAULT_MESSAGES = 10;

const INSTRUCTIONS = `vibe-os runs coding agents and terminals in windows, each in a git worktree (a workspace) of a project.

To hand an agent a task: vibe_list_projects to find a project and its profiles, vibe_create_workspace, vibe_open_window with a prompt, then vibe_wait until the window settles, then vibe_read_messages (Claude windows) or vibe_read_output for the answer.

A window is named by its ref, like quiet-amber-otter-1. Its state is busy (drawing), idle (at its prompt), question (stopped on a menu or yes/no question) or asleep (hibernated). A window on a question needs an answer: read it with vibe_read_output, then vibe_send keys, like ["2"] or ["y"] for a numbered menu or a yes/no, or ["Down", "Enter"] to move the ❯ marker in a menu without numbers.`;

/** Cuts text to `max` characters from the start, keeping the end. */
export function clip(text: string, max = MAX_RESULT_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.length - max;
  return `[${cut} earlier characters cut; ask for fewer lines, or read on from a cursor with after]\n${text.slice(cut)}`;
}

/** A tool result: a short text for the model, and the structured value. */
function ok(text: string, structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: clip(text) }],
    structuredContent: structured,
  };
}

/** An error the model reads, with what to do next. */
function fail(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * An error from ops, reworded for a model where the API's wording assumes
 * HTTP. Anything else is reported as it is.
 */
export function explain(err: unknown, window?: string): CallToolResult {
  const message = describeError(err);
  if (err instanceof OpError) {
    if (err.extra.capacity === true)
      return fail(
        `${message}. The box is short of memory: pass force: true to open anyway, or close a window first with vibe_close_window.`,
      );
    if (message === "the window is not running")
      return fail(
        `${window ?? "the window"} is not running. vibe_send starts it, or open a new one with vibe_open_window.`,
      );
    if (err.status === 404 && message.startsWith("no window called"))
      return fail(
        `${message.split(".")[0]}. vibe_list_windows lists the windows and their refs.`,
      );
  }
  return fail(message);
}

/** Why a send went nowhere, as the next step to take. */
function undelivered(ref: string, r: Partial<SendResult>): CallToolResult {
  if (r.state === "question")
    return fail(
      `${ref} is waiting on a question, so nothing was pasted. Read it with vibe_read_output, then answer with vibe_send keys: the option's number, like ["2"], or ["Up"] and ["Down"] to move the ❯ marker, then ["Enter"]. Or pass force: true to paste anyway.`,
    );
  return fail(
    `${ref} did not take the text: ${r.reason ?? "it did not draw it"}. See what it shows with vibe_read_output.`,
  );
}

/** One window as a line: ref, state, turn, role, where, label. */
function windowLine(w: WindowSummary): string {
  const parts = [
    w.ref,
    w.state ?? "stopped",
    w.turn ? `turn ${w.turn}` : null,
    w.role ?? "terminal",
    `${w.project}/${w.workspace}`,
    w.label ? `label ${w.label}` : null,
  ];
  return parts.filter(Boolean).join("  ");
}

// Output schemas: what structuredContent carries. Loose objects, so a field
// added to the API later does not make old results fail validation.
const windowSchema = z.looseObject({
  id: z.string(),
  ref: z.string(),
  workspace: z.string(),
  project: z.string(),
  role: z.string().nullable(),
  label: z.string().nullable(),
  live: z.boolean(),
  state: z.string().nullable(),
  turn: z.string().nullable(),
  lastOutputAt: z.number().nullable(),
  lastSendAt: z.number().nullable(),
});

const workspaceSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  project: z.string(),
  branch: z.string(),
  path: z.string(),
});

const windowArg = z
  .string()
  .describe("The window's ref, like quiet-amber-otter-1, or its id");

export interface McpDeps {
  ops: Ops;
  db: Db;
}

/** Registers every tool on a server, in the order `tools/list` gives them. */
export function registerTools(server: McpServer, { ops, db }: McpDeps): void {
  /** A window by ref or id, as a tool error if there is none. */
  const windowOf = (name: string): AttachTarget => ops.target(name.trim());

  server.registerTool(
    "vibe_list_windows",
    {
      title: "List windows",
      description:
        "Lists the windows on the box with their state (busy, idle, question, asleep, or stopped) and how the turn after the last send is going (pending, working, done).",
      inputSchema: z.object({
        label: z.string().optional().describe("Only windows with this label"),
        workspace: z
          .string()
          .optional()
          .describe("Only windows in this workspace (name or project/name)"),
        state: z
          .enum(["busy", "idle", "question", "asleep", "stopped"])
          .optional()
          .describe("Only windows in this state"),
      }),
      outputSchema: z.object({ windows: z.array(windowSchema) }),
      annotations: { readOnlyHint: true },
    },
    async ({ label, workspace, state }) => {
      try {
        let all = await ops.windows(label ?? null);
        if (workspace) {
          const ws = findWorkspace(ops.workspaces(), workspace);
          all = all.filter(
            (w) => w.workspace === ws.name && w.project === ws.project,
          );
        }
        if (state) all = all.filter((w) => (w.state ?? "stopped") === state);
        return ok(
          all.length === 0 ? "no windows" : all.map(windowLine).join("\n"),
          { windows: all },
        );
      } catch (err) {
        return explain(err);
      }
    },
  );

  server.registerTool(
    "vibe_list_workspaces",
    {
      title: "List workspaces",
      description:
        "Lists workspaces (git worktrees, one per piece of work), most recently opened first.",
      inputSchema: z.object({
        project: z.string().optional().describe("Only this project's"),
      }),
      outputSchema: z.object({ workspaces: z.array(workspaceSchema) }),
      annotations: { readOnlyHint: true },
    },
    async ({ project }) => {
      try {
        let all = ops.workspaces();
        if (project) {
          const p = findProject(listProjects(db), project);
          all = all.filter((w) => w.projectId === p.id);
        }
        return ok(
          all.length === 0
            ? "no workspaces"
            : all
                .map((w) => `${w.project}/${w.name}  branch ${w.branch}`)
                .join("\n"),
          { workspaces: all },
        );
      } catch (err) {
        return explain(err);
      }
    },
  );

  server.registerTool(
    "vibe_list_projects",
    {
      title: "List projects",
      description:
        "Lists projects (git repositories) with their profiles: the roles a window can be opened as, each with its harness and the blanks its prompt has.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        projects: z.array(
          z.looseObject({
            id: z.string(),
            name: z.string(),
            profiles: z.array(
              z.object({
                name: z.string(),
                harness: z.string(),
                blanks: z.array(z.string()),
              }),
            ),
          }),
        ),
      }),
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const projects = listProjects(db).map((p) => ({
          id: p.id,
          name: p.name,
          path: p.path,
          branch: p.branch,
          profiles: listProfiles(db, p.id).map((r) => ({
            name: r.name,
            harness: r.harness,
            blanks: parsePrompt(r.prompt).flatMap((s) =>
              s.type === "blank" ? [s.value] : [],
            ),
          })),
        }));
        const text = projects
          .map((p) => {
            const roles = p.profiles.map(
              (r) =>
                `  ${r.name} (${r.harness})${r.blanks.length > 0 ? `, blanks: ${r.blanks.join(", ")}` : ""}`,
            );
            return [p.name, ...roles].join("\n");
          })
          .join("\n");
        return ok(text || "no projects", { projects });
      } catch (err) {
        return explain(err);
      }
    },
  );

  server.registerTool(
    "vibe_create_workspace",
    {
      title: "Create a workspace",
      description:
        "Cuts a workspace: a new git worktree of a project, on its own branch. Open windows in it with vibe_open_window.",
      inputSchema: z.object({
        project: z
          .string()
          .describe(
            "The project, by name or id. project/name also names the workspace",
          ),
        name: z
          .string()
          .optional()
          .describe(
            "Lowercase letters, digits and dashes. Three random words if absent",
          ),
        from: z
          .string()
          .optional()
          .describe(
            "The branch or commit to start from. Defaults to origin's default branch",
          ),
      }),
      outputSchema: z.looseObject({
        id: z.string(),
        name: z.string(),
        project: z.string(),
        branch: z.string(),
        base: z.string(),
        warning: z.string().nullable(),
      }),
      annotations: { idempotentHint: false },
    },
    async ({ project, name, from }) => {
      try {
        const slash = project.indexOf("/");
        const projectName = slash === -1 ? project : project.slice(0, slash);
        const wanted =
          name ?? (slash === -1 ? undefined : project.slice(slash + 1));
        const p = findProject(listProjects(db), projectName);
        const created = await ops.newWorkspace(p.id, { name: wanted, from });
        return ok(
          `created ${p.name}/${created.name}, from ${created.base}${created.warning ? `. ${created.warning}` : ""}`,
          { ...created, project: p.name },
        );
      } catch (err) {
        return explain(err);
      }
    },
  );

  server.registerTool(
    "vibe_open_window",
    {
      title: "Open a window",
      description:
        "Opens a window in a workspace as a profile, starts it, and sends it a prompt. After opening with a prompt, call vibe_wait, then vibe_read_messages or vibe_read_output for the answer. With reuse and a label, a window already open under that label is returned instead of a second one, and the prompt is not sent again.",
      inputSchema: z.object({
        workspace: z
          .string()
          .describe("The workspace, by name or project/name"),
        profile: z
          .string()
          .optional()
          .describe(
            "The profile to open as, by name. A plain terminal if absent",
          ),
        label: z
          .string()
          .optional()
          .describe("Your own tag for the window, to find it again"),
        prompt: z.string().optional().describe("Text to send it"),
        blanks: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Instead of prompt: values for the profile prompt's blanks, by label",
          ),
        submit: z
          .boolean()
          .default(true)
          .describe("Press Enter after the prompt. Default true"),
        reuse: z
          .boolean()
          .optional()
          .describe("Return the window already open with this label, if any"),
        force: z
          .boolean()
          .optional()
          .describe("Open even when the box is short of memory"),
      }),
      outputSchema: z.looseObject({
        window: windowSchema,
        reused: z.boolean(),
        delivered: z.boolean().optional(),
      }),
      annotations: { idempotentHint: false },
    },
    async (args) => {
      try {
        const ws = findWorkspace(ops.workspaces(), args.workspace);
        const profile = args.profile
          ? findProfile(listProfiles(db, ws.projectId), args.profile)
          : undefined;
        const sends = args.prompt !== undefined || args.blanks !== undefined;
        const opened = await ops.open(ws.id, {
          profileId: profile?.id,
          label: args.label,
          prompt: args.prompt,
          blanks: args.blanks,
          start: true,
          submit: sends ? args.submit : undefined,
          reuse: args.reuse,
          force: args.force,
        });
        const body = opened.body as Partial<SendResult> & {
          window: WindowSummary;
          reused?: boolean;
        };
        const reused = body.reused === true;
        if (sends && !reused && body.delivered === false)
          return undelivered(body.window.ref, body);
        const what = reused
          ? `reused ${body.window.ref}, already open as ${args.label}`
          : `opened ${body.window.ref} as ${profile?.name ?? "a terminal"} in ${ws.project}/${ws.name}`;
        const next =
          sends && body.delivered
            ? args.submit
              ? ". Prompt submitted; call vibe_wait to know when it is done"
              : ". Prompt pasted, not submitted"
            : "";
        return ok(`${what}${next}`, {
          ...body,
          reused,
        });
      } catch (err) {
        return explain(err);
      }
    },
  );

  server.registerTool(
    "vibe_send",
    {
      title: "Send to a window",
      description:
        'Sends text to a window and presses Enter, or presses keys. Text is refused while the window is on a question: read the question with vibe_read_output, then answer with keys: the number of the option, like ["2"], ["y"] for yes/no, or ["Down", "Enter"] to pick the next option in a menu without numbers. ["Escape"] stops a busy agent. A hibernated window wakes on send. Keys are one character or Enter, Escape, Tab, BackTab, Backspace, Delete, Space, Up, Down, Left, Right, Home, End, PageUp, PageDown, Ctrl+<letter>.',
      inputSchema: z.object({
        window: windowArg,
        text: z.string().optional().describe("Text to paste"),
        blanks: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Instead of text: values for the profile prompt's blanks, by label",
          ),
        keys: z
          .array(z.string())
          .optional()
          .describe('Instead of text: keys to press, like ["2"] or ["Enter"]'),
        submit: z
          .boolean()
          .optional()
          .describe("Press Enter after text. Default true"),
        force: z
          .boolean()
          .optional()
          .describe("Paste even when the window is on a question"),
      }),
      outputSchema: z.looseObject({
        delivered: z.boolean(),
        started: z.boolean(),
        window: windowSchema,
      }),
    },
    async ({ window, text, blanks, keys, submit, force }) => {
      try {
        const t = windowOf(window);
        // Keys go with nothing else, and ops says so if they do.
        const body =
          keys !== undefined
            ? { keys, text, blanks, submit }
            : { text, blanks, submit: submit ?? true, force };
        const r = await ops.send(t, "send", body);
        if (!r.delivered) return undelivered(t.ref, r);
        const what =
          keys !== undefined
            ? `pressed ${keys.join(" ")} in ${t.ref}`
            : `sent to ${t.ref}${(submit ?? true) ? " and submitted" : ""}`;
        return ok(
          `${what}${r.started ? " (started it first)" : ""}. Call vibe_wait to know when it has answered`,
          { delivered: true, started: r.started ?? false, window: r.window },
        );
      } catch (err) {
        return explain(err, window);
      }
    },
  );

  server.registerTool(
    "vibe_read_output",
    {
      title: "Read a window",
      description:
        "Reads what a window shows, as plain text. With after (a cursor from an earlier read), returns only the lines added since, plus the screen as it is now. Does not wake a hibernated window.",
      inputSchema: z.object({
        window: windowArg,
        lines: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe(
            `How many lines, from the bottom. Default ${DEFAULT_READ_LINES}; with after, every new line unless given`,
          ),
        after: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("A cursor from an earlier read: only what came since"),
      }),
      outputSchema: z.looseObject({
        text: z.string(),
        state: z.string(),
        cursor: z.number(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ window, lines, after }) => {
      try {
        const t = windowOf(window);
        const out = await ops.output(t, {
          lines:
            lines ?? (after === undefined ? DEFAULT_READ_LINES : undefined),
          after,
        });
        const text =
          after === undefined
            ? out.text
            : [
                out.text ? `new since ${after}:\n${out.text}` : null,
                `screen:\n${out.screen ?? ""}`,
              ]
                .filter(Boolean)
                .join("\n\n");
        return ok(
          `${t.ref} is ${out.state}. cursor ${out.cursor}${out.truncated ? " (some lines were no longer held)" : ""}\n\n${text}`,
          { ...out },
        );
      } catch (err) {
        return explain(err, window);
      }
    },
  );

  server.registerTool(
    "vibe_wait",
    {
      title: "Wait for a window",
      description:
        "Blocks until a window settles (stops working: idle, question or asleep), or until the timeout. With several windows, returns when the first one does. By default it also waits for the window to have answered the last send, so an idle before the work starts does not count. Returns the window's last lines. Does not wake a hibernated window.",
      inputSchema: z.object({
        windows: z
          .union([z.string(), z.array(z.string()).min(1).max(32)])
          .describe("One window's ref, or several"),
        until: z
          .enum(UNTIL)
          .default("settled")
          .describe(
            "settled (default): not busy. idle or question: that state. change: any change",
          ),
        timeout: z
          .number()
          .int()
          .min(1)
          .max(MAX_WAIT_S)
          .default(DEFAULT_WAIT_S)
          .describe(`Seconds, up to ${MAX_WAIT_S}. Default ${DEFAULT_WAIT_S}`),
        turn: z
          .boolean()
          .default(true)
          .describe("Also wait for the answer to the last send. Default true"),
        background: z
          .boolean()
          .default(false)
          .describe(
            "Also wait for commands the agent left running in the background (Claude) to finish. Off by default: a server left running never finishes",
          ),
        lines: z
          .number()
          .int()
          .min(0)
          .max(2000)
          .default(DEFAULT_WAIT_LINES)
          .describe("Lines of output to return. Default 30"),
      }),
      outputSchema: z.looseObject({
        ref: z.string(),
        state: z.string().nullable(),
        reached: z.boolean(),
        waitedMs: z.number(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ windows, until, timeout, turn, background, lines }, ctx) => {
      try {
        const targets = (Array.isArray(windows) ? windows : [windows]).map(
          windowOf,
        );
        const token = ctx.mcpReq._meta?.progressToken;
        let progress = 0;
        // Where each window is, as the progress messages say it: a state
        // alone reads "idle" for a shell whose command is still running.
        const where = new Map(
          targets.map((t) => {
            const w = ops.summary(t);
            return [t.ref, { state: w.state ?? "stopped", turn: w.turn }];
          }),
        );
        const describe = () =>
          [...where]
            .map(
              ([ref, w]) =>
                `${ref}: ${w.state}${w.turn ? `, turn ${w.turn}` : ""}`,
            )
            .join("; ");
        const report = (message: string) => {
          if (token === undefined) return;
          progress += 1;
          void ctx.mcpReq
            .notify({
              method: "notifications/progress",
              params: { progressToken: token, progress, message },
            })
            .catch(() => {});
        };
        const begun = Date.now();
        // A beat while nothing changes, so a client's idle timeout never
        // fires on a long turn.
        const beat = setInterval(
          () =>
            report(
              `${describe()} (${Math.round((Date.now() - begun) / 1000)}s)`,
            ),
          PROGRESS_MS,
        );
        let result: WaitResult;
        try {
          result = await ops.wait(targets, {
            until,
            timeoutMs: timeout * 1000,
            turn,
            background,
            lines,
            signal: ctx.mcpReq.signal,
            onEvent: (e: WindowEvent) => {
              const w = where.get(e.ref);
              if (!w) return;
              if (e.type === "window.turn") w.turn = e.turn ?? null;
              else w.state = e.to ?? "stopped";
              report(describe());
            },
          });
        } finally {
          clearInterval(beat);
        }
        const head = result.reached
          ? `${result.ref} is ${result.state} after ${Math.round(result.waitedMs / 1000)}s`
          : result.state === null || result.state === "asleep"
            ? `${result.ref} is ${result.state ?? "not running"}`
            : `still ${result.state} after ${Math.round(result.waitedMs / 1000)}s${result.window.turn === "working" && result.state !== "busy" ? ", with its last command still running" : ""}; call vibe_wait again to keep waiting`;
        const others = result.windows
          ? `\n${result.windows.map((w) => `${w.ref}: ${w.state ?? "stopped"}${w.turn ? `, turn ${w.turn}` : ""}`).join("\n")}`
          : "";
        const hint =
          result.reached && result.state === "question"
            ? "\nIt is asking something: answer with vibe_send keys."
            : result.background
              ? "\nIt still has a command running in the background, and will answer again when that finishes. To wait for it, call vibe_wait with background: true."
              : "";
        return ok(
          `${head}${hint}${others}${result.text ? `\n\n${result.text}` : ""}`,
          { ...result },
        );
      } catch (err) {
        return explain(err);
      }
    },
  );

  server.registerTool(
    "vibe_read_messages",
    {
      title: "Read a conversation",
      description:
        "Reads the last messages of the conversation in a Claude window, from its transcript: what was asked, what it answered, and its tool calls in short form. The way to read an agent's final answer. Other harnesses: use vibe_read_output.",
      inputSchema: z.object({
        window: windowArg,
        last: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(DEFAULT_MESSAGES)
          .describe("How many messages, from the end. Default 10"),
      }),
      outputSchema: z.object({
        messages: z.array(
          z.object({
            role: z.enum(["user", "assistant", "tool"]),
            text: z.string(),
            at: z.number().nullable(),
          }),
        ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ window, last }) => {
      try {
        const messages = await ops.messages(windowOf(window), last);
        const text = messages
          .map((m) => `${m.role === "tool" ? "→" : `${m.role}:`} ${m.text}`)
          .join("\n\n");
        return ok(text || "no messages yet", { messages });
      } catch (err) {
        return explain(err, window);
      }
    },
  );

  server.registerTool(
    "vibe_close_window",
    {
      title: "Close a window",
      description: "Closes a window and ends what runs in it.",
      inputSchema: z.object({ window: windowArg }),
      outputSchema: z.object({ closed: z.string() }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ window }) => {
      try {
        const t = windowOf(window);
        await ops.close(t.windowId);
        return ok(`closed ${t.ref}`, { closed: t.ref });
      } catch (err) {
        return explain(err, window);
      }
    },
  );

  server.registerTool(
    "vibe_delete_workspace",
    {
      title: "Delete a workspace",
      description:
        "Ends every window in a workspace and removes its worktree. The branch is kept.",
      inputSchema: z.object({
        workspace: z
          .string()
          .describe("The workspace, by name or project/name"),
      }),
      outputSchema: z.object({ deleted: z.string() }),
      annotations: { destructiveHint: true },
    },
    async ({ workspace }) => {
      try {
        const ws = findWorkspace(ops.workspaces(), workspace);
        await ops.removeWorkspace(ws.id);
        return ok(`deleted ${ws.project}/${ws.name}; its branch is kept`, {
          deleted: `${ws.project}/${ws.name}`,
        });
      } catch (err) {
        return explain(err);
      }
    },
  );
}

/** The handler mounted at /mcp. Builds a server per request, as the SDK does. */
export function createMcpEndpoint(deps: McpDeps): McpHttpHandler {
  return createMcpHandler(() => {
    const server = new McpServer(
      { name: "vibe-os", version: pkg.version },
      { instructions: INSTRUCTIONS },
    );
    registerTools(server, deps);
    return server;
  });
}

/**
 * The route at `/mcp`. The front door has checked the token by then (see
 * front-door.ts), and turned a `?token=` into nothing.
 */
export function mcpRoute(
  endpoint: McpHttpHandler,
): (req: Request) => Promise<Response> {
  return (req) =>
    // Who the caller is, for the day tokens have scopes. There is one token
    // today, so there is one caller.
    endpoint.fetch(req, {
      authInfo: { token: "", clientId: "token", scopes: [] },
    });
}
