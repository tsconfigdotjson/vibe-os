/**
 * Fill-in-the-blank prompts.
 *
 * A profile's prompt is the same every time, which is most of its value and
 * also its limit: "review the ticket" is only useful if you can say which
 * ticket. A blank is written `{{like this}}` in the prompt, and the band turns
 * each one into a field to type in before the prompt is handed over.
 *
 * The syntax lives in the prompt text rather than in its own column, so this
 * needed no storage of its own — a prompt with no braces in it behaves exactly
 * as it did before.
 */

const BLANK = /\{\{([^{}\n]{1,60})\}\}/g;

/**
 * A discriminated union, not one shape with an optional `index`.
 *
 * Only blanks have an index, and the optional field made that invisible to the
 * type system: the band knew a `blank` segment always carried one, and had to
 * say so with a non-null assertion at every use. Narrowing on `type` now proves
 * it instead.
 */
export type Segment =
  | { type: "text"; value: string; key: string }
  /** `value` is the label; `index` is its position among the blanks. */
  | { type: "blank"; value: string; index: number; key: string };

/**
 * Splits a prompt into literal runs and blanks.
 *
 * Two blanks with the same label stay separate fields. They usually mean two
 * different things — `{{file}}` twice in a prompt is far more likely to be two
 * files than the same one written twice — and one field silently driving two
 * places is a worse surprise than typing something twice.
 */
export function parsePrompt(prompt: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  let index = 0;

  // Keyed by offset in the prompt: unique, and stable for as long as the prompt
  // is — which is the band's whole lifetime.
  for (const match of prompt.matchAll(BLANK)) {
    const at = match.index ?? 0;
    if (at > last)
      segments.push({
        type: "text",
        value: prompt.slice(last, at),
        key: `t${last}`,
      });
    segments.push({
      type: "blank",
      value: match[1].trim(),
      index: index++,
      key: `b${at}`,
    });
    last = at + match[0].length;
  }
  if (last < prompt.length)
    segments.push({ type: "text", value: prompt.slice(last), key: `t${last}` });
  return segments;
}

/** How many blanks a prompt has. */
export function countBlanks(prompt: string): number {
  return [...prompt.matchAll(BLANK)].length;
}

/**
 * Substitutes the filled values back into the prompt.
 *
 * An unfilled blank falls back to its own label, so a prompt handed over early
 * still reads as a sentence rather than collapsing into "review the  and
 * report". The band asks before letting that happen, but the text should be
 * sane either way.
 */
export function fillPrompt(
  prompt: string,
  values: Record<number, string>,
): string {
  let index = 0;
  return prompt.replace(BLANK, (_, label: string) => {
    const value = values[index++];
    return value?.trim() ? value.trim() : label.trim();
  });
}

/**
 * Fills blanks by label, for callers that have names rather than positions.
 *
 * The CLI and the API take `--blank ticket=123`, so every blank with that label
 * gets the value. `missing` lists labels left empty and `unknown` lists labels
 * the prompt does not have, so a caller can refuse instead of sending a prompt
 * with a hole in it.
 */
export function fillBlanks(
  prompt: string,
  values: Record<string, string>,
): { text: string; missing: string[]; unknown: string[] } {
  const labels = parsePrompt(prompt).flatMap((s) =>
    s.type === "blank" ? [s.value] : [],
  );
  const byIndex: Record<number, string> = {};
  labels.forEach((label, i) => {
    if (Object.hasOwn(values, label)) byIndex[i] = values[label];
  });
  return {
    text: fillPrompt(prompt, byIndex),
    missing: [...new Set(labels.filter((l) => !values[l]?.trim()))],
    unknown: Object.keys(values).filter((k) => !labels.includes(k)),
  };
}
