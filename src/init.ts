import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// `pom init`: a repository made ready for pom. Its config, its spec folder, pom's own
// folder (ignored by itself), and with `--commit` the attributes that keep committed
// pictures out of Git LFS and trees and manifests folded in pull requests.

export const ATTRIBUTES = [
  "# pom: trees and manifests are generated; pictures are plain git, never LFS",
  "spec/**/*.tree.yml linguist-generated=true",
  "spec/**/shots.json linguist-generated=true",
  "spec/**/*.png -filter -diff -merge",
];

/** The config pom starts a repository with: where the app runs, the rest left to defaults. */
export function configText(input: {
  agent: string | null;
  baseURL: string | null;
  commit: boolean;
}): string {
  const fields = [
    `  baseURL: ${JSON.stringify(input.baseURL ?? "http://localhost:3000")},`,
    ...(input.agent ? [`  agent: ${JSON.stringify(input.agent)},`] : []),
    ...(input.commit ? ["  commit: true,"] : []),
    '  // webServer: { command: "npm run dev", url: "http://localhost:3000" },',
    '  // roles: { owner: { signIn: "spec/sign-in-as-owner.ts" } },',
  ];
  return `// pom's settings: where the app runs, how it is pictured. Every field is optional.
import type { PomConfig } from "pomspec";

export default {
${fields.join("\n")}
} satisfies PomConfig;
`;
}

export type Initialized = Readonly<{ config: string; created: ReadonlyArray<string> }>;

export function init(input: {
  agent: string | null;
  baseURL: string | null;
  commit: boolean;
  dir: string;
}): Initialized {
  const created: Array<string> = [];
  const config = path.join(input.dir, "pom.config.ts");
  if (!existsSync(config)) {
    writeFileSync(config, configText(input));
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
  return { config, created };
}

/** Who owns what, for a person to put in CODEOWNERS: the spec reviewed, its pictures not. */
export const CODEOWNERS = ["spec/ @your-team", "spec/**/*.shots/"];
