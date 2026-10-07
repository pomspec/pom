import "./frame.ts";
import type { PomFrame as Frame } from "./frame.ts";

// A video's frame for a page that bundles its scripts (`pomspec/frame`). frame.ts stays
// a classic script that sets `window.PomFrame`, since the videos runner injects it into
// Chromium as one (prototype/videos.ts) and its test runs it in a VM, where an `export`
// would not parse; imported here, it runs once and is handed on as a module's export.

export type { Captions, DrawOptions, Scene, Spot, View } from "./frame.ts";
export type PomFrame = Frame;
export const PomFrame: PomFrame = window.PomFrame;
