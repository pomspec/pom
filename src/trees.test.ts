import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkSpec } from "./check.ts";
import { resolveConfig } from "./config.ts";
import { crawlTest, excluded, inventory, pictureName, routeOf } from "./map.ts";
import { prune, readOutline, writeOutline } from "./outline.ts";
import { GENERATED, pageAt, readSpec } from "./spec.ts";
import { readTree } from "./tree.ts";
import { split, writePage } from "./trees.ts";

const OUTLINE = `- banner:
  - link "Acme"
  - navigation "Main":
    - link "Pricing":
      - /url: /pricing
- main:
  - heading "Write it down" [level=1]
  - region "New note":
    - paragraph:
      - textbox "Title": Call ana+k3x9z1@example.com
    - button "Save" [disabled]
- contentinfo:
  - link "Pricing"`;

test("a pruned tree keeps every role above what it keeps, drops states and urls, and makes run marks patterns", () => {
  const kept = prune(
    readOutline(OUTLINE),
    (node) =>
      (node.role === "textbox" && node.name === "Title") ||
      (node.role === "button" && node.name === "Save"),
  );
  assert.equal(
    writeOutline(kept),
    [
      "- main:",
      '  - region "New note":',
      "    - paragraph:",
      '      - textbox "Title": /Call [^@\\s]+@[^\\s]+/',
      '    - button "Save"',
    ].join("\n"),
  );
});

test("a page's inventory: landmarks, headings, controls, and links in navigation", () => {
  const text = writeOutline(inventory(readOutline(OUTLINE)));
  assert.match(text, /heading "Write it down" \[level=1\]/);
  assert.match(text, /navigation "Main":\n\s+- link "Pricing"/);
  // A link outside navigation is not inventory.
  assert.doesNotMatch(text, /contentinfo/);
});

test("a path that differs by an id is one route; signing out is never followed", () => {
  assert.equal(routeOf("/projects/42/runs/7f3a9c21"), "/projects/[id]/runs/[id2]");
  assert.equal(routeOf("/settings/billing"), "/settings/billing");
  assert.equal(routeOf("/acme-launch-2026q3"), "/[id]");
  assert.equal(excluded("/sign-out", ["/sign-out"]), true);
  assert.equal(excluded("/sign-outs", ["/sign-out"]), false);
});

test("a page whose address ends like a journey is a route no journey collides with, and a journey is a file", () => {
  // A video's page: its address ends in its journey's file.
  const at = "/acme/blob/main/spec/say-hello.feature";
  assert.equal(routeOf(at), "/acme/blob/main/spec/[file]");
  // Nor a journey's pictures, a hidden folder or a group: none is a folder of its own.
  assert.equal(routeOf("/x/a.shots/.well-known/(b)"), "/x/[file]/[file2]/[file3]");
  // Nor a tree's: its folder would be read as the tree.
  for (const name of [
    "page.tree.yml",
    "layout.tree.yml",
    "x.dialog.tree.yml",
    "x.menu.tree.yml",
    "page.desktop.tree.yml",
  ])
    assert.equal(routeOf(`/a/${name}`), "/a/[file]");
  const root = mkdtempSync(path.join(tmpdir(), "pom-routes-"));
  const tree = inventory(readOutline('- main:\n  - heading "Say hello" [level=1]'), true);
  const page = (at: string) =>
    writePage(path.join(root, ...at.split("/").filter(Boolean)), [
      { combo: { role: "visitor", state: null, width: "desktop" }, tree },
    ]);
  page(routeOf(at));
  // A folder named like a journey or a tree, written by hand or by an older pom, is a
  // path segment, beside the trees of the page it is in (written last, among them).
  for (const old of [
    "/old/say-hello.feature",
    "/older/page.tree.yml",
    "/old/page.desktop.tree.yml",
    "/old",
  ])
    page(old);
  writeFileSync(
    path.join(root, "look.feature"),
    'Feature: Look\n  Scenario: Look\n    # Look\n    Given I am on "/old/say-hello.feature"\n',
  );
  const read = readSpec(root, ["desktop"]);
  assert.deepEqual(
    read.journeys.map((journey) => journey.title),
    ["Look"],
  );
  assert.equal(pageAt(read, at)!.page.route, "/acme/blob/main/spec/[file]");
  assert.deepEqual(pageAt(read, at)!.params, { file: "say-hello.feature" });
  for (const old of [
    "/old/say-hello.feature",
    "/older/page.tree.yml",
    "/old/page.desktop.tree.yml",
  ])
    assert.equal(pageAt(read, old)!.page.route, old);
  // `/old`'s own trees: the folders beside them are none of its variations.
  assert.deepEqual(Object.keys(pageAt(read, "/old")!.page.variations), []);
  assert.deepEqual(checkSpec(read).problems, []);
});

test('a name holding what YAML reads otherwise (": ", " #") is quoted, and reads back as itself', () => {
  const names = ["Chapters: Say hello", "Issue #4", `It's "here": now`, "Next:", "Save"];
  const node = (role: string, name: string | null, text: string | null = null) => ({
    children: [],
    key: name === null ? role : `${role} ${JSON.stringify(name)}`,
    name,
    role,
    text,
  });
  const written = writeOutline([
    {
      ...node("main", null),
      children: [
        ...names.map((name) => node("button", name, "x")),
        node("text", null, "Invited: ana+k3x9z1@example.com"),
      ],
    },
  ]);
  // Quoted as Playwright quotes it, where YAML needs it; plain where it does not.
  assert.match(written, /^ {2}- 'button "Chapters: Say hello"': "x"$/m);
  assert.match(written, /^ {2}- button "Save": "x"$/m);
  // pom's reader, as \`pom check\` reads the tree, and the outline's: every name as it was.
  const tree = readTree(written, "page.tree.yml")[0]!.children;
  assert.deepEqual(
    tree.flatMap((one) => (one.role === "button" ? [one.name] : [])),
    names,
  );
  assert.deepEqual(
    readOutline(written)[0]!.children.map((one) => one.name),
    [...names, null],
  );
  // A run's own email made a pattern, quoted too where its text needs it.
  assert.equal(tree.at(-1)!.text, "/Invited: [^@\\s]+@[^\\s]+/");
});

test("the map pictures each address on its own: a query tells two apart, and so does a number", () => {
  const taken = new Set<string>();
  assert.equal(pictureName("/pricing?plan=free", taken), "pricing-plan-free");
  assert.equal(pictureName("/pricing?plan=team", taken), "pricing-plan-team");
  assert.equal(pictureName("/", taken), "home");
  assert.equal(pictureName("/a-b", taken), "a-b");
  assert.equal(pictureName("/a/b", taken), "a-b-2");
  // A long query (a link carrying an address) keeps under a file name's limit, and two
  // that differ only at their end are two pictures, whatever else is taken.
  const long = (end: string) =>
    `/consent?redirect=${encodeURIComponent(`https://x.test/${"a".repeat(380)}${end}`)}`;
  const [one, two] = [pictureName(long("1"), new Set()), pictureName(long("2"), new Set())];
  assert.ok(long("1").length > 400 && one.length < 120, one);
  assert.match(one, /^consent-redirect-https-3A-2F-2Fx-test-2Faaa+-[0-9a-f]{8}$/);
  assert.notEqual(one, two);
  // The crawl names them so, with the very functions above.
  const crawl = crawlTest({
    config: resolveConfig({}, tmpdir(), null),
    roles: [{ entry: null, role: "visitor", viaConfig: false }],
    start: "/",
  });
  assert.match(crawl, /pictureName\(here\.pathname \+ here\.search, pictures\)/);
  const inlined = crawl.slice(crawl.indexOf("const routeOf = "), crawl.indexOf("const excluded"));
  const made = new Function(`${inlined}; return { pictureName, routeOf };`)() as {
    pictureName: typeof pictureName;
    routeOf: typeof routeOf;
  };
  assert.equal(
    made.routeOf("/acme/blob/main/spec/say-hello.feature"),
    "/acme/blob/main/spec/[file]",
  );
  assert.equal(made.pictureName("/pricing?plan=team", new Set()), "pricing-plan-team");
  assert.equal(made.pictureName(long("1"), new Set()), one);
});

test("a page's trees: what every width shows, then what only one does; a person's tree is kept", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pom-trees-"));
  const desktop = inventory(readOutline(OUTLINE), true);
  const phone = inventory(
    readOutline(
      OUTLINE.replace('    - link "Pricing":\n      - /url: /pricing\n', '    - button "Menu"\n'),
    ),
    true,
  );
  const written = writePage(dir, [
    { combo: { role: "visitor", state: null, width: "desktop" }, tree: desktop },
    { combo: { role: "visitor", state: null, width: "phone" }, tree: phone },
  ]);
  assert.deepEqual(
    written.map((w) => path.basename(w.file)),
    ["page.tree.yml", "page.desktop.tree.yml", "page.phone.tree.yml"],
  );
  const shared = readFileSync(path.join(dir, "page.tree.yml"), "utf8");
  assert.ok(shared.startsWith(GENERATED));
  assert.match(shared, /textbox "Title"/);
  assert.match(shared, /contentinfo:\n {2}- link "Pricing"/);
  assert.doesNotMatch(shared, /button "Menu"/);
  assert.match(
    readFileSync(path.join(dir, "page.phone.tree.yml"), "utf8"),
    /navigation "Main":\n {4}- button "Menu"/,
  );

  // The same everywhere now: the width's own trees pom wrote go; a person's tree stays.
  writeFileSync(path.join(dir, "page.tree.yml"), '- textbox "Title"\n');
  const again = writePage(dir, [
    { combo: { role: "visitor", state: null, width: "desktop" }, tree: desktop },
    { combo: { role: "visitor", state: null, width: "phone" }, tree: desktop },
  ]);
  assert.deepEqual(
    again.map((w) => w.kind),
    ["kept"],
  );
  assert.equal(readFileSync(path.join(dir, "page.tree.yml"), "utf8"), '- textbox "Title"\n');
  assert.equal(existsSync(path.join(dir, "page.phone.tree.yml")), false);
  assert.deepEqual(checkSpec(readSpec(dir)).problems, []);
});

test("siblings alike, two paragraphs with no name, stay two in a page's tree", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pom-trees-"));
  const form = inventory(
    readOutline(`- main:
  - button "Create account"
  - paragraph:
    - link "Terms":
      - /url: /terms
    - link "Privacy Policy":
      - /url: /privacy
  - paragraph:
    - link "Already have an account? Sign in":
      - /url: /sign-in`),
    true,
  );
  writePage(dir, [
    { combo: { role: "visitor", state: null, width: "desktop" }, tree: form },
    { combo: { role: "visitor", state: null, width: "phone" }, tree: form },
  ]);
  assert.equal(
    readFileSync(path.join(dir, "page.tree.yml"), "utf8"),
    [
      GENERATED,
      "- main:",
      '  - button "Create account"',
      "  - paragraph:",
      '    - link "Terms"',
      '    - link "Privacy Policy"',
      "  - paragraph:",
      '    - link "Already have an account? Sign in"',
      "",
    ].join("\n"),
  );
});

test("what every variation shows is the page's; what only one does, that variation's", () => {
  const chains = (...names: Array<string>) => new Set(names);
  const out = split([
    {
      chains: chains("main > heading", "banner > link Home", "banner > button Menu"),
      combo: { role: "visitor", state: null, width: "phone" },
    },
    {
      chains: chains("main > heading", "banner > link Home"),
      combo: { role: "visitor", state: null, width: "desktop" },
    },
    {
      chains: chains("main > heading", "banner > button Account", "main > button New project"),
      combo: { role: "owner", state: null, width: "desktop" },
    },
    {
      chains: chains("main > heading", "banner > button Account", "main > paragraph No projects"),
      combo: { role: "owner", state: "empty", width: "desktop" },
    },
  ]);
  assert.deepEqual([...out.get("")!], ["main > heading"]);
  assert.deepEqual([...out.get("visitor")!], ["banner > link Home"]);
  assert.deepEqual(
    [...out.get("owner")!],
    ["banner > button Account", "main > button New project"],
  );
  assert.deepEqual([...out.get("empty")!], ["main > paragraph No projects"]);
  assert.deepEqual([...out.get("phone")!], ["banner > button Menu"]);
});
