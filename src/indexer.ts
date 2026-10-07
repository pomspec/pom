import path from "node:path";
import { entryFor } from "./check.ts";
import type { Journey, Line } from "./feature.ts";
import { ACTING, momentIds } from "./moments.ts";
import { pageAt, type Page, type Plain, type Spec, type Tree } from "./spec.ts";
import type {
  IndexedJourney,
  IndexedLine,
  IndexedPage,
  IndexedTree,
  Manifest,
  SpecIndex,
} from "./types.ts";

// A spec as data, for anything that shows one (a person reading it beside its
// pictures) without reading its files: its pages with their trees, its
// journeys with their lines, each line with the page it is on and the moment
// whose picture shows the screen after it, and each journey's manifest when it
// has been pictured. Paths are the spec folder's own, relative to it.

export function specIndex(
  spec: Spec,
  manifests: Readonly<Record<string, Manifest>> = {},
): SpecIndex {
  const relative = (file: string) => path.relative(spec.root, file);
  const id = (journey: Journey) =>
    relative(journey.file)
      .replace(/\.feature$/, "")
      .split(path.sep)
      .join("/");
  const plain = (tree: Plain) => ({ file: relative(tree.file), source: tree.source });
  const indexedTree = (tree: Tree): IndexedTree => ({
    ...plain(tree),
    variations: Object.fromEntries(
      Object.entries(tree.variations).map(([name, at]) => [name, plain(at)]),
    ),
  });

  /** The page each line is on, as `check` reads it: a go or arrival moves, a sign-in lands where its journey ends. */
  function walk(journey: Journey, seen: Set<Journey> = new Set()) {
    seen.add(journey);
    let page: Page | null = null;
    const idFor = momentIds();
    let moment = idFor(null);
    const visited = new Set<Page>();
    let signsInWith: Journey | null = null;
    const index = (line: Line): IndexedLine => {
      const { action } = line;
      if (action.verb === "go" || action.verb === "arrive") {
        page = pageAt(spec, action.path, line.role)?.page ?? page;
      } else if (action.verb === "signin") {
        const entry = entryFor(spec, action.role);
        if (entry && !seen.has(entry)) {
          signsInWith = entry;
          page = walk(entry, seen).last;
        }
      } else if (ACTING.has(action.verb)) {
        moment = idFor(line);
      }
      if (page) visited.add(page);
      return {
        line: line.line,
        page: (page as Page | null)?.route ?? null,
        moment,
        role: line.role,
        state: line.state,
        source: line.source,
      };
    };
    const background = journey.background.map(index);
    const steps = journey.steps.map((step) => ({
      caption: step.caption,
      lines: step.lines.map(index),
    }));
    return {
      background,
      last: page as Page | null,
      signsInWith: signsInWith as Journey | null,
      steps,
      visited,
    };
  }

  const walked = new Map(spec.journeys.map((journey) => [journey, walk(journey)]));

  const journeys = spec.journeys.map((journey): IndexedJourney => {
    const { background, signsInWith, steps } = walked.get(journey)!;
    return {
      background,
      file: relative(journey.file),
      id: id(journey),
      manifest: manifests[id(journey)] ?? null,
      signsInWith: signsInWith ? id(signsInWith) : null,
      steps,
      title: journey.title,
    };
  });

  const pages = spec.pages.map((page): IndexedPage => ({
    dialogs: page.dialogs.map((dialog) => ({ name: dialog.name, ...plain(dialog) })),
    groups: page.groups,
    journeys: spec.journeys.filter((journey) => walked.get(journey)!.visited.has(page)).map(id),
    layouts: page.layouts.map((layout) => ({ ...indexedTree(layout), dir: relative(layout.dir) })),
    route: page.route,
    tree: indexedTree(page),
  }));

  return { journeys, pages };
}
