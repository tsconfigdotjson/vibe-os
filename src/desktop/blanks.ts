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

export interface Segment {
  /** Literal prompt text, or a blank to be filled. */
  type: 'text' | 'blank';
  /** The text, or for a blank its label. */
  value: string;
  /** Stable key for a blank: its position among the blanks. */
  index?: number;
}

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

  for (const match of prompt.matchAll(BLANK)) {
    const at = match.index ?? 0;
    if (at > last) segments.push({ type: 'text', value: prompt.slice(last, at) });
    segments.push({ type: 'blank', value: match[1].trim(), index: index++ });
    last = at + match[0].length;
  }
  if (last < prompt.length) segments.push({ type: 'text', value: prompt.slice(last) });
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
export function fillPrompt(prompt: string, values: Record<number, string>): string {
  let index = 0;
  return prompt.replace(BLANK, (_, label: string) => {
    const value = values[index++];
    return value?.trim() ? value.trim() : label.trim();
  });
}
