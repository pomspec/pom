import type { Call, Compiled } from "./check.ts";
import type { Line } from "./feature.ts";
import type { Box, Manifest, Moment, MomentPicture, Renderer, Taken, Width } from "./types.ts";

// A journey's moments: its start, then the screen after each acting line (a press,
// a fill…), once the lines after it have seen it settle — taken just before the next
// acting line, or at the end. Every moment is a frame (in `.pom/` and the video); a
// checkpoint is a moment whose screen's structure changed: the start, the end, and
// each moment whose accessibility outline gained or lost a node at any width.
//
// The rule is env/spec-doc's `structure()`/`breakpoints()`, ported: keep them alike.
// A pom moment is spec-doc's state after the line before it, and carries the kit's
// breakpoint key, `(step, index)`, index −1 being the start.

/** The lines a person acts with: each leaves a moment after it. */
export const ACTING: ReadonlySet<string> = new Set(["check", "fill", "key", "press", "select"]);

const acts = (line: Line) => ACTING.has(line.action.verb);

/** The verb as the line says it: a link is followed, anything else pressed. */
export function verbOf(line: Line): string {
  const { action } = line;
  if (action.verb === "press" && /^(?:When|And|But) I follow /.test(line.source)) return "follow";
  if (action.verb === "check") return action.checked ? "check" : "uncheck";
  return action.verb;
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "x";

/** What the line acts on, by name: a field's or a control's. */
function named(line: Line): string | null {
  const { action } = line;
  if (action.verb === "key") return action.key;
  return "name" in action ? action.name : null;
}

/**
 * Moment ids, in a journey's order: `start`, then each acting line's verb and name
 * (`press-create-account`), `-2`… when one repeats. A typed value is never part of
 * one, so a journey's moments keep their names when what it types changes.
 */
export function momentIds(): (line: Line | null) => string {
  const used = new Map<string, number>();
  return (line) => {
    const base = line ? `${verbOf(line)}-${slug(named(line) ?? "")}` : "start";
    const seen = (used.get(base) ?? 0) + 1;
    used.set(base, seen);
    return seen === 1 ? base : `${base}-${seen}`;
  };
}

/** A moment's static part: what the generated test knows before it runs. */
export type Planned = Readonly<Omit<Moment, "checkpoint" | "pictures">> &
  Readonly<{
    /** The next acting line's locator, whose box the picture records. */
    target: string | null;
  }>;

/**
 * A journey's moments, in order, each with the call it is taken before (`null`: at
 * the end). Ids are the line that made the screen (`press-create-account`), `start`
 * for the first, `-2`… when a line repeats; a typed value is never part of one.
 */
export function plan(
  compiled: Compiled,
  journey: string,
): Array<Planned & Readonly<{ before: Call | null }>> {
  const steps: Array<{ calls: ReadonlyArray<Call>; step: number }> = [
    { calls: compiled.background, step: 0 },
    ...compiled.steps.map((step, index) => ({ calls: step.calls, step: index })),
  ];
  const ordered = steps.flatMap(({ calls, step }, which) =>
    calls.map((call) => ({
      call,
      // A background's lines come before the first step; they count as its start.
      index: which === 0 ? -1 : calls.indexOf(call),
      step,
    })),
  );
  const out: Array<Planned & Readonly<{ before: Call | null }>> = [];
  const idFor = momentIds();
  let after: (typeof ordered)[number] | null = null;
  let page: string | null = null;
  const lastLine = ordered.at(-1)?.call.line ?? null;
  const push = (before: (typeof ordered)[number] | null) => {
    const next = before?.call.line ?? null;
    out.push({
      after: after ? { line: after.call.line.line, source: after.call.line.source } : null,
      before: before?.call ?? null,
      id: idFor(after?.call.line ?? null),
      index: after ? after.index : -1,
      journey,
      next: next
        ? {
            line: next.line,
            name: named(next),
            role: next.action.verb === "press" ? next.action.role : null,
            verb: verbOf(next),
          }
        : null,
      page,
      role: next?.role ?? lastLine?.role ?? compiled.journey.endsAs,
      state: next?.state ?? lastLine?.state ?? null,
      step: after ? after.step : 0,
      target: before?.call.target ?? null,
    });
  };
  for (const entry of ordered) {
    if (acts(entry.call.line)) {
      push(entry);
      after = entry;
    }
    page = entry.call.page?.route ?? page;
  }
  push(null);
  return out;
}

/**
 * A screen's structure: its outline without what a person types (a field's
 * value) or a control's passing state (`[disabled]`, `[checked]`…; a heading's
 * level stays). Typing is not a checkpoint; a dialog opening, a row appearing is.
 */
export const structure = (yaml: string): Array<string> =>
  yaml
    .split("\n")
    .map((line) =>
      line
        .replace(
          /^(\s*- (?:textbox|searchbox|combobox|spinbutton|slider)(?: "(?:[^"\\]|\\.)*")?)(?: \[[^\]]*\])*: .*$/,
          "$1",
        )
        .replace(/ \[(?!level=)[^\]]*\]/g, ""),
    )
    .filter((line) => line.trim());

/**
 * The nodes of `a` that `b` has no match for, each only where its parent had
 * one: a dialog that opened is one change, not one per control in it.
 */
export function changed(a: ReadonlyArray<string>, b: ReadonlyArray<string>): Array<string> {
  const left = new Map<string, number>();
  for (const line of b) left.set(line.trim(), (left.get(line.trim()) ?? 0) + 1);
  const found: Array<string> = [];
  let within: number | null = null;
  for (const line of a) {
    const depth = line.length - line.trimStart().length;
    if (within !== null && depth > within) continue;
    within = null;
    const n = left.get(line.trim()) ?? 0;
    if (n > 0) {
      left.set(line.trim(), n - 1);
    } else {
      found.push(line.trim().replace(/:$/, ""));
      within = depth;
    }
  }
  return found.slice(0, 8);
}

/**
 * Which moments are checkpoints, given each moment's outline at each width: the
 * first, the last, and any whose structure differs from the last checkpoint's at
 * any width. With what appeared and went, at the first width that changed.
 */
export function checkpoints(
  outlines: ReadonlyArray<Readonly<Record<Width, string>>>,
): Array<{ added: Array<string>; checkpoint: boolean; removed: Array<string> }> {
  const last = new Map<Width, Array<string>>();
  return outlines.map((byWidth, index) => {
    const now = new Map(Object.entries(byWidth).map(([width, yaml]) => [width, structure(yaml)]));
    let added: Array<string> = [];
    let removed: Array<string> = [];
    let differs = false;
    for (const [width, lines] of now) {
      const before = last.get(width);
      if (before && before.join("\n") === lines.join("\n")) continue;
      if (!differs && before) {
        added = changed(lines, before);
        removed = changed(before, lines);
      }
      differs = true;
    }
    const checkpoint = index === 0 || index === outlines.length - 1 || differs;
    if (checkpoint) for (const [width, lines] of now) last.set(width, lines);
    return { added, checkpoint, removed };
  });
}

/** What one test said of one moment at one width (the generated helper's attachment). */
export type Seen = Readonly<
  Omit<Planned, "target"> & {
    box: Box | null;
    structure: string;
    width: Width;
  }
>;

/** A picture file of a journey's, relative to its folder (`desktop/start.png`). */
export const pictureFile = (width: Width, id: string) => `${width}/${id}.png`;

/**
 * A journey's manifest from what its tests saw at each width (all passed), each
 * picture's hash given. `frames`: every moment's picture (the cache), else only
 * the checkpoints' (what a repository commits). Keys in a fixed order: the same
 * journey taken twice is the same bytes.
 */
export function manifest(input: {
  frames: boolean;
  journey: string;
  renderer: Renderer;
  seen: Readonly<Record<Width, ReadonlyArray<Seen>>>;
  sha256: (width: Width, id: string) => string;
  steps: ReadonlyArray<string>;
  taken: Taken;
  title: string;
  widths: Readonly<Record<Width, Readonly<{ height: number; width: number }>>>;
}): Manifest {
  const widths = Object.keys(input.seen);
  const first = input.seen[widths[0]!] ?? [];
  const flags = checkpoints(
    first.map((_, index) =>
      Object.fromEntries(
        widths.map((width) => [width, input.seen[width]![index]?.structure ?? ""]),
      ),
    ),
  );
  const moments: Array<Moment> = first.map((seen, index) => {
    const checkpoint = flags[index]!.checkpoint;
    const pictures: Record<Width, MomentPicture> = {};
    if (checkpoint || input.frames) {
      for (const width of widths) {
        const at = input.seen[width]![index]!;
        pictures[width] = {
          box: at.box,
          file: pictureFile(width, seen.id),
          sha256: input.sha256(width, seen.id),
        };
      }
    }
    return {
      after: seen.after,
      checkpoint,
      id: seen.id,
      index: seen.index,
      journey: seen.journey,
      next: seen.next,
      page: seen.page,
      ...(Object.keys(pictures).length ? { pictures } : {}),
      role: seen.role,
      state: seen.state,
      step: seen.step,
    };
  });
  return {
    journey: input.journey,
    moments,
    pom: 1,
    renderer: input.renderer,
    steps: [...input.steps],
    taken: input.taken,
    title: input.title,
    widths: Object.fromEntries(widths.map((width) => [width, input.widths[width]!])),
  };
}

/** JSON with keys sorted at every level: one manifest, one byte string. */
export function stable(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((key) => [key, sort((v as Record<string, unknown>)[key])]),
          )
        : v;
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}
