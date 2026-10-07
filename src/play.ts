import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import { checkSpec } from "./check.ts";
import { type Config, loadConfig } from "./config.ts";
import { type Played, verdictOf } from "./video.ts";
import { generate } from "./generate.ts";
import { compare, type Threshold } from "./png.ts";
import { MODE } from "./reel.ts";
import { gitRoot, real } from "./source.ts";
import { readSpec } from "./spec.ts";
import type { Video, VideoRun } from "./view/model.ts";

// `pom videos`: a spec's journeys played on a pull request's two sides and recorded for
// pomspec. Both sides play this checkout's spec: its head (this checkout's app) and its
// base (main's), each at an address it is up at, or started for its turn and stopped
// after it (one side at a time, so both can take the same port). Each journey is recorded
// by the reel (reel.ts) inside its generated test, then made ready to watch (its length,
// its storyboard) and the base's chapters compared with the head's: a screen that looks
// different is noted on the base's video, as the videos' pages and the pull request's
// comment read it (video.ts, verdictOf). A journey new in the pull request stops on the
// base, where it is not yet.
//
// What it makes is kept as a run of the spec, keyed as git keys code (its commit, and a
// hash of what is not committed yet under the spec), beside the spec in pom's own
// folder: `.pom/runs/<run>/`, its run.json and `<side>/<journey>/<mode>/` per video,
// ready for `pom upload --run <run>`. It exits 0 once the videos are made, whatever they
// show: what they found is the videos' to say, and the pull request's check pomspec
// writes from them.

export const USAGE = `pom videos [spec] [--head-url <url>] [--base-url <url>]
           [--start <command> --ready-url <url>] [--base-dir <dir>]
           [--width <name>] [--names <base>,<head>] [-- <playwright args>]

Plays the spec's journeys on a pull request's head and base, recorded for pomspec, into
.pom/runs/<run>/ beside the spec; then pom upload --run <run> sends them.

  --head-url <url>     where the head's app is up (else pom.config.ts's baseURL, or
                       --start)
  --base-url <url>     where the base's app is up; with neither it nor --base-dir, only
                       the head is played
  --start <command>    starts a side's app when it has no address: here for the head, in
                       --base-dir for the base (else pom.config.ts's webServer)
  --ready-url <url>    where a started app answers once it is up: its journeys play there
  --base-dir <dir>     the base's checkout (a git worktree), where its app is started
  --width <name>       the width recorded (pom.config.ts's first video width, else its
                       first)
  --names <base>,<head>  the sides' names on pomspec (the pull request's base branch,
                       and head)

A value typed from a secret (a variable named *_PASSWORD, *_TOKEN or *_SECRET, or
listed in pom.config.ts's secrets) shows as dots in the videos and what they say.
In a GitHub Action, the run's id is also the step's output "run".`;

type Side = "base" | "head";

/** An app started for a side's turn: its command, where it runs, and where it answers. */
type Start = Readonly<{
  command: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeout: number;
  url: string;
}>;

/** Where a side plays: its address, and the app started there first, if one is. */
type Where = Readonly<{ start: Start | null; url: string }>;

/** A video kept in a run: its folder, its side, and what it says. */
type Kept = Readonly<{ dir: string; video: Video; side: string }>;

const OPTIONS = {
  "base-dir": { type: "string" },
  "base-url": { type: "string" },
  config: { type: "string" },
  "head-url": { type: "string" },
  help: { short: "h", type: "boolean" },
  names: { type: "string" },
  "ready-url": { type: "string" },
  start: { type: "string" },
  width: { type: "string" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>["values"];

/** `pom videos`, its arguments after the command: its exit status. */
export async function videos(argv: ReadonlyArray<string>): Promise<number> {
  const split = argv.indexOf("--");
  const own = split === -1 ? [...argv] : argv.slice(0, split);
  const rest = split === -1 ? [] : argv.slice(split + 1);
  let parsed: { positionals: Array<string>; values: Values };
  try {
    parsed = parseArgs({ allowPositionals: true, args: own, options: OPTIONS });
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    await play(parsed.values, parsed.positionals[0], rest);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/** The config written beside the generated one: the width recorded, and no server of its own. */
const VIDEOS_CONFIG = `// Written by pom videos: the journeys' Playwright config, generated from the spec,
// at the width it records and with no server of its own (each side's app is up at
// POM_BASE_URL before it plays). A control that is not there stops its journey in
// seconds, not at the test's timeout: the video shows where. Edit the spec and
// pom.config.ts, not this file.
import config from "./playwright.config.ts";

const width = process.env.POM_VIDEOS_WIDTH ?? "desktop";
const projects = config.projects ?? [];
const own =
  projects.find((p) => p.name === \`video-\${width}\`) ?? projects.find((p) => p.name === width);
if (!own) throw new Error(\`pom.config.ts has no width \${width}\`);

export default {
  ...config,
  projects: [
    {
      ...own,
      name: \`video-\${width}\`,
      use: { ...own.use, actionTimeout: 10_000, navigationTimeout: 30_000, trace: "off" },
    },
  ],
  webServer: undefined,
};
`;

async function play(values: Values, named: string | undefined, rest: ReadonlyArray<string>) {
  const config = await loadConfig({ cwd: process.cwd(), file: values.config, spec: named });
  const spec = readSpec(config.spec, Object.keys(config.widths));
  const { compiled, problems } = checkSpec(spec, {
    signIns: new Set(Object.keys(config.roles)),
  });
  for (const p of problems)
    console.error(`${path.relative(process.cwd(), p.file)}:${p.line}: ${p.message}`);
  if (problems.length)
    throw new Error(
      `${problems.length} problems in the spec: it is recorded once every line finds its control`,
    );
  if (!compiled.length)
    throw new Error(`No journeys in ${path.relative(process.cwd(), config.spec) || "."}`);
  const width = values.width ?? config.video?.widths[0] ?? Object.keys(config.widths)[0]!;
  if (!config.widths[width])
    throw new Error(
      `pom.config.ts has no width ${width}: ${Object.keys(config.widths).join(", ")}`,
    );

  // pom's own folder beside the spec, where `pom upload` finds the runs.
  const out = path.join(path.dirname(config.spec), ".pom");
  generate(spec, out, { config });
  writeFileSync(path.join(out, "videos.config.ts"), VIDEOS_CONFIG);
  const run = runOf(config);
  const dir = path.join(out, "runs", run.run);
  const sides = sidesOf(values, config);
  // A run is what this play made: an earlier play's videos of it, of either side, go.
  rmSync(dir, { force: true, recursive: true });
  mkdirSync(dir, { recursive: true });

  const played: Record<string, string> = {};
  for (const side of ["head", "base"] as const) {
    const where = sides[side];
    if (!where) continue;
    console.log(`\n${side}: ${where.url}`);
    try {
      const stop = where.start ? await serve(where.start, side) : null;
      try {
        playSide({ config, dir, out, rest, side, url: where.url, width });
      } finally {
        await stop?.();
      }
      if (!videosUnder(path.join(dir, side)).length)
        throw new Error(`No video was made on the ${side}: Playwright says why, above.`);
      played[side] = where.url;
    } catch (error) {
      // The head's videos are the run; without the base's, it is the head's alone.
      if (side === "head") throw error;
      rmSync(path.join(dir, side), { force: true, recursive: true });
      console.error(`The base wasn't played: ${(error as Error).message}`);
    }
  }

  const changed = compareSides(ready(dir), config.threshold);
  const both = Boolean(played.head && played.base);
  const [base, head] = (values.names ?? "").split(",").map((name) => name.trim());
  const record: VideoRun = {
    ...run,
    at: new Date().toISOString(),
    ...(both
      ? { names: { base: base || process.env.GITHUB_BASE_REF || "base", head: head || "head" } }
      : {}),
    targets: played,
  };
  writeFileSync(path.join(dir, "run.json"), `${JSON.stringify(record, null, 1)}\n`);

  console.log("");
  for (const [file, takes] of journeysOf(keptIn(dir))) {
    const verdict = verdictOf(takes, both);
    console.log(`${takes[0]!.video.journey.title}: ${verdict.kind} (${file})`);
  }
  if (changed) console.log(`${changed} screens look different on the base`);
  console.log(`run ${run.run}: ${path.relative(process.cwd(), dir) || "."}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${run.run}\n`);
}

/**
 * Where each side plays: the head always, the base when it has an address or a checkout.
 * A side pom starts never plays an app already answering where it would: one left running
 * (an earlier play's base, another checkout's) would be recorded as this side's.
 */
function sidesOf(values: Values, config: Config): Record<Side, Where | null> {
  const web = config.webServer;
  const startIn = (cwd: string): Start | null => {
    if (values.start) {
      const url =
        values["ready-url"] ??
        failWith("pom videos starts an app only with where it answers: --ready-url <url>");
      return { command: values.start, cwd, env: {}, timeout: 180_000, url };
    }
    if (!web) return null;
    const url =
      values["ready-url"] ??
      web.url ??
      (web.port ? `http://localhost:${web.port}` : null) ??
      failWith("pom.config.ts's webServer says no url or port: where does it answer?");
    return {
      command: web.command,
      cwd: path.resolve(cwd, web.cwd ?? "."),
      env: { ...web.env },
      timeout: web.timeout ?? 60_000,
      url,
    };
  };

  let head: Where;
  if (values["head-url"]) head = { start: null, url: values["head-url"] };
  else {
    const start = startIn(config.dir);
    // One up already is given by its address (--head-url): serve() refuses it.
    if (start) head = { start, url: start.url };
    else {
      const url =
        process.env.POM_BASE_URL ??
        config.baseURL ??
        failWith(
          "pom videos needs where the head's app is: --head-url <url>, --start <command> with --ready-url, or baseURL or webServer in pom.config.ts",
        );
      head = { start: null, url };
    }
  }

  let base: Where | null = null;
  if (values["base-url"]) base = { start: null, url: values["base-url"] };
  else if (values["base-dir"]) {
    const root =
      gitRoot(config.dir) ?? failWith("pom videos starts the base only in a git repository");
    const checkout = path.resolve(values["base-dir"]);
    const start =
      startIn(path.join(checkout, path.relative(root, real(config.dir)))) ??
      failWith(
        "pom videos starts the base's app with --start <command> (and --ready-url), or pom.config.ts's webServer",
      );
    base = { start, url: start.url };
  }
  return { base, head };
}

const failWith = (message: string): never => {
  throw new Error(message);
};

/** Whether an app answers at an address, as Playwright's webServer asks: anything short of 404. */
async function answers(url: string) {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
    await response.body?.cancel().catch(() => {});
    return response.status >= 200 && response.status < 404;
  } catch {
    return false;
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How pom's own exit status reads a signal that ends it: 128 and the signal's number. */
const SIGNALS = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

/**
 * A side's app, started for its turn in its own process group, once its address answers;
 * how to stop it, the processes it started included. Something already answering there
 * is another app, never this side's: refused. A signal that ends pom (Ctrl-C, a cancelled
 * job) takes the app down with it, since its group never hears the terminal's.
 */
async function serve(start: Start, side: Side): Promise<() => Promise<void>> {
  if (await answers(start.url))
    throw new Error(
      `Something already answers at ${start.url}, so the ${side}'s app can't start there. Stop it, or give the ${side}'s address (--${side}-url).`,
    );
  console.log(`starting the ${side}'s app: ${start.command} (in ${start.cwd})`);
  const child = spawn(start.command, {
    cwd: start.cwd,
    detached: true,
    env: { ...process.env, ...start.env },
    shell: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  let exited: number | null = null;
  const gone = new Promise<void>((resolve) =>
    child.on("exit", (code, signal) => {
      exited = code ?? (signal ? 128 : 1);
      resolve();
    }),
  );
  const kill = (signal: NodeJS.Signals) => {
    if (exited !== null || !child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Gone already.
    }
  };
  const down = () => kill("SIGTERM");
  const ended = (signal: keyof typeof SIGNALS) => {
    down();
    process.exit(SIGNALS[signal]);
  };
  const names = Object.keys(SIGNALS) as Array<keyof typeof SIGNALS>;
  for (const signal of names) process.on(signal, ended);
  process.on("exit", down);
  const release = () => {
    for (const signal of names) process.off(signal, ended);
    process.off("exit", down);
  };
  const stop = async () => {
    if (exited === null && child.pid) {
      kill("SIGTERM");
      await Promise.race([gone, wait(5000)]);
      kill("SIGKILL");
    }
    release();
  };
  const deadline = Date.now() + start.timeout;
  for (;;) {
    if (exited !== null) {
      release();
      throw new Error(`The ${side}'s app stopped (${exited}) before ${start.url} answered.`);
    }
    if (await answers(start.url)) return stop;
    if (Date.now() > deadline) {
      await stop();
      throw new Error(
        `${start.url} didn't answer within ${Math.round(start.timeout / 1000)} s of starting the ${side}'s app.`,
      );
    }
    await wait(500);
  }
}

/** One side's journeys, played and recorded by the generated tests at its address. */
function playSide(input: {
  config: Config;
  dir: string;
  out: string;
  rest: ReadonlyArray<string>;
  side: Side;
  url: string;
  width: string;
}) {
  const { config, out } = input;
  const cli = createRequire(path.join(out, "x.js")).resolve("@playwright/test/cli");
  spawnSync(
    process.execPath,
    [cli, "test", "-c", path.join(out, "videos.config.ts"), ...input.rest],
    {
      env: {
        ...process.env,
        POM_BASE_URL: input.url,
        POM_VIDEOS: path.join(input.dir, input.side),
        // Its pictures as `pom shots` takes them, so two sides played apart compare alike.
        POM_VIDEOS_LOOK: JSON.stringify({
          clock: config.clock,
          mask: config.mask,
          stylePath: config.stylePath,
        }),
        // The journeys' files as the runs name them: from the folder `pom upload` reads.
        POM_VIDEOS_SPEC: path.relative(path.dirname(out), config.spec).split(path.sep).join("/"),
        POM_VIDEOS_TESTS: path.join(out, "tests"),
        POM_VIDEOS_WIDTH: input.width,
        POM_RUN: path.join(out, "run-videos"),
        POM_SECRETS: config.secrets.join(","),
        POM_SHOTS: "1",
      },
      stdio: "inherit",
    },
  );
}

/** Every video under a folder: a folder with its video.json beside its journey.webm. */
function videosUnder(folder: string): Array<string> {
  const found: Array<string> = [];
  const visit = (dir: string) => {
    if (existsSync(path.join(dir, "video.json")) && existsSync(path.join(dir, "journey.webm"))) {
      found.push(dir);
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true }))
      if (entry.isDirectory()) visit(path.join(dir, entry.name));
  };
  if (existsSync(folder)) visit(folder);
  return found.sort();
}

const readVideo = (dir: string) =>
  JSON.parse(readFileSync(path.join(dir, "video.json"), "utf8")) as Video;
const writeVideo = (dir: string, video: Video) =>
  writeFileSync(path.join(dir, "video.json"), `${JSON.stringify(video, null, 1)}\n`);

/** A run's videos, head's first. */
export const keptIn = (dir: string): Array<Kept> =>
  ["head", "base"].flatMap((side) =>
    videosUnder(path.join(dir, side)).map((folder) => ({
      dir: folder,
      video: readVideo(folder),
      side,
    })),
  );

const hasFfmpeg = () => spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

/** A storyboard's picture every quarter second, ten to a row, for a player's timeline. */
const STORYBOARD = { columns: 10, every: 0.25, height: 120, width: 160 };

/**
 * Each video of a run made ready to watch: its length as its journey.webm has it (the
 * recorder holds the last frame past the end) and its storyboard, drawn with ffmpeg when
 * this machine has it; without, the length the reel noted and no storyboard.
 */
function ready(dir: string): Array<Kept> {
  const ffmpeg = hasFfmpeg();
  return keptIn(dir).map(({ dir: folder, video: read, side }): Kept => {
    let video = read;
    const webm = path.join(folder, "journey.webm");
    if (ffmpeg && !video.storyboard) {
      const probed = Number(
        spawnSync(
          "ffprobe",
          ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", webm],
          { encoding: "utf8" },
        ).stdout.trim(),
      );
      const length = Number.isFinite(probed) && probed > 0 ? probed : video.duration;
      const count = Math.max(1, Math.ceil(length / STORYBOARD.every));
      const drawn = spawnSync(
        "ffmpeg",
        [
          "-y",
          "-loglevel",
          "error",
          "-i",
          webm,
          "-vf",
          `fps=${1 / STORYBOARD.every},scale=${STORYBOARD.width}:${STORYBOARD.height},tile=${STORYBOARD.columns}x${Math.ceil(count / STORYBOARD.columns)}`,
          "-frames:v",
          "1",
          "-q:v",
          "4",
          path.join(folder, "storyboard.jpg"),
        ],
        { stdio: "inherit" },
      );
      video = {
        ...video,
        seconds: length,
        storyboard:
          drawn.status === 0
            ? {
                columns: STORYBOARD.columns,
                count,
                every: STORYBOARD.every,
                height: STORYBOARD.height,
                width: STORYBOARD.width,
              }
            : null,
      };
      writeVideo(folder, video);
    }
    return { dir: folder, video, side };
  });
}

const percent = (ratio: number) => `${(ratio * 100).toFixed(2)}%`;

/** What tells a screen compared here from the video's own checks. */
const COMPARED = /^The screen: /;

/**
 * The base's chapters against the head's, where the journey passed on both: each screen
 * that looks different, past the config's threshold, noted on the base's video as the
 * videos' verdicts read it ("changed"). Its picture is the base's; the count noted.
 */
export function compareSides(kept: ReadonlyArray<Kept>, threshold: Threshold): number {
  let changed = 0;
  const heads = new Map(
    kept.filter((k) => k.side === "head").map((k) => [k.video.journey.file, k] as const),
  );
  for (const base of kept.filter((k) => k.side === "base")) {
    const head = heads.get(base.video.journey.file);
    const checks = base.video.checks.filter(
      (c) => !(c.verdict === "differs" && COMPARED.test(c.text)),
    );
    if (head?.video.passed && base.video.passed)
      base.video.chapters.forEach((chapter, i) => {
        const theirs = head.video.chapters[i];
        if (!chapter.picture || !theirs?.picture || theirs.title !== chapter.title) return;
        const mine = path.join(base.dir, chapter.picture);
        const other = path.join(head.dir, theirs.picture);
        if (!existsSync(mine) || !existsSync(other)) return;
        const result = compare(readFileSync(other), readFileSync(mine), threshold);
        if (!result.changed) return;
        changed += 1;
        const next = base.video.chapters[i + 1]?.start ?? base.video.duration;
        checks.push({
          at: Math.max(chapter.start, next - 0.6),
          picture: chapter.picture,
          text: `The screen: ${percent(result.ratio)} different from the reference (${percent(threshold.ratio)} allowed)`,
          verdict: "differs",
        });
      });
    writeVideo(base.dir, { ...base.video, checks: checks.sort((a, b) => a.at - b.at) });
  }
  return changed;
}

/** A run's videos by journey, as verdicts read them. */
function journeysOf(kept: ReadonlyArray<Kept>) {
  const by = new Map<string, Array<Played>>();
  for (const { video, side } of kept) {
    const file = video.journey.file;
    by.set(file, [...(by.get(file) ?? []), { video, mode: video.mode ?? MODE, target: side }]);
  }
  return [...by].sort(([a], [b]) => a.localeCompare(b));
}

/**
 * The run this spec's code is at: its commit, and what is not committed yet under the
 * spec (changed or new files, by content), so every edit is a run of its own. A
 * detached checkout (a pull request's head, in CI) takes its branch's name from CI.
 */
export function runOf(config: Config): Omit<VideoRun, "at" | "names" | "targets"> {
  const root =
    gitRoot(config.dir) ?? failWith("pom videos keeps runs by commit: this is no git repository");
  const git = (args: ReadonlyArray<string>) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const commit = git(["rev-parse", "HEAD"]).trim();
  let branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (branch === "HEAD")
    branch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || "HEAD";
  const subject = git(["log", "-1", "--format=%s"]).trim();
  const spec = path.relative(root, real(config.spec)).split(path.sep).join("/") || ".";
  // -z: each entry is `XY <path>`, and a rename's or copy's old path follows it.
  const entries = git(["status", "--porcelain", "-z", "--untracked-files=all", "--", spec]).split(
    "\0",
  );
  const changed: Array<string> = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (!entry) continue;
    if (/^[RC]/.test(entry)) i += 1;
    // A journey's kept pictures are what a run drew, not what it ran.
    if (!/\.shots\//.test(entry.slice(3))) changed.push(entry.slice(3));
  }
  changed.sort();
  if (!changed.length) return { branch, commit, dirty: false, run: commit.slice(0, 12), subject };
  const hash = createHash("sha256");
  for (const file of changed) {
    const full = path.join(root, file);
    hash.update(`${file}\0`);
    if (existsSync(full)) hash.update(readFileSync(full));
  }
  return {
    branch,
    commit,
    dirty: true,
    run: `${commit.slice(0, 12)}-${hash.digest("hex").slice(0, 8)}`,
    subject,
  };
}
