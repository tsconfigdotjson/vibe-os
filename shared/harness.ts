import { detokenize } from "./args";

/**
 * What a harness is, as data: the command it runs and the flags the editor
 * offers for it.
 *
 * A profile stores an argv list, because that is what actually gets run and it
 * has to stay the single source of truth. The editor's controls do not get
 * their own storage. They read the tokens on the way in and rewrite them on the
 * way out, and every token they do not recognise goes to the advanced field in
 * its original order, so a hand-written flag survives a save.
 *
 * Both sides import this. The server ships each harness's spec to the browser
 * on `GET /api/harnesses`, and the editor renders whatever it is given, so a
 * harness added on the server (or in `~/.vibe-os/harnesses/*.json`) needs no
 * change to the client.
 */

/** One value a select can take. */
export interface ChoiceOption {
  value: string;
  /** What the dropdown shows. The value itself when absent. */
  label?: string;
  /** An `<optgroup>` to file it under. */
  group?: string;
}

/**
 * A value that is spelled as its own flag rather than as `--flag value`.
 *
 * Claude's "skip every check" is `--dangerously-skip-permissions`, not a
 * `--permission-mode`; Hermes' interface is `--tui` or `--cli` with no flag of
 * its own at all.
 */
export interface SpecialOption {
  value: string;
  label: string;
  flag: string;
  aliases?: string[];
  /** Shown under the field while this value is picked. */
  warn?: string;
}

/** A flag that takes one value, offered as a dropdown or a typed field. */
export interface SelectField {
  kind: "select";
  /** Stable id: the key in settings, the discovery report and the DOM. */
  key: string;
  label: string;
  /** `--model` in `--model opus`. Absent when every value is a special. */
  flag?: string;
  /** Other spellings of `flag`, read on the way in and never written. */
  aliases?: string[];
  /**
   * Text the value carries in front of it, for a flag shared between fields.
   * Codex sets its thinking level as `-c model_reasoning_effort=high`, and a
   * `-c` with any other key is left alone.
   */
  prefix?: string;
  /** What to offer when discovery has nothing better. */
  options?: ChoiceOption[];
  specials?: SpecialOption[];
  /** Typed, with the options as suggestions, rather than picked from a list. */
  free?: boolean;
  /** The label for no value. Defaults to "Default — whatever <harness> picks". */
  none?: string;
  /** Placeholder for the typed form. */
  placeholder?: string;
  /**
   * A marker appended to the value, as its own checkbox. Claude's `[1m]` asks
   * for the million-token context window: `--model opus[1m]`.
   */
  suffix?: { token: string; label: string; hint?: string };
  /** Shown under the field. Backticks become code. */
  hint?: string;
  /** Shown instead of `hint` when there was nothing to offer. */
  emptyHint?: string;
}

/** A flag with no value, offered as a switch under Options. */
export interface ToggleField {
  kind: "toggle";
  flag: string;
  aliases?: string[];
  label: string;
  hint?: string;
  /** Shown under the switches while this one is on. */
  warn?: string;
}

/**
 * Claude's MCP picker: `--strict-mcp-config`, then `--mcp-config` with as many
 * paths as follow it.
 *
 * There is no flag that enables servers by name, so the three states are what
 * the two flags can actually say: neither means the harness loads whatever the
 * box has, the strict flag alone means none of it, and adding the config flag
 * gives back exactly the files listed.
 */
export interface McpField {
  kind: "mcp";
  key: string;
  label: string;
  strict: string;
  config: string;
  /** Shown when the box has no servers configured. Backticks become code. */
  emptyHint?: string;
}

export type Field = SelectField | ToggleField | McpField;

export type McpMode = "all" | "pick" | "none";

/** Everything a harness is, minus the code. */
export interface HarnessSpec {
  /** What profiles store. Letters, digits and dashes. */
  id: string;
  label: string;
  /** The binary, looked up on PATH. */
  command: string;
  /**
   * Where else to look, with `~` for the home directory. A systemd service and
   * an `ssh host 'command'` both lack `~/.local/bin`, which is where most
   * `curl | sh` installers put things.
   */
  paths?: string[];
  /** Subcommand in front of every profile's flags, like Hermes' `chat`. */
  leading?: string[];
  /**
   * How to pick the last conversation back up after a reboot.
   *
   * `args` go after the profile's flags, or straight after the command when
   * `subcommand` is set: Codex resumes with `codex resume --last`, not a flag.
   * `unless` lists flags that already pick a conversation, which make adding
   * `args` redundant.
   */
  resume?: { args: string[]; subcommand?: boolean; unless?: string[] };
  /** The line doctor prints when the command is missing. */
  install?: string;
  /** Arguments that print a version. `--version` when absent. */
  version?: string[];
  /**
   * A command that reports whether the box is logged in, and the one that
   * logs it in. A window opened logged out sits at a login prompt.
   */
  login?: { args: string[]; fix: string };
  /** Flags a new profile starts with. */
  defaults?: string[];
  /** Controls, in the order they render and are written. */
  fields: Field[];
  /** Flags the controls do not own whose value is the next token. */
  valued?: string[];
  /**
   * Flags whose value is optional. Bare they may be a switch (Hermes' `-c` is
   * `--continue`); with a value they name something no control can say, so the
   * pair goes to the advanced field whole.
   */
  optional?: string[];
  /** Placeholder for the advanced field. */
  extraPlaceholder?: string;
}

/** What discovery found on the box, for one harness. */
export interface HarnessReport {
  id: string;
  /** The command was found. */
  available: boolean;
  version: string | null;
  /**
   * Null is "could not tell" or "this harness has no login". Only a definite
   * false is worth warning about.
   */
  loggedIn: boolean | null;
  /** Discovered choices by field key. They replace the spec's own options. */
  options: Record<string, ChoiceOption[]>;
  /** What the harness uses for a field left empty, by field key. */
  defaults: Record<string, string>;
  /** Facts about the box worth saying in the editor. Backticks become code. */
  notes: { label: string; text: string; warn?: boolean }[];
}

/** The editor's view of one profile's argv. */
export interface FlagSettings {
  /** Select fields by key. Empty means unset. */
  values: Record<string, string>;
  /** Select-field suffixes by key. */
  suffixes: Record<string, boolean>;
  /** Switches by canonical flag. */
  toggles: Record<string, boolean>;
  mcp: McpMode;
  /** Paths passed to the MCP config flag, in the order they will be given. */
  mcpConfigs: string[];
  /** Everything the controls do not own, as the user typed it. */
  extra: string;
}

const isValue = (token: string | undefined): token is string =>
  token !== undefined && !token.startsWith("-");

/**
 * Reads stored argv into the editor's controls.
 *
 * Every spelling of a flag is understood on the way in and one canonical form
 * is written on the way out, so `-m opus` typed into the advanced field comes
 * back as a model selection. A valued flag with nothing after it is malformed
 * and goes to `extra` to be seen and fixed, rather than swallowing whatever
 * followed it.
 */
export function parseArgs(spec: HarnessSpec, args: string[]): FlagSettings {
  const specials = new Map<string, { key: string; value: string }>();
  const selects = new Map<string, SelectField[]>();
  const toggleFlags = new Map<string, string>();
  let mcp: McpField | undefined;
  for (const field of spec.fields) {
    if (field.kind === "toggle") {
      for (const f of [field.flag, ...(field.aliases ?? [])])
        toggleFlags.set(f, field.flag);
    } else if (field.kind === "mcp") {
      mcp = field;
    } else {
      for (const s of field.specials ?? [])
        for (const f of [s.flag, ...(s.aliases ?? [])])
          specials.set(f, { key: field.key, value: s.value });
      if (field.flag)
        for (const f of [field.flag, ...(field.aliases ?? [])])
          selects.set(f, [...(selects.get(f) ?? []), field]);
    }
  }
  const isSpecial = (key: string, value: string) =>
    [...specials.values()].some((s) => s.key === key && s.value === value);
  const valued = new Set(spec.valued ?? []);
  const optional = new Set(spec.optional ?? []);

  const values: Record<string, string> = {};
  const suffixes: Record<string, boolean> = {};
  const toggles: Record<string, boolean> = {};
  const leftovers: string[] = [];
  const mcpConfigs: string[] = [];
  let strict = false;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    const next = args[i + 1];

    if (optional.has(token) && isValue(next)) {
      leftovers.push(token, next);
      i += 1;
      continue;
    }
    const special = specials.get(token);
    if (special) {
      values[special.key] = special.value;
      continue;
    }
    if (mcp && token === mcp.strict) {
      strict = true;
      continue;
    }
    // Variadic, unlike every other flag here: it takes as many paths as follow
    // it, so it swallows tokens until the next thing that looks like a flag.
    if (mcp && token === mcp.config) {
      const before = mcpConfigs.length;
      while (isValue(args[i + 1])) {
        mcpConfigs.push(args[i + 1]);
        i += 1;
      }
      if (mcpConfigs.length === before) leftovers.push(token);
      continue;
    }
    const toggle = toggleFlags.get(token);
    if (toggle) {
      toggles[toggle] = true;
      continue;
    }
    const candidates = selects.get(token);
    if (candidates) {
      if (!isValue(next)) {
        leftovers.push(token);
        continue;
      }
      i += 1;
      const field = candidates.find(
        (f) => !f.prefix || next.startsWith(f.prefix),
      );
      // A shared flag carrying a key no field owns, like Codex's
      // `-c model="o3"`: kept as a pair, exactly as written.
      if (!field) {
        leftovers.push(token, next);
        continue;
      }
      let value = field.prefix ? next.slice(field.prefix.length) : next;
      if (field.suffix && value.endsWith(field.suffix.token)) {
        suffixes[field.key] = true;
        value = value.slice(0, -field.suffix.token.length);
      }
      // A special beats the flag it stands in for, whichever came first:
      // `--dangerously-skip-permissions` makes `--permission-mode` moot.
      if (!isSpecial(field.key, values[field.key] ?? "\0"))
        values[field.key] = value;
      continue;
    }
    leftovers.push(token);
    // Keep a value attached to the flag it belongs to.
    if (valued.has(token) && isValue(next)) {
      leftovers.push(next);
      i += 1;
    }
  }

  // The config flag without the strict one means "the box's servers and also
  // these", which the three-way control cannot say. Rather than quietly add the
  // strict flag and change what the profile does, that combination goes back
  // to the advanced field exactly as it was written.
  if (mcp && !strict && mcpConfigs.length > 0)
    leftovers.push(mcp.config, ...mcpConfigs.splice(0));

  return {
    values,
    suffixes,
    toggles,
    mcp: strict ? (mcpConfigs.length > 0 ? "pick" : "none") : "all",
    mcpConfigs,
    extra: detokenize(leftovers),
  };
}

/** Composes the controls back into a command line for the server to tokenise. */
export function buildArgs(spec: HarnessSpec, settings: FlagSettings): string {
  const tokens: string[] = [];

  for (const field of spec.fields) {
    if (field.kind === "toggle") {
      if (settings.toggles[field.flag]) tokens.push(field.flag);
    } else if (field.kind === "mcp") {
      // Picking nothing is the same command line as picking none, so it is
      // written as none rather than left half-stated.
      if (
        settings.mcp === "none" ||
        (settings.mcp === "pick" && settings.mcpConfigs.length === 0)
      ) {
        tokens.push(field.strict);
      } else if (settings.mcp === "pick") {
        tokens.push(field.strict, field.config, ...settings.mcpConfigs);
      }
    } else {
      const value = settings.values[field.key];
      if (!value) continue;
      const special = field.specials?.find((s) => s.value === value);
      if (special) {
        tokens.push(special.flag);
      } else if (field.flag) {
        const suffix =
          field.suffix && settings.suffixes[field.key]
            ? field.suffix.token
            : "";
        tokens.push(field.flag, `${field.prefix ?? ""}${value}${suffix}`);
      }
    }
  }

  const extra = settings.extra.trim();
  return [detokenize(tokens), extra].filter(Boolean).join(" ");
}

/** The settings a new profile of this harness starts from. */
export const initialSettings = (spec: HarnessSpec): FlagSettings =>
  parseArgs(spec, spec.defaults ?? []);

/** Whether a profile of this harness can pick its last conversation back up. */
export const resumes = (spec: HarnessSpec | undefined): boolean =>
  Boolean(spec?.resume);

/** The pseudo-harnesses every box has, which are not adapters. */
export const SHELL = "shell";
export const CUSTOM = "custom";
