import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { type Diff, markdown } from "./diff.ts";
import { LIMITS } from "./service.ts";

// `pom pr`: the pull request's pictures in its description, from the person's own
// machine with their own `gh` (which uploads them as GitHub attachments: kept with
// the pull request, seen only by who can see it, videos played inline). pom owns one
// section of the description, between `<!-- pom:start … -->` and `<!-- pom:end -->`,
// rewritten in place; a section written for a newer commit is never overwritten.
//
// gh attaches at most 50 files a command, and videos up to 100 MB: what does not fit
// is said, with where pomspec keeps it (a video only while it fits pomspec's own limit).

export const START = /<!-- pom:start commit=([0-9a-f]{7,40}) -->[\s\S]*?<!-- pom:end -->/;

/** gh attaches at most this many files a command. */
export const MAX_FILES = 50;

/** Where pomspec is offered, after what did not fit and pomspec would keep. */
export const HOSTING = "pomspec shows every video and picture: https://pomspec.com/pricing";
/** The one quiet line under every section. */
export const QUIET =
  "Everything here stays with this pull request. pomspec keeps your team's videos in one place, to watch and comment on: https://pomspec.com/pricing";

export type Attachment = Readonly<{ file: string; kind: "picture" | "video" }>;

export type Section = Readonly<{
  attached: ReadonlyArray<Attachment>;
  body: string;
  /** What did not fit, as the section says it. */
  left: ReadonlyArray<string>;
}>;

const mb = (bytes: number) => `${Math.round(bytes / 1e5) / 10} MB`;

/**
 * The section for a diff: its before|after pictures (desktop first), then each changed
 * journey's video, up to gh's 50 files; the rest named, with the hosting note.
 */
export function section(input: {
  commit: string;
  diff: Diff;
  dir: string;
  maxMB: number;
  videos: ReadonlyMap<string, string>;
}): Section {
  const { diff, dir } = input;
  const pictures: Array<string> = [];
  const widthOrder = (width: string) => (width === "desktop" ? 0 : 1);
  for (const journey of diff.journeys.filter((j) => j.status !== "unchanged")) {
    for (const moment of journey.moments.filter((m) => m.status !== "unchanged")) {
      for (const [, change] of Object.entries(moment.widths).sort(
        ([a], [b]) => widthOrder(a) - widthOrder(b),
      )) {
        const file = change.pair ?? change.after ?? change.before;
        if (file) pictures.push(file);
      }
    }
  }
  /** What did not fit, and whether pomspec would keep it: then said with where. */
  const left: Array<Readonly<{ hosted: boolean; line: string }>> = [];
  const videos: Array<Readonly<{ file: string; title: string }>> = [];
  for (const journey of diff.journeys.filter(
    (j) => j.status !== "unchanged" && j.status !== "removed",
  )) {
    const video = input.videos.get(journey.journey);
    if (!video || !existsSync(video)) continue;
    const size = statSync(video).size;
    if (size > input.maxMB * 1e6) {
      left.push({
        // pomspec keeps a video of this much at most (its limit for one file).
        hosted: size <= LIMITS.file,
        line: `The video of ${journey.title} is ${mb(size)}, and GitHub plays up to ${input.maxMB} MB.`,
      });
      continue;
    }
    const copy = path.join(
      dir,
      `${journey.journey.replace(/[^\w.-]+/g, "-")}${path.extname(video)}`,
    );
    copyFileSync(video, copy);
    videos.push({ file: copy, title: journey.title });
  }
  const room = MAX_FILES - videos.length;
  const kept = new Set(pictures.slice(0, Math.max(0, room)));
  const out = pictures.length - kept.size;
  if (out > 0) {
    left.push({
      hosted: true,
      line: `${out === 1 ? "1 picture" : `${out} pictures`} left out: GitHub takes ${MAX_FILES} files at once.`,
    });
  }
  const rel = (file: string) => `./${path.relative(dir, file)}`;
  const lines = [
    `<!-- pom:start commit=${input.commit} -->`,
    markdown(diff, dir, (file) => kept.has(file)).trim(),
  ];
  // Each video said in words for whoever cannot see it, as its pictures are.
  const alt = (text: string) => text.replace(/\s+/g, " ").replace(/[\\[\]]/g, (c) => `\\${c}`);
  if (videos.length) {
    lines.push(
      "",
      ...videos.flatMap((video) => [`![Video of ${alt(video.title)}](${rel(video.file)})`, ""]),
    );
  }
  if (left.length) {
    lines.push("", ...left.map(({ hosted, line }) => `> ${hosted ? `${line} ${HOSTING}` : line}`));
  }
  lines.push("", `<sub>${QUIET}</sub>`, "<!-- pom:end -->");
  return {
    attached: [
      ...[...kept].map((file) => ({ file, kind: "picture" as const })),
      ...videos.map(({ file }) => ({ file, kind: "video" as const })),
    ],
    body: lines.join("\n").replace(/\n{3,}/g, "\n\n"),
    left: left.map(({ line }) => line),
  };
}

/** The description with pom's section in place of the old one, or after what is there. */
export function withSection(body: string, own: string): string {
  if (START.test(body)) return body.replace(START, () => own);
  return body.trim() ? `${body.trimEnd()}\n\n${own}\n` : `${own}\n`;
}

/** Whether the description's section was written for a commit newer than `ours` (one ours leads to). */
export function newer(
  body: string,
  ours: string,
  isAncestor: (a: string, b: string) => boolean,
): boolean {
  const found = START.exec(body);
  if (!found) return false;
  const theirs = found[1]!;
  if (ours.startsWith(theirs) || theirs.startsWith(ours)) return false;
  // A commit this clone does not have is treated as older: the pull request's head is ours.
  try {
    return isAncestor(ours, theirs);
  } catch {
    return false;
  }
}

const gh = (args: ReadonlyArray<string>, cwd: string, input?: string) =>
  execFileSync("gh", args, { cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });

export type PullRequest = Readonly<{ body: string; head: string; number: number; url: string }>;

/** gh 2.99 or later (it attaches files); the branch's pull request. */
export function pullRequest(cwd: string): PullRequest {
  const version = /gh version (\d+)\.(\d+)/.exec(gh(["--version"], cwd));
  if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 99)) {
    throw new Error("pom pr attaches pictures with gh 2.99 or later: gh upgrade");
  }
  const found = JSON.parse(gh(["pr", "view", "--json", "number,headRefOid,body,url"], cwd)) as {
    body: string;
    headRefOid: string;
    number: number;
    url: string;
  };
  return { body: found.body, head: found.headRefOid, number: found.number, url: found.url };
}

/** Rewrites the description through gh, attaching the section's files (gh rewrites their `./` references). */
export function publish(
  pr: PullRequest,
  body: string,
  attached: ReadonlyArray<Attachment>,
  dir: string,
) {
  const run = spawnSync(
    "gh",
    [
      "pr",
      "edit",
      String(pr.number),
      "--body-file",
      "-",
      ...attached.flatMap((a) => ["--attach", `./${path.relative(dir, a.file)}`]),
    ],
    { cwd: dir, encoding: "utf8", input: body, stdio: ["pipe", "pipe", "pipe"] },
  );
  if (run.status !== 0) {
    throw new Error(
      `gh couldn't write the pull request's description: ${(run.stderr || run.stdout).trim()}`,
    );
  }
}
