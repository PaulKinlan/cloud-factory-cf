import { describe, expect, it, vi } from "vitest";
import { coalescePerFrame, type FrameApi } from "../src/pan-frame";

/** A frame clock the test drives by hand. */
function fakeFrames() {
  const queued = new Map<number, () => void>();
  let next = 1;
  const api: FrameApi = {
    request: (callback) => {
      const handle = next++;
      queued.set(handle, callback);
      return handle;
    },
    cancel: (handle) => {
      queued.delete(handle);
    },
  };
  return {
    api,
    pending: () => queued.size,
    /** Run every frame that is currently queued, as a browser would. */
    flush() {
      const callbacks = [...queued.values()];
      queued.clear();
      for (const callback of callbacks) callback();
    },
  };
}

describe("pan frame coalescing (cloud-factory-cf-7mw9)", () => {
  it("applies one frame for a burst of pointer events, using the newest", () => {
    const frames = fakeFrames();
    const apply = vi.fn();
    const pan = coalescePerFrame<{ x: number }>(apply, frames.api);

    pan.schedule({ x: 1 });
    pan.schedule({ x: 2 });
    pan.schedule({ x: 3 });

    expect(apply).not.toHaveBeenCalled();
    expect(frames.pending()).toBe(1);
    frames.flush();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({ x: 3 });
  });

  it("schedules a fresh frame for events after the previous one ran", () => {
    const frames = fakeFrames();
    const apply = vi.fn();
    const pan = coalescePerFrame<{ x: number }>(apply, frames.api);

    pan.schedule({ x: 1 });
    frames.flush();
    pan.schedule({ x: 2 });
    frames.flush();

    expect(apply.mock.calls).toEqual([[{ x: 1 }], [{ x: 2 }]]);
  });

  it("cancels a queued frame so nothing lands after the drag ends", () => {
    const frames = fakeFrames();
    const apply = vi.fn();
    const pan = coalescePerFrame<{ x: number }>(apply, frames.api);

    pan.schedule({ x: 1 });
    pan.cancel();

    expect(frames.pending()).toBe(0);
    frames.flush();
    expect(apply).not.toHaveBeenCalled();

    // A new drag after the cancel still works.
    pan.schedule({ x: 9 });
    frames.flush();
    expect(apply).toHaveBeenCalledWith({ x: 9 });
  });
});
