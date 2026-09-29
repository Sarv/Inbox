/**
 * Write text to the clipboard, reporting whether it worked.
 *
 * The one place the app talks to `navigator.clipboard`. It is absent in a
 * non-secure context and rejects when the document is not focused, so a failure
 * is a normal outcome: this never throws, it answers `false`, and the caller
 * decides how to tell the reader — `useCopyToClipboard` shows it on the button,
 * a menu's Copy (which has closed by then) logs it.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
