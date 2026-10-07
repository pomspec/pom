import assert from "node:assert/strict";
import { mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Diff } from "./diff.ts";
import { MAX_FILES, newer, section, withSection } from "./pr.ts";

const changes = (n: number, dir: string): Diff => ({
  after: "",
  before: "base",
  journeys: [
    {
      journey: "sign-up",
      moments: Array.from({ length: n }, (_, i) => {
        const file = path.join(dir, `m${i}.pair.png`);
        writeFileSync(file, "x");
        return {
          after: {
            after: { line: i, source: `When I press the "B${i}" button` },
            checkpoint: true,
            id: `press-b${i}`,
            index: i,
            journey: "sign-up",
            next: null,
            page: "/",
            role: "visitor",
            state: null,
            step: 0,
          },
          before: null,
          status: "changed" as const,
          widths: { desktop: { after: null, before: null, diff: null, pair: file, ratio: 0.5 } },
        };
      }),
      status: "changed",
      title: "Sign up",
    },
  ],
  notes: [],
});

test("pom's section replaces its old one, or follows what the description says", () => {
  const own = "<!-- pom:start commit=abc1234 -->\nnew $1 $&\n<!-- pom:end -->";
  assert.equal(withSection("", own), `${own}\n`);
  assert.equal(withSection("Why this change.", own), `Why this change.\n\n${own}\n`);
  const old = "Why.\n\n<!-- pom:start commit=0000000 -->\nold\n<!-- pom:end -->\n\nMore.";
  assert.equal(withSection(old, own), `Why.\n\n${own}\n\nMore.`);
});

test("a section written for a newer commit is left; one this clone does not have counts as older", () => {
  const body = "<!-- pom:start commit=bbbbbbb -->\n<!-- pom:end -->";
  assert.equal(
    newer(body, "aaaaaaa", () => true),
    true,
  );
  assert.equal(
    newer(body, "aaaaaaa", () => false),
    false,
  );
  assert.equal(
    newer(body, "aaaaaaa", () => {
      throw new Error("unknown commit");
    }),
    false,
  );
  assert.equal(
    newer("no section", "aaaaaaa", () => true),
    false,
  );
});

test("past gh's 50 files, the rest are named with where pomspec keeps them", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pom-pr-"));
  const made = section({
    commit: "abc1234",
    diff: changes(MAX_FILES + 3, dir),
    dir,
    maxMB: 100,
    videos: new Map(),
  });
  assert.equal(made.attached.length, MAX_FILES);
  assert.equal(made.left[0], "3 pictures left out: GitHub takes 50 files at once.");
  assert.match(
    made.body,
    /> 3 pictures left out: GitHub takes 50 files at once\. pomspec shows every video and picture: https:\/\/pomspec\.com\/pricing/,
  );
  assert.ok(
    made.body.includes(
      "<sub>Everything here stays with this pull request. pomspec keeps your team's videos in one place, to watch and comment on: https://pomspec.com/pricing</sub>",
    ),
  );
  // The body names only what is attached: no reference is left for gh to fail on.
  const referenced = [...made.body.matchAll(/\]\(\.\/([^)]+)\)/g)].map((m) => m[1]);
  assert.equal(referenced.length, MAX_FILES);
  // One left out is one picture.
  const one = section({
    commit: "abc1234",
    diff: changes(MAX_FILES + 1, mkdtempSync(path.join(tmpdir(), "pom-pr-"))),
    dir,
    maxMB: 100,
    videos: new Map(),
  });
  assert.equal(one.left[0], "1 picture left out: GitHub takes 50 files at once.");
});

test("a video past what GitHub plays gets the note, not an attachment", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pom-pr-"));
  const video = path.join(dir, "big.webm");
  writeFileSync(video, Buffer.alloc(2_100_000));
  const made = section({
    commit: "abc1234",
    diff: changes(1, dir),
    dir,
    maxMB: 2,
    videos: new Map([["sign-up", video]]),
  });
  assert.ok(made.attached.every((a) => a.kind === "picture"));
  assert.equal(made.left[0], "The video of Sign up is 2.1 MB, and GitHub plays up to 2 MB.");
  // pomspec keeps a video this size: said with where.
  assert.match(made.body, /GitHub plays up to 2 MB\. pomspec shows every video and picture/);
});

test("a video that fits is shown with its journey's name; one past pomspec's own limit is not offered", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pom-pr-"));
  const video = path.join(dir, "small.webm");
  writeFileSync(video, Buffer.alloc(1_000));
  const made = section({
    commit: "abc1234",
    diff: changes(1, dir),
    dir,
    maxMB: 2,
    videos: new Map([["sign-up", video]]),
  });
  assert.match(made.body, /!\[Video of Sign up\]\(\.\/sign-up\.webm\)/);

  const huge = path.join(dir, "huge.webm");
  writeFileSync(huge, Buffer.alloc(0));
  truncateSync(huge, 101 * 1024 * 1024);
  const past = section({
    commit: "abc1234",
    diff: changes(1, dir),
    dir,
    maxMB: 100,
    videos: new Map([["sign-up", huge]]),
  });
  assert.match(past.body, /> The video of Sign up is 105\.9 MB, and GitHub plays up to 100 MB\.\n/);
  assert.doesNotMatch(past.body, /pomspec shows every video/);
});
