import { afterEach, describe, expect, it, vi } from "vitest";
import indexHtml from "../index.html?raw";
import { installLightDismiss } from "../src/light-dismiss";

/**
 * A fake <dialog> carrying the two things the fallback uses: a click listener it can
 * fire, and a content box to compare the click coordinates against.
 */
function fakeDialog(rect = { top: 100, left: 100, height: 200, width: 300 }) {
  const listeners: Record<string, (event: any) => void> = {};
  const dialog = {
    close: vi.fn(),
    addEventListener: vi.fn((type: string, fn: (event: any) => void) => {
      listeners[type] = fn;
    }),
    getBoundingClientRect: () =>
      ({
        top: rect.top,
        left: rect.left,
        height: rect.height,
        width: rect.width,
        bottom: rect.top + rect.height,
        right: rect.left + rect.width,
        x: rect.left,
        y: rect.top,
      }) as DOMRect,
    fire(event: any) {
      listeners["click"]?.(event);
    },
  };
  return dialog;
}

const fakeRoot = (dialogs: unknown[]): ParentNode =>
  ({ querySelectorAll: () => dialogs }) as unknown as ParentNode;

describe("dialog light-dismiss (cloud-factory-cf-v62o)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("every canvas dialog asks for light-dismiss declaratively", () => {
    for (const id of ["connect-dialog", "share-dialog", "export-dialog"]) {
      expect(new RegExp(`<dialog[^>]*id="${id}"[^>]*closedby="any"`).test(indexHtml), `${id} needs closedby="any"`).toBe(true);
    }
  });

  it("keeps an explicit close control inside every light-dismissable dialog", () => {
    for (const id of ["connect-close", "share-close", "export-close"]) {
      expect(new RegExp(`<button[^>]*id="${id}"[^>]*>\\s*Close\\s*</button>`).test(indexHtml), `${id} must offer an explicit Close`).toBe(true);
    }
  });

  it("closes when the backdrop is clicked, where closedby is not implemented", () => {
    const dialog = fakeDialog();
    installLightDismiss(fakeRoot([dialog]));

    expect(dialog.addEventListener).toHaveBeenCalledWith("click", expect.any(Function));
    // A backdrop click targets the dialog itself and lands outside its content box.
    dialog.fire({ target: dialog, clientX: 5, clientY: 5 });
    expect(dialog.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog open for a click on its own box or on a child", () => {
    const dialog = fakeDialog();
    installLightDismiss(fakeRoot([dialog]));

    // The dialog's padding targets the dialog too, but the coordinates are inside it.
    dialog.fire({ target: dialog, clientX: 150, clientY: 150 });
    // A click on a child of the dialog never reached the backdrop.
    dialog.fire({ target: { tagName: "BUTTON" }, clientX: 5, clientY: 5 });
    expect(dialog.close).not.toHaveBeenCalled();
  });

  it("leaves the native implementation alone where the browser has closedby", () => {
    vi.stubGlobal("HTMLDialogElement", class {});
    (globalThis as any).HTMLDialogElement.prototype.closedBy = "auto";

    const dialog = fakeDialog();
    installLightDismiss(fakeRoot([dialog]));
    expect(dialog.addEventListener).not.toHaveBeenCalled();
  });
});
