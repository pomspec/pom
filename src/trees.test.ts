import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkSpec } from "./check.ts";
import { excluded, inventory, routeOf } from "./map.ts";
import { prune, readOutline, writeOutline } from "./outline.ts";
import { GENERATED, readSpec } from "./spec.ts";
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
