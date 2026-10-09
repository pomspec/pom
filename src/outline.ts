import { parse, stringify } from "yaml";

// A page's outline as `ariaSnapshot()` writes it, kept whole: each node's key as
// written (`heading "Plans" [level=2]`), its text, its children. What pom writes
// back is a part of it: the nodes kept, every role-bearing node above each (a
// template's children match a node's direct children only, so none may be skipped),
// states dropped but a heading's level, and a run's own marks made patterns.

export type OutlineNode = {
  children: Array<OutlineNode>;
  /** The key as written, attributes and all: `button "Save" [disabled]`. */
  key: string;
  name: string | null;
  role: string;
  text: string | null;
};

const KEY = /^([a-z]+)(?:\s+("(?:[^"\\]|\\.)*"|\/(?:[^/\\]|\\.)+\/[a-z]*))?((?:\s*\[[^\]]*\])*)$/;

function readKey(raw: string): Pick<OutlineNode, "key" | "name" | "role"> | null {
  const found = KEY.exec(raw.trim());
  if (!found) return null;
  const [, role, quoted] = found;
  const name = quoted?.startsWith('"') ? (JSON.parse(quoted) as string) : (quoted ?? null);
  return { key: raw.trim(), name, role: role! };
}

function nodes(value: unknown): Array<OutlineNode> {
  if (!Array.isArray(value)) return [];
  const out: Array<OutlineNode> = [];
  for (const item of value) {
    if (typeof item === "string") {
      const key = readKey(item);
      if (key) out.push({ ...key, children: [], text: null });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    for (const [raw, inner] of Object.entries(item)) {
      if (raw.startsWith("/")) continue;
      if (raw === "text") {
        out.push({ children: [], key: "text", name: null, role: "text", text: String(inner) });
        continue;
      }
      const key = readKey(raw);
      if (!key) continue;
      out.push({
        ...key,
        children: typeof inner === "string" || typeof inner === "number" ? [] : nodes(inner),
        text: typeof inner === "string" || typeof inner === "number" ? String(inner) : null,
      });
    }
  }
  return out;
}

export const readOutline = (yaml: string): Array<OutlineNode> => nodes(parse(yaml));

/** Every node, depth first, with those above it. */
export function* walkOutline(
  tree: ReadonlyArray<OutlineNode>,
  above: ReadonlyArray<OutlineNode> = [],
): Generator<{ above: ReadonlyArray<OutlineNode>; node: OutlineNode }> {
  for (const node of tree) {
    yield { above, node };
    yield* walkOutline(node.children, [...above, node]);
  }
}

const EMAIL = /[A-Za-z0-9._%-]+(?:\+[a-z0-9]+)?@[A-Za-z0-9.-]+\.[A-Za-z]+/g;

/** A name or text as a tree keeps it: a run's own email (ana+x1y2@…) becomes a pattern any run matches. */
function stable(text: string): { pattern: boolean; text: string } {
  if (!EMAIL.test(text)) return { pattern: false, text };
  EMAIL.lastIndex = 0;
  const escaped = text
    .replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
    .replace(
      /[A-Za-z0-9._%-]+(?:\\\+[a-z0-9]+)?@[A-Za-z0-9.\\-]+\\\.[A-Za-z]+/g,
      "[^@\\s]+@[^\\s]+",
    );
  return { pattern: true, text: escaped };
}

/** A key as a tree writes it: no passing states, a heading's level kept, run marks made patterns. */
export function cleanKey(node: OutlineNode): string {
  const level = /\[level=\d+\]/.exec(node.key)?.[0];
  if (node.name === null) return `${node.role}${level ? ` ${level}` : ""}`;
  const name = stable(node.name);
  const written = name.pattern ? `/${name.text}/` : JSON.stringify(name.text);
  return `${node.role} ${written}${level ? ` ${level}` : ""}`;
}

/**
 * A key or a pattern as YAML holds it, by the yaml package's own rules: plain where it
 * reads back as itself (`button "Save"`), quoted where it would not
 * (`'button "Chapters: Say hello"'`), on one line.
 */
const scalar = (text: string) => stringify(text, { blockQuote: false, lineWidth: 0 }).trimEnd();

/** A node's text as a tree writes it: quoted, or a pattern where a run's own email was. */
const cleanText = (text: string) => {
  const kept = stable(text);
  return kept.pattern ? scalar(`/${kept.text}/`) : JSON.stringify(text);
};

/**
 * The outline cut to the nodes `keep` says, each with every node above it, written
 * as a tree file holds it. A kept node keeps its text; its children only when kept.
 */
export function prune(
  tree: ReadonlyArray<OutlineNode>,
  keep: (node: OutlineNode, above: ReadonlyArray<OutlineNode>) => boolean,
): Array<OutlineNode> {
  const kept = new Set<OutlineNode>();
  for (const { above, node } of walkOutline(tree)) {
    if (!keep(node, above)) continue;
    kept.add(node);
    for (const up of above) kept.add(up);
  }
  const cut = (list: ReadonlyArray<OutlineNode>): Array<OutlineNode> =>
    list
      .filter((node) => kept.has(node))
      .map((node) => ({ ...node, children: cut(node.children) }));
  return cut(tree);
}

/** A tree as YAML, Playwright's own shape (`- role "name":` then its children). */
export function writeOutline(tree: ReadonlyArray<OutlineNode>, indent = ""): string {
  return tree
    .map((node) => {
      if (node.role === "text") return `${indent}- text: ${cleanText(node.text ?? "")}`;
      const key = scalar(cleanKey(node));
      if (node.children.length)
        return `${indent}- ${key}:\n${writeOutline(node.children, `${indent}  `)}`;
      if (node.text !== null && node.text !== "")
        return `${indent}- ${key}: ${cleanText(node.text)}`;
      return `${indent}- ${key}`;
    })
    .join("\n");
}

/** A node's place: its key and every key above it, as a tree is told apart from another. */
export const chainOf = (above: ReadonlyArray<OutlineNode>, node: OutlineNode) =>
  [...above, node].map(cleanKey).join(" > ");
