import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { noToken, vouchable, workflowToken } from "./oidc.ts";
import { ServiceError, serviceOf } from "./service.ts";

// pom upload on GitHub Actions with no runner token: GitHub's word for its workflow, asked
// of a GitHub of its own, swapped at a pomspec of its own; what goes where (GitHub's
// request token to GitHub alone, the ID token to pomspec alone), and what each refusal says.

/** A workflow's token, as pomspec gives one. */
const WORKFLOW = `pomg_${"e".repeat(120)}.${"s".repeat(43)}`;
/** GitHub's ID token for the job: what GitHub answers, opaque to pom. */
const ID_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJyZXBvc2l0b3J5IjoiYWNtZS9ub3RlcyJ9.c2lnbmVk";
/** What GitHub's runner sets for a job with `id-token: write`, but its address. */
const REQUEST_TOKEN = "github-request-token";
/** A test's patience: a few quick tries, a third of a second in all. */
const QUICK = { first: 20, total: 300 } as const;

type Asked = Readonly<{ headers: IncomingMessage["headers"]; method: string; url: string }>;
type Handler = (asked: Asked, response: ServerResponse) => void;

/** A server that answers as `handle` says, and keeps what it was asked. */
async function server(handle: Handler) {
  const asked: Array<Asked> = [];
  const listening = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const one = {
        headers: request.headers,
        method: request.method ?? "",
        url: request.url ?? "",
      };
      asked.push(one);
      handle(one, response);
    });
  });
  await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
  const { port } = listening.address() as AddressInfo;
  after(() => {
    listening.closeAllConnections();
    listening.close();
  });
  return { asked, url: `http://127.0.0.1:${port}` };
}

const json = (response: ServerResponse, body: unknown, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
const line = (response: ServerResponse, status: number, text: string) => {
  response.writeHead(status, { "content-type": "text/plain" });
  response.end(text);
};

/** pomspec, at the exchange: its audience, and a workflow's token for `ID_TOKEN` alone. */
const pomspec = (
  swap: Handler = (_one, response) => json(response, { repository: "acme/notes", token: WORKFLOW }),
) =>
  server((one, response) => {
    if (one.url !== "/api/runner/github") return line(response, 404, "Not found.");
    if (one.method === "GET") return json(response, { audience: "https://pomspec.test" });
    if (one.headers.authorization !== `Bearer ${ID_TOKEN}`)
      return line(response, 401, "That ID token isn't signed by GitHub.");
    swap(one, response);
  });

/** GitHub's token service for the job: an ID token for whoever shows the request token. */
const github = (answer: Handler = (_one, response) => json(response, { value: ID_TOKEN })) =>
  server((one, response) => {
    if (one.headers.authorization !== `Bearer ${REQUEST_TOKEN}`) return json(response, {}, 401);
    answer(one, response);
  });

/** The job's environment, GitHub's token service at `url`, as GitHub writes its address. */
const job = (url: string) => ({
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
  ACTIONS_ID_TOKEN_REQUEST_URL: `${url}/_apis/pipelines/1/runs/17/idtoken?api-version=2.0`,
});

test("GitHub vouches for a job only where the workflow lets it ask", () => {
  assert.equal(vouchable({}), false);
  assert.equal(vouchable({ ACTIONS_ID_TOKEN_REQUEST_URL: "https://github.test/token" }), false);
  assert.equal(vouchable({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN }), false);
  assert.equal(vouchable(job("https://github.test")), true);
  assert.equal(
    noToken("https://pomspec.com"),
    "No runner token in POM_RUNNER_TOKEN: create one on pomspec (https://pomspec.com) in Settings → Runners. On GitHub Actions, add `permissions: id-token: write` to the workflow instead.",
  );
});

test("on GitHub Actions, GitHub's word for the workflow is swapped for a workflow's token, each token going where it belongs", async () => {
  const service = await pomspec();
  const gh = await github();
  const said: Array<string> = [];
  const token = await workflowToken({
    env: job(gh.url),
    say: (one) => said.push(one),
    url: `${service.url}/`,
  });
  assert.equal(token, WORKFLOW);
  assert.deepEqual(said, ["GitHub vouched for acme/notes: uploading as its workflow."]);

  // GitHub was asked for pomspec's audience, at the address it gave, its query kept.
  assert.equal(gh.asked.length, 1);
  const asked = new URL(gh.asked[0]!.url, gh.url);
  assert.equal(asked.pathname, "/_apis/pipelines/1/runs/17/idtoken");
  assert.equal(asked.searchParams.get("api-version"), "2.0");
  assert.equal(asked.searchParams.get("audience"), "https://pomspec.test");
  // pomspec was asked its audience, then shown the ID token: never GitHub's request token.
  assert.deepEqual(
    service.asked.map(({ headers, method }) => [method, headers.authorization ?? null]),
    [
      ["GET", null],
      ["POST", `Bearer ${ID_TOKEN}`],
    ],
  );
  assert.ok(service.asked.every(({ headers }) => headers["x-pom-version"]));
  assert.ok(!JSON.stringify(service.asked).includes(REQUEST_TOKEN));

  // What it is given is a runner's token to pom's client, and refused in a workflow's words.
  const { url } = await server((_one, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ errors: [{ message: "No." }] }));
  });
  await assert.rejects(
    serviceOf({ token, url }).claim("job-1"),
    (error) =>
      error instanceof ServiceError &&
      error.status === 401 &&
      error.message ===
        "pomspec no longer takes this workflow's token: it lasts two hours, and only while its repository is connected in Settings → GitHub. Run the workflow again.",
  );
  assert.throws(() => serviceOf({ token: `${token}x`, url }), /That isn't a runner token/);
});

test("each refusal says what to do: a pomspec that can't swap, GitHub saying no, pomspec saying no", async () => {
  const gh = await github();
  // An older pomspec, with no exchange.
  const older = await server((_one, response) => line(response, 404, "Not found."));
  await assert.rejects(workflowToken({ env: job(gh.url), url: older.url }), {
    message: `pomspec at ${older.url} can't take GitHub's word for a workflow (404): use a runner token in POM_RUNNER_TOKEN.`,
  });

  // GitHub won't: the workflow doesn't let the job ask.
  const service = await pomspec();
  const forbidding = await github((_one, response) => json(response, { message: "No." }, 403));
  await assert.rejects(workflowToken({ env: job(forbidding.url), url: service.url }), {
    message:
      "GitHub didn't give this job an ID token (403): add `permissions: id-token: write` to the workflow.",
  });
  await assert.rejects(
    workflowToken({ env: { ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN }, url: service.url }),
    {
      message:
        "GitHub gave this job no way to ask for an ID token: add `permissions: id-token: write` to the workflow.",
    },
  );

  // pomspec won't, saying why in a line of its own; or answers as pomspec doesn't.
  const unconnected = await pomspec((_one, response) =>
    line(response, 403, "acme/notes isn't connected to pomspec: connect it in Settings → GitHub."),
  );
  await assert.rejects(workflowToken({ env: job(gh.url), url: unconnected.url }), {
    message: "acme/notes isn't connected to pomspec: connect it in Settings → GitHub.",
  });
  const paged = await pomspec((_one, response) => {
    response.writeHead(403, { "content-type": "text/html" });
    response.end("<html>Forbidden</html>");
  });
  await assert.rejects(workflowToken({ env: job(gh.url), url: paged.url }), {
    message: "pomspec refused GitHub's word for this workflow (403).",
  });
  const elsewhere = await pomspec((_one, response) => json(response, { token: "pomr_nope" }));
  await assert.rejects(workflowToken({ env: job(gh.url), url: elsewhere.url }), {
    message: `${elsewhere.url} didn't answer as pomspec does: check that it's pomspec's address.`,
  });
  await assert.rejects(workflowToken({ env: job(gh.url), url: "ftp://pomspec.test" }), {
    message:
      "--service or POM_SERVICE_URL takes an http:// or https:// address, not ftp://pomspec.test.",
  });
});

test("a pomspec or a GitHub busy for a moment is asked again; one that never answers is named", async () => {
  let busy = 2;
  const service = await pomspec((_one, response) =>
    busy-- > 0 ? line(response, 503, "Busy.") : json(response, { token: WORKFLOW }),
  );
  let down = 1;
  const gh = await github((_one, response) =>
    down-- > 0 ? json(response, {}, 502) : json(response, { value: ID_TOKEN }),
  );
  const said: Array<string> = [];
  const token = await workflowToken({
    env: job(gh.url),
    patience: QUICK,
    say: (one) => said.push(one),
    url: service.url,
  });
  assert.equal(token, WORKFLOW);
  assert.deepEqual(said, [
    `${new URL(gh.url).host} didn't answer (502): trying again.`,
    `${new URL(service.url).host} didn't answer (503): trying again.`,
  ]);

  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address() as AddressInfo;
  await new Promise((resolve) => closed.close(resolve));
  const nowhere = `http://127.0.0.1:${port}`;
  await assert.rejects(workflowToken({ env: job(gh.url), patience: QUICK, url: nowhere }), {
    message: `Couldn't reach pomspec at ${nowhere} (ECONNREFUSED): check --service or POM_SERVICE_URL.`,
  });
});

test("pom upload asks GitHub on Actions with no runner token, and says both ways without either", async () => {
  const cli = path.join(import.meta.dirname, "cli.ts");
  const dir = mkdtempSync(path.join(tmpdir(), "pom-oidc-"));
  after(() => rmSync(dir, { force: true, recursive: true }));
  const upload = (env: Record<string, string>) =>
    promisify(execFile)(process.execPath, [cli, "upload", "--project", "notes"], {
      cwd: dir,
      env: { HOME: dir, PATH: process.env.PATH ?? "", POM_SERVICE_URL: service.url, ...env },
    }).then(
      () => ({ code: 0, stderr: "" }),
      (error: { code: number; stderr: string }) => ({ code: error.code, stderr: error.stderr }),
    );
  const service = await pomspec();
  const gh = await github();

  const none = await upload({});
  assert.equal(none.code, 1);
  assert.match(none.stderr, /add `permissions: id-token: write` to the workflow instead\./);
  assert.equal(service.asked.length, 0);

  // GitHub's word swapped, then on to the spec, of which there is none here.
  const vouched = await upload(job(gh.url));
  assert.equal(vouched.code, 1);
  assert.match(vouched.stderr, /^GitHub vouched for acme\/notes: uploading as its workflow\.\n/);
  assert.doesNotMatch(vouched.stderr, /runner token/);
  assert.deepEqual(
    service.asked.map(({ method }) => method),
    ["GET", "POST"],
  );

  // A runner token, when there is one, is used as it is: GitHub isn't asked.
  await upload({ ...job(gh.url), POM_RUNNER_TOKEN: `pomr_${"a".repeat(43)}` });
  assert.equal(gh.asked.length, 1);
});
