import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

// The video's frame (view/frame.ts), as both renderers load it: a classic script, its
// types taken out, that sets window.PomFrame.

type View = { x: number; y: number; zoom: number };
type Box = { h: number; w: number; x: number; y: number };
type Frame = {
  camera(video: unknown, t: number): View;
  captions(
    video: unknown,
    t: number,
  ): { opacity: number; roll: number; rows: Array<{ shown: string; text: string }> } | null;
  pointer(video: unknown, t: number): { opacity: number; press: number; x: number; y: number };
  spotlight(video: unknown, t: number): { box: Box; opacity: number; tone: string } | null;
  still(video: unknown): number;
};

/** Runs a script as Chromium runs an injected one, and hands back what it set. */
function run(script: string): Frame {
  const context = { window: {} as { PomFrame?: Frame } };
  vm.createContext(context);
  vm.runInContext(script, context);
  return context.window.PomFrame!;
}

function load(): Frame {
  const file = path.join(import.meta.dirname, "view", "frame.ts");
  return run(stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" }));
}

// What the published package ships (`files`), so what a renderer run from it injects,
// written by the build.
const BUILT = path.join(import.meta.dirname, "..", "dist", "view", "frame.js");

const SIZE = { height: 800, width: 1280 };

/** A journey as eyes.ts records one: see a headline, click a link far below, type, see a card. */
function video(overrides: Record<string, unknown> = {}) {
  return {
    badges: [],
    checks: [
      { at: 1.35, text: "The headline", verdict: "found" },
      { at: 2.38, text: "The link", verdict: "found" },
      { at: 4.6, text: "The card", verdict: "found" },
      { at: 12, text: "The screen", verdict: "same" },
    ],
    duration: 13,
    lines: [
      {
        end: 2.11,
        start: 0.81,
        text: "See the headline, “Gerenciar obra não precisa ser esse caos todo.”",
      },
      { end: 3.7, start: 2.11, text: "Click “ou veja o demo primeiro”" },
      { end: 4.3, start: 3.7, text: "Type “Casa Jardins”" },
      { end: 5.4, start: 4.3, text: "See the card" },
      { end: 13, start: 12, text: "The screen looks as it should" },
    ],
    pointer: [{ end: 2.82, start: 2.44, x: 728, y: 753 }],
    rings: [
      { box: { h: 120, w: 768, x: 256, y: 158 }, end: 2.11, start: 1.35, tone: "found" },
      { box: { h: 20, w: 160, x: 648, y: 743 }, end: 3.7, start: 2.38, tone: "found" },
      { box: { h: 18, w: 242, x: 1000, y: 40 }, end: 5.35, start: 4.6, tone: "found" },
    ],
    ripples: [{ at: 3.34, x: 728, y: 753 }],
    size: SIZE,
    ...overrides,
  };
}

const times = (end: number, step = 0.02) =>
  Array.from({ length: Math.ceil(end / step) }, (_, i) => i * step);

test("the built frame is a classic script too", { skip: !existsSync(BUILT) && "not built" }, () => {
  const built = run(readFileSync(BUILT, "utf8"));
  assert.deepEqual(Object.keys(built).sort(), Object.keys(load()).sort());
  assert.equal(built.camera(video(), 0.5).zoom, 1);
});

test("the same video always makes the same frames", () => {
  const a = load();
  const b = load();
  // Two loads are two realms: compared as data.
  const same = (x: unknown, y: unknown) => assert.equal(JSON.stringify(x), JSON.stringify(y));
  for (const t of times(13, 0.1)) {
    same(a.camera(video(), t), b.camera(video(), t));
    same(a.spotlight(video(), t), b.spotlight(video(), t));
    same(a.captions(video(), t), b.captions(video(), t));
  }
  assert.equal(a.still(video()), b.still(video()));
});

test("the camera never shows outside the video, nor past 1.8x", () => {
  const frame = load();
  const scene = video();
  for (const t of times(13)) {
    const { x, y, zoom } = frame.camera(scene, t);
    const w = SIZE.width / zoom / 2;
    const h = SIZE.height / zoom / 2;
    assert.ok(zoom >= 1 && zoom <= 1.8, `zoom ${zoom} at ${t}`);
    assert.ok(x - w >= -0.01 && x + w <= SIZE.width + 0.01, `x at ${t}`);
    assert.ok(y - h >= -0.01 && y + h <= SIZE.height + 0.01, `y at ${t}`);
  }
});

test("a proof is lit only once the camera is still on it, and it is in view", () => {
  const frame = load();
  const scene = video();
  let lit = 0;
  for (const t of times(13)) {
    const spot = frame.spotlight(scene, t);
    if (!spot || spot.opacity < 1) continue;
    lit++;
    const a = frame.camera(scene, t);
    assert.deepEqual(a, frame.camera(scene, t + 0.02), `the camera moves under a proof at ${t}`);
    const left = a.x - SIZE.width / a.zoom / 2;
    const top = a.y - SIZE.height / a.zoom / 2;
    assert.ok(spot.box.x >= left && spot.box.y >= top, `the proof is out of view at ${t}`);
  }
  // Each of the two proofs, for long enough to read.
  assert.ok(lit * 0.02 > 1, `lit for ${lit * 0.02} s`);
  // The click's ring is an action: never lit.
  assert.ok(!times(13).some((t) => frame.spotlight(scene, t)?.box.y === 743));
});

test("the camera goes in on each step, holds while typing, and out when nothing happens", () => {
  const frame = load();
  const scene = video();
  assert.equal(frame.camera(scene, 0.5).zoom, 1);
  assert.ok(frame.camera(scene, 1.9).zoom > 1.15, "in on the headline");
  // On the link from its click through the typing after it.
  for (const t of [3.4, 3.9, 4.2]) {
    const view = frame.camera(scene, t);
    const top = view.y - SIZE.height / view.zoom / 2;
    assert.ok(view.zoom > 1.15 && top <= 743, `on the link at ${t}`);
  }
  // Nothing from 5.4 to the screen check at 12: back out, and out for the check.
  assert.equal(frame.camera(scene, 9).zoom, 1);
  assert.equal(frame.camera(scene, 12.8).zoom, 1);
});

test("a failed wait is not typing: the camera does not stay in on it", () => {
  const frame = load();
  const scene = video({
    checks: [
      { at: 1.07, text: "The menu", verdict: "found" },
      { at: 22.48, text: "Couldn't find the tab", verdict: "missing" },
    ],
    duration: 24.7,
    lines: [
      { end: 2.33, start: 0.81, text: "Click “Configurações” in the menu" },
      { end: 22.48, start: 2.33, text: "Click the “Segurança” tab" },
      { end: 24.7, start: 22.48, text: "The “Segurança” tab isn't on the page" },
    ],
    pointer: [{ end: 1.51, start: 1.13, x: 112, y: 288 }],
    rings: [
      { box: { h: 36, w: 199, x: 12, y: 270 }, end: 2.33, start: 1.07, tone: "found" },
      {
        box: { h: 42, w: 100, x: 23, y: 266 },
        end: 24.7,
        label: "the closest",
        start: 22.48,
        tone: "missing",
      },
    ],
    ripples: [{ at: 1.97, x: 112, y: 288 }],
  });
  assert.equal(frame.camera(scene, 5).zoom, 1);
  const spot = frame.spotlight(scene, 24);
  assert.equal(spot?.tone, "missing");
  assert.equal(spot?.opacity, 1);
  // It ends on where it stopped, at rest.
  assert.ok(frame.camera(scene, 24.6).zoom > 1);
  assert.deepEqual(frame.camera(scene, 24.6), frame.camera(scene, 24.7));
  assert.ok(Math.abs(frame.still(scene) - 23.2) < 1.5);
});

test("captions: two rows at most, each word appearing where it stays", () => {
  const frame = load();
  const scene = video();
  for (const t of times(13)) {
    const said = frame.captions(scene, t);
    if (!said) continue;
    assert.ok(said.rows.length - (said.roll < 1 ? 1 : 0) <= 2, `rows at ${t}`);
    for (const row of said.rows) assert.ok(row.text.startsWith(row.shown), `${row.shown} at ${t}`);
  }
  // The headline's line is written word by word, across most of its time.
  const early = frame.captions(scene, 0.9)!.rows.at(-1)!;
  assert.equal(early.shown, "See");
  const later = frame
    .captions(scene, 2.0)!
    .rows.map((r) => r.shown)
    .join(" ");
  assert.ok(later.endsWith("todo.”"), later);
  // While the click far below happens, the captions over it let it show through.
  assert.ok(frame.captions(scene, 3.3)!.opacity < 0.5);
  assert.equal(frame.captions(scene, 1.9)!.opacity, 1);
});

test("the pointer comes in with its first move", () => {
  const frame = load();
  const scene = video();
  assert.equal(frame.pointer(scene, 1).opacity, 0);
  const at = frame.pointer(scene, 3);
  assert.deepEqual([at.opacity, Math.round(at.x), Math.round(at.y)], [1, 728, 753]);
  assert.ok(frame.pointer(scene, 3.45).press > 0);
});
