import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { featureOf, repoOf, runsIn, runsOf, stillOf, videosIn } from "./videos.ts";

// What a runner uploads of a spec's runs (videos.ts): its runs and their finished videos,
// each journey's .feature as the run played it, and the repository it is in.

/** A spec folder of runs, as the runner leaves it. */
function spec() {
  const dir = mkdtempSync(path.join(tmpdir(), "pom-videos-"));
  after(() => rmSync(dir, { force: true, recursive: true }));
  writeFileSync(path.join(dir, "pom.config.ts"), 'export default { name: "shop", targets: {} };\n');
  return dir;
}

function run(dir: string, id: string, at: string) {
  const root = path.join(runsOf(dir), id);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, "run.json"),
    JSON.stringify({
      at,
      branch: "feature",
      commit: "abcdef1234567",
      dirty: false,
      run: id,
      subject: "Add a cart",
      targets: { base: "http://localhost/base", head: "http://localhost/head" },
    }),
  );
  return (target: string, file: string, video: { seconds?: number } = {}, mode = "visual") => {
    const slug = path.basename(file, ".journey.ts");
    const folder = path.join(root, target, path.dirname(file), slug, mode);
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      path.join(folder, "video.json"),
      JSON.stringify({
        badges: [],
        chapters: [{ start: 0, title: "Start" }],
        checks: [{ at: 1, text: "The page", verdict: "found" }],
        duration: 3,
        journey: { file, route: "/", slug, title: slug.replace(/-/g, " ") },
        lines: [],
        mode,
        passed: true,
        pointer: [],
        rings: [],
        ripples: [],
        size: { height: 800, width: 1280 },
        ...("seconds" in video ? { seconds: video.seconds } : { seconds: 3 }),
      }),
    );
    for (const name of ["journey.webm", "poster.jpg", "01-sees.png"])
      writeFileSync(path.join(folder, name), "x");
    return folder;
  };
}

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Ana",
      "-c",
      "user.email=ana@example.com",
      "-c",
      "commit.gpgsign=false",
    ].concat(args),
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();

test("a spec's runs, newest first, and each run's finished videos by target", () => {
  const dir = spec();
  run(dir, "r1", "2026-01-01T00:00:00Z")("head", "cart.journey.ts");
  const video = run(dir, "r2", "2026-01-02T00:00:00Z");
  video("head", "[shop]/browse.journey.ts");
  video("base", "[shop]/browse.journey.ts", {}, "reference");
  // Unfinished (no length yet): not a video to upload.
  video("head", "cart.journey.ts", { seconds: undefined });
  // A folder with no run.json is no run.
  mkdirSync(path.join(runsOf(dir), "half"), { recursive: true });

  assert.deepEqual(
    runsIn(runsOf(dir)).map((r) => r.run),
    ["r2", "r1"],
  );
  assert.deepEqual(runsIn(path.join(dir, "nowhere")), []);
  assert.deepEqual(
    videosIn(path.join(runsOf(dir), "r2"))
      .map((f) => [f.target, f.video.journey.file, path.relative(runsOf(dir), f.dir)])
      .sort(),
    [
      [
        "base",
        "[shop]/browse.journey.ts",
        path.join("r2", "base", "[shop]", "browse", "reference"),
      ],
      ["head", "[shop]/browse.journey.ts", path.join("r2", "head", "[shop]", "browse", "visual")],
    ],
  );
});

test("a video's still is drawn from its journey.webm, never the runner's marked poster: none when the webm cannot be read", () => {
  const dir = spec();
  const folder = run(dir, "r1", "2026-01-01T00:00:00Z")("head", "cart.journey.ts");
  const [found] = videosIn(path.join(runsOf(dir), "r1"));
  assert.equal(stillOf(folder, found!.video), null);
});

test("a journey's .feature as the run played it: its commit's, else the checkout's, said so when its journey changed since", () => {
  const dir = spec();
  git(dir, "init", "--quiet");
  const file = "account/sign-in.journey.ts";
  const feature = path.join(dir, "account", "sign-in.feature");
  // A journey with no .feature has none.
  assert.equal(featureOf(dir, file), null);
  mkdirSync(path.dirname(feature), { recursive: true });
  writeFileSync(feature, "Feature: Sign in\n");
  git(dir, "add", "account");
  git(dir, "commit", "--quiet", "--no-verify", "-m", "Sign in");
  const commit = git(dir, "rev-parse", "HEAD");
  writeFileSync(feature, "Feature: Sign in, again\n");
  const played = { at: "2026-01-01T00:00:00Z", commit, dirty: false };

  // Played at a commit that holds it: as that commit has it.
  assert.deepEqual(featureOf(dir, file, played), {
    file: "account/sign-in.feature",
    note: null,
    text: "Feature: Sign in\n",
  });
  // Played with uncommitted changes: the checkout's, which it played.
  assert.deepEqual(featureOf(dir, file, { ...played, dirty: true }), {
    file: "account/sign-in.feature",
    note: null,
    text: "Feature: Sign in, again\n",
  });
  // A .feature that is the journey itself is read as it is.
  assert.equal(featureOf(dir, "account/sign-in.feature")?.text, "Feature: Sign in, again\n");

  // Its journey's code changed after the .feature was written: said so.
  const code = path.join(dir, file);
  writeFileSync(code, "journey('Sign in');\n");
  const later = new Date(Date.now() + 60_000);
  utimesSync(code, later, later);
  assert.equal(featureOf(dir, file)?.note, "Its journey changed after this was written.");
  // Written again since, but the run played before the journey changed: said so too.
  const latest = new Date(Date.now() + 120_000);
  utimesSync(feature, latest, latest);
  assert.equal(featureOf(dir, file)?.note, null);
  assert.equal(
    featureOf(dir, file, { ...played, dirty: true })?.note,
    "Its journey changed after this run played.",
  );
});

test("a repository's owner and name, from its origin remote, and the spec's place in it", () => {
  const dir = spec();
  const sh = (...args: Array<string>) => execFileSync("git", ["-C", dir, ...args]);
  sh("init", "-q");
  mkdirSync(path.join(dir, "apps", "shop", "spec"), { recursive: true });
  const inner = path.join(dir, "apps", "shop", "spec");
  // No remote: local, by the spec's name (its config's, else its folder's).
  assert.deepEqual(repoOf(inner), { name: "shop", owner: "local", prefix: "apps/shop/spec/" });
  writeFileSync(path.join(inner, "pom.config.ts"), 'export default { name: "store" };\n');
  assert.equal(repoOf(inner).name, "store");
  sh("remote", "add", "origin", "https://example.com/x/y.git");
  for (const url of [
    "https://github.com/acme/notes.git",
    "git@github.com:acme/notes.git",
    "https://github.com/acme/notes",
  ]) {
    sh("remote", "set-url", "origin", url);
    assert.deepEqual(repoOf(inner), {
      name: "notes",
      owner: "acme",
      prefix: "apps/shop/spec/",
    });
  }
});
