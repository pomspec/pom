import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { NAMES } from "./config.ts";
import { SERVICE_URL, VERSION } from "./service.ts";
import { gitRoot, real } from "./source.ts";

// `pom init`: a repository made ready for pom. Its config, its spec folder, pom's own
// folder (ignored by itself), with `--commit` the attributes that keep committed
// pictures out of Git LFS and trees and manifests folded in pull requests, and in a
// repository on GitHub the workflow that records every pull request's journeys with
// pom's Action, which proves its runs to pomspec with the token GitHub signs for them:
// no runner token, no secret. What it finds there already it leaves as it is.

export const ATTRIBUTES = [
  "# pom: trees and manifests are generated; pictures are plain git, never LFS",
  "spec/**/*.tree.yml linguist-generated=true",
  "spec/**/shots.json linguist-generated=true",
  "spec/**/*.png -filter -diff -merge",
];

/** Where the workflow goes, from the repository's root. */
export const WORKFLOW = ".github/workflows/pomspec.yml";

/**
 * pom's Action, as its public repository publishes it, at this pom's own number: the two
 * are released together (pomspec@X.Y.Z on npm, the tag vX.Y.Z on pomspec/pom), so the
 * workflow runs the Action made for the pom the project has. Should they part (pomspec
 * updated alone), the Action says so (action/action.yml).
 */
const ACTION = `pomspec/pom/action@v${VERSION}`;

/** The config pom starts a repository with: where the app runs, the rest left to defaults. */
export function configText(input: {
  agent: string | null;
  baseURL: string | null;
  commit: boolean;
  /** How the app starts, when its package.json says (`startOf`): shown as the webServer to add. */
  start?: string | null;
}): string {
  const baseURL = input.baseURL ?? "http://localhost:3000";
  const fields = [
    `  baseURL: ${JSON.stringify(baseURL)},`,
    ...(input.agent ? [`  agent: ${JSON.stringify(input.agent)},`] : []),
    ...(input.commit ? ["  commit: true,"] : []),
    `  // webServer: { command: ${JSON.stringify(input.start ?? "npm run dev")}, url: ${JSON.stringify(baseURL)} },`,
    '  // roles: { owner: { signIn: "spec/sign-in-as-owner.ts" } },',
  ];
  return `// pom's settings: where the app runs, how it is pictured. Every field is optional.
import type { PomConfig } from "pomspec";

export default {
${fields.join("\n")}
} satisfies PomConfig;
`;
}

/**
 * The workflow pom init writes, as Settings → Runners shows it (`workflowFor` in
 * apps/web/src/settings/Runners.tsx, kept alike by hand): pom's Action on every pull
 * request, its runs proven by the token GitHub signs (`id-token: write`). `start` and
 * `readyURL` are what init knows of the app; each it doesn't is a commented line saying
 * what goes there. `service` only where pomspec is elsewhere than the Action's default.
 */
export function workflowText(input: {
  readyURL: string | null;
  service: string | null;
  spec: string;
  start: string | null;
}): string {
  // Each value as YAML would write it: quoted only where it has to be.
  const value = (text: string) => stringify(text, { lineWidth: 0 }).trimEnd();
  const inputs = [
    ...(input.service ? [`service-url: ${value(input.service)}`] : []),
    `spec: ${value(input.spec)}`,
    "# Where each side runs: its address (head-url, base-url), for the head",
    "# a deployment of it that isn't production, else this command, in",
    "# each side's checkout, answering at ready-url.",
    input.start
      ? `start: ${value(input.start)}`
      : "# start: npm run dev  # uncomment, with the command that starts your app",
    input.readyURL
      ? `ready-url: ${value(input.readyURL)}`
      : "# ready-url: http://localhost:3000  # uncomment, with where it answers then",
  ];
  return `name: pomspec
on:
  pull_request:
permissions:
  contents: read
  deployments: read
  pull-requests: read
  # The token GitHub signs for each run, which proves to pomspec whose run it is:
  # no runner token, no secret.
  id-token: write
jobs:
  videos:
    # A pull request from a fork gets no secrets and no signed token, so it isn't
    # played; nor is Dependabot's.
    if: github.event.pull_request.head.repo.full_name == github.repository && github.actor != 'dependabot[bot]'
    # One play a commit at a time: another for it cancels the one under way,
    # and its videos replace the last.
    concurrency:
      group: pomspec-\${{ github.event.pull_request.head.sha || github.sha }}
      cancel-in-progress: true
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: ${ACTION}
        with:
${inputs.map((line) => `          ${line}`).join("\n")}
        # If your spec signs in: each role's credentials, from the repository's secrets.
        # Secrets show as dots in the videos.
        # env:
        #   POM_OWNER_EMAIL: \${{ secrets.POM_OWNER_EMAIL }}
        #   POM_OWNER_PASSWORD: \${{ secrets.POM_OWNER_PASSWORD }}
`;
}

export type Initialized = Readonly<{
  config: string;
  created: ReadonlyArray<string>;
  /** What init says last: what's next, from committing what it wrote to a pull request's videos. */
  next: ReadonlyArray<string>;
  /** What it found there already and left as it is, said after what it made. */
  notes: ReadonlyArray<string>;
  /** The GitHub workflow, made now or there already; null where the repository isn't on GitHub. */
  workflow: Readonly<{ file: string; made: boolean }> | null;
}>;

/** The package.json nearest `dir`, read, if there is one and it parses. */
function packageOf(dir: string): { scripts?: Record<string, string>; type?: string } | null {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    const file = path.join(at, "package.json");
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, "utf8")) as {
          scripts?: Record<string, string>;
          type?: string;
        };
      } catch {
        return null;
      }
    }
    if (path.dirname(at) === at) return null;
  }
}

/**
 * How the app starts, when its package.json has a `dev` script: run as the lockfile
 * nearest it says (pnpm, yarn, else npm, as pom's Action installs), up to the
 * repository's root. Never `start`, which often serves a build that isn't there.
 */
function startOf(dir: string, root: string | null): string | null {
  if (!packageOf(dir)?.scripts?.dev) return null;
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    if (existsSync(path.join(at, "pnpm-lock.yaml"))) return "pnpm dev";
    if (existsSync(path.join(at, "yarn.lock"))) return "yarn dev";
    if (existsSync(path.join(at, "package-lock.json"))) return "npm run dev";
    if (real(at) === root || path.dirname(at) === at) return "npm run dev";
  }
}

/** Whether a repository is on GitHub: a remote there, or a `.github` folder of its own. */
function onGitHub(root: string): boolean {
  if (existsSync(path.join(root, ".github"))) return true;
  try {
    const remotes = execFileSync("git", ["-C", root, "remote", "-v"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return /github\.com[:/]/i.test(remotes);
  } catch {
    return false;
  }
}

/** Whether git tracks a file of the repository at `root` already. */
function tracked(root: string, file: string): boolean {
  try {
    execFileSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", real(file)], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** Names in running text: "a", "a and b", "a, b and c". */
const listed = (names: ReadonlyArray<string>) =>
  names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

export function init(input: {
  agent: string | null;
  baseURL: string | null;
  commit: boolean;
  dir: string;
  /** Where pomspec is, when not pomspec.com (POM_SERVICE_URL): the workflow says so. */
  service?: string | null;
}): Initialized {
  const created: Array<string> = [];
  const notes: Array<string> = [];
  const root = gitRoot(input.dir);
  // A file as the person names it, from where init runs: through real folders, as git
  // names the root (macOS's /var is /private/var).
  const name = (file: string) => path.relative(real(input.dir), real(file)) || ".";
  const start = startOf(input.dir, root);
  // A config the folder has already, else `.mts` where `.ts` would be read as CommonJS.
  const config =
    NAMES.map((one) => path.join(input.dir, one)).find((file) => existsSync(file)) ??
    path.join(
      input.dir,
      packageOf(input.dir)?.type === "module" ? "pom.config.ts" : "pom.config.mts",
    );
  if (!existsSync(config)) {
    writeFileSync(config, configText({ ...input, start }));
    created.push(config);
  }
  const spec = path.join(input.dir, "spec");
  if (!existsSync(spec)) {
    mkdirSync(spec, { recursive: true });
    created.push(spec);
  }
  const own = path.join(input.dir, ".pom", ".gitignore");
  if (!existsSync(own)) {
    mkdirSync(path.dirname(own), { recursive: true });
    writeFileSync(own, "*\n");
    created.push(own);
  }
  if (input.commit) {
    const file = path.join(input.dir, ".gitattributes");
    const had = existsSync(file) ? readFileSync(file, "utf8") : "";
    const missing = ATTRIBUTES.filter((line) => !had.includes(line));
    if (missing.length) {
      appendFileSync(file, `${had && !had.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
      created.push(file);
    }
  }

  // The workflow, at the repository's root, never over one that's there (`.yaml` too).
  // It says where the app answers only as the person said it: without an address, the
  // config's baseURL is a guess (localhost:3000) a run on GitHub would wait on in vain,
  // and a config init didn't write may say otherwise. A command with nowhere to answer
  // would stop the Action, which starts the app only with both: each it lacks is left
  // to fill in.
  const app = { readyURL: input.baseURL, start: input.baseURL ? start : null };
  let workflow: Initialized["workflow"] = null;
  if (root && onGitHub(root)) {
    const file = path.join(root, WORKFLOW);
    const there = [file, file.replace(/\.yml$/, ".yaml")].find((one) => existsSync(one));
    if (there) {
      workflow = { file: there, made: false };
      notes.push(`${name(there)} is there already: pom left it as it is.`);
    } else {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(
        file,
        workflowText({
          ...app,
          service: input.service ?? null,
          spec: path.relative(root, real(spec)).split(path.sep).join("/"),
        }),
      );
      created.push(file);
      workflow = { file, made: true };
    }
  }

  // What's next, numbered: what to fill in, what to commit, then the way to videos.
  const commit = [name(config), `${name(spec)}/`];
  const attributes = path.join(input.dir, ".gitattributes");
  if (created.includes(attributes)) commit.push(name(attributes));
  const steps: Array<string> = [];
  if (workflow?.made) {
    if (!app.readyURL)
      steps.push(
        `In ${name(workflow.file)}, fill in start and ready-url: how your app starts, and where it answers then.`,
      );
    else if (!app.start)
      steps.push(`In ${name(workflow.file)}, fill in start: the command that starts your app.`);
  }
  // The workflow, made now or by an init before (run again for its agent) and not
  // committed yet: one git tracks is the person's already.
  if (root && workflow && !tracked(root, workflow.file)) commit.push(name(workflow.file));
  if (workflow) {
    const service = (input.service ?? SERVICE_URL).replace(/\/+$/, "");
    steps.push(
      `Commit ${listed(commit)}, and push them.`,
      `Connect GitHub in pomspec, one button: ${service}/settings/github`,
      "Open a pull request: pom's Action records its journeys, and pomspec comments with the videos.",
    );
  } else {
    steps.push(
      `Commit ${listed(commit)}.`,
      "With your app running, record your journeys (npx pomspec videos) and send them to pomspec with a runner token from Settings → Runners (npx pomspec upload).",
    );
  }
  const next = ["What's next:", ...steps.map((step, i) => `  ${i + 1}. ${step}`)];
  // With the app's address again, the workflow knows where it answers and how it starts.
  if (!workflow)
    next.push(
      `Once the repository is on GitHub, npx pomspec init ${input.baseURL ?? "<your app's address>"} --agent none adds the workflow that records every pull request (${WORKFLOW}).`,
    );
  return { config, created, next, notes, workflow };
}

/** Who owns what, for a person to put in CODEOWNERS: the spec reviewed, its pictures not. */
export const CODEOWNERS = ["spec/ @your-team", "spec/**/*.shots/"];
