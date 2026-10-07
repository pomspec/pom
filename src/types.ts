// A spec as data (indexer.ts makes it): types alone, so a page that shows a
// spec imports nothing of pom's own, which reads files.

/** A width the journeys are pictured at, by its name in the config (`desktop`, `phone`). */
export type Width = string;

export type IndexedTree = Readonly<{
  file: string;
  source: string;
  /** What only a variation shows: a width, a role, a state (`# when …`). */
  variations: Readonly<Record<string, Readonly<{ file: string; source: string }>>>;
}>;

export type IndexedPage = Readonly<{
  /** `/settings/[slug]` */
  route: string;
  /** The role it is for, when two pages share its route. */
  groups: ReadonlyArray<string>;
  tree: IndexedTree;
  /** What it shares with the pages around it, outermost first. */
  layouts: ReadonlyArray<IndexedTree & Readonly<{ dir: string }>>;
  dialogs: ReadonlyArray<Readonly<{ name: string; file: string; source: string }>>;
  /** The journeys that pass through it, by id. */
  journeys: ReadonlyArray<string>;
}>;

export type IndexedLine = Readonly<{
  /** The Gherkin, as written. */
  source: string;
  line: number;
  /** Who acts at this line. */
  role: string;
  /** The state its journey says the app is in (`# when empty`), if it says. */
  state: string | null;
  /** The route of the page it is on, when it is on one. */
  page: string | null;
  /** The moment whose picture shows the screen once this line has happened (`start`, `press-save`…). */
  moment: string;
}>;

export type IndexedJourney = Readonly<{
  /** Its file, relative to the spec, without `.feature`: `(visitor)/sign-up/sign-up`. */
  id: string;
  title: string;
  file: string;
  /** The journey played first to sign in, by id. */
  signsInWith: string | null;
  background: ReadonlyArray<IndexedLine>;
  steps: ReadonlyArray<Readonly<{ caption: string; lines: ReadonlyArray<IndexedLine> }>>;
  /** Its pictures and moments (`pom shots`), when it has been pictured. */
  manifest: Manifest | null;
}>;

export type SpecIndex = Readonly<{
  pages: ReadonlyArray<IndexedPage>;
  journeys: ReadonlyArray<IndexedJourney>;
}>;

/** Where a control is on the screen, in CSS pixels, rounded: `[x, y, width, height]`. */
export type Box = readonly [number, number, number, number];

/**
 * What drew a picture set, as Playwright tells baselines apart: the platform (fonts
 * differ between them) and Playwright's version (which pins its browser). Two sets
 * compare only when both agree.
 */
export type Renderer = Readonly<{ platform: string; playwright: string }>;

/** The code that drew a picture set: a hash of the config's `sources`, and the commit it sat on. */
export type Taken = Readonly<{ commit: string | null; dirty: boolean; source: string }>;

export type MomentPicture = Readonly<{
  /** Where the next action's control is, so a player can point at it. */
  box: Box | null;
  /** Relative to the journey's pictures folder: `desktop/start.png`. */
  file: string;
  sha256: string;
}>;

export type Moment = Readonly<{
  /** The line that made the screen; none for the start. */
  after: Readonly<{ line: number; source: string }> | null;
  /** The structure changed here (or it starts or ends the journey): a picture worth keeping. */
  checkpoint: boolean;
  /** `start`, else the line's verb and name: `press-create-account`, `fill-email-2`. */
  id: string;
  /** The `after` line's place in its step, −1 for the start: the kit's breakpoint key with `step`. */
  index: number;
  journey: string;
  /** Where the pointer goes next. */
  next: Readonly<{ line: number; name: string | null; role: string | null; verb: string }> | null;
  /** The route of the page it is on. */
  page: string | null;
  /** By width: every moment's in pom's own store, only checkpoints' where a repository keeps them. */
  pictures?: Readonly<Record<Width, MomentPicture>>;
  /** Who acts at this moment. */
  role: string;
  /** The state its journey says the app is in (`# when …`), if it says: with role and width, its variation. */
  state: string | null;
  step: number;
}>;

/** A journey's pictures as data: `shots.json`. */
export type Manifest = Readonly<{
  journey: string;
  moments: ReadonlyArray<Moment>;
  pom: 1;
  renderer: Renderer;
  /** Its steps' captions, in order. */
  steps: ReadonlyArray<string>;
  taken: Taken;
  title: string;
  widths: Readonly<Record<Width, Readonly<{ height: number; width: number }>>>;
}>;
