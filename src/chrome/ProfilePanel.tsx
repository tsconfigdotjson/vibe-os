import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { detokenize } from "../../shared/args";
import { countBlanks } from "../../shared/blanks";
import {
  buildArgs,
  type ChoiceOption,
  CUSTOM,
  type FlagSettings,
  initialSettings,
  type McpField,
  type McpMode,
  parseArgs,
  type SelectField,
  SHELL,
} from "../../shared/harness";
import type {
  Harness,
  HarnessReport,
  HarnessSpec,
  McpServer,
  Profile,
  ProfileInput,
} from "../data";
import { describeError, useHarnessReport } from "../data";

export interface ProfilePanelProps {
  /** The profile being edited, or null when creating a new one. */
  profile: Profile | null;
  palette: readonly string[];
  /** The server's scope limits, shown as what an empty field means. */
  memoryDefaults: { high: string | null; max: string | null };
  /** Every harness the server knows, or null while it is still being read. */
  harnesses: HarnessSpec[] | null;
  /** MCP servers configured on the box, for this project. */
  mcpServers: McpServer[];
  onSave: (input: ProfileInput) => Promise<unknown>;
  onDelete: (() => Promise<unknown>) | null;
  onClose: () => void;
}

const MCP_MODES: { value: McpMode; label: string }[] = [
  { value: "all", label: "Everything configured on this box" },
  { value: "pick", label: "Only the ones I pick" },
  { value: "none", label: "None — no MCP servers at all" },
];

/** Where a server is defined, said in a couple of words under its name. */
const SCOPE_NOTE: Record<McpServer["scope"], string> = {
  user: "this box",
  project: "the repo",
  local: "one directory",
};

/** Text from a spec or a report, with `backticks` shown as code. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, i) =>
        // Odd segments sat between a pair of backticks.
        i % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the split is fixed for a given text
          <code key={i}>{part}</code>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the split is fixed for a given text
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/** The command a harness runs, as the advanced preview shows it. */
const commandLine = (spec: HarnessSpec) =>
  [spec.command, ...(spec.leading ?? [])].join(" ");

/**
 * One select field: a dropdown when there is something to pick from, a typed
 * field with suggestions when the spec says free or there is nothing to offer.
 *
 * Every form makes the same round-trip guarantee: a stored value this build has
 * not heard of is offered back rather than reset, so opening and saving a
 * profile never changes what it runs.
 */
function SelectControl({
  spec,
  field,
  report,
  settings,
  patch,
}: {
  spec: HarnessSpec;
  field: SelectField;
  report: HarnessReport | null;
  settings: FlagSettings;
  patch: (next: Partial<FlagSettings>) => void;
}) {
  const id = `${spec.id}-${field.key}`;
  const value = settings.values[field.key] ?? "";
  const options: ChoiceOption[] =
    report?.options[field.key] ?? field.options ?? [];
  const specials = field.specials ?? [];
  const fallback = report?.defaults[field.key];
  const none = fallback
    ? `Default — ${fallback}`
    : (field.none ?? `Default — whatever ${spec.label} picks`);
  const typed = field.free || (options.length === 0 && specials.length === 0);
  const special = specials.find((s) => s.value === value);
  const set = (next: string) =>
    patch({ values: { ...settings.values, [field.key]: next } });

  // Ungrouped first, then each group in the order it first appears.
  const groups = [...new Set(options.map((o) => o.group ?? ""))];
  const known =
    options.some((o) => o.value === value) ||
    specials.some((s) => s.value === value);

  const control = typed ? (
    <>
      <input
        id={id}
        className="text-input mono"
        list={options.length > 0 ? `${id}-options` : undefined}
        value={value}
        placeholder={
          fallback
            ? `Default — ${fallback}`
            : (field.placeholder ?? `Default — whatever ${spec.label} picks`)
        }
        onChange={(event) => set(event.target.value)}
      />
      {options.length > 0 ? (
        <datalist id={`${id}-options`}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </datalist>
      ) : null}
    </>
  ) : (
    <select
      id={id}
      className="text-input select"
      data-warn={special?.warn ? true : undefined}
      value={value}
      onChange={(event) => set(event.target.value)}
    >
      <option value="">{none}</option>
      {groups.map((group) => {
        const items = options
          .filter((o) => (o.group ?? "") === group)
          .map((o) => (
            <option key={o.value} value={o.value}>
              {o.label ?? o.value}
            </option>
          ));
        return group ? (
          <optgroup key={group} label={group}>
            {items}
          </optgroup>
        ) : (
          <Fragment key="">{items}</Fragment>
        );
      })}
      {specials.map((s) => (
        <option key={s.value} value={s.value}>
          {s.label}
        </option>
      ))}
      {value && !known ? <option value={value}>{value}</option> : null}
    </select>
  );

  const hint =
    options.length === 0 && field.emptyHint ? field.emptyHint : field.hint;

  return (
    <div className="field">
      <label htmlFor={id}>{field.label}</label>
      {field.suffix ? (
        <div className="row">
          {control}
          <label className="check" title={field.suffix.hint}>
            <input
              type="checkbox"
              checked={Boolean(settings.suffixes[field.key])}
              disabled={!value}
              onChange={(event) =>
                patch({
                  suffixes: {
                    ...settings.suffixes,
                    [field.key]: event.target.checked,
                  },
                })
              }
            />
            {field.suffix.label}
          </label>
        </div>
      ) : (
        control
      )}
      {hint ? (
        <p className="field-hint">
          <Rich text={hint} />
        </p>
      ) : null}
      {special?.warn ? (
        <p className="field-hint field-warn">{special.warn}</p>
      ) : null}
    </div>
  );
}

/** Which of the box's MCP servers a session gets. */
function McpControl({
  spec,
  field,
  servers,
  settings,
  patch,
}: {
  spec: HarnessSpec;
  field: McpField;
  servers: McpServer[];
  settings: FlagSettings;
  patch: (next: Partial<FlagSettings>) => void;
}) {
  const id = `${spec.id}-${field.key}`;
  /**
   * Selections whose server is not on the box.
   *
   * A profile can outlive the server it named. Showing the leftover path as
   * its own row keeps it visible and keeps it selected; dropping it silently
   * would change what the profile does without saying so.
   */
  const strays = settings.mcpConfigs.filter(
    (p) => !servers.some((s) => s.configPath === p),
  );
  const toggle = (configPath: string, on: boolean) =>
    patch({
      // Rebuilt from the discovered order rather than appended to, so the
      // command line does not depend on the order boxes were clicked in.
      mcpConfigs: [
        ...servers
          .map((s) => s.configPath)
          .filter((p) =>
            p === configPath ? on : settings.mcpConfigs.includes(p),
          ),
        ...strays.filter((p) => p !== configPath || on),
      ],
    });

  return (
    <div className="field">
      <label htmlFor={id}>{field.label}</label>
      <select
        id={id}
        className="text-input select"
        value={settings.mcp}
        onChange={(event) => patch({ mcp: event.target.value as McpMode })}
      >
        {MCP_MODES.map((mode) => (
          <option key={mode.value} value={mode.value}>
            {mode.label}
          </option>
        ))}
      </select>

      {settings.mcp === "pick" ? (
        servers.length > 0 || strays.length > 0 ? (
          <div className="mcp-list">
            {servers.map((server) => (
              <label
                key={server.configPath}
                className="check mcp-item"
                // The row shows what a name cannot: two servers called the
                // same thing are told apart by where they point and which file
                // says so.
                title={[server.detail, `defined in ${server.source}`]
                  .filter(Boolean)
                  .join("\n")}
              >
                <input
                  type="checkbox"
                  checked={settings.mcpConfigs.includes(server.configPath)}
                  onChange={(event) =>
                    toggle(server.configPath, event.target.checked)
                  }
                />
                <span className="mcp-name">{server.name}</span>
                <span className="mcp-meta">
                  {server.transport} · {SCOPE_NOTE[server.scope]}
                </span>
              </label>
            ))}
            {strays.map((configPath) => (
              <label
                key={configPath}
                className="check mcp-item"
                title={configPath}
              >
                <input
                  type="checkbox"
                  checked
                  onChange={() => toggle(configPath, false)}
                />
                <span className="mcp-name mcp-stray">
                  {configPath.split("/").pop()}
                </span>
                <span className="mcp-meta field-warn">not on this box</span>
              </label>
            ))}
          </div>
        ) : field.emptyHint ? (
          <p className="field-hint">
            <Rich text={field.emptyHint} />
          </p>
        ) : null
      ) : null}

      {settings.mcp === "pick" &&
      settings.mcpConfigs.length === 0 &&
      servers.length > 0 ? (
        <p className="field-hint">
          Nothing picked, so this profile gets no MCP servers at all.
        </p>
      ) : null}
      {settings.mcp === "none" ? (
        <p className="field-hint">
          Fewer tools to choose between, and a shorter prompt. Worth it for a
          role that only reads and writes code.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Everything the editor shows for one harness, rendered from its spec.
 *
 * Selects and the MCP picker in spec order, then what the box said about
 * itself, then the switches, then the advanced field with everything the
 * controls do not own.
 */
function HarnessControls({
  spec,
  report,
  servers,
  settings,
  patch,
}: {
  spec: HarnessSpec;
  report: HarnessReport | null;
  servers: McpServer[];
  settings: FlagSettings;
  patch: (next: Partial<FlagSettings>) => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const composed = useMemo(() => buildArgs(spec, settings), [spec, settings]);
  const toggles = spec.fields.filter((f) => f.kind === "toggle");

  // Facts about the box, not about this profile, so said rather than offered
  // as controls that would imply a choice the profile does not have.
  const notes: { label: string; text: string; warn?: boolean }[] = [];
  if (report && !report.available) {
    notes.push({
      label: "Install",
      text: `${spec.label} is not installed here, so this profile opens a window that closes immediately. \`vibe-os doctor\` has the install line.`,
      warn: true,
    });
  } else if (report?.loggedIn === false && spec.login) {
    notes.push({
      label: "Account",
      text: `Not logged in, so this profile opens a window that sits at the login prompt. Run \`${spec.login.fix}\` on the box.`,
      warn: true,
    });
  }
  notes.push(...(report?.notes ?? []));

  return (
    <>
      {spec.fields.map((field) =>
        field.kind === "select" ? (
          <SelectControl
            key={field.key}
            spec={spec}
            field={field}
            report={report}
            settings={settings}
            patch={patch}
          />
        ) : field.kind === "mcp" ? (
          <McpControl
            key={field.key}
            spec={spec}
            field={field}
            servers={servers}
            settings={settings}
            patch={patch}
          />
        ) : null,
      )}

      {notes.map((note) => (
        <div className="field" key={`${note.label}:${note.text}`}>
          <span className="field-label">{note.label}</span>
          <p className="field-hint">
            {note.warn ? (
              <span className="field-warn">
                <Rich text={note.text} />
              </span>
            ) : (
              <Rich text={note.text} />
            )}
          </p>
        </div>
      ))}

      {toggles.length > 0 ? (
        <fieldset className="field">
          <legend className="field-label">Options</legend>
          <div className="switches">
            {toggles.map((toggle) => (
              <label key={toggle.flag} className="check" title={toggle.hint}>
                <input
                  type="checkbox"
                  checked={Boolean(settings.toggles[toggle.flag])}
                  onChange={(event) =>
                    patch({
                      toggles: {
                        ...settings.toggles,
                        [toggle.flag]: event.target.checked,
                      },
                    })
                  }
                />
                {toggle.label}
              </label>
            ))}
          </div>
          {toggles
            .filter((t) => t.warn && settings.toggles[t.flag])
            .map((t) => (
              <p key={t.flag} className="field-hint field-warn">
                {t.warn}
              </p>
            ))}
        </fieldset>
      ) : null}

      <div className="field">
        <button
          type="button"
          className="disclosure"
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced((open) => !open)}
        >
          <span className="disclosure-caret" aria-hidden="true">
            {showAdvanced ? "▾" : "▸"}
          </span>
          Advanced
        </button>
        {showAdvanced ? (
          <>
            <input
              className="text-input mono"
              value={settings.extra}
              placeholder={spec.extraPlaceholder}
              onChange={(event) => patch({ extra: event.target.value })}
            />
            <p className="field-hint">
              Anything else to pass through. The controls above own their own
              flags; whatever you put here is kept exactly as typed.
            </p>
            {/* A leading subcommand is not part of the stored flags. The
                server puts it there, because the flags belong to it. */}
            <p className="field-hint mono command-preview">
              {commandLine(spec)} {composed || "(no arguments)"}
            </p>
          </>
        ) : null}
      </div>
    </>
  );
}

export function ProfilePanel({
  profile,
  palette,
  memoryDefaults,
  harnesses,
  mcpServers,
  onSave,
  onDelete,
  onClose,
}: ProfilePanelProps) {
  const [name, setName] = useState(profile?.name ?? "");
  const [color, setColor] = useState(profile?.color ?? palette[0] ?? "cyan");
  const [harness, setHarness] = useState<Harness>(profile?.harness ?? "claude");
  const [command, setCommand] = useState(profile?.command ?? "");
  const [prompt, setPrompt] = useState(profile?.prompt ?? "");
  const [memoryHigh, setMemoryHigh] = useState(profile?.memoryHigh ?? "");
  const [memoryMax, setMemoryMax] = useState(profile?.memoryMax ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /**
   * Focus the name field when the dialog opens. `autoFocus` as an attribute is
   * discouraged because on a page load it moves focus out from under the
   * reader; inside a dialog that has just been opened deliberately, putting the
   * caret in the first field is the expected behaviour, so it is done here
   * where it only ever runs on open.
   */
  const nameRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const spec = harnesses?.find((h) => h.id === harness);
  const report = useHarnessReport(spec ? spec.id : null);

  // The controls and the advanced field are two views of one argv list. State
  // is held in the structured shape and flattened on save, so the raw text can
  // never drift out of step with the controls above it.
  //
  // One shape per harness, kept as the segment is switched. Each reads the
  // stored list only when the profile is already of its own kind: parsing a
  // Claude profile's flags as Hermes ones would dump the lot into the advanced
  // field, and switching back would then have destroyed them. The others seed
  // with their own defaults instead, which is what a switch should land on.
  const [edited, setEdited] = useState<Record<string, FlagSettings>>({});
  const seed = (s: HarnessSpec): FlagSettings =>
    profile?.harness === s.id ? parseArgs(s, profile.args) : initialSettings(s);
  const settings = spec ? (edited[spec.id] ?? seed(spec)) : null;
  const patch = (next: Partial<FlagSettings>) => {
    if (!spec) return;
    setEdited((all) => ({
      ...all,
      [spec.id]: { ...(all[spec.id] ?? seed(spec)), ...next },
    }));
  };

  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  /**
   * Drops a blank in at the caret.
   *
   * Typed by hand `{{like this}}` works identically — this exists so the
   * feature is discoverable, because nobody guesses a brace syntax. Selected
   * text becomes the label, which makes "turn this word into a blank" the
   * obvious gesture it should be.
   */
  const insertBlank = () => {
    const field = promptRef.current;
    if (!field) return;
    const { selectionStart: from, selectionEnd: to, value } = field;
    const selected = value.slice(from, to).trim();
    const label = selected || "what to fill in";
    const next = `${value.slice(0, from)}{{${label}}}${value.slice(to)}`;
    setPrompt(next);
    // Select the label so it can be typed straight over.
    const caret = from + 2;
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(caret, caret + label.length);
    });
  };

  // For the custom harness there are no known flags to offer, so the whole
  // argument list is free text and the structured controls stay out of it. The
  // same goes for a harness whose spec has left the box: its stored argv is
  // shown raw rather than lost.
  const [customArgs, setCustomArgs] = useState(detokenize(profile?.args ?? []));
  const blanks = useMemo(() => countBlanks(prompt), [prompt]);

  const options = [
    ...(harnesses ?? []).map((h) => ({
      value: h.id,
      label: h.label,
      hint: `runs \`${commandLine(h)}\` in the worktree`,
    })),
    { value: SHELL, label: "Shell", hint: "a plain shell, tinted and named" },
    { value: CUSTOM, label: "Custom", hint: "any command on the box" },
  ];
  // Still loading, or a harness whose spec file was removed. Either way the
  // profile keeps the one it has until someone picks another.
  const orphan =
    harnesses !== null && !spec && harness !== SHELL && harness !== CUSTOM;
  if (orphan)
    options.push({
      value: harness,
      label: harness,
      hint: "this harness is no longer defined on the box",
    });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave({
        name,
        color,
        harness,
        command: harness === CUSTOM ? command : null,
        args:
          spec && settings
            ? buildArgs(spec, settings)
            : harness === SHELL
              ? ""
              : customArgs,
        prompt,
        memoryHigh,
        memoryMax,
      });
      // onClose unmounts this panel, so clearing `busy` afterwards would write
      // state to a component that is gone. Only the failure path stays mounted.
      onClose();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  /**
   * Deleting went straight through with no catch, so a failure left the panel
   * open, showed nothing in the error slot, and surfaced only as an unhandled
   * rejection in the console. Same shape as submit above.
   */
  const remove = async () => {
    if (!onDelete) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete();
      onClose();
    } catch (err) {
      setError(describeError(err));
      setConfirming(false);
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="scrim"
        aria-label="Close"
        onClick={onClose}
      />
      <aside
        className="panel glass-solid panel-wide"
        role="dialog"
        aria-label={profile ? `Edit ${profile.name}` : "New profile"}
        style={{ ["--win-color" as string]: `var(--profile-${color})` }}
      >
        <header className="panel-head">
          <h2>{profile ? profile.name : "New profile"}</h2>
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
            ref={nameRef}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <fieldset className="field">
          <legend className="field-label">Colour</legend>
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
        </fieldset>

        <fieldset className="field">
          <legend className="field-label">Harness</legend>
          <div className="segmented">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                data-active={harness === option.value || undefined}
                onClick={() => setHarness(option.value)}
                title={option.hint.replaceAll("`", "")}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>

        {harness === CUSTOM ? (
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

        {spec && settings ? (
          <HarnessControls
            // Remounts on a switch, so the advanced disclosure starts closed
            // for each harness rather than carrying over.
            key={spec.id}
            spec={spec}
            report={report}
            servers={mcpServers}
            settings={settings}
            patch={patch}
          />
        ) : null}

        {harness === CUSTOM || orphan ? (
          <div className="field">
            <label htmlFor="profile-args">Arguments</label>
            <input
              id="profile-args"
              className="text-input mono"
              value={customArgs}
              placeholder="--serve --port 8080"
              onChange={(event) => setCustomArgs(event.target.value)}
            />
            <p className="field-hint">
              Split like a shell would, quotes included — but run as a list, so
              a <code>;</code> inside an argument stays part of that argument.
            </p>
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="profile-prompt">
            Prompt
            <button
              type="button"
              className="inline-action"
              onClick={insertBlank}
            >
              + blank
            </button>
          </label>
          <textarea
            id="profile-prompt"
            ref={promptRef}
            className="text-input prompt-input"
            value={prompt}
            rows={8}
            placeholder="You are the backend manager for this repo…"
            onChange={(event) => setPrompt(event.target.value)}
          />
          <p className="field-hint">
            Offered above the terminal each time you open this profile.
            {blanks > 0 ? (
              <>
                {" "}
                It has <strong>{blanks}</strong> blank{blanks === 1 ? "" : "s"}{" "}
                to fill in each time.
              </>
            ) : (
              <>
                {" "}
                Select a word and press <strong>+ blank</strong> to make it a
                field you fill in each time.
              </>
            )}
          </p>
        </div>

        <fieldset className="field">
          <legend className="field-label">Memory</legend>
          <div className="switches">
            <input
              aria-label="Throttle past"
              className="text-input mono"
              value={memoryHigh}
              placeholder={`throttle past ${memoryDefaults.high ?? "infinity"}`}
              onChange={(event) => setMemoryHigh(event.target.value)}
            />
            <input
              aria-label="Kill past"
              className="text-input mono"
              value={memoryMax}
              placeholder={`kill past ${memoryDefaults.max ?? "infinity"}`}
              onChange={(event) => setMemoryMax(event.target.value)}
            />
          </div>
          <p className="field-hint">
            Each window runs in its own systemd scope. Past the first limit it
            is slowed down; past the second, once its share of swap is used, it
            is ended. Sizes like <code>1500M</code>, <code>2G</code>,{" "}
            <code>40%</code> of the box&apos;s RAM, or <code>infinity</code>.
            Empty uses the server&apos;s.
          </p>
        </fieldset>

        <div className="panel-actions">
          {onDelete ? (
            confirming ? (
              <>
                <span className="panel-ask">Delete this profile?</span>
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  Delete
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-quiet panel-delete"
                onClick={() => setConfirming(true)}
              >
                Delete
              </button>
            )
          ) : null}

          {!confirming ? (
            <button
              type="button"
              className="btn btn-primary"
              // Until the harness list arrives there are no controls to
              // compose a command line from.
              disabled={busy || harnesses === null}
              onClick={() => void submit()}
            >
              {busy ? "saving…" : profile ? "Save" : "Create"}
            </button>
          ) : null}
        </div>

        {onDelete ? (
          <p className="field-hint panel-foot">
            Deleting keeps any window already running this profile — it just
            becomes an ordinary terminal.
          </p>
        ) : null}
      </aside>
    </>
  );
}
