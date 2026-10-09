import { allNodes, camel, type Dialog, type Layout, type Page } from "./spec.ts";
import { type Name, type Node, walk } from "./tree.ts";

// What each tree becomes: a page object (a page), a component object (a
// layout, a dialog), each named node in it a `readonly` locator, as
// Playwright's page object model has them. A locator is scoped by the
// landmarks and named containers above its node, so the "Pricing" link in the
// header and the one in the footer are two properties, not one ambiguous one.

export type Control = Readonly<{
  /** `getByRole(…)` chain, from the constructor's `page` or `this.root`. */
  locator: string;
  node: Node;
  /** Every node it is, one per tree it is written in (the shared one, a variation's). */
  nodes: ReadonlyArray<Node>;
  property: string;
  /** The landmarks and named containers its locator goes through, outermost first. */
  scopes: ReadonlyArray<Node>;
}>;

export type ObjectModel = Readonly<{ className: string; controls: ReadonlyArray<Control> }>;

/** Roles that scope what is inside them. `main` does not: a page's tree is its content. */
const LANDMARKS = new Set([
  "banner",
  "complementary",
  "contentinfo",
  "dialog",
  "form",
  "navigation",
  "region",
  "search",
]);

/** Named nodes that are parts of something larger, not controls of their own. */
const PARTS = new Set([
  "cell",
  "columnheader",
  "gridcell",
  "listitem",
  "row",
  "rowgroup",
  "rowheader",
]);

/** What a label reads as, when two controls share a name. */
const PLACE: Record<string, string> = {
  banner: "header",
  complementary: "sidebar",
  contentinfo: "footer",
};

/** Members every object has; a control never takes one of their names. */
const TAKEN = new Set([
  "constructor",
  "expectLoaded",
  "expectOpen",
  "expectVisible",
  "goto",
  "page",
  "root",
]);

export const literal = (name: Name): string =>
  typeof name === "string" ? JSON.stringify(name) : name.toString();

const byRole = (node: Node) =>
  node.name === undefined
    ? `getByRole(${JSON.stringify(node.role)})`
    : `getByRole(${JSON.stringify(node.role)}, { name: ${literal(node.name)}${
        typeof node.name === "string" ? ", exact: true" : ""
      } })`;

const words = (name: Name) => (typeof name === "string" ? name : name.source.replace(/\\./g, " "));

export function controlsOf(
  tree: Array<Node>,
  base: string,
  reserved: ReadonlySet<string>,
): Array<Control> {
  const found: Array<{ locator: string; node: Node; nodes: Array<Node>; scopes: Array<Node> }> = [];
  for (const { above, node } of walk(tree)) {
    if (node.name === undefined || PARTS.has(node.role) || node.role === "text") continue;
    const scopes = above.filter(
      (up) => LANDMARKS.has(up.role) || (typeof up.name === "string" && !PARTS.has(up.role)),
    );
    const locator = [base, ...scopes.map(byRole), byRole(node)].join(".");
    // A control written in two trees (the shared one, and a variation's) is one control.
    const same = found.find((other) => other.locator === locator);
    if (same) same.nodes.push(node);
    else found.push({ locator, node, nodes: [node], scopes });
  }
  const plain = found.map(({ node }) => camel(words(node.name!)));
  const count = (name: string) => plain.filter((other) => other === name).length;
  const used = new Set<string>([...TAKEN, ...reserved]);
  return found.map(({ locator, node, nodes, scopes }, index) => {
    let property = plain[index]!;
    if (count(property) > 1) {
      // Told apart by the nearest named container, else the outermost landmark.
      const named = scopes.findLast((up) => typeof up.name === "string");
      const label = named
        ? (named.name as string)
        : scopes[0]
          ? (PLACE[scopes[0].role] ?? scopes[0].role)
          : "";
      property = camel(`${label} ${words(node.name!)}`);
    }
    if (used.has(property)) property = camel(`${words(node.name!)} ${node.role}`);
    for (let n = 2; used.has(property); n++) property = `${property.replace(/\d+$/, "")}${n}`;
    used.add(property);
    return { locator, node, nodes, property, scopes };
  });
}

export const layoutProperty = (layout: Layout) => camel(layout.className);

export function pageModel(page: Page): ObjectModel {
  const reserved = new Set([
    ...page.layouts.map(layoutProperty),
    ...page.dialogs.map((d) => d.property),
  ]);
  return { className: page.className, controls: controlsOf(allNodes(page), "page", reserved) };
}

export function layoutModel(layout: Layout): ObjectModel {
  return { className: layout.className, controls: controlsOf(allNodes(layout), "page", new Set()) };
}

export function dialogModel(dialog: Dialog): ObjectModel {
  return {
    className: dialog.className,
    controls: controlsOf(dialog.root.children, "this.root", new Set()),
  };
}
