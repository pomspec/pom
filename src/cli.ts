#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { installed, PROVIDERS, providerOf, relativeBrief, runAgent, shown } from "./agents.ts";
import { baseRun } from "./base.ts";
import { checkSpec } from "./check.ts";
import { type Config, loadConfig } from "./config.ts";
import { commitSide, type Diff, diff, storeEntry } from "./diff.ts";
import { SpecError, VISITOR } from "./feature.ts";
import { generate } from "./generate.ts";
import { CODEOWNERS, init } from "./init.ts";
import { map } from "./map.ts";
import { noToken, vouchable, workflowToken } from "./oidc.ts";
import { videos } from "./play.ts";
import { newer, publish, pullRequest, section, withSection } from "./pr.ts";
import { nativePlatform, startDocker } from "./renderer.ts";
import { rendererOf, report, type ShotsResult, shots } from "./shots.ts";
import { snapshot, snapshotArgs, waysIn } from "./snapshot.ts";
import { defaultBase, filesAt, gitRoot, mergeBase, sourceAt, takenNow } from "./source.ts";
import { picture } from "./terminal.ts";
import { runsIn, runsOf } from "./videos.ts";
import { defaultProject, publishFor, SERVICE_URL, serviceOf } from "./service.ts";
import { readSpec, type Spec } from "./spec.ts";

// pom init [url] [--agent <provider>]  a repository made ready: pom.config.ts, spec/,
//                                      on GitHub its workflow (init.ts), then the spec
//                                      written by your own agent (you choose which; pom
//                                      runs its own command, under its own sign-in),
//                                      then the app mapped, then what's next
// pom check [spec]                     journeys against their pages, no browser
// pom generate [spec]                  the spec as Playwright page objects and tests, in .pom/
// pom test [spec] [--base-url <url>]   generate, then run them against the app there
// pom shots [spec] [--base-url <url>]  every journey at every width, pictured and recorded:
//                                      into .pom/ (and with --commit, its checkpoints
//                                      beside each journey); --docker draws in
//                                      Playwright's image, as CI does
// pom diff [spec] [--base <ref>]       the pictures against the base branch's (at the
//                                      merge-base): from pom's store, from git when
//                                      committed, else drawn fresh (--run, a webServer)
// pom snapshot [spec] <path>… [--as <role>]…
//                                      pages as the app shows them now, as each role,
//                                      at every width: pictured, their outlines kept
//                                      with each node's box, and their trees written
// pom map [spec] [--base-url <url>]   the app crawled by its links, as each role:
//                                      every page pictured, a tree for each route
//                                      that has none, and the pages no journey visits
// pom pr [spec] [--dry-run]            this checkout pictured, then its before and after
//                                      and videos into its pull request's description
//                                      (gh, as you); --dry-run prints it instead
// pom videos [spec] [--head-url <url>] [--base-url <url>] [--start <command> --ready-url <url>]
//            [--base-dir <dir>]        the journeys played on a pull request's head and
//                                      base, each recorded for pomspec, into .pom/runs/<run>
//                                      for pom upload (play.ts; --help says the rest)
// pom upload [spec] [--run <id>] [--project <slug> | --repo <owner/name>] [--pull <n>]
//            [--job <id>] [--feature-commit <sha>] [--replace]
//                                      a run played here (.pom/runs/<id>) onto pomspec,
//                                      into its project (by its address, or by the GitHub
//                                      repository linked to it; a spec with no GitHub
//                                      remote goes to its name's project), as the
//                                      organization's runner (POM_RUNNER_TOKEN, created in
//                                      Settings → Runners; on GitHub Actions, without one,
//                                      the workflow GitHub vouches for), at pomspec.com unless
//                                      --service or POM_SERVICE_URL says another: its
//                                      videos, files and journeys; prints the address of
//                                      its page, last
// pom --help, pom <command> --help     what each command takes
//
// The spec, base URL and widths come from pom.config.ts beside the spec when there is
// one. What follows `--` goes to Playwright as it is: `pom test -- --grep "Sign up"`.

// `pom videos` reads its own arguments (play.ts).
if (process.argv[2] === "videos") process.exit(await videos(process.argv.slice(3)));

const split = process.argv.indexOf("--");
const own = split === -1 ? process.argv.slice(2) : process.argv.slice(2, split);
const rest = split === -1 ? [] : process.argv.slice(split + 1);
// To `pom upload`, `--run` names the run; to `pom diff`, it draws the base fresh.
const uploading = own[0] === "upload";
const { positionals, values } = parseArgs({
  allowPositionals: true,
  args: own,
  options: {
    agent: { type: "string" },
    as: { type: "string", multiple: true },
    base: { type: "string" },
    "base-url": { type: "string" },
    commit: { type: "boolean" },
    config: { type: "string" },
    "dry-run": { type: "boolean" },
    force: { type: "boolean" },
    docker: { type: "boolean" },
    "no-video": { type: "boolean" },
    "feature-commit": { type: "string" },
    help: { short: "h", type: "boolean" },
    job: { type: "string" },
    out: { type: "string" },
    project: { type: "string" },
    pull: { type: "string" },
    replace: { type: "boolean" },
    repo: { type: "string" },
    run: { type: uploading ? "string" : "boolean" },
    service: { type: "string" },
  },
});
const [command, ...args] = positionals;
// A snapshot's pages are addresses, from a slash; the spec is a folder on disk, which may
// be named from a slash too (snapshot.ts tells them apart, and says when both could be).
const snapshotting =
  command === "snapshot"
    ? snapshotArgs(args, [process.cwd(), gitRoot(process.cwd()) ?? process.cwd()])
    : null;
const named = snapshotting ? snapshotting.specs[0] : args[0];

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const USAGE = [
  "pom init [url] [--agent claude|codex|gemini|copilot|opencode|pi|none] [--commit]",
  "pom check [spec]",
  "pom generate [spec] [--out dir]",
  "pom test [spec] [--base-url <url>] [-- <playwright args>]",
  "pom shots [spec] [--base-url <url>] [--commit] [--docker] [--no-video]",
  "pom diff [spec] [--base <ref>] [--run]",
  "pom snapshot [spec] <path>... [--as <role>]... [--base-url <url>]",
  "pom map [spec] [--base-url <url>]",
  "pom pr [spec] [--base <ref>] [--dry-run] [--force]",
  "pom videos [spec] [--head-url <url>] [--base-url <url>] [--start <command> --ready-url <url>] [--base-dir <dir>] (--help)",
  "pom upload [spec] [--run <id>] [--project <slug> | --repo <owner/name>] [--pull <n>] [--job <id>] [--feature-commit <sha>] [--replace] [--service <url>]",
];

// `pom --help`, or a command's own line: asked for, so on stdout, and no failure.
if (values.help) {
  const own = USAGE.filter((line) => line.startsWith(`pom ${command} `));
  console.log((own.length ? own : USAGE).join("\n"));
  process.exit(0);
}

async function setup(): Promise<{ config: Config; out: string; spec: Spec }> {
  let config: Config;
  try {
    config = await loadConfig({ cwd: process.cwd(), file: values.config, spec: named });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const out = path.resolve(values.out ?? path.join(path.dirname(config.spec), ".pom"));
  try {
    return { config, out, spec: readSpec(config.spec, Object.keys(config.widths)) };
  } catch (error) {
    if (error instanceof SpecError || error instanceof Error) return fail(error.message);
    throw error;
  }
}

const where = (file: string, line: number) => `${path.relative(process.cwd(), file)}:${line}`;

function check(spec: Spec, config: Config): boolean {
  const { compiled, problems, unvisited } = checkSpec(spec, {
    signIns: new Set(Object.keys(config.roles)),
  });
  for (const p of problems) console.error(`${where(p.file, p.line)}: ${p.message}`);
  for (const page of unvisited) console.log(`${page.route}: no journey visits it`);
  const lines = compiled.reduce(
    (n, c) => n + c.steps.reduce((m, s) => m + s.calls.length, c.background.length),
    0,
  );
  console.log(
    `${spec.pages.length} pages, ${spec.journeys.length} journeys, ${lines} lines: ${
      problems.length ? `${problems.length} problems` : "every line finds its control"
    }`,
  );
  return problems.length === 0;
}

const baseOf = (config: Config): string => {
  const base =
    values["base-url"] ??
    process.env.POM_BASE_URL ??
    config.baseURL ??
    config.webServer?.url ??
    (config.webServer?.port ? `http://localhost:${config.webServer.port}` : null);
  return (
    base ??
    fail(
      "pom needs where the app runs: --base-url <url>, POM_BASE_URL, or baseURL in pom.config.ts",
    )
  );
};

/** Pictures every journey now, as `pom shots` does: what `diff` and `pr` compare. */
async function shoot(
  config: Config,
  out: string,
  spec: Spec,
  video: boolean,
): Promise<ShotsResult> {
  const base = baseOf(config);
  const docker =
    values.docker || config.renderer === "docker"
      ? await startDocker(rendererOf(out).playwright)
      : null;
  try {
    const result = shots({
      base,
      commit: values.commit ?? config.commit,
      config,
      extra: rest,
      out,
      ...(docker ? { platform: docker.platform } : {}),
      spec,
      taken: takenNow(config),
      video: video && !values["no-video"] && config.video !== null,
      ...(docker ? { ws: docker.wsEndpoint } : {}),
    });
    report(result);
    return result;
  } finally {
    docker?.stop();
  }
}

/** The pull request's pictures against its base's, taking whichever side is missing. */
export async function compareWithBase(config: Config, out: string, spec: Spec): Promise<Diff> {
  const renderer = rendererOf(
    out,
    values.docker || config.renderer === "docker" ? nativePlatform() : undefined,
  );
  const taken = takenNow(config);
  let after = storeEntry(out, taken.source, renderer);
  if (!after) {
    console.log("Picturing this checkout first.");
    const result = await shoot(config, out, spec, true);
    if (result.failed.length)
      fail("Not every journey passed, so there's nothing whole to compare.");
    after = storeEntry(out, taken.source, renderer)!;
  }
  const ref = values.base ?? defaultBase(config);
  const base = mergeBase(config, ref);
  const source = sourceAt(config, base);
  let before = values.run ? null : storeEntry(out, source, renderer);
  if (!before && (values.commit ?? config.commit)) {
    const committed = commitSide(config, spec, base);
    if (committed.manifests.size) before = committed;
  }
  const hadJourneys = filesAt(config, base, spec.root).some((file) => file.endsWith(".feature"));
  if (!before && hadJourneys) {
    if (source === taken.source) before = after;
    else if (values.run || config.webServer) {
      console.log(`Picturing the base (${base.slice(0, 7)}) fresh.`);
      if (await baseRun({ base, config, out, renderer, source }))
        before = storeEntry(out, source, renderer);
    } else {
      fail(
        `No pictures of the base (${ref} at ${base.slice(0, 7)}) yet: switch to it, run pom shots, and switch back; or give pom.config.ts a webServer, and pom draws it fresh`,
      );
    }
  }
  return diff({ after, before, config, dir: path.join(out, "diff") });
}

/** Asks a question on the terminal; none when there is no one to ask. */
async function ask(question: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const io = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await io.question(question)).trim();
  } finally {
    io.close();
  }
}

switch (command) {
  case "init": {
    const url = named ?? values["base-url"] ?? null;
    const commit = values.commit ?? false;
    let choice = values.agent ?? null;
    if (!choice) {
      console.log(
        "Which agent writes your spec? pom runs that agent's own command, under its own sign-in:",
      );
      PROVIDERS.forEach((p, i) =>
        console.log(`  ${i + 1}. ${p.name}${installed(p) ? "" : " (not installed)"}`),
      );
      console.log(`  ${PROVIDERS.length + 1}. None: I'll ask my agent myself`);
      const answer = await ask("Choose a number: ");
      const index = Number(answer) - 1;
      choice = PROVIDERS[index]?.id ?? "none";
    }
    const provider = choice === "none" ? null : providerOf(choice);
    if (choice !== "none" && !provider)
      fail(`pom knows no agent "${choice}": ${PROVIDERS.map((p) => p.id).join(", ")}, or none`);
    const done = init({
      agent: provider?.id ?? null,
      baseURL: url,
      commit,
      dir: process.cwd(),
      service: process.env.POM_SERVICE_URL || null,
    });
    for (const file of done.created)
      console.log(`made ${path.relative(process.cwd(), file) || "."}`);
    for (const note of done.notes) console.log(note);
    console.log(
      `For CODEOWNERS, so the spec is reviewed and its pictures are not:\n  ${CODEOWNERS.join("\n  ")}`,
    );
    if (!provider) {
      console.log(`To have your agent write the spec, ask it to follow ${relativeBrief()}.`);
    } else if (!installed(provider)) {
      console.log(
        `${provider.name} isn't installed here. Once it is (and signed in: ${provider.login}), run pom init --agent ${provider.id} again.`,
      );
    } else {
      console.log(`\n${shown(provider, process.cwd())}\n`);
      const yes = (await ask("Run it? [Y/n] ")) ?? "y";
      if (/^(y|yes|)$/i.test(yes)) {
        const status = runAgent(provider, process.cwd());
        if (status !== 0)
          console.log(
            `${provider.name} stopped (${status}). If it isn't signed in: ${provider.login}.`,
          );
      }
    }
    const mapped = url
      ? spawnSync(process.execPath, [process.argv[1]!, "map", "--base-url", url], {
          stdio: "inherit",
        }).status
      : 0;
    // What's next, last, whatever the map found.
    console.log(`\n${done.next.join("\n")}`);
    process.exit(mapped ?? 1);
  }
  case "check": {
    const { config, spec } = await setup();
    process.exit(check(spec, config) ? 0 : 1);
  }
  case "generate":
  case "shots":
  case "test": {
    const { config, out, spec } = await setup();
    if (!check(spec, config)) process.exit(1);
    const { written } = generate(spec, out, { config });
    console.log(`wrote ${written.length} files to ${path.relative(process.cwd(), out)}/`);
    if (command === "generate") process.exit(0);
    if (command === "test") {
      const base = baseOf(config);
      const cli = createRequire(path.join(out, "x.js")).resolve("@playwright/test/cli");
      const first = Object.keys(config.widths)[0]!;
      const run = spawnSync(
        process.execPath,
        [cli, "test", "-c", path.join(out, "playwright.config.ts"), "--project", first, ...rest],
        { env: { ...process.env, POM_BASE_URL: base }, stdio: "inherit" },
      );
      process.exit(run.status ?? 1);
    }
    const result = await shoot(config, out, spec, true);
    process.exit(result.failed.length ? 1 : result.status);
  }
  case "diff": {
    const { config, out, spec } = await setup();
    if (!check(spec, config)) process.exit(1);
    generate(spec, out, { config });
    const result = await compareWithBase(config, out, spec);
    for (const note of result.notes) console.log(note);
    const changed = result.journeys.filter((j) => j.status !== "unchanged");
    if (result.before === null)
      console.log(`No journeys at the base yet: ${result.journeys.length} pictured here.`);
    else if (changed.length === 0) console.log("No visual change.");
    for (const journey of changed) {
      console.log(`${journey.title}: ${journey.status}`);
      for (const moment of journey.moments.filter((m) => m.status !== "unchanged")) {
        const m = moment.after ?? moment.before!;
        console.log(`  ${m.after?.source ?? "The start"} · ${moment.status}`);
        const desktop = Object.values(moment.widths)[0];
        const file = desktop?.pair ?? desktop?.after ?? desktop?.before;
        if (file) process.stdout.write(picture(file, 100));
      }
    }
    console.log(
      `before and after in ${path.relative(process.cwd(), path.join(out, "diff"))}/ (diff.html, diff.md)`,
    );
    process.exit(0);
  }
  case "snapshot": {
    const { notes, paths, specs } = snapshotting!;
    for (const note of notes) console.log(note);
    if (specs.length > 1) fail(`pom snapshot takes one spec, not ${specs.join(" and ")}`);
    if (!paths.length) fail("pom snapshot needs a path: pom snapshot /sign-up [--as <role>]");
    const { config, out, spec } = await setup();
    const { compiled } = checkSpec(spec, { signIns: new Set(Object.keys(config.roles)) });
    generate(spec, out, { config, partial: true });
    const ways = waysIn(
      spec,
      config,
      values.as?.length ? values.as : [VISITOR],
      new Set(compiled.map((c) => c.journey.file)),
    );
    if (typeof ways === "string") fail(ways);
    const result = snapshot({
      base: baseOf(config),
      config,
      out,
      paths,
      spec,
      ways: ways as Exclude<typeof ways, string>,
    });
    const shown = (file: string) => path.relative(process.cwd(), file);
    for (const s of result.snapped) {
      console.log(`${s.path}${s.at === s.path ? "" : ` (landed on ${s.at})`} as ${s.role}:`);
      for (const [width, f] of Object.entries(s.files))
        console.log(`  ${width}: ${shown(f.picture)} ${shown(f.outline)}`);
    }
    for (const t of result.trees)
      console.log(`${t.kind === "kept" ? "kept, a person's" : "tree"}: ${shown(t.file)}`);
    if (result.status !== 0) process.exit(result.status);
    process.exit(check(readSpec(config.spec, Object.keys(config.widths)), config) ? 0 : 1);
  }
  case "map": {
    const { config, out, spec } = await setup();
    if (!check(spec, config)) process.exit(1);
    generate(spec, out, { config });
    const base = baseOf(config);
    const result = map({ base, config, out, spec, start: "/" });
    const roles = new Set(result.map.pages.flatMap((p) => Object.keys(p.variations)));
    console.log(`${result.map.pages.length} pages, as ${[...roles].join(", ")}`);
    for (const file of result.trees) console.log(`tree: ${path.relative(process.cwd(), file)}`);
    const todo = result.map.pages.filter((p) => p.journeys.length === 0);
    if (todo.length) {
      console.log(
        `No journey visits ${todo.length === 1 ? "this page" : `these ${todo.length} pages`} yet:`,
      );
      for (const page of todo) {
        const seen = Object.entries(page.variations);
        const as = seen.map(([role]) => role).filter((role) => role !== "visitor");
        console.log(
          `  ${page.route}${as.length ? ` (as ${as.join(", ")})` : ""} · ${seen[0]?.[1].title ?? ""}`,
        );
      }
    }
    console.log(`the map: ${path.relative(process.cwd(), path.join(out, "map", "map.json"))}`);
    process.exit(result.status);
  }
  case "pr": {
    const { config, out, spec } = await setup();
    if (!check(spec, config)) process.exit(1);
    generate(spec, out, { config });
    const root =
      gitRoot(config.dir) ?? fail("pom pr writes into a pull request: this is no git repository");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const dry = values["dry-run"] ?? false;
    const pr = dry ? null : pullRequest(root);
    if (pr && pr.head !== head && !values.force) {
      fail(
        `The pull request is at ${pr.head.slice(0, 7)} and this checkout at ${head.slice(0, 7)}: push (or pull) first, so its pictures are its own`,
      );
    }
    // Always taken fresh: the pictures a pull request shows are its code's.
    const result = await shoot(config, out, spec, true);
    if (result.failed.length)
      fail("Not every journey passed, so its pull request gets no pictures this time.");
    const compared = await compareWithBase(config, out, spec);
    const source = takenNow(config).source;
    const clips = new Map<string, string>();
    for (const journey of compared.journeys) {
      for (const width of config.video?.widths ?? []) {
        const base = path.join(out, "videos", source, `${journey.journey}.${width}`);
        const file = [`${base}.mp4`, `${base}.webm`].find((f) => existsSync(f));
        if (file && !clips.has(journey.journey)) clips.set(journey.journey, file);
      }
    }
    const made = section({
      commit: head,
      diff: compared,
      dir: path.join(out, "diff"),
      maxMB: config.video?.maxMB ?? 100,
      videos: clips,
    });
    if (!pr) {
      console.log(made.body);
      console.log(`\n${made.attached.length} files would be attached:`);
      for (const a of made.attached) console.log(`  ${path.relative(process.cwd(), a.file)}`);
      process.exit(0);
    }
    const isAncestor = (a: string, b: string) =>
      spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: root }).status === 0;
    if (newer(pr.body, head, isAncestor)) {
      console.log("The pull request already shows a newer commit's pictures: left as it is.");
      process.exit(0);
    }
    publish(pr, withSection(pr.body, made.body), made.attached, path.join(out, "diff"));
    console.log(`Pictures in ${pr.url}${made.left.length ? ` (${made.left.join(" ")})` : ""}`);
    process.exit(0);
  }
  case "upload": {
    // The run named, else the newest beside the spec (found below, with the runs).
    const runNamed = typeof values.run === "string" && values.run ? values.run : null;
    if (values.project !== undefined && values.repo !== undefined)
      fail("pom upload takes --project <slug> or --repo <owner/name>, not both.");
    if (values.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
      fail(`--repo takes a repository as GitHub names it (owner/name), not ${values.repo}.`);
    if (values.project !== undefined && !/^[a-z0-9][a-z0-9-]{1,63}$/.test(values.project))
      fail(`--project takes a project's address (its slug), not ${values.project}.`);
    const pull =
      values.pull === undefined
        ? null
        : /^\d+$/.test(values.pull)
          ? Number(values.pull)
          : fail(`--pull takes a pull request's number, not ${values.pull}.`);
    // Checked with the run, before anything is sent: one that isn't a full sha is refused there.
    const featureCommit = values["feature-commit"] ?? null;
    const address = values.service || process.env.POM_SERVICE_URL || SERVICE_URL;
    // A runner token, else, on GitHub Actions, GitHub's word for the workflow (oidc.ts).
    const token =
      process.env.POM_RUNNER_TOKEN ||
      (vouchable()
        ? await workflowToken({ say: (line) => console.error(line), url: address }).catch(
            (error: Error) => fail(error.message),
          )
        : fail(noToken(address)));
    // Its runs, beside the spec or in pom's own folder.
    let spec = path.resolve(named ?? ".");
    if (!existsSync(runsOf(spec))) {
      const { config, out } = await setup();
      spec =
        [config.spec, path.dirname(out)].find((dir) => existsSync(runsOf(dir))) ??
        fail(
          `No runs to upload in ${path.relative(process.cwd(), config.spec) || "."}: run pom videos first.`,
        );
    }
    const run =
      runNamed ??
      runsIn(runsOf(spec))[0]?.run ??
      fail(
        `No runs to upload in ${path.relative(process.cwd(), spec) || "."}: run pom videos first.`,
      );
    if (!runNamed) console.error(`Uploading run ${run}, the newest (--run <id> names another).`);
    // Where it goes: as named, else, for a spec with no GitHub remote, its name's project.
    const project =
      values.project ??
      (values.repo
        ? null
        : (defaultProject(spec) ??
          fail(
            "pom upload needs --project <slug>, or --repo <owner/name> for a connected GitHub repository.",
          )));
    try {
      // The service first: a token or an address it can't take is refused at once, never
      // after every GIF is made.
      const service = serviceOf({
        // Said as it happens, on stderr: the Action holds stdout until pom is done.
        say: (line) => console.error(line),
        token,
        url: address,
      });
      // What the pull request's comment shows, for its repository's videos branch: its GIFs,
      // made now, and its pictures; what is left out said as it happens, on stderr.
      const shown =
        pull === null
          ? null
          : await publishFor({ pull, run, say: (line) => console.error(line), spec });
      const { already, latest, url } = await service.uploadRun({
        featureCommit,
        job: values.job ?? null,
        project,
        publish: shown,
        pull,
        replace: values.replace ?? false,
        repo: values.repo ?? null,
        run,
        // Before the address, which stays the last line.
        say: (line) => console.log(line),
        spec,
      });
      // An older run of a pull request, uploaded late: the newer one speaks for it on GitHub.
      if (pull !== null && !latest)
        console.log(
          `pomspec has a newer run of ${values.repo ?? project}#${pull}: its comment stays as it is.`,
        );
      // The address last, its line's last word: what the Action reads (action/action.yml).
      console.log(`${already ? "On pomspec already" : "On pomspec"}: ${url}`);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    process.exit(0);
  }
  default:
    console.error(USAGE.join("\n"));
    process.exit(2);
}
