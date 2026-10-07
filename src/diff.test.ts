import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PNG } from "pngjs";
import { resolveConfig } from "./config.ts";
import { diff, markdown, pairMoments, type Side } from "./diff.ts";
import { compare, pair } from "./png.ts";
import type { Manifest, Moment } from "./types.ts";

const png = (
  width: number,
  height: number,
  paint?: (x: number, y: number) => [number, number, number],
) => {
  const image = new PNG({ height, width });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint?.(x, y) ?? [255, 255, 255];
      const i = (y * width + x) * 4;
      image.data[i] = r;
      image.data[i + 1] = g;
      image.data[i + 2] = b;
      image.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(image);
};

const moment = (id: string, step: number, index: number, sha = id): Moment => ({
  after: id === "start" ? null : { line: index + 3, source: `When I press the "${id}" button` },
  checkpoint: true,
  id,
  index,
  journey: "j",
  next: null,
  page: "/",
  pictures: { desktop: { box: null, file: `desktop/${id}.png`, sha256: sha } },
  role: "visitor",
  state: null,
  step,
});

const manifest = (moments: Array<Moment>, platform = "darwin"): Manifest => ({
  journey: "j",
  moments,
  pom: 1,
  renderer: { platform, playwright: "1.63.0" },
  steps: ["Go"],
  taken: { commit: null, dirty: false, source: "x" },
  title: "J",
  widths: { desktop: { height: 10, width: 10 } },
});

const side = (m: Manifest, pictures: Record<string, Buffer>): Side => ({
  manifests: new Map([[m.journey, m]]),
  picture: (_journey, file) => pictures[file] ?? null,
  said: "",
});

const config = resolveConfig({}, tmpdir(), null);

test("moments pair by id, else by their place in their step; the rest were added or removed", () => {
  const pairs = pairMoments(
    [moment("start", 0, -1), moment("press-save", 0, 1), moment("press-old", 1, 1)],
    [
      moment("start", 0, -1),
      moment("press-save", 0, 1),
      moment("press-new", 1, 1),
      moment("press-more", 1, 2),
    ],
  );
  assert.deepEqual(
    pairs.map((p) => [p.before?.id ?? null, p.after?.id ?? null, p.reworded]),
    [
      ["start", "start", false],
      ["press-save", "press-save", false],
      ["press-old", "press-new", true],
      [null, "press-more", false],
    ],
  );
});

test("a picture the same in its bytes, or within the threshold, is unchanged; past it, changed", () => {
  const white = png(100, 100);
  const dot = png(100, 100, (x, y) => (x === 5 && y === 5 ? [0, 0, 0] : [255, 255, 255]));
  const block = png(100, 100, (x, y) => (x < 20 && y < 20 ? [220, 0, 0] : [255, 255, 255]));
  const threshold = { pixel: 0.1, ratio: 0.001 };
  assert.equal(compare(white, white, threshold).changed, false);
  assert.equal(compare(white, dot, threshold).changed, false);
  assert.equal(compare(white, block, threshold).changed, true);
  assert.equal(compare(white, png(100, 90), threshold).changed, true);
  const both = PNG.sync.read(pair(white, block));
  assert.equal(both.width, 224);
});

test("a diff writes what changed, and says unchanged what did not (sign-out's identical start and end)", () => {
  const same = png(10, 10);
  const other = png(10, 10, () => [0, 0, 0]);
  const before = manifest([moment("start", 0, -1, "a"), moment("press-x", 0, 1, "a")]);
  const after = manifest([moment("start", 0, -1, "a"), moment("press-x", 0, 1, "b")]);
  const dir = mkdtempSync(path.join(tmpdir(), "pom-diff-"));
  const result = diff({
    after: side(after, { "desktop/press-x.png": other, "desktop/start.png": same }),
    before: side(before, { "desktop/press-x.png": same, "desktop/start.png": same }),
    config,
    dir,
  });
  const journey = result.journeys[0]!;
  assert.equal(journey.status, "changed");
  assert.deepEqual(
    journey.moments.map((m) => [m.after?.id, m.status]),
    [
      ["start", "unchanged"],
      ["press-x", "changed"],
    ],
  );
  assert.ok(journey.moments[1]!.widths.desktop!.pair);
});

test("pictures from another platform are not compared: the diff says why", () => {
  const before = manifest([moment("start", 0, -1, "a")], "linux");
  const after = manifest([moment("start", 0, -1, "b")], "darwin");
  const result = diff({
    after: side(after, { "desktop/start.png": png(10, 10) }),
    before: side(before, { "desktop/start.png": png(10, 10, () => [0, 0, 0]) }),
    config,
    dir: mkdtempSync(path.join(tmpdir(), "pom-diff-")),
  });
  assert.equal(result.journeys.length, 0);
  assert.equal(
    result.notes[0],
    "J wasn't compared: Before was pictured on linux with Playwright 1.63.0, After on darwin with Playwright 1.63.0. Picture both on one machine, or let CI do it.",
  );
});

test("the section counts screens changed, a real plural, and names the sides Before and After", () => {
  const same = png(10, 10);
  const other = png(10, 10, () => [0, 0, 0]);
  const dir = mkdtempSync(path.join(tmpdir(), "pom-diff-"));
  // One screen changed, the other the same: one of two.
  const before = manifest([moment("start", 0, -1, "a"), moment("press-x", 0, 1, "a")]);
  const after = manifest([moment("start", 0, -1, "b"), moment("press-x", 0, 1, "a")]);
  const result = diff({
    after: side(after, { "desktop/press-x.png": same, "desktop/start.png": other }),
    before: side(before, { "desktop/press-x.png": same, "desktop/start.png": same }),
    config,
    dir,
  });
  const md = markdown(result, dir);
  assert.match(md, /^\*\*Pictures\*\* · 1 journey changed · 1 screen · Before \\\| After$/m);
  assert.match(md, /<b>J<\/b> · 1 of 2 screens changed/);
  // A step reworded counts as a changed screen too, as a changed moment always has: two of two.
  const reworded = manifest([moment("start", 0, -1, "b"), moment("press-y", 0, 1, "a")]);
  const bothDir = mkdtempSync(path.join(tmpdir(), "pom-diff-"));
  const both = diff({
    after: side(reworded, { "desktop/press-y.png": same, "desktop/start.png": other }),
    before: side(before, { "desktop/press-x.png": same, "desktop/start.png": same }),
    config,
    dir: bothDir,
  });
  const twice = markdown(both, bothDir);
  assert.match(twice, /^\*\*Pictures\*\* · 1 journey changed · 2 screens · Before \\\| After$/m);
  assert.match(twice, /<b>J<\/b> · 2 of 2 screens changed/);

  const added = diff({
    after: side(after, { "desktop/press-x.png": same, "desktop/start.png": same }),
    before: { manifests: new Map(), picture: () => null, said: "" },
    config,
    dir: mkdtempSync(path.join(tmpdir(), "pom-diff-")),
  });
  assert.match(markdown(added, dir), /<b>J<\/b> · New/);
  const alone = { ...added, before: null };
  assert.match(
    markdown(alone, dir),
    /^\*\*Journeys\*\* · 1 journey pictured · nothing to compare with yet$/m,
  );
});
