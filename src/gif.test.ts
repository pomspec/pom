import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { BrowserType } from "@playwright/test";
import {
  firstOf,
  framePage,
  makeGifs,
  NO_FFMPEG,
  NO_PLAYWRIGHT,
  startAt,
  stripOf,
  withBrand,
} from "./gif.ts";
import type { Video } from "./view/model.ts";

// A video's GIF for its pull request's comment (gif.ts): its palette, where it starts, the
// page each frame is drawn in, and the GIF itself where this machine has ffmpeg and a
// Chromium that starts.

const SIZE = { height: 200, width: 320 };

/** A journey's marks: a caption, a move and a click, a proof. */
const video = (overrides: Partial<Video> = {}): Video => ({
  badges: [],
  chapters: [{ start: 0.2, title: "Say hello" }],
  checks: [{ at: 1.2, picture: null, text: 'I see "Hello"', verdict: "found" }],
  duration: 1.8,
  journey: { file: "spec/say-hello.feature", route: "/", slug: "say-hello", title: "Say hello" },
  lines: [{ end: 1.2, start: 0.6, text: 'When I press the "Say hello" button' }],
  mode: "visual",
  passed: true,
  pointer: [{ end: 0.9, start: 0.7, x: 100, y: 60 }],
  rings: [{ box: { h: 20, w: 80, x: 60, y: 50 }, end: 1.6, start: 1.2, tone: "found" }],
  ripples: [{ at: 1, x: 100, y: 60 }],
  seconds: 2,
  size: SIZE,
  ...overrides,
});

const folder = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pom-gif-"));
  after(() => rmSync(dir, { force: true, recursive: true }));
  return dir;
};

test("the palette keeps pomspec's colours over palettegen's repeats, its transparent one kept", () => {
  const palette = Buffer.alloc(256 * 4, 7);
  withBrand(palette);
  const at = (i: number) => [...palette.subarray(i * 4, i * 4 + 4)];
  // What palettegen chose stays; white and the blues follow, then the repeats it wrote.
  assert.deepEqual(at(114), [7, 7, 7, 7]);
  assert.deepEqual(at(115), [255, 255, 255, 255]);
  assert.deepEqual(at(116), [0x1b, 0x45, 0xd1, 255]);
  assert.deepEqual(at(127), [7, 7, 7, 7]);
  assert.deepEqual(at(255), [7, 7, 7, 7]);
});

test("a GIF starts once the app has drawn, never long before the first step", () => {
  const white = new Uint8Array(16).fill(255);
  const drawn = new Uint8Array(16).fill(20);
  const frames = (from: number) => (i: number) => (i < from ? white : drawn);
  // The app draws at 0.8 s, just before its first step at 0.83 s.
  assert.equal(startAt(0.83, 60, frames(8)), 8);
  // Drawn at once, its first step 3 s in: a quarter of a second before it.
  assert.equal(startAt(3, 60, frames(1)), 27);
  // Nothing changed before its first step: from just before it.
  assert.equal(startAt(0.4, 60, frames(50)), 1);
  // Never past its last frame.
  assert.equal(startAt(9, 20, frames(1)), 19);
  // Its first step: its first caption, move, mark or check.
  assert.equal(firstOf(video()), 0.6);
});

test("each frame's page has pomspec's strip above the picture and the end card over it", () => {
  const page = framePage(1280);
  assert.equal(stripOf(1280), 68);
  assert.equal(stripOf(920) % 2, 0);
  assert.match(page, /#strip\{box-sizing:border-box;height:68px;/);
  // Its words: “Open in pomspec ↗” in the strip and on the end card, the title set later.
  assert.equal(page.split("<span>Open in pomspec</span>").length, 3);
  assert.match(page, /<div class="title" id="named"><\/div>/);
  assert.match(page, /window\.pomGif = \{/);
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

test("without ffmpeg, or Playwright, there is no GIF, and a line says why", async () => {
  const dir = folder();
  writeFileSync(path.join(dir, "video.json"), JSON.stringify(video()));
  // A GIF of an older recording: the journey played again since.
  writeFileSync(path.join(dir, "journey.gif"), "GIF89a");
  const webm = path.join(dir, "journey.webm");
  writeFileSync(webm, "webm");
  const later = new Date(Date.now() + 60_000);
  utimesSync(webm, later, later);
  const gifs = [{ dir, reference: "the reference", video: video() }];
  const said: Array<string> = [];
  const PATH = process.env.PATH;
  process.env.PATH = dir;
  try {
    await makeGifs(gifs, { from: dir, say: (line) => said.push(line) });
  } finally {
    process.env.PATH = PATH;
  }
  assert.deepEqual(said, [NO_FFMPEG]);
  // Gone, though none was made in its place: never shown for the newer recording.
  assert.equal(existsSync(path.join(dir, "journey.gif")), false);
  if (!hasFfmpeg) return;
  said.length = 0;
  await makeGifs(gifs, { from: dir, say: (line) => said.push(line) });
  assert.deepEqual(said, [NO_PLAYWRIGHT]);
});

/** pom's own Playwright's Chromium, when it starts here. */
async function chromiumHere(): Promise<boolean> {
  try {
    const { chromium } = createRequire(import.meta.url)("@playwright/test") as {
      chromium: BrowserType;
    };
    await (await chromium.launch()).close();
    return true;
  } catch {
    return false;
  }
}

test(
  "a GIF is drawn from the recording, under the frame, and kept while it is fresh",
  { skip: !hasFfmpeg || !(await chromiumHere()) },
  async () => {
    const dir = folder();
    const webm = path.join(dir, "journey.webm");
    // Half a second of a white screen, then a grey one, as a recording.
    const color = (c: string, d: number) => [
      "-f",
      "lavfi",
      "-i",
      `color=c=${c}:s=${SIZE.width}x${SIZE.height}:d=${d}`,
    ];
    const made = spawnSync("ffmpeg", [
      "-loglevel",
      "error",
      ...color("white", 0.5),
      ...color("gray", 1.5),
      "-filter_complex",
      "[0][1]concat=n=2:v=1",
      "-c:v",
      "libvpx",
      webm,
    ]);
    assert.equal(made.status, 0, String(made.stderr));
    writeFileSync(path.join(dir, "video.json"), JSON.stringify(video()));
    const said: Array<string> = [];
    const gifs = [{ dir, reference: "the reference", video: video() }];
    await makeGifs(gifs, { from: import.meta.dirname, say: (line) => said.push(line) });
    assert.equal(said.length, 0, said.join("\n"));
    const gif = path.join(dir, "journey.gif");
    const bytes = readFileSync(gif);
    assert.equal(bytes.subarray(0, 6).toString(), "GIF89a");
    // Never wider than the recording; its strip above the picture.
    assert.equal(bytes.readUInt16LE(6), SIZE.width);
    assert.equal(bytes.readUInt16LE(8), SIZE.height + stripOf(SIZE.width));
    // Made after its recording: kept as it is.
    const first = statSync(gif).mtimeMs;
    await makeGifs(gifs, { from: import.meta.dirname, say: (line) => said.push(line) });
    assert.equal(statSync(gif).mtimeMs, first);
  },
);
