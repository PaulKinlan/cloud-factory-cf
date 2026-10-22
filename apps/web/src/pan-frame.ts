/**
 * Frame-coalescing for pointer-driven canvas writes (cloud-factory-cf-7mw9).
 *
 * Panning moves the view straight from the pointer event, and a trackpad delivers
 * those at 120-240 Hz - several per rendered frame. Writing the transform, the label
 * and the layout that follows on every event does that work two to four times a frame
 * for one visible result, and on a slow device it can push the input past a frame.
 *
 * This keeps only the newest pointer event and applies it once per animation frame.
 * Cancelling on pointerup matters: without it a pan queued in the last frame would
 * still be written after the drag ended.
 */

/** The two calls the coalescer needs, injected so it can be tested without a DOM. */
export type FrameApi = {
  request: (callback: () => void) => number;
  cancel: (handle: number) => void;
};

export type PointerCoalescer<E> = {
  /** Remember the newest event and make sure one frame is pending. */
  schedule: (event: E) => void;
  /** Drop a pending frame and its event, so nothing is applied after release. */
  cancel: () => void;
};

const defaultFrameApi: FrameApi = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/**
 * Coalesce the newest event of a burst into a single `apply` per animation frame.
 * `apply` receives the most recent event scheduled before the frame ran; events that
 * arrive after the frame was scheduled but before it fires replace earlier ones.
 */
export function coalescePerFrame<E>(
  apply: (event: E) => void,
  frameApi: FrameApi = defaultFrameApi,
): PointerCoalescer<E> {
  let pending: E | null = null;
  let handle = 0;

  const run = (): void => {
    handle = 0;
    const event = pending;
    pending = null;
    if (event !== null) apply(event);
  };

  return {
    schedule(event: E): void {
      pending = event;
      if (handle === 0) handle = frameApi.request(run);
    },
    cancel(): void {
      if (handle !== 0) frameApi.cancel(handle);
      handle = 0;
      pending = null;
    },
  };
}
