import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkSpec } from "./check.ts";
import { checkpoints, manifest, plan, type Seen, stable, structure } from "./moments.ts";
import { readSpec } from "./spec.ts";

function spec(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "pom-moments-"));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text.replace(/^\n/, ""));
  }
  return root;
}

const SIGN_UP = {
  "sign-up/page.tree.yml": '- textbox "Name"\n- textbox "Email"\n- button "Create account"\n',
  "new/page.tree.yml": '- textbox "Name"\n- button "Continue"\n',
  "sign-up/sign-up.feature": `
Feature: Sign up
  Scenario: Sign up
    # Create an account
    Given I am on "/sign-up"
    When I fill "Name" with "Ana"
    And I fill "Email" with "ana@example.com"
    And I press the "Create account" button
    # Name the organization
    Then I am on "/new"
    When I fill "Name" with "Acme"
    And I press the "Continue" button
`,
};

test("a journey's moments: its start, then after each acting line, named by the line", () => {
  const read = readSpec(spec(SIGN_UP));
  const { compiled, problems } = checkSpec(read);
  assert.deepEqual(problems, []);
  const moments = plan(compiled[0]!, "sign-up/sign-up");
  assert.deepEqual(
    moments.map((m) => [
      m.id,
      m.step,
      m.index,
      m.page,
      m.next?.verb ?? null,
      m.before?.line.line ?? null,
    ]),
    [
      ["start", 0, -1, "/sign-up", "fill", 5],
      ["fill-name", 0, 1, "/sign-up", "fill", 6],
      ["fill-email", 0, 2, "/sign-up", "press", 7],
      // The screen after "Create account" is /new's, once "Then I am on" has seen it.
      ["press-create-account", 0, 3, "/new", "fill", 10],
      ["fill-name-2", 1, 1, "/new", "press", 11],
      ["press-continue", 1, 2, "/new", null, null],
    ],
  );
  assert.equal(moments[0]!.target, "signUpPage.name");
  assert.equal(moments.at(-1)!.target, null);
});

test("a checkpoint is the start, the end, and a moment whose structure changed at any width", () => {
  const page = (...lines: Array<string>) => lines.join("\n");
  const flags = checkpoints([
    { desktop: page('- textbox "Name"', '- button "Save"'), phone: page('- textbox "Name"') },
    // Typing is no checkpoint.
    {
      desktop: page('- textbox "Name": Ana', '- button "Save"'),
      phone: page('- textbox "Name": Ana'),
    },
    // A control that became disabled is no checkpoint either.
    {
      desktop: page('- textbox "Name": Ana', '- button "Save" [disabled]'),
      phone: page('- textbox "Name": Ana'),
    },
    // A dialog that opened at one width is.
    {
      desktop: page('- textbox "Name": Ana', '- button "Save"'),
      phone: page('- textbox "Name": Ana', '- dialog "Saved":', '  - button "Close"'),
    },
    {
      desktop: page('- textbox "Name": Ana', '- button "Save"'),
      phone: page('- textbox "Name": Ana'),
    },
  ]);
  assert.deepEqual(
    flags.map((f) => f.checkpoint),
    [true, false, false, true, true],
  );
  assert.deepEqual(flags[3]!.added, ['- dialog "Saved"']);
});

test("a heading's level is structure; a field's value is not", () => {
  assert.deepEqual(structure('- heading "Plans" [level=2]\n- textbox "Email": ana@x.co'), [
    '- heading "Plans" [level=2]',
    '- textbox "Email"',
  ]);
});

test("a manifest is the same bytes for the same journey, whatever order its keys came in", () => {
  const seen = (id: string, structure: string): Seen => ({
    after: null,
    box: [1, 2, 3, 4],
    id,
    index: -1,
    journey: "j",
    next: null,
    page: "/",
    role: "visitor",
    state: null,
    step: 0,
    structure,
    width: "desktop",
  });
  const make = (frames: boolean) =>
    stable(
      manifest({
        frames,
        journey: "j",
        renderer: { platform: "darwin", playwright: "1.63.0" },
        seen: { desktop: [seen("start", "- a"), seen("press-b", "- a"), seen("press-c", "- a")] },
        sha256: (width, id) => `${width}:${id}`,
        steps: ["Go"],
        taken: { commit: null, dirty: true, source: "abc" },
        title: "J",
        widths: { desktop: { height: 900, width: 1280 } },
      }),
    );
  assert.equal(make(false), make(false));
  const committed = JSON.parse(make(false));
  // Only checkpoints carry pictures where a repository keeps them; every moment in pom's own store.
  assert.deepEqual(
    committed.moments.map((m: { id: string; pictures?: unknown }) => [m.id, Boolean(m.pictures)]),
    [
      ["start", true],
      ["press-b", false],
      ["press-c", true],
    ],
  );
  assert.ok(JSON.parse(make(true)).moments.every((m: { pictures?: unknown }) => m.pictures));
});
