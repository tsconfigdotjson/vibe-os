import { useEffect } from "react";
import useSWR, { mutate as globalMutate } from "swr";
import type {
  AttachInfo,
  Harness,
  HarnessReport,
  HarnessSpec,
  McpServer,
  MemoryReport,
  Profile,
  ProfileInput,
} from "../shared/wire";
import type { ServerConfig } from "./api";
import { postOnce } from "./broadcast";

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

/**
 * What a caught `unknown` should say to a person. Mirrors `describeError` in
 * `server/log.ts`; the two halves cannot share a module because this one has to
 * survive into the browser bundle.
 */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

/**
 * What creating one answers with, which is not a workspace row: it also says
 * where the branch was cut from, because that involves a fetch that can be slow
 * and can fail without stopping the creation.
 */
export interface CreatedWorkspace {
  id: string;
  name: string;
  branch: string;
  path: string;
  /** The ref the branch starts at, "origin/main" for a normal project. */
  base: string;
  /** Set when the base may be stale, e.g. origin could not be reached. */
  warning: string | null;
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
  handoff: "ssh" | null;
  handoffAt: number | null;
  /** A terminal has actually attached, so its departure is reaped at once. */
  handoffSeen: boolean;
  /**
   * 'ask' when the session died under the window, by a restart or a kill, and
   * the desktop should offer to bring it back before starting a new one.
   */
  restore: "ask" | "resume" | null;
  createdAt: number;
}

/** Mirrors AttachInfo in server/attach.ts. */

/**
 * One way to talk to the API.
 *
 * Every handler on the server answers a failure with `{ error }` and a status,
 * so the only correct read of a response is: check `ok`, then unwrap `error`
 * for the message. Anything that skips the `ok` check hands the caller an error
 * object typed as the success shape — which is how a 401 once reached
 * `WallpaperPanel` as a `Wallpaper[]` and blew up in `.map()`.
 *
 * `init` carries a raw body (a File upload) and its own headers; JSON callers
 * pass `body` and get it serialised.
 */
export async function request<T>(
  url: string,
  options: {
    method?: string;
    body?: unknown;
    raw?: BodyInit;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  const { method = "GET", body, raw, headers } = options;
  const res = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  if (!res.ok) {
    const detail = await res
      .json()
      .catch(() => ({}) as Record<string, unknown>);
    throw new ApiError(
      typeof detail.error === "string"
        ? detail.error
        : `${url}: HTTP ${res.status}`,
      res.status,
      detail,
    );
  }
  // 204 and friends have no body; the callers that expect nothing pass `void`.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** A failed request, keeping the status and body for callers that branch on them. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

const fetcher = <T>(url: string): Promise<T> => request<T>(url);

const send = <T>(url: string, method: string, body?: unknown): Promise<T> =>
  request<T>(url, { method, body });

/**
 * The server config, fetched once.
 *
 * Three components did this by hand — the desktop, the pop-out and the handoff
 * panel — each with its own `cancelled` flag and its own error state, nine
 * lines apiece. Through SWR they share one cache entry, which also means a
 * pop-out open beside the desktop does not fetch it twice.
 */
export function useServerConfig() {
  const { data, error } = useSWR<ServerConfig>("/api/config", fetcher, {
    // It describes the running server; it does not change while a page is open.
    revalidateOnFocus: false,
    revalidateIfStale: false,
  });
  // index.html ships a default so a cold load is not white; this replaces it
  // with the configured one, which is what makes two instances distinguishable.
  useEffect(() => {
    if (!data?.themeColor) return;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", data.themeColor);
  }, [data?.themeColor]);

  return {
    server: data ?? null,
    error: error ? describeError(error) : null,
  };
}

export function useProjects() {
  const { data, error, isLoading, mutate } = useSWR<Project[]>(
    "/api/projects",
    fetcher,
    {
      refreshInterval: POLL_MS,
    },
  );

  /** Walks the disk for repos. Only ever from the refresh button. */
  const rescan = async () => {
    const projects = await send<Project[]>("/api/projects/scan", "POST");
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
    if (!projectId) throw new Error("no project selected");
    const created = await send<CreatedWorkspace>(
      `/api/projects/${projectId}/workspaces`,
      "POST",
      name ? { name } : {},
    );
    await mutate();
    return created;
  };

  const remove = async (id: string) => {
    await send(`/api/workspaces/${id}`, "DELETE");
    await mutate();
    await globalMutate(`/api/workspaces/${id}/windows`, [], {
      revalidate: false,
    });
  };

  const touch = (id: string) =>
    void send(`/api/workspaces/${id}`, "POST").catch(() => {});

  return {
    workspaces: data ?? [],
    error,
    isLoading,
    create,
    remove,
    touch,
    mutate,
  };
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
    if (!projectId) throw new Error("no project selected");
    const created = await send<Profile>(
      `/api/projects/${projectId}/profiles`,
      "POST",
      input,
    );
    await mutate();
    return created;
  };

  const update = async (id: string, input: ProfileInput) => {
    const updated = await send<Profile>(`/api/profiles/${id}`, "PATCH", input);
    await mutate();
    return updated;
  };

  const remove = async (id: string) => {
    await send(`/api/profiles/${id}`, "DELETE");
    await mutate();
  };

  return {
    profiles: data ?? [],
    error,
    isLoading,
    create,
    update,
    remove,
    mutate,
  };
}

/**
 * Every harness a profile can launch, as the specs the editor renders.
 *
 * Fetched once: the list is the server's built-ins plus the box's own
 * `harnesses/*.json`, and both are read when the server starts.
 */
export function useHarnesses(): HarnessSpec[] | null {
  const { data } = useSWR<HarnessSpec[]>("/api/harnesses", fetcher, {
    revalidateOnFocus: false,
    refreshInterval: 0,
  });
  return data ?? null;
}

/**
 * What one harness found on the box: models and options read off the installed
 * binary, its defaults, whether it is logged in.
 *
 * Read from the server rather than hardcoded here. Models ship faster than this
 * project does, and some answers (a provider list, a login) belong to the box.
 * Fetched once per harness: it describes an installed binary, which does not
 * change while the page is open.
 */
export function useHarnessReport(id: string | null): HarnessReport | null {
  const { data } = useSWR<HarnessReport>(
    id ? `/api/harness/${encodeURIComponent(id)}` : null,
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 0 },
  );
  return data ?? null;
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
    refreshInterval: (latest) =>
      latest?.some((r) => r.handoff === "ssh") ? 5_000 : POLL_MS,
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
    if (!workspaceId || typeof BroadcastChannel === "undefined") return;
    const bc = new BroadcastChannel(WINDOWS_CHANNEL);
    bc.onmessage = (event: MessageEvent<{ workspaceId: string }>) => {
      if (event.data?.workspaceId === workspaceId) void mutate();
    };
    return () => bc.close();
  }, [workspaceId, mutate]);

  return { rows: data, error, isLoading, mutate, key };
}

const WINDOWS_CHANNEL = "vibe-os:windows:v1";

/**
 * Tells other tabs a window's handoff changed, so they let go of its terminal.
 * Its own channel, posted through `postOnce` — see there for why.
 */
export function nudgeWindows(workspaceId: string): void {
  postOnce(WINDOWS_CHANNEL, { workspaceId });
}

/**
 * What the box has and what each window in the workspace costs.
 *
 * Polled, unlike the window rows: memory moves on its own, and the point of
 * showing it is to see it climb. SWR skips the poll while the tab is hidden.
 */
export const MEMORY_POLL_MS = 10_000;

export function useMemory(workspaceId: string | null) {
  const key = workspaceId ? `/api/workspaces/${workspaceId}/memory` : null;
  const { data } = useSWR<MemoryReport>(key, fetcher, {
    refreshInterval: MEMORY_POLL_MS,
  });
  return data ?? null;
}

export const windowApi = {
  /**
   * `force` opens it even when the server says the box cannot fit another
   * agent, which it answers with a 409 carrying `capacity: true`.
   */
  create: (workspaceId: string, profileId?: string | null, force = false) =>
    send<WindowRow>(`/api/workspaces/${workspaceId}/windows`, "POST", {
      profileId: profileId ?? null,
      ...(force ? { force: true } : {}),
    }),
  patch: (id: string, patch: Partial<WindowRow> & { raise?: boolean }) =>
    send<WindowRow>(`/api/windows/${id}`, "PATCH", patch),
  remove: (id: string) => send<{ ok: true }>(`/api/windows/${id}`, "DELETE"),
  /** How to reach this window from a real terminal. Composes strings only. */
  attachInfo: (id: string) => fetcher<AttachInfo>(`/api/windows/${id}/attach`),
  /**
   * Hands the terminal to an ssh client, or takes it back — which detaches
   * whoever is attached, so the desktop never becomes a second client.
   */
  handoff: (id: string, mode: "ssh" | null) =>
    send<WindowRow>(`/api/windows/${id}/handoff`, "POST", { mode }),
  /** Brings back a window whose session died, resuming its conversation or not. */
  restore: (id: string, resume: boolean) =>
    send<WindowRow>(`/api/windows/${id}/restore`, "POST", { resume }),
};

export type {
  AttachInfo,
  Harness,
  HarnessReport,
  HarnessSpec,
  McpServer,
  MemoryReport,
  Profile,
  ProfileInput,
};
