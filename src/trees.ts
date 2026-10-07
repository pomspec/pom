import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type OutlineNode, chainOf, prune, walkOutline, writeOutline } from "./outline.ts";
import { GENERATED, isGenerated } from "./spec.ts";
import type { Width } from "./types.ts";

// A page's trees from what the app showed (`pom map`, `pom snapshot`): one page per
// route, seen in its variations (a width, who acts, a state). What all of them show
// goes to `page.tree.yml`, what only one does to `page.<variation>.tree.yml`. A tree
// a person wrote is never rewritten.

/** A variation of a page: the width, who acts, the state it is in. */
export type Combo = Readonly<{ role: string; state: string | null; width: Width }>;

export type Written = Readonly<{ file: string; kind: "kept" | "written" }>;

/** The variations a combination is in, in the order a node is filed under one: role, state, width. */
const namesOf = (c: Combo) => [c.role, ...(c.state ? [c.state] : []), c.width];

const every = <T>(sets: ReadonlyArray<ReadonlySet<T>>): Set<T> =>
  sets.length
    ? new Set([...sets[0]!].filter((item) => sets.every((set) => set.has(item))))
    : new Set();

/**
 * Splits what a page's variations show into what all of them do (`""`, the shared
 * tree) and what only one does: by who acts first, then by state, then by width.
 * What only some combinations within a variation show goes with who acts there.
 */
export function split(
  seen: ReadonlyArray<{ chains: ReadonlySet<string>; combo: Combo }>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const filed = new Set<string>();
  const file = (name: string, chains: Iterable<string>) => {
    const fresh = [...chains].filter((chain) => !filed.has(chain));
    if (!fresh.length && name !== "") return;
    out.set(name, new Set([...(out.get(name) ?? []), ...fresh]));
    for (const chain of fresh) filed.add(chain);
  };
  file("", every(seen.map((s) => s.chains)));
  const kinds: ReadonlyArray<(combo: Combo) => string | null> = [
    (c) => c.role,
    (c) => c.state,
    (c) => c.width,
  ];
  for (const kindOf of kinds) {
    for (const name of new Set(seen.flatMap((s) => kindOf(s.combo) ?? []))) {
      file(name, every(seen.filter((s) => kindOf(s.combo) === name).map((s) => s.chains)));
    }
  }
  for (const s of seen) file(s.combo.role, s.chains);
  return out;
}

/**
 * Two outlines as one: a node both have (by its place) once, its children merged.
 * Siblings alike (two paragraphs, which have no name) are told apart by their order:
 * the second of them in one outline is the second in the other.
 */
function merge(a: ReadonlyArray<OutlineNode>, b: ReadonlyArray<OutlineNode>): Array<OutlineNode> {
  const out = a.map((node) => ({ ...node }));
  const seen = new Map<string, number>();
  for (const node of b) {
    const chain = chainOf([], node);
    const nth = seen.get(chain) ?? 0;
    seen.set(chain, nth + 1);
    const at = out.findIndex(
      (mine, index) =>
        chainOf([], mine) === chain &&
        out.slice(0, index).filter((before) => chainOf([], before) === chain).length === nth,
    );
    if (at === -1) out.push(node);
    else out[at] = { ...out[at]!, children: merge(out[at]!.children, node.children) };
  }
  return out;
}

const chainsOf = (tree: ReadonlyArray<OutlineNode>) =>
  new Set([...walkOutline(tree)].map(({ above, node }) => chainOf(above, node)));

/**
 * Writes the trees of the page in `dir` from what it showed in each variation; a
 * variation's tree pom wrote before and no longer would (the page is the same in it
 * now) goes.
 */
export function writePage(
  dir: string,
  seen: ReadonlyArray<{ combo: Combo; tree: ReadonlyArray<OutlineNode> }>,
): Array<Written> {
  const chained = seen.map((s) => ({ ...s, chains: chainsOf(s.tree) }));
  const written: Array<Written> = [];
  for (const [name, wanted] of split(chained)) {
    if (!wanted.size) continue;
    const tree = chained
      .filter((s) => name === "" || namesOf(s.combo).includes(name))
      .map((s) => prune(s.tree, (node, above) => wanted.has(chainOf(above, node))))
      .reduce(merge, []);
    const file = path.join(dir, name ? `page.${name}.tree.yml` : "page.tree.yml");
    const text = `${GENERATED}\n${writeOutline(tree)}\n`;
    if (existsSync(file) && !isGenerated(readFileSync(file, "utf8"))) {
      written.push({ file, kind: "kept" });
      continue;
    }
    mkdirSync(dir, { recursive: true });
    if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);
    written.push({ file, kind: "written" });
  }
  const kept = new Set(written.map((w) => w.file));
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    if (!/^page\.[a-z0-9-]+\.tree\.yml$/.test(name)) continue;
    const file = path.join(dir, name);
    if (!kept.has(file) && isGenerated(readFileSync(file, "utf8"))) rmSync(file);
  }
  return written;
}
