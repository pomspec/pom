import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The person's own agent, run in their repository with pom's brief: they choose it
// (pom guesses nothing), and pom launches that vendor's own command-line agent under
// that agent's own sign-in, on their machine and subscription. pom never signs in to
// a provider itself, never reads a provider's tokens, and runs nothing elsewhere.

export type Provider = Readonly<{
  /** How the agent runs headless in the repository, given its prompt. */
  args: (prompt: string) => ReadonlyArray<string>;
  bin: string;
  id: string;
  /** How a person signs in to it, when it is not yet. */
  login: string;
  name: string;
}>;

export const PROVIDERS: ReadonlyArray<Provider> = [
  {
    args: (prompt) => [
      "-p",
      prompt,
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Bash(npx pomspec:*) Bash(pom:*)",
    ],
    bin: "claude",
    id: "claude",
    login: "claude, then /login",
    name: "Claude Code (a Claude subscription or API key)",
  },
  {
    args: (prompt) => ["exec", "--full-auto", prompt],
    bin: "codex",
    id: "codex",
    login: "codex login",
    name: "Codex (a ChatGPT plan or API key)",
  },
  {
    args: (prompt) => ["-p", prompt, "--approval-mode", "auto_edit"],
    bin: "gemini",
    id: "gemini",
    login: "gemini, then sign in",
    name: "Gemini CLI",
  },
  {
    args: (prompt) => ["-p", prompt, "--allow-all-tools"],
    bin: "copilot",
    id: "copilot",
    login: "copilot, then /login",
    name: "GitHub Copilot CLI",
  },
  {
    args: (prompt) => ["run", prompt],
    bin: "opencode",
    id: "opencode",
    login: "opencode auth login",
    name: "OpenCode",
  },
  { args: (prompt) => ["-p", prompt], bin: "pi", id: "pi", login: "pi, then /login", name: "pi" },
];

/** The brief an agent follows to write a repository's spec: in pom's own package, beside its skill. */
export const BRIEF = fileURLToPath(new URL("../skills/pom/map-repo.md", import.meta.url));

/** What pom asks the agent to do: read the brief, and follow it here. */
export const prompt = (dir: string) =>
  `Read ${BRIEF} and follow it for the repository in ${dir}: write its pomspec spec (route folders, journeys as .feature files, draft trees), then run pom check until every line finds its control.`;

export const providerOf = (id: string) => PROVIDERS.find((p) => p.id === id) ?? null;

/** Whether the provider's command is on this machine. */
export const installed = (provider: Provider) =>
  spawnSync(provider.bin, ["--version"], { stdio: "ignore" }).status === 0;

/** The command as a person reads it before saying yes. */
export const shown = (provider: Provider, dir: string) =>
  [
    provider.bin,
    ...provider.args(prompt(dir)).map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)),
  ].join(" ");

/** Runs the agent in `dir`, its output the person's to watch. */
export function runAgent(provider: Provider, dir: string): number {
  const run = spawnSync(provider.bin, provider.args(prompt(dir)), { cwd: dir, stdio: "inherit" });
  return run.status ?? 1;
}

export const relativeBrief = () => path.relative(process.cwd(), BRIEF);
