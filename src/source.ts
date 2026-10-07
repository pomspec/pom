import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "./config.ts";
import type { Taken } from "./types.ts";

// What code drew a set of pictures: a hash of the config's `sources` (the files git
// tracks there, and what is staged, the spec left out), as the working tree has them
// or as a commit does. Pictures are kept and looked up by it: the same code, the same
// pictures; a commit that only touched the spec changes nothing, and neither does a
// stray file nobody added. A new file counts once git knows it (`git add`).

const git = (cwd: string, args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const attempt = <T>(run: () => T): T | null => {
  try {
    return run();
  } catch {
    return null;
  }
};

/**
 * A path as git names it: through its real folders (macOS's /var is /private/var),
 * the part that does not exist yet kept as it is.
 */
export function real(at: string): string {
  const missing: Array<string> = [];
  let here = path.resolve(at);
  while (!existsSync(here)) {
    missing.unshift(path.basename(here));
    here = path.dirname(here);
  }
  return path.join(realpathSync.native(here), ...missing);
}

/** The repository a folder is in, if any. */
export const gitRoot = (dir: string) => attempt(() => git(dir, ["rev-parse", "--show-toplevel"]));

const digest = (parts: ReadonlyArray<string>) =>
  createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);

/** Outside git: the files themselves, what is generated or installed left out. */
function walked(config: Config): string {
  const skip = new Set([".git", ".pom", "node_modules", "dist"]);
  const parts: Array<string> = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (skip.has(entry) || full === config.spec) continue;
      if (statSync(full).isDirectory()) visit(full);
      else
        parts.push(`${path.relative(config.dir, full)} ${digest([readFileSync(full, "latin1")])}`);
    }
  };
  for (const source of config.sources) {
    const at = path.resolve(config.dir, source);
    if (existsSync(at)) visit(at);
  }
  return digest(parts);
}

/**
 * The source hash of the working tree (`ref` null) or of a commit. Through an index
 * of its own: the repository's index and files are never touched.
 */
export function sourceAt(config: Config, ref: string | null = null): string {
  const root = gitRoot(config.dir);
  if (!root) {
    if (ref) throw new Error("pom compares commits only in a git repository");
    return walked(config);
  }
  const temp = mkdtempSync(path.join(os.tmpdir(), "pom-index-"));
  try {
    const index = path.join(temp, "index");
    const env = { GIT_INDEX_FILE: index };
    const relative = (at: string) => path.relative(root, real(at)).split(path.sep).join("/") || ".";
    const sources = config.sources.map((s) => relative(path.resolve(config.dir, s)));
    if (ref) {
      git(root, ["read-tree", ref], env);
    } else {
      const own = path.resolve(root, git(root, ["rev-parse", "--git-path", "index"]));
      // The copy keeps the index's time: git trusts a file's cached stat only when it is
      // older than the index, and a fresh copy's time would hide a same-size edit made
      // in the second the index was written.
      if (existsSync(own)) {
        copyFileSync(own, index);
        const { atime, mtime } = statSync(own);
        utimesSync(index, atime, mtime);
      }
      git(root, ["add", "-u", "--", ...sources], env);
    }
    git(root, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", relative(config.spec)], env);
    const tree = git(root, ["write-tree"], env);
    return digest(
      sources.map(
        (source) =>
          `${source} ${source === "." ? tree : (attempt(() => git(root, ["rev-parse", `${tree}:${source}`], env)) ?? "none")}`,
      ),
    );
  } finally {
    rmSync(temp, { force: true, recursive: true });
  }
}

/** The code that drew pictures taken now: its source, its commit, and whether it differs from it. */
export function takenNow(config: Config): Taken {
  const source = sourceAt(config);
  const root = gitRoot(config.dir);
  const commit = root ? attempt(() => git(root, ["rev-parse", "HEAD"])) : null;
  const dirty = commit ? attempt(() => sourceAt(config, commit)) !== source : true;
  return { commit, dirty, source };
}

/** `git merge-base HEAD <base>`, or why there is none. */
export function mergeBase(config: Config, base: string): string {
  const root = gitRoot(config.dir);
  if (!root) throw new Error("pom diff compares with a base branch only in a git repository");
  if (git(root, ["rev-parse", "--is-shallow-repository"]) === "true") {
    const found = attempt(() => git(root, ["merge-base", "HEAD", base]));
    if (found) return found;
    throw new Error(
      `This clone is shallow, so it has no merge-base with ${base}: fetch it (git fetch --unshallow, or actions/checkout with fetch-depth: 0)`,
    );
  }
  const found = attempt(() => git(root, ["merge-base", "HEAD", base]));
  if (!found) throw new Error(`No merge-base between HEAD and ${base}`);
  return found;
}

/** The base branch a pull request goes into: `--base`, CI's, the remote's default, else `main`. */
export function defaultBase(config: Config): string {
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`;
  const root = gitRoot(config.dir);
  const head = root
    ? attempt(() => git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]))
    : null;
  return head ?? "main";
}

/** A file as a commit has it (`git show`), or null. */
export function showAt(config: Config, ref: string, file: string): Buffer | null {
  const root = gitRoot(config.dir);
  if (!root) return null;
  const relative = path.relative(root, real(file)).split(path.sep).join("/");
  return attempt(() =>
    execFileSync("git", ["show", `${ref}:${relative}`], {
      cwd: root,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
}

/** The files a commit holds under a folder. */
export function filesAt(config: Config, ref: string, dir: string): Array<string> {
  const root = gitRoot(config.dir);
  if (!root) return [];
  const relative = path.relative(root, real(dir)).split(path.sep).join("/");
  const listed =
    attempt(() => git(root, ["ls-tree", "-r", "--name-only", ref, "--", relative])) ?? "";
  return listed
    .split("\n")
    .filter(Boolean)
    .map((file) => path.join(root, file));
}

/** A Git LFS pointer where a picture should be. */
export const isLfsPointer = (bytes: Buffer) =>
  bytes.subarray(0, 64).toString("utf8").startsWith("version https://git-lfs.github.com/spec/");
