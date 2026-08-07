import type { Profile } from '../data';

export interface ProfileRailProps {
  profiles: Profile[];
  /** Profile ids with a window open in the current workspace. */
  running: Set<string>;
  /** The profile of the focused window, if it has one. */
  activeId: string | null;
  projectName: string | null;
  canOpen: boolean;
  onOpen: (id: string, opts: { forceNew?: boolean }) => void;
  onEdit: (id: string) => void;
  onCreate: () => void;
}

const HARNESS_LABEL: Record<Profile['harness'], string> = {
  claude: 'claude',
  shell: 'shell',
  custom: 'custom',
};

/**
 * The roles you can open a terminal as, down the right of the workspace.
 *
 * Deliberately the mirror of the workspace sidebar rather than a second dock:
 * the left rail is *where* you are working, this one is *as whom*. Both are
 * lists of things you switch between, so they read as a matched pair holding
 * the surface between them.
 */
export function ProfileRail({
  profiles,
  running,
  activeId,
  projectName,
  canOpen,
  onOpen,
  onEdit,
  onCreate,
}: ProfileRailProps) {
  return (
    <aside className="rail">
      <header className="rail-head">
        <span className="rail-title">Profiles</span>
        <button
          type="button"
          className="rail-new"
          onClick={onCreate}
          disabled={!projectName}
          title="Create a profile"
        >
          +
        </button>
      </header>

      {!projectName ? (
        <p className="rail-empty">Choose a project to see its profiles.</p>
      ) : profiles.length === 0 ? (
        <p className="rail-empty">
          No profiles yet.{' '}
          <button type="button" className="linkish" onClick={onCreate}>
            Create one
          </button>{' '}
          to open a terminal with a harness and a prompt ready.
        </p>
      ) : (
        <ul className="rail-list">
          {profiles.map((profile) => {
            const live = running.has(profile.id);
            return (
              <li key={profile.id} style={{ ['--win-color' as string]: `var(--profile-${profile.color})` }}>
                <button
                  type="button"
                  className="rail-item"
                  data-live={live || undefined}
                  data-active={profile.id === activeId || undefined}
                  disabled={!canOpen}
                  // Alt-click is the "I meant a second one" escape hatch, and it
                  // matches the alt chords the desktop already uses for windows.
                  onClick={(event) => onOpen(profile.id, { forceNew: event.altKey })}
                  title={
                    live
                      ? `Bring ${profile.name} to the front  (alt-click for another)`
                      : `Open a terminal as ${profile.name}`
                  }
                >
                  <span className="rail-chip" aria-hidden="true" />
                  <span className="rail-text">
                    <span className="rail-name">{profile.name}</span>
                    <span className="rail-meta">{HARNESS_LABEL[profile.harness]}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="rail-edit"
                  onClick={() => onEdit(profile.id)}
                  title={`Edit ${profile.name}`}
                  aria-label={`Edit ${profile.name}`}
                >
                  ⋯
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
