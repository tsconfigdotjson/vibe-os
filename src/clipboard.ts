/**
 * Putting text on the clipboard from a page that may not be a secure origin.
 *
 * `navigator.clipboard` does not merely fail on plain HTTP served to an IP
 * address — it is not defined at all, which is exactly how vibe-os is meant to
 * be reached. The textarea-and-`execCommand` route is deprecated and has no
 * such requirement, so it is the fallback rather than the alternative.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Blocked, or not permitted from this context — try the old way.
    }
  }

  const scratch = document.createElement('textarea');
  scratch.value = text;
  // Off-screen rather than hidden: execCommand ignores an unfocusable element.
  scratch.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
  scratch.setAttribute('readonly', '');
  document.body.appendChild(scratch);

  // Whatever the user had selected is theirs; putting it back matters most in
  // a terminal, where a selection is often the thing being copied.
  const previous = document.activeElement as HTMLElement | null;
  try {
    scratch.select();
    scratch.setSelectionRange(0, scratch.value.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    scratch.remove();
    previous?.focus?.();
  }
}
