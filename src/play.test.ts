import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PNG } from "pngjs";
import { resolveConfig } from "./config.ts";
import { verdictOf } from "./video.ts";
import { generate } from "./generate.ts";
import { compareSides, keptIn, runOf, videos } from "./play.ts";
import { masked } from "./reel.ts";
import { DOTS, listedIn, masker, maskAll, secretName, secretsIn } from "./secrets.ts";
import { readSpec } from "./spec.ts";

const folder = (files: Record<string, string>) => {
  const root = mkdtempSync(path.join(tmpdir(), "pom-videos-"));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text.replace(/^\n/, ""));
  }
  return root;
};

test("a secret is a variable named like one, or one the config lists, and shows as dots", () => {
  assert.ok(secretName("POM_OWNER_PASSWORD"));
  assert.ok(secretName("API_TOKEN"));
  assert.ok(secretName("client_secret"));
  assert.ok(secretName("PASSWORD"));
  assert.ok(!secretName("POM_OWNER_EMAIL"));
  assert.ok(!secretName("TOKENS_USED"));
  assert.ok(secretName("STRIPE_KEY", ["STRIPE_KEY"]));
  const env = {
    DATABASE_PASSWORD: "password",
    POM_OWNER_EMAIL: "ana@example.com",
    POM_OWNER_PASSWORD: "hunter2-hunter2",
    POM_SECRETS: "STRIPE_KEY, PIN",
    PIN: "42",
    STRIPE_KEY: "sk_test_abc123",
  };
  assert.deepEqual(listedIn(env), ["STRIPE_KEY", "PIN"]);
  assert.deepEqual(secretsIn(env), [
    { sought: true, value: "hunter2-hunter2" },
    { sought: true, value: "sk_test_abc123" },
    { sought: false, value: "password" },
    { sought: true, value: "42" },
  ]);
  const { isSecret, mask } = masker(secretsIn(env));
  assert.equal(
    mask('When I fill "Password" with "hunter2-hunter2"'),
    `When I fill "Password" with "${DOTS}"`,
  );
  // Too short to look for inside other text, but quoted or typed whole, still a secret.
  assert.equal(mask("Room 42"), "Room 42");
  assert.equal(mask('When I fill "PIN" with "42"'), `When I fill "PIN" with "${DOTS}"`);
  assert.equal(mask("Type “42”"), `Type “${DOTS}”`);
  assert.ok(isSecret("42"));
  assert.ok(!isSecret("ana@example.com"));
  // A CI job's database password is an ordinary word inside other text: dots only whole.
  assert.equal(mask('When I fill "New password" with "x"'), 'When I fill "New password" with "x"');
  assert.equal(mask("Change your password"), "Change your password");
  assert.equal(mask('When I fill "Note" with "password"'), `When I fill "Note" with "${DOTS}"`);
  // A listed or pom's own, long enough, is looked for anywhere.
  assert.equal(mask("Bearer sk_test_abc123 refused"), `Bearer ${DOTS} refused`);
  assert.deepEqual(maskAll({ lines: [{ start: 1, text: "sk_test_abc123" }], title: "Pay" }, mask), {
    lines: [{ start: 1, text: DOTS }],
    title: "Pay",
  });
});

test("a video's words are masked, never the file, route and slug that address its journey", () => {
  const { mask } = masker(secretsIn({ POM_SECRETS: "SETTING", SETTING: "settings/password" }));
  const recorded = {
    badges: [{ end: 1, start: 0, text: "settings/password", tone: "fail" as const }],
    chapters: [
      { picture: "01-end-of-settings-password.png", start: 0, title: "settings/password" },
    ],
    checks: [{ at: 1, picture: null, text: 'I see "settings/password"', verdict: "found" }],
    duration: 1,
    journey: {
      file: "spec/settings/password/change.feature",
      route: "/settings/password",
      slug: "change",
      title: "Open settings/password",
    },
    lines: [{ chapter: "", end: 1, start: 0, step: 3, text: "Open settings/password" }],
    mode: "reference",
    passed: true,
    pointer: [],
    rings: [],
    ripples: [],
    seconds: 1,
    size: { height: 720, width: 1280 },
  };
  const written = masked(recorded, mask);
  assert.deepEqual(written.journey, {
    file: "spec/settings/password/change.feature",
    route: "/settings/password",
    slug: "change",
    title: `Open ${DOTS}`,
  });
  assert.equal(written.chapters[0]!.picture, "01-end-of-settings-password.png");
  assert.equal(written.chapters[0]!.title, DOTS);
  assert.equal(written.lines[0]!.text, `Open ${DOTS}`);
  assert.equal(written.checks[0]!.text, `I see "${DOTS}"`);
  assert.equal(written.badges[0]!.text, DOTS);
});

test("a generated test tells the reel each line, what it is about, and ends its video after it", () => {
  const root = folder({
    "notes/page.tree.yml": `
- heading "Notes" [level=1]
- textbox "Note"
- button "Add"
- list:
  - listitem: Call the plumber
`,
    "notes/new-note.dialog.tree.yml": '- dialog "New note":\n  - button "Save"\n',
    "notes/write-a-note.feature": `
Feature: Write a note
  Scenario: Write a note
    # Write it down
    Given I am on "/notes"
    When I fill "Note" with "Call the plumber"
    And I press the "Add" button
    Then I see "Call the plumber"
    And the "New note" dialog opens
`,
  });
  const out = path.join(root, "..", `${path.basename(root)}-out`);
  const { written } = generate(readSpec(root), out);
  const test = readFileSync(
    written.find((file) => file.endsWith("write-a-note.spec.ts"))!,
    "utf8",
  );
  assert.match(test, /^test\.afterEach\(finish\);$/m);
  assert.match(test, /import \{[^}]*\bfinish\b[^}]*\} from "\.\.\/\.\.\/pom\.ts";/);
  assert.match(
    test,
    /await say\(page, 'When I fill "Note" with "Call the plumber"', \{ line: 5, target: \(\) => notesPage\.note, verb: "fill" \}\);/,
  );
  assert.match(test, /line: 6, target: \(\) => notesPage\.add, verb: "press"/);
  // What a Then proves is reached as its assertion reaches it.
  assert.match(
    test,
    /line: 7, target: \(\) => notesPage\.page\.getByText\("Call the plumber"\)\.first\(\), verb: "see"/,
  );
  assert.match(test, /line: 8, target: \(\) => notesPage\.newNoteDialog\.root, verb: "opens"/);
  assert.match(test, /line: 4, target: null, verb: "go"/);
  const helpers = readFileSync(path.join(out, "pom.ts"), "utf8");
  assert.match(helpers, /export async function finish\(\{ page \}: \{ page: Page \}\)/);
  assert.match(helpers, /"reel": ".*reel\.ts"/);
});

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "pom-videos-run-"));
  const git = (...args: Array<string>) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_AUTHOR_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
      },
    }).trim();
  git("init", "-q", "-b", "main");
  mkdirSync(path.join(dir, "spec"));
  writeFileSync(path.join(dir, "spec", "x.feature"), "Feature: X\n");
  writeFileSync(path.join(dir, "app.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "Notes, at last");
  return { config: resolveConfig({}, dir, null), dir, git };
}

test("a run is its commit, and a hash of what the spec has not committed yet", () => {
  const { config, dir, git } = repo();
  const head = git("rev-parse", "HEAD");
  assert.deepEqual(runOf(config), {
    branch: "main",
    commit: head,
    dirty: false,
    run: head.slice(0, 12),
    subject: "Notes, at last",
  });
  // The app's own changes are not the spec's.
  writeFileSync(path.join(dir, "app.ts"), "export const a = 2;\n");
  assert.equal(runOf(config).run, head.slice(0, 12));
  writeFileSync(path.join(dir, "spec", "y.feature"), "Feature: Y\n");
  const dirty = runOf(config);
  assert.equal(dirty.dirty, true);
  assert.match(dirty.run, new RegExp(`^${head.slice(0, 12)}-[0-9a-f]{8}$`));
  writeFileSync(path.join(dir, "spec", "y.feature"), "Feature: Why\n");
  assert.notEqual(runOf(config).run, dirty.run);
  // A detached checkout (a pull request's head in CI) takes its branch from CI.
  git("checkout", "-q", "--detach");
  const was = process.env.GITHUB_HEAD_REF;
  process.env.GITHUB_HEAD_REF = "ana/notes";
  try {
    assert.equal(runOf(config).branch, "ana/notes");
  } finally {
    if (was === undefined) delete process.env.GITHUB_HEAD_REF;
    else process.env.GITHUB_HEAD_REF = was;
  }
});

/** A screen of one colour, as a chapter's picture. */
const screen = (shade: number) => {
  const png = new PNG({ height: 20, width: 20 });
  png.data.fill(shade);
  return PNG.sync.write(png);
};

/** A video of a run, its chapters' pictures beside it. */
function video(run: string, side: string, slug: string, shades: Array<number>, passed = true) {
  const dir = path.join(run, side, slug, "reference");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "journey.webm"), "");
  const chapters = shades.map((shade, i) => {
    const picture = `0${i + 1}-end-of-${i}.png`;
    writeFileSync(path.join(dir, picture), screen(shade));
    return { picture, start: i * 2, title: `Chapter ${i}` };
  });
  const made = {
    badges: [],
    chapters,
    checks: [{ at: 1, picture: null, text: 'I see "Notes"', verdict: "found" }],
    duration: shades.length * 2,
    journey: { file: `spec/${slug}.feature`, route: "/", slug, title: slug },
    lines: [],
    mode: "reference",
    passed,
    pointer: [],
    rings: [],
    ripples: [],
    seconds: shades.length * 2,
    size: { height: 20, width: 20 },
  };
  writeFileSync(path.join(dir, "video.json"), JSON.stringify(made));
}

test("the base's screens are held to the head's: one that looks different makes the journey changed", () => {
  const run = mkdtempSync(path.join(tmpdir(), "pom-videos-sides-"));
  video(run, "head", "same", [255, 255]);
  video(run, "base", "same", [255, 255]);
  video(run, "head", "moved", [255, 255]);
  video(run, "base", "moved", [255, 0]);
  // A journey new in the pull request, which stops on the base, is not compared.
  video(run, "head", "new", [255]);
  video(run, "base", "new", [0], false);
  const threshold = { pixel: 0.1, ratio: 0.001 };
  assert.equal(compareSides(keptIn(run), threshold), 1);
  // Compared again, it notes it once.
  assert.equal(compareSides(keptIn(run), threshold), 1);
  const verdicts = Object.fromEntries(
    ["same", "moved", "new"].map((slug) => [
      slug,
      verdictOf(
        keptIn(run)
          .filter((k) => k.video.journey.slug === slug)
          .map((k) => ({ video: k.video, mode: "reference", target: k.side })),
        true,
      ).kind,
    ]),
  );
  assert.deepEqual(verdicts, { moved: "changed", new: "new", same: "same" });
  const moved = keptIn(run).find((k) => k.side === "base" && k.video.journey.slug === "moved")!;
  assert.deepEqual(
    moved.video.checks.map((c) => [c.verdict, c.picture]),
    [
      ["found", null],
      ["differs", "02-end-of-1.png"],
    ],
  );
});

test("pom videos says how it is used, and refuses what it does not know", async () => {
  const said: Array<string> = [];
  const log = console.log;
  const error = console.error;
  console.log = (text: string) => said.push(text);
  console.error = (text: string) => said.push(text);
  try {
    assert.equal(await videos(["--help"]), 0);
    assert.match(said.join("\n"), /^pom videos \[spec\]/);
    assert.equal(await videos(["--nope"]), 2);
    assert.match(said.at(-1)!, /Unknown option '--nope'/);
  } finally {
    console.log = log;
    console.error = error;
  }
});
