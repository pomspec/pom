import { parse } from "yaml";

// A page's tree is Playwright's ARIA snapshot format, as `ariaSnapshot()`
// writes it and `toMatchAriaSnapshot` reads it: each item a node, `role "name"
// [attributes]`, with its text or its children after a colon. Read here only
// for what the page holds (roles, names, nesting); Playwright matches the text
// itself, so what is written is what is checked.

export type Name = string | RegExp;

export type Node = {
  children: Array<Node>;
  name?: Name;
  role: string;
  /** Inline text: `- paragraph: Some words`. */
  text?: string;
};

const KEY = /^([a-z]+)(?:\s+("(?:[^"\\]|\\.)*"|\/(?:[^/\\]|\\.)+\/[a-z]*))?(?:\s*\[[^\]]*\])*$/;

function key(raw: string, file: string): Pick<Node, "name" | "role"> {
  const match = KEY.exec(raw.trim());
  if (!match) throw new Error(`${file}: cannot read "${raw}" as a node (role "name" [attributes])`);
  const [, role, name] = match;
  if (!name) return { role: role! };
  if (name.startsWith('"')) return { name: JSON.parse(name) as string, role: role! };
  const slash = name.lastIndexOf("/");
  return { name: new RegExp(name.slice(1, slash), name.slice(slash + 1)), role: role! };
}

function nodes(value: unknown, file: string): Array<Node> {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${file}: a node's children must be a list`);
  const out: Array<Node> = [];
  for (const item of value) {
    if (typeof item === "string") {
      out.push({ ...key(item, file), children: [] });
      continue;
    }
    if (item && typeof item === "object") {
      for (const [raw, inner] of Object.entries(item)) {
        // Properties (`/url`, `/placeholder`) describe their node; they hold no node.
        if (raw.startsWith("/")) continue;
        if (raw === "text") {
          out.push({ children: [], role: "text", text: String(inner) });
          continue;
        }
        const node: Node = { ...key(raw, file), children: [] };
        if (typeof inner === "string" || typeof inner === "number") node.text = String(inner);
        else node.children = nodes(inner, file);
        out.push(node);
      }
      continue;
    }
    throw new Error(`${file}: cannot read ${JSON.stringify(item)} as a node`);
  }
  return out;
}

export function readTree(source: string, file: string): Array<Node> {
  return nodes(parse(source), file);
}

/** Every node, depth first, with the nodes above it. */
export function* walk(
  tree: Array<Node>,
  above: Array<Node> = [],
): Generator<{ above: Array<Node>; node: Node }> {
  for (const node of tree) {
    yield { above, node };
    yield* walk(node.children, [...above, node]);
  }
}

export function sameName(written: Name | undefined, wanted: string): boolean {
  if (written === undefined) return false;
  return typeof written === "string" ? written === wanted : written.test(wanted);
}
