/**
 * Light-dismiss for the canvas dialogs (cloud-factory-cf-v62o).
 *
 * `<dialog closedby="any">` is the declarative way to let a click on the backdrop — and
 * the platform's back/dismiss gesture — close a modal dialog that was opened with
 * `showModal()`. In an engine that implements the attribute, that one attribute is the
 * whole mechanism and nothing else is needed.
 *
 * Where it is missing the fallback below covers the BACKDROP CLICK only. It deliberately
 * does not claim the platform back gesture: the gesture is a browser-level dismissal that
 * no portable web API can intercept once `closedby` is absent, and the history-based
 * alternative (pushState on open, close on popstate) changes how the canvas's own back
 * button behaves for every user, needs a Safari device to verify, and cannot be tested on
 * this fleet's Linux VMs (cloud-factory-cf-pmkq). What keeps an engine without `closedby`
 * usable is that every light-dismissable dialog still carries an explicit Close control,
 * which light-dismiss.test.ts asserts — so dismissal is narrower there, never missing.
 *
 * TODO(baseline/dialog-closedby): delete installLightDismiss(), its call in main.ts and
 * the fallback test once `closedby` is Baseline Widely Available (web-features
 * `dialog-closedby`: Chrome/Edge 134, Firefox 141, no Safari as of 2026-10) — from then
 * on the attribute alone can dismiss the dialog on the backdrop and the back gesture.
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
