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

export interface ClaudeSettings {
  /** Model alias or id, without any context-window suffix. Empty for default. */
  model: string;
  /** The `[1m]` suffix, which asks for the million-token context window. */
  longContext: boolean;
  /** '' for ask-every-time, 'skip' for the dangerous flag, or a mode name. */
  permission: string;
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
  let model = '';
  let longContext = false;
  let permission = '';

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];

    if (token === SKIP_PERMISSIONS) {
      permission = 'skip';
      continue;
    }
    if (known.has(token)) {
      toggles[token] = true;
      continue;
    }
    if (token === '--model' || token === '--permission-mode') {
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

  return { model, longContext, permission, toggles, extra: detokenize(leftovers) };
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
  for (const { flag } of TOGGLES) {
    if (settings.toggles[flag]) tokens.push(flag);
  }

  const extra = settings.extra.trim();
  return [detokenize(tokens), extra].filter(Boolean).join(' ');
}
