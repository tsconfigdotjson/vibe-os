import { useEffect } from 'react';
import useSWR, { mutate as globalMutate } from 'swr';

/**
 * Server state.
 *
 * Everything that used to live in localStorage is here instead, so a desktop
 * follows you between browsers and machines. Polling is deliberately slow: a
 * VPS is not a realtime database, sidebars change when a person creates a
 * workspace, and a minute of staleness costs nothing. SWR also revalidates on
 * window focus, which covers the case that actually matters — coming back to
 * the tab after doing something in another one.
 */
export const POLL_MS = 60_000;

export interface Project {
  id: string;
  name: string;
  path: string;
  branch: string | null;
  remote: string | null;
  createdAt: number;
}

export interface Workspace {
  id: string;
  projectId: string;
  name: string;
  branch: string;
  path: string;
  createdAt: number;
  lastOpenedAt: number;
}

export type Harness = 'claude' | 'shell' | 'custom';

/** A role a terminal can be opened as. Defined per project. */
export interface Profile {
  id: string;
  projectId: string;
  name: string;
  /** Palette token; `--profile-<color>` in the stylesheet resolves it. */
  color: string;
  harness: Harness;
  command: string | null;
  /** argv tokens, already split and validated by the server. */
  args: string[];
  prompt: string;
  position: number;
  createdAt: number;
}

export interface WindowRow {
  id: string;
  workspaceId: string;
  idx: number;
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
  z: number;
  minimized: boolean;
  profileId: string | null;
  promptDone: boolean;
  /**
   * 'ssh' while this window's terminal belongs to a real terminal instead of
   * the desktop. Persisted, unlike a browser pop-out, because the point of it
   * is that you close the laptop and the terminal keeps running.
   */
  handoff: 'ssh' | null;
  handoffAt: number | null;
  /** A terminal has actually attached, so its departure is reaped at once. */
  handoffSeen: boolean;
  createdAt: number;
}

/** Mirrors AttachInfo in server/attach.ts. */
export interface AttachInfo {
  ref: string;
  session: string;
  cwd: string;
  workspace: string;
  project: string;
  role: string | null;
  endpoint: { user: string; host: string; port: number };
  /** The one command that gets you there. */
  command: string;
}

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}) as { error?: string });
    throw new Error(detail.error ?? `${url}: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}) as { error?: string });
    throw new Error(detail.error ?? `${url}: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function useProjects() {
  const { data, error, isLoading, mutate } = useSWR<Project[]>('/api/projects', fetcher, {
    refreshInterval: POLL_MS,
  });

  /** Walks the disk for repos. Only ever from the refresh button. */
  const rescan = async () => {
    const projects = await send<Project[]>('/api/projects/scan', 'POST');
    await mutate(projects, { revalidate: false });
    return projects;
  };

  return { projects: data ?? [], error, isLoading, rescan, mutate };
}

export function useWorkspaces(projectId: string | null) {
  const key = projectId ? `/api/projects/${projectId}/workspaces` : null;
  const { data, error, isLoading, mutate } = useSWR<Workspace[]>(key, fetcher, {
    refreshInterval: POLL_MS,
  });

  const create = async (name?: string) => {
    if (!projectId) throw new Error('no project selected');
    const created = await send<Workspace>(`/api/projects/${projectId}/workspaces`, 'POST', name ? { name } : {});
    await mutate();
    return created;
  };

  const remove = async (id: string) => {
    await send(`/api/workspaces/${id}`, 'DELETE');
    await mutate();
    await globalMutate(`/api/workspaces/${id}/windows`, [], { revalidate: false });
  };

  const touch = (id: string) => void send(`/api/workspaces/${id}`, 'POST').catch(() => {});

  return { workspaces: data ?? [], error, isLoading, create, remove, touch, mutate };
}

/**
 * Profiles for a project.
 *
 * Project-scoped rather than workspace-scoped: a role's prompt and flags
 * describe the codebase, while workspaces are worktrees you throw away. So the
 * same rail follows you across every workspace of a project.
 */
export function useProfiles(projectId: string | null) {
  const key = projectId ? `/api/projects/${projectId}/profiles` : null;
  const { data, error, isLoading, mutate } = useSWR<Profile[]>(key, fetcher, {
    refreshInterval: POLL_MS,
  });

  const create = async (input: ProfileInput) => {
    if (!projectId) throw new Error('no project selected');
    const created = await send<Profile>(`/api/projects/${projectId}/profiles`, 'POST', input);
    await mutate();
    return created;
  };

  const update = async (id: string, input: ProfileInput) => {
    const updated = await send<Profile>(`/api/profiles/${id}`, 'PATCH', input);
    await mutate();
    return updated;
  };

  const remove = async (id: string) => {
    await send(`/api/profiles/${id}`, 'DELETE');
    await mutate();
  };

  return { profiles: data ?? [], error, isLoading, create, update, remove, mutate };
}

/** What the installed Claude CLI on the server accepts. */
export interface HarnessInfo {
  available: boolean;
  version: string | null;
  aliases: string[];
  models: string[];
  permissionModes: string[];
  /** Values `--effort` accepts, weakest first — the order is the scale. */
  effortLevels: string[];
}

/**
 * Read from the binary on the server rather than hardcoded here.
 *
 * Claude ships models faster than this project ships anything, so a list baked
 * into the UI would be wrong within a release or two. Fetched once — it
 * describes an installed binary, which does not change while the page is open.
 */
export function useHarness() {
  const { data } = useSWR<HarnessInfo>('/api/harness/claude', fetcher, {
    revalidateOnFocus: false,
    refreshInterval: 0,
  });
  return data ?? null;
}

/** An MCP server configured on the box, as the profile editor sees it. */
export interface McpServer {
  name: string;
  /** `user` is machine-wide, `project` is the repo's `.mcp.json`, `local` is one directory. */
  scope: 'user' | 'project' | 'local';
  /** The file or directory it was defined in. */
  source: string;
  transport: string;
  /** URL, or the command it runs. */
  detail: string;
  /** The path a profile passes to `--mcp-config` for this one server. */
  configPath: string;
}

/**
 * MCP servers this project's profiles can be given.
 *
 * Project-scoped because a repo's `.mcp.json` is, and because a server added
 * inside one workspace is only visible from that directory. Not polled: it
 * changes when someone runs `claude mcp add` on the box, and reopening the
 * editor is already the moment you would look.
 */
export function useMcpServers(projectId: string | null) {
  const key = projectId ? `/api/projects/${projectId}/mcp` : null;
  const { data, isLoading } = useSWR<McpServer[]>(key, fetcher, {
    revalidateOnFocus: false,
    refreshInterval: 0,
  });
  return { servers: data ?? [], loading: isLoading };
}

/** What the editor sends. `args` is free text; the server tokenises it. */
export interface ProfileInput {
  name?: string;
  color?: string;
  harness?: Harness;
  command?: string | null;
  args?: string;
  prompt?: string;
}

/**
 * Windows for a workspace.
 *
 * Not polled. These change only because of something happening in this tab, and
 * a poll would fight the optimistic updates that make dragging feel immediate.
 */
export function useWindowRows(workspaceId: string | null) {
  const key = workspaceId ? `/api/workspaces/${workspaceId}/windows` : null;
  const { data, error, isLoading, mutate } = useSWR<WindowRow[]>(key, fetcher, {
    revalidateOnFocus: true,
    /*
     * Fast while something is handed to a terminal, slow otherwise.
     *
     * Not conditional on *this* tab already knowing about a handoff, which is
     * the trap: gate the poll on `handoff === 'ssh'` alone and a desktop only
     * ever polls once it has already found out, so a second tab or another
     * machine never learns at all. It keeps its terminal mounted, and then
     * there are two clients on one session — the size fight the whole
     * handoff exists to prevent. The baseline poll is what closes that, and
     * focus revalidation is what makes it immediate in the case that actually
     * happens: coming back to a tab you left.
     */
    refreshInterval: (latest) => (latest?.some((r) => r.handoff === 'ssh') ? 5_000 : POLL_MS),
  });

  /*
   * Tabs in one browser tell each other at once rather than waiting a minute.
   *
   * Same trick the pop-out uses, and for the same reason: two documents on one
   * origin with no shared state. This only nudges — the message carries no
   * data, so there is no second source of truth to disagree with the server,
   * and a tab that misses it still catches up on its own poll.
   */
  useEffect(() => {
    if (!workspaceId || typeof BroadcastChannel === 'undefined') return;
    const bc = new BroadcastChannel(WINDOWS_CHANNEL);
    bc.onmessage = (event: MessageEvent<{ workspaceId: string }>) => {
      if (event.data?.workspaceId === workspaceId) void mutate();
    };
    return () => bc.close();
  }, [workspaceId, mutate]);

  return { rows: data, error, isLoading, mutate, key };
}

const WINDOWS_CHANNEL = 'vibe-os:windows:v1';

/**
 * Tells other tabs a window's handoff changed, so they let go of its terminal.
 *
 * Sent on a channel of its own rather than a long-lived one, for the reason
 * usePopouts documents: a ref to a listening channel is null between an
 * effect's cleanup and its next run, and a send landing in that gap posts
 * nothing at all, silently.
 */
export function nudgeWindows(workspaceId: string): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const bc = new BroadcastChannel(WINDOWS_CHANNEL);
  bc.postMessage({ workspaceId });
  bc.close();
}

export const windowApi = {
  create: (workspaceId: string, profileId?: string | null) =>
    send<WindowRow>(`/api/workspaces/${workspaceId}/windows`, 'POST', { profileId: profileId ?? null }),
  patch: (id: string, patch: Partial<WindowRow> & { raise?: boolean }) =>
    send<WindowRow>(`/api/windows/${id}`, 'PATCH', patch),
  remove: (id: string) => send<{ ok: true }>(`/api/windows/${id}`, 'DELETE'),
  /** How to reach this window from a real terminal. Composes strings only. */
  attachInfo: (id: string) => fetcher<AttachInfo>(`/api/windows/${id}/attach`),
  /**
   * Hands the terminal to an ssh client, or takes it back — which detaches
   * whoever is attached, so the desktop never becomes a second client.
   */
  handoff: (id: string, mode: 'ssh' | null) => send<WindowRow>(`/api/windows/${id}/handoff`, 'POST', { mode }),
};
