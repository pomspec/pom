import { type Patience, VERSION, WORKFLOW_TOKEN } from "./service.ts";

// On GitHub Actions, pom upload needs no runner token and the repository no secret: GitHub
// vouches for the workflow. In a job with `permissions: id-token: write`, each step may
// ask GitHub for an ID token (at ACTIONS_ID_TOKEN_REQUEST_URL, showing
// ACTIONS_ID_TOKEN_REQUEST_TOKEN): a JWT GitHub signs, naming the repository the workflow
// runs in, for the audience the workflow names. pom asks pomspec which audience is its own
// (GET /api/runner/github: its origin, the same through any address pom reaches it by),
// asks GitHub for a token for it, and swaps that at pomspec (POST, the same address) for a
// workflow's token (`pomg_…`), which uploads to that repository and the project linked to
// it alone, for two hours. Nothing is kept: each upload asks again.
//
// GitHub's request token goes to GitHub alone, and the ID token only to the address pom
// uploads to, the one that named its audience: it is good at that pomspec alone, which the
// workflow trusts with its videos already. A pull request from a fork gets no ID token
// under `pull_request`.

/** About two minutes in all, as the runner's client waits (service.ts). */
const PATIENCE: Patience = { first: 500, total: 120_000 };

/** Whether GitHub can vouch for this job: on Actions, with `permissions: id-token: write`. */
export const vouchable = (env: NodeJS.ProcessEnv = process.env): boolean =>
  !!env.ACTIONS_ID_TOKEN_REQUEST_URL && !!env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

/** What pom upload says with neither a runner token nor GitHub's word for its workflow. */
export const noToken = (address: string) =>
  `No runner token in POM_RUNNER_TOKEN: create one on pomspec (${address}) in Settings → Runners. On GitHub Actions, add \`permissions: id-token: write\` to the workflow instead.`;

/** Worth asking again: the service restarting, or too busy just now (as service.ts has it). */
const passing = (status: number) => status >= 500 || status === 408 || status === 429;

/** Why a request got no answer, as the network said it (ECONNREFUSED), not fetch's "fetch failed". */
const causeOf = (error: unknown): string => {
  const code = (error as { cause?: { code?: unknown } }).cause?.code;
  return typeof code === "string" ? code : (error as Error).message;
};

/** A refusal's body when it's one plain line of the service's (not a proxy's page); else null. */
async function lineOf(response: Response): Promise<string | null> {
  if (!response.headers.get("content-type")?.startsWith("text/plain")) return null;
  const text = (await response.text().catch(() => "")).trim();
  return text && text.length <= 300 && !text.includes("\n") ? text : null;
}

/** A success's JSON object; else null, its body let go. */
async function jsonOf(response: Response): Promise<Record<string, unknown> | null> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const value: unknown = await response.json().catch(() => null);
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * A call's answer, made again while nothing answers or its server fails on its side, ever
 * more slowly, for `patience.total` in all; then its last answer, or why nothing answered.
 */
async function ask(
  to: string,
  init: RequestInit,
  patience: Patience,
  say?: (line: string) => void,
): Promise<Response> {
  const until = Date.now() + patience.total;
  let told = false;
  for (let attempt = 0; ; attempt++) {
    let response: Response | null = null;
    let failure: unknown = null;
    try {
      response = await fetch(to, init);
    } catch (error) {
      failure = error;
    }
    if (response && !passing(response.status)) return response;
    const left = until - Date.now();
    if (left <= 0) {
      if (response) return response;
      throw failure;
    }
    await response?.body?.cancel().catch(() => {});
    if (!told) {
      told = true;
      say?.(
        `${new URL(to).host} didn't answer (${response ? response.status : causeOf(failure)}): trying again.`,
      );
    }
    const wait = Math.min(left, 30_000, patience.first * 2 ** attempt);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/**
 * A workflow's token for this job's repository, from pomspec at `url`, on GitHub's word:
 * its audience asked of pomspec, an ID token for it asked of GitHub, and the one swapped
 * for the other. Throws, in a sentence pom upload shows as it is, when any of them says no.
 */
export async function workflowToken({
  env = process.env,
  patience = PATIENCE,
  say,
  url,
}: Readonly<{
  env?: NodeJS.ProcessEnv;
  /** How long a call is made again: about two minutes in all, by default. */
  patience?: Patience;
  /** Tells the person, a line at a time: which repository GitHub vouched for. */
  say?: (line: string) => void;
  url: string;
}>): Promise<string> {
  const address = URL.parse(url);
  if (address?.protocol !== "http:" && address?.protocol !== "https:")
    throw new Error(
      `--service or POM_SERVICE_URL takes an http:// or https:// address, not ${url}.`,
    );
  const base = address.href.replace(/\/+$/, "");
  const swap = `${base}/api/runner/github`;
  const own = { "x-pom-version": VERSION };
  const unreachable = (error: unknown) =>
    new Error(
      `Couldn't reach pomspec at ${base} (${causeOf(error)}): check --service or POM_SERVICE_URL.`,
    );

  // The audience pomspec takes: its own origin.
  const asked = await ask(
    swap,
    { headers: { ...own, accept: "application/json" } },
    patience,
    say,
  ).catch((error: unknown) => {
    throw unreachable(error);
  });
  const audience = (await jsonOf(asked))?.audience;
  if (typeof audience !== "string" || !audience || audience.length > 512)
    throw new Error(
      `pomspec at ${base} can't take GitHub's word for a workflow (${asked.status}): use a runner token in POM_RUNNER_TOKEN.`,
    );

  // GitHub's word for this job, for that audience.
  const request = URL.parse(env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "");
  if (!request || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
    throw new Error(
      "GitHub gave this job no way to ask for an ID token: add `permissions: id-token: write` to the workflow.",
    );
  request.searchParams.set("audience", audience);
  const github = await ask(
    request.href,
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,
      },
    },
    patience,
    say,
  ).catch((error: unknown) => {
    throw new Error(`Couldn't reach GitHub for an ID token (${causeOf(error)}).`);
  });
  const value = (await jsonOf(github))?.value;
  if (typeof value !== "string" || !value)
    throw new Error(
      `GitHub didn't give this job an ID token (${github.status}): add \`permissions: id-token: write\` to the workflow.`,
    );

  // Swapped for a workflow's token.
  const swapped = await ask(
    swap,
    {
      headers: { ...own, accept: "application/json", authorization: `Bearer ${value}` },
      method: "POST",
    },
    patience,
    say,
  ).catch((error: unknown) => {
    throw unreachable(error);
  });
  if (!swapped.ok)
    throw new Error(
      (await lineOf(swapped)) ??
        `pomspec refused GitHub's word for this workflow (${swapped.status}).`,
    );
  const given = await jsonOf(swapped);
  if (typeof given?.token !== "string" || !WORKFLOW_TOKEN.test(given.token))
    throw new Error(`${base} didn't answer as pomspec does: check that it's pomspec's address.`);
  if (typeof given.repository === "string")
    say?.(`GitHub vouched for ${given.repository}: uploading as its workflow.`);
  return given.token;
}
