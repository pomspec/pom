import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
import { compare, pair } from "./png.ts";
import { committedDir, entryOf } from "./shots.ts";
import { filesAt, isLfsPointer, showAt } from "./source.ts";
import type { Spec } from "./spec.ts";
import type { Manifest, Moment, Renderer, Width } from "./types.ts";

// Before and after: a pull request's pictures against its base's. Pictures are read
// from wherever they were kept — pom's own store (by the code that drew them), or a
// commit, where a repository commits them — and compared like with like: the same
// platform and Playwright, or not at all. Moments pair by id, else by their place in
// their step; a picture changed when it differs past the threshold.

/** Where a side's pictures come from: a folder of journeys, or a commit's files. */
export type Side = Readonly<{
  manifests: ReadonlyMap<string, Manifest>;
  picture: (journey: string, file: string) => Buffer | null;
  /** How the pictures were found, for a person. */
  said: string;
}>;

/** The journeys pictured in a store's entry (`.pom/shots/<source>/<renderer>/`). */
export function storeSide(entry: string, said: string): Side | null {
  if (!existsSync(entry)) return null;
  const manifests = new Map<string, Manifest>();
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (!statSync(full).isDirectory()) continue;
      const file = path.join(full, "shots.json");
      if (existsSync(file)) {
        const manifest = JSON.parse(readFileSync(file, "utf8")) as Manifest;
        manifests.set(manifest.journey, manifest);
      } else visit(full);
    }
  };
  visit(entry);
  return {
    manifests,
    picture: (journey, file) => {
      const at = path.join(entry, journey, file);
      return existsSync(at) ? readFileSync(at) : null;
    },
    said,
  };
}

/** The checkpoints a commit holds beside its journeys (a repository that commits them). */
export function commitSide(config: Config, spec: Spec, ref: string): Side {
  const manifests = new Map<string, Manifest>();
  for (const file of filesAt(config, ref, spec.root)) {
    if (!file.endsWith(`.shots${path.sep}shots.json`)) continue;
    const bytes = showAt(config, ref, file);
    if (!bytes) continue;
    const manifest = JSON.parse(bytes.toString("utf8")) as Manifest;
    manifests.set(manifest.journey, manifest);
  }
  return {
    manifests,
    picture: (journey, file) => {
      const bytes = showAt(config, ref, path.join(committedDir(spec, journey), file));
      if (bytes && isLfsPointer(bytes)) {
        throw new Error(
          `${journey}'s pictures are in Git LFS, so git holds only pointers: add "spec/**/*.png -filter -diff -merge" to .gitattributes`,
        );
      }
      return bytes;
    },
    said: `committed at ${ref.slice(0, 7)}`,
  };
}

export type WidthChange = Readonly<{
  after: string | null;
  before: string | null;
  diff: string | null;
  pair: string | null;
  ratio: number;
}>;

export type MomentChange = Readonly<{
  after: Moment | null;
  before: Moment | null;
  /** `reworded`: paired by its place in its step, its line changed. */
  status: "added" | "changed" | "removed" | "reworded" | "unchanged";
  widths: Readonly<Record<Width, WidthChange>>;
}>;

export type JourneyChange = Readonly<{
  journey: string;
  moments: ReadonlyArray<MomentChange>;
  status: "added" | "changed" | "removed" | "unchanged";
  title: string;
}>;

export type Diff = Readonly<{
  after: string;
  before: string | null;
  journeys: ReadonlyArray<JourneyChange>;
  /** Said when the base cannot be compared: another renderer, or none at all. */
  notes: ReadonlyArray<string>;
}>;

const pictured = (moments: ReadonlyArray<Moment>) =>
  moments.filter((m) => m.checkpoint && m.pictures);

/**
 * Pairs a base journey's checkpoints with the head's: by id, else by their place among
 * the unpaired of the same step; what is left was added or removed.
 */
export function pairMoments(
  before: ReadonlyArray<Moment>,
  after: ReadonlyArray<Moment>,
): Array<{ after: Moment | null; before: Moment | null; reworded: boolean }> {
  const out: Array<{ after: Moment | null; before: Moment | null; reworded: boolean }> = [];
  const left = new Set(before);
  const right = new Set(after);
  for (const b of before) {
    const a = after.find((m) => m.id === b.id && right.has(m));
    if (!a) continue;
    out.push({ after: a, before: b, reworded: false });
    left.delete(b);
    right.delete(a);
  }
  // Deleting the moment at hand while iterating a Set is safe: the rest are still visited.
  for (const b of left) {
    const sameStep = (moments: Iterable<Moment>) => [...moments].filter((m) => m.step === b.step);
    const place = sameStep(left).indexOf(b);
    const a = sameStep(right)[place];
    if (!a) continue;
    out.push({ after: a, before: b, reworded: true });
    left.delete(b);
    right.delete(a);
  }
  for (const b of left) out.push({ after: null, before: b, reworded: false });
  for (const a of right) out.push({ after: a, before: null, reworded: false });
  const order = (p: { after: Moment | null; before: Moment | null }) => {
    const m = p.after ?? p.before!;
    return m.step * 1000 + m.index;
  };
  return out.sort((x, y) => order(x) - order(y));
}

const sameRenderer = (a: Renderer, b: Renderer) =>
  a.platform === b.platform && a.playwright === b.playwright;

const flat = (journey: string) => journey.replace(/[^\w.-]+/g, "-").replace(/^-|-$/g, "");

/** Compares two sides' journeys, writing what changed into `dir` (cleared first). */
export function diff(input: {
  after: Side;
  before: Side | null;
  config: Config;
  dir: string;
}): Diff {
  const { after, before, config, dir } = input;
  rmSync(dir, { force: true, recursive: true });
  mkdirSync(dir, { recursive: true });
  const notes: Array<string> = [];
  const journeys: Array<JourneyChange> = [];
  const write = (name: string, bytes: Buffer) => {
    const file = path.join(dir, name);
    writeFileSync(file, bytes);
    return file;
  };
  const ids = new Set([...after.manifests.keys(), ...(before?.manifests.keys() ?? [])]);
  for (const id of [...ids].sort()) {
    const head = after.manifests.get(id) ?? null;
    const base = before?.manifests.get(id) ?? null;
    if (head && base && !sameRenderer(head.renderer, base.renderer)) {
      notes.push(
        `${head.title} wasn't compared: Before was pictured on ${base.renderer.platform} with Playwright ${base.renderer.playwright}, After on ${head.renderer.platform} with Playwright ${head.renderer.playwright}. Picture both on one machine, or let CI do it.`,
      );
      continue;
    }
    const pairs = pairMoments(
      base ? pictured(base.moments) : [],
      head ? pictured(head.moments) : [],
    );
    const moments: Array<MomentChange> = pairs.map(({ after: a, before: b, reworded }) => {
      const widths: Record<Width, WidthChange> = {};
      let changed = false;
      for (const width of Object.keys((a ?? b)!.pictures ?? {})) {
        const pa = a?.pictures?.[width];
        const pb = b?.pictures?.[width];
        const bytesA = pa ? after.picture(id, pa.file) : null;
        const bytesB = pb && before ? before.picture(id, pb.file) : null;
        const name = `${flat(id)}--${width}--${(a ?? b)!.id}`;
        if (bytesA && bytesB) {
          const same =
            pa!.sha256 === pb!.sha256 || !compare(bytesB, bytesA, config.threshold).changed;
          if (same) {
            widths[width] = { after: null, before: null, diff: null, pair: null, ratio: 0 };
            continue;
          }
          const compared = compare(bytesB, bytesA, config.threshold);
          changed = true;
          widths[width] = {
            after: write(`${name}.after.png`, bytesA),
            before: write(`${name}.before.png`, bytesB),
            diff: compared.diff ? write(`${name}.diff.png`, compared.diff) : null,
            pair: write(`${name}.pair.png`, pair(bytesB, bytesA)),
            ratio: compared.ratio,
          };
        } else {
          widths[width] = {
            after: bytesA ? write(`${name}.after.png`, bytesA) : null,
            before: bytesB ? write(`${name}.before.png`, bytesB) : null,
            diff: null,
            pair: null,
            ratio: 1,
          };
        }
      }
      const status: MomentChange["status"] = !b
        ? "added"
        : !a
          ? "removed"
          : changed
            ? "changed"
            : reworded
              ? "reworded"
              : "unchanged";
      return { after: a, before: b, status, widths };
    });
    journeys.push({
      journey: id,
      moments,
      status: !base
        ? "added"
        : !head
          ? "removed"
          : moments.some((m) => m.status !== "unchanged")
            ? "changed"
            : "unchanged",
      title: (head ?? base)!.title,
    });
  }
  const result: Diff = { after: after.said, before: before?.said ?? null, journeys, notes };
  writeFileSync(path.join(dir, "diff.json"), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(path.join(dir, "diff.md"), markdown(result, dir));
  writeFileSync(path.join(dir, "diff.html"), html(result, dir));
  return result;
}

/** The base's store entry, if this source was pictured by this renderer. */
export const storeEntry = (out: string, source: string, renderer: Renderer) =>
  storeSide(entryOf(out, source, renderer), `pictured from ${source.slice(0, 7)}`);

const line = (m: Moment | null) => m?.after?.source ?? "The start";

const counts = (diff: Diff) => {
  const changed = diff.journeys.filter((j) => j.status !== "unchanged");
  const screens = changed.flatMap((j) => j.moments.filter((m) => m.status !== "unchanged"));
  return { changed, screens };
};

/**
 * A diff as Markdown, its pictures referenced relative to `dir` (`./x.pair.png`), as
 * `gh --attach` rewrites them: each changed journey with its changed moments, the
 * first width's before|after inline and the other widths' folded under it.
 */
export function markdown(
  diff: Diff,
  dir: string,
  pictures: (file: string) => boolean = () => true,
): string {
  const rel = (file: string) => `./${path.relative(dir, file)}`;
  const { changed, screens } = counts(diff);
  const out: Array<string> = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (diff.before === null) {
    out.push(
      `**Journeys** · ${plural(diff.journeys.length, "journey", "journeys")} pictured · nothing to compare with yet`,
      "",
    );
  } else if (changed.length === 0) {
    out.push("**Pictures** · no visual change", "");
  } else {
    out.push(
      `**Pictures** · ${plural(changed.length, "journey", "journeys")} changed · ${plural(screens.length, "screen", "screens")} · Before \\| After`,
      "",
    );
  }
  for (const note of diff.notes) out.push(`> ${note}`, "");
  for (const journey of changed) {
    const shown = journey.moments.filter((m) => m.status !== "unchanged");
    const said =
      journey.status === "added"
        ? "New"
        : journey.status === "removed"
          ? "Removed"
          : `${shown.length} of ${plural(journey.moments.length, "screen", "screens")} changed`;
    out.push(`<details open><summary><b>${journey.title}</b> · ${said}</summary>`, "");
    const widths = [...new Set(shown.flatMap((m) => Object.keys(m.widths)))];
    const block = (width: string) => {
      const lines: Array<string> = [];
      for (const moment of shown) {
        const change = moment.widths[width];
        const file = change ? (change.pair ?? change.after ?? change.before) : null;
        if (!file || !pictures(file)) continue;
        const name = line(moment.after ?? moment.before);
        lines.push(
          `${name}${moment.status === "changed" ? "" : ` · ${moment.status}`}`,
          "",
          `![${name}](${rel(file)})`,
          "",
        );
      }
      return lines;
    };
    const [first, ...rest] = widths;
    if (first) out.push(...block(first));
    for (const width of rest) {
      const lines = block(width);
      if (lines.length)
        out.push(`<details><summary>${width}</summary>`, "", ...lines, "</details>", "");
    }
    out.push("</details>", "");
  }
  return `${out.join("\n").trim()}\n`;
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A diff as a page of its own, beside its pictures: side by side, and the changes in red. */
export function html(diff: Diff, dir: string): string {
  const rel = (file: string | null) => (file ? escapeHtml(path.relative(dir, file)) : "");
  const rows = counts(diff).changed.map((journey) => {
    const moments = journey.moments
      .filter((m) => m.status !== "unchanged")
      .flatMap((moment) =>
        Object.entries(moment.widths).map(
          ([
            width,
            change,
          ]) => `<section><h3>${escapeHtml(line(moment.after ?? moment.before))} <small>${width} · ${moment.status}</small></h3>
<div class="row">${change.before ? `<figure><img src="${rel(change.before)}"><figcaption>Before</figcaption></figure>` : ""}${change.after ? `<figure><img src="${rel(change.after)}"><figcaption>After</figcaption></figure>` : ""}${change.diff ? `<figure><img src="${rel(change.diff)}"><figcaption>Changes</figcaption></figure>` : ""}</div></section>`,
        ),
      );
    return `<article><h2>${escapeHtml(journey.title)}</h2>${moments.join("\n")}</article>`;
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pictures, before and after</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px;color:#1f2430;background:#fff}h2{margin:32px 0 8px}h3{font-size:15px;font-weight:600}small{color:#6b7280;font-weight:400}.row{display:flex;gap:12px;flex-wrap:wrap}figure{margin:0;flex:1 1 300px}img{width:100%;border:1px solid #e5e7eb}figcaption{color:#6b7280;font-size:13px}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}img{border-color:#333}}</style>
</head><body><h1>Pictures, before and after</h1>
${diff.notes.map((note) => `<p>${escapeHtml(note)}</p>`).join("\n")}
${rows.length ? rows.join("\n") : "<p>No visual change.</p>"}
</body></html>
`;
}
