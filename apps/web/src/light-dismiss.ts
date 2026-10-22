/**
 * Light-dismiss for the canvas dialogs (cloud-factory-cf-v62o).
 *
 * `<dialog closedby="any">` is the declarative way to let a click on the backdrop — and
 * the platform's back/dismiss gesture — close a modal dialog that was opened with
 * `showModal()` (see docs/speed.md's neighbours for the project's stance on native APIs
 * first). It is the whole mechanism in browsers that implement it; nothing else is
 * needed.
 *
 * TODO(baseline/dialog-closedby): delete installLightDismiss(), its call in main.ts and
 * the fallback test once `closedby` is Baseline Widely Available (web-features
 * `dialog-closedby`: Chrome/Edge 134, Firefox 141, no Safari as of 2026-10) — from then
 * on the attribute alone can dismiss the dialog on the backdrop.
 */

/** Does this browser implement `closedby` natively? Missing global means "no". */
function supportsClosedBy(): boolean {
  return typeof HTMLDialogElement !== "undefined" && "closedBy" in HTMLDialogElement.prototype;
}

/**
 * Give every `<dialog closedby="any">` the backdrop dismissal it asks for in engines that
 * do not implement `closedby` yet. A no-op where the attribute already works, so calling
 * it unconditionally is safe.
 */
export function installLightDismiss(root: ParentNode): void {
  if (supportsClosedBy()) return;

  for (const dialog of root.querySelectorAll<HTMLDialogElement>('dialog[closedby="any"]')) {
    dialog.addEventListener("click", (event) => {
      // A backdrop click targets the dialog element itself; a click on any child targets
      // that child. But the dialog's own box (its padding, not the backdrop) also targets
      // the dialog, so the coordinates decide which one this was.
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const insideBox =
        event.clientY >= rect.top &&
        event.clientY <= rect.top + rect.height &&
        event.clientX >= rect.left &&
        event.clientX <= rect.left + rect.width;
      if (!insideBox) dialog.close();
    });
  }
}
