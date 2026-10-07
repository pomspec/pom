import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkSpec } from "./check.ts";
import { generate } from "./generate.ts";
import { specIndex } from "./indexer.ts";
import { layoutModel, pageModel } from "./objects.ts";
import { pageAt, readSpec } from "./spec.ts";

/** A spec folder from `{ "path/file": "contents" }`. */
function spec(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "pom-"));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text.replace(/^\n/, ""));
  }
  return root;
}

const NOTES = {
  "(site)/layout.tree.yml": `
- banner:
  - navigation:
    - link "Pricing"
- contentinfo:
  - navigation:
    - link "Pricing"
`,
  "(site)/notes/page.tree.yml": `
- heading "Notes" [level=1]
- button "Add a note"
- region "All notes"
`,
  "(site)/notes/new-note.dialog.tree.yml": `
- dialog "New note":
  - textbox "Note"
  - button "Save"
`,
  "(site)/notes/write-a-note.feature": `
Feature: Write a note
  Scenario: Write a note
    # Write it down
    Given I am on "/notes"
    When I press the "Add a note" button
    Then the "New note" dialog opens
    When I fill "Note" with "Call the plumber"
    And I press the "Save" button
    Then "All notes" shows "Call the plumber"
`,
  "(site)/notes/[id]/delete.dialog.tree.yml": `
- dialog "Delete this note?":
  - button "Delete"
`,
  "(site)/notes/[id]/page.tree.yml": `
- heading "A note" [level=1]
`,
  "(site)/notes/new/page.tree.yml": `
- heading "New" [level=1]
`,
};

test("every line finds its control: a dialog first, then the page, then its layouts", () => {
  const { compiled, problems } = checkSpec(readSpec(spec(NOTES)));
  assert.deepEqual(problems, []);
  assert.deepEqual(
    compiled[0]!.steps[0]!.calls.map((call) => call.code),
    [
      "await notesPage.goto()",
      "await notesPage.addANote.click()",
      "await notesPage.newNoteDialog.expectOpen()",
      'await notesPage.newNoteDialog.note.fill("Call the plumber")',
      "await notesPage.newNoteDialog.save.click()",
      'await expect(notesPage.allNotes).toContainText("Call the plumber")',
    ],
  );
});

test("a name no tree holds is refused at its line", () => {
  const root = spec({
    ...NOTES,
    "(site)/notes/write-a-note.feature": NOTES["(site)/notes/write-a-note.feature"].replace(
      '"Add a note" button',
      '"Add note" button',
    ),
  });
  const { problems } = checkSpec(readSpec(root));
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.line, 5);
  assert.match(problems[0]!.message, /no button "Add note" on \/notes/);
});

test("a journey sees only what its page's tree holds", () => {
  const root = spec({
    ...NOTES,
    "(site)/notes/look.feature": `
Feature: Look
  Scenario: Look
    # Look
    Given I am on "/notes"
    Then I see "Invoices"
`,
  });
  const { problems } = checkSpec(readSpec(root));
  assert.match(problems[0]!.message, /"Invoices" is in no tree on \/notes/);
});

test("a line outside the grammar, or under the wrong keyword, is refused", () => {
  assert.throws(
    () =>
      readSpec(
        spec({
          ...NOTES,
          "x.feature": "Feature: X\n  Scenario: X\n    # Go\n    When I click Save\n",
        }),
      ),
    /x\.feature:4: not in the grammar: When I click Save/,
  );
  assert.throws(
    () =>
      readSpec(
        spec({
          ...NOTES,
          "x.feature": 'Feature: X\n  Scenario: X\n    # Go\n    Then I press the "Save" button\n',
        }),
      ),
    /x\.feature:4: "I press the "Save" button" is a When line, not Then/,
  );
});

test("two controls with one name are told apart by where they are", () => {
  const read = readSpec(spec(NOTES));
  const notes = read.pages.find((page) => page.route === "/notes")!;
  assert.deepEqual(
    layoutModel(notes.layouts[0]!).controls.map((c) => [c.property, c.locator]),
    [
      [
        "headerPricing",
        'page.getByRole("banner").getByRole("navigation").getByRole("link", { name: "Pricing", exact: true })',
      ],
      [
        "footerPricing",
        'page.getByRole("contentinfo").getByRole("navigation").getByRole("link", { name: "Pricing", exact: true })',
      ],
    ],
  );
  assert.deepEqual(
    pageModel(notes).controls.map((c) => c.property),
    ["notes", "addANote", "allNotes"],
  );
});

test("routes read as Next.js reads app/: groups are no segment, a static one outranks [dynamic]", () => {
  const read = readSpec(spec(NOTES));
  assert.deepEqual(
    read.pages.map((page) => page.route),
    ["/notes", "/notes/[id]", "/notes/new"],
  );
  assert.equal(pageAt(read, "/notes/new")!.page.route, "/notes/new");
  assert.deepEqual(pageAt(read, "/notes/42?tab=1"), {
    page: read.pages[1],
    params: { id: "42" },
  });
  assert.equal(pageAt(read, "/elsewhere"), null);
});

test("the generated test names each line of the spec as a step", () => {
  const root = spec(NOTES);
  const out = path.join(root, "..", `${path.basename(root)}-out`);
  const { written } = generate(readSpec(root), out);
  const test = readFileSync(
    written.find((file) => file.endsWith("write-a-note.spec.ts"))!,
    "utf8",
  );
  assert.match(test, /await test\.step\("Write it down", async \(\) => \{/);
  assert.match(
    test,
    /await test\.step\('When I fill "Note" with "Call the plumber"', async \(\) => \{\n\s+await notesPage\.newNoteDialog\.note\.fill\("Call the plumber"\);/,
  );
  const page = readFileSync(path.join(out, "pages", "NotesIdPage.ts"), "utf8");
  // A dialog is named for its page, so two pages' "delete" dialogs are two files.
  assert.match(page, /import \{ NotesIdDeleteDialog \} from "\.\/NotesIdDeleteDialog\.ts";/);
  assert.match(
    page,
    /async goto\(params: \{ "id": string \}\) \{\n\s+await this\.page\.goto\(`\/notes\/\$\{params\["id"\]\}`\);/,
  );
});

test("a path with a page per role is the acting role's; signing in plays the journey that makes one", () => {
  const root = spec({
    "(visitor)/page.tree.yml": '- heading "Welcome" [level=1]\n',
    "(visitor)/sign-up/page.tree.yml": '- button "Create account"\n',
    "(visitor)/sign-up/sign-up.feature": `
Feature: Sign up
  Scenario: Sign up
    # Join
    Given I am on "/sign-up"
    When I press the "Create account" button
    # Arrive
    # as owner
    Then I am on "/"
`,
    "(app)/page.tree.yml": "- paragraph: No journeys yet\n",
    "(app)/layout.tree.yml": '- banner:\n  - button "Sign out"\n',
    "(app)/layout.desktop.tree.yml": '- complementary:\n  - link "Home"\n',
    "(app)/sign-out.feature": `
Feature: Sign out
  Background:
    Given I am signed in as the "owner"
  Scenario: Sign out
    # Leave
    Given I am on "/"
    When I press the "Sign out" button
    # Gone
    # as visitor
    Then I am on "/"
    And I see "Welcome"
`,
  });
  const read = readSpec(root);
  assert.deepEqual(read.pages.map((page) => page.className).sort(), [
    "AppHomePage",
    "SignUpPage",
    "VisitorHomePage",
  ]);
  assert.equal(pageAt(read, "/")!.page.className, "VisitorHomePage");
  assert.equal(pageAt(read, "/", "owner")!.page.className, "AppHomePage");
  const { compiled, problems } = checkSpec(read);
  assert.deepEqual(problems, []);
  const signOut = compiled.find((c) => c.journey.title === "Sign out")!;
  assert.deepEqual(
    [...signOut.background, ...signOut.steps.flatMap((s) => s.calls)].map((c) => c.code),
    [
      "await signUp(page)",
      "await appHomePage.goto()",
      "await appHomePage.appLayout.signOut.click()",
      "await visitorHomePage.expectLoaded()",
      'await expect(visitorHomePage.page.getByText("Welcome").first()).toBeVisible()',
    ],
  );
  // A control only one width shows is still a control, checked at that width.
  const app = read.pages.find((page) => page.className === "AppHomePage")!;
  assert.deepEqual(
    layoutModel(app.layouts[0]!).controls.map((c) => c.property),
    ["signOut", "home"],
  );
});

test("signing in as a role no journey makes is refused", () => {
  const root = spec({
    "page.tree.yml": '- heading "Home" [level=1]\n',
    "x.feature":
      'Feature: X\n  Background:\n    Given I am signed in as the "admin"\n  Scenario: X\n    # Look\n    Given I am on "/"\n',
  });
  const { problems } = checkSpec(readSpec(root));
  assert.match(problems[0]!.message, /no journey makes a visitor the "admin"/);
});

test("the index gives each line its page and the moment whose picture follows it", () => {
  const root = spec(NOTES);
  const index = specIndex(readSpec(root));
  const journey = index.journeys[0]!;
  assert.equal(journey.id, "(site)/notes/write-a-note");
  assert.equal(journey.manifest, null);
  assert.deepEqual(
    journey.steps[0]!.lines.map((line) => [line.moment, line.page]),
    [
      ["start", "/notes"],
      ["press-add-a-note", "/notes"],
      ["press-add-a-note", "/notes"],
      ["fill-note", "/notes"],
      ["press-save", "/notes"],
      ["press-save", "/notes"],
    ],
  );
  const notes = index.pages.find((page) => page.route === "/notes")!;
  assert.deepEqual(notes.journeys, ["(site)/notes/write-a-note"]);
  assert.equal(notes.dialogs[0]!.name, "New note");
  assert.equal(notes.layouts[0]!.dir, "(site)");
});

test("a list's option is selected, a box checked or unchecked, a key pressed, a menu opened", () => {
  const root = spec({
    "settings/page.tree.yml": `
- combobox "Billing period"
- checkbox "Send receipts"
- button "Account"
`,
    "settings/account.menu.tree.yml": `
- menu "Account":
  - menuitem "Sign out"
`,
    "settings/change.feature": `
Feature: Change
  Scenario: Change
    # Change
    Given I am on "/settings"
    When I select "Monthly" in "Billing period"
    And I check "Send receipts"
    And I uncheck "Send receipts"
    And I press the "Escape" key
    And I press the "Account" button
    Then the "Account" menu opens
    When I press the "Sign out" menuitem
`,
  });
  const { compiled, problems } = checkSpec(readSpec(root));
  assert.deepEqual(problems, []);
  assert.deepEqual(
    compiled[0]!.steps[0]!.calls.map((call) => call.code),
    [
      "await settingsPage.goto()",
      'await settingsPage.billingPeriod.selectOption("Monthly")',
      "await settingsPage.sendReceipts.check()",
      "await settingsPage.sendReceipts.uncheck()",
      'await settingsPage.page.keyboard.press("Escape")',
      "await settingsPage.account.click()",
      "await settingsPage.accountMenu.expectOpen()",
      "await settingsPage.accountMenu.signOut.click()",
    ],
  );
});

test("config: defaults keep today's run; a width's name is a word; video names a width there is", async () => {
  const { resolveConfig } = await import("./config.ts");
  const config = resolveConfig({}, "/app", null);
  assert.deepEqual(Object.keys(config.widths), ["desktop", "phone"]);
  assert.equal(config.renderer, "host");
  assert.equal(config.commit, false);
  assert.deepEqual(config.video, { maxMB: 100, widths: ["desktop"] });
  assert.deepEqual(config.mask, ["[data-pom-mask]"]);
  assert.throws(() => resolveConfig({ widths: { Desktop: {} } }, "/app", null), /lowercase/);
  assert.throws(() => resolveConfig({ video: { widths: ["tv"] } }, "/app", null), /tv/);
});

test("a page's variations: a line sees its page as who acts and in its state; the test says which", () => {
  const root = spec({
    "page.tree.yml": '- heading "Acme" [level=1]\n',
    "page.visitor.tree.yml": '- link "Sign in"\n',
    "page.owner.tree.yml": '- button "Account"\n',
    "page.empty.tree.yml": "- paragraph: No projects yet\n",
    "home.feature": `
Feature: Home
  Scenario: Home
    # Look
    # as owner
    # when empty
    Given I am on "/"
    When I press the "Account" button
    Then I see "No projects yet"
`,
    "wrong.feature": `
Feature: Wrong
  Scenario: Wrong
    # Look
    Given I am on "/"
    When I press the "Account" button
`,
  });
  const read = readSpec(root);
  assert.deepEqual([...read.states], ["empty"]);
  const { problems } = checkSpec(read);
  // The visitor's variation shows no "Account": only the owner's does.
  assert.equal(problems.length, 1);
  assert.match(problems[0]!.file, /wrong\.feature/);
  assert.match(problems[0]!.message, /no button "Account" on \//);

  // Without the wrong journey, the moments say which variation they are in; the page
  // holds every variation's controls, and asserts no tree as a whole.
  rmSync(path.join(root, "wrong.feature"));
  const out = path.join(root, "..", `${path.basename(root)}-out`);
  const { written } = generate(readSpec(root), out);
  const test = readFileSync(
    written.find((file) => file.endsWith("home.spec.ts"))!,
    "utf8",
  );
  assert.match(test, /"role":"owner","state":"empty"/);
  const page = readFileSync(path.join(out, "pages", "HomePage.ts"), "utf8");
  assert.match(page, /readonly account: Locator;/);
  assert.doesNotMatch(page, /toMatchAriaSnapshot/);
});

test("a variation file names a width, a role or a state the spec has", () => {
  assert.throws(
    () =>
      readSpec(
        spec({
          "page.tree.yml": '- heading "A" [level=1]\n',
          "page.admin.tree.yml": '- button "X"\n',
        }),
      ),
    /"admin" is no width, role or state of this spec/,
  );
});
