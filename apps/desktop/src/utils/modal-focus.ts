/** Focusable controls in the visible portion of a setup dialog. */
export function dialogControls(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')]
    .filter((item) => {
      if (item.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      let ancestor = item.parentElement;
      while (ancestor && ancestor !== container) {
        if (ancestor.tagName === 'DETAILS' && !ancestor.hasAttribute('open') &&
            !ancestor.querySelector(':scope > summary')?.contains(item)) return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    });
}

/** Keep keyboard navigation inside a modal, including from its focused heading. */
export function trapDialogTab(
  event: { key: string; shiftKey: boolean; preventDefault: () => void },
  container: HTMLElement | null,
): void {
  if (event.key !== 'Tab' || !container) return;
  const controls = dialogControls(container);
  if (!controls.length) { event.preventDefault(); return; }
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && (!controls.includes(document.activeElement as HTMLElement) || document.activeElement === first)) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault(); first.focus();
  }
}
