import { useState } from 'react';
import type { Workspace } from '../data';

export interface WorkspaceSidebarProps {
  workspaces: Workspace[];
  current: string | null;
  projectName: string | null;
  busy: boolean;
  error: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRemove: (id: string) => void;
}

function ago(then: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Workspaces for the selected project, most recently opened first.
 *
 * Each one is a git worktree on its own branch, so they are cheap to make and
 * safe to throw away — which is the point of naming them after nothing in
 * particular.
 */
export function WorkspaceSidebar({
  workspaces,
  current,
  projectName,
  busy,
  error,
  onSelect,
  onCreate,
  onRemove,
}: WorkspaceSidebarProps) {
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <aside className="sidebar">
      <header className="sidebar-head">
        <span className="sidebar-title">Workspaces</span>
        <button
          type="button"
          className="sidebar-new"
          onClick={onCreate}
          disabled={busy || !projectName}
          title="Create a git worktree on a new branch"
        >
          {busy ? '…' : '+'}
        </button>
      </header>

      {error ? <p className="sidebar-error">{error}</p> : null}

      {!projectName ? (
        <p className="sidebar-empty">Choose a project to see its workspaces.</p>
      ) : workspaces.length === 0 ? (
        <p className="sidebar-empty">
          No workspaces yet.{' '}
          <button type="button" className="linkish" onClick={onCreate}>
            Create one
          </button>{' '}
          to get a worktree and a branch.
        </p>
      ) : (
        <ul className="sidebar-list">
          {workspaces.map((ws) => (
            <li key={ws.id} data-active={ws.id === current || undefined}>
              {confirming === ws.id ? (
                // Deliberately built on the same `.ws` shape as a normal row, so
                // the name does not move and the block keeps the list's padding,
                // radius and type. Only the action bar is new — asking a
                // question about a row should not redraw it as a foreign object.
                <div className="ws ws-confirming">
                  <span className="ws-name">{ws.name}</span>
                  <span className="ws-meta">Delete this workspace? The branch is kept.</span>
                  <div className="ws-actions">
                    <button type="button" className="btn btn-quiet" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={() => {
                        onRemove(ws.id);
                        setConfirming(null);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className="ws"
                    data-active={ws.id === current || undefined}
                    onClick={() => onSelect(ws.id)}
                    title={ws.path}
                  >
                    <span className="ws-name">{ws.name}</span>
                    <span className="ws-meta">{ago(ws.lastOpenedAt)}</span>
                  </button>
                  <button
                    type="button"
                    className="ws-remove"
                    onClick={() => setConfirming(ws.id)}
                    title={`Remove ${ws.name} (the branch is kept)`}
                    aria-label={`Remove ${ws.name}`}
                  >
                    ✕
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
