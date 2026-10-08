import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { PNG } from "pngjs";
import { NO_FFMPEG } from "./gif.ts";
import { LIMITS, publishFor, publishOf, shownIn } from "./service.ts";
import { runsOf, videosIn } from "./videos.ts";
import type { Video } from "./view/model.ts";

// What `pom upload --pull <n>` puts on the videos branch for its pull request's comment
// (service.ts: shownIn, publishOf), over a run of five journeys as `pom videos` leaves
// them: one broken, one failed on both sides, one new, one changed, one not played
// after, and one the same, which the comment never shows.

const RUN = "a50e864ade9a";

/** A picture as the reel keeps one: a few pixels of a PNG. */
const png = (shade: number) => {
  const picture = new PNG({ height: 2, width: 2 });
  picture.data.fill(shade);
  return PNG.sync.write(picture);
};

type Marks = Partial<Pick<Video, "chapters" | "checks" | "passed">>;

/** A run of a spec, where `pom videos` leaves it (the spec's .pom/runs), and a video of it made. */
function runIn() {
  const spec = mkdtempSync(path.join(tmpdir(), "pom-publish-"));
  const dir = path.join(runsOf(spec), RUN);
  after(() => rmSync(spec, { force: true, recursive: true }));
  const made = (target: string, slug: string, title: string, marks: Marks = {}) => {
    const folder = path.join(dir, target, "notes", slug, "visual");
    mkdirSync(folder, { recursive: true });
    const video = {
      badges: [],
      chapters: [{ picture: "01-end-of-open-it.png", start: 0.3, title: "Open it" }],
      checks: [],
      duration: 4,
      journey: { file: `spec/notes/${slug}.feature`, route: "/", slug, title },
      lines: [],
      mode: "visual",
      passed: true,
      pointer: [],
      rings: [],
      ripples: [],
      seconds: 5,
      size: { height: 800, width: 1280 },
      ...marks,
    };
    writeFileSync(path.join(folder, "video.json"), JSON.stringify(video));
    writeFileSync(path.join(folder, "journey.webm"), "webm");
    for (const one of [...video.chapters, ...video.checks])
      if (one.picture)
        writeFileSync(path.join(folder, one.picture), png(target === "head" ? 0 : 255));
    return folder;
  };
  return { dir, made };
}

const stopped = (picture: string | null) => ({
  at: 2,
  picture,
  text: "Couldn't find “Save”",
  verdict: "missing",
});

/** The run: each verdict the comment shows, and one it doesn't. */
function fiveJourneys() {
  const { dir, made } = runIn();
  // Broken: stops here, played through before.
  made("head", "leave-a-note", "Leave a note", {
    checks: [stopped("02-stopped.png")],
    passed: false,
  });
  made("base", "leave-a-note", "Leave a note");
  // Failed on both sides: where it stopped before beside where it stops now.
  made("head", "rename-a-note", "Rename a note", {
    checks: [stopped("02-stopped.png")],
    passed: false,
  });
  made("base", "rename-a-note", "Rename a note", {
    checks: [stopped("02-stopped.png")],
    passed: false,
  });
  // New: it stops before, where it isn't yet.
  made("head", "share-a-note", "Share a note");
  made("base", "share-a-note", "Share a note", { checks: [stopped(null)], passed: false });
  // Changed: a screen compared looks different before (main's picture), beside this pull
  // request's picture of the same chapter, numbered otherwise.
  const pin = {
    chapters: [
      { picture: "01-end-of-open-it.png", start: 0.3, title: "Open it" },
      { picture: "02-end-of-pin-it.png", start: 1.5, title: "Pin it" },
    ],
  };
  made("head", "pin-a-note", "Pin a note", {
    chapters: [
      { picture: "01-end-of-open-it.png", start: 0.3, title: "Open it" },
      { picture: "02-end-of-look.png", start: 1, title: "Look" },
      { picture: "03-end-of-pin-it.png", start: 1.5, title: "Pin it" },
    ],
  });
  made("base", "pin-a-note", "Pin a note", {
    ...pin,
    checks: [
      {
        at: 3.4,
        picture: "02-end-of-pin-it.png",
        text: "The screen: 4.10% different from the reference (0.10% allowed)",
        verdict: "differs",
      },
    ],
  });
  // Not played after: main's video is the one there is.
  made("base", "archive-a-note", "Archive a note");
  // The same on both sides: not in the comment.
  made("head", "delete-a-note", "Delete a note");
  made("base", "delete-a-note", "Delete a note");
  return dir;
}

test("the comment's files are listed as it shows them, in its order", () => {
  const dir = fiveJourneys();
  const shown = shownIn(dir, videosIn(dir));
  assert.deepEqual(
    shown.map(({ at, gif }) => (gif ? `${at} (${gif.reference})` : at)),
    [
      // Broken, then failed, new, changed and not played after, as the comment orders them.
      "head/notes/leave-a-note/visual/journey.gif (the reference)",
      "head/notes/leave-a-note/visual/01-end-of-open-it.png",
      "head/notes/rename-a-note/visual/journey.gif (the reference)",
      "base/notes/rename-a-note/visual/02-stopped.png",
      "head/notes/rename-a-note/visual/02-stopped.png",
      "head/notes/rename-a-note/visual/01-end-of-open-it.png",
      "head/notes/share-a-note/visual/journey.gif (the reference)",
      "head/notes/share-a-note/visual/01-end-of-open-it.png",
      "head/notes/pin-a-note/visual/journey.gif (the reference)",
      "base/notes/pin-a-note/visual/02-end-of-pin-it.png",
      "head/notes/pin-a-note/visual/03-end-of-pin-it.png",
      "head/notes/pin-a-note/visual/01-end-of-open-it.png",
      "head/notes/pin-a-note/visual/02-end-of-look.png",
      // Main's video, measured against this pull request as its page shows it.
      "base/notes/archive-a-note/visual/journey.gif (this pull request)",
      "base/notes/archive-a-note/visual/01-end-of-open-it.png",
    ],
  );
  assert.ok(shown.every(({ file }) => file.startsWith(dir)));
});

test("what goes on the videos branch is where the comment finds it, keyed under publish/", () => {
  const dir = fiveJourneys();
  // Two GIFs made: the others are left out, as GIFs that couldn't be made.
  for (const slug of ["pin-a-note", "leave-a-note"])
    writeFileSync(path.join(dir, "head", "notes", slug, "visual", "journey.gif"), "GIF89a");
  const lines: Array<string> = [];
  const publish = publishOf(dir, videosIn(dir), { pull: 7, run: RUN, say: (l) => lines.push(l) });
  assert.deepEqual(lines, []);
  assert.equal(publish.length, 12);
  assert.deepEqual(publish[0], {
    file: path.join(dir, "head", "notes", "leave-a-note", "visual", "journey.gif"),
    key: "publish/1-journey.gif",
    path: `pr-7/${RUN}/head/notes/leave-a-note/visual/journey.gif`,
  });
  assert.ok(!publish.some(({ path: at }) => at.includes("rename-a-note/visual/journey.gif")));
  for (const { file, key, path: at } of publish) {
    // As the run holds it, and as the service takes it (github/videosBranch.ts, publishable).
    assert.match(key, /^publish\/[^/]+\.(gif|jpg|mp4|png)$/);
    assert.equal(at, `pr-7/${RUN}/${path.relative(dir, file).split(path.sep).join("/")}`);
    assert.ok(at.split("/").length <= 10);
    assert.ok(at.split("/").every((s) => /^[A-Za-z0-9._@+()[\]-]{1,128}$/.test(s)));
  }
  assert.equal(new Set(publish.map(({ key }) => key)).size, publish.length);
  // A pull request's number, and a run, that the branch can't have: nothing.
  assert.deepEqual(publishOf(dir, videosIn(dir), { pull: 0, run: RUN }), []);
  assert.deepEqual(publishOf(dir, videosIn(dir), { pull: 7, run: "../x" }), []);
});

test("past pomspec's limits, GIFs go first, the largest first, and a line says so", () => {
  const dir = fiveJourneys();
  const gif = (slug: string, bytes: number, target = "head") =>
    writeFileSync(
      path.join(dir, target, "notes", slug, "visual", "journey.gif"),
      Buffer.alloc(bytes, 1),
    );
  gif("leave-a-note", 1200);
  gif("rename-a-note", 900);
  gif("share-a-note", 700);
  gif("pin-a-note", 800);
  const pictures = shownIn(dir, videosIn(dir))
    .filter(({ gif }) => !gif)
    .reduce((sum, { file }) => sum + statSync(file).size, 0);
  const said: Array<string> = [];
  const publish = publishOf(dir, videosIn(dir), {
    // Room for two of the three GIFs under the limit for one, with every picture.
    limits: { ...LIMITS, branch: 1000, branchRun: 1500 + pictures },
    pull: 7,
    run: RUN,
    say: (line) => said.push(line),
  });
  const gifs = publish.filter(({ key }) => key.endsWith(".gif")).map(({ path: at }) => at);
  assert.deepEqual(gifs, [
    `pr-7/${RUN}/head/notes/share-a-note/visual/journey.gif`,
    `pr-7/${RUN}/head/notes/pin-a-note/visual/journey.gif`,
  ]);
  assert.equal(publish.length, 2 + 10);
  assert.equal(said.length, 1);
  assert.match(
    said[0]!,
    /^Left out of the pull request's comment, over pomspec's limits for the videos branch \(.+ a file, .+ in all\): the GIFs of “Leave a note” and “Rename a note”\.$/,
  );

  // No room for a GIF at all, nor every picture: the comment's last pictures go too.
  const fewer: Array<string> = [];
  const least = publishOf(dir, videosIn(dir), {
    limits: { ...LIMITS, branch: 1000, branchRun: pictures - 1 },
    pull: 7,
    run: RUN,
    say: (line) => fewer.push(line),
  });
  assert.equal(least.length, 9);
  assert.ok(!least.some(({ key }) => key.endsWith(".gif")));
  assert.match(fewer[0]!, /: 4 GIFs, and a picture\.$/);

  // So many files at most: the comment's last go.
  const counted = publishOf(dir, videosIn(dir), {
    limits: { ...LIMITS, branchFiles: 3 },
    pull: 7,
    run: RUN,
  });
  assert.deepEqual(
    counted.map(({ key }) => key),
    ["publish/1-journey.gif", "publish/2-01-end-of-open-it.png", "publish/3-journey.gif"],
  );
});

/** The run's own files, as its upload sends them: each video's, its still counted drawn or not, never its GIF. */
function ownFiles(dir: string) {
  let count = 0;
  let bytes = 0;
  for (const { dir: folder } of videosIn(dir)) {
    const names = readdirSync(folder).filter((name) => name !== "journey.gif");
    count += names.length + 1;
    for (const name of names) bytes += statSync(path.join(folder, name)).size;
  }
  return { bytes, count };
}

test("a run's own files leave less room, and the line names a run's limits, not the branch's", () => {
  const dir = fiveJourneys();
  for (const [slug, bytes] of [
    ["leave-a-note", 1200],
    ["rename-a-note", 900],
    ["share-a-note", 700],
    ["pin-a-note", 800],
  ] as const)
    writeFileSync(
      path.join(dir, "head", "notes", slug, "visual", "journey.gif"),
      Buffer.alloc(bytes, 1),
    );
  const pictures = shownIn(dir, videosIn(dir))
    .filter(({ gif }) => !gif)
    .reduce((sum, { file }) => sum + statSync(file).size, 0);
  const own = ownFiles(dir);

  // Room left in the run for every picture and the smallest GIF alone.
  const said: Array<string> = [];
  const sized = publishOf(dir, videosIn(dir), {
    limits: { ...LIMITS, run: own.bytes + pictures + 750 },
    pull: 7,
    run: RUN,
    say: (line) => said.push(line),
  });
  assert.deepEqual(
    sized.filter(({ key }) => key.endsWith(".gif")).map(({ path: at }) => at),
    [`pr-7/${RUN}/head/notes/share-a-note/visual/journey.gif`],
  );
  assert.equal(sized.length, 1 + 10);
  assert.deepEqual(said, [
    "Left out of the pull request's comment, over pomspec's limit for a run, its videos included (0 MB): the GIFs of “Leave a note”, “Rename a note” and “Pin a note”.",
  ]);

  // Room left in the run for two more files: the comment's first two.
  const counted: Array<string> = [];
  const two = publishOf(dir, videosIn(dir), {
    limits: { ...LIMITS, files: own.count + 2 },
    pull: 7,
    run: RUN,
    say: (line) => counted.push(line),
  });
  assert.deepEqual(
    two.map(({ key }) => key),
    ["publish/1-journey.gif", "publish/2-01-end-of-open-it.png"],
  );
  assert.deepEqual(counted, [
    `Left out of the pull request's comment, over pomspec's limit for a run, its videos included (${(own.count + 2).toLocaleString("en")} files): the GIFs of “Rename a note”, “Share a note” and “Pin a note”, and 9 pictures.`,
  ]);

  // Past the branch's count alone: its limit, and only it.
  const branch: Array<string> = [];
  publishOf(dir, videosIn(dir), {
    limits: { ...LIMITS, branchFiles: 3 },
    pull: 7,
    run: RUN,
    say: (line) => branch.push(line),
  });
  assert.match(branch[0]!, /, over pomspec's limit for the videos branch \(3 files\): /);
});

test("pom upload --pull makes the GIFs, then lists them; without ffmpeg, the list without them", async () => {
  const dir = fiveJourneys();
  const spec = path.resolve(dir, "..", "..", "..");
  // A GIF of an older recording of a journey played again since: not made again, and gone.
  const folder = path.join(dir, "head", "notes", "leave-a-note", "visual");
  writeFileSync(path.join(folder, "journey.gif"), "GIF89a");
  const later = new Date(Date.now() + 60_000);
  utimesSync(path.join(folder, "journey.webm"), later, later);
  const stale = publishOf(dir, videosIn(dir), { pull: 7, run: RUN });
  assert.ok(stale.some(({ key }) => key.endsWith(".gif")));

  const said: Array<string> = [];
  const PATH = process.env.PATH;
  process.env.PATH = dir;
  let publish: Awaited<ReturnType<typeof publishFor>>;
  try {
    publish = await publishFor({ pull: 7, run: RUN, say: (line) => said.push(line), spec });
  } finally {
    process.env.PATH = PATH;
  }
  assert.deepEqual(said, [NO_FFMPEG]);
  assert.deepEqual(publish, publishOf(dir, videosIn(dir), { pull: 7, run: RUN }));
  assert.deepEqual(
    publish.map(({ path: at }) => at),
    stale.filter(({ key }) => !key.endsWith(".gif")).map(({ path: at }) => at),
  );
  // No such run: nothing, and the upload says so.
  assert.deepEqual(await publishFor({ pull: 7, run: "0123456789ab", spec }), []);
});
