import { type Journey, type Line, VISITOR } from "./feature.ts";
import { type Control, dialogModel, layoutModel, layoutProperty, pageModel } from "./objects.ts";
import {
  allNodes,
  type Dialog,
  journeyFunction,
  type Page,
  pageAt,
  pageVariable,
  roleOf,
  type Spec,
  type Tree,
  words,
} from "./spec.ts";
import { type Node, sameName, walk } from "./tree.ts";

// A journey read against its pages, before anything runs: each line finds its
// control in the tree of the page it is on (an open dialog first, then the
// page, then its layouts, innermost first), and becomes the call the test
// makes. A name no tree holds is refused here, as a type error would be.
// `Given I am signed in as the "owner"` plays first the journey that starts as
// the visitor and ends as the owner: the spec already says how one gets in.

export type Call = Readonly<{
  code: string;
  line: Line;
  /** The page the line acts on: where the journey was when it ran. */
  on: Page | null;
  /** The page the journey is on once the line has run. */
  page: Page | null;
  /** The locator a press or a fill acts on, as the test reaches it. */
  target: string | null;
}>;

export type Compiled = Readonly<{
  background: ReadonlyArray<Call>;
  /** The journeys it plays first, to sign in. */
  entries: ReadonlyArray<Journey>;
  journey: Journey;
  /** The page it ends on. */
  last: Page | null;
  /** The pages it visits, each its test's variable. */
  pages: ReadonlyArray<Page>;
  steps: ReadonlyArray<{ calls: ReadonlyArray<Call>; caption: string }>;
}>;

export type Problem = Readonly<{ file: string; line: number; message: string }>;

const FIELDS = new Set(["combobox", "searchbox", "spinbutton", "textbox"]);
const LISTS = new Set(["combobox", "listbox"]);
const CHECKS = new Set(["checkbox", "menuitemcheckbox", "menuitemradio", "radio", "switch"]);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]+/g;

const emailsIn = (text: string) => text.match(EMAIL) ?? [];

/** A value typed, as the test writes it: its emails made the run's own, so a run never meets the last one's account. */
export const value = (text: string) =>
  emailsIn(text).length ? `unique(${JSON.stringify(text)})` : JSON.stringify(text);

/**
 * Text a line looks for, as the test writes it: an email the journey typed before it
 * (its sign-in's too) is the run's own, as it was typed; any other, an account the app
 * already had (`dev@example.com`), is as the line says.
 */
function shown(text: string, typed: ReadonlySet<string>): string {
  const emails = emailsIn(text);
  if (!emails.some((email) => typed.has(email))) return JSON.stringify(text);
  if (emails.every((email) => typed.has(email))) return value(text);
  const parts: Array<string> = [];
  let from = 0;
  for (const match of text.matchAll(EMAIL)) {
    if (!typed.has(match[0])) continue;
    if (match.index > from) parts.push(JSON.stringify(text.slice(from, match.index)));
    parts.push(value(match[0]));
    from = match.index + match[0].length;
  }
  if (from < text.length) parts.push(JSON.stringify(text.slice(from)));
  return parts.join(" + ");
}

// A page's variable and a journey's function, as a test names them.
export { journeyFunction, pageVariable };

const linesOf = (journey: Journey) => [
  ...journey.background,
  ...journey.steps.flatMap((step) => step.lines),
];

/** The journey that makes a visitor this role: how a journey signed in as it begins. */
export function entryFor(spec: Spec, role: string): Journey | null {
  return (
    spec.journeys.find((journey) => {
      const lines = linesOf(journey);
      return (
        journey.endsAs === role &&
        lines[0]?.role === VISITOR &&
        !lines.some((line) => line.action.verb === "signin")
      );
    }) ?? null
  );
}

type Where = { dialog: Dialog | null; page: Page };

/** Where a line looks: what it shows there, and how the test reaches it (a dialog from its root). */
type Place = {
  allowed: ReadonlySet<Node> | null;
  controls: ReadonlyArray<Control>;
  path: string;
  root: Node | null;
};

/** The nodes a tree shows in the variations a line is in: its shared tree and theirs. */
const shownIn = (tree: Tree, active: (variation: string) => boolean): ReadonlySet<Node> =>
  new Set([...walk(allNodes(tree, active))].map(({ node }) => node));

/** Where a line looks, in order, with how the test reaches each and what it shows there. */
function places(where: Where, active: (variation: string) => boolean): Array<Place> {
  const on = pageVariable(where.page);
  const out: Array<Place> = [];
  if (where.dialog)
    out.push({
      allowed: null,
      controls: dialogModel(where.dialog).controls,
      path: `${on}.${where.dialog.property}`,
      root: where.dialog.root,
    });
  out.push({
    allowed: shownIn(where.page, active),
    controls: pageModel(where.page).controls,
    path: on,
    root: null,
  });
  for (const layout of [...where.page.layouts].reverse()) {
    out.push({
      allowed: shownIn(layout, active),
      controls: layoutModel(layout).controls,
      path: `${on}.${layoutProperty(layout)}`,
      root: null,
    });
  }
  return out;
}

type Found = { control: Control; path: string; place: Place };

/** A control the line's variations show that fits, as the test reaches it. */
function find(
  where: Where,
  fits: (node: Node) => boolean,
  active: (variation: string) => boolean,
): Found | null {
  for (const place of places(where, active)) {
    const control = place.controls.find((c) =>
      c.nodes.some((node) => (!place.allowed || place.allowed.has(node)) && fits(node)),
    );
    if (control) return { control, path: `${place.path}.${control.property}`, place };
  }
  return null;
}

/** A node as two trees of one page are told apart: its role and name. */
const keyOf = (node: Node) =>
  `${node.role} ${node.name === undefined ? "" : typeof node.name === "string" ? JSON.stringify(node.name) : node.name.toString()}`;

/**
 * Trees of one page as the one page they are: a node two of them write (a container
 * the shared tree and a width's both hold) once, siblings alike told apart by order.
 */
function together(a: ReadonlyArray<Node>, b: ReadonlyArray<Node>): Array<Node> {
  const out = a.map((node) => ({ ...node }));
  const seen = new Map<string, number>();
  for (const node of b) {
    const key = keyOf(node);
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    let alike = 0;
    const at = out.findIndex((mine) => keyOf(mine) === key && alike++ === nth);
    if (at === -1) out.push(node);
    else out[at] = { ...out[at]!, children: together(out[at]!.children, node.children) };
  }
  return out;
}

/** Whether a locator's name finds a node's: the same text, or the pattern's match. */
function named(wanted: Node["name"], node: Node): boolean {
  if (wanted === undefined) return true;
  if (node.name === undefined) return false;
  if (typeof wanted === "string") return node.name === wanted;
  return typeof node.name === "string"
    ? node.name.search(wanted) !== -1
    : node.name.toString() === wanted.toString();
}

/** How many of a page's nodes a locator finds: its role and name, inside its scopes in order. */
function finds(chain: ReadonlyArray<Node>, tree: Array<Node>): number {
  const target = chain.at(-1)!;
  const scopes = chain.slice(0, -1);
  let count = 0;
  for (const { above, node } of walk(tree)) {
    if (node.role !== target.role || !named(target.name, node)) continue;
    let next = 0;
    for (const up of above) {
      const scope = scopes[next];
      if (scope && up.role === scope.role && named(scope.name, up)) next += 1;
    }
    if (next === scopes.length) count += 1;
  }
  return count;
}

/**
 * How many controls of the page a found one's locator reaches, at the width where most
 * do: the page as the line sees it there (its trees, its layouts', the dialog open on
 * it), one tree. Playwright acts on one element, or refuses.
 */
function reach(spec: Spec, where: Where, found: Found, line: Line): number {
  const chain = [
    ...(found.place.root ? [found.place.root] : []),
    ...found.control.scopes,
    found.control.node,
  ];
  let most = 0;
  for (const width of spec.widths.length ? spec.widths : [""]) {
    const at = (variation: string) =>
      variation === width || variation === line.role || variation === line.state;
    // Each tree on its own: the shared one and a variation's are one page, not two.
    const trees = (tree: Tree) => [
      tree.tree,
      ...Object.entries(tree.variations).flatMap(([name, plain]) => (at(name) ? [plain.tree] : [])),
    ];
    const page = [
      ...(where.dialog ? [[where.dialog.root]] : []),
      ...trees(where.page),
      ...where.page.layouts.flatMap(trees),
    ].reduce(together, []);
    most = Math.max(most, finds(chain, page));
  }
  return most;
}

/** How a check reads a spec beyond its files: the roles the config signs in itself. */
export type CheckOptions = Readonly<{ signIns?: ReadonlySet<string> }>;

export function compile(
  spec: Spec,
  journey: Journey,
  options: CheckOptions = {},
): { compiled: Compiled | null; problems: Array<Problem> } {
  const problems: Array<Problem> = [];
  const visited: Array<Page> = [];
  const entries: Array<Journey> = [];
  // The emails this test has typed so far: what its lines see of them is the run's own.
  const typed = new Set<string>();
  let where: Where | null = null;

  const make = (line: Line): Omit<Call, "on" | "page"> | null => {
    const problem = (message: string) => {
      problems.push({ file: journey.file, line: line.line, message });
      return null;
    };
    const { action } = line;
    if (action.verb === "signin" && options.signIns?.has(action.role)) {
      // The config's own sign-in: it lands wherever the app sends that role, so the
      // journey says where it goes next.
      where = null;
      return { code: `await signIn(page, ${JSON.stringify(action.role)})`, line, target: null };
    }
    if (action.verb === "signin") {
      const entry = entryFor(spec, action.role);
      if (!entry || entry === journey) {
        return problem(
          `no journey makes a visitor the "${action.role}": one that starts as the visitor and ends "# as ${action.role}"`,
        );
      }
      const played = compile(spec, entry, options).compiled;
      if (!played)
        return problem(
          `"${entry.title}", which signs in as the "${action.role}", fails its own check`,
        );
      if (!entries.includes(entry)) entries.push(entry);
      for (const typing of linesOf(entry))
        if (typing.action.verb === "fill")
          for (const email of emailsIn(typing.action.value)) typed.add(email);
      where = played.last ? { dialog: null, page: played.last } : null;
      if (played.last && !visited.includes(played.last)) visited.push(played.last);
      return { code: `await ${journeyFunction(entry)}(page)`, line, target: null };
    }
    if (action.verb === "go" || action.verb === "arrive") {
      const found = pageAt(spec, action.path, line.role);
      if (!found) return problem(`no page at "${action.path}" (no page.tree.yml routes there)`);
      where = { dialog: null, page: found.page };
      if (!visited.includes(found.page)) visited.push(found.page);
      const on = pageVariable(found.page);
      if (action.verb === "arrive")
        return { code: `await ${on}.expectLoaded()`, line, target: null };
      const params = Object.entries(found.params);
      const args = params.length
        ? `{ ${params.map(([key, val]) => `${JSON.stringify(key)}: ${JSON.stringify(val)}`).join(", ")} }`
        : "";
      return { code: `await ${on}.goto(${args})`, line, target: null };
    }
    if (!where)
      return problem(`the journey is on no page yet: start it with Given I am on "<path>"`);
    const here: Where = where;
    // What the line can see: its page in every width, as who acts, in its journey's state.
    const active = (variation: string) =>
      spec.widths.includes(variation) || variation === line.role || variation === line.state;
    const on = pageVariable(here.page);
    const at = `on ${here.page.route}${here.dialog ? ` in the "${here.dialog.name}" dialog` : ""}`;
    // The control a line acts on or looks at: one on the page, or Playwright refuses it.
    const one = (found: Found | null, missing: string): string | null => {
      if (!found) return problem(`${missing} ${at}`);
      const many = reach(spec, here, found, line);
      if (many > 1) {
        const { node } = found.control;
        return problem(
          `${node.role} "${"name" in action ? action.name : ""}" is ${many} controls ${at}: give each a name of its own, so the line says which one`,
        );
      }
      return found.path;
    };
    switch (action.verb) {
      case "press": {
        const path = one(
          find(
            here,
            (node) => node.role === action.role && sameName(node.name, action.name),
            active,
          ),
          `no ${action.role} "${action.name}"`,
        );
        if (!path) return null;
        return { code: `await ${path}.click()`, line, target: path };
      }
      case "fill": {
        const path = one(
          find(here, (node) => FIELDS.has(node.role) && sameName(node.name, action.name), active),
          `no field "${action.name}"`,
        );
        if (!path) return null;
        const code = `await ${path}.fill(${value(action.value)})`;
        for (const email of emailsIn(action.value)) typed.add(email);
        return { code, line, target: path };
      }
      case "select": {
        const path = one(
          find(here, (node) => LISTS.has(node.role) && sameName(node.name, action.name), active),
          `no list "${action.name}"`,
        );
        if (!path) return null;
        return {
          code: `await ${path}.selectOption(${JSON.stringify(action.value)})`,
          line,
          target: path,
        };
      }
      case "check": {
        const verb = action.checked ? "check" : "uncheck";
        const path = one(
          find(here, (node) => CHECKS.has(node.role) && sameName(node.name, action.name), active),
          `nothing to ${verb} named "${action.name}"`,
        );
        if (!path) return null;
        return { code: `await ${path}.${verb}()`, line, target: path };
      }
      case "key":
        return {
          code: `await ${on}.page.keyboard.press(${JSON.stringify(action.key)})`,
          line,
          target: null,
        };
      case "shows": {
        const path = one(
          find(here, (node) => sameName(node.name, action.name), active),
          `nothing named "${action.name}"`,
        );
        if (!path) return null;
        return {
          code: `await expect(${path}).toContainText(${shown(action.text, typed)})`,
          line,
          target: null,
        };
      }
      case "see": {
        const trees = [...(here.dialog ? [here.dialog] : []), here.page, ...here.page.layouts];
        // A generated tree is the page as it loads, not what it shows later: held to
        // it is only what a person wrote first.
        const written = trees.every((tree) => !tree.generated);
        if (written && !words(trees, active).some((word) => word.includes(action.text))) {
          return problem(
            `"${action.text}" is in no tree ${at}: a journey sees only what its page says it holds`,
          );
        }
        return {
          code: `await expect(${on}.page.getByText(${shown(action.text, typed)}).first()).toBeVisible()`,
          line,
          target: null,
        };
      }
      case "opens": {
        const dialog = here.page.dialogs.find(
          (d) => d.name === action.name && d.kind === action.kind,
        );
        if (!dialog) {
          return problem(
            `${here.page.route} opens no ${action.kind} "${action.name}" (no <name>.${action.kind}.tree.yml)`,
          );
        }
        where = { dialog, page: here.page };
        return { code: `await ${on}.${dialog.property}.expectOpen()`, line, target: null };
      }
    }
  };

  const call = (line: Line): Call | null => {
    const on = where === null ? null : (where as Where).page;
    const made = make(line);
    return made ? { ...made, on, page: where === null ? null : (where as Where).page } : null;
  };

  const background = journey.background.map(call);
  const steps = journey.steps.map((step) => ({
    calls: step.lines.map(call),
    caption: step.caption,
  }));
  if (problems.length) return { compiled: null, problems };
  return {
    compiled: {
      background: background as Array<Call>,
      entries,
      journey,
      last: where === null ? null : (where as Where).page,
      pages: visited,
      steps: steps as Array<{ calls: Array<Call>; caption: string }>,
    },
    problems,
  };
}

/** Every journey against the spec, and the routes none visits. */
export function checkSpec(
  spec: Spec,
  options: CheckOptions = {},
): {
  compiled: Array<Compiled>;
  problems: Array<Problem>;
  unvisited: Array<Page>;
} {
  const problems: Array<Problem> = [];
  // One path may have a page per role, never two for the same one.
  const routes = new Map<string, Page>();
  for (const page of spec.pages) {
    const key = `${page.route} ${roleOf(spec, page) ?? ""}`;
    const same = routes.get(key);
    if (same) {
      problems.push({
        file: page.file,
        line: 1,
        message: `${page.route} is also ${same.file}: two pages at one path are for different roles, each in a group named after it`,
      });
    }
    routes.set(key, page);
  }
  const compiled: Array<Compiled> = [];
  for (const journey of spec.journeys) {
    const result = compile(spec, journey, options);
    problems.push(...result.problems);
    if (result.compiled) compiled.push(result.compiled);
  }
  const visited = new Set(compiled.flatMap((c) => c.pages));
  return {
    compiled,
    problems,
    unvisited: spec.pages.filter((page) => !visited.has(page)),
  };
}
