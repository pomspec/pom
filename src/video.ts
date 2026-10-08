import type {
  Verdict,
  Video,
  VideoMark,
  VideoPr,
  VideoRef,
  VideoRepo,
  VideoRun,
  VideoScope,
} from "./view/model.ts";

// What a run's videos say, wherever they are read: pure functions of video.json and its
// run, with nothing of Node's or a page's, so pom's runner, the service that keeps the
// videos and the web app that plays them say the same of the same video. A journey's
// verdict, a video's marks in plain words, the step a moment plays, and the addresses
// that name them, a project's or, as GitHub's paths do, its repository's.

/** How a pull request's sides are ordered: its head first, then its base, then any other target. */
export const sideOrder = (target: string) => ["head", "base"].indexOf(target) + 1 || 9;

/** Visual first: a video seen by its pixels alone, as a person sees the app. */
const MODES = ["visual", "reference"];
export const byMode = (a: { mode: string }, b: { mode: string }) =>
  (MODES.indexOf(a.mode) + 1 || 9) - (MODES.indexOf(b.mode) + 1 || 9);

/** What moved or looked different, as the video words it. */
const differences = (video: Video) =>
  video.checks.filter((c) => c.verdict === "moved" || c.verdict === "differs");

/** The chapter a moment of a video is in: the last that started by then. */
export const chapterAt = (video: Video, at: number) =>
  [...video.chapters].reverse().find((c) => c.start <= at + 0.001)?.title ??
  video.chapters[0]?.title ??
  null;

type Check = Video["checks"][number];

// A video's words, read whatever wrote them: the runner's checks (scores, thresholds and
// errors kept in video.json, where they are measured), its captions, badges and labels,
// and the plain words this file wrote before (a video already kept in plain words is read
// again when a page names what it was compared with), each to one meaning, then said in
// the words people read.

/**
 * What a video's words say it was measured against: what its own reference run kept
 * ("expected"), this change's (a compared run's Before video), or nothing (main's page:
 * main is not wrong).
 */
type Against = "change" | "expected" | null;

/**
 * What `plainVideo`'s reference names: "the reference" (or "expected"), what the video's own
 * reference run kept; null, nothing (main's page); any other name, this change, whatever
 * the run called its head (a branch's name is never said).
 */
const againstOf = (reference: string | null): Against =>
  reference === null
    ? null
    : reference === "the reference" || reference === "expected"
      ? "expected"
      : "change";

/** A line's first letter as a line starts, the rest as it is: “save” → “Save”, never “SAVE”. */
const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** How far a control moved, as the runner measures it: `12 px lower`, `8 px left and 4 px lower`. */
const WHERE = String.raw`\d+ px (?:left|right|higher|lower)(?: and \d+ px (?:higher|lower))?`;

/** What a video's words say, whichever words wrote it. */
type Said =
  | Readonly<{ control: string; kind: "missing" | "twice" }>
  | Readonly<{ control: string; kind: "found"; where: string | null }>
  | Readonly<{ kind: "screen"; same: boolean }>
  | Readonly<{ kind: "kept" | "stopped" }>
  | Readonly<{ kind: "other"; text: string }>;

const MISSING = [
  // The runner's eyes: the closest, how alike, what it needs.
  /^Couldn't find (.+?)(?: by .+?)?: the closest is /,
  // A reel's: by its role and name.
  /^Couldn't find (.+)$/,
  /^(.+) isn't on the page$/,
];
const TWICE = /^(.+?) could be in two places\b/;
const FOUND = [
  new RegExp(String.raw`^(.+?): [\d.]+ alike(?:, (${WHERE}) than in the reference)?(?: \(.*\))?$`),
  new RegExp(String.raw`^(.+?) is on the page(?:, (${WHERE}) than (?:expected|in .+))?$`),
  /^(.+?): found, and .+ kept$/,
];
const SCREEN = /^The screen: ([\d.]+)% different from .+?(?: \(([\d.]+)% allowed\))?$/;
/** A screen compared, in a caption or a badge: "The screen looks as expected", "Looks different from the reference". */
const LOOKS = /^(?:The screen looks|Looks) (as|like|different)\b/;
const KEPT = /^The screen[:,] kept (?:as the reference|for comparison)$/;
const STOPPED = /^It stopped(?:: [\s\S]*| before (?:its|the) end)$/;

/** A guard's lines from before they were plain: no methods, no scope, no action ids. */
function guarded(text: string): string | null {
  const blocked = /^Blocked [A-Z]+ (\S+): (.+)$/.exec(text);
  if (blocked) {
    const elsewhere = /^an? [A-Z]+ to another site \((.+)\)$/.exec(blocked[2]!);
    if (elsewhere)
      return `Blocked a request to another site (${elsewhere[1]}): it could change data`;
    const why = /\bchanges data there\b/.test(blocked[2]!)
      ? "it changes data"
      : "it could change data";
    return `Blocked a request to ${blocked[1]}: ${why}`;
  }
  const count = /^The guard blocked (\d+) requests? that could change data$/.exec(text);
  if (count) {
    const n = Number(count[1]);
    return `Blocked ${n} ${n === 1 ? "request" : "requests"} that could change data`;
  }
  const none =
    /^No request that could change data left the browser(?: \(\d+ the scope allows as reads\))?(; pages opened: .*)?$/.exec(
      text,
    );
  return none ? `Nothing that could change data left the browser${none[1] ?? ""}` : null;
}

/** Scores and thresholds out of words nothing else here reads. */
const unscored = (text: string) =>
  text
    .replace(/: [\d.]+ alike and [\d.]+ alike/g, "")
    .replace(/,? ?[\d.]+ alike\b/g, "")
    .replace(/ \([^)]*allowed\)/g, "");

/** What a check, caption, badge or label says; a check's verdict, when known, says whether a screen looked the same. */
function saidOf(text: string, verdict?: string): Said {
  for (const missing of MISSING) {
    const m = missing.exec(text);
    if (m) return { control: m[1]!, kind: "missing" };
  }
  const twice = TWICE.exec(text);
  if (twice) return { control: twice[1]!, kind: "twice" };
  if (KEPT.test(text)) return { kind: "kept" };
  const screen = SCREEN.exec(text);
  if (screen) {
    const [, ratio, allowed] = screen;
    const same =
      verdict === "same" || verdict === "differs"
        ? verdict === "same"
        : allowed
          ? Number(ratio) <= Number(allowed)
          : Number(ratio) === 0;
    return { kind: "screen", same };
  }
  const looks = LOOKS.exec(text);
  if (looks) return { kind: "screen", same: looks[1] !== "different" };
  if (STOPPED.test(text)) return { kind: "stopped" };
  for (const found of FOUND) {
    const m = found.exec(text);
    if (m) return { control: m[1]!, kind: "found", where: m[2] ?? null };
  }
  const chose = /^Chose (“.*”) through the page\b/.exec(text);
  if (chose) return { kind: "other", text: `Chose ${chose[1]}` };
  return { kind: "other", text: guarded(text) ?? unscored(text) };
}

/** What it is said against, in words: "than expected", "than in this change". */
const than = (against: "change" | "expected") =>
  against === "change" ? "than in this change" : "than expected";

/** What a video's words say, in the words people read; null for what is left out (a screen compared, on main's page). */
function wordsOf(said: Said, against: Against): string | null {
  switch (said.kind) {
    case "missing":
      return `${capital(said.control)} isn't on the page`;
    case "twice":
      return `${capital(said.control)} could be in two places`;
    case "found": {
      const on = `${capital(said.control)} is on the page`;
      return said.where && against ? `${on}, ${said.where} ${than(against)}` : on;
    }
    case "screen":
      if (against === null) return null;
      if (against === "change")
        return said.same
          ? "The screen looks as it does in this change"
          : "The screen looks different in this change";
      return said.same
        ? "The screen looks as expected"
        : "The screen looks different than expected";
    case "kept":
      return "The screen, kept for comparison";
    case "stopped":
      return "It stopped before the end";
    case "other":
      return said.text;
  }
}

/** What may say where a journey stopped as it is: where it never got, what did not show, what a guard blocked. */
const STOPS =
  /^(?:It never got to |“[^”]*” doesn't show “|Blocked |Nothing that could change data)/;

/** A check in plain words, against what it is measured against; null when it is left out. */
function checkWords(check: Pick<Check, "text" | "verdict">, against: Against): string | null {
  const said = saidOf(check.text, check.verdict);
  // A stop the video says in no words of ours is an error's: it stopped, no more.
  if (said.kind === "other" && check.verdict === "missing" && !STOPS.test(said.text))
    return "It stopped before the end";
  return wordsOf(said, against);
}

/**
 * A check as people read it, on every surface (a video's Timeline, a pull request's page,
 * GitHub): "{Control} isn't on the page" or "could be in two places", "{Control} is on
 * the page" and how far it moved, how the screen looks, "It stopped before the end" for an
 * error. No score, no threshold, no method, no error's own text: those stay in video.json.
 * `reference` as `plainVideo` takes it: what the video was measured against.
 */
export function plainCheck(
  check: Pick<Check, "text" | "verdict">,
  reference = "the reference",
): string {
  return checkWords(check, againstOf(reference)) ?? unscored(check.text);
}

/**
 * The control a failed check looked for, in the video's words (“Pay”): what it "Couldn't
 * find", what "isn't on the page", or what "could be in two places"; null when the check
 * names none.
 */
export function controlOf(text: string): string | null {
  const said = saidOf(text);
  return said.kind === "missing" || said.kind === "twice" ? said.control : null;
}

/** “12 px lower” as seen from the other side: “12 px higher”. */
const turned = (where: string) =>
  where.replace(
    /\b(left|right|higher|lower)\b/g,
    (w) => ({ higher: "lower", left: "right", lower: "higher", right: "left" })[w] ?? w,
  );

/**
 * What a change did, in plain words, from a check of its Before video (which looks for
 * what the change's reference run kept): what moved, and which way it went in this
 * change; or that a screen looks different. No scores, no thresholds; a line's start.
 */
export function differenceOf(video: Video, check: Check): string {
  if (check.verdict === "differs") {
    const chapter = chapterAt(video, check.at);
    return chapter ? `The screen at “${chapter}” looks different` : "A screen looks different";
  }
  const said = saidOf(check.text, check.verdict);
  if (check.verdict === "moved" && said.kind === "found" && said.where)
    return `${capital(said.control)} is ${turned(said.where)} in this change`;
  return capital(plainCheck(check));
}

/**
 * A video's marks in plain words, as the page paints them, its transcript and subtitles
 * read them and its Timeline lists its checks: no score, no threshold, no error's text
 * (video.json keeps them). A screen or a place is measured against `reference`: "the
 * reference", what the video's own reference run kept ("expected"); any other name, this
 * change's (a compared run's Before video, which looks for what the change kept: "in this
 * change"); null, nothing, as main's page shows main, which is not wrong: what was
 * compared is left out there, and nothing moved. Words it wrote before are read again.
 */
export function plainVideo(video: Video, reference: string | null = "the reference"): Video {
  const against = againstOf(reference);
  const label = (text: string | undefined) => {
    if (!text) return text;
    if (/^the closest(?:: [\d.]+ alike)?$/i.test(text)) return "The closest";
    if (/^[\d.]+ alike$/.test(text)) return undefined;
    const moved = new RegExp(
      String.raw`^(?:[\d.]+ alike · )?(${WHERE}) than (?:expected|in .+)$`,
    ).exec(text);
    if (moved) return against ? `${moved[1]} ${than(against)}` : undefined;
    return capital(text);
  };
  /** A badge: a screen's, by its tone when it gave a ratio. */
  const badge = (text: string, tone: string) => {
    const ratio = /^[\d.]+% different from the reference$/.test(text);
    return wordsOf(ratio ? { kind: "screen", same: tone === "pass" } : saidOf(text), against);
  };
  /**
   * A caption's screen, by its check: a caption kept without what was allowed (as this
   * file kept them before) says only how different, not whether that was too much.
   */
  const screenOf = (text: string) => {
    const ratio = SCREEN.exec(text)?.[1];
    return ratio === undefined
      ? undefined
      : video.checks.find(
          (c) =>
            (c.verdict === "same" || c.verdict === "differs") && SCREEN.exec(c.text)?.[1] === ratio,
        )?.verdict;
  };
  return {
    ...video,
    badges: video.badges.flatMap((b) => {
      const text = badge(b.text, b.tone);
      return text === null ? [] : [{ ...b, text }];
    }),
    checks: video.checks.flatMap((c) => {
      const text = checkWords(c, against);
      const verdict = against === null && c.verdict === "moved" ? "found" : c.verdict;
      return text === null ? [] : [{ ...c, text, verdict }];
    }),
    lines: video.lines.flatMap((l) => {
      const text = wordsOf(saidOf(l.text, screenOf(l.text)), against);
      return text === null ? [] : [{ ...l, text }];
    }),
    rings: video.rings.flatMap((r) =>
      against === null && r.tone === "was" ? [] : [{ ...r, label: label(r.label) }],
    ),
  };
}

/** Where it stopped: the check that failed, else its end; its chapter, the control it looked for, and what it says. */
const stopOf = (video: Video, side: string): VideoMark => {
  const check = video.checks.find((c) => c.verdict === "missing");
  const at = check ? check.at : video.seconds;
  return {
    at,
    chapter: chapterAt(video, at),
    control: check ? controlOf(check.text) : null,
    side,
    text: check ? plainCheck(check) : "It stopped before the end",
  };
};

/** A difference, as a moment worth going to. */
const noteOf =
  (video: Video, side: string) =>
  (c: Video["checks"][number]): VideoMark => ({
    at: c.at,
    chapter: chapterAt(video, c.at),
    said: differenceOf(video, c),
    side,
    text: c.text,
  });

/** A journey's video as a verdict reads it: what it is, on which side (a target), in which mode. */
export type Played = Readonly<{ mode: string; target: string; video: Video }>;

/**
 * What the run says about a journey. A pull request's run (head and base): broken when
 * it fails on head and played through on base; failed when it fails on head and stopped
 * on base too, or has no video there (nothing it broke); new when it passes on head and
 * fails on base; changed when it passes on both but main's video found something
 * elsewhere or a screen different from this pull request's; the same otherwise; not
 * played on base when base has no video of it. Any other run: passed or failed.
 */
export function verdictOf(videos: ReadonlyArray<Played>, compared: boolean): Verdict {
  const on = (side: string) => videos.filter((f) => f.target === side).sort(byMode);
  const head = compared ? on("head")[0] : [...videos].sort(byMode)[0];
  if (!head) return { kind: "unplayed", side: "head" };
  if (!compared)
    return head.video.passed
      ? { kind: "passed" }
      : { kind: "failed", stop: stopOf(head.video, head.target) };
  const bases = on("base");
  const base = bases.find((f) => f.mode === head.mode) ?? bases[0];
  if (!head.video.passed)
    return { kind: base?.video.passed ? "broken" : "failed", stop: stopOf(head.video, "head") };
  if (!base) return { kind: "unplayed", side: "base" };
  if (!base.video.passed) return { kind: "new", stop: stopOf(base.video, "base") };
  // Main's video looks for what this pull request's reference run kept: what it found
  // elsewhere is what the pull request changed. This pull request's own video against
  // its own reference says nothing about main.
  const notes = differences(base.video).map(noteOf(base.video, "base"));
  return notes.length ? { kind: "changed", notes } : { kind: "same" };
}

/** The order journeys are listed in ("More journeys", a pull request's): what needs a look first. */
export const verdictRank: Readonly<Record<Verdict["kind"], number>> = {
  broken: 0,
  changed: 3,
  failed: 0,
  new: 1,
  passed: 5,
  same: 5,
  unplayed: 4,
};

/** Whether a run is of a pull request: on its head's branch, at its head's commit, or on a branch named for it (`pom/pr-88-journeys`). */
export const ofPr = (pr: VideoPr, run: Pick<VideoRun, "branch" | "commit">) =>
  run.branch === pr.head.ref ||
  (Boolean(run.commit) && run.commit === pr.head.sha) ||
  new RegExp(`(^|[/_-])pr-${pr.number}($|[/_-])`).test(run.branch);

/** A commit, as an address may name it: 7 to 40 hexadecimal characters. */
export const HEX = /^[0-9a-f]{7,40}$/i;

/** What an address asks for: a pull request (at a commit), main, a branch, a run, or a commit alone. */
export type VideosAsk = Readonly<{
  /**
   * A ref and what follows it, as `blob/` and `tree/` addresses have them
   * (`ana/forgot-password/apps/notes/spec/cart.feature`): the longest ref it starts with.
   */
  at?: string | null;
  /** A branch's newest run (a pull request's head branch: the pull request's). */
  branch?: string | null;
  commit?: string | null;
  main?: boolean;
  pull?: number | null;
  /** A run's id: with a commit, that commit's run (`?run=`); alone, that run (an address from before paths). */
  run?: string | null;
}>;

/**
 * What a ref names, from the start of an address's segments (a branch's name may have
 * slashes): the longest that is a known one (main, `HEAD`, a pull request's head, a
 * branch, a run's id), else a commit (7 to 40 hexadecimal characters); and the rest,
 * a blob's path. pomspec's service reads a blob's and a tree's addresses with it.
 */
export function askAt(
  refs: ReadonlyArray<VideoRef>,
  at: string,
): { ask: VideosAsk; path: string; ref: string } | null {
  const segments = at.split("/").filter(Boolean);
  for (let n = segments.length; n > 0; n--) {
    const name = segments.slice(0, n).join("/");
    const ref =
      refs.find((r) => r.name === name) ??
      (name === "HEAD" ? refs.find((r) => r.kind === "main") : undefined);
    if (!ref) continue;
    const path = segments.slice(n).join("/");
    const ask: VideosAsk =
      ref.kind === "main"
        ? { main: true }
        : ref.kind === "pull"
          ? { pull: ref.pull! }
          : ref.kind === "branch"
            ? { branch: name }
            : { commit: name };
    return { ask, path, ref: name };
  }
  const first = segments[0];
  return first && HEX.test(first)
    ? { ask: { commit: first }, path: segments.slice(1).join("/"), ref: first }
    : null;
}

/** What only the video says, and no step of the .feature: a screen compared, a control not found. */
export const VIDEO_ONLY = /^The screen\b|isn't on the page$|could be in two places$/;

/** A video beside its journey's .feature: which step plays when. */
export type Steps = Readonly<{
  /** The step a moment plays: the last the video said by then (where it starts, before any). */
  at: (t: number) => { line: number; text: string } | null;
  /** A line of the .feature, trimmed. */
  textOf: (line: number) => string;
  /** When the video plays a line: a step when it is said, a chapter when it begins, else the start. */
  timeOf: (line: number) => number;
}>;

/**
 * A video and its journey's .feature, side by side: the step a moment plays (its line in
 * the file, from 1) and when the video plays a line. A video that kept the step each line
 * says (`step`, the line its call wrote) is read by it, when every line it said has one
 * and each is a step of this file; an older video is paired by count: both are written
 * from the journey's code, so the video says its steps in the order the file lists them.
 * The file's first (`Given I am on …`) is where it starts.
 */
export function stepsOf(video: Pick<Video, "chapters" | "lines">, text: string): Steps {
  const lines = text.split("\n");
  const scenario = lines.findIndex((l) => /^\s*Scenario( Outline)?:/.test(l));
  const steps: Array<number> = [];
  const chapters = new Map<number, string>();
  for (let i = scenario + 1; scenario >= 0 && i < lines.length; i++) {
    const rest = lines[i]!.trim();
    if (rest.startsWith("#")) chapters.set(i + 1, rest.replace(/^#\s*/, ""));
    else if (/^(Given|When|Then|And|But|\*)\s/.test(rest)) steps.push(i + 1);
  }
  const first = steps[0] && /\bI am on "/.test(lines[steps[0] - 1]!) ? steps.shift()! : null;
  const said = video.lines.filter((l) => !VIDEO_ONLY.test(l.text));
  const known = new Set(steps);
  const kept =
    said.length > 0 && said.every((l) => typeof l.step === "number" && known.has(l.step));
  let next = 0;
  const byVideo = video.lines.map((l) =>
    VIDEO_ONLY.test(l.text) ? null : kept ? l.step! : (steps[next++] ?? null),
  );
  const textOf = (line: number) => lines[line - 1]?.trim() ?? "";
  return {
    at(t) {
      for (let i = video.lines.length - 1; i >= 0; i--) {
        const line = byVideo[i];
        if (line && video.lines[i]!.start <= t + 0.05) return { line, text: textOf(line) };
      }
      return first ? { line: first, text: textOf(first) } : null;
    },
    textOf,
    timeOf(line) {
      const i = byVideo.indexOf(line);
      if (i >= 0) return video.lines[i]!.start;
      const chapter = chapters.get(line);
      return video.chapters.find((c) => chapter && c.title === chapter)?.start ?? 0;
    },
  };
}

// Addresses: a product's videos are at its project's, /<project>, and a project linked to
// a GitHub repository's at the repository's too, under /github/ as GitHub's own paths
// (/github/<owner>/<repo>), so swapping github.com for pomspec's host and /github lands
// on the same thing. Under either, a pull request is <base>/pull/<n>, a branch's videos
// <base>/tree/<branch>, a commit's <base>/commit/<sha>, and a journey's videos are at its
// .feature's blob (<base>/blob/<ref>/<path>). GitHub-facing writing (a pull request's
// comment, its check, a note) names the repository's; everything else, the project's.

/** A segment of an address: encoded, its brackets kept readable (`[username]`). */
export const segment = (s: string) =>
  encodeURIComponent(s).replace(/%5B/g, "[").replace(/%5D/g, "]");

/** A path's segments, each encoded. */
export const pathAddress = (file: string) => file.split("/").filter(Boolean).map(segment).join("/");

/**
 * Where a product's addresses start: its project's (`{ project: <slug> }`), or the GitHub
 * repository linked to it (`{ owner, name }`).
 */
export type VideoBase = Readonly<{ project: string }> | Pick<VideoRepo, "name" | "owner">;

/** A base, and where the spec is in the product's code (`apps/notes/spec/`): what a blob address names. */
export type VideoPlace = VideoBase & Readonly<{ prefix: string }>;

/** A GitHub owner's page, its connected repositories: `/github/<owner>`. */
export const ownerAddress = (owner: string) => `/github/${segment(owner)}`;

/** A GitHub repository's page: `/github/<owner>/<repo>`. */
export const repoAddress = (repo: Pick<VideoRepo, "name" | "owner">) =>
  `${ownerAddress(repo.owner)}/${segment(repo.name)}`;

/** A project's page: `/<project>`. */
export const projectAddress = (slug: string) => `/${segment(slug)}`;

/** Where a base's addresses start: a repository's (it names an owner), else a project's. */
export const baseAddress = (base: VideoBase) =>
  "owner" in base ? repoAddress(base) : projectAddress(base.project);

/** A journey's address within its spec: its file, without its extension (`dashboard/start-a-project`). */
export const journeyPath = (file: string) =>
  file.replace(/\.feature$/, "").replace(/(\.journey)?\.[cm]?[jt]sx?$/, "");

/** A journey's .feature, from the spec's folder: what a blob address names (after the spec's place in the code). */
export const featurePath = (file: string) => `${journeyPath(file)}.feature`;

/** A blob's address up to the spec's folder, at a ref. */
export const blobAt = (place: VideoPlace, ref: string) =>
  `${baseAddress(place)}/blob/${pathAddress(ref)}${place.prefix ? `/${pathAddress(place.prefix)}` : ""}`;

/** `?run=<id>`, when a commit's address must say which of its runs. */
export const runQuery = (run: string | null) => (run ? `?run=${encodeURIComponent(run)}` : "");

/** Where a run's journeys play: `<base>/blob/<ref>/<the spec's folder>`, and the run a commit's address names. */
export type VideoHome = Readonly<{ path: string; run: string | null }>;

/**
 * What an address needs of a run's videos: which they are, how an address names them
 * (`blob/<ref>/…`: main, a pull request's head branch, a branch, or the commit they are
 * pinned to), and which of that commit's runs (`?run=`) when it has a newer one.
 */
type Named = Readonly<{ pinRun: string | null; ref: string; scope: VideoScope }>;

/** The videos are a commit's run, not a branch's newest: an address names its commit. */
const pinnedVideos = (videos: Named) =>
  videos.scope.kind === "commit" || (videos.scope.kind === "pull" && videos.scope.pinned !== null);

/** Where a run's journeys play, as its videos name it. */
export const homeOf = (place: VideoPlace, videos: Named): VideoHome => ({
  path: blobAt(place, videos.ref),
  run: pinnedVideos(videos) ? videos.pinRun : null,
});

/**
 * A pull request's page: `<base>/pull/<n>`; at a commit of it (GitHub's commit in it),
 * `/pull/<n>/commits/<ref>`, and which of that commit's runs.
 */
export const pullAddress = (
  base: VideoBase,
  number: number,
  at?: Readonly<{ ref: string; run?: string | null }>,
) =>
  `${baseAddress(base)}/pull/${number}${at ? `/commits/${segment(at.ref)}${runQuery(at.run ?? null)}` : ""}`;

/**
 * The page that lists a run's journeys: main's are the base's own, a pull request's its
 * own (pinned: at its commit), a branch's its tree, any other run its commit's.
 */
export function journeysAddress(base: VideoBase, videos: Named): string {
  const scope = videos.scope;
  if (scope.kind === "main") return baseAddress(base);
  if (scope.kind === "pull")
    return pullAddress(
      base,
      scope.number,
      scope.pinned ? { ref: videos.ref, run: videos.pinRun } : undefined,
    );
  if (scope.kind === "branch") return `${baseAddress(base)}/tree/${pathAddress(scope.name)}`;
  return `${baseAddress(base)}/commit/${segment(videos.ref)}${runQuery(videos.pinRun)}`;
}

/**
 * A journey's video: its .feature where its videos are (`home`, a blob's ref and the
 * spec's folder, and which of a commit's runs), a side, a mode, a moment.
 */
export function videoAddress(
  home: VideoHome,
  file: string,
  params: { mode?: string; side?: string; t?: number } = {},
): string {
  const query = new URLSearchParams();
  if (home.run) query.set("run", home.run);
  if (params.side) query.set("side", params.side);
  if (params.mode) query.set("mode", params.mode);
  if (params.t && params.t > 0.05) query.set("t", params.t.toFixed(1));
  const q = query.toString();
  return `${home.path}/${pathAddress(featurePath(file))}${q ? `?${q}` : ""}`;
}
