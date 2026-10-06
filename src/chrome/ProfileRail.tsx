import type { Profile } from "../data";

export interface ProfileRailProps {
  profiles: Profile[];
  /** Profile ids with a window open in the current workspace. */
  running: Set<string>;
  /** The profile of the focused window, if it has one. */
  activeId: string | null;
  projectName: string | null;
  canOpen: boolean;
  /** Shows each profile's shortcut number, while one is being picked. */
  numbered: boolean;
  onOpen: (id: string, opts: { forceNew?: boolean }) => void;
  onEdit: (id: string) => void;
  onCreate: () => void;
}

/**
 * The roles you can open a terminal as, down the right of the workspace.
 *
 * Deliberately the mirror of the workspace sidebar rather than a second dock:
 * the left rail is *where* you are working, this one is *as whom*.
 *
 * It parks off the right edge between uses and slides back when the pointer
 * reaches that edge; the auto-hiding chrome block in the stylesheet has the
 * reasoning. The windows get the width the rest of the time.
 */
export function ProfileRail({
  profiles,
  running,
  activeId,
  projectName,
  canOpen,
  numbered,
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
          No profiles yet.{" "}
          <button type="button" className="linkish" onClick={onCreate}>
            Create one
          </button>{" "}
          to open a terminal with a harness and a prompt ready.
        </p>
      ) : (
        <ul className="rail-list">
          {profiles.map((profile, index) => {
            const live = running.has(profile.id);
            return (
              <li
                key={profile.id}
                style={{
                  ["--win-color" as string]: `var(--profile-${profile.color})`,
                }}
              >
                <button
                  type="button"
                  className="rail-item"
                  data-live={live || undefined}
                  data-active={profile.id === activeId || undefined}
                  disabled={!canOpen}
                  onClick={() => onOpen(profile.id, {})}
                  title={
                    live
                      ? `Bring ${profile.name} to the front`
                      : `Open a terminal as ${profile.name}`
                  }
                >
                  <span className="rail-chip" aria-hidden="true">
                    {numbered && index < 9 ? index + 1 : null}
                  </span>
                  <span className="rail-text">
                    <span className="rail-name">{profile.name}</span>
                    <span className="rail-meta">{profile.harness}</span>
                  </span>
                </button>
                {/* Wanting a second window as the same role is rare enough to
                    hide until you hover the row, but it is a button rather than
                    a modifier click — a chord nobody can see is not an
                    affordance, and on macOS alt is the terminal's anyway. */}
                {live ? (
                  <button
                    type="button"
                    className="rail-again"
                    onClick={() => onOpen(profile.id, { forceNew: true })}
                    title={`Open another ${profile.name}`}
                    aria-label={`Open another ${profile.name}`}
                  >
                    +
                  </button>
                ) : null}
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
