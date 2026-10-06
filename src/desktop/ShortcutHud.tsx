import { LEADER_LABEL, type ShortcutMode } from "./useShortcuts";

const KEYS: [string, string][] = [
  ["1–9", "window"],
  ["← →", "next window"],
  ["↑ ↓", "workspace"],
  ["p", "profile"],
  ["t", "new terminal"],
  ["m", "minimise"],
  ["f", "fill"],
  ["g", "tile"],
];

/**
 * What the next key will do, shown while one is awaited.
 *
 * Always shown rather than after a pause: the keys are few enough to read at a
 * glance, and there is no other place on screen they are written down.
 */
export function ShortcutHud({
  mode,
  profiles,
}: {
  mode: Exclude<ShortcutMode, "idle">;
  /** How many profiles the rail has, for the profile prompt. */
  profiles: number;
}) {
  return (
    <div className="keys-hud glass-solid" role="status">
      <span className="keys-lead">
        <kbd>{LEADER_LABEL}</kbd>
        {mode === "profile" ? <kbd>p</kbd> : null}
      </span>
      {mode === "profile" ? (
        <span className="keys-prompt">
          {profiles === 0
            ? "No profiles in this project."
            : profiles === 1
              ? "Press 1 for the profile."
              : `Press a profile's number, 1–${Math.min(profiles, 9)}.`}
        </span>
      ) : (
        <ul className="keys-list">
          {KEYS.map(([key, what]) => (
            <li key={key}>
              <kbd>{key}</kbd>
              <span>{what}</span>
            </li>
          ))}
        </ul>
      )}
      <span className="keys-esc">
        <kbd>esc</kbd>
      </span>
    </div>
  );
}
