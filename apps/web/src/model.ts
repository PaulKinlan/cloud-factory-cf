/**
 * The canvas model now lives in `@factory-cloud/canvas-model` so the worker can
 * turn a stored document into the same agent configuration the UI exports.
 * Re-exported here so the renderer and its tests keep their import path.
 */
export * from "@factory-cloud/canvas-model";
