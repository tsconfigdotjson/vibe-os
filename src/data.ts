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
  create: (workspaceId: string) => send<WindowRow>(`/api/workspaces/${workspaceId}/windows`, 'POST'),
  patch: (id: string, patch: Partial<WindowRow> & { raise?: boolean }) =>
    send<WindowRow>(`/api/windows/${id}`, 'PATCH', patch),
  remove: (id: string) => send<{ ok: true }>(`/api/windows/${id}`, 'DELETE'),
};
