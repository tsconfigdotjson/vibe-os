/**
 * Translating between what the editor shows and what the harness is given.
 *
 * A profile stores an argv list, because that is what actually gets run and it
 * has to stay the single source of truth — anything a person types by hand must
 * survive a round trip through the editor untouched. So the dropdowns do not
 * get their own storage. They read the tokens on the way in and rewrite them on
 * the way out, and every token they do not recognise is handed to the advanced
 * field rather than silently dropped.
 */

/** Flags that take a value, as `--flag value`. */
const VALUED = new Set(['--model', '--permission-mode', '--agent', '--effort', '--fallback-model', '--name']);

/**
 * How much of the box's MCP configuration a session gets.
 *
 * There is no flag that enables servers by name, so the three states are what
 * the two flags can actually say: nothing at all means Claude loads whatever
 * the box has, `--strict-mcp-config` on its own means none of it, and adding
 * `--mcp-config` gives back exactly the files listed.
 */
export type McpMode = 'all' | 'pick' | 'none';

export interface ClaudeSettings {
  /** Model alias or id, without any context-window suffix. Empty for default. */
  model: string;
  /** The `[1m]` suffix, which asks for the million-token context window. */
  longContext: boolean;
  /** '' for ask-every-time, 'skip' for the dangerous flag, or a mode name. */
  permission: string;
  /** How hard the session thinks. Empty for whatever the harness defaults to. */
  effort: string;
  mcp: McpMode;
  /** Paths passed to `--mcp-config`, in the order they will be given. */
  mcpConfigs: string[];
  toggles: Record<string, boolean>;
  /** Everything the controls above do not own, as the user typed it. */
  extra: string;
}

/** Boolean flags the editor offers as switches. */
export const TOGGLES: { flag: string; label: string; hint: string; warn?: boolean }[] = [
  {
    flag: '--remote-control',
    label: 'Remote control',
    hint: 'Drive this session from claude.ai. Needs nothing on the box beyond outbound network.',
  },
  {
    flag: '--chrome',
    label: 'Browser tools',
    hint: 'Claude in Chrome. Pairs with the extension on the machine you are browsing from.',
  },
  { flag: '--continue', label: 'Resume last conversation', hint: 'Pick up the most recent session in this directory.' },
  { flag: '--verbose', label: 'Verbose output', hint: 'Show full tool output rather than the collapsed form.' },
];

export const SKIP_PERMISSIONS = '--dangerously-skip-permissions';
export const STRICT_MCP = '--strict-mcp-config';
export const MCP_CONFIG = '--mcp-config';

/** Plain-English names for the modes the CLI reports. Unknown ones show raw. */
const MODE_LABELS: Record<string, string> = {
  acceptEdits: 'Accept edits automatically',
  plan: 'Plan first, then ask',
  auto: 'Decide automatically',
  manual: 'Ask every time',
  dontAsk: 'Never ask',
  bypassPermissions: 'Bypass permission checks',
};

export const modeLabel = (mode: string): string => MODE_LABELS[mode] ?? mode;

/**
 * Readable names for the effort ladder. Unknown levels show raw, as modes do.
 *
 * `xhigh` is the one that actually needs this — it is the level you reach for
 * on hard work, and it is the only one whose name does not say what it means.
 */
const EFFORT_LABELS: Record<string, string> = {
  low: 'Low — quick and cheap',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Maximum — slowest, most thorough',
};

export const effortLabel = (level: string): string => EFFORT_LABELS[level] ?? level;

/** Splits a command line into tokens the way a shell would, honouring quotes. */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** Renders tokens back to editable text. Mirrors the server's `detokenize`. */
export function detokenize(tokens: string[]): string {
  return tokens
    .map((t) => (t === '' || /[\s"']/.test(t) ? `'${t.replaceAll("'", `'\\''`)}'` : t))
    .join(' ');
}

/**
 * Reads stored argv into the editor's controls.
 *
 * Anything not claimed by a control lands in `extra` in its original order, so
 * a hand-written `--append-system-prompt "…"` is still there after a save.
 */
export function parseSettings(args: string[]): ClaudeSettings {
  const toggles: Record<string, boolean> = {};
  const known = new Set(TOGGLES.map((t) => t.flag));
  const leftovers: string[] = [];
  const mcpConfigs: string[] = [];
  let model = '';
  let longContext = false;
  let permission = '';
  let effort = '';
  let strictMcp = false;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];

    if (token === SKIP_PERMISSIONS) {
      permission = 'skip';
      continue;
    }
    if (token === STRICT_MCP) {
      strictMcp = true;
      continue;
    }
    // Variadic, unlike every other flag here: it takes as many paths as follow
    // it, so it swallows tokens until the next thing that looks like a flag.
    if (token === MCP_CONFIG) {
      const before = mcpConfigs.length;
      while (args[i + 1] !== undefined && !args[i + 1].startsWith('-')) {
        mcpConfigs.push(args[i + 1]);
        i += 1;
      }
      // Nothing after it is malformed, and goes to `extra` to be seen and
      // fixed rather than disappearing into a control that cannot show it.
      if (mcpConfigs.length === before) leftovers.push(token);
      continue;
    }
    if (known.has(token)) {
      toggles[token] = true;
      continue;
    }
    if (token === '--model' || token === '--permission-mode' || token === '--effort') {
      const value = args[i + 1];
      // A trailing valued flag with nothing after it is malformed; keep it in
      // `extra` rather than swallowing it, so the person can see and fix it.
      if (value === undefined || value.startsWith('-')) {
        leftovers.push(token);
        continue;
      }
      i += 1;
      if (token === '--model') {
        longContext = value.endsWith('[1m]');
        model = longContext ? value.slice(0, -4) : value;
      } else if (token === '--effort') {
        effort = value;
      } else if (permission !== 'skip') {
        permission = value;
      }
      continue;
    }
    leftovers.push(token);
    // Keep a value attached to the flag it belongs to.
    if (VALUED.has(token) && args[i + 1] !== undefined && !args[i + 1].startsWith('-')) {
      leftovers.push(args[i + 1]);
      i += 1;
    }
  }

  // `--mcp-config` without `--strict-mcp-config` means "the box's servers and
  // also these", which the three-way control cannot say. Rather than quietly
  // add the strict flag and change what the profile does, that combination is
  // handed back to the advanced field exactly as it was written.
  if (!strictMcp && mcpConfigs.length > 0) leftovers.push(MCP_CONFIG, ...mcpConfigs.splice(0));

  return {
    model,
    longContext,
    permission,
    effort,
    mcp: strictMcp ? (mcpConfigs.length > 0 ? 'pick' : 'none') : 'all',
    mcpConfigs,
    toggles,
    extra: detokenize(leftovers),
  };
}

/** Composes the controls back into a command line for the server to tokenise. */
export function buildArgs(settings: ClaudeSettings): string {
  const tokens: string[] = [];

  if (settings.model) {
    tokens.push('--model', settings.longContext ? `${settings.model}[1m]` : settings.model);
  }
  if (settings.permission === 'skip') {
    tokens.push(SKIP_PERMISSIONS);
  } else if (settings.permission) {
    tokens.push('--permission-mode', settings.permission);
  }
  if (settings.effort) {
    tokens.push('--effort', settings.effort);
  }
  // Selecting nothing is the same command line as selecting none, so it is
  // written as `none` rather than left half-stated.
  if (settings.mcp === 'none' || (settings.mcp === 'pick' && settings.mcpConfigs.length === 0)) {
    tokens.push(STRICT_MCP);
  } else if (settings.mcp === 'pick') {
    tokens.push(STRICT_MCP, MCP_CONFIG, ...settings.mcpConfigs);
  }
  for (const { flag } of TOGGLES) {
    if (settings.toggles[flag]) tokens.push(flag);
  }

  const extra = settings.extra.trim();
  return [detokenize(tokens), extra].filter(Boolean).join(' ');
}
