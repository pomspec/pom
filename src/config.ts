import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// `pom.config.ts` beside the spec folder: how pom runs the spec against the app.
// Every field has a default, so a spec with none runs as it always did: desktop and
// phone, against `--base-url`, the machine's own Chromium.

/** A width the journeys are pictured at: a Playwright device to start from, and what it changes. */
export type WidthConfig = Readonly<{
  /** `devices["Pixel 7"]`'s name. */
  device?: string;
  deviceScaleFactor?: number;
  hasTouch?: boolean;
  isMobile?: boolean;
  viewport?: Readonly<{ height: number; width: number }>;
}>;

/** Playwright's own `webServer`; its command reads `$PORT`, so a base run can use another. */
export type WebServerConfig = Readonly<{
  command: string;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  port?: number;
  reuseExistingServer?: boolean;
  timeout?: number;
  url?: string;
}>;

export type PomConfig = Readonly<{
  /** Which provider's own agent CLI `pom init` hands the repository to. */
  agent?: string;
  baseURL?: string;
  /** Freeze the page's clock at this instant (ISO); off unless asked. */
  clock?: string;
  colorScheme?: "dark" | "light";
  /** Commit checkpoints beside each journey (`<journey>.shots/`); off: pictures live in `.pom/` and on pull requests. */
  commit?: boolean;
  locale?: string;
  map?: Readonly<{ exclude?: ReadonlyArray<string>; limit?: number }>;
  /** Selectors covered in every picture (and hidden from its structure). */
  mask?: ReadonlyArray<string>;
  /** `host` (the machine's own Playwright Chromium) or `docker` (Playwright's image, as CI runs it). */
  renderer?: "docker" | "host";
  /** A command run before each journey, from the config's folder. */
  reset?: string;
  /** How each role signs in: a module whose default export is `async (page) => …`. */
  roles?: Readonly<Record<string, Readonly<{ signIn: string }>>>;
  /**
   * Environment variables whose values are secrets, beyond those named like one
   * (`*_PASSWORD`, `*_TOKEN`, `*_SECRET`): shown as dots wherever a video says them.
   */
  secrets?: ReadonlyArray<string>;
  /** What draws the pictures: paths whose files, changed, mean the pictures may have. */
  sources?: ReadonlyArray<string>;
  spec?: string;
  /** CSS put on the page for every picture. */
  stylePath?: string;
  /** A picture changed when more than `ratio` of its pixels differ by more than `pixel`. */
  threshold?: Readonly<{ pixel?: number; ratio?: number }>;
  timezoneId?: string;
  /** Record each journey at these widths; `maxMB` is what the repository's GitHub plays inline. */
  video?: false | Readonly<{ maxMB?: number; widths?: ReadonlyArray<string> }>;
  webServer?: WebServerConfig;
  widths?: Readonly<Record<string, WidthConfig>>;
}>;

/** A config with its defaults, and where it lives. */
export type Config = Readonly<{
  agent: string | null;
  baseURL: string | null;
  clock: string | null;
  colorScheme: "dark" | "light";
  commit: boolean;
  /** The folder paths are relative to: the config's own, else the spec's parent. */
  dir: string;
  file: string | null;
  locale: string;
  map: Readonly<{ exclude: ReadonlyArray<string>; limit: number }>;
  mask: ReadonlyArray<string>;
  renderer: "docker" | "host";
  reset: string | null;
  roles: Readonly<Record<string, Readonly<{ signIn: string }>>>;
  secrets: ReadonlyArray<string>;
  sources: ReadonlyArray<string>;
  /** Absolute. */
  spec: string;
  stylePath: string | null;
  threshold: Readonly<{ pixel: number; ratio: number }>;
  timezoneId: string;
  video: Readonly<{ maxMB: number; widths: ReadonlyArray<string> }> | null;
  webServer: WebServerConfig | null;
  widths: Readonly<Record<string, WidthConfig>>;
}>;

export const defineConfig = (config: PomConfig): PomConfig => config;

export const DEFAULT_WIDTHS: Readonly<Record<string, WidthConfig>> = {
  desktop: { deviceScaleFactor: 1, viewport: { height: 900, width: 1280 } },
  phone: { device: "Pixel 7" },
};

const NAMES = ["pom.config.ts", "pom.config.mjs", "pom.config.js"];

/** The config file for a spec folder: beside it, then in its parent. */
export function findConfig(spec: string): string | null {
  for (const dir of [path.dirname(spec), spec]) {
    for (const name of NAMES) {
      if (existsSync(path.join(dir, name))) return path.join(dir, name);
    }
  }
  return null;
}

export function resolveConfig(raw: PomConfig, dir: string, file: string | null): Config {
  const widths = raw.widths ?? DEFAULT_WIDTHS;
  const names = Object.keys(widths);
  if (names.length === 0) throw new Error(`${file ?? dir}: widths names none`);
  for (const name of names) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new Error(`${file ?? dir}: a width's name is lowercase words (${name})`);
    }
  }
  const video =
    raw.video === false
      ? null
      : {
          maxMB: raw.video?.maxMB ?? 100,
          widths: raw.video?.widths ?? [names.includes("desktop") ? "desktop" : names[0]!],
        };
  for (const width of video?.widths ?? []) {
    if (!names.includes(width))
      throw new Error(`${file ?? dir}: video names a width that isn't one: ${width}`);
  }
  return {
    agent: raw.agent ?? null,
    baseURL: raw.baseURL ?? null,
    clock: raw.clock ?? null,
    colorScheme: raw.colorScheme ?? "light",
    commit: raw.commit ?? false,
    dir,
    file,
    locale: raw.locale ?? "en-US",
    map: {
      exclude: raw.map?.exclude ?? ["/sign-out", "/signout", "/logout", "/log-out"],
      limit: raw.map?.limit ?? 50,
    },
    mask: raw.mask ?? ["[data-pom-mask]"],
    renderer: raw.renderer ?? "host",
    reset: raw.reset ?? null,
    roles: raw.roles ?? {},
    secrets: raw.secrets ?? [],
    sources: raw.sources ?? ["."],
    spec: path.resolve(dir, raw.spec ?? "spec"),
    stylePath: raw.stylePath ? path.resolve(dir, raw.stylePath) : null,
    threshold: { pixel: raw.threshold?.pixel ?? 0.1, ratio: raw.threshold?.ratio ?? 0.001 },
    timezoneId: raw.timezoneId ?? "UTC",
    video,
    webServer: raw.webServer ?? null,
    widths,
  };
}

/**
 * The config: `--config`, else the `pom.config.ts` beside the spec named on the command
 * line, else the one in the working folder; read by Node itself (types stripped). With
 * none, the defaults, the spec where it was named (`spec` by default).
 */
export async function loadConfig(options: {
  cwd: string;
  file?: string;
  spec?: string;
}): Promise<Config> {
  const spec = options.spec ? path.resolve(options.cwd, options.spec) : null;
  const found = options.file
    ? path.resolve(options.cwd, options.file)
    : spec
      ? findConfig(spec)
      : (NAMES.map((name) => path.join(options.cwd, name)).find((file) => existsSync(file)) ??
        null);
  if (!found) {
    const at = spec ?? path.join(options.cwd, "spec");
    return resolveConfig({ spec: path.basename(at) }, path.dirname(at), null);
  }
  const module = (await import(pathToFileURL(found).href)) as { default?: PomConfig };
  const raw = module.default ?? {};
  const dir = path.dirname(found);
  // A spec named on the command line wins over the config's.
  return resolveConfig(spec ? { ...raw, spec: path.relative(dir, spec) || "." } : raw, dir, found);
}
