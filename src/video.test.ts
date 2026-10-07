import assert from "node:assert/strict";
import { test } from "node:test";
import {
  askAt,
  blobAt,
  controlOf,
  differenceOf,
  homeOf,
  journeysAddress,
  plainCheck,
  plainVideo,
  projectAddress,
  pullAddress,
  repoAddress,
  stepsOf,
  verdictOf,
  verdictRank,
  videoAddress,
} from "./video.ts";
import type { Video, VideoRef, VideoRepo } from "./view/model.ts";

// What a video says wherever it is read (video.ts): pure, so `pom`, the service and the
// web app each get the same answers from the same video.json.

/** A video as eyes.ts leaves one: a chapter, a check, whether it passed. */
function video(overrides: Partial<Video> = {}): Video {
  return {
    badges: [],
    chapters: [{ start: 0, title: "Start" }],
    checks: [{ at: 1, text: "The page", verdict: "found" }],
    duration: 3,
    journey: { file: "cart.journey.ts", route: "/", slug: "cart", title: "Cart" },
    lines: [],
    passed: true,
    pointer: [],
    rings: [],
    ripples: [],
    seconds: 3,
    size: { height: 800, width: 1280 },
    ...overrides,
  };
}

const FEATURE = [
  "Feature: Change your password",
  "  Background:",
  "    Given a new reader",
  "  Scenario: Change your password",
  '    Given I am on "/dashboard"',
  "    # Open the settings",
  "    When I click “Settings”",
  "    Then I see “Password”",
  "    # Change it",
  "    When I type “new”",
  "    Then I see “Saved”",
  "",
].join("\n");

const line = (start: number, text: string, step?: number | null) => ({
  chapter: "",
  end: -1,
  start,
  text,
  ...(step === undefined ? {} : { step }),
});

const CHAPTERS = [
  { start: 0, title: "Open the settings" },
  { start: 6, title: "Change it" },
];

test("a video from before steps were kept pairs its lines with the .feature's steps by count", () => {
  const steps = stepsOf(
    {
      chapters: CHAPTERS,
      lines: [
        line(1, "Click “Settings”"),
        line(3, "See “Password”"),
        // The video's own words, no step of the file's.
        line(5, "The screen looks as expected"),
        line(7, "Type “new”"),
        line(9, "“Saved” isn't on the page"),
      ],
    },
    FEATURE,
  );
  // Before any step: where it starts.
  assert.deepEqual(steps.at(0.5), { line: 5, text: 'Given I am on "/dashboard"' });
  assert.equal(steps.at(1)?.line, 7);
  assert.equal(steps.at(4)?.line, 8);
  // A screen compared is no step: the one before it is still what plays.
  assert.equal(steps.at(5.5)?.line, 8);
  assert.equal(steps.at(8)?.line, 10);
  // The video stopped before the last step: it never plays it, and stays on the one before.
  assert.equal(steps.at(9.5)?.line, 10);
  assert.equal(steps.timeOf(8), 3);
  assert.equal(steps.timeOf(10), 7);
  // A chapter's line is its start; the feature's own lines are the video's start.
  assert.equal(steps.timeOf(9), 6);
  assert.equal(steps.timeOf(1), 0);
  assert.equal(steps.textOf(11), "Then I see “Saved”");
});

test("a video that kept each line's step is read by it, where counting would drift", () => {
  // A step said twice (its call in a loop), then one that found nothing: by count the
  // second "Type" would be "Then I see “Saved”", and the line after it no step at all.
  const kept = [
    line(1, "Click “Settings”", 7),
    line(3, "See “Password”", 8),
    line(5, "The screen looks as expected", null),
    line(7, "Type “new”", 10),
    line(8, "Type “new”", 10),
    line(9, "See “Saved”", 11),
    line(10, "“Saved” isn't on the page", 11),
  ];
  const steps = stepsOf({ chapters: CHAPTERS, lines: kept }, FEATURE);
  assert.equal(steps.at(8.5)?.line, 10);
  assert.equal(steps.at(9.5)?.line, 11);
  assert.equal(steps.at(10.5)?.line, 11);
  assert.equal(steps.timeOf(10), 7);
  assert.equal(steps.timeOf(11), 9);
  assert.deepEqual(steps.at(0.5), { line: 5, text: 'Given I am on "/dashboard"' });

  // One said line without its step: the whole video is paired by count, as before.
  const partly = kept.map((l, i) => (i === 3 ? line(l.start, l.text) : l));
  assert.equal(stepsOf({ chapters: CHAPTERS, lines: partly }, FEATURE).at(8.5)?.line, 11);
  // Steps of another .feature (its journey changed since): by count too.
  const moved = kept.map((l) => (l.step === 11 ? { ...l, step: 12 } : l));
  assert.equal(stepsOf({ chapters: CHAPTERS, lines: moved }, FEATURE).at(8.5)?.line, 11);
});

test("a journey's verdict: broken, new, changed or the same as on main", () => {
  const stop = {
    at: 2,
    text: "Couldn't find “Pay”: the closest is 0.40 alike",
    verdict: "missing",
  };
  const failing = video({ checks: [stop], passed: false });
  const played = (target: string, f: Video, mode = "visual") => ({ mode, target, video: f });

  // Where it stopped, in the words people read: the score stays in video.json.
  assert.deepEqual(verdictOf([played("head", failing), played("base", video())], true), {
    kind: "broken",
    stop: {
      at: 2,
      chapter: "Start",
      control: "“Pay”",
      side: "head",
      text: "“Pay” isn't on the page",
    },
  });
  // Stopped before too, or never played there: it fails, and broke nothing.
  assert.equal(verdictOf([played("head", failing), played("base", failing)], true).kind, "failed");
  assert.equal(verdictOf([played("head", failing)], true).kind, "failed");
  assert.equal(verdictOf([played("head", video()), played("base", failing)], true).kind, "new");
  const moved = video({
    checks: [
      { at: 1, text: "The list: 0.97 alike, 12 px lower than in the reference", verdict: "moved" },
    ],
  });
  assert.deepEqual(verdictOf([played("head", video()), played("base", moved)], true), {
    kind: "changed",
    notes: [
      {
        at: 1,
        chapter: "Start",
        said: "The list is 12 px higher in this change",
        side: "base",
        text: moved.checks[0]!.text,
      },
    ],
  });
  // What this pull request's own video found against its own reference says nothing of main.
  assert.deepEqual(verdictOf([played("head", moved), played("base", video())], true), {
    kind: "same",
  });
  // Main's video in the head's mode, when it has one.
  assert.equal(
    verdictOf(
      [
        played("head", video(), "reference"),
        played("base", failing),
        played("base", video(), "reference"),
      ],
      true,
    ).kind,
    "same",
  );
  assert.deepEqual(verdictOf([played("head", video())], true), { kind: "unplayed", side: "base" });
  // A run of no pull request: passed or failed.
  assert.deepEqual(verdictOf([played("dom", video())], false), { kind: "passed" });
  assert.equal(verdictOf([played("dom", failing)], false).kind, "failed");
  // An error's own text stays in video.json: it stopped, no more; so does a video that
  // failed with no check failing.
  const erred = video({
    checks: [
      { at: 2, text: "It stopped: locator.click: Timeout 5000ms exceeded", verdict: "missing" },
    ],
    passed: false,
  });
  for (const f of [erred, video({ checks: [], passed: false })])
    assert.deepEqual(verdictOf([played("dom", f)], false), {
      kind: "failed",
      stop: {
        at: f.checks[0]?.at ?? 3,
        chapter: "Start",
        control: null,
        side: "dom",
        text: "It stopped before the end",
      },
    });
  // What needs a look comes first.
  assert.ok(verdictRank.broken < verdictRank.new && verdictRank.new < verdictRank.changed);
  assert.ok(verdictRank.changed < verdictRank.same);
});

test("what a check looked for, and what changed, in plain words", () => {
  assert.equal(
    controlOf("Couldn't find “Esqueci minha senha”: the closest is 0.58 alike, and it needs 0.75"),
    "“Esqueci minha senha”",
  );
  assert.equal(
    controlOf("Couldn't find “Save” by “Name”: the closest is 0.40 alike, and it needs 0.75"),
    "“Save”",
  );
  assert.equal(
    controlOf("“Link”: “Expired” could be in two places: 0.90 alike and 0.89 alike"),
    "“Link”: “Expired”",
  );
  assert.equal(controlOf("Blocked POST /api: it writes"), null);
  // A reel's, by its role and name; and in the words people read, as a page keeps them.
  assert.equal(controlOf("Couldn't find “Pay”"), "“Pay”");
  assert.equal(controlOf("The “Segurança” tab isn't on the page"), "The “Segurança” tab");
  assert.equal(controlOf("“Link”: “Expired” could be in two places"), "“Link”: “Expired”");
  assert.equal(controlOf("It stopped before the end"), null);
  const paying = video({
    chapters: [
      { start: 0, title: "Start" },
      { start: 5, title: "Pay" },
    ],
  });
  assert.equal(
    differenceOf(paying, {
      at: 2,
      text: "“Total”: 0.97 alike, 12 px lower than in the reference",
      verdict: "moved",
    }),
    "“Total” is 12 px higher in this change",
  );
  // A control's own name is never lower-cased: the line starts with it.
  for (const text of [
    "the list: 0.97 alike, 8 px left and 4 px lower than in the reference",
    "The list is on the page, 8 px left and 4 px lower than in this change",
    "The list is on the page, 8 px left and 4 px lower than expected",
  ])
    assert.equal(
      differenceOf(paying, { at: 2, text, verdict: "moved" }),
      "The list is 8 px right and 4 px higher in this change",
    );
  assert.equal(
    differenceOf(paying, {
      at: 6,
      text: "The screen: 3.10% different from the reference (2.00% allowed)",
      verdict: "differs",
    }),
    "The screen at “Pay” looks different",
  );
  assert.equal(
    differenceOf(video({ chapters: [] }), {
      at: 6,
      text: "The screen looks different in this change",
      verdict: "differs",
    }),
    "A screen looks different",
  );
});

test("a check in plain words: no scores, thresholds, methods or errors", () => {
  const plain = (text: string, verdict: string, reference?: string) =>
    plainCheck({ text, verdict }, reference);
  // A control not found, found twice, found: the scores and the part it was found by stay in video.json.
  assert.equal(
    plain(
      "Couldn't find the Save button by “Name”: the closest is 0.40 alike, and it needs 0.75",
      "missing",
    ),
    "The Save button isn't on the page",
  );
  assert.equal(plain("Couldn't find “Pay”", "missing"), "“Pay” isn't on the page");
  assert.equal(
    plain(
      "The Save button could be in two places by “Name”: 0.95 alike and 0.94 alike, and where they differ 0.90 and 0.80",
      "missing",
    ),
    "The Save button could be in two places",
  );
  const moved =
    "The Save button: 0.97 alike, 12 px lower than in the reference (told apart where they differ, 0.91 to 0.80)";
  assert.equal(plain(moved, "moved"), "The Save button is on the page, 12 px lower than expected");
  assert.equal(
    plain(moved, "moved", "this pull request"),
    "The Save button is on the page, 12 px lower than in this change",
  );
  // A head named by the run is still this change: a branch's name is never said.
  assert.equal(
    plain(moved, "moved", "pin-notes"),
    "The Save button is on the page, 12 px lower than in this change",
  );
  assert.equal(plain("The Save button: 1.00 alike", "found"), "The Save button is on the page");
  assert.equal(
    plain("The Save button: found, and its picture kept", "found"),
    "The Save button is on the page",
  );
  assert.equal(
    plain("Chose “Brazil” through the page: a select's list is drawn outside the screen", "found"),
    "Chose “Brazil”",
  );
  // The screen, by its verdict and what it was compared with.
  const screen = "The screen: 3.10% different from the reference (2.00% allowed)";
  assert.equal(plain(screen, "differs"), "The screen looks different than expected");
  assert.equal(
    plain(screen, "differs", "this change"),
    "The screen looks different in this change",
  );
  assert.equal(plain(screen.replace("3.10", "1.00"), "same"), "The screen looks as expected");
  assert.equal(
    plain(screen.replace("3.10", "1.00"), "same", "this change"),
    "The screen looks as it does in this change",
  );
  assert.equal(
    plain("The screen: kept as the reference", "same"),
    "The screen, kept for comparison",
  );
  // Where it stopped: an error's own text never; where it never got, or what did not show, as said.
  assert.equal(
    plain("It stopped: locator.click: Timeout 5000ms exceeded", "missing"),
    "It stopped before the end",
  );
  assert.equal(plain("It stopped before its end", "missing"), "It stopped before the end");
  assert.equal(plain("Unexpected error.", "missing"), "It stopped before the end");
  assert.equal(plain("It never got to /settings", "missing"), "It never got to /settings");
  assert.equal(plain("“Notes” doesn't show “Pinned”", "missing"), "“Notes” doesn't show “Pinned”");
  assert.equal(plain(`I see "Saved"`, "found"), `I see "Saved"`);
  // What a guard blocked, as it says it now and as it said it before: no method, no scope, no action id.
  for (const [text, said] of [
    [
      "Blocked a request to /api/notes: it changes data",
      "Blocked a request to /api/notes: it changes data",
    ],
    [
      "Blocked GET /visit: GET /visit changes data there (the scope says so)",
      "Blocked a request to /visit: it changes data",
    ],
    [
      "Blocked POST /: a server action (4f1c2e9a7b3d…) the scope does not list: it may change data",
      "Blocked a request to /: it could change data",
    ],
    [
      "Blocked PATCH /api/notes: PATCH could change data, and the scope is read-only",
      "Blocked a request to /api/notes: it could change data",
    ],
    [
      "Blocked POST /collect: a POST to another site (stats.example.com)",
      "Blocked a request to another site (stats.example.com): it could change data",
    ],
    [
      "The guard blocked 1 request that could change data",
      "Blocked 1 request that could change data",
    ],
    [
      "The guard blocked 3 requests that could change data",
      "Blocked 3 requests that could change data",
    ],
  ])
    assert.equal(plain(text!, "missing"), said);
  assert.equal(
    plain(
      "No request that could change data left the browser (4 the scope allows as reads); pages opened: notes.test/, notes.test/pinned",
      "same",
    ),
    "Nothing that could change data left the browser; pages opened: notes.test/, notes.test/pinned",
  );
  // What it says now, said again: the same words.
  for (const said of [
    "The Save button isn't on the page",
    "The Save button is on the page, 12 px lower than expected",
    "The screen looks different than expected",
    "The screen, kept for comparison",
    "It stopped before the end",
    "Nothing that could change data left the browser",
  ])
    assert.equal(
      plain(said, said.includes("isn't") || said.startsWith("It") ? "missing" : "found"),
      said,
    );
});

test("a video's marks in plain words: no scores, no thresholds, compared with what it was", () => {
  const box = { h: 1, w: 1, x: 0, y: 0 };
  const raw = video({
    badges: [
      { end: 2, start: 1, text: "0.00% different from the reference", tone: "pass" },
      { end: 3, start: 2, text: "4.00% different from the reference", tone: "warn" },
      { end: 5, start: 4, text: "The journey stops here", tone: "fail" },
    ],
    checks: [
      { at: 1, text: "The list: 0.91 alike, 12 px lower than in the reference", verdict: "moved" },
      {
        at: 4,
        text: "The screen: 4.00% different from the reference (2.00% allowed)",
        verdict: "differs",
      },
      {
        at: 5,
        text: "Couldn't find “Esqueci minha senha”: the closest is 0.58 alike, and it needs 0.75",
        verdict: "missing",
      },
    ],
    lines: [
      {
        end: 2,
        start: 1,
        text: "Couldn't find “Esqueci minha senha”: the closest is 0.58 alike, and it needs 0.75",
      },
      {
        end: 3,
        start: 2,
        text: "Couldn't find the “Segurança” tab: the closest is 0.54 alike, and it needs 0.75",
      },
      { end: 4, start: 3, text: "See the budget, R$ 120.000,00" },
      { end: 5, start: 4, text: "The screen looks as it should" },
      { end: 6, start: 5, text: "The screen looks different" },
      { end: 7, start: 6, text: "The screen: 1.25% different from the reference (2.00% allowed)" },
      { end: 8, start: 7, text: "The screen, kept as the reference" },
    ],
    rings: [
      { box, end: 2, label: "0.98 alike", start: 1, tone: "found" },
      { box, end: 2, label: "the closest: 0.58 alike", start: 1, tone: "missing" },
      {
        box,
        end: 2,
        label: "0.91 alike · 12 px lower than in the reference",
        start: 1,
        tone: "found",
      },
      { box, end: 2, label: "picture kept", start: 1, tone: "found" },
      { box, end: 2, start: 1, tone: "was" },
    ],
  });

  // Against what its own reference run kept: expected.
  const expected = plainVideo(raw);
  assert.deepEqual(
    expected.lines.map((l) => l.text),
    [
      "“Esqueci minha senha” isn't on the page",
      "The “Segurança” tab isn't on the page",
      "See the budget, R$ 120.000,00",
      "The screen looks as expected",
      "The screen looks different than expected",
      "The screen looks as expected",
      "The screen, kept for comparison",
    ],
  );
  assert.deepEqual(
    expected.rings.map((r) => r.label),
    [undefined, "The closest", "12 px lower than expected", "Picture kept", undefined],
  );
  assert.deepEqual(
    expected.badges.map((b) => b.text),
    [
      "The screen looks as expected",
      "The screen looks different than expected",
      "The journey stops here",
    ],
  );
  assert.deepEqual(
    expected.checks.map((c) => [c.verdict, c.text]),
    [
      ["moved", "The list is on the page, 12 px lower than expected"],
      ["differs", "The screen looks different than expected"],
      ["missing", "“Esqueci minha senha” isn't on the page"],
    ],
  );

  // A compared run's Before video, against this change, whatever the run named its head;
  // the same from the video.json as from its words kept against what was expected.
  for (const change of [plainVideo(raw, "this pull request"), plainVideo(expected, "pin-notes")]) {
    assert.deepEqual(
      change.lines.slice(3).map((l) => l.text),
      [
        "The screen looks as it does in this change",
        "The screen looks different in this change",
        "The screen looks as it does in this change",
        "The screen, kept for comparison",
      ],
    );
    assert.equal(change.rings[2]!.label, "12 px lower than in this change");
    assert.deepEqual(
      change.badges.map((b) => b.text),
      [
        "The screen looks as it does in this change",
        "The screen looks different in this change",
        "The journey stops here",
      ],
    );
    assert.deepEqual(
      change.checks.map((c) => c.text),
      [
        "The list is on the page, 12 px lower than in this change",
        "The screen looks different in this change",
        "“Esqueci minha senha” isn't on the page",
      ],
    );
  }
  // The words it kept before, read again.
  const older = video({
    badges: [{ end: 2, start: 1, text: "Looks as in this pull request", tone: "pass" }],
    // A screen's caption kept without what was allowed: its check says it looked the same.
    checks: [
      {
        at: 3,
        text: "The screen: 1.25% different from the reference (2.00% allowed)",
        verdict: "same",
      },
    ],
    lines: [
      { end: 2, start: 1, text: "The screen looks different from the reference" },
      { end: 4, start: 3, text: "The screen: 1.25% different from the reference" },
    ],
    rings: [{ box, end: 2, label: "12 px lower than in pin-notes", start: 1, tone: "found" }],
  });
  const reread = plainVideo(older);
  assert.equal(reread.badges[0]!.text, "The screen looks as expected");
  assert.deepEqual(
    reread.lines.map((l) => l.text),
    ["The screen looks different than expected", "The screen looks as expected"],
  );
  assert.equal(reread.rings[0]!.label, "12 px lower than expected");

  // Main's page: main is not wrong. What was compared is left out, and nothing moved.
  const main = plainVideo(expected, null);
  assert.deepEqual(
    main.lines.map((l) => l.text),
    [
      "“Esqueci minha senha” isn't on the page",
      "The “Segurança” tab isn't on the page",
      "See the budget, R$ 120.000,00",
      "The screen, kept for comparison",
    ],
  );
  assert.deepEqual(
    main.checks.map((c) => [c.verdict, c.text]),
    [
      ["found", "The list is on the page"],
      ["missing", "“Esqueci minha senha” isn't on the page"],
    ],
  );
  assert.deepEqual(
    main.badges.map((b) => b.text),
    ["The journey stops here"],
  );
  assert.deepEqual(
    main.rings.map((r) => [r.tone, r.label]),
    [
      ["found", undefined],
      ["missing", "The closest"],
      ["found", undefined],
      ["found", "Picture kept"],
    ],
  );
});

const refs: Array<VideoRef> = [
  { kind: "main", name: "main" },
  { kind: "pull", name: "ana/forgot-password", pull: 88 },
  { kind: "branch", name: "pom/pr-88-journeys" },
  { kind: "run", name: "c0b7b3ad86b6-5e5825ea" },
];

test("a ref is the longest a branch's slashes allow, HEAD is main, else a commit; the rest is the path", () => {
  assert.deepEqual(askAt(refs, "ana/forgot-password/apps/notes/spec/login/reset.feature"), {
    ask: { pull: 88 },
    path: "apps/notes/spec/login/reset.feature",
    ref: "ana/forgot-password",
  });
  assert.deepEqual(askAt(refs, "main/apps/notes/spec/tour.feature")?.ask, { main: true });
  assert.deepEqual(askAt(refs, "HEAD/apps/notes/spec/tour.feature")?.ask, { main: true });
  assert.deepEqual(askAt(refs, "pom/pr-88-journeys")?.ask, { branch: "pom/pr-88-journeys" });
  assert.deepEqual(askAt(refs, "e0b132f27fc2/x.feature"), {
    ask: { commit: "e0b132f27fc2" },
    path: "x.feature",
    ref: "e0b132f27fc2",
  });
  assert.deepEqual(askAt(refs, "c0b7b3ad86b6-5e5825ea/x.feature")?.ask, {
    commit: "c0b7b3ad86b6-5e5825ea",
  });
  assert.equal(askAt(refs, "ana/nowhere"), null);
  assert.equal(askAt(refs, "abc"), null);
  // HEAD is main wherever main is listed.
  assert.deepEqual(askAt(refs.toReversed(), "HEAD/apps/notes/spec/tour.feature")?.ask, {
    main: true,
  });
});

const repo: VideoRepo = { name: "notes", owner: "acme", prefix: "apps/notes/spec/" };

/** How a run's videos are named, as the service answers them. */
type Named = Parameters<typeof homeOf>[1];
const named = (
  scope: Named["scope"],
  extra: Partial<Pick<Named, "pinRun" | "ref">> = {},
): Named => ({
  pinRun: null,
  ref: scope.kind === "pull" && !scope.pinned ? "ana/forgot-password" : "e0b132f",
  scope,
  ...extra,
});

test("addresses GitHub could read, under /github/: a commit, and which of its runs only in a query it ignores", () => {
  assert.equal(repoAddress(repo), "/github/acme/notes");
  assert.equal(pullAddress(repo, 88), "/github/acme/notes/pull/88");
  assert.equal(
    blobAt({ ...repo, prefix: "" }, "ana/forgot-password"),
    "/github/acme/notes/blob/ana/forgot-password",
  );
  const pull = named({ kind: "pull", number: 88, pinned: null, run: "e0b132f27fc2" });
  assert.equal(journeysAddress(repo, pull), "/github/acme/notes/pull/88");
  assert.equal(
    videoAddress(homeOf(repo, pull), "login/reset-a-forgotten-password.journey.ts", { t: 7 }),
    "/github/acme/notes/blob/ana/forgot-password/apps/notes/spec/login/reset-a-forgotten-password.feature?t=7.0",
  );
  const older = named(
    { kind: "pull", number: 88, pinned: "c0b7b3a", run: "e0b132f27fc2" },
    { pinRun: "c0b7b3ad86b6-5e5825ea", ref: "c0b7b3a" },
  );
  assert.equal(
    journeysAddress(repo, older),
    "/github/acme/notes/pull/88/commits/c0b7b3a?run=c0b7b3ad86b6-5e5825ea",
  );
  assert.equal(
    videoAddress(homeOf(repo, older), "[username]/browse-a-portfolio.journey.ts", {
      side: "main",
    }),
    "/github/acme/notes/blob/c0b7b3a/apps/notes/spec/[username]/browse-a-portfolio.feature?run=c0b7b3ad86b6-5e5825ea&side=main",
  );
  const main = named({ kind: "main", sha: "976eb34" }, { ref: "main" });
  assert.equal(journeysAddress(repo, main), "/github/acme/notes");
  assert.equal(
    videoAddress(homeOf(repo, main), "tour-the-demo.journey.ts", { mode: "reference", t: 0.01 }),
    "/github/acme/notes/blob/main/apps/notes/spec/tour-the-demo.feature?mode=reference",
  );
  assert.equal(
    journeysAddress(repo, named({ kind: "commit", ref: "e0b132f" })),
    "/github/acme/notes/commit/e0b132f",
  );
  assert.equal(
    journeysAddress(repo, named({ kind: "branch", name: "ana/forgot password" })),
    "/github/acme/notes/tree/ana/forgot%20password",
  );
});

test("a project's addresses have the same shapes under its own: pull, blob, tree, commit and commits", () => {
  const project = { project: "notes" };
  const place = { ...project, prefix: "apps/notes/spec/" };
  assert.equal(projectAddress("notes"), "/notes");
  assert.equal(pullAddress(project, 88), "/notes/pull/88");
  assert.equal(
    pullAddress(project, 88, { ref: "c0b7b3a", run: "c0b7b3ad86b6-5e5825ea" }),
    "/notes/pull/88/commits/c0b7b3a?run=c0b7b3ad86b6-5e5825ea",
  );
  assert.equal(blobAt({ ...project, prefix: "" }, "main"), "/notes/blob/main");
  const pull = named({ kind: "pull", number: 88, pinned: null, run: "e0b132f27fc2" });
  assert.equal(journeysAddress(project, pull), "/notes/pull/88");
  assert.equal(
    videoAddress(homeOf(place, pull), "login/reset-a-forgotten-password.journey.ts", { t: 7 }),
    "/notes/blob/ana/forgot-password/apps/notes/spec/login/reset-a-forgotten-password.feature?t=7.0",
  );
  const main = named({ kind: "main", sha: "976eb34" }, { ref: "main" });
  assert.equal(journeysAddress(project, main), "/notes");
  assert.equal(
    journeysAddress(project, named({ kind: "commit", ref: "e0b132f" })),
    "/notes/commit/e0b132f",
  );
  assert.equal(
    journeysAddress(project, named({ kind: "branch", name: "ana/forgot password" })),
    "/notes/tree/ana/forgot%20password",
  );
  // A repository's object names its owner, whatever else it carries: its address is GitHub's.
  assert.equal(pullAddress({ ...repo, project: "notes" }, 88), "/github/acme/notes/pull/88");
});
