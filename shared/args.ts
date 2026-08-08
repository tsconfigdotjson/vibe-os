/**
 * Turning a flag string into argv, and back.
 *
 * Shared rather than mirrored. These two are inverses of each other, and the
 * editor relies on that: `detokenize` renders stored argv into the text field,
 * `tokenize` parses it on the way back, so every save of an unmodified profile
 * runs a full cycle. They lived in two files that agreed by hand until they
 * didn't — the browser's copy had no unbalanced-quote check and no idea what
 * the escaping the server emitted meant, so an argument with an apostrophe in
 * it came back mangled on one side and unsaveable on the other.
 *
 * Runtime code, unlike the type-only `wire.ts` beside it, so `shared/` is in
 * the package's `files` list.
 */

/**
 * Splits a flag string into argv tokens, honouring quotes.
 *
 * The tokens are shell-quoted individually when the launch command is built, so
 * this is what stops `--model "gpt 4"` from becoming two arguments and equally
 * what stops a stray `;` from becoming a second command. Unbalanced quotes are
 * an error here rather than a mystery at spawn time — you find out when you
 * press save, not when the terminal comes up empty.
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    // Single quotes are literal in POSIX: no escape survives inside them, and
    // the only way out is the closing quote. This is what makes the `'\''`
    // idiom detokenize emits work — it closes, escapes, and reopens.
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && (input[i + 1] === '"' || input[i + 1] === "\\")) {
        current += input[i + 1];
        i += 1;
      } else if (ch === '"') quote = null;
      else current += ch;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= input.length)
        throw new Error("the arguments end in a dangling backslash");
      current += input[i + 1];
      i += 1;
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }

  if (quote) throw new Error(`unbalanced ${quote} in the arguments`);
  if (started) tokens.push(current);
  return tokens;
}

/**
 * Renders tokens back to editable text. Round-trips through `tokenize`.
 *
 * Backslash is in the quote-me set alongside whitespace and the quote
 * characters, because `tokenize` now treats it as an escape: without this a
 * token like `C:\\path` would come back as `C:path`.
 */
export function detokenize(tokens: string[]): string {
  return tokens
    .map((t) =>
      t === "" || /[\s"'\\]/.test(t) ? `'${t.replaceAll("'", `'\\''`)}'` : t,
    )
    .join(" ");
}
