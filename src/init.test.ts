import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { init, WORKFLOW } from "./init.ts";

/** A repository with `app/` in it (a package.json of `files`' own), its remote at `remote`. */
function repository(remote: string | null, files: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "pom-init-"));
  const git = (...args: Array<string>) =>
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  if (remote) git("remote", "add", "origin", remote);
  for (const [file, text] of Object.entries({ "app/package.json": "{}", ...files })) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return { app: path.join(root, "app"), root };
}

/** pom's version, as its package.json says, read here the plain way. */
const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

type Step = Readonly<{ uses: string; with: Record<string, string> }>;
type Workflow = Readonly<{
  jobs: Readonly<{ videos: Readonly<{ steps: ReadonlyArray<Step> }> }>;
  permissions: Record<string, string>;
}>;

test("on GitHub, init writes the workflow at the repository's root: the spec from there, how the app starts and where it answers, GitHub's token and no runner token", () => {
  const { app, root } = repository("git@github.com:acme/app.git", {
    "app/package.json": JSON.stringify({ scripts: { dev: "vite" } }),
    "pnpm-lock.yaml": "",
  });
  const done = init({
    agent: null,
    baseURL: "http://localhost:5173",
    commit: false,
    dir: app,
    service: null,
  });
  const file = path.join(root, WORKFLOW);
  assert.deepEqual(done.workflow, { file: done.workflow?.file, made: true });
  assert.equal(readFileSync(done.workflow!.file, "utf8"), readFileSync(file, "utf8"));
  assert.ok(done.created.includes(done.workflow!.file));
  const text = readFileSync(file, "utf8");
  const workflow = parse(text) as Workflow;
  assert.deepEqual(workflow.permissions, {
    contents: "read",
    deployments: "read",
    "id-token": "write",
    "pull-requests": "read",
  });
  const [step] = workflow.jobs.videos.steps;
  // The Action at this pom's own number, never a moving tag: they're released together.
  assert.equal(step?.uses, `pomspec/pom/action@v${VERSION}`);
  assert.match(step?.uses ?? "", /@v\d+\.\d+\.\d+$/);
  // pomspec.com, the Action's default, goes unsaid.
  assert.deepEqual(step?.with, {
    "ready-url": "http://localhost:5173",
    spec: "app/spec",
    start: "pnpm dev",
  });
  assert.doesNotMatch(text, /runner-token|POMSPEC_RUNNER_TOKEN/);
  // The config says the same, its webServer shown to add.
  assert.match(
    readFileSync(done.config, "utf8"),
    /\/\/ webServer: \{ command: "pnpm dev", url: "http:\/\/localhost:5173" \}/,
  );
  // What's next: commit what it wrote, connect GitHub, open a pull request.
  assert.deepEqual(done.next, [
    "What's next:",
    "  1. Commit pom.config.mts, spec/ and ../.github/workflows/pomspec.yml, and push them.",
    "  2. Connect GitHub in pomspec, one button: https://pomspec.com/settings/github",
    "  3. Open a pull request: pom's Action records its journeys, and pomspec comments with the videos.",
  ]);

  // Run again (for its agent, say), it leaves the workflow and still says to commit it.
  const again = init({ agent: null, baseURL: null, commit: false, dir: app, service: null });
  assert.deepEqual(again.workflow, { file: done.workflow?.file, made: false });
  assert.equal(readFileSync(file, "utf8"), text);
  assert.deepEqual(again.notes, [
    "../.github/workflows/pomspec.yml is there already: pom left it as it is.",
  ]);
  assert.equal(
    again.next[1],
    "  1. Commit pom.config.mts, spec/ and ../.github/workflows/pomspec.yml, and push them.",
  );
  rmSync(root, { force: true, recursive: true });
});

test("init's workflow names pomspec where POM_SERVICE_URL said, and where the app answers only as it was told: what it doesn't know is left to fill in", () => {
  // A dev script, but no address: the config's localhost:3000 is a guess, and so the
  // workflow neither starts the app nor waits on it.
  const { app, root } = repository("https://github.com/acme/app.git", {
    "app/package.json": JSON.stringify({ scripts: { dev: "vite" } }),
  });
  const done = init({
    agent: null,
    baseURL: null,
    commit: false,
    dir: app,
    service: "http://localhost:8806/",
  });
  const text = readFileSync(path.join(root, WORKFLOW), "utf8");
  const [step] = (parse(text) as Workflow).jobs.videos.steps;
  assert.deepEqual(step?.with, { "service-url": "http://localhost:8806/", spec: "app/spec" });
  assert.match(text, /^ {10}# start: npm run dev {2}# uncomment, with the command that starts/m);
  assert.match(text, /^ {10}# ready-url: http:\/\/localhost:3000 {2}# uncomment, with where/m);
  assert.deepEqual(done.next, [
    "What's next:",
    "  1. In ../.github/workflows/pomspec.yml, fill in start and ready-url: how your app starts, and where it answers then.",
    "  2. Commit pom.config.mts, spec/ and ../.github/workflows/pomspec.yml, and push them.",
    "  3. Connect GitHub in pomspec, one button: http://localhost:8806/settings/github",
    "  4. Open a pull request: pom's Action records its journeys, and pomspec comments with the videos.",
  ]);
  rmSync(path.join(root, WORKFLOW));

  // The address, and no dev script: where it answers, and how it starts left to the person.
  writeFileSync(path.join(app, "package.json"), "{}");
  const told = init({
    agent: null,
    baseURL: "http://localhost:5173",
    commit: false,
    dir: app,
    service: null,
  });
  const [answers] = (parse(readFileSync(path.join(root, WORKFLOW), "utf8")) as Workflow).jobs.videos
    .steps;
  assert.deepEqual(answers?.with, { "ready-url": "http://localhost:5173", spec: "app/spec" });
  assert.equal(
    told.next[1],
    "  1. In ../.github/workflows/pomspec.yml, fill in start: the command that starts your app.",
  );
  rmSync(root, { force: true, recursive: true });
});

test("init never overwrites a workflow that's there: it says so and leaves it", () => {
  const { app, root } = repository(null, { ".github/workflows/pomspec.yml": "name: mine\n" });
  const done = init({ agent: null, baseURL: null, commit: false, dir: app, service: null });
  assert.equal(readFileSync(path.join(root, WORKFLOW), "utf8"), "name: mine\n");
  assert.deepEqual(done.workflow, { file: done.workflow?.file, made: false });
  assert.ok(!done.created.some((file) => file.endsWith("pomspec.yml")));
  assert.deepEqual(done.notes, [
    "../.github/workflows/pomspec.yml is there already: pom left it as it is.",
  ]);
  // Still on GitHub (its .github folder): commit it, connect GitHub, open a pull request.
  assert.match(done.next.join("\n"), /Connect GitHub in pomspec/);
  assert.equal(
    done.next[1],
    "  1. Commit pom.config.mts, spec/ and ../.github/workflows/pomspec.yml, and push them.",
  );
  // One git tracks is the person's already: not theirs to commit again.
  execFileSync("git", ["add", WORKFLOW], { cwd: root });
  const added = init({ agent: null, baseURL: null, commit: false, dir: app, service: null });
  assert.equal(added.next[1], "  1. Commit pom.config.mts and spec/, and push them.");
  rmSync(root, { force: true, recursive: true });
});

test("off GitHub, init writes no workflow and says how to add it later, with the app's address it was given", () => {
  for (const [remote, baseURL, address] of [
    ["https://gitlab.com/acme/app.git", "http://localhost:5173", "http://localhost:5173"],
    [null, null, "<your app's address>"],
  ] as const) {
    const { app, root } = repository(remote);
    const done = init({ agent: null, baseURL, commit: false, dir: app, service: null });
    assert.equal(done.workflow, null);
    assert.equal(existsSync(path.join(root, ".github")), false);
    assert.deepEqual(done.next, [
      "What's next:",
      "  1. Commit pom.config.mts and spec/.",
      "  2. With your app running, record your journeys (npx pomspec videos) and send them to pomspec with a runner token from Settings → Runners (npx pomspec upload).",
      `Once the repository is on GitHub, npx pomspec init ${address} --agent none adds the workflow that records every pull request (.github/workflows/pomspec.yml).`,
    ]);
    rmSync(root, { force: true, recursive: true });
  }
});
