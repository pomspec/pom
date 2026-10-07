import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { inside, listedIn, type Masker, masker, secretsIn } from "./secrets.ts";
import type { Video } from "./view/model.ts";

// `pom videos`' reel: a journey recorded for pomspec as its generated test plays it
// (generate.ts hands it each caption and line, in the test's own worker, when
// POM_VIDEOS says where its side's videos go). The video is the app alone, recorded as it
// is: nothing is drawn into it, since pomspec's player draws the pointer, rings and
// captions from what is kept beside it, video.json, each mark at its moment in the
// video's own time (its clock starts as the recording does).
//
// Each control is found as the test finds it, by its role and name: a person's pace is
// added around it (a look at the target before acting, a beat to see what it did), a
// pause for whoever watches, never a wait for the app. What a `Then` line proves is
// ringed once it holds. A journey that stops is recorded to where it stopped, a picture of
// the screen there; one that stops before its own steps begin (signing in) is recorded
// standing there. Each chapter keeps a picture of the screen as it ends (at its last
// proof, else as it ends): what `pom videos` compares between a pull request's two sides,
// so it is pictured as `pom shots` pictures a moment (its clock fixed, embedded frames and
// the config's masks covered, its stylesheet applied), else a clock, or what a mask
// covers, would tell two plays minutes apart from each other.
//
// It never imports Playwright itself (the test hands it the page and its info): it runs
// beside the project's own Playwright, not pom's.

/** The videos' mode: each control found as the test finds it, by role and name, in the page. */
export const MODE = "reference";

/** Pauses for whoever watches, in milliseconds. */
const PACE = { after: 350, chapter: 500, end: 600, look: 600, miss: 1600, sees: 700, start: 300 };
/** The pointer's glide to a target, drawn by the player within the look before acting. */
const GLIDE = 0.38;

/** How a generated test names the line it is about to play. */
export type At = Readonly<{
  /** Its line in the journey's .feature, from 1. */
  line: number;
  /** What it acts on, or what it proves is on the screen, as the test reaches it. */
  target: (() => Locator) | null;
  /** Its verb, as the grammar has it (feature.ts): press, fill, see… */
  verb: string;
}>;

/** Lines a person acts with, on a control. */
const ACTS = new Set(["check", "fill", "press", "select"]);
/** Lines that prove something is on the screen. */
const PROVES = new Set(["opens", "see", "shows"]);

type Box = { h: number; w: number; x: number; y: number };

/** A video as it is recorded: Video, its lists open. */
type Recorded = {
  badges: Array<{ end: number; start: number; text: string; tone: "fail" | "pass" | "warn" }>;
  chapters: Array<{ picture?: string; start: number; title: string }>;
  checks: Array<{ at: number; picture: string | null; text: string; verdict: string }>;
  duration: number;
  journey: { file: string; route: string; slug: string; title: string };
  lines: Array<{ chapter: string; end: number; start: number; step: number | null; text: string }>;
  mode: string;
  passed: boolean;
  pointer: Array<{ end: number; start: number; x: number; y: number }>;
  rings: Array<{ box: Box; end: number; start: number; tone: "found" | "missing" }>;
  ripples: Array<{ at: number; x: number; y: number }>;
  seconds: number;
  size: { height: number; width: number };
};

/** The line playing now: said, not yet proven done. */
type Pending = { at: At | null; text: string };

/**
 * How the screen is pictured, as `pom shots` pictures it (`moment()`, generate.ts): the
 * config's clock, its masks and its stylesheet's text, as `pom videos` hands them to its
 * test workers (POM_VIDEOS_LOOK, play.ts).
 */
type Look = Readonly<{ clock: string | null; mask: ReadonlyArray<string>; style: string | null }>;

function lookIn(env: Readonly<Record<string, string | undefined>>): Look {
  let said: { clock?: unknown; mask?: unknown; stylePath?: unknown } = {};
  try {
    said = JSON.parse(env.POM_VIDEOS_LOOK ?? "{}") as typeof said;
  } catch {
    // None said: the screen as it is.
  }
  return {
    clock: typeof said.clock === "string" ? said.clock : null,
    mask: Array.isArray(said.mask)
      ? said.mask.filter((selector): selector is string => typeof selector === "string")
      : [],
    style: typeof said.stylePath === "string" ? readFileSync(said.stylePath, "utf8") : null,
  };
}

type Reel = {
  chapter: string;
  dir: string;
  video: Recorded;
  look: Look;
  /** The test's own mark in what it makes unique (generate.ts, `unique`), once it has one. */
  mark: () => string | null;
  mask: Masker;
  page: Page;
  pending: Pending | null;
  /** The screen at the chapter's latest proof: the picture the chapter keeps. */
  seen: Buffer | null;
  shot: number;
  t0: number;
};

const reels = new Map<string, Reel>();
/** The last line said before a video began (a sign-in's): where one that never began stopped. */
const before = new Map<string, Pending>();

const now = (reel: Reel) => (Date.now() - reel.t0) / 1000;
const pause = (page: Page, ms: number) => page.waitForTimeout(ms);
const center = (box: Box) => ({
  x: Math.round(box.x + box.w / 2),
  y: Math.round(box.y + box.h / 2),
});
/**
 * Takes the test's mark out of the screen (its text and fields), as `pom shots` does, so
 * `ana+<mark>@example.com` reads as the spec says it; `restore` puts it back. Run in the
 * page, as its source.
 */
const UNMARK = `(mark) => {
  const undo = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node, was = text.nodeValue || "";
    if (!was.includes(mark)) continue;
    text.nodeValue = was.replaceAll(mark, "");
    undo.push(() => (text.nodeValue = was));
  }
  for (const field of document.querySelectorAll("input, textarea")) {
    const was = field.value;
    if (!was.includes(mark)) continue;
    field.value = was.replaceAll(mark, "");
    undo.push(() => (field.value = was));
  }
  window.pomReelUndo = undo;
}`;
const RESTORE = "for (const undo of window.pomReelUndo || []) undo(); window.pomReelUndo = [];";

/**
 * A field that holds a secret, or the start of one as it is typed, shows dots, whoever
 * fills it: a line of the journey, or a role's sign-in module, which the reel never sees.
 * `whole`: every secret's value; `within`: those looked for inside other text too. Run
 * in the page, as its source, in every document it opens; the values stay in its closure.
 */
const HIDE = `(whole, within) => {
  const hidden = new WeakSet();
  const look = (field) => {
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return;
    const value = field.value;
    const secret =
      value !== "" &&
      (whole.some((one) => one.startsWith(value)) || within.some((one) => value.includes(one)));
    if (secret) {
      field.style.setProperty("-webkit-text-security", "disc");
      hidden.add(field);
    } else if (hidden.has(field)) {
      field.style.removeProperty("-webkit-text-security");
      hidden.delete(field);
    }
  };
  for (const kind of ["input", "change"])
    document.addEventListener(kind, (event) => look(event.target), true);
  for (const field of document.querySelectorAll("input, textarea")) look(field);
}`;

/**
 * The screen as the video keeps it: in the video's own pixels, still, covered and styled
 * as the config says, the test's mark taken out (two sides' marks differ; their screens
 * must not, for it); null when there is no page to see.
 */
async function screenshot(reel: Reel): Promise<Buffer | null> {
  const mark = reel.mark();
  const { look, page } = reel;
  try {
    if (mark) await page.evaluate(`(${UNMARK})(${JSON.stringify(`+${mark}`)})`);
    return await page.screenshot({
      animations: "disabled",
      caret: "hide",
      mask: [page.locator("iframe"), ...look.mask.map((selector) => page.locator(selector))],
      maskColor: "#d4d4d8",
      scale: "css",
      ...(look.style ? { style: look.style } : {}),
    });
  } catch {
    return null;
  } finally {
    if (mark) await page.evaluate(RESTORE).catch(() => {});
  }
}
const slug = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "chapter";
/** A line without its keyword: `Then I see "Saved"` → `I see "Saved"`. */
const unkeyed = (text: string) => text.replace(/^(?:Given|When|Then|And|But)\s+/, "");
/** The names a line quotes, in order. */
const quoted = (text: string) => [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);

/** A journey's id (`(app)/sign-out`) from its generated test's file. */
const journeyOf = (info: TestInfo) =>
  path
    .relative(process.env.POM_VIDEOS_TESTS ?? path.dirname(info.file), info.file)
    .replace(/\.spec\.ts$/, "")
    .split(path.sep)
    .join("/");

/** The route a journey starts at, from its folder: `(app)/settings/billing/x` → `/settings/billing`. */
const routeOf = (journey: string) =>
  `/${journey
    .split("/")
    .slice(0, -1)
    .filter((segment) => !/^\(.+\)$/.test(segment))
    .join("/")}`;

/**
 * Where a control is on the screen, brought into view as a person scrolls to it; null
 * when it is not there. `words`: what it says, not the box it fills (a paragraph's text,
 * not the page's width), for what a `Then` proves.
 */
async function boxOf(locator: Locator, size: Recorded["size"], words = false): Promise<Box | null> {
  const one = locator.first();
  try {
    await one.waitFor({ state: "visible", timeout: 5000 });
    await one.scrollIntoViewIfNeeded({ timeout: 2000 });
    const whole = await one.boundingBox({ timeout: 2000 });
    const said = words
      ? await one
          .evaluate((element) => {
            const range = element.ownerDocument.createRange();
            range.selectNodeContents(element);
            const { height, width, x, y } = range.getBoundingClientRect();
            return { height, width, x, y };
          })
          .catch(() => null)
      : null;
    const box = said && said.width > 0 && said.height > 0 ? said : whole;
    if (!box) return null;
    const x = Math.max(0, Math.round(box.x));
    const y = Math.max(0, Math.round(box.y));
    const w = Math.min(size.width, Math.round(box.x + box.width)) - x;
    const h = Math.min(size.height, Math.round(box.y + box.height)) - y;
    return w > 0 && h > 0 ? { h, w, x, y } : null;
  } catch {
    return null;
  }
}

/** Keeps a picture of the screen in the video's folder; its file's name. */
function keep(reel: Reel, name: string, png: Buffer) {
  reel.shot += 1;
  const file = `${String(reel.shot).padStart(2, "0")}-${name}.png`;
  writeFileSync(path.join(reel.dir, file), png);
  return file;
}

/** Ends the rings still open. */
const unring = (reel: Reel) => {
  for (const ring of reel.video.rings) if (ring.end < 0) ring.end = now(reel);
};

/**
 * The line playing done, once the test has moved past it: what a `Then` proves ringed
 * where it is and noted as a check, its screen kept for the chapter's picture; after an
 * action, a beat to see what it did.
 */
async function settle(reel: Reel) {
  const pending = reel.pending;
  if (!pending) return;
  reel.pending = null;
  const verb = pending.at?.verb ?? "";
  if (PROVES.has(verb) || verb === "arrive") {
    const target = pending.at?.target;
    const box = target ? await boxOf(target(), reel.video.size, verb === "see") : null;
    const at = now(reel);
    if (box) reel.video.rings.push({ box, end: -1, start: at, tone: "found" });
    reel.video.checks.push({
      at,
      picture: null,
      text: unkeyed(pending.text),
      verdict: "found",
    });
    reel.seen = (await screenshot(reel)) ?? reel.seen;
    await pause(reel.page, PACE.sees);
  } else await pause(reel.page, PACE.after);
  unring(reel);
}

/** The chapter that ends: its picture, the screen as it proved it (else as it ends). */
async function endChapter(reel: Reel) {
  const chapter = reel.video.chapters.at(-1);
  if (!chapter || chapter.picture) return;
  const png = reel.seen ?? (await screenshot(reel));
  if (png) chapter.picture = keep(reel, `end-of-${slug(chapter.title)}`, png);
}

/**
 * Where the journey stopped: the line playing, in the video's words (what it could not
 * find, else what went wrong), a picture of the screen there, and the badge that says
 * so.
 */
async function stopped(reel: Reel, info: TestInfo) {
  const { video } = reel;
  const pending = reel.pending ?? before.get(info.testId) ?? null;
  reel.pending = null;
  unring(reel);
  const at = now(reel);
  const verb = pending?.at?.verb ?? "";
  const names = quoted(pending?.text ?? "");
  const named = verb === "select" ? names.at(-1) : names[0];
  const error = reel.mask
    .mask(
      stripVTControlCharacters(info.error?.message ?? "")
        .split("\n")[0]!
        .trim(),
    )
    .slice(0, 300);
  // A control on the screen that never answered (one disabled) was found: what went wrong says.
  const shown =
    ACTS.has(verb) && pending?.at?.target
      ? await pending.at
          .target()
          .first()
          .isVisible()
          .catch(() => false)
      : false;
  // What stopped it, as the check keeps it: an error's own words stay in video.json, and
  // people read "It stopped before the end" (video.ts, plainCheck).
  let text: string;
  if (verb === "arrive") text = `It never got to ${named ?? "its page"}`;
  else if (verb === "shows" && names.length === 2)
    text = `“${names[0]}” doesn't show “${names[1]}”`;
  else if (named && !shown && (ACTS.has(verb) || PROVES.has(verb))) {
    text = `Couldn't find “${named}”`;
    video.lines.push({
      chapter: reel.chapter,
      end: -1,
      start: at,
      step: null,
      text: `“${named}” isn't on the page`,
    });
  } else text = error ? `It stopped: ${error}` : "It stopped before the end";
  const png = await screenshot(reel);
  video.checks.push({
    at,
    picture: png ? keep(reel, "stopped", png) : null,
    text,
    verdict: "missing",
  });
  video.badges.push({ end: -1, start: at, text: "The journey stops here", tone: "fail" });
  video.passed = false;
  await pause(reel.page, PACE.miss).catch(() => {});
}

/**
 * The video begins, once the journey's own steps do: a sign-in played first is not its
 * story. From here the page's clock is the config's, and a field holding a secret shows
 * dots. `mark`: the test's mark in what it makes unique, once it has one.
 */
export async function begin(
  page: Page,
  info: TestInfo,
  journey: string,
  mark: () => string | null = () => null,
) {
  const root = process.env.POM_VIDEOS;
  if (!root || reels.has(info.testId)) return;
  const secrets = secretsIn(process.env, listedIn(process.env));
  const mask = masker(secrets);
  const look = lookIn(process.env);
  const size = page.viewportSize() ?? { height: 720, width: 1280 };
  const dir = path.join(root, ...journey.split("/"), MODE);
  // A video is what this play made: an earlier play's pictures do not stay beside it.
  rmSync(dir, { force: true, recursive: true });
  mkdirSync(dir, { recursive: true });
  const reel: Reel = {
    chapter: "",
    dir,
    video: {
      badges: [],
      chapters: [],
      checks: [],
      duration: 0,
      journey: {
        file: path.posix.join(process.env.POM_VIDEOS_SPEC ?? "", `${journey}.feature`),
        route: routeOf(journey),
        slug: path.posix.basename(journey),
        title: mask.mask(info.title),
      },
      lines: [],
      mode: MODE,
      passed: true,
      pointer: [],
      rings: [],
      ripples: [],
      seconds: 0,
      size,
    },
    look,
    mark,
    mask,
    page,
    pending: null,
    seen: null,
    shot: 0,
    t0: Date.now(),
  };
  reels.set(info.testId, reel);
  if (look.clock) await page.clock.setFixedTime(new Date(look.clock));
  if (secrets.length) {
    const hide = `(${HIDE})(${JSON.stringify(secrets.map((secret) => secret.value))}, ${JSON.stringify(
      secrets.filter(inside).map((secret) => secret.value),
    )})`;
    await page.addInitScript(hide);
    await page.evaluate(hide).catch(() => {});
  }
  await page.screencast.start({ path: path.join(dir, "journey.webm"), size });
  await pause(page, PACE.start);
}

/** A chapter of the journey (its `# Caption`): the one before it ends, its picture kept. */
export async function chapter(page: Page, info: TestInfo, title: string) {
  const reel = reels.get(info.testId);
  if (!reel) return;
  await settle(reel);
  await endChapter(reel);
  const at = now(reel);
  const last = reel.video.lines.at(-1);
  if (last && last.end < 0) last.end = at;
  reel.chapter = reel.mask.mask(title);
  reel.video.chapters.push({ start: at, title: reel.chapter });
  reel.seen = null;
  await pause(page, PACE.chapter);
}

/**
 * A line about to play: said (a secret in it as dots), and for one that acts on a
 * control, the pointer to it and a look before the test acts there. A secret filled in
 * shows as dots on the screen too.
 */
export async function say(page: Page, info: TestInfo, text: string, at?: At | null) {
  const reel = reels.get(info.testId);
  if (!reel) {
    before.set(info.testId, { at: at ?? null, text });
    return;
  }
  await settle(reel);
  const start = now(reel);
  const last = reel.video.lines.at(-1);
  if (last && last.end < 0) last.end = start;
  const said = reel.mask.mask(text);
  reel.video.lines.push({
    chapter: reel.chapter,
    end: -1,
    start,
    step: at?.line ?? null,
    text: said,
  });
  reel.pending = { at: at ?? null, text: said };
  if (!at) return;
  if (ACTS.has(at.verb) && at.target) {
    const box = await boxOf(at.target(), reel.video.size);
    if (!box) return;
    const target = center(box);
    const t = now(reel);
    reel.video.pointer.push({ end: t + GLIDE, start: t, ...target });
    reel.video.rings.push({ box, end: -1, start: t, tone: "found" });
    if (at.verb === "fill" && said !== text)
      await at
        .target()
        .first()
        .evaluate((field) => field.style.setProperty("-webkit-text-security", "disc"))
        .catch(() => {});
    await pause(page, PACE.look);
    reel.video.ripples.push({ at: now(reel), ...target });
  } else if (at.verb === "key") await pause(page, PACE.look / 2);
}

/** A moment the generated test holds on: the line before it done. */
export async function hold(_page: Page, info: TestInfo) {
  const reel = reels.get(info.testId);
  if (reel) await settle(reel);
}

/**
 * A video's words as people read them (its title, lines, checks, badges and chapters),
 * every secret in them as dots; never its journey's file, route or slug, nor its
 * pictures' names, which name files and addresses.
 */
export const masked = (video: Recorded, mask: (text: string) => string): Recorded => ({
  ...video,
  badges: video.badges.map((badge) => ({ ...badge, text: mask(badge.text) })),
  chapters: video.chapters.map((chapter) => ({ ...chapter, title: mask(chapter.title) })),
  checks: video.checks.map((check) => ({ ...check, text: mask(check.text) })),
  journey: { ...video.journey, title: mask(video.journey.title) },
  lines: video.lines.map((line) => ({ ...line, text: mask(line.text) })),
});

/**
 * After the test, passed or not: the video ends where the journey did, and its marks are
 * written beside it (video.json), every secret in its words as dots.
 */
export async function finish(page: Page, info: TestInfo) {
  if (!process.env.POM_VIDEOS || info.status === "skipped") {
    reels.delete(info.testId);
    before.delete(info.testId);
    return;
  }
  const failed = info.status !== "passed";
  if (!reels.has(info.testId)) {
    // Stopped before its own steps began: recorded standing where it stopped.
    if (!failed) {
      before.delete(info.testId);
      return;
    }
    await begin(page, info, journeyOf(info)).catch(() => {});
    const said = before.get(info.testId);
    const reel = reels.get(info.testId);
    if (reel && said) {
      const text = reel.mask.mask(said.text);
      reel.video.lines.push({ chapter: "", end: -1, start: now(reel), step: null, text });
      reel.pending = { at: said.at, text };
    }
  }
  const reel = reels.get(info.testId);
  if (!reel) return;
  try {
    if (failed) await stopped(reel, info);
    else {
      await settle(reel);
      await endChapter(reel);
    }
    await pause(page, PACE.end);
  } catch {
    // The page went with the test (a crash, a timeout's end): the video keeps what it has.
  } finally {
    const { video } = reel;
    video.duration = now(reel);
    video.seconds = video.duration;
    for (const mark of [...video.lines, ...video.rings, ...video.badges])
      if (mark.end < 0) mark.end = video.duration;
    await page.screencast.stop().catch(() => {});
    const written: Video = masked(video, reel.mask.mask);
    writeFileSync(path.join(reel.dir, "video.json"), `${JSON.stringify(written, null, 1)}\n`);
    reels.delete(info.testId);
    before.delete(info.testId);
  }
}
