import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";
import { entryOf } from "./shots.ts";
import { gitRoot, real } from "./source.ts";
import type { Renderer } from "./types.ts";

// A pull request's "before", drawn fresh: its merge-base checked out beside the
// repository (a git worktree under `.pom/base/`), installed as its lockfile says,
// started by the config's `webServer` on a port of its own, and pictured by pom —
// then kept in this checkout's store under the base's source, as if taken here.

const free = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(),
      );
    });
  });

/** The install a lockfile asks for, in the folder that holds it. */
function install(root: string) {
  const lockfiles: ReadonlyArray<[string, string, Array<string>]> = [
    ["pnpm-lock.yaml", "pnpm", ["install", "--frozen-lockfile"]],
    ["package-lock.json", "npm", ["ci", "--no-audit", "--no-fund"]],
    ["yarn.lock", "yarn", ["install", "--frozen-lockfile"]],
    ["bun.lock", "bun", ["install", "--frozen-lockfile"]],
    ["bun.lockb", "bun", ["install", "--frozen-lockfile"]],
  ];
  const found = lockfiles.find(([file]) => existsSync(path.join(root, file)));
  if (!found) return;
  const run = spawnSync(found[1], found[2], { cwd: root, stdio: "inherit" });
  if (run.status !== 0) throw new Error(`the base's ${found[1]} ${found[2].join(" ")} failed`);
}

const CLI = fileURLToPath(
  new URL(`./cli${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);

/** Pictures the base: true when its pictures are now in `out`'s store under `source`. */
export async function baseRun(input: {
  base: string;
  config: Config;
  out: string;
  renderer: Renderer;
  source: string;
}): Promise<boolean> {
  const { config } = input;
  if (!config.webServer) {
    throw new Error(
      "pom draws the base fresh only with a webServer in pom.config.ts, to start the base's app. Without one: switch to the base, run pom shots, and switch back",
    );
  }
  const root = gitRoot(config.dir);
  if (!root) throw new Error("pom draws the base only in a git repository");
  const tree = path.join(input.out, "base", input.base.slice(0, 12));
  if (!existsSync(tree)) {
    mkdirSync(path.dirname(tree), { recursive: true });
    execFileSync("git", ["worktree", "add", "--detach", tree, input.base], {
      cwd: root,
      stdio: "inherit",
    });
    install(tree);
  }
  const dir = path.join(tree, path.relative(root, real(config.dir)));
  const port = await free();
  const run = spawnSync(
    process.execPath,
    [
      CLI,
      "shots",
      path.relative(config.dir, config.spec) || ".",
      "--no-video",
      "--base-url",
      `http://localhost:${port}`,
    ],
    { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: "inherit" },
  );
  const from = entryOf(
    path.join(path.dirname(path.join(tree, path.relative(root, real(config.spec)))), ".pom"),
    input.source,
    input.renderer,
  );
  if (!existsSync(from)) {
    if (run.status !== 0)
      throw new Error(
        "The base's journeys didn't all pass, so it has no pictures to compare with.",
      );
    return false;
  }
  const to = entryOf(input.out, input.source, input.renderer);
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  const index = path.join(input.out, "shots", "index.json");
  const entries = existsSync(index)
    ? (JSON.parse(readFileSync(index, "utf8")) as Array<unknown>)
    : [];
  entries.push({ at: new Date().toISOString(), ...input.renderer, source: input.source });
  writeFileSync(index, `${JSON.stringify(entries, null, 2)}\n`);
  return true;
}
