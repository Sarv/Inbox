/** A modal alert owns keyboard input even when focus is still in the background. */
export function isModalAlertOpen(): boolean {
  return document.querySelector('[role="alertdialog"][aria-modal="true"]') !== null;
}
