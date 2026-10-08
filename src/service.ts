import { execFile, execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openAsBlob,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import pom from "../package.json" with { type: "json" };
import { type Gif, makeGifs } from "./gif.ts";
import { byMode, verdictOf } from "./video.ts";
import {
  featureOf,
  type Found,
  nameOf,
  repoOf,
  runsIn,
  runsOf,
  stillOf,
  videosIn,
} from "./videos.ts";
import type { Verdict } from "./view/model.ts";

// pomspec's service, as a runner speaks to it. A runner hears which pull requests to
// play (the `runnerJobs` subscription, over SSE, read as the kit's player reads a
// session's activity: packages/kit/src/player/follow.ts), claims one so no other runner
// plays it too, and uploads what it played to its project (by its address, or by the
// GitHub repository linked to it): the run, each video's files, then each journey's
// .feature, from which the service makes the run's page, and what a pull request's
// comment shows (its GIFs, its pictures), which the service puts on the repository's
// videos branch. A runner belongs to an organization by its token (`pomr_…`, created in
// Settings → Runners) and never takes a connection in: a Mac behind any network can be
// one. A video's pictures go up as WebP, where this machine can make it (ffmpeg with
// libwebp, or cwebp): the run on disk keeps its PNGs, which pom's own comparisons read.
// Every call says which pom makes it (x-pom-version), and one the service fails on its
// side (5xx, or too busy: 408, 429) or that finds no connection (a deploy restarting it)
// is made again, ever more slowly, for about two minutes in all; a refusal (any other
// 4xx) is not.

/** pomspec's address, unless --service or POM_SERVICE_URL says another. */
export const SERVICE_URL = "https://pomspec.com";

/** This pom's version, as its package.json says: the same file from src/ and from dist/. */
export const VERSION: string = pom.version;

/** A runner token, as Settings → Runners creates it. */
export const RUNNER_TOKEN = /^pomr_[A-Za-z0-9_-]{43}$/;

/** A workflow's token, as pomspec swaps GitHub's word for a workflow for one (oidc.ts). */
export const WORKFLOW_TOKEN = /^pomg_[A-Za-z0-9_-]{1,1024}\.[A-Za-z0-9_-]{43}$/;

/** A pull request to play at a commit: what the service hands a runner. */
export type RunnerJob = Readonly<{
  baseSha: string;
  headSha: string;
  id: string;
  pullRequest: Readonly<{
    baseRef: string;
    baseSha: string;
    headRef: string;
    headSha: string;
    number: number;
    title: string;
    url: string;
  }>;
  repository: Readonly<{ name: string; owner: string }>;
  status: string;
}>;

/**
 * Writes a video's picture (a PNG) as WebP at `webp`: true once it's there. Only what goes
 * up is WebP: the run on disk keeps its PNGs.
 */
export type Encode = (png: string, webp: string) => Promise<boolean>;

/** A run to upload: one of a spec's runs (`<spec>/.pom/runs/<run>`), and what it played. */
export type Upload = Readonly<{
  /**
   * What makes its pictures WebP: by default this machine's (`webpEncoder`; with none,
   * they go up as PNG, said in `say`); null sends them as PNG.
   */
  encode?: Encode | null;
  /** The commit holding the `.feature` files it played (the spec commit pushed after it): comments are anchored there, so they are read from it alone, and it must be in the spec's checkout. A run the service has, uploaded again, keeps the one it had. */
  featureCommit?: string | null;
  /** The runner job it answers, done once the run is. */
  job?: string | null;
  /** The project it recorded, by its address (its slug): this or `repo`, one of them. */
  project?: string | null;
  /** The pull request it played, by number: of the repository linked to its project. */
  pull?: number | null;
  /**
   * What GitHub shows of it inline (a journey's GIF, its chapters' pictures): each file on
   * this machine, its key in the run (`publish/write-a-note.gif`) and its path on the
   * repository's videos branch (`pr-7/<run>/write-a-note.gif`), at most `LIMITS.branchRun`
   * together. The service puts them there when the run is its pull request's latest, and
   * says where GitHub shows each.
   */
  publish?: ReadonlyArray<Readonly<{ file: string; key: string; path: string }>> | null;
  /** A run the service already has is replaced, not kept as it is. */
  replace?: boolean;
  /** `owner/name`, as GitHub has it: a repository connected to pomspec, which names its project. */
  repo?: string | null;
  /** The run's id (its folder's name). */
  run: string;
  /** Tells the person something on the way, a line at a time: why its pictures go up as PNG. */
  say?: (line: string) => void;
  /** The folder whose `.pom/runs` holds it. */
  spec: string;
}>;

/** A run's file on the repository's videos branch: its key in the run, its path there, and where GitHub shows it. */
export type Published = Readonly<{ key: string; path: string; url: string }>;

/** A run uploaded: its page, whether it is its pull request's latest, and where GitHub shows what it published. */
export type Uploaded = Readonly<{
  /** The service had it, ready, and kept it as it is. */
  already: boolean;
  /**
   * Its pull request's latest run, whose comment and check say what it found: not an older
   * one uploaded late, nor a run of no pull request.
   */
  latest: boolean;
  /** In the order asked; none when the run is not its pull request's latest. */
  publish: ReadonlyArray<Published>;
  url: string;
}>;

export type Service = Readonly<{
  /** Takes a job, so no other runner plays it; null when it's no longer waiting (taken, done or out of date). */
  claim: (id: string) => Promise<RunnerJob | null>;
  /** Gives a job up, saying why. */
  fail: (id: string, reason: string) => Promise<void>;
  /** The organization's queued jobs, oldest first, then each new one, for as long as it is asked. */
  runnerJobs: (signal?: AbortSignal) => AsyncGenerator<RunnerJob>;
  /** Uploads a run: its page on the service, once it is ready, and what it published. */
  uploadRun: (upload: Upload) => Promise<Uploaded>;
  url: string;
}>;

/** What the service refused, with its code when it gave one ("claimed"), and what else it said. */
export class ServiceError extends Error {
  readonly code: string | null;
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly status: number | null;
  constructor(
    message: string,
    code: string | null = null,
    status: number | null = null,
    extensions: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.code = code;
    this.extensions = extensions;
    this.status = status;
  }
}

/** The service's own failure while it streamed (its errors are masked): followed again. */
class Faulted extends Error {}

const JOB = `id status headSha baseSha repository { owner name }
    pullRequest { number title url headRef headSha baseRef baseSha }`;
const JOBS = `subscription RunnerJobs { runnerJobs { ${JOB} } }`;
const CLAIM = `mutation ClaimRunnerJob($id: ID!) { claimRunnerJob(id: $id) { ${JOB} } }`;
const FAIL = `mutation FailRunnerJob($id: ID!, $reason: String!) {
  failRunnerJob(id: $id, reason: $reason) { id }
}`;
const START = `mutation StartVideoRun($input: StartVideoRunInput!) { startVideoRun(input: $input) { id } }`;
const FINISH = `mutation FinishVideoRun($input: FinishVideoRunInput!) {
  finishVideoRun(input: $input) { run { id } url latest publish { key path url } }
}`;

const MB = 1024 * 1024;
/**
 * What the service takes, so a run over them is refused before anything is sent: so many
 * files, a video.json, any other file and the run so large; of what goes on the videos
 * branch, a file (`branch`), all of them together (`branchRun`) and how many
 * (`branchFiles`).
 */
export const LIMITS = {
  branch: 15 * MB,
  branchFiles: 1000,
  branchRun: 150 * MB,
  files: 5000,
  json: 5 * MB,
  file: 100 * MB,
  run: 2048 * MB,
} as const;
/** The files a video is played with: everything else in its folder stays on the runner. */
const VIDEO_FILE = /^(video\.json|journey\.webm|still\.jpg|storyboard\.jpg|.+\.(png|webp))$/;
/** What goes on the videos branch, as the run holds it: what GitHub shows inline, one folder deep. */
const PUBLISHED = /^publish\/[^/]+\.(gif|jpg|mp4|png)$/;
/** A segment of a file's path in its run, as the service stores it. */
const SEGMENT = /^[A-Za-z0-9._@+()[\]-]{1,128}$/;
const SEGMENTS = 8;
/** Files sent at once. */
const WIDTH = 4;

/**
 * How a call is made again after no connection or a failure of the service's: its first
 * wait (doubled each time, to 30 seconds at most) and how long it is tried in all.
 */
export type Patience = Readonly<{ first: number; total: number }>;
/** About two minutes in all: long enough for a deploy to restart the service. */
const PATIENCE: Patience = { first: 500, total: 120_000 };

type Payload<T> = {
  data?: T | null;
  errors?: Array<{ extensions?: { code?: string; [key: string]: unknown }; message: string }>;
};

/** A file of the run, by its path in it. */
type Local = Readonly<{ file: string; path: string; size: number }>;

const TOKEN_REFUSED =
  "pomspec doesn't know this runner token: create another in Settings → Runners.";
/** A workflow's token refused: it lasted its hours, or its repository was let go. */
const WORKFLOW_REFUSED =
  "pomspec no longer takes this workflow's token: it lasts two hours, and only while its repository is connected in Settings → GitHub. Run the workflow again.";

/** Codes the service refuses for good with: asked again, it would refuse again. */
const FINAL = new Set(["FORBIDDEN", "UNAUTHENTICATED", "forbidden", "not-found"]);
/** What the service says in place of an error of its own (Yoga masks them). */
const MASKED = "Unexpected error.";
/** What a person reads in its place. */
const ON_ITS_SIDE = "Something went wrong on pomspec's side. Try again in a moment.";

/** Worth trying again: the service restarting, or too busy just now. */
const passing = (status: number) => status >= 500 || status === 408 || status === 429;

/** Why a request got no answer, as the network said it (ECONNREFUSED), not fetch's "fetch failed". */
const causeOf = (error: unknown): string => {
  const code = (error as { cause?: { code?: unknown } }).cause?.code;
  return typeof code === "string" ? code : (error as Error).message;
};

/** An upload that stopped before its last file: the run is left uploading. */
const STOPPED = "The upload stopped part-way.";

/** A refusal's body when it's a sentence of the service's own (not a proxy's page); else null. */
async function sentenceOf(response: Response): Promise<string | null> {
  if (!response.headers.get("content-type")?.startsWith("text/plain")) return null;
  const text = (await response.text().catch(() => "")).trim();
  return text && text.length <= 300 && !text.includes("\n") ? text : null;
}

/** The wait before trying again: twice as long each time, from `first`, to 30 seconds. */
const backoff = (attempt: number, first: number) => Math.min(30_000, first * 2 ** attempt);

/** Waits `ms` before trying again; false once aborted. */
const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<boolean>((resolve) => {
    if (signal?.aborted) return resolve(false);
    const stop = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });

/** The first error a GraphQL answer carries, as a refusal: a masked one in our words. */
const refusal = (payload: Payload<unknown> | null, status: number | null) => {
  const error = payload?.errors?.[0];
  return error
    ? new ServiceError(
        error.message === MASKED ? ON_ITS_SIDE : error.message,
        error.extensions?.code ?? null,
        status,
        error.extensions,
      )
    : null;
};

/**
 * The jobs an SSE stream of the subscription carries, until it completes or drops. An
 * error refuses the runner for good when its code says so, or when it is the stream's
 * first word (the subscription refused); any other is the service failing on its side
 * (a job it could not read just then), and ends only this stream.
 */
async function* jobsIn(
  body: ReadableStream<Uint8Array>,
  heard: () => void,
): AsyncGenerator<RunnerJob> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let jobs = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      heard();
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (event === "complete") return;
        if (event === "next" && data) {
          const payload = JSON.parse(data) as Payload<{ runnerJobs: RunnerJob | null }>;
          const refused = refusal(payload, null);
          if (refused) {
            const masked = payload.errors?.[0]?.message === MASKED;
            if (FINAL.has(refused.code ?? "") || (!jobs && !masked)) throw refused;
            throw new Faulted(refused.message);
          }
          if (payload.data?.runnerJobs) {
            jobs += 1;
            yield payload.data.runnerJobs;
          }
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Runs `work` over every item, `width` at a time; the first failure stops the rest, those under way too. */
async function inTurn<T>(
  items: ReadonlyArray<T>,
  width: number,
  work: (item: T, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const stop = new AbortController();
  let next = 0;
  const lane = async () => {
    while (!stop.signal.aborted && next < items.length) {
      try {
        await work(items[next++]!, stop.signal);
      } catch (error) {
        stop.abort();
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane));
}

/**
 * A run's files as the service takes them, by their path in the run
 * (`<target>/[<folder>/…]<slug>/<mode>/<name>`): each finished video's video.json,
 * journey.webm, still (drawn now when the runner left none), storyboard and pictures, then
 * what goes on the videos branch, under publish/. A path the service would refuse, or a
 * run over its limits, is refused here, before anything is sent.
 */
function filesOf(
  dir: string,
  videos: ReadonlyArray<Found>,
  publish: NonNullable<Upload["publish"]>,
): Array<Local> {
  if (!videos.length)
    throw new Error(
      `${path.basename(dir)} has no finished video (a video.json beside a journey.webm).`,
    );
  const files = videos.flatMap(({ dir: folder, video }) => {
    stillOf(folder, video);
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && VIDEO_FILE.test(entry.name))
      .map((entry): Local => {
        const file = path.join(folder, entry.name);
        return {
          file,
          path: path.relative(dir, file).split(path.sep).join("/"),
          size: statSync(file).size,
        };
      });
  });
  for (const { file, key } of publish) {
    if (!PUBLISHED.test(key))
      throw new Error(
        `${key} can't go on the videos branch: only a .gif, .jpg, .mp4 or .png, as publish/<name>.`,
      );
    if (files.some((f) => f.path === key)) throw new Error(`${key} is published twice.`);
    files.push({ file, path: key, size: statSync(file).size });
  }
  for (const { path: at, size } of files) {
    const segments = at.split("/");
    if (
      segments.length > SEGMENTS ||
      segments.some((s) => s === "." || s === ".." || !SEGMENT.test(s))
    )
      throw new Error(
        `pomspec can't store ${at}: at most ${SEGMENTS - 1} folders deep, each name made of letters, digits and . _ @ + ( ) [ ] - only.`,
      );
    const most = at.endsWith("/video.json")
      ? LIMITS.json
      : at.startsWith("publish/")
        ? LIMITS.branch
        : LIMITS.file;
    if (size > most)
      throw new Error(`${at} is over pomspec's limit of ${most / MB} MB for one file.`);
  }
  if (files.length > LIMITS.files)
    throw new Error(
      `The run is over pomspec's limit of ${LIMITS.files.toLocaleString("en")} files.`,
    );
  if (
    files.filter((f) => f.path.startsWith("publish/")).reduce((sum, f) => sum + f.size, 0) >
    LIMITS.branchRun
  )
    throw new Error("The run's files for the videos branch are over pomspec's limit of 150 MB.");
  if (publish.length > LIMITS.branchFiles)
    throw new Error(
      `The run's files for the videos branch are over pomspec's limit of ${LIMITS.branchFiles.toLocaleString("en")} files.`,
    );
  if (files.reduce((sum, f) => sum + f.size, 0) > LIMITS.run)
    throw new Error("The run is over pomspec's limit of 2 GB.");
  return files;
}

/**
 * WebP's quality, lossy. On a run of 341 pictures at 1280×800 (60.3 MB as PNG), 90 made
 * 10.1 MB, 6 times lighter, with small text as sharp as the PNG's; 80 made 7.3 MB but
 * smeared thin coloured lines; lossless made 28.2 MB.
 */
const QUALITY = 90;
/** Pictures made WebP at once. */
const ENCODERS = Math.max(1, Math.min(8, availableParallelism()));

/** Said when a run's pictures go up as PNG, for want of anything here that writes WebP. */
export const NO_WEBP =
  "Pictures go up as PNG, about 6 times larger: nothing here writes WebP. Install cwebp (brew install webp, or apt install webp) to send WebP.";
/** Said when a run's pictures go up as PNG, WebP having made none of them smaller (or none at all). */
export const NO_SMALLER = "Pictures go up as PNG: WebP couldn't make any of them smaller.";
/** Said when a run's pictures go up as PNG, the service not taking WebP yet (one from before it did). */
export const NO_WEBP_THERE =
  "pomspec's service doesn't take WebP pictures yet, so they go up as PNG.";

/** A command run to make one picture: true once it exited well and the picture is there. */
const making =
  (command: string, args: (png: string, webp: string) => Array<string>): Encode =>
  (png, webp) =>
    new Promise((resolve) =>
      execFile(command, args(png, webp), { timeout: 60_000 }, (error) =>
        resolve(!error && existsSync(webp)),
      ),
    );

/**
 * What writes a picture as WebP on this machine, both at `QUALITY` with libwebp's fourth
 * effort: ffmpeg, where its build has libwebp (Ubuntu's has; Homebrew's hasn't), else
 * cwebp, Google's own (`brew install webp` on a Mac). Null when neither is here.
 */
export function webpEncoder(): Encode | null {
  const help = spawnSync("ffmpeg", ["-hide_banner", "-h", "encoder=libwebp"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 15_000,
  });
  // An encoder it lacks is said there too, and ffmpeg exits with 0 all the same.
  if (help.status === 0 && /^Encoder libwebp\b/m.test(help.stdout ?? ""))
    return making("ffmpeg", (png, webp) => [
      "-loglevel",
      "error",
      "-y",
      "-i",
      png,
      "-c:v",
      "libwebp",
      "-quality",
      String(QUALITY),
      "-compression_level",
      "4",
      webp,
    ]);
  const cwebp = spawnSync("cwebp", ["-version"], { stdio: "ignore", timeout: 15_000 });
  if (cwebp.status === 0)
    return making("cwebp", (png, webp) => [
      "-quiet",
      "-q",
      String(QUALITY),
      "-m",
      "4",
      png,
      "-o",
      webp,
    ]);
  return null;
}

/**
 * A run's files as they go up: each video's pictures as WebP, made in `temp`, where
 * `encode` makes one smaller (else its PNG), and each video.json naming what went up,
 * written there too; the rest as they are. What goes on the videos branch (publish/) is
 * never made WebP: GitHub shows it as the run holds it.
 */
async function asWebp(
  files: ReadonlyArray<Local>,
  videos: ReadonlyArray<Found>,
  dir: string,
  temp: string,
  encode: Encode,
): Promise<Array<Local>> {
  const taken = new Set(files.map((f) => f.path));
  const made = new Map<string, Local>();
  const pictures = files.filter((f) => !f.path.startsWith("publish/") && f.path.endsWith(".png"));
  await inTurn(pictures, ENCODERS, async (picture) => {
    const at = picture.path.replace(/\.png$/, ".webp");
    // A WebP of that name there already, or a name too long to store: its PNG goes up.
    if (taken.has(at) || !SEGMENT.test(path.posix.basename(at))) return;
    const file = path.join(temp, ...at.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    let size: number | null = null;
    try {
      if (await encode(picture.file, file)) size = statSync(file).size;
    } catch {
      // Not made: its PNG goes up.
    }
    if (size !== null && size < picture.size) made.set(picture.path, { file, path: at, size });
  });
  const written = new Map<string, Local>();
  for (const { dir: folder, video } of videos) {
    const at = path.relative(dir, folder).split(path.sep).join("/");
    let renamed = 0;
    const named = <T extends Readonly<{ picture?: string | null }>>(
      marks: ReadonlyArray<T>,
    ): ReadonlyArray<T> =>
      Array.isArray(marks)
        ? marks.map((mark: T) => {
            const one =
              typeof mark?.picture === "string" ? made.get(`${at}/${mark.picture}`) : undefined;
            if (!one) return mark;
            renamed += 1;
            return { ...mark, picture: path.posix.basename(one.path) };
          })
        : marks;
    const chapters = named(video.chapters);
    const checks = named(video.checks);
    if (!renamed) continue;
    const file = path.join(temp, ...at.split("/"), "video.json");
    const text = JSON.stringify({ ...video, chapters, checks });
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    written.set(`${at}/video.json`, {
      file,
      path: `${at}/video.json`,
      size: Buffer.byteLength(text),
    });
  }
  return files.map((f) => made.get(f.path) ?? written.get(f.path) ?? f);
}

/** Git's answer in a folder, or null (no such commit, or no such file in it). */
const gitIn = (folder: string, args: ReadonlyArray<string>): string | null => {
  try {
    return execFileSync("git", ["-C", folder, ...args], {
      encoding: "utf8",
      maxBuffer: 16 * MB,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
};

/** A project's address from a name, as pomspec makes one: lowercase letters and digits, dashed. */
export const projectSlugOf = (name: string): string =>
  name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");

/**
 * The project a spec's runs go to when an upload names neither its project nor its
 * repository: its name's address (pom.config.ts's `name`, else its folder's). None for a
 * spec in a GitHub repository's checkout: its upload names one or the other.
 */
export function defaultProject(spec: string): string | null {
  const remote = gitIn(spec, ["remote", "get-url", "origin"])?.trim() ?? "";
  if (/github\.com[:/]/i.test(remote)) return null;
  return projectSlugOf(nameOf(spec)) || null;
}

/** pomspec's service at `url`, as the runner whose token this is. */
export function serviceOf({
  patience = PATIENCE,
  say,
  token,
  url,
}: Readonly<{
  /** How long a call is made again: about two minutes in all, by default. */
  patience?: Patience;
  /** Tells the person, a line at a time, that pomspec isn't answering and is asked again. */
  say?: (line: string) => void;
  token: string;
  url: string;
}>): Service {
  if (!RUNNER_TOKEN.test(token) && !WORKFLOW_TOKEN.test(token))
    throw new Error("That isn't a runner token (pomr_…): create one in Settings → Runners.");
  /** What pom says when pomspec refuses the token, whatever pomspec says with it. */
  const tokenRefused = WORKFLOW_TOKEN.test(token) ? WORKFLOW_REFUSED : TOKEN_REFUSED;
  const address = URL.parse(url);
  if (address?.protocol !== "http:" && address?.protocol !== "https:")
    throw new Error(
      `--service or POM_SERVICE_URL takes an http:// or https:// address, not ${url}.`,
    );
  const base = address.href.replace(/\/+$/, "");
  /** What every call carries: the runner's token, and which pom makes it. */
  const own = { authorization: `Bearer ${token}`, "x-pom-version": VERSION };
  // Said once while pomspec isn't answering, and again only after it has answered.
  let told = false;

  /**
   * A call's answer: made again while nothing answers or the service fails on its side
   * (5xx, or busy: 408, 429), ever more slowly, until `patience.total` has passed; then its
   * last answer, or why nothing answered. Never again once `signal` aborts.
   */
  async function ask(to: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const until = Date.now() + patience.total;
    for (let attempt = 0; ; attempt++) {
      let response: Response | null = null;
      let failure: unknown = null;
      try {
        response = await fetch(to, { ...init, signal });
      } catch (error) {
        failure = error;
      }
      if (response && !passing(response.status)) {
        told = false;
        return response;
      }
      const left = until - Date.now();
      if (signal?.aborted || left <= 0) {
        if (response) return response;
        throw failure;
      }
      await response?.body?.cancel().catch(() => {});
      if (!told) {
        told = true;
        say?.(
          `pomspec didn't answer (${response ? response.status : causeOf(failure)}): trying again.`,
        );
      }
      if (!(await pause(Math.min(left, backoff(attempt, patience.first)), signal)))
        throw failure ?? new Error(STOPPED);
    }
  }

  async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await ask(`${base}/graphql`, {
        body: JSON.stringify({ query, variables }),
        headers: { ...own, accept: "application/json", "content-type": "application/json" },
        method: "POST",
      });
    } catch (error) {
      // Nothing answered there, for two minutes: most often an address mistyped.
      throw new Error(
        `Couldn't reach pomspec at ${base} (${causeOf(error)}): check --service or POM_SERVICE_URL.`,
      );
    }
    // A token revoked or unknown, whatever the service says with it.
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      throw new ServiceError(tokenRefused, null, 401);
    }
    const payload = (await response.json().catch(() => null)) as Payload<T> | null;
    const refused = refusal(payload, response.status);
    if (refused) throw refused;
    if (!response.ok || !payload?.data)
      throw new ServiceError(
        `pomspec answered with an error (${response.status}).`,
        null,
        response.status,
      );
    return payload.data;
  }

  async function* runnerJobs(signal?: AbortSignal): AsyncGenerator<RunnerJob> {
    // Back to the shortest wait once the service is heard again, unless it failed as it spoke.
    let attempt = 0;
    for (;;) {
      let response: Response | null = null;
      try {
        response = await fetch(`${base}/graphql`, {
          body: JSON.stringify({ query: JOBS }),
          headers: { ...own, accept: "text/event-stream", "content-type": "application/json" },
          method: "POST",
          signal,
        });
      } catch {
        // Not reached (the service restarting, the network gone): asked again below.
      }
      if (response?.status === 401) {
        await response.body?.cancel().catch(() => {});
        throw new ServiceError(tokenRefused, null, 401);
      }
      if (response && !response.ok && !passing(response.status)) {
        const payload = (await response.json().catch(() => null)) as Payload<unknown> | null;
        throw (
          refusal(payload, response.status) ??
          new ServiceError(
            `pomspec answered with an error (${response.status}).`,
            null,
            response.status,
          )
        );
      }
      if (response?.ok && response.body) {
        // An answer that is no stream is a refusal of the subscription itself.
        if (!response.headers.get("content-type")?.includes("text/event-stream")) {
          const payload = (await response.json().catch(() => null)) as Payload<unknown> | null;
          throw (
            refusal(payload, response.status) ??
            new ServiceError(
              `${base} didn't answer as pomspec does: check that it's pomspec's address.`,
              null,
              response.status,
            )
          );
        }
        let heard = false;
        try {
          for await (const job of jobsIn(response.body, () => (heard = true))) yield job;
        } catch (error) {
          if (error instanceof ServiceError) throw error;
          // The stream dropped, or the service failed on its side: asked again below, and
          // the queued jobs come again; a service failing every time, ever more slowly.
          if (error instanceof Faulted) heard = false;
        }
        if (heard) attempt = 0;
      } else await response?.body?.cancel().catch(() => {});
      if (!(await pause(backoff(attempt++, patience.first), signal))) return;
    }
  }

  /** One file into the run, made again while the connection drops or the service fails. */
  async function put(run: string, file: Local, signal: AbortSignal) {
    const to = `${base}/api/runner/runs/${encodeURIComponent(run)}/files/${file.path}`;
    // A blob reads its file again for each try.
    const body = await openAsBlob(file.file);
    let response: Response;
    try {
      response = await ask(
        to,
        { body, headers: { ...own, "content-type": "application/octet-stream" }, method: "PUT" },
        signal,
      );
    } catch (error) {
      throw new Error(
        signal.aborted ? STOPPED : `Couldn't upload ${file.path} (${causeOf(error)}).`,
      );
    }
    // Past a limit, the service says which in a sentence of its own: read only then.
    const said = response.status === 413 ? await sentenceOf(response) : null;
    await response.body?.cancel().catch(() => {});
    if (response.ok) return;
    throw new ServiceError(
      response.status === 401
        ? tokenRefused
        : response.status === 404
          ? "No run of yours is uploading under that id."
          : (said ?? `pomspec refused ${file.path} (${response.status}).`),
      null,
      response.status,
    );
  }

  async function uploadRun(upload: Upload): Promise<Uploaded> {
    if (!upload.project === !upload.repo)
      throw new Error(
        "pomspec can't start this run: name its project or its repository, one of them.",
      );
    const runs = runsOf(upload.spec);
    const run = runsIn(runs).find((r) => r.run === upload.run);
    if (!run) throw new Error(`No run ${upload.run} in ${runs}.`);
    const dir = path.join(runs, run.run);
    const videos = videosIn(dir);
    const publish = upload.publish ?? [];
    const files = filesOf(dir, videos, publish);
    const { prefix } = repoOf(upload.spec);
    /** A commit the journeys' .feature files are read from: one the spec's checkout has. */
    const held = (sha: string) => {
      if (!/^[0-9a-f]{40}$/i.test(sha))
        throw new Error(`--feature-commit takes a full commit sha, not ${sha}.`);
      if (gitIn(upload.spec, ["cat-file", "-e", `${sha}^{commit}`]) === null)
        throw new Error(
          `The journeys' .feature files are read from ${sha}, which ${upload.spec} doesn't have: fetch it first.`,
        );
      return sha;
    };
    let commit = upload.featureCommit ? held(upload.featureCommit) : null;
    const journeys = [...new Set(videos.map(({ video }) => video.journey.file))].sort();
    // Each journey's .feature: as the commit its comments are anchored at has it, and only
    // so (the checkout's text under that commit's sha would put them on the wrong lines);
    // without one, as the run played it.
    const featuresAt = (at: string | null) =>
      journeys.flatMap((file) => {
        const feature = featureOf(
          upload.spec,
          file,
          at ? { at: run.at, commit: at, dirty: false } : run,
        );
        // A journey whose .feature the commit lacks (one still being written) has none.
        const text =
          feature && at ? gitIn(upload.spec, ["show", `${at}:./${feature.file}`]) : feature?.text;
        return feature && text != null
          ? [
              {
                file,
                note: at ? null : feature.note,
                path: path.posix.join(prefix, feature.file),
                text,
              },
            ]
          : [];
      });
    let features = featuresAt(commit);
    const start = (replace: boolean) =>
      graphql<{ startVideoRun: { id: string } }>(START, {
        input: {
          branch: run.branch,
          commit: run.commit,
          dirty: run.dirty,
          job: upload.job ?? null,
          key: run.run,
          names: Object.entries(run.names ?? {}).map(([side, name]) => ({ name, side })),
          playedAt: run.at,
          ...(upload.project ? { project: upload.project } : { repository: upload.repo }),
          pullRequest: upload.pull ?? null,
          replace,
          specPrefix: prefix,
          subject: run.subject,
        },
      });
    let started: { startVideoRun: { id: string } };
    try {
      started = await start(upload.replace ?? false);
    } catch (error) {
      if (!(error instanceof ServiceError) || error.code !== "uploaded") throw error;
      // The service has the run, ready: kept as it is (a review run again), and what it put
      // on the videos branch said again. Uploaded again only when it went up before its
      // spec was pushed and this upload has the spec's commit, for no pull request or
      // another, or when this upload shows what is not on the branch yet (only a run's
      // finish puts it there); a run that is not its pull request's latest puts nothing
      // there.
      const said = error.extensions;
      const kept = typeof said.featureCommit === "string" ? said.featureCommit : null;
      const latest = said.latest === true;
      const there = new Map(
        (Array.isArray(said.publish) ? (said.publish as ReadonlyArray<Published>) : []).map(
          (one) => [one.path, one],
        ),
      );
      const shown = publish.flatMap(({ path: at }) => there.get(at) ?? []);
      if (
        (!commit || kept) &&
        (upload.pull == null || said.pullRequest === upload.pull) &&
        (!latest || shown.length === publish.length)
      )
        return {
          already: true,
          latest,
          publish: latest ? shown : [],
          url: typeof said.url === "string" ? said.url : base,
        };
      // Uploaded again, its comments still anchored where they were: never at another
      // commit, or none, over the one it had.
      if (kept) {
        commit = held(kept);
        features = featuresAt(commit);
      }
      started = await start(true);
    }
    const { id } = started.startVideoRun;
    // Its pictures as WebP, made only now that they go up: the run on disk keeps its PNGs.
    const pictures = files.some((f) => !f.path.startsWith("publish/") && f.path.endsWith(".png"));
    const encode = upload.encode === undefined ? (pictures ? webpEncoder() : null) : upload.encode;
    if (pictures && !encode && upload.encode === undefined) upload.say?.(NO_WEBP);
    const temp = pictures && encode ? mkdtempSync(path.join(tmpdir(), "pom-upload-")) : null;
    try {
      let sent = temp && encode ? await asWebp(files, videos, dir, temp, encode) : files;
      // Its first WebP alone, first: a service from before it took WebP refuses it (400),
      // and then the run goes up as it is, its pictures PNG.
      const first = sent.find((f, n) => f !== files[n] && f.path.endsWith(".webp"));
      if (encode && pictures && !first) upload.say?.(NO_SMALLER);
      if (first) {
        try {
          await put(id, first, new AbortController().signal);
          sent = sent.filter((f) => f !== first);
        } catch (error) {
          if (!(error instanceof ServiceError) || error.status !== 400) throw error;
          upload.say?.(NO_WEBP_THERE);
          sent = files;
        }
      }
      await inTurn(sent, WIDTH, (file, signal) => put(id, file, signal));
    } finally {
      if (temp) rmSync(temp, { force: true, recursive: true });
    }
    const { finishVideoRun } = await graphql<{
      finishVideoRun: { latest: boolean; publish?: ReadonlyArray<Published> | null; url: string };
    }>(FINISH, {
      input: {
        featureCommit: commit,
        features,
        ...(publish.length
          ? { publish: publish.map(({ key, path: at }) => ({ key, path: at })) }
          : {}),
        run: id,
      },
    });
    return {
      already: false,
      latest: finishVideoRun.latest,
      publish: finishVideoRun.publish ?? [],
      url: finishVideoRun.url,
    };
  }

  return {
    async claim(id) {
      try {
        return (await graphql<{ claimRunnerJob: RunnerJob | null }>(CLAIM, { id })).claimRunnerJob;
      } catch (error) {
        // No longer waiting (another runner took it, or nobody needs it now): nothing to play.
        if (error instanceof ServiceError && error.code === "claimed") return null;
        throw error;
      }
    },
    async fail(id, reason) {
      await graphql(FAIL, { id, reason: reason.slice(0, 2000) });
    },
    runnerJobs,
    uploadRun,
    url: base,
  };
}

// ── what a pull request's comment shows ──────────────────────────────────

/** A file for the videos branch: on this machine, its key in the run, its path there. */
export type Publish = NonNullable<Upload["publish"]>[number];

/** A file of a run that its pull request's comment shows, by its path in the run. */
export type Shown = Readonly<{
  at: string;
  file: string;
  /** For a GIF, which may not be made yet: the video it is drawn from, as gif.ts takes it. */
  gif: Omit<Gif, "dir"> | null;
}>;

/** The verdicts the comment shows a journey for, in its order (review.ts: kindOf, ORDER). */
const LOOKS: ReadonlyArray<Verdict["kind"]> = ["broken", "failed", "new", "changed", "unplayed"];
/** What GitHub shows inline, as the videos branch takes it. */
const INLINE = /\.(gif|jpg|mp4|png)$/;

/**
 * A picture's step, from its file name, whatever its number and kind, as the comment
 * pairs two sides' pictures (review.ts: stepOf): 05-click-login.page.forgot-password.png
 * → login.page.forgot-password.
 */
const stepOf = (picture: string) =>
  picture.replace(/^\d+-[a-z]+-/, "").replace(/\.(png|webp)$/, "");

/** A video's picture of the step another picture is of: one of its checks', else its chapters'. */
const sameStep = (video: Found["video"], picture: string) =>
  [...video.checks, ...video.chapters].find(
    (c) => c.picture && stepOf(c.picture) === stepOf(picture),
  )?.picture;

const isFile = (file: string) => existsSync(file) && statSync(file).isFile();

/**
 * What a pull request's comment shows of a run, as pomspec's service writes it
 * (apps/service/src/github/review.ts: reviewOf, and shownBy for where it finds each): for
 * each journey whose verdict needs a look (broken, failed, new, changed, played on one
 * side alone), in the comment's order, the GIF of its video (this pull request's; main's,
 * of one not played after), where it stopped before beside this pull request's picture of
 * the same step, each screen that looks different beside this pull request's picture of
 * the same step, and each chapter's picture as it ends. Pictures the run's folders hold;
 * a GIF whether it is made yet or not.
 */
export function shownIn(dir: string, videos: ReadonlyArray<Found>): Array<Shown> {
  // A run that played both sides compares them, as the service reads it.
  const compared =
    videos.some((one) => one.target === "head") && videos.some((one) => one.target === "base");
  const journeys = new Map<string, Array<Found & { mode: string }>>();
  for (const one of videos) {
    const file = one.video.journey.file;
    const mode = one.video.mode ?? path.basename(one.dir);
    journeys.set(file, [...(journeys.get(file) ?? []), { ...one, mode }]);
  }
  /** A side's video the comment shows: the one a person watches first (visual). */
  const on = (takes: ReadonlyArray<Found & { mode: string }>, target: string) =>
    takes.filter((one) => one.target === target).sort(byMode)[0] ?? null;
  const rows = [...journeys.values()]
    .flatMap((takes) => {
      const verdict = verdictOf(takes, compared);
      const title = [...takes].sort(byMode)[0]!.video.journey.title;
      return LOOKS.includes(verdict.kind) ? [{ takes, title, verdict }] : [];
    })
    .sort(
      (a, b) =>
        LOOKS.indexOf(a.verdict.kind) - LOOKS.indexOf(b.verdict.kind) ||
        a.title.localeCompare(b.title),
    );

  const shown: Array<Shown> = [];
  const add = (of: Found, picture: string | null | undefined, gif: Shown["gif"] = null) => {
    // A name as a run's are, of a kind GitHub shows: never a path out of its folder.
    if (!picture || picture.startsWith(".") || !SEGMENT.test(picture) || !INLINE.test(picture))
      return;
    const file = path.join(of.dir, picture);
    const at = path.relative(dir, file).split(path.sep).join("/");
    if (shown.some((one) => one.at === at) || (!gif && !isFile(file))) return;
    shown.push({ at, file, gif });
  };
  for (const { takes, verdict } of rows) {
    const base = compared ? on(takes, "base") : null;
    // Not played after: main's video (Before) is the one there is.
    const head =
      on(takes, compared ? "head" : (takes[0]?.target ?? "head")) ??
      (verdict.kind === "unplayed" ? base : null);
    if (!head) continue;
    add(head, "journey.gif", {
      // A compared run's Before video is measured against this pull request.
      reference: compared && head.target === "base" ? "this pull request" : "the reference",
      video: head.video,
    });
    const other = base && base !== head ? base : null;
    const stop =
      verdict.kind === "new" ? undefined : other?.video.checks.find((c) => c.verdict === "missing");
    if (other && stop?.picture) {
      add(other, stop.picture);
      const picture = stop.picture;
      add(
        head,
        head.video.checks.find((c) => c.picture && stepOf(c.picture) === stepOf(picture))?.picture,
      );
    }
    if (other && verdict.kind === "changed")
      for (const note of verdict.notes) {
        const differs = other.video.checks.find(
          (c) => c.at === note.at && c.verdict === "differs" && c.picture,
        );
        const same = differs?.picture ? sameStep(head.video, differs.picture) : undefined;
        if (!same) continue;
        add(other, differs!.picture);
        add(head, same);
      }
    for (const chapter of head.video.chapters) add(head, chapter.picture);
  }
  return shown;
}

/** “a”, “a and b”, “a, b and c”. */
const listed = (items: ReadonlyArray<string>) =>
  items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

const inMb = (bytes: number) => `${Number((bytes / MB).toFixed(1))} MB`;

/** The run's own files, as filesOf sends them (each video's still counted, drawn yet or not): how many, how large. */
function ownOf(videos: ReadonlyArray<Found>) {
  let count = 0;
  let bytes = 0;
  for (const { dir } of videos) {
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && VIDEO_FILE.test(entry.name))
      .map((entry) => entry.name);
    count += names.length + (names.includes("still.jpg") ? 0 : 1);
    for (const name of names) bytes += statSync(path.join(dir, name)).size;
  }
  return { bytes, count };
}

/**
 * What goes on the videos branch for a pull request's comment (shownIn): each file there
 * at `pr-<n>/<run>/<its path in the run>`, where the service's comment finds it (a
 * picture uploaded as WebP, by its PNG of the same name: the run on disk keeps its PNGs),
 * and uploaded under publish/. Within pomspec's limits (`limits`, the service's), said in
 * one line, naming only those that did, when they leave anything out: a file over the
 * limit for one; then, while together they are over the limit for a run's (or the run's
 * own files leave less room), its GIFs, the largest first, then its pictures, the
 * comment's last first; then, past so many files, the comment's last.
 */
export function publishOf(
  dir: string,
  videos: ReadonlyArray<Found>,
  {
    limits = LIMITS,
    pull,
    run,
    say,
  }: Readonly<{
    limits?: Readonly<Record<"branch" | "branchFiles" | "branchRun" | "files" | "run", number>>;
    pull: number;
    run: string;
    say?: (line: string) => void;
  }>,
): Array<Publish> {
  if (!Number.isSafeInteger(pull) || pull < 1 || !SEGMENT.test(run)) return [];
  const files = shownIn(dir, videos).flatMap((one) =>
    isFile(one.file) ? [{ ...one, size: statSync(one.file).size }] : [],
  );
  const left = new Set<(typeof files)[number]>();
  // The limits that left something out, said alone: the videos branch's (a file, in all,
  // how many), else a run's, when its own files leave less room than the branch has.
  const branch = new Set<string>();
  const ofRun = new Set<string>();
  const leave = (one: (typeof files)[number], over: Set<string>, limit: string) => {
    left.add(one);
    over.add(limit);
  };
  const kept: typeof files = [];
  for (const one of files) {
    if (one.size > limits.branch) leave(one, branch, `${inMb(limits.branch)} a file`);
    else kept.push(one);
  }
  const own = ownOf(videos);
  const room = Math.min(limits.branchRun, limits.run - own.bytes);
  const [roomOf, roomIs] =
    room === limits.branchRun
      ? [branch, `${inMb(limits.branchRun)} in all`]
      : [ofRun, inMb(limits.run)];
  let total = kept.reduce((sum, one) => sum + one.size, 0);
  while (kept.length && total > room) {
    const gif = kept
      .filter((one) => one.gif)
      .reduce<(typeof kept)[number] | null>((a, b) => (a && a.size >= b.size ? a : b), null);
    const drop = gif ?? kept.at(-1)!;
    kept.splice(kept.indexOf(drop), 1);
    total -= drop.size;
    leave(drop, roomOf, roomIs);
  }
  const most = Math.max(0, Math.min(limits.branchFiles, limits.files - own.count));
  const [countOf, countIs] =
    most === limits.branchFiles
      ? [branch, `${limits.branchFiles.toLocaleString("en")} files`]
      : [ofRun, `${limits.files.toLocaleString("en")} files`];
  while (kept.length > most) leave(kept.pop()!, countOf, countIs);
  /** “pomspec's limit for … (a, b)”, “pomspec's limits for … (a, b)”. */
  const limitsOf = (parts: Set<string>, of: string) =>
    parts.size
      ? [`pomspec's limit${parts.size > 1 ? "s" : ""} for ${of} (${[...parts].join(", ")})`]
      : [];
  // What was left out, in the comment's order.
  const gifs = files.flatMap((one) =>
    left.has(one) && one.gif ? [`“${one.gif.video.journey.title}”`] : [],
  );
  const pictures = left.size - gifs.length;
  if (left.size)
    say?.(
      `Left out of the pull request's comment, over ${[
        ...limitsOf(branch, "the videos branch"),
        ...limitsOf(ofRun, "a run, its videos included"),
      ].join(" and ")}: ${[
        gifs.length > 3
          ? `${gifs.length} GIFs`
          : gifs.length
            ? `the GIF${gifs.length > 1 ? "s" : ""} of ${listed(gifs)}`
            : "",
        pictures > 1 ? `${pictures} pictures` : pictures ? "a picture" : "",
      ]
        .filter(Boolean)
        .join(", and ")}.`,
    );
  return kept.map((one, n) => {
    // Its key, one folder deep: numbered, so no two are alike, and named as it is.
    const name = `${n + 1}-${path.posix.basename(one.at)}`;
    return {
      file: one.file,
      key: `publish/${SEGMENT.test(name) ? name : `${n + 1}${path.posix.extname(one.at)}`}`,
      path: `pr-${pull}/${run}/${one.at}`,
    };
  });
}

/**
 * What `pom upload --pull <n>` puts on the videos branch for its pull request's comment:
 * the GIFs the comment shows, made first beside their recordings with the spec's own
 * Playwright (gif.ts), then publishOf. What can't be made is said in a line, and the
 * upload goes on without it.
 */
export async function publishFor({
  pull,
  run,
  say,
  spec,
}: Readonly<{
  pull: number;
  /** The run's id: its folder in the spec's runs. */
  run: string;
  say?: (line: string) => void;
  /** The folder whose `.pom/runs` holds it. */
  spec: string;
}>): Promise<Array<Publish>> {
  const dir = path.join(runsOf(spec), run);
  // No such run: the upload says so.
  if (!existsSync(dir)) return [];
  const videos = videosIn(dir);
  const gifs = shownIn(dir, videos).flatMap(({ file, gif }) =>
    gif ? [{ ...gif, dir: path.dirname(file) }] : [],
  );
  if (gifs.length) await makeGifs(gifs, { from: spec, say: (line) => say?.(line) });
  return publishOf(dir, videos, { pull, run, say });
}
