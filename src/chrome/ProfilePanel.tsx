import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Harness,
  HarnessInfo,
  HermesInfo,
  McpServer,
  Profile,
  ProfileInput,
} from "../data";
import { describeError } from "../data";
import { countBlanks } from "../desktop/blanks";
import {
  buildArgs,
  type ClaudeSettings,
  detokenize,
  effortLabel,
  type McpMode,
  modeLabel,
  parseSettings,
  TOGGLES,
} from "./claudeFlags";
import {
  buildArgs as buildHermesArgs,
  TOGGLES as HERMES_TOGGLES,
  type HermesSettings,
  type Interface,
  interfaceLabel,
  parseSettings as parseHermesSettings,
} from "./hermesFlags";

export interface ProfilePanelProps {
  /** The profile being edited, or null when creating a new one. */
  profile: Profile | null;
  palette: readonly string[];
  /** What the installed CLI accepts, or null while it is still being read. */
  harnessInfo: HarnessInfo | null;
  /** What Hermes on the box is configured for, or null while it is read. */
  hermesInfo: HermesInfo | null;
  /** MCP servers configured on the box, for this project. */
  mcpServers: McpServer[];
  onSave: (input: ProfileInput) => Promise<unknown>;
  onDelete: (() => Promise<unknown>) | null;
  onClose: () => void;
}

const HARNESSES: { value: Harness; label: string; hint: string }[] = [
  { value: "claude", label: "Claude", hint: "runs `claude` in the worktree" },
  {
    value: "hermes",
    label: "Hermes",
    hint: "runs `hermes chat` in the worktree",
  },
  { value: "shell", label: "Shell", hint: "a plain shell, tinted and named" },
  { value: "custom", label: "Custom", hint: "any command on the box" },
];

const INTERFACES: Interface[] = ["", "cli", "tui"];

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

export function ProfilePanel({
  profile,
  palette,
  harnessInfo,
  hermesInfo,
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

  // The dropdowns and the advanced field are two views of one argv list. State
  // is held in the structured shape and flattened on save, so the raw text can
  // never drift out of step with the controls above it.
  //
  // Two shapes rather than one, because a profile stores one argv list and the
  // two harnesses share no flags. Each reads the stored list only when the
  // profile is already of its own kind: parsing a Claude profile's flags as
  // Hermes ones would dump the lot into the advanced field, and switching the
  // segment back would then have destroyed them. The other side seeds with its
  // own sensible default instead, which is what a switch should land you on.
  const argsFor = (kind: Harness, fallback: string[]) =>
    profile?.harness === kind ? profile.args : fallback;
  const [settings, setSettings] = useState<ClaudeSettings>(() =>
    parseSettings(argsFor("claude", ["--dangerously-skip-permissions"])),
  );
  const [hermes, setHermes] = useState<HermesSettings>(() =>
    parseHermesSettings(argsFor("hermes", ["--yolo"])),
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
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
  const patch = (next: Partial<ClaudeSettings>) =>
    setSettings((s) => ({ ...s, ...next }));
  const patchHermes = (next: Partial<HermesSettings>) =>
    setHermes((s) => ({ ...s, ...next }));

  /**
   * Selections whose server is not on the box.
   *
   * A profile can outlive the server it named — someone runs `claude mcp
   * remove`, or the workspace a local-scope server lived in is deleted. Showing
   * the leftover path as its own row keeps it visible and keeps it selected;
   * dropping it silently would change what the profile does without saying so.
   */
  const strays = useMemo(
    () =>
      settings.mcpConfigs.filter(
        (p) => !mcpServers.some((s) => s.configPath === p),
      ),
    [settings.mcpConfigs, mcpServers],
  );

  const toggleMcp = (configPath: string, on: boolean) =>
    patch({
      // Rebuilt from the discovered order rather than appended to, so the
      // command line does not depend on the order boxes were clicked in.
      mcpConfigs: [
        ...mcpServers
          .map((s) => s.configPath)
          .filter((p) =>
            p === configPath ? on : settings.mcpConfigs.includes(p),
          ),
        ...strays.filter((p) => p !== configPath || on),
      ],
    });

  // For the custom harness there are no known flags to offer, so the whole
  // argument list is free text and the structured controls stay out of it.
  const [customArgs, setCustomArgs] = useState(detokenize(profile?.args ?? []));

  const composed = useMemo(() => buildArgs(settings), [settings]);
  const composedHermes = useMemo(() => buildHermesArgs(hermes), [hermes]);
  const blanks = useMemo(() => countBlanks(prompt), [prompt]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave({
        name,
        color,
        harness,
        command: harness === "custom" ? command : null,
        args:
          harness === "claude"
            ? composed
            : harness === "hermes"
              ? composedHermes
              : harness === "custom"
                ? customArgs
                : "",
        prompt,
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
        </fieldset>

        {harness === "custom" ? (
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

        {harness === "claude" ? (
          <>
            <div className="field">
              <label htmlFor="profile-model">Model</label>
              <div className="row">
                <select
                  id="profile-model"
                  className="text-input select"
                  value={settings.model}
                  onChange={(event) => patch({ model: event.target.value })}
                >
                  <option value="">Default — whatever Claude picks</option>
                  {/* Aliases first, and they are the right answer for almost
                      every profile: they always mean the newest model of that
                      tier, so a role written today does not quietly get worse
                      as better models ship. */}
                  <optgroup label="Latest of its tier">
                    {(harnessInfo?.aliases ?? [])
                      .filter((a) => a !== "default")
                      .map((alias) => (
                        <option key={alias} value={alias}>
                          {alias[0].toUpperCase() + alias.slice(1)}
                        </option>
                      ))}
                  </optgroup>
                  {harnessInfo && harnessInfo.models.length > 0 ? (
                    <optgroup label="Pinned to one version">
                      {harnessInfo.models.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                  {/* A model this build has not heard of still has to survive a
                      round trip, so it is offered back rather than reset. */}
                  {settings.model &&
                  !(harnessInfo?.aliases ?? []).includes(settings.model) &&
                  !(harnessInfo?.models ?? []).includes(settings.model) ? (
                    <option value={settings.model}>{settings.model}</option>
                  ) : null}
                </select>
                <label
                  className="check"
                  title="Ask for the million-token context window"
                >
                  <input
                    type="checkbox"
                    checked={settings.longContext}
                    disabled={!settings.model}
                    onChange={(event) =>
                      patch({ longContext: event.target.checked })
                    }
                  />
                  1M context
                </label>
              </div>
            </div>

            <div className="field">
              <label htmlFor="profile-effort">Thinking</label>
              <select
                id="profile-effort"
                className="text-input select"
                value={settings.effort}
                onChange={(event) => patch({ effort: event.target.value })}
              >
                <option value="">Default — whatever the harness picks</option>
                {(harnessInfo?.effortLevels ?? []).map((level) => (
                  <option key={level} value={level}>
                    {effortLabel(level)}
                  </option>
                ))}
                {/* Same round-trip guarantee the model dropdown makes: a level
                    this build has not heard of is offered back, not reset. */}
                {settings.effort &&
                !(harnessInfo?.effortLevels ?? []).includes(settings.effort) ? (
                  <option value={settings.effort}>{settings.effort}</option>
                ) : null}
              </select>
              <p className="field-hint">
                How long the session reasons before it acts. Higher is slower
                and costs more tokens; it is worth it for work where being wrong
                is expensive.
              </p>
            </div>

            <div className="field">
              <label htmlFor="profile-permission">Permissions</label>
              <select
                id="profile-permission"
                className="text-input select"
                data-warn={settings.permission === "skip" || undefined}
                value={settings.permission}
                onChange={(event) => patch({ permission: event.target.value })}
              >
                <option value="">Ask before each action</option>
                {(harnessInfo?.permissionModes ?? []).map((mode) => (
                  <option key={mode} value={mode}>
                    {modeLabel(mode)}
                  </option>
                ))}
                <option value="skip">
                  Skip every check — no prompts at all
                </option>
              </select>
              {settings.permission === "skip" ? (
                <p className="field-hint field-warn">
                  This session will not ask before editing, running or deleting
                  anything. Reasonable on a box that is already a sandbox; think
                  twice anywhere else.
                </p>
              ) : null}
            </div>

            <div className="field">
              <label htmlFor="profile-mcp">MCP servers</label>
              <select
                id="profile-mcp"
                className="text-input select"
                value={settings.mcp}
                onChange={(event) =>
                  patch({ mcp: event.target.value as McpMode })
                }
              >
                {MCP_MODES.map((mode) => (
                  <option key={mode.value} value={mode.value}>
                    {mode.label}
                  </option>
                ))}
              </select>

              {settings.mcp === "pick" ? (
                mcpServers.length > 0 || strays.length > 0 ? (
                  <div className="mcp-list">
                    {mcpServers.map((server) => (
                      <label
                        key={server.configPath}
                        className="check mcp-item"
                        // The row shows what a name cannot: two servers called
                        // the same thing are told apart by where they point and
                        // which file says so.
                        title={[server.detail, `defined in ${server.source}`]
                          .filter(Boolean)
                          .join("\n")}
                      >
                        <input
                          type="checkbox"
                          checked={settings.mcpConfigs.includes(
                            server.configPath,
                          )}
                          onChange={(event) =>
                            toggleMcp(server.configPath, event.target.checked)
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
                          onChange={() => toggleMcp(configPath, false)}
                        />
                        <span className="mcp-name mcp-stray">
                          {configPath.split("/").pop()}
                        </span>
                        <span className="mcp-meta field-warn">
                          not on this box
                        </span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="field-hint">
                    Nothing configured yet. Add one on the box with{" "}
                    <code>claude mcp add --scope user …</code> and it appears
                    here. The scope matters: without it Claude files the server
                    under whichever directory you ran the command in, and in a
                    workspace that goes when the worktree does.
                  </p>
                )
              ) : null}

              {settings.mcp === "pick" &&
              settings.mcpConfigs.length === 0 &&
              mcpServers.length > 0 ? (
                <p className="field-hint">
                  Nothing picked, so this profile gets no MCP servers at all.
                </p>
              ) : null}
              {settings.mcp === "none" ? (
                <p className="field-hint">
                  Fewer tools to choose between, and a shorter prompt. Worth it
                  for a role that only reads and writes code.
                </p>
              ) : null}
            </div>

            <fieldset className="field">
              <legend className="field-label">Options</legend>
              <div className="switches">
                {TOGGLES.map((toggle) => (
                  <label
                    key={toggle.flag}
                    className="check"
                    title={toggle.hint}
                  >
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
            </fieldset>

            <div className="field">
              <button
                type="button"
                className="disclosure"
                aria-expanded={showAdvanced}
                onClick={() => setShowAdvanced((open) => !open)}
              >
                <span className="disclosure-caret" aria-hidden="true">
                  {showAdvanced ? "\u25be" : "\u25b8"}
                </span>
                Advanced
              </button>
              {showAdvanced ? (
                <>
                  <input
                    className="text-input mono"
                    value={settings.extra}
                    placeholder="--append-system-prompt &quot;…&quot;"
                    onChange={(event) => patch({ extra: event.target.value })}
                  />
                  <p className="field-hint">
                    Anything else to pass through. The controls above own their
                    own flags; whatever you put here is kept exactly as typed.
                  </p>
                  <p className="field-hint mono command-preview">
                    claude {composed || "(no arguments)"}
                  </p>
                </>
              ) : null}
            </div>
          </>
        ) : null}

        {harness === "hermes" ? (
          <>
            {/* Typed, not picked. `hermes model` is an interactive wizard with
                no listing mode, so there is nothing authoritative to read off
                the box — the datalists carry what it is already configured for
                and everything else is free text. */}
            <div className="field">
              <label htmlFor="hermes-model">Model</label>
              <input
                id="hermes-model"
                className="text-input mono"
                list="hermes-models"
                value={hermes.model}
                placeholder={
                  hermesInfo?.defaultModel
                    ? `Default — ${hermesInfo.defaultModel}`
                    : "Default — whatever Hermes is set to"
                }
                onChange={(event) => patchHermes({ model: event.target.value })}
              />
              <datalist id="hermes-models">
                {hermesInfo?.defaultModel ? (
                  <option value={hermesInfo.defaultModel} />
                ) : null}
              </datalist>
            </div>

            <div className="field">
              <label htmlFor="hermes-provider">Provider</label>
              <input
                id="hermes-provider"
                className="text-input mono"
                list="hermes-providers"
                value={hermes.provider}
                placeholder={
                  hermesInfo?.defaultProvider
                    ? `Default — ${hermesInfo.defaultProvider}`
                    : "Default — whatever Hermes is set to"
                }
                onChange={(event) =>
                  patchHermes({ provider: event.target.value })
                }
              />
              <datalist id="hermes-providers">
                {(hermesInfo?.providers ?? []).map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <p className="field-hint">
                Providers this box is set up with. Add one with{" "}
                <code>hermes model</code> on the box and it appears here.
              </p>
            </div>

            <div className="field">
              <label htmlFor="hermes-interface">Interface</label>
              <select
                id="hermes-interface"
                className="text-input select"
                value={hermes.interface}
                onChange={(event) =>
                  patchHermes({ interface: event.target.value as Interface })
                }
              >
                {INTERFACES.map((value) => (
                  <option key={value || "default"} value={value}>
                    {interfaceLabel(value)}
                  </option>
                ))}
              </select>
            </div>

            {/* Where the browser tools land is a property of the box, not of
                this profile: Hermes reads its CDP target from config.yaml and
                has no flag for it. Said rather than offered as a switch, so the
                editor cannot imply a choice it does not have. */}
            <div className="field">
              <span className="field-label">Browser tools</span>
              <p className="field-hint">
                {hermesInfo?.browser.connected ? (
                  <>
                    Driving the box's Chrome on{" "}
                    <code>127.0.0.1:{hermesInfo.browser.cdpPort}</code>. Watch
                    it over VNC.
                    {hermesInfo.browser.browserUse ? null : (
                      <>
                        {" "}
                        <span className="field-warn">
                          No browser-use CLI, so this falls back to the twelve
                          built-in tools.
                        </span>
                      </>
                    )}
                  </>
                ) : hermesInfo?.available ? (
                  <span className="field-warn">
                    Not pointed at this box's browser. Run{" "}
                    <code>vibe-os connect-hermes</code> on the box.
                  </span>
                ) : (
                  <span className="field-warn">
                    Hermes is not installed here, so this profile opens a window
                    that closes immediately. <code>vibe-os doctor</code> has the
                    install line.
                  </span>
                )}
              </p>
            </div>

            <fieldset className="field">
              <legend className="field-label">Options</legend>
              <div className="switches">
                {HERMES_TOGGLES.map((toggle) => (
                  <label
                    key={toggle.flag}
                    className="check"
                    title={toggle.hint}
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(hermes.toggles[toggle.flag])}
                      onChange={(event) =>
                        patchHermes({
                          toggles: {
                            ...hermes.toggles,
                            [toggle.flag]: event.target.checked,
                          },
                        })
                      }
                    />
                    {toggle.label}
                  </label>
                ))}
              </div>
              {hermes.toggles["--yolo"] ? (
                <p className="field-hint field-warn">
                  This session will not ask before running anything. Reasonable
                  on a box that is already a sandbox; think twice anywhere else.
                </p>
              ) : null}
            </fieldset>

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
                    value={hermes.extra}
                    placeholder="--append-system-prompt &quot;…&quot;"
                    onChange={(event) =>
                      patchHermes({ extra: event.target.value })
                    }
                  />
                  <p className="field-hint">
                    Anything else to pass through. The controls above own their
                    own flags; whatever you put here is kept exactly as typed.
                  </p>
                  {/* `chat` is not part of the stored flags. The server puts it
                      there, because --model belongs to that subcommand. */}
                  <p className="field-hint mono command-preview">
                    hermes chat {composedHermes || "(no arguments)"}
                  </p>
                </>
              ) : null}
            </div>
          </>
        ) : null}

        {harness === "custom" ? (
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
              disabled={busy}
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
