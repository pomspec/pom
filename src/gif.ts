import { execFile, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Browser, BrowserType } from "@playwright/test";
import { PNG } from "pngjs";
import { plainVideo } from "./videos.ts";
import type { Video } from "./view/model.ts";

// A video's GIF, for its pull request's comment on GitHub: journey.gif, beside the
// journey.webm it is made from. A recording is the app alone; what the journey did is
// drawn over it by pom's frame (view/frame.ts, the file pomspec's player draws with: the
// camera, the spotlight, the pointer and its clicks, the captions), so each of the
// recording's frames is drawn here under that same file, in Chromium, and pictured: the
// GIF moves as the video plays on pomspec, and the two never drift. Its words are the
// video's as the page shows them (plainVideo).
//
// The GIF says whose it is, drawn by this file's own page around pom's frame (the player
// has chrome of its own, so frame.ts never draws it): a white strip above the app's
// picture, never on it, the journey's title at its left and Pom and "Open in pomspec ↗"
// at its right, the same in every frame, so wherever a looping GIF is caught it says that
// a click opens pomspec (the comment links it to the video there), and nothing of it
// reads as the app's; and an end card after the last frame, Pom, the journey's title and
// "Open in pomspec ↗" again. It starts once the app has drawn its first screen.
//
// GitHub shows a comment's GIF at up to 460 px: it is drawn at twice that, ten frames a
// second (only those frames are drawn, never the recording's 25), and smaller again while
// it is over its budget. Chromium is the project's own, from its @playwright/test (pom
// brings no Playwright), and ffmpeg this machine's: without either there is no GIF, said
// in a line, and the upload goes on without it.

/** Frames drawn a second: the GIF's first try shows each; the smaller ones fewer. */
const FPS = 10;
/**
 * The GIF's widths and frame rates, tried in turn until it fits the budget: the camera's
 * moves change every pixel, so it steps down gently, keeping the captions readable. Never
 * wider than the recording.
 */
const GIF_TRIES: ReadonlyArray<readonly [number, number]> = [
  [920, 10],
  [800, 8],
  [720, 8],
  [640, 7],
  [560, 6],
];
/** Comfortable on a pull request's page: past it, the next try. */
const GIF_BUDGET = 8 * 1024 * 1024;
/** Videos drawn at once, each in a page of its own. */
const AT_ONCE = 3;
/** The end card's length, after the video's last frame, and its fade in: the white first, then what it says. */
const END_CARD = 3;
const END_FADE = 0.4;
/** pomspec's strip above the picture: its height, in a fortieth of the video's width (48 px of the GIF's 920). */
const STRIP = 2.1;
/**
 * Whether the app has drawn: two frames differ when more than a few of their pixels
 * (`SPECK`, a share) changed by more than the recording's noise (`SHADE` levels).
 */
const SHADE = 10;
const SPECK = 0.0001;
/** The GIF starts at most this long before the video's first step, once the app has drawn. */
const LEAD = 0.25;
/** The GIF's colours, those its palette keeps for pomspec's included (`BRAND`): GitHub's GIFs seldom need more. */
const GIF_COLORS = 128;
/** A screenshot's quality, as a frame waits for the GIF. */
const QUALITY = 94;

// pomspec's look: white and one blue, the system's sans.
const BLUE = "#1b45d1";
const DEEP = "#102c8a";
/** brand-line (pomspec's web app): the blue at 15% on white. */
const LINE = "#dde3f8";
const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
/** A colour drawn at `alpha` on white, as [r, g, b]. */
const onWhite = (hex: string, alpha: number) =>
  [1, 3, 5].map((at) =>
    Math.round(255 - alpha * (255 - Number.parseInt(hex.slice(at, at + 2), 16))),
  );
/**
 * pomspec's colours, kept in every GIF's palette: white, and the blue and the deep blue
 * each with the shades their edges blend through on white. A palette fitted to what
 * moves (stats_mode=diff) never counts the strip, which never moves, nor the end card,
 * which is held: without them the title comes out slate, specked with grey.
 */
const BRAND: ReadonlyArray<ReadonlyArray<number>> = [
  [255, 255, 255],
  ...[1, 0.85, 0.7, 0.55, 0.4, 0.25, 0.15].map((alpha) => onWhite(BLUE, alpha)),
  ...[1, 0.75, 0.5, 0.25].map((alpha) => onWhite(DEEP, alpha)),
];
/** What the strip and the end card say: a click opens pomspec, elsewhere (↗), not a play button. */
const OPEN = "Open in pomspec";

/** Pom's head, as pomspec's web app draws it: `ink` its line and face, `fill` its fur. */
const pomHead = (ink: string, fill: string) =>
  `<svg viewBox="54 38 132 120" fill="none" aria-hidden="true"><path d="M89 72 L95 45 L111 61 Q120 57 129 61 L145 45 L151 72 C163 79 170 90 169 99 Q179 103 173 110 Q181 118 171 122 Q176 132 163 132 Q162 142 149 139 Q142 150 134 142 Q127 152 120 144 Q113 152 106 142 Q98 150 91 139 Q78 142 77 132 Q64 132 69 122 Q59 118 67 110 Q61 103 71 99 C70 90 77 79 89 72Z" fill="${fill}" stroke="${ink}" stroke-linejoin="round" stroke-width="7"/><ellipse cx="106" cy="98" rx="6" ry="7" fill="${ink}"/><ellipse cx="134" cy="98" rx="6" ry="7" fill="${ink}"/><path d="M113 108 Q120 104 127 108 Q125 115 120 116 Q115 115 113 108Z" fill="${ink}"/><path d="M120 116 v3 M113 119 q3.5 4.5 7 0 q3.5 4.5 7 0" stroke="${ink}" stroke-linecap="round" stroke-linejoin="round" stroke-width="3"/></svg>`;
/**
 * Pom's head drawn small, as pomspec's favicon draws it: shapes that keep its eyes and
 * nose at a dozen pixels, where the line drawing's would blur into its fur.
 */
const pomMark = (fur: string, face: string) =>
  `<svg viewBox="0.2 2.2 15.6 14" aria-hidden="true"><g fill="${fur}"><path d="M2.6 7 L3.8 2.4 L6.8 5 Z M13.4 7 L12.2 2.4 L9.2 5 Z"/><ellipse cx="8" cy="9.4" rx="6.1" ry="5"/><circle cx="1.9" cy="9.8" r="1.6"/><circle cx="14.1" cy="9.8" r="1.6"/><circle cx="2.6" cy="12.4" r="1.6"/><circle cx="13.4" cy="12.4" r="1.6"/><circle cx="5.2" cy="14" r="1.7"/><circle cx="8" cy="14.4" r="1.6"/><circle cx="10.8" cy="14" r="1.7"/></g><g fill="${face}"><rect x="5" y="8" width="2" height="2.4" rx=".9"/><rect x="9" y="8" width="2" height="2.4" rx=".9"/><path d="M6.9 11.3 H9.1 L8 12.6 Z"/></g></svg>`;
/** ↗, drawn: the same in every renderer's fonts. It says the click goes elsewhere. */
const OUT = `<svg class="out" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 9 L8.6 3.4 M4.2 3 H9 V7.8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** The strip's height in pixels, for a video this wide: even, as a GIF scaled by half stays whole. */
export const stripOf = (width: number) => 2 * Math.round((width / 40) * (STRIP / 2));

/**
 * What the page does, as its own script (pom's types know no DOM): `build` puts the frame
 * in its stage and the title in the strip and on the end card, `draw` shows a frame of
 * the recording at its moment under what the journey did then, `end` fades the end card
 * in. The video is handed over once, so the frame's work on it is kept between frames.
 */
const PAGE = `window.pomGif = {
  build(video, title) {
    window.PomFrame.build(document.getElementById("stage"), document.getElementById("picture"));
    for (const id of ["named", "title"]) document.getElementById(id).textContent = title;
    window.pomGifVideo = video;
  },
  async draw(src, t) {
    const picture = document.getElementById("picture");
    picture.src = src;
    await picture.decode();
    window.PomFrame.draw(document.getElementById("stage"), window.pomGifVideo, t);
  },
  end(back, card) {
    const end = document.getElementById("end");
    end.style.background = "rgba(255,255,255," + back.toFixed(3) + ")";
    end.firstElementChild.style.opacity = card.toFixed(3);
  },
};`;

/** The page's script, as pom's code reaches it in the page (it has no DOM of its own). */
type InPage = Readonly<{
  pomGif: Readonly<{
    build: (video: Video, title: string) => void;
    draw: (src: string, t: number) => Promise<void>;
    end: (back: number, card: number) => void;
  }>;
}>;

/**
 * The page each frame is drawn in: pomspec's strip, and under it pom's frame (its stage
 * and the recording's picture) and the end card over that, sized by the video's width,
 * since the GIF is shown at the same width whatever the screen it recorded. The strip is
 * outside the stage, so nothing the frame draws (a spotlight's dimming) reaches it.
 */
export function framePage(width: number): string {
  const u = width / 40;
  const px = (n: number) => `${(n * u).toFixed(1)}px`;
  const strip = stripOf(width);
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:#fff}
body{font-family:${SANS};-webkit-font-smoothing:antialiased}
.out{height:.8em;width:.8em;display:block;flex:none}
#strip{box-sizing:border-box;height:${strip}px;display:flex;align-items:center;justify-content:space-between;gap:${px(1)};padding:0 ${px(0.55)} 0 ${px(0.7)};background:#fff;border-bottom:${Math.max(1, Math.round(width / 640))}px solid ${LINE};white-space:nowrap}
#strip .title{min-width:0;overflow:hidden;text-overflow:ellipsis;color:${DEEP};font-size:${px(0.98)};font-weight:600;letter-spacing:-0.01em}
#strip .open{flex:none;display:flex;align-items:center;gap:${px(0.3)};color:${BLUE};font-size:${px(1.02)};font-weight:600;letter-spacing:-0.005em}
#strip .open>svg:first-child{height:${px(1.45)};width:auto;display:block}
#end{position:fixed;left:0;right:0;top:${strip}px;bottom:0;z-index:2;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0)}
#end .card{display:flex;flex-direction:column;align-items:center;gap:${px(0.7)};width:100%;opacity:0}
#end .pom{height:${px(3.8)}}
#end .pom svg{height:100%;width:auto;display:block}
#end .title{max-width:82%;color:${DEEP};font-size:${px(1.65)};font-weight:700;line-height:1.15;letter-spacing:-0.015em;text-align:center;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
#end .call{display:flex;align-items:center;gap:${px(0.34)};margin-top:${px(0.2)};padding:${px(0.42)} ${px(0.9)} ${px(0.48)} ${px(1)};border-radius:999px;background:${BLUE};color:#fff;font-size:${px(1)};font-weight:600}
</style><body><div id="strip"><div class="title" id="named"></div><div class="open">${pomMark(BLUE, "#fff")}<span>${OPEN}</span>${OUT}</div></div>
<div id="stage"></div><img id="picture" alt="">
<div id="end"><div class="card"><div class="pom">${pomHead(BLUE, "#fff")}</div><div class="title" id="title"></div><div class="call"><span>${OPEN}</span>${OUT}</div></div></div>
<script>${PAGE}</script>
</body>`;
}

/**
 * A GIF's palette as ffmpeg's palettegen writes it (16 × 16, RGBA: the colours it chose,
 * the last of them repeated to fill, and last the transparent one, which lets a frame
 * leave what did not change), with pomspec's colours (`BRAND`) over the repeats, up to
 * GIF_COLORS.
 */
export function withBrand(palette: Buffer): Buffer {
  const from = GIF_COLORS - 1 - BRAND.length;
  BRAND.forEach(([r, g, b], i) => palette.set([r!, g!, b!, 255], (from + i) * 4));
  return palette;
}

/** When the video first does something: its first caption, move, mark or check. */
export function firstOf(video: Video): number {
  return Math.min(
    video.duration,
    ...video.lines.map((l) => l.start),
    ...video.pointer.map((p) => p.start),
    ...video.rings.map((r) => r.start),
    ...video.ripples.map((r) => r.at),
    ...video.checks.map((c) => c.at),
  );
}

/** Whether two frames' pixels (RGBA) differ: more than a few of them changed shade. */
function differs(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return true;
  let changed = 0;
  for (let i = 0; i < a.length; i += 4)
    if (
      Math.abs(a[i]! - b[i]!) > SHADE ||
      Math.abs(a[i + 1]! - b[i + 1]!) > SHADE ||
      Math.abs(a[i + 2]! - b[i + 2]!) > SHADE
    )
      changed++;
  return changed > (a.length / 4) * SPECK;
}

/**
 * The frame the GIF starts at, of `frames` drawn `FPS` a second: once the app has drawn
 * (where the recording's picture last changed before the video's first step, `first`),
 * and no more than LEAD before that step, a screen waited on before it left out. `pixels`
 * reads a frame (each once, in order).
 */
export function startAt(first: number, frames: number, pixels: (i: number) => Uint8Array) {
  let drawn = 0;
  let previous: Uint8Array | null = null;
  for (let i = 0; i < frames && i / FPS <= first; i++) {
    const now = pixels(i);
    if (previous && differs(previous, now)) drawn = i;
    previous = now;
  }
  return Math.max(0, Math.min(Math.max(drawn, Math.floor((first - LEAD) * FPS)), frames - 1));
}

const run = promisify(execFile);
/** ffmpeg, without holding up the other videos being drawn meanwhile. */
const ffmpeg = (...args: Array<string>) =>
  run("ffmpeg", ["-y", "-loglevel", "error", ...args], { maxBuffer: 64 * 1024 * 1024 });

/** pom's frame, as the page runs it: a classic script, built (dist) or its types taken out (src). */
function frameScript(): string {
  const built = path.join(import.meta.dirname, "view", "frame.js");
  if (existsSync(built)) return readFileSync(built, "utf8");
  const source = path.join(import.meta.dirname, "view", "frame.ts");
  return stripTypeScriptTypes(readFileSync(source, "utf8"), { mode: "strip" });
}

/** A video a GIF is made of. */
export type Gif = Readonly<{
  /** Its folder: journey.gif goes beside its journey.webm. */
  dir: string;
  /** What its words are measured against, as plainVideo takes it ("the reference"). */
  reference: string;
  video: Video;
}>;

/** Said when no GIF is made: one line, and the upload goes on. */
export const NO_FFMPEG =
  "No GIFs for the pull request's comment: they need ffmpeg (brew install ffmpeg, or apt install ffmpeg).";
export const NO_PLAYWRIGHT =
  "No GIFs for the pull request's comment: they're drawn in Playwright's Chromium, and @playwright/test isn't installed beside the spec.";
export const noChromium = (why: string) =>
  `No GIFs for the pull request's comment: Playwright's Chromium didn't start (npx playwright install chromium installs it): ${why}`;

/** An error's first line, cut short: what a line says of it. */
const firstLine = (error: unknown) => {
  const line = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
};

/** A GIF made already, after its recording and its video.json were: not made again. */
const fresh = (dir: string) => {
  const gif = path.join(dir, "journey.gif");
  if (!existsSync(gif)) return false;
  const made = statSync(gif).mtimeMs;
  return ["journey.webm", "video.json"].every(
    (file) => statSync(path.join(dir, file)).mtimeMs <= made,
  );
};

/**
 * Each video's GIF, journey.gif beside its journey.webm, drawn in Chromium from `from`'s
 * @playwright/test (the spec's folder): one made already, after its recording, is kept.
 * Without ffmpeg, Playwright or a Chromium that starts, none is made and `say` says why in
 * a line; a video whose GIF fails is said in a line too, and the others are made.
 */
export async function makeGifs(
  gifs: ReadonlyArray<Gif>,
  { from, say }: Readonly<{ from: string; say: (line: string) => void }>,
): Promise<void> {
  const queue = gifs.filter((gif) => !fresh(gif.dir));
  if (!queue.length) return;
  // One of an older recording goes, made again or not: never shown for this one.
  for (const gif of queue) rmSync(path.join(gif.dir, "journey.gif"), { force: true });
  if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0) return say(NO_FFMPEG);
  let chromium: BrowserType;
  try {
    chromium = (
      createRequire(path.join(from, "x.js"))("@playwright/test") as { chromium: BrowserType }
    ).chromium;
  } catch {
    return say(NO_PLAYWRIGHT);
  }
  let script: string;
  try {
    script = frameScript();
  } catch (error) {
    return say(`No GIFs for the pull request's comment: ${firstLine(error)}`);
  }
  let browser: Browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    return say(noChromium(firstLine(error)));
  }
  try {
    await Promise.all(
      Array.from({ length: Math.min(AT_ONCE, queue.length) }, async () => {
        for (let gif = queue.shift(); gif; gif = queue.shift()) {
          // Worked on outside the video's folder, and cleared whatever happens: a GIF goes
          // beside its recording only once it is whole.
          const work = mkdtempSync(path.join(tmpdir(), "pom-gif-"));
          try {
            copyFileSync(
              await frame(browser, script, gif, work),
              path.join(gif.dir, "journey.gif"),
            );
          } catch (error) {
            say(`No GIF of “${gif.video.journey.title}”: ${firstLine(error)}`);
          } finally {
            rmSync(work, { force: true, recursive: true });
          }
        }
      }),
    );
  } finally {
    await browser.close();
  }
}

/**
 * One video's GIF, made in `work`: its recording's frames, ten a second, each drawn under
 * pom's frame with pomspec's strip above it, then the end card, then the GIF of them all
 * at the first size within its budget. Where it is.
 */
async function frame(browser: Browser, script: string, gif: Gif, work: string): Promise<string> {
  const webm = path.join(gif.dir, "journey.webm");
  const video = plainVideo(gif.video, gif.reference);
  const clean = path.join(work, "clean");
  const framed = path.join(work, "framed");
  mkdirSync(clean, { recursive: true });
  mkdirSync(framed);
  await ffmpeg("-i", webm, "-vf", `fps=${FPS}`, "-start_number", "0", path.join(clean, "%05d.png"));
  const frames = readdirSync(clean).filter((f) => f.endsWith(".png")).length;
  if (!frames) throw new Error("its recording has no frames");
  const name = (i: number) => String(i).padStart(5, "0");
  const named = (i: number) => path.join(framed, `${name(i)}.jpg`);
  const { height, width } = video.size;
  const strip = stripOf(width);
  writeFileSync(path.join(work, "frame.html"), framePage(width));

  const start = startAt(
    firstOf(video),
    frames,
    (i) => PNG.sync.read(readFileSync(path.join(clean, `${name(i)}.png`))).data,
  );

  const page = await browser.newPage({ viewport: { height: strip + height, width } });
  let drawn = 0;
  try {
    await page.goto(pathToFileURL(path.join(work, "frame.html")).href);
    await page.addScriptTag({ content: script });
    await page.evaluate(
      ([one, title]) => (globalThis as unknown as InPage).pomGif.build(one, title),
      [video, video.journey.title] as const,
    );
    for (let i = start; i < frames; i++) {
      await page.evaluate(([src, t]) => (globalThis as unknown as InPage).pomGif.draw(src, t), [
        `clean/${name(i)}.png`,
        i / FPS,
      ] as const);
      await page.screenshot({ path: named(drawn++), quality: QUALITY, type: "jpeg" });
    }
    // The end card, over the video's last frame and under the strip, which stays: its
    // white faded in, then what it says, so the two never show through each other; then
    // held, the same frame again.
    const fading = Math.max(1, Math.round(END_FADE * FPS));
    const ease = (p: number) => 1 - (1 - Math.min(1, Math.max(0, p))) ** 2;
    for (let k = 1; k <= fading; k++) {
      const p = k / fading;
      await page.evaluate(
        ([back, card]) => (globalThis as unknown as InPage).pomGif.end(back, card),
        [ease(p * 2), ease(p * 2 - 1)] as const,
      );
      await page.screenshot({ path: named(drawn++), quality: QUALITY, type: "jpeg" });
    }
    const held = named(drawn - 1);
    for (let k = fading; k < Math.round(END_CARD * FPS); k++) copyFileSync(held, named(drawn++));
  } finally {
    await page.close();
  }

  // From the drawn frames themselves, its palette fitted to what moves in the video and
  // keeping pomspec's colours (withBrand), undithered (a dither's pattern changes with
  // every move of the camera) and each frame writing only the part that changed (never
  // the strip); smaller again while it is over its budget.
  const out = path.join(work, "journey.gif");
  const palette = path.join(work, "palette.rgba");
  const widest = 2 * Math.floor(width / 2);
  for (const [wide, fps] of GIF_TRIES) {
    const sized = `fps=${fps},scale=${Math.min(wide, widest)}:-2:flags=lanczos`;
    const input = ["-framerate", String(FPS), "-i", path.join(framed, "%05d.jpg")];
    await ffmpeg(
      ...input,
      "-vf",
      `${sized},palettegen=stats_mode=diff:max_colors=${GIF_COLORS - BRAND.length}`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      palette,
    );
    writeFileSync(palette, withBrand(readFileSync(palette)));
    await ffmpeg(
      ...input,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-video_size",
      "16x16",
      "-i",
      palette,
      "-lavfi",
      `[0:v]${sized}[video];[video][1:v]paletteuse=dither=none:diff_mode=rectangle`,
      out,
    );
    if (statSync(out).size <= GIF_BUDGET) break;
  }
  return out;
}
