// A run's videos, as types alone: each journey played on the real app and recorded, its
// video.json as the runner wrote it, its run.json, and what video.ts says of them (a
// verdict, a video's marks, the addresses that name them), shared by pom (videos.ts,
// service.ts), the frame that draws a video (frame.ts) and, through `pomspec/video`,
// pomspec's service and web app.

/**
 * A repository as GitHub addresses it (its origin remote: `acme/notes`), and
 * where the spec is in it (`apps/notes/spec/`, "" at its root): swap github.com for
 * pomspec's host and /github, and the address is the same page's.
 */
export type VideoRepo = Readonly<{ name: string; owner: string; prefix: string }>;

/**
 * A ref an address may name (`blob/<ref>/<path>`, `tree/<ref>`): main, a pull request's
 * head branch, another branch a run was made on, a run's id. A commit (7 characters or
 * more) need not be listed.
 */
export type VideoRef = Readonly<{
  kind: "branch" | "main" | "pull" | "run";
  name: string;
  pull?: number;
}>;

type Box = Readonly<{ h: number; w: number; x: number; y: number }>;

/** A video.json: the video's marks, in its own pixels and seconds. */
export type Video = Readonly<{
  badges: ReadonlyArray<Readonly<{ end: number; start: number; text: string; tone: string }>>;
  chapters: ReadonlyArray<Readonly<{ picture?: string; start: number; title: string }>>;
  checks: ReadonlyArray<
    Readonly<{ at: number; picture?: string | null; text: string; verdict: string }>
  >;
  duration: number;
  journey: Readonly<{ file: string; route: string; slug: string; title: string }>;
  lines: ReadonlyArray<
    Readonly<{
      chapter?: string;
      end: number;
      start: number;
      /**
       * The line of the journey's .feature the call that said it wrote (from 1); null when
       * it wrote none (a screen compared). A video from before it was kept has none at all.
       */
      step?: number | null;
      text: string;
    }>
  >;
  mode?: string;
  passed: boolean;
  pointer: ReadonlyArray<Readonly<{ end: number; start: number; x: number; y: number }>>;
  rings: ReadonlyArray<
    Readonly<{
      box: Box;
      end: number;
      label?: string;
      labelAt?: Readonly<{ x: number; y: number }>;
      start: number;
      tone: string;
    }>
  >;
  ripples: ReadonlyArray<Readonly<{ at: number; x: number; y: number }>>;
  /** The video's length, in seconds: it has one once it is finished. */
  seconds: number;
  size: Readonly<{ height: number; width: number }>;
  start?: string;
  storyboard?: Readonly<{
    columns: number;
    count: number;
    every: number;
    height: number;
    width: number;
  }> | null;
}>;

/** A moment of a video worth going to: where it stopped, what moved. */
export type VideoMark = Readonly<{
  at: number;
  /** The chapter it is in. */
  chapter?: string | null;
  /** Where it stopped: the control it looked for, in the video's words (“Pay”). */
  control?: string | null;
  /** What moved or differs, in plain words: no scores, no thresholds. */
  said?: string;
  side: string;
  /** The check, as the video words it. */
  text: string;
}>;

/** A journey as its repository keeps it: its `.feature`, beside its code. */
export type VideoFeature = Readonly<{
  file: string;
  /** Why it may not be what the run played: its journey changed since. */
  note: string | null;
  text: string;
}>;

export type Verdict = Readonly<
  | { kind: "broken" | "failed" | "new"; stop: VideoMark }
  | { kind: "changed"; notes: ReadonlyArray<VideoMark> }
  | { kind: "passed" | "same" }
  /** Played on one side only. */
  | { kind: "unplayed"; side: string }
>;

/** A run.json. */
export type VideoRun = Readonly<{
  at: string;
  branch: string;
  commit: string;
  dirty: boolean;
  names?: Readonly<Record<string, string>>;
  run: string;
  subject: string;
  targets: Readonly<Record<string, string>>;
}>;

/** A pull request a run may be of: its head and base, its number. */
export type VideoPr = Readonly<{
  base: Readonly<{ ref: string; sha: string }>;
  head: Readonly<{ ref: string; sha: string }>;
  number: number;
  /** Its latest reviewed run, when pomspec named it: what its address plays. */
  run?: string;
  title: string;
  url: string;
}>;

/**
 * Which videos these are, as an address says it: a pull request's (its latest reviewed
 * run, or `pinned` to another, by commit or id), main's (at its commit, when known), a
 * branch's newest, or a run of no pull request, by its commit.
 */
export type VideoScope = Readonly<
  | { kind: "branch"; name: string }
  | { kind: "commit"; ref: string }
  | { kind: "main"; sha: string | null }
  | { kind: "pull"; number: number; pinned: string | null; run: string | null }
>;
