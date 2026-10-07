import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Config } from "./config.ts";
import { journeyId } from "./generate.ts";
import { manifest, pictureFile, type Seen, stable } from "./moments.ts";
import { compare, sha256, size } from "./png.ts";
import type { Result } from "./reporter.ts";
import type { Spec } from "./spec.ts";
import { picture } from "./terminal.ts";
import type { Manifest, Renderer, Taken, Width } from "./types.ts";

// `pom shots`: the journeys played at every width (and recorded), their pictures kept
// where they belong. By default in pom's own store, `.pom/shots/<source>/pw<version>/`,
// keyed by the code that drew them and the Playwright that did: the same code, the
// same pictures, so a pull request's "before" is there when it was taken once. With
// `commit`, a journey's checkpoints are also written beside it (`<journey>.shots/`).
//
// A journey is kept only when it passed at every width; a picture is rewritten only
// when it changed beyond the threshold, so two runs of the same code are the same bytes.

export type ShotsOptions = Readonly<{
  base: string;
  commit: boolean;
  config: Config;
  /** Playwright's own arguments: a run they narrow keeps only what ran at every width. */
  extra: ReadonlyArray<string>;
  out: string;
  /** Where the pictures are drawn, when not this machine: Playwright's image's `linux/arm64`. */
  platform?: string;
  spec: Spec;
  taken: Taken;
  video: boolean;
  ws?: string;
}>;

export type Kept = Readonly<{
  /** Checkpoints whose pictures changed against the last ones kept, by width. */
  changed: ReadonlyArray<Readonly<{ id: string; width: Width }>>;
  journey: string;
  manifest: Manifest;
  video: string | null;
}>;

export type ShotsResult = Readonly<{
  /** Where this source's pictures are. */
  entry: string;
  failed: ReadonlyArray<Readonly<{ error: string | null; journey: string; width: Width }>>;
  kept: ReadonlyArray<Kept>;
  status: number;
}>;

/** The project's Playwright version: what pins its browser, and so its pictures. */
export function playwrightVersion(out: string): string {
  const file = createRequire(path.join(out, "x.js")).resolve("@playwright/test/package.json");
  return (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
}

export const rendererOf = (out: string, platform: string = process.platform): Renderer => ({
  platform,
  playwright: playwrightVersion(out),
});

/** A source's pictures, drawn by this Playwright. */
export const entryOf = (out: string, source: string, renderer: Renderer) =>
  path.join(
    out,
    "shots",
    source,
    `${renderer.platform.replace("/", "-")}-pw${renderer.playwright}`,
  );

type Index = Array<{ at: string; platform: string; playwright: string; source: string }>;

const readIndex = (out: string): Index =>
  existsSync(path.join(out, "shots", "index.json"))
    ? (JSON.parse(readFileSync(path.join(out, "shots", "index.json"), "utf8")) as Index)
    : [];

/** How many sources' pictures pom keeps: a pull request's base and head, and some behind. */
const KEEP = 12;

/** The latest pictures of a journey this Playwright drew, other than `source`'s. */
function previous(out: string, renderer: Renderer, journey: string, source: string): string | null {
  for (const entry of readIndex(out)) {
    if (entry.playwright !== renderer.playwright || entry.platform !== renderer.platform) continue;
    if (entry.source === source) continue;
    const dir = path.join(entryOf(out, entry.source, renderer), journey);
    if (existsSync(path.join(dir, "shots.json"))) return dir;
  }
  return null;
}

const copyTree = (from: string, to: string) => {
  if (!existsSync(from)) return;
  for (const entry of readdirSync(from)) {
    const a = path.join(from, entry);
    const b = path.join(to, entry);
    if (statSync(a).isDirectory()) copyTree(a, b);
    else if (entry.endsWith(".png")) {
      mkdirSync(to, { recursive: true });
      copyFileSync(a, b);
    }
  }
};

const readManifest = (file: string): Manifest | null =>
  existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Manifest) : null;

/** Writes a file only when its bytes change: the same pictures leave the same files, and mtimes. */
function writeIfChanged(file: string, bytes: Buffer | string) {
  const next = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
  if (existsSync(file) && readFileSync(file).equals(next)) return false;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, next);
  return true;
}

/** The path of a journey's committed pictures: beside its `.feature`. */
export const committedDir = (spec: Spec, journey: string) =>
  path.join(spec.root, `${journey}.shots`);

const hasFfmpeg = () => spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

export function shots(options: ShotsOptions): ShotsResult {
  const { config, out, spec, taken } = options;
  const renderer = rendererOf(out, options.platform);
  const entry = entryOf(out, taken.source, renderer);
  const run = path.join(out, "run");
  const widths = Object.keys(config.widths);
  const journeys = new Map(spec.journeys.map((journey) => [journeyId(spec, journey), journey]));

  // Seeded with the pictures kept last, so `toHaveScreenshot` leaves one that did not change.
  rmSync(run, { force: true, recursive: true });
  mkdirSync(run, { recursive: true });
  for (const id of journeys.keys()) {
    const committed = options.commit
      ? readManifest(path.join(committedDir(spec, id), "shots.json"))
      : null;
    const seed =
      committed?.renderer.platform === renderer.platform &&
      committed.renderer.playwright === renderer.playwright
        ? committedDir(spec, id)
        : existsSync(path.join(entry, id))
          ? path.join(entry, id)
          : previous(out, renderer, id, taken.source);
    if (seed) copyTree(seed, path.join(run, id));
  }

  const cli = createRequire(path.join(out, "x.js")).resolve("@playwright/test/cli");
  const projects = [
    ...widths,
    ...(options.video ? (config.video?.widths ?? []).map((w) => `video-${w}`) : []),
  ];
  const played = spawnSync(
    process.execPath,
    [
      cli,
      "test",
      "-c",
      path.join(out, "playwright.config.ts"),
      ...projects.flatMap((p) => ["--project", p]),
      ...options.extra,
    ],
    {
      env: {
        ...process.env,
        POM_BASE_URL: options.base,
        POM_RUN: run,
        POM_SHOTS: "1",
        ...(options.ws ? { POM_WS: options.ws } : {}),
      },
      stdio: "inherit",
    },
  );
  const results: Array<Result> = existsSync(path.join(run, "results.json"))
    ? (JSON.parse(readFileSync(path.join(run, "results.json"), "utf8")) as Array<Result>)
    : [];

  const failed: Array<{ error: string | null; journey: string; width: Width }> = [];
  const kept: Array<Kept> = [];
  const narrowed = options.extra.length > 0;
  for (const [id, journey] of journeys) {
    const mine = results.filter((r) => r.journey === id);
    const at = (width: Width) => mine.find((r) => r.project === width);
    if (mine.length === 0) continue;
    const missing = widths.filter((width) => at(width)?.status !== "passed");
    for (const width of missing) {
      const result = at(width);
      failed.push({ error: result ? result.error : "not run at this width", journey: id, width });
    }
    if (missing.length) continue;

    const seen = Object.fromEntries(
      widths.map((width) => [width, at(width)!.moments as Array<Seen>]),
    );
    const pictureAt = (width: Width, momentId: string) =>
      path.join(run, id, pictureFile(width, momentId));
    // A picture within the threshold of the one kept last keeps that one's bytes.
    const before = previous(out, renderer, id, taken.source);
    const own = existsSync(path.join(entry, id, "shots.json")) ? path.join(entry, id) : before;
    const changed: Array<{ id: string; width: Width }> = [];
    const bytes = new Map<string, Buffer>();
    for (const width of widths) {
      for (const moment of seen[width]!) {
        const fresh = readFileSync(pictureAt(width, moment.id));
        const old = own ? path.join(own, pictureFile(width, moment.id)) : null;
        const prior = old && existsSync(old) ? readFileSync(old) : null;
        const same = prior && !compare(prior, fresh, config.threshold).changed;
        bytes.set(`${width}/${moment.id}`, same ? prior! : fresh);
        if (prior && !same) changed.push({ id: moment.id, width });
      }
    }
    const dims = Object.fromEntries(
      widths.map((width) => [
        width,
        size(bytes.get(`${width}/start`) ?? Buffer.alloc(0)) ?? { height: 0, width: 0 },
      ]),
    );
    const steps = journey.steps.map((step) => step.caption);
    const shasum = (width: Width, momentId: string) => sha256(bytes.get(`${width}/${momentId}`)!);
    const full = manifest({
      frames: true,
      journey: id,
      renderer,
      seen,
      sha256: shasum,
      steps,
      taken,
      title: journey.title,
      widths: dims,
    });
    const checkpoints = new Set(full.moments.filter((m) => m.checkpoint).map((m) => m.id));

    // pom's own store: every frame, the outline each moment had.
    const dir = path.join(entry, id);
    rmSync(dir, { force: true, recursive: true });
    for (const [key, data] of bytes) writeIfChanged(path.join(dir, `${key}.png`), data);
    writeFileSync(
      path.join(dir, "outlines.json"),
      `${JSON.stringify(Object.fromEntries(widths.map((w) => [w, seen[w]!.map((m) => ({ id: m.id, structure: m.structure }))])))}\n`,
    );
    writeFileSync(path.join(dir, "shots.json"), stable(full));

    if (options.commit) promote(spec, id, full, bytes, widths, taken);

    // The video, beside what happened when.
    let webm: string | null = null;
    for (const width of config.video?.widths ?? []) {
      const recorded = mine.find((r) => r.project === `video-${width}`);
      const info = recorded?.video as {
        chapters: unknown;
        file: string;
        moments: unknown;
        ms: number;
      } | null;
      if (recorded?.status !== "passed" || !info || !existsSync(info.file)) continue;
      const to = path.join(out, "videos", taken.source, `${id}.${width}.webm`);
      mkdirSync(path.dirname(to), { recursive: true });
      renameSync(info.file, to);
      writeFileSync(
        to.replace(/\.webm$/, ".json"),
        `${JSON.stringify({ chapters: info.chapters, moments: info.moments, ms: info.ms }, null, 2)}\n`,
      );
      if (hasFfmpeg()) {
        spawnSync(
          "ffmpeg",
          [
            "-y",
            "-loglevel",
            "error",
            "-i",
            to,
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-an",
            to.replace(/\.webm$/, ".mp4"),
          ],
          { stdio: "inherit" },
        );
      }
      webm ??= to;
    }
    kept.push({
      changed: changed.filter((c) => checkpoints.has(c.id)),
      journey: id,
      manifest: full,
      video: webm,
    });
  }

  // Journeys gone from the spec leave their committed pictures behind no more.
  if (options.commit && !narrowed) {
    const visit = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (!statSync(full).isDirectory()) continue;
        if (name.endsWith(".shots")) {
          const id = path
            .relative(spec.root, full)
            .replace(/\.shots$/, "")
            .split(path.sep)
            .join("/");
          if (!journeys.has(id)) rmSync(full, { force: true, recursive: true });
        } else if (!name.startsWith(".")) visit(full);
      }
    };
    visit(spec.root);
  }

  if (kept.length) {
    const index = readIndex(out).filter(
      (e) =>
        !(
          e.source === taken.source &&
          e.playwright === renderer.playwright &&
          e.platform === renderer.platform
        ),
    );
    index.unshift({ at: new Date().toISOString(), ...renderer, source: taken.source });
    for (const old of index.slice(KEEP)) {
      rmSync(entryOf(out, old.source, old), { force: true, recursive: true });
      rmSync(path.join(out, "videos", old.source), { force: true, recursive: true });
    }
    mkdirSync(path.join(out, "shots"), { recursive: true });
    writeFileSync(
      path.join(out, "shots", "index.json"),
      `${JSON.stringify(index.slice(0, KEEP), null, 2)}\n`,
    );
  }

  return { entry, failed, kept, status: played.status ?? 1 };
}

/**
 * A journey's checkpoints into the repository, beside its `.feature`: a picture only
 * when its bytes changed, any file the manifest no longer names removed, `shots.json`
 * last, and only when it changed; `taken` stays when the code that drew them did.
 */
function promote(
  spec: Spec,
  id: string,
  full: Manifest,
  bytes: ReadonlyMap<string, Buffer>,
  widths: ReadonlyArray<Width>,
  taken: Taken,
) {
  const dir = committedDir(spec, id);
  const old = readManifest(path.join(dir, "shots.json"));
  const committed: Manifest = {
    ...full,
    moments: full.moments.map(({ pictures, ...moment }) =>
      moment.checkpoint && pictures ? { ...moment, pictures } : moment,
    ),
    taken: old && old.taken.source === taken.source ? old.taken : taken,
  };
  const named = new Set(["shots.json"]);
  for (const moment of committed.moments) {
    if (!moment.pictures) continue;
    for (const width of widths) {
      const file = pictureFile(width, moment.id);
      named.add(file.split("/").join(path.sep));
      writeIfChanged(path.join(dir, file), bytes.get(`${width}/${moment.id}`)!);
    }
  }
  const remove = (at: string) => {
    if (!existsSync(at)) return;
    for (const name of readdirSync(at)) {
      const full = path.join(at, name);
      if (statSync(full).isDirectory()) {
        remove(full);
        if (readdirSync(full).length === 0) rmSync(full, { recursive: true });
      } else if (!named.has(path.relative(dir, full))) rmSync(full);
    }
  };
  remove(dir);
  writeIfChanged(path.join(dir, "shots.json"), stable(committed));
}

/** What a run kept and what changed, for a person; changed checkpoints pictured where the terminal can. */
export function report(result: ShotsResult) {
  for (const kept of result.kept) {
    const checkpoints = kept.manifest.moments.filter((m) => m.checkpoint).length;
    console.log(
      `${kept.manifest.title}: ${kept.manifest.moments.length} moments, ${checkpoints} checkpoints${kept.video ? ", recorded" : ""}`,
    );
    for (const change of kept.changed) {
      const file = path.join(result.entry, kept.journey, pictureFile(change.width, change.id));
      console.log(
        `  changed: ${change.id} (${change.width})  ${path.relative(process.cwd(), file)}`,
      );
      process.stdout.write(picture(file));
    }
  }
  for (const failed of result.failed) {
    console.log(
      `not kept: ${failed.journey} at ${failed.width}${failed.error ? `: ${failed.error}` : ""}`,
    );
  }
  if (result.kept.length)
    console.log(`pictures in ${path.relative(process.cwd(), result.entry) || "."}/`);
}
