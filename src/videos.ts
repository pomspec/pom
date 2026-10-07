import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Video, VideoFeature, VideoRepo, VideoRun } from "./view/model.ts";

// What a spec's runs recorded, as a runner uploads it to pomspec (service.ts): each run of
// the journeys on the real app (`<spec>/.pom/runs/<run>/run.json`) and its videos, one
// folder per target, journey and mode (`<run>/<target>/<folder>/<slug>/<mode>/video.json`,
// beside its journey.webm, storyboard, still and pictures), each journey's `.feature` as
// the run played it, and the repository it is in. What a video says, wherever it is read,
// is video.ts's.

// The videos runner (prototype/videos.ts) words a video's marks as pom's does.
export { plainVideo } from "./video.ts";

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
};

const isDir = (file: string) => existsSync(file) && statSync(file).isDirectory();

/** Where a spec's runs are: `<spec>/.pom/runs`. */
export const runsOf = (spec: string) => path.join(spec, ".pom", "runs");

/** Git's answer, or null (no git, no such commit or file). */
const git = (folder: string, args: Array<string>): string | null => {
  try {
    return execFileSync("git", ["-C", folder, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
};

/** A file as a commit has it: a commit never changes, so it is asked of git once. */
const kept = new Map<string, string | null>();
const shown = (folder: string, commit: string, file: string) => {
  const key = `${folder}\0${commit}\0${file}`;
  if (!kept.has(key)) kept.set(key, git(folder, ["show", `${commit}:./${file}`]));
  return kept.get(key)!;
};

const mtime = (file: string) => (existsSync(file) ? statSync(file).mtimeMs : 0);

/**
 * A journey as its repository keeps it: the `.feature` beside its code
 * (`<folder>/<slug>.feature`, written from the journey's TypeScript and its data), or
 * the journey itself when it is one; null when there is none. As the run played it:
 * from the run's commit when the run had no uncommitted changes and the commit holds
 * it, else from the checkout, said so when the journey's code changed since the run
 * or since its `.feature` was written.
 */
export function featureOf(
  spec: string,
  file: string,
  run?: Pick<VideoRun, "at" | "commit" | "dirty">,
): VideoFeature | null {
  const feature = file.endsWith(".feature")
    ? file
    : path.posix.join(
        path.posix.dirname(file),
        `${path.posix.basename(file).replace(/(\.journey)?\.[cm]?[jt]sx?$/, "")}.feature`,
      );
  if (run && !run.dirty && run.commit) {
    const kept = shown(spec, run.commit, feature);
    if (kept !== null) return { file: feature, note: null, text: kept };
  }
  const at = path.join(spec, ...feature.split("/"));
  if (!existsSync(at)) return null;
  let text: string;
  try {
    text = readFileSync(at, "utf8");
  } catch {
    return null;
  }
  const code = file === feature ? 0 : mtime(path.join(spec, ...file.split("/")));
  const note =
    code > mtime(at)
      ? "Its journey changed after this was written."
      : run && code > new Date(run.at).getTime()
        ? "Its journey changed after this run played."
        : null;
  return { file: feature, note, text };
}

/**
 * The repository a folder is in, as its host addresses it: owner and name from its
 * origin remote (`https://github.com/acme/notes.git`,
 * `git@github.com:acme/notes.git`), and the folder's path in it
 * (`apps/notes/spec/`). With no remote, `local/<the spec's name>`.
 */
export function repoOf(folder: string): VideoRepo {
  const remote = git(folder, ["remote", "get-url", "origin"])?.trim() ?? "";
  const named = /[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote);
  const prefix = git(folder, ["rev-parse", "--show-prefix"])?.trim() ?? "";
  return named
    ? { name: named[2]!, owner: named[1]!, prefix }
    : { name: nameOf(folder), owner: "local", prefix };
}

/** The spec's name: its config's `name` (read, never run), else its folder's. */
export function nameOf(folder: string): string {
  const config = path.join(folder, "pom.config.ts");
  const named = existsSync(config)
    ? /\bname:\s*["'`]([^"'`]+)["'`]/.exec(readFileSync(config, "utf8"))?.[1]
    : null;
  if (named) return named;
  const base = path.basename(folder);
  return base === "spec" ? path.basename(path.dirname(folder)) : base;
}

export type Found = Readonly<{ dir: string; target: string; video: Video }>;

/** Every finished video of a run (one that has its length and its journey.webm), by target. */
export function videosIn(runDir: string): Array<Found> {
  const found: Array<Found> = [];
  const visit = (dir: string, target: string) => {
    const file = path.join(dir, "video.json");
    if (existsSync(file)) {
      const video = readJson<Video>(file);
      if (
        video?.journey?.file &&
        typeof video.seconds === "number" &&
        existsSync(path.join(dir, "journey.webm"))
      )
        found.push({ dir, target, video });
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true }))
      if (entry.isDirectory()) visit(path.join(dir, entry.name), target);
  };
  for (const entry of readdirSync(runDir, { withFileTypes: true }))
    if (entry.isDirectory()) visit(path.join(runDir, entry.name), entry.name);
  return found;
}

const hasFfmpeg = (() => {
  let known: boolean | null = null;
  return () => (known ??= spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0);
})();
/** Videos whose still could not be drawn, by file and its time: not tried again. */
const failed = new Set<string>();

/**
 * A video's still, for its poster and its card: the app alone at its first check, as
 * its journey.webm has it (the runner's poster.jpg has its marks burned in, which the
 * page paints itself). Drawn once beside it with ffmpeg, when there is one; null else.
 */
export function stillOf(dir: string, video: Video): string | null {
  const still = path.join(dir, "still.jpg");
  const webm = path.join(dir, "journey.webm");
  const made = mtime(webm);
  if (existsSync(still) && mtime(still) >= made) return still;
  const key = `${webm}@${made}`;
  if (failed.has(key) || !hasFfmpeg()) return null;
  const at = Math.min(
    Math.max(0, (video.checks[0]?.at ?? 1) + 0.25),
    Math.max(0, video.seconds - 0.1),
  );
  const done = spawnSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-ss", String(at), "-i", webm, "-frames:v", "1"].concat([
      "-vf",
      "scale=640:-2",
      "-q:v",
      "3",
      still,
    ]),
    { stdio: "ignore", timeout: 15_000 },
  );
  if (done.status === 0 && existsSync(still)) return still;
  failed.add(key);
  return null;
}

/** The runs in a folder of runs, newest first. */
export function runsIn(runs: string): Array<VideoRun> {
  if (!isDir(runs)) return [];
  return readdirSync(runs)
    .map((name) => readJson<VideoRun>(path.join(runs, name, "run.json")))
    .filter((run): run is VideoRun => Boolean(run?.run && run.at))
    .sort((a, b) => b.at.localeCompare(a.at));
}
