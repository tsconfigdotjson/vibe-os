import { useState } from "react";
import type { Workspace } from "../data";

export interface WorkspaceSidebarProps {
  workspaces: Workspace[];
  current: string | null;
  projectName: string | null;
  busy: boolean;
  error: string | null;
  /** Something the last creation should own up to. Not a failure. */
  note: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRemove: (id: string) => void;
}

/**
 * Evaluated during render, so it is only as fresh as the last one.
 *
 * Workspaces poll on POLL_MS, which re-renders this list roughly every minute
 * and keeps the numbers honest in practice. A sidebar that stops re-rendering
 * — the tab left in the background with polling paused — will show a stale
 * value until something else wakes it. That is accepted rather than driving a
 * second interval purely to retick a caption.
 */
function ago(then: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
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
  note,
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
          title="Create a git worktree on a new branch off origin"
        >
          {busy ? <span className="spinner" aria-hidden="true" /> : "+"}
        </button>
      </header>

      {/* Creating one fetches origin first, which is the slow part and the part
          worth naming: seconds of nothing happening reads as a broken button,
          and "fetching origin" is also the reason the branch is worth having. */}
      {busy ? (
        <p className="sidebar-busy" role="status">
          Fetching origin, then branching from its default branch…
        </p>
      ) : null}

      {error ? <p className="sidebar-error">{error}</p> : null}
      {note ? <p className="sidebar-note">{note}</p> : null}

      {!projectName ? (
        <p className="sidebar-empty">Choose a project to see its workspaces.</p>
      ) : workspaces.length === 0 ? (
        <p className="sidebar-empty">
          No workspaces yet.{" "}
          {/* Disabled while busy for the same reason as the "+" above it: the
              wait is a fetch now, and this is the button shown during the
              longest one, so an impatient second click is two worktrees. */}
          <button
            type="button"
            className="linkish"
            onClick={onCreate}
            disabled={busy}
          >
            Create one
          </button>{" "}
          to get a worktree and a branch.
        </p>
      ) : (
        <ul className="sidebar-list">
          {workspaces.map((ws) => (
            <li key={ws.id}>
              {confirming === ws.id ? (
                // Deliberately built on the same `.ws` shape as a normal row, so
                // the name does not move and the block keeps the list's padding,
                // radius and type. Only the action bar is new — asking a
                // question about a row should not redraw it as a foreign object.
                <div className="ws ws-confirming">
                  <span className="ws-name">{ws.name}</span>
                  <span className="ws-meta">
                    Delete this workspace? The branch is kept.
                  </span>
                  <div className="ws-actions">
                    <button
                      type="button"
                      className="btn btn-quiet"
                      onClick={() => setConfirming(null)}
                    >
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
