import { useMemo, useState } from 'react';
import type { Harness, Profile, ProfileInput } from '../data';

export interface ProfilePanelProps {
  /** The profile being edited, or null when creating a new one. */
  profile: Profile | null;
  palette: readonly string[];
  onSave: (input: ProfileInput) => Promise<unknown>;
  onDelete: (() => Promise<unknown>) | null;
  onClose: () => void;
}

const HARNESSES: { value: Harness; label: string; hint: string }[] = [
  { value: 'claude', label: 'Claude', hint: 'runs `claude` in the worktree' },
  { value: 'shell', label: 'Shell', hint: 'a plain shell, tinted and named' },
  { value: 'custom', label: 'Custom', hint: 'any command on the box' },
];

/**
 * A few flags worth one click. Everything else goes in the arguments field.
 *
 * Kept short on purpose: a long hardcoded list of someone else's CLI flags is a
 * list that quietly goes stale, and the free-text field already accepts
 * anything the harness understands.
 */
const CLAUDE_CHIPS = [
  { flag: '--dangerously-skip-permissions', label: 'skip permissions', warn: true },
  { flag: '--continue', label: 'continue last' },
  { flag: '--verbose', label: 'verbose' },
];

/** Mirrors the server's `detokenize` so the field round-trips what was saved. */
function argsToText(tokens: string[]): string {
  return tokens
    .map((t) => (t === '' || /[\s"']/.test(t) ? `'${t.replaceAll("'", `'\\''`)}'` : t))
    .join(' ');
}

export function ProfilePanel({ profile, palette, onSave, onDelete, onClose }: ProfilePanelProps) {
  const [name, setName] = useState(profile?.name ?? '');
  const [color, setColor] = useState(profile?.color ?? palette[0] ?? 'cyan');
  const [harness, setHarness] = useState<Harness>(profile?.harness ?? 'claude');
  const [command, setCommand] = useState(profile?.command ?? '');
  const [args, setArgs] = useState(argsToText(profile?.args ?? ['--dangerously-skip-permissions']));
  const [prompt, setPrompt] = useState(profile?.prompt ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Chip state is derived from the text rather than tracked alongside it, so
  // typing a flag by hand lights its chip and there is only one source of truth.
  const tokens = useMemo(() => args.split(/\s+/).filter(Boolean), [args]);

  const toggleFlag = (flag: string) => {
    setArgs((current) => {
      const present = current.split(/\s+/).filter(Boolean);
      return present.includes(flag)
        ? present.filter((t) => t !== flag).join(' ')
        : [...present, flag].join(' ');
    });
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave({ name, color, harness, command: harness === 'custom' ? command : null, args, prompt });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside
        className="panel glass-solid panel-wide"
        role="dialog"
        aria-label={profile ? `Edit ${profile.name}` : 'New profile'}
        style={{ ['--win-color' as string]: `var(--profile-${color})` }}
      >
        <header className="panel-head">
          <h2>{profile ? profile.name : 'New profile'}</h2>
          <button type="button" onClick={onClose} title="Close">
            ✕
          </button>
        </header>

        {error ? <p className="panel-error">{error}</p> : null}

        <div className="field">
          <label htmlFor="profile-name">Name</label>
          <input
            id="profile-name"
            className="text-input"
            value={name}
            maxLength={40}
            placeholder="Backend Manager"
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="field">
          <label>Colour</label>
          {/* The same colour tints the window, its title bar and its rail entry,
              which is what makes three roles distinguishable without reading. */}
          <div className="swatches">
            {palette.map((token) => (
              <button
                key={token}
                type="button"
                className="swatch"
                data-active={token === color || undefined}
                style={{ background: `var(--profile-${token})` }}
                onClick={() => setColor(token)}
                title={token}
                aria-label={token}
              />
            ))}
          </div>
        </div>

        <div className="field">
          <label>Harness</label>
          <div className="segmented">
            {HARNESSES.map((option) => (
              <button
                key={option.value}
                type="button"
                data-active={harness === option.value || undefined}
                onClick={() => setHarness(option.value)}
                title={option.hint}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {harness === 'custom' ? (
          <div className="field">
            <label htmlFor="profile-command">Command</label>
            <input
              id="profile-command"
              className="text-input mono"
              value={command}
              placeholder="/usr/local/bin/my-agent"
              onChange={(event) => setCommand(event.target.value)}
            />
          </div>
        ) : null}

        {harness !== 'shell' ? (
          <div className="field">
            <label htmlFor="profile-args">Arguments</label>
            {harness === 'claude' ? (
              <div className="chips">
                {CLAUDE_CHIPS.map((chip) => (
                  <button
                    key={chip.flag}
                    type="button"
                    className="chip"
                    data-active={tokens.includes(chip.flag) || undefined}
                    data-warn={chip.warn || undefined}
                    onClick={() => toggleFlag(chip.flag)}
                    title={chip.flag}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            ) : null}
            <input
              id="profile-args"
              className="text-input mono"
              value={args}
              placeholder="--model opus"
              onChange={(event) => setArgs(event.target.value)}
            />
            <p className="field-hint">
              Split like a shell would, quotes included — but run as a list, so a <code>;</code> inside an
              argument stays part of that argument.
            </p>
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="profile-prompt">Prompt</label>
          <textarea
            id="profile-prompt"
            className="text-input prompt-input"
            value={prompt}
            rows={8}
            placeholder="You are the backend manager for this repo…"
            onChange={(event) => setPrompt(event.target.value)}
          />
          <p className="field-hint">Offered above the terminal each time you open this profile.</p>
        </div>

        <div className="panel-actions">
          {onDelete ? (
            confirming ? (
              <>
                <span className="panel-ask">Delete this profile?</span>
                <button type="button" className="btn btn-quiet" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => void onDelete().then(onClose)}
                >
                  Delete
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-quiet panel-delete" onClick={() => setConfirming(true)}>
                Delete
              </button>
            )
          ) : null}

          {!confirming ? (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
              {busy ? 'saving…' : profile ? 'Save' : 'Create'}
            </button>
          ) : null}
        </div>

        {onDelete ? (
          <p className="field-hint panel-foot">
            Deleting keeps any window already running this profile — it just becomes an ordinary terminal.
          </p>
        ) : null}
      </aside>
    </>
  );
}
