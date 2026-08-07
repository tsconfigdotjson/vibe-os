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
  createdAt: number;
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
    revalidateOnFocus: false,
    refreshInterval: 0,
  });

  return { rows: data, error, isLoading, mutate, key };
}

export const windowApi = {
  create: (workspaceId: string, profileId?: string | null) =>
    send<WindowRow>(`/api/workspaces/${workspaceId}/windows`, 'POST', { profileId: profileId ?? null }),
  patch: (id: string, patch: Partial<WindowRow> & { raise?: boolean }) =>
    send<WindowRow>(`/api/windows/${id}`, 'PATCH', patch),
  remove: (id: string) => send<{ ok: true }>(`/api/windows/${id}`, 'DELETE'),
};
