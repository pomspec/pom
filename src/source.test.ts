import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "./config.ts";
import { isLfsPointer, mergeBase, sourceAt, takenNow } from "./source.ts";

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "pom-source-"));
  const git = (...args: Array<string>) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    }).trim();
  git("init", "-q", "-b", "main");
  mkdirSync(path.join(dir, "spec"));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "app.ts"), "export const a = 1;\n");
  writeFileSync(path.join(dir, "spec", "x.feature"), "Feature: X\n");
  git("add", "-A");
  git("commit", "-qm", "one");
  return { config: resolveConfig({}, dir, null), dir, git };
}

test("the source is the code that draws the pictures: the spec, and stray files, are not part of it", () => {
  const { config, dir, git } = repo();
  const head = git("rev-parse", "HEAD");
  const clean = sourceAt(config);
  assert.equal(clean, sourceAt(config, head));
  assert.deepEqual(takenNow(config), { commit: head, dirty: false, source: clean });

  writeFileSync(path.join(dir, "spec", "x.feature"), "Feature: X, reworded\n");
  writeFileSync(path.join(dir, "notes.txt"), "a stray file nobody added\n");
  assert.equal(sourceAt(config), clean);

  writeFileSync(path.join(dir, "src", "app.ts"), "export const a = 2;\n");
  assert.notEqual(sourceAt(config), clean);
  assert.equal(takenNow(config).dirty, true);

  // A commit that only touched the spec draws the same pictures.
  git("checkout", "-q", "--", "src");
  git("add", "spec");
  git("commit", "-qm", "the spec only");
  assert.equal(sourceAt(config, git("rev-parse", "HEAD")), clean);
});

test("a pull request's base is the merge-base with its branch", () => {
  const { config, dir, git } = repo();
  const base = git("rev-parse", "HEAD");
  git("switch", "-qc", "change");
  writeFileSync(path.join(dir, "src", "app.ts"), "export const a = 3;\n");
  git("commit", "-qam", "change");
  assert.equal(mergeBase(config, "main"), base);
});

test("a Git LFS pointer is told from a picture", () => {
  assert.equal(
    isLfsPointer(Buffer.from("version https://git-lfs.github.com/spec/v1\noid sha256:abc\n")),
    true,
  );
  assert.equal(isLfsPointer(Buffer.from([0x89, 0x50, 0x4e, 0x47])), false);
});
