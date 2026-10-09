import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { entryFor, journeyFunction } from "./check.ts";
import type { Config } from "./config.ts";
import { specIndex } from "./indexer.ts";
import { type OutlineNode, prune, readOutline } from "./outline.ts";
import { pageAt, type Spec } from "./spec.ts";
import { writePage } from "./trees.ts";

// `pom map`: the app as a person finds it, page by page. Playwright follows the app's
// own links (never a button or a form, so nothing changes), breadth first, as the
// visitor and as each role the spec can sign in; each page pictured at every width,
// its outline and its links kept. Paths that differ only by an id are one route,
// `[id]`. A route with no tree gets one (its landmarks, headings and controls); the
// map lists the pages no journey visits: what is left to write.

export type Crawled = Readonly<{
  links: ReadonlyArray<string>;
  outline: string;
  path: string;
  picture: string;
  status: number | null;
  title: string;
}>;

/** A page as one role finds it: one of its variations. */
export type MappedVariation = Readonly<{
  /** Paths found for it: `/projects/42`, `/projects/7`. */
  examples: ReadonlyArray<string>;
  /** By width: its picture. */
  picture: Readonly<Record<string, string>>;
  title: string;
}>;

export type MappedPage = Readonly<{
  journeys: ReadonlyArray<string>;
  /** The routes its links lead to. */
  links: ReadonlyArray<string>;
  /** `/projects/[id]` */
  route: string;
  /** Where its tree is, if it has one. */
  tree: string | null;
  /** By who sees it: the visitor's, the owner's… alike ones kept once, as the visitor's. */
  variations: Readonly<Record<string, MappedVariation>>;
}>;

export type AppMap = Readonly<{ pages: ReadonlyArray<MappedPage> }>;

/**
 * A path's route, as the spec's folders hold it. A segment that reads as an id is `[id]`
 * (`[id2]` after it); one no folder of the spec could be named is `[file]` (`[file2]`…):
 * a file's name a folder would read as a journey, its pictures or a tree
 * (`say-hello.feature`, `x.shots`, `page.tree.yml`), or one the spec reads as no segment
 * at all (`.well-known`, `(group)`).
 * Whole on its own, as the crawl runs it in the browser's test too.
 */
export function routeOf(at: string): string {
  const id =
    /^(?:\d+|[0-9a-f]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-z]{6,})$/i;
  const unnamable = /\.(?:feature|shots|tree\.yml)$|^\.|^\(.*\)$|^\[.*\]$/;
  const counts: Record<string, number> = {};
  const param = (name: string) => {
    counts[name] = (counts[name] ?? 0) + 1;
    return counts[name] === 1 ? `[${name}]` : `[${name}${counts[name]}]`;
  };
  const segments = at
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (id.test(segment) && /\d/.test(segment)) return param("id");
      if (unnamable.test(segment)) return param("file");
      return segment;
    });
  return `/${segments.join("/")}`;
}

/**
 * A picture's name from the whole address it shows, its query too (`/pricing?plan=team`
 * is `pricing-plan-team`), and a number after it when another address already reads the
 * same in `taken`. A long one (a query carrying an address) keeps its start and a hash
 * of the whole, under a file name's limit. Whole on its own, as the crawl runs it in the
 * browser's test too.
 */
export function pictureName(address: string, taken: Set<string>): string {
  const whole = address.replace(/#.*$/, "");
  let base = whole.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "home";
  if (base.length > 100) {
    // FNV-1a, 32 bits: two addresses alike for their first 80 characters differ by it.
    let hash = 0x811c9dc5;
    for (let i = 0; i < whole.length; i++) hash = Math.imul(hash ^ whole.charCodeAt(i), 0x01000193);
    base = `${base.slice(0, 80).replace(/-$/, "")}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}-${n}`;
  taken.add(name.toLowerCase());
  return name;
}

/** Whether a path is one the crawl leaves alone (signing out ends the role it maps). */
export const excluded = (at: string, exclude: ReadonlyArray<string>) =>
  exclude.some((prefix) => at === prefix || at.startsWith(`${prefix}/`));

/**
 * A page's inventory: its landmarks, its headings to the second level, its controls,
 * and its links in navigation (every link, with `everyLink`).
 */
const CONTROLS = new Set([
  "button",
  "checkbox",
  "combobox",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);
export function inventory(tree: ReadonlyArray<OutlineNode>, everyLink = false): Array<OutlineNode> {
  return prune(tree, (node, above) => {
    if (node.role === "heading") return /\[level=[12]\]/.test(node.key);
    if (CONTROLS.has(node.role)) return node.name !== null;
    if (node.role === "link")
      return node.name !== null && (everyLink || above.some((up) => up.role === "navigation"));
    return false;
  });
}

/** The crawl, as a Playwright test of its own (it signs in as journeys do, through the generated ones). */
export function crawlTest(input: {
  config: Config;
  roles: ReadonlyArray<{ entry: string | null; role: string; viaConfig: boolean }>;
  start: string;
}): string {
  const entries = [...new Set(input.roles.flatMap((r) => (r.entry ? [r.entry] : [])))];
  return `// Generated by pom map. Edit the spec, not this file.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { signIn } from "../pom.ts";
${entries.map((name) => `import { ${name} } from "../journeys/${name}.ts";`).join("\n")}

const SETTINGS = ${JSON.stringify({ exclude: input.config.map.exclude, limit: input.config.map.limit, mask: input.config.mask, start: input.start })};
const routeOf = ${routeOf.toString()};
const pictureName = ${pictureName.toString()};
const excluded = (at: string) => SETTINGS.exclude.some((p) => at === p || at.startsWith(p + "/"));

${input.roles
  .map(
    (r) => `test(${JSON.stringify(`map as ${r.role}`)}, async ({ page }, info) => {
  ${r.viaConfig ? `await signIn(page, ${JSON.stringify(r.role)});` : r.entry ? `await ${r.entry}(page);` : ""}
  const width = info.project.name;
  const dir = path.join(process.env.POM_RUN!, "map", ${JSON.stringify(r.role)}, width);
  mkdirSync(dir, { recursive: true });
  const origin = new URL(SETTINGS.start, info.project.use.baseURL ?? process.env.POM_BASE_URL).origin;
  const queue = [new URL(SETTINGS.start, origin).href];
  const seen = new Set<string>();
  const routes = new Map<string, number>();
  const pictures = new Set<string>();
  const pages: Array<unknown> = [];
  while (queue.length && pages.length < SETTINGS.limit) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    const response = await page.goto(url).catch(() => null);
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    const here = new URL(page.url());
    if (here.origin !== origin || excluded(here.pathname)) continue;
    const route = routeOf(here.pathname);
    // Two of a route are enough to know it: an id's page, again, is the same page.
    if ((routes.get(route) ?? 0) >= 2) continue;
    routes.set(route, (routes.get(route) ?? 0) + 1);
    // Named by the whole address: two pages a query tells apart are two pictures.
    const picture = path.join(dir, pictureName(here.pathname + here.search, pictures) + ".png");
    await page.screenshot({ animations: "disabled", caret: "hide", mask: [page.locator("iframe"), ...SETTINGS.mask.map((s) => page.locator(s))], maskColor: "#d4d4d8", path: picture });
    const outline = await page.locator("body").ariaSnapshot();
    const links = await page.$$eval("a[href]", (anchors) =>
      anchors.filter((a) => !a.closest("[data-pom-skip]")).map((a) => (a as HTMLAnchorElement).href),
    );
    const own = [...new Set(links.map((l) => { const u = new URL(l); u.hash = ""; return u; }).filter((u) => u.origin === origin && !excluded(u.pathname)).map((u) => u.href))];
    pages.push({ links: own.map((l) => new URL(l).pathname), outline, path: here.pathname, picture, status: response?.status() ?? null, title: await page.title() });
    for (const link of own) if (!seen.has(link)) queue.push(link);
  }
  writeFileSync(path.join(dir, "pages.json"), JSON.stringify(pages));
});`,
  )
  .join("\n\n")}
`;
}

/** Runs the generated tests in `tests` (a folder of .pom/) at each width, as they print. */
export function play(input: {
  base: string;
  out: string;
  run: string;
  tests: string;
  widths: ReadonlyArray<string>;
}): { status: number | null } {
  const cli = createRequire(path.join(input.out, "x.js")).resolve("@playwright/test/cli");
  return spawnSync(
    process.execPath,
    [
      cli,
      "test",
      "-c",
      path.join(input.out, "playwright.config.ts"),
      ...input.widths.flatMap((w) => ["--project", w]),
      "--reporter",
      "list",
    ],
    {
      env: { ...process.env, POM_BASE_URL: input.base, POM_RUN: input.run, POM_TESTS: input.tests },
      stdio: "inherit",
    },
  );
}

/** Maps the app; returns the map, its pages' trees written where there were none. */
export function map(input: {
  base: string;
  config: Config;
  out: string;
  spec: Spec;
  start: string;
}): { map: AppMap; status: number; trees: ReadonlyArray<string> } {
  const { config, out, spec } = input;
  const widths = Object.keys(config.widths);
  type Way = { entry: string | null; role: string; viaConfig: boolean };
  const roles = [...spec.roles].flatMap((role): Array<Way> => {
    if (role === "visitor") return [{ entry: null, role, viaConfig: false }];
    if (config.roles[role]) return [{ entry: null, role, viaConfig: true }];
    const entry = entryFor(spec, role);
    return entry ? [{ entry: journeyFunction(entry), role, viaConfig: false }] : [];
  });
  const testDir = path.join(out, "map");
  rmSync(testDir, { force: true, recursive: true });
  mkdirSync(testDir, { recursive: true });
  writeFileSync(path.join(testDir, "crawl.spec.ts"), crawlTest({ ...input, roles }));
  const run = path.join(out, "run");
  rmSync(path.join(run, "map"), { force: true, recursive: true });
  const played = play({ base: input.base, out, run, tests: "./map", widths });

  // Each role's pages, merged across widths by route.
  const kept = path.join(out, "map", "pictures");
  // A route's pictures, one name for it whoever sees it, at every width: no two routes share one.
  const named = new Map<string, string>();
  const pictured = new Set<string>();
  const byRoute = new Map<
    string,
    {
      examples: Set<string>;
      links: Set<string>;
      outline: string;
      picture: Record<string, string>;
      role: string;
      title: string;
    }
  >();
  for (const { role } of roles) {
    for (const width of widths) {
      const file = path.join(run, "map", role, width, "pages.json");
      if (!existsSync(file)) continue;
      for (const page of JSON.parse(readFileSync(file, "utf8")) as Array<Crawled>) {
        const route = routeOf(page.path);
        const key = `${role} ${route}`;
        const at = byRoute.get(key) ?? {
          examples: new Set(),
          links: new Set(),
          outline: page.outline,
          picture: {},
          role,
          title: page.title,
        };
        at.examples.add(page.path);
        for (const link of page.links) at.links.add(routeOf(link));
        if (!at.picture[width] && existsSync(page.picture)) {
          if (!named.has(route)) named.set(route, pictureName(route, pictured));
          const to = path.join(kept, role, width, `${named.get(route)}.png`);
          mkdirSync(path.dirname(to), { recursive: true });
          copyFileSync(page.picture, to);
          at.picture[width] = to;
        }
        byRoute.set(key, at);
      }
    }
  }
  // A page every role sees alike is the visitor's alone.
  // Deleting the entry at hand while iterating a Map is safe: the rest are still visited.
  for (const [key, at] of byRoute) {
    if (at.role === "visitor") continue;
    const visitor = byRoute.get(`visitor ${key.slice(at.role.length + 1)}`);
    if (visitor && visitor.outline === at.outline) byRoute.delete(key);
  }

  const index = specIndex(spec);
  const trees: Array<string> = [];
  const routes = new Map<string, Array<typeof byRoute extends Map<string, infer V> ? V : never>>();
  for (const at of byRoute.values()) {
    const route = routeOf([...at.examples][0]!);
    routes.set(route, [...(routes.get(route) ?? []), at]);
  }
  const width = widths[0]!;
  const pages: Array<MappedPage> = [...routes].map(([route, seen]) => {
    const found = pageAt(spec, [...seen[0]!.examples][0]!, seen[0]!.role);
    let tree = found?.page.file ?? null;
    if (!found) {
      // A page's inventory as each role finds it: what all show, then what only one does.
      const dir = path.join(spec.root, ...route.split("/").filter(Boolean));
      const done = writePage(
        dir,
        seen.map((at) => ({
          combo: { role: at.role, state: null, width },
          tree: inventory(readOutline(at.outline)),
        })),
      );
      trees.push(...done.filter((w) => w.kind === "written").map((w) => w.file));
      tree = existsSync(path.join(dir, "page.tree.yml")) ? path.join(dir, "page.tree.yml") : null;
    }
    return {
      journeys: index.pages.find((p) => p.route === route)?.journeys ?? [],
      links: [...new Set(seen.flatMap((at) => [...at.links]))].filter((l) => l !== route),
      route,
      tree,
      variations: Object.fromEntries(
        seen.map((at) => [
          at.role,
          { examples: [...at.examples], picture: at.picture, title: at.title },
        ]),
      ),
    };
  });
  const appMap: AppMap = { pages: pages.sort((a, b) => a.route.localeCompare(b.route)) };
  mkdirSync(path.join(out, "map"), { recursive: true });
  writeFileSync(path.join(out, "map", "map.json"), `${JSON.stringify(appMap, null, 2)}\n`);
  return { map: appMap, status: played.status ?? 1, trees };
}
