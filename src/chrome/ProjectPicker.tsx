import { useEffect, useRef, useState } from 'react';
import type { Project } from '../data';

export interface ProjectPickerProps {
  projects: Project[];
  current: Project | null;
  scanning: boolean;
  onSelect: (id: string) => void;
  onRescan: () => void;
}

/** Strips a git remote down to `owner/repo` for display. */
function shortRemote(remote: string | null): string | null {
  if (!remote) return null;
  const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(remote.trim());
  return match ? match[1] : null;
}

export function ProjectPicker({ projects, current, scanning, onSelect, onRescan }: ProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Close on an outside click or Escape — a dropdown that traps you is worse
  // than no dropdown.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div className="picker" ref={root}>
      <button
        type="button"
        className="picker-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={current?.path ?? 'Choose a project'}
      >
        <span className="picker-mark" aria-hidden="true" />
        <span className="picker-label">{current?.name ?? 'No project'}</span>
        {current?.branch ? <span className="picker-branch">{current.branch}</span> : null}
        <span className="picker-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open ? (
        <div className="picker-menu glass-solid" role="listbox">
          <div className="picker-head">
            <span>Projects</span>
            <button
              type="button"
              className="picker-refresh"
              onClick={() => onRescan()}
              disabled={scanning}
              title="Scan the machine for git repositories"
            >
              {scanning ? 'scanning…' : 'refresh'}
            </button>
          </div>

          {projects.length === 0 ? (
            <p className="picker-empty">
              No git repositories found. Clone one, then press refresh.
            </p>
          ) : (
            <ul className="picker-list">
              {projects.map((project) => {
                const remote = shortRemote(project.remote);
                return (
                  <li key={project.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={project.id === current?.id}
                      data-active={project.id === current?.id || undefined}
                      onClick={() => {
                        onSelect(project.id);
                        setOpen(false);
                      }}
                      title={project.path}
                    >
                      <span className="picker-name">{project.name}</span>
                      <span className="picker-meta">{remote ?? project.path}</span>
                      {project.branch ? <span className="picker-tag">{project.branch}</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
