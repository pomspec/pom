import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { PNG } from "pngjs";
import {
  defaultProject,
  type Encode,
  NO_SMALLER,
  NO_WEBP,
  NO_WEBP_THERE,
  type RunnerJob,
  ServiceError,
  serviceOf,
  webpEncoder,
} from "./service.ts";

// The runner's client against a service of its own: what it asks (the runner contract's
// GraphQL and file paths) and how it holds up when the stream drops or the service is busy.

const TOKEN = `pomr_${"a".repeat(43)}`;

/** pom's version, as its package.json says, read here the plain way. */
const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

/** A test's patience: a few quick tries, a third of a second in all. */
const QUICK = { first: 20, total: 300 } as const;

const job = (id: string, number = 7): RunnerJob => ({
  baseSha: "b".repeat(40),
  headSha: "a".repeat(40),
  id,
  pullRequest: {
    baseRef: "main",
    baseSha: "b".repeat(40),
    headRef: "add-notes",
    headSha: "a".repeat(40),
    number,
    title: "Add notes",
    url: `https://github.com/acme/notes/pull/${number}`,
  },
  repository: { name: "notes", owner: "acme" },
  status: "queued",
});

type Asked = Readonly<{
  body: Buffer;
  headers: IncomingMessage["headers"];
  method: string;
  url: string;
}>;
type Handler = (asked: Asked, response: ServerResponse) => void;

/** A service that answers as `handle` says, and keeps what it was asked. */
async function service(handle: Handler) {
  const asked: Array<Asked> = [];
  const server = createServer((request, response) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const one = {
        body: Buffer.concat(chunks),
        headers: request.headers,
        method: request.method ?? "",
        url: request.url ?? "",
      };
      asked.push(one);
      handle(one, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { asked, url: `http://127.0.0.1:${port}` };
}

const json = (response: ServerResponse, body: unknown, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const operation = (asked: Asked) =>
  JSON.parse(asked.body.toString("utf8")) as {
    query: string;
    variables?: Record<string, unknown>;
  };

const next = (data: unknown) => `event: next\ndata: ${JSON.stringify({ data })}\n\n`;
const failed = (error: unknown) =>
  `event: next\ndata: ${JSON.stringify({ data: null, errors: [error] })}\n\n`;

/** What the service answers a runner token it doesn't know, revoked or never created (app.ts). */
const unknownToken = (response: ServerResponse) => {
  response.writeHead(401, {
    "content-type": "application/json",
    "www-authenticate": 'Bearer error="invalid_token"',
  });
  response.end(
    JSON.stringify({
      errors: [
        {
          extensions: { code: "UNAUTHENTICATED" },
          message: "pomspec doesn't know this runner token: create another in Settings → Runners.",
        },
      ],
    }),
  );
};

test("a runner token is one Settings → Runners creates, at an address of pomspec's", () => {
  assert.throws(
    () => serviceOf({ token: "ghp_nope", url: "http://localhost" }),
    /^Error: That isn't a runner token \(pomr_…\): create one in Settings → Runners\.$/,
  );
  for (const url of ["ftp://localhost", "localhost:3000"])
    assert.throws(
      () => serviceOf({ token: TOKEN, url }),
      new RegExp(`takes an http:// or https:// address, not ${url}\\.$`),
    );
  assert.equal(serviceOf({ token: TOKEN, url: "http://localhost/" }).url, "http://localhost");
});

test("the jobs stream over SSE, and a dropped stream is joined again", async () => {
  let streams = 0;
  const { asked, url } = await service((one, response) => {
    streams += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (streams === 1) {
      // A ping, a job split across two writes, then the connection drops.
      response.write(":\n\n");
      const event = next({ runnerJobs: job("first") });
      response.write(event.slice(0, 20));
      response.write(event.slice(20), () => setTimeout(() => response.socket?.destroy(), 20));
    } else response.write(next({ runnerJobs: job("second") }));
  });
  const controller = new AbortController();
  const heard: Array<string> = [];
  for await (const one of serviceOf({ token: TOKEN, url }).runnerJobs(controller.signal)) {
    heard.push(one.id);
    if (heard.length === 2) controller.abort();
  }
  assert.deepEqual(heard, ["first", "second"]);
  assert.equal(streams, 2);
  for (const one of asked) {
    assert.equal(one.url, "/graphql");
    assert.equal(one.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(one.headers.accept, "text/event-stream");
    assert.match(operation(one).query, /subscription RunnerJobs \{ runnerJobs \{/);
    assert.match(operation(one).query, /pullRequest \{ number title url headRef headSha/);
  }
});

test("a stream that completes is joined again; one the service refuses is not", async () => {
  let streams = 0;
  const { url } = await service((_one, response) => {
    streams += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (streams === 1)
      response.end(`${next({ runnerJobs: job("one") })}event: complete\ndata:\n\n`);
    else
      response.end(
        `event: next\ndata: ${JSON.stringify({ errors: [{ extensions: { code: "not-found" }, message: "No such runner token." }] })}\n\nevent: complete\ndata:\n\n`,
      );
  });
  const heard: Array<string> = [];
  await assert.rejects(
    async () => {
      for await (const one of serviceOf({ token: TOKEN, url }).runnerJobs()) heard.push(one.id);
    },
    (error) =>
      error instanceof ServiceError &&
      error.code === "not-found" &&
      /No such runner token/.test(error.message),
  );
  assert.deepEqual(heard, ["one"]);
  assert.equal(streams, 2);
});

test("the service failing as it streams is followed again; a refusal is not", async () => {
  const at: Array<number> = [];
  const { url } = await service((_one, response) => {
    at.push(Date.now());
    response.writeHead(200, { "content-type": "text/event-stream" });
    // A job, then one the service could not read just then (masked); the same as the
    // stream's first word; then a job again.
    const masked = failed({ message: "Unexpected error." });
    if (at.length === 1) response.end(`:\n\n${next({ runnerJobs: job("one") })}${masked}`);
    else if (at.length === 2) response.end(`:\n\n${masked}`);
    else response.write(`:\n\n${next({ runnerJobs: job("two") })}`);
  });
  const controller = new AbortController();
  const heard: Array<string> = [];
  for await (const one of serviceOf({ token: TOKEN, url }).runnerJobs(controller.signal)) {
    heard.push(one.id);
    if (heard.length === 2) controller.abort();
  }
  assert.deepEqual(heard, ["one", "two"]);
  assert.equal(at.length, 3);
  // A service failing every time is asked ever more slowly, though it answers.
  assert.ok(at[2]! - at[1]! > at[1]! - at[0]!);

  // The subscription refused, its first word: for good, code or not.
  const { url: refusing } = await service((_one, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `:\n\n${failed({ message: "This needs a runner token: create one in Settings → Runners." })}`,
    );
  });
  await assert.rejects(
    async () => {
      for await (const _ of serviceOf({ token: TOKEN, url: refusing }).runnerJobs()) void _;
    },
    (error) => error instanceof ServiceError && /runner token/.test(error.message),
  );

  // An answer that is no stream: an address that isn't pomspec's.
  const { url: elsewhere } = await service((_one, response) => json(response, { hello: true }));
  await assert.rejects(
    async () => {
      for await (const _ of serviceOf({ token: TOKEN, url: elsewhere }).runnerJobs()) void _;
    },
    {
      message: `${elsewhere} didn't answer as pomspec does: check that it's pomspec's address.`,
    },
  );
});

test("a token the service does not know ends the stream, and any call, with why", async () => {
  const { url } = await service((_one, response) => unknownToken(response));
  const runner = serviceOf({ token: TOKEN, url });
  const refused = (error: unknown) =>
    error instanceof ServiceError &&
    error.status === 401 &&
    error.message ===
      "pomspec doesn't know this runner token: create another in Settings → Runners.";
  await assert.rejects(async () => {
    for await (const _ of runner.runnerJobs()) void _;
  }, refused);
  await assert.rejects(runner.claim("free"), refused);
});

test("an address where nothing answers is asked again for a while, then says so, and where pomspec's address is set", async () => {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address() as AddressInfo;
  await new Promise((resolve) => closed.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const said: Array<string> = [];
  const started = Date.now();
  await assert.rejects(
    serviceOf({ patience: QUICK, say: (line) => said.push(line), token: TOKEN, url }).claim("free"),
    {
      message: `Couldn't reach pomspec at ${url} (ECONNREFUSED): check --service or POM_SERVICE_URL.`,
    },
  );
  // For as long as its patience, and said once.
  assert.ok(Date.now() - started >= QUICK.total - 5);
  assert.deepEqual(said, ["pomspec didn't answer (ECONNREFUSED): trying again."]);
});

test("a call the service fails (5xx) or drops is made again, ever more slowly, until it answers; a refusal (4xx) is not", async () => {
  const at: Array<number> = [];
  const { url } = await service((_one, response) => {
    at.push(Date.now());
    // Two failures of the service's (a deploy restarting it), the connection dropped, then
    // its answer.
    if (at.length <= 2)
      return json(response, { errors: [{ message: "Unexpected error." }] }, 501 + at.length);
    if (at.length === 3) return void response.socket?.destroy();
    json(response, { data: { claimRunnerJob: { ...job("free"), status: "claimed" } } });
  });
  const said: Array<string> = [];
  const runner = serviceOf({
    patience: { first: 40, total: 10_000 },
    say: (line) => said.push(line),
    token: TOKEN,
    url,
  });
  assert.equal((await runner.claim("free"))?.status, "claimed");
  assert.equal(at.length, 4);
  // Waiting twice as long each time: 40, 80, then 160 milliseconds.
  assert.ok(at[1]! - at[0]! >= 35);
  assert.ok(at[2]! - at[1]! > at[1]! - at[0]!);
  assert.ok(at[3]! - at[2]! > at[2]! - at[1]!);
  // Said once, until pomspec answered.
  assert.deepEqual(said, ["pomspec didn't answer (502): trying again."]);

  // A service that keeps failing: asked until its patience is spent, then its last answer.
  const { asked: down, url: failing } = await service((_one, response) => json(response, {}, 503));
  const started = Date.now();
  await assert.rejects(
    serviceOf({ patience: QUICK, token: TOKEN, url: failing }).claim("free"),
    (error) =>
      error instanceof ServiceError &&
      error.status === 503 &&
      error.message === "pomspec answered with an error (503).",
  );
  assert.ok(Date.now() - started >= QUICK.total - 5);
  assert.ok(down.length >= 3);

  // A refusal is the service's word: asked once.
  for (const status of [400, 403, 404, 413]) {
    const { asked, url: refusing } = await service((_one, response) =>
      json(response, { errors: [{ extensions: { code: "refused" }, message: "No." }] }, status),
    );
    await assert.rejects(
      serviceOf({ patience: QUICK, token: TOKEN, url: refusing }).claim("free"),
      (error) => error instanceof ServiceError && error.status === status,
    );
    assert.equal(asked.length, 1);
  }
});

test("every call says which pom makes it: its package's version", async () => {
  const { asked, url } = await service((one, response) => {
    if (operation(one).query.includes("subscription")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      return void response.write(next({ runnerJobs: job("one") }));
    }
    json(response, { data: { claimRunnerJob: { ...job("one"), status: "claimed" } } });
  });
  const runner = serviceOf({ token: TOKEN, url });
  const controller = new AbortController();
  for await (const one of runner.runnerJobs(controller.signal)) {
    await runner.claim(one.id);
    controller.abort();
  }
  assert.equal(asked.length, 2);
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
  for (const one of asked) assert.equal(one.headers["x-pom-version"], VERSION);
});

test("a job is claimed once: another runner's is null, other refusals are thrown", async () => {
  const { asked, url } = await service((one, response) => {
    const { query, variables } = operation(one);
    if (query.includes("failRunnerJob"))
      return json(response, { data: { failRunnerJob: { id: variables!.id } } });
    if (variables!.id === "taken")
      return json(response, {
        data: { claimRunnerJob: null },
        errors: [{ extensions: { code: "claimed" }, message: "Another runner took it." }],
      });
    if (variables!.id === "gone")
      return json(response, {
        data: { claimRunnerJob: null },
        errors: [{ extensions: { code: "not-found" }, message: "No such job." }],
      });
    // The service failing on its side, its error masked.
    if (variables!.id === "broken")
      return json(response, { data: null, errors: [{ message: "Unexpected error." }] });
    json(response, {
      data: { claimRunnerJob: { ...job(String(variables!.id)), status: "claimed" } },
    });
  });
  const runner = serviceOf({ token: TOKEN, url });
  assert.equal((await runner.claim("free"))?.status, "claimed");
  assert.equal(await runner.claim("taken"), null);
  await assert.rejects(
    runner.claim("gone"),
    (error) => (error as ServiceError).code === "not-found",
  );
  await assert.rejects(runner.claim("broken"), {
    message: "Something went wrong on pomspec's side. Try again in a moment.",
  });
  await runner.fail("free", "The checkout is gone.");
  const failed = operation(asked.at(-1)!);
  assert.match(failed.query, /mutation FailRunnerJob\(\$id: ID!, \$reason: String!\)/);
  assert.deepEqual(failed.variables, { id: "free", reason: "The checkout is gone." });
  assert.match(
    operation(asked[0]!).query,
    /mutation ClaimRunnerJob\(\$id: ID!\) \{ claimRunnerJob\(id: \$id\)/,
  );
});

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Ana",
      "-c",
      "user.email=ana@example.com",
      "-c",
      "commit.gpgsign=false",
    ].concat(args),
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();

/**
 * A spec folder with one run that played a journey on its head and base, as the runner
 * leaves it, in a checkout of its own: `before` has no .feature yet, `commit` has it.
 */
function played(options: { folder?: string } = {}) {
  const spec = mkdtempSync(path.join(tmpdir(), "pom-service-"));
  after(() => rmSync(spec, { force: true, recursive: true }));
  git(spec, "init", "--quiet");
  git(spec, "commit", "--quiet", "--allow-empty", "--no-verify", "-m", "Notes");
  const before = git(spec, "rev-parse", "HEAD");
  const run = path.join(spec, ".pom", "runs", "abc123def456");
  mkdirSync(run, { recursive: true });
  writeFileSync(
    path.join(run, "run.json"),
    JSON.stringify({
      at: "2026-10-01T12:00:00.000Z",
      branch: "add-notes",
      commit: "abc123def4567890",
      dirty: false,
      names: { base: "main", head: "this pull request" },
      run: "abc123def456",
      subject: "Add notes",
      targets: { base: "http://localhost:3000", head: "http://localhost:3001" },
    }),
  );
  const file = "(app)/notes/write-a-note.journey.ts";
  mkdirSync(path.join(spec, "(app)", "notes"), { recursive: true });
  writeFileSync(
    path.join(spec, "(app)", "notes", "write-a-note.feature"),
    'Feature: Write a note\n  Scenario: Write a note\n    Given I am on "/notes"\n',
  );
  git(spec, "add", "(app)");
  git(spec, "commit", "--quiet", "--no-verify", "-m", "Write a note");
  const commit = git(spec, "rev-parse", "HEAD");
  for (const target of ["head", "base"]) {
    const folder = path.join(
      run,
      target,
      options.folder ?? "(app)/notes",
      "write-a-note",
      "visual",
    );
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      path.join(folder, "video.json"),
      JSON.stringify({
        badges: [],
        chapters: [{ picture: "02-end-of-start.png", start: 0, title: "Start" }],
        checks: [
          { at: 1, picture: "01-sees-notes.[id].title.png", text: "The notes", verdict: "found" },
        ],
        duration: 3,
        journey: { file, route: "/notes", slug: "write-a-note", title: "Write a note" },
        lines: [],
        mode: "visual",
        passed: target === "head",
        pointer: [],
        rings: [],
        ripples: [],
        seconds: 3,
        size: { height: 800, width: 1280 },
      }),
    );
    // The runner's video first, then its still: a still newer than its video is not drawn again.
    writeFileSync(path.join(folder, "journey.webm"), `webm of ${target}`);
    for (const name of [
      "still.jpg",
      "storyboard.jpg",
      "01-sees-notes.[id].title.png",
      "02-end-of-start.png",
      // What GitHub shows, and the burned-in poster: they stay on the runner.
      "journey.gif",
      "journey.mp4",
      "poster.jpg",
      "journey.vtt",
    ])
      writeFileSync(path.join(folder, name), `${name} of ${target}`);
  }
  return { before, commit, file, spec };
}

test("a run is uploaded: started, each video's files put, its features with it, then finished", async () => {
  const { commit, file, spec } = played();
  // Changed since its commit: what is sent is the commit's, where comments are anchored.
  writeFileSync(path.join(spec, "(app)", "notes", "write-a-note.feature"), "Feature: Changed\n");
  const busy = new Set<string>();
  const puts = new Map<string, string>();
  const { asked, url } = await service((one, response) => {
    if (one.method === "PUT") {
      const at = one.url.replace("/api/runner/runs/run-1/files/", "");
      assert.equal(Number(one.headers["content-length"]), one.body.length);
      assert.equal(one.headers.authorization, `Bearer ${TOKEN}`);
      // The service is busy once for the head's video: it is sent again.
      if (at === "head/(app)/notes/write-a-note/visual/journey.webm" && !busy.has(at)) {
        busy.add(at);
        return json(response, {}, 503);
      }
      puts.set(at, one.body.toString("utf8"));
      response.writeHead(204).end();
      return;
    }
    const { query } = operation(one);
    if (query.includes("startVideoRun"))
      return json(response, { data: { startVideoRun: { id: "run-1" } } });
    if (query.includes("finishVideoRun"))
      return json(response, {
        data: {
          finishVideoRun: {
            latest: true,
            run: { id: "run-1" },
            url: "http://localhost/notes/pull/7",
          },
        },
      });
    json(response, { errors: [{ message: "unexpected" }] });
  });
  const done = await serviceOf({ token: TOKEN, url }).uploadRun({
    featureCommit: commit,
    job: "job-1",
    pull: 7,
    repo: "acme/notes",
    run: "abc123def456",
    spec,
  });
  assert.deepEqual(done, {
    already: false,
    latest: true,
    publish: [],
    url: "http://localhost/notes/pull/7",
  });

  const started = operation(asked[0]!);
  assert.match(started.query, /mutation StartVideoRun\(\$input: StartVideoRunInput!\)/);
  assert.deepEqual(started.variables, {
    input: {
      branch: "add-notes",
      commit: "abc123def4567890",
      dirty: false,
      job: "job-1",
      key: "abc123def456",
      names: [
        { name: "main", side: "base" },
        { name: "this pull request", side: "head" },
      ],
      playedAt: "2026-10-01T12:00:00.000Z",
      pullRequest: 7,
      replace: false,
      repository: "acme/notes",
      specPrefix: "",
      subject: "Add notes",
    },
  });

  const expected = ["base", "head"].flatMap((target) =>
    [
      "01-sees-notes.[id].title.png",
      "02-end-of-start.png",
      "video.json",
      "journey.webm",
      "still.jpg",
      "storyboard.jpg",
    ].map((name) => `${target}/(app)/notes/write-a-note/visual/${name}`),
  );
  assert.deepEqual([...puts.keys()].sort(), expected.sort());
  assert.equal(puts.get("head/(app)/notes/write-a-note/visual/journey.webm"), "webm of head");
  assert.equal(busy.size, 1);

  const finished = operation(asked.at(-1)!);
  assert.match(finished.query, /mutation FinishVideoRun\(\$input: FinishVideoRunInput!\)/);
  assert.match(
    finished.query,
    /finishVideoRun\(input: \$input\) \{ run \{ id \} url latest publish \{ key path url \} \}/,
  );
  assert.deepEqual(finished.variables, {
    input: {
      featureCommit: commit,
      features: [
        {
          file,
          note: null,
          path: "(app)/notes/write-a-note.feature",
          text: 'Feature: Write a note\n  Scenario: Write a note\n    Given I am on "/notes"\n',
        },
      ],
      run: "run-1",
    },
  });
  // Every file was in before the run was finished.
  assert.equal(asked.filter((one) => one.method === "PUT").length, expected.length + 1);
});

test("a run the service could not store is refused before anything is sent", async () => {
  const { spec } = played({ folder: "my notes" });
  const { asked, url } = await service((_one, response) => json(response, {}, 500));
  await assert.rejects(
    serviceOf({ token: TOKEN, url }).uploadRun({ repo: "acme/notes", run: "abc123def456", spec }),
    /^Error: pomspec can't store (base|head)\/my notes\/.+: at most 7 folders deep/,
  );
  await assert.rejects(
    serviceOf({ token: TOKEN, url }).uploadRun({ repo: "acme/notes", run: "nope", spec }),
    /No run nope/,
  );
  // A feature commit the checkout does not have: its .feature files cannot be read from it.
  const { spec: fine } = played();
  await assert.rejects(
    serviceOf({ token: TOKEN, url }).uploadRun({
      featureCommit: "f".repeat(40),
      repo: "acme/notes",
      run: "abc123def456",
      spec: fine,
    }),
    /fetch it first/,
  );
  await assert.rejects(
    serviceOf({ token: TOKEN, url }).uploadRun({
      featureCommit: "abc123",
      repo: "acme/notes",
      run: "abc123def456",
      spec: fine,
    }),
    { message: "--feature-commit takes a full commit sha, not abc123." },
  );
  assert.equal(asked.length, 0);
});

test("a run the service has is kept as it is, unless it went up before its spec or its pull request", async () => {
  const { before, commit, spec } = played();
  const page = "http://localhost/notes/pull/7";
  let kept: string | null = null;
  let pullRequest: number | null = 7;
  const { asked, url } = await service((one, response) => {
    if (one.method === "PUT") return void response.writeHead(204).end();
    const { query, variables } = operation(one);
    const input = variables!.input as { replace: boolean };
    if (query.includes("startVideoRun") && !input.replace)
      return json(response, {
        data: null,
        errors: [
          {
            extensions: {
              code: "uploaded",
              featureCommit: kept,
              latest: true,
              publish: [],
              pullRequest,
              url: page,
            },
            message:
              "acme/notes already has run abc123def456: use pom upload --replace to upload it again.",
          },
        ],
      });
    if (query.includes("startVideoRun"))
      return json(response, { data: { startVideoRun: { id: "run-2" } } });
    json(response, { data: { finishVideoRun: { latest: true, run: { id: "run-2" }, url: page } } });
  });
  const runner = serviceOf({ token: TOKEN, url });
  const upload = { pull: 7, repo: "acme/notes", run: "abc123def456", spec };
  const kept7 = { already: true, latest: true, publish: [], url: page };

  // Reviewed again, or uploaded again without its spec: nothing more is sent.
  assert.deepEqual(await runner.uploadRun(upload), kept7);
  kept = commit;
  assert.deepEqual(await runner.uploadRun({ ...upload, featureCommit: commit }), kept7);
  // At a commit the checkout moved to since, or with none: its own is kept.
  assert.deepEqual(await runner.uploadRun({ ...upload, featureCommit: before }), kept7);
  assert.equal(asked.length, 3);

  // Uploaded before its spec was pushed, now with the spec's commit: replaced, to keep it.
  // The journey's .feature is that commit's alone: one it lacks is sent as none.
  kept = null;
  assert.deepEqual(await runner.uploadRun({ ...upload, featureCommit: before }), {
    ...kept7,
    already: false,
  });
  const starts = asked
    .slice(3)
    .filter((one) => one.method === "POST" && operation(one).query.includes("startVideoRun"));
  assert.deepEqual(
    starts.map((one) => (operation(one).variables!.input as { replace: boolean }).replace),
    [false, true],
  );
  assert.deepEqual(operation(asked.at(-1)!).variables, {
    input: { featureCommit: before, features: [], run: "run-2" },
  });

  // Uploaded for no pull request, now for #7: replaced, at the spec commit it had, never
  // the one this upload brings.
  kept = commit;
  pullRequest = null;
  assert.deepEqual(await runner.uploadRun({ ...upload, featureCommit: before }), {
    ...kept7,
    already: false,
  });
  const finished = operation(asked.at(-1)!).variables!.input as {
    featureCommit: string;
    features: Array<{ path: string }>;
  };
  assert.equal(finished.featureCommit, commit);
  assert.deepEqual(
    finished.features.map((one) => one.path),
    ["(app)/notes/write-a-note.feature"],
  );
});

test("what a comment shows goes up under publish/, and the finish says where GitHub shows it", async () => {
  const { before, commit, spec } = played();
  const video = path.join(spec, ".pom/runs/abc123def456/head/(app)/notes/write-a-note/visual");
  writeFileSync(path.join(video, "journey.gif"), "GIF89a");
  const page = "http://localhost/notes/pull/7";
  const shown = (at: string) => `https://github.com/acme/notes/blob/pomspec/videos/${at}?raw=true`;
  let ready = false;
  let latest = true;
  /** What the run put on the videos branch, as its finish said. */
  let onBranch: Array<{ key: string; path: string; url: string }> = [];
  const puts = new Map<string, string>();
  const { asked, url } = await service((one, response) => {
    if (one.method === "PUT") {
      puts.set(one.url.replace("/api/runner/runs/run-1/files/", ""), one.body.toString("utf8"));
      return void response.writeHead(204).end();
    }
    const { query, variables } = operation(one);
    const input = variables!.input as {
      publish?: Array<{ key: string; path: string }>;
      replace?: boolean;
    };
    if (query.includes("startVideoRun") && ready && !input.replace)
      return json(response, {
        data: null,
        errors: [
          {
            extensions: {
              code: "uploaded",
              featureCommit: commit,
              latest,
              publish: onBranch,
              pullRequest: 7,
              url: page,
            },
            message: "acme/notes already has run abc123def456.",
          },
        ],
      });
    if (query.includes("startVideoRun"))
      return json(response, { data: { startVideoRun: { id: "run-1" } } });
    ready = true;
    if (latest) onBranch = (input.publish ?? []).map((p) => ({ ...p, url: shown(p.path) }));
    json(response, {
      data: {
        finishVideoRun: {
          latest,
          publish: latest ? onBranch : [],
          run: { id: "run-1" },
          url: page,
        },
      },
    });
  });
  const runner = serviceOf({ token: TOKEN, url });
  const publish = [
    {
      file: path.join(video, "journey.gif"),
      key: "publish/write-a-note.gif",
      path: "pr-7/abc123def456/write-a-note.gif",
    },
    {
      file: path.join(video, "02-end-of-start.png"),
      key: "publish/write-a-note-1.png",
      path: "pr-7/abc123def456/write-a-note-1.png",
    },
  ];
  const upload = {
    featureCommit: commit,
    publish,
    pull: 7,
    repo: "acme/notes",
    run: "abc123def456",
    spec,
  };
  const linked = publish.map(({ key, path: at }) => ({ key, path: at, url: shown(at) }));
  assert.deepEqual(await runner.uploadRun(upload), {
    already: false,
    latest: true,
    publish: linked,
    url: page,
  });
  assert.equal(puts.get("publish/write-a-note.gif"), "GIF89a");
  assert.equal(puts.get("publish/write-a-note-1.png"), "02-end-of-start.png of head");
  assert.deepEqual(
    (operation(asked.at(-1)!).variables!.input as { publish: unknown }).publish,
    publish.map(({ key, path: at }) => ({ key, path: at })),
  );
  const startsOf = () =>
    asked
      .filter((one) => one.method === "POST" && operation(one).query.includes("startVideoRun"))
      .map((one) => (operation(one).variables!.input as { replace: boolean }).replace);
  const sent = asked.length;

  // Reviewed again, its spec's checkout moved on since or its spec left out: kept as it is,
  // and what it put on the videos branch said again.
  for (const featureCommit of [commit, before, null])
    assert.deepEqual(await runner.uploadRun({ ...upload, featureCommit }), {
      already: true,
      latest: true,
      publish: linked,
      url: page,
    });
  assert.equal(asked.length, sent + 3);

  // Showing what is not on the branch yet: uploaded again, and finished at the spec commit
  // it had, its .feature read from there.
  const more = [
    ...publish,
    {
      file: path.join(video, "02-end-of-start.png"),
      key: "publish/write-a-note-2.png",
      path: "pr-7/abc123def456/write-a-note-2.png",
    },
  ];
  assert.deepEqual(
    (await runner.uploadRun({ ...upload, featureCommit: before, publish: more })).publish.map(
      (one) => one.path,
    ),
    more.map((one) => one.path),
  );
  assert.deepEqual(startsOf(), [false, false, false, false, false, true]);
  const finished = operation(asked.at(-1)!).variables!.input as {
    featureCommit: string;
    features: Array<{ path: string }>;
  };
  assert.equal(finished.featureCommit, commit);
  assert.deepEqual(
    finished.features.map((one) => one.path),
    ["(app)/notes/write-a-note.feature"],
  );

  // A newer run is its pull request's latest: this one is kept as it is, and shows nothing.
  latest = false;
  assert.deepEqual(
    await runner.uploadRun({
      ...upload,
      publish: [...more, { ...more[2]!, key: "publish/a.png", path: "pr-7/abc123def456/a.png" }],
    }),
    { already: true, latest: false, publish: [], url: page },
  );
  assert.deepEqual(startsOf(), [false, false, false, false, false, true, false]);

  // What the videos branch cannot hold is refused before anything is sent: a file it
  // cannot show, one twice, or more of them than it holds of a run.
  const now = asked.length;
  await assert.rejects(
    runner.uploadRun({ ...upload, publish: [{ ...publish[0]!, key: "publish/video.json" }] }),
    /\.gif, \.jpg, \.mp4 or \.png/,
  );
  await assert.rejects(
    runner.uploadRun({ ...upload, publish: [publish[0]!, publish[0]!] }),
    /published twice/,
  );
  const large = Array.from({ length: 11 }, (_, i) => {
    const file = path.join(video, `large-${i}.gif`);
    writeFileSync(file, "");
    truncateSync(file, 14 * 1024 * 1024);
    return { file, key: `publish/large-${i}.gif`, path: `pr-7/abc123def456/large-${i}.gif` };
  });
  await assert.rejects(runner.uploadRun({ ...upload, publish: large }), /limit of 150 MB/);
  assert.equal(asked.length, now);
});

test("a file the service refuses stops the upload with why", async () => {
  const { spec } = played();
  // Past a limit, the service's own sentence says which; without one, the status does.
  const said =
    "head/(app)/notes/write-a-note/visual/journey.webm is over pomspec's limit of 100 MB for one file.";
  let plain = true;
  const { url } = await service((one, response) => {
    if (one.method === "PUT") {
      if (!plain) return json(response, {}, 413);
      response.writeHead(413, { "content-type": "text/plain" });
      return void response.end(said);
    }
    json(response, { data: { startVideoRun: { id: "run-1" } } });
  });
  const upload = () =>
    serviceOf({ token: TOKEN, url }).uploadRun({ repo: "acme/notes", run: "abc123def456", spec });
  await assert.rejects(
    upload(),
    (error) => error instanceof ServiceError && error.status === 413 && error.message === said,
  );
  plain = false;
  await assert.rejects(
    upload(),
    (error) =>
      error instanceof ServiceError &&
      error.status === 413 &&
      /^pomspec refused (base|head)\/.+ \(413\)\.$/.test(error.message),
  );
});

test("a file is put again while the service fails or drops it, with pom's version; one refused is not", async () => {
  const { spec } = played();
  const webm = "head/(app)/notes/write-a-note/visual/journey.webm";
  const tries = new Map<string, number>();
  let refuse = false;
  const { asked, url } = await service((one, response) => {
    if (one.method === "PUT") {
      const at = decodeURIComponent(one.url.replace("/api/runner/runs/run-1/files/", ""));
      const tried = (tries.get(at) ?? 0) + 1;
      tries.set(at, tried);
      if (at === webm && refuse) return json(response, {}, 400);
      // The head's video: the service fails twice, then the connection drops, then it's kept.
      if (at === webm && tried <= 2) return json(response, {}, 500);
      if (at === webm && tried === 3) return void response.socket?.destroy();
      return void response.writeHead(204).end();
    }
    const { query } = operation(one);
    if (query.includes("startVideoRun"))
      return json(response, { data: { startVideoRun: { id: "run-1" } } });
    json(response, {
      data: { finishVideoRun: { latest: false, publish: [], run: { id: "run-1" }, url } },
    });
  });
  const runner = serviceOf({ patience: { first: 10, total: 10_000 }, token: TOKEN, url });
  const upload = { encode: null, repo: "acme/notes", run: "abc123def456", spec } as const;
  assert.equal((await runner.uploadRun(upload)).url, url);
  assert.equal(tries.get(webm), 4);
  assert.ok([...tries.entries()].every(([at, n]) => at === webm || n === 1));
  for (const one of asked) assert.equal(one.headers["x-pom-version"], VERSION);

  tries.clear();
  refuse = true;
  await assert.rejects(
    runner.uploadRun({ ...upload, replace: true }),
    (error) =>
      error instanceof ServiceError &&
      error.status === 400 &&
      error.message === `pomspec refused ${webm} (400).`,
  );
  assert.equal(tries.get(webm), 1);
});

test("a run goes to a project by its address, with no repository; to one or the other alone", async () => {
  const { spec } = played();
  const { asked, url } = await service((one, response) => {
    if (one.method === "PUT") return void response.writeHead(204).end();
    const { query } = operation(one);
    if (query.includes("startVideoRun"))
      return json(response, { data: { startVideoRun: { id: "run-1" } } });
    json(response, {
      data: {
        finishVideoRun: {
          latest: false,
          publish: [],
          run: { id: "run-1" },
          url: "http://localhost/notes",
        },
      },
    });
  });
  const runner = serviceOf({ token: TOKEN, url });
  const done = await runner.uploadRun({ project: "notes", run: "abc123def456", spec });
  assert.deepEqual(done, {
    already: false,
    latest: false,
    publish: [],
    url: "http://localhost/notes",
  });
  const { input } = operation(asked[0]!).variables as { input: Record<string, unknown> };
  assert.equal(input.project, "notes");
  assert.equal("repository" in input, false);
  assert.equal(input.pullRequest, null);

  // Neither, or both: refused before anything is sent.
  const sent = asked.length;
  const neither = {
    message: "pomspec can't start this run: name its project or its repository, one of them.",
  };
  await assert.rejects(runner.uploadRun({ run: "abc123def456", spec }), neither);
  await assert.rejects(
    runner.uploadRun({ project: "notes", repo: "acme/notes", run: "abc123def456", spec }),
    neither,
  );
  assert.equal(asked.length, sent);
});

test("a spec with no GitHub remote goes to its name's project by default", () => {
  const { spec } = played();
  // Its folder's name, made an address, until its config names it.
  assert.equal(defaultProject(spec), path.basename(spec).toLowerCase());
  writeFileSync(path.join(spec, "pom.config.ts"), 'export default { name: "Acme Notes!" };\n');
  assert.equal(defaultProject(spec), "acme-notes");
  git(spec, "remote", "add", "origin", "https://gitlab.example.com/acme/notes.git");
  assert.equal(defaultProject(spec), "acme-notes");
  // A GitHub repository's checkout names its repository, or its project, itself.
  git(spec, "remote", "set-url", "origin", "git@github.com:acme/notes.git");
  assert.equal(defaultProject(spec), null);
});

/**
 * A service that takes any run whole, and keeps each file put, by its path in the run; or,
 * `older`, one from before WebP, which refuses a .webp as a path a run holds no file at.
 */
async function taking({ older = false } = {}) {
  const puts = new Map<string, Buffer>();
  const { url } = await service((one, response) => {
    if (one.method === "PUT") {
      const at = decodeURIComponent(one.url.replace("/api/runner/runs/run-1/files/", ""));
      if (older && at.endsWith(".webp")) {
        response.writeHead(400, { "content-type": "text/plain" });
        return void response.end("A run can't have a file at that path.");
      }
      puts.set(at, one.body);
      return void response.writeHead(204).end();
    }
    const { query } = operation(one);
    if (query.includes("startVideoRun"))
      return json(response, { data: { startVideoRun: { id: "run-1" } } });
    json(response, {
      data: {
        finishVideoRun: {
          latest: false,
          publish: [],
          run: { id: "run-1" },
          url: "http://localhost/notes",
        },
      },
    });
  });
  return { puts, runner: serviceOf({ token: TOKEN, url }) };
}

/**
 * An ffmpeg of its own, alone on the PATH beside git: one that writes WebP (a few bytes,
 * whatever it is given), saying each call in `calls`, or one without it, as Homebrew's,
 * then with cwebp beside it, which writes WebP and says its calls the same way.
 */
function ffmpegOf(kind: "webp" | "no-webp" | "cwebp" | "none") {
  const bin = mkdtempSync(path.join(tmpdir(), "pom-ffmpeg-"));
  after(() => rmSync(bin, { force: true, recursive: true }));
  symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), path.join(bin, "git"));
  const calls = path.join(bin, "calls");
  if (kind !== "none")
    writeFileSync(
      path.join(bin, "ffmpeg"),
      [
        "#!/bin/sh",
        `case "$*" in *encoder=libwebp*) echo "${kind === "webp" ? "Encoder libwebp [libwebp WebP image]:" : "Codec 'libwebp' is not recognized by FFmpeg."}"; exit 0;; esac`,
        `printf '%s\\n' "$*" >> '${calls}'`,
        "for last; do :; done",
        'printf RIFFWEBP > "$last"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  if (kind === "cwebp")
    writeFileSync(
      path.join(bin, "cwebp"),
      [
        "#!/bin/sh",
        'if [ "$1" = -version ]; then echo 1.6.0; exit 0; fi',
        `printf '%s\\n' "$*" >> '${calls}'`,
        "for last; do :; done",
        'printf RIFFWEBP > "$last"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  /** `work`, with this ffmpeg the only one there is. */
  const using = async <T>(work: () => Promise<T>): Promise<T> => {
    const was = process.env.PATH;
    process.env.PATH = bin;
    try {
      return await work();
    } finally {
      process.env.PATH = was;
    }
  };
  return {
    calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []),
    using,
  };
}

const FOLDER = "(app)/notes/write-a-note/visual";

test("a video's pictures go up as WebP, its video.json naming them; the run keeps its PNGs, and publish/ goes as it is", async () => {
  const { spec } = played();
  const run = path.join(spec, ".pom/runs/abc123def456");
  const video = path.join(run, "head", FOLDER);
  const before = readFileSync(path.join(video, "video.json"), "utf8");
  const { puts, runner } = await taking();
  const ffmpeg = ffmpegOf("webp");
  const said: Array<string> = [];
  await ffmpeg.using(() =>
    runner.uploadRun({
      project: "notes",
      publish: [
        {
          file: path.join(video, "02-end-of-start.png"),
          key: "publish/write-a-note-1.png",
          path: "pr-7/abc123def456/write-a-note-1.png",
        },
      ],
      run: "abc123def456",
      say: (line) => said.push(line),
      spec,
    }),
  );
  const expected = ["base", "head"].flatMap((target) =>
    [
      "01-sees-notes.[id].title.webp",
      "02-end-of-start.webp",
      "video.json",
      "journey.webm",
      "still.jpg",
      "storyboard.jpg",
    ].map((name) => `${target}/${FOLDER}/${name}`),
  );
  assert.deepEqual([...puts.keys()].sort(), [...expected, "publish/write-a-note-1.png"].sort());
  assert.equal(puts.get(`head/${FOLDER}/02-end-of-start.webp`)?.toString(), "RIFFWEBP");
  // What GitHub shows goes as the run holds it.
  assert.equal(puts.get("publish/write-a-note-1.png")?.toString(), "02-end-of-start.png of head");
  const sent = JSON.parse(puts.get(`head/${FOLDER}/video.json`)!.toString("utf8"));
  assert.deepEqual(sent, {
    ...JSON.parse(before),
    chapters: [{ picture: "02-end-of-start.webp", start: 0, title: "Start" }],
    checks: [
      { at: 1, picture: "01-sees-notes.[id].title.webp", text: "The notes", verdict: "found" },
    ],
  });
  // ffmpeg made each picture from the run's PNG, lossy at 90, in a folder of its own.
  const calls = ffmpeg.calls();
  assert.equal(calls.length, 4);
  for (const call of calls) {
    const [, png, webp] =
      /^-loglevel error -y -i (.+\.png) -c:v libwebp -quality 90 -compression_level 4 (.+\.webp)$/.exec(
        call,
      ) ?? assert.fail(call);
    assert.ok(png!.startsWith(run));
    assert.ok(!webp!.startsWith(spec));
    // Gone once the run is up.
    assert.equal(existsSync(path.dirname(webp!)), false);
  }
  // The run on disk is as it was: its PNGs, its video.json naming them.
  assert.equal(readFileSync(path.join(video, "video.json"), "utf8"), before);
  assert.deepEqual(
    readdirSync(video).filter((name) => /\.(png|webp)$/.test(name)),
    ["01-sees-notes.[id].title.png", "02-end-of-start.png"],
  );
  assert.deepEqual(said, []);
});

test("without ffmpeg's WebP, cwebp makes the pictures, at the same quality", async () => {
  const { spec } = played();
  const { puts, runner } = await taking();
  const tools = ffmpegOf("cwebp");
  const said: Array<string> = [];
  await tools.using(() =>
    runner.uploadRun({
      project: "notes",
      run: "abc123def456",
      say: (line) => said.push(line),
      spec,
    }),
  );
  assert.deepEqual(said, []);
  assert.equal(puts.get(`head/${FOLDER}/02-end-of-start.webp`)?.toString(), "RIFFWEBP");
  const calls = tools.calls();
  assert.equal(calls.length, 4);
  for (const call of calls) assert.match(call, /^-quiet -q 90 -m 4 \S+\.png -o \S+\.webp$/);
});

test("a service from before WebP is sent the run as it is, its pictures PNG, said in a line", async () => {
  const { spec } = played();
  const disk = path.join(spec, ".pom/runs/abc123def456/head", FOLDER, "video.json");
  const { puts, runner } = await taking({ older: true });
  const said: Array<string> = [];
  await ffmpegOf("webp").using(() =>
    runner.uploadRun({
      project: "notes",
      run: "abc123def456",
      say: (line) => said.push(line),
      spec,
    }),
  );
  assert.deepEqual(said, [NO_WEBP_THERE]);
  assert.equal(
    [...puts.keys()].some((at) => at.endsWith(".webp")),
    false,
  );
  assert.ok(puts.has(`head/${FOLDER}/02-end-of-start.png`));
  assert.equal(puts.get(`head/${FOLDER}/video.json`)!.toString("utf8"), readFileSync(disk, "utf8"));
});

test("pictures WebP made none of smaller go up as PNG, said in a line", async () => {
  const { spec } = played();
  const { puts, runner } = await taking();
  const said: Array<string> = [];
  await runner.uploadRun({
    encode: async () => false,
    project: "notes",
    run: "abc123def456",
    say: (line) => said.push(line),
    spec,
  });
  assert.deepEqual(said, [NO_SMALLER]);
  assert.ok(puts.has(`head/${FOLDER}/02-end-of-start.png`));
});

test("without an ffmpeg that writes WebP, pictures go up as PNG, said in a line", async () => {
  for (const kind of ["no-webp", "none"] as const) {
    const { spec } = played();
    const { puts, runner } = await taking();
    const said: Array<string> = [];
    await ffmpegOf(kind).using(() =>
      runner.uploadRun({
        project: "notes",
        run: "abc123def456",
        say: (line) => said.push(line),
        spec,
      }),
    );
    assert.deepEqual(said, [NO_WEBP]);
    assert.ok(puts.has(`head/${FOLDER}/02-end-of-start.png`));
    assert.equal(
      [...puts.keys()].some((at) => at.endsWith(".webp")),
      false,
    );
  }
  // Sent as PNG by choice: nothing to say.
  const { spec } = played();
  const { puts, runner } = await taking();
  const said: Array<string> = [];
  await runner.uploadRun({
    encode: null,
    project: "notes",
    run: "abc123def456",
    say: (line) => said.push(line),
    spec,
  });
  assert.deepEqual(said, []);
  assert.ok(puts.has(`base/${FOLDER}/01-sees-notes.[id].title.png`));
});

test("a picture whose WebP isn't smaller, or couldn't be made, goes up as PNG", async () => {
  const { spec } = played();
  const disk = path.join(spec, ".pom/runs/abc123def456/base", FOLDER, "video.json");
  const { puts, runner } = await taking();
  const encode: Encode = async (png, webp) => {
    const at = path.relative(spec, png);
    if (at.includes("base") && at.endsWith("01-sees-notes.[id].title.png")) throw new Error("no");
    if (at.includes("base")) return false;
    writeFileSync(webp, at.endsWith("01-sees-notes.[id].title.png") ? "x".repeat(500) : "RIFF");
    return true;
  };
  await runner.uploadRun({ encode, project: "notes", run: "abc123def456", spec });
  const pictures = [...puts.keys()].filter((at) => /\.(png|webp)$/.test(at)).sort();
  assert.deepEqual(pictures, [
    `base/${FOLDER}/01-sees-notes.[id].title.png`,
    `base/${FOLDER}/02-end-of-start.png`,
    `head/${FOLDER}/01-sees-notes.[id].title.png`,
    `head/${FOLDER}/02-end-of-start.webp`,
  ]);
  const head = JSON.parse(puts.get(`head/${FOLDER}/video.json`)!.toString("utf8"));
  assert.equal(head.chapters[0].picture, "02-end-of-start.webp");
  assert.equal(head.checks[0].picture, "01-sees-notes.[id].title.png");
  // Nothing of it made WebP: its video.json goes as the run holds it.
  assert.equal(puts.get(`base/${FOLDER}/video.json`)!.toString("utf8"), readFileSync(disk, "utf8"));
});

const webp = webpEncoder();
test(
  "this machine writes a picture as WebP, where it can",
  { skip: webp ? false : "nothing here writes WebP" },
  async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "pom-webp-"));
    after(() => rmSync(folder, { force: true, recursive: true }));
    const png = new PNG({ height: 200, width: 320 });
    for (let i = 0; i < png.data.length; i += 4) {
      const x = (i / 4) % 320;
      png.data.set([x % 64 < 32 ? 30 : 230, 120, (i / 4 / 320) | 0, 255], i);
    }
    const file = path.join(folder, "01-sees-notes.png");
    writeFileSync(file, PNG.sync.write(png));
    const out = path.join(folder, "01-sees-notes.webp");
    assert.equal(await webp!(file, out), true);
    const made = readFileSync(out);
    assert.equal(made.subarray(0, 4).toString("latin1"), "RIFF");
    assert.equal(made.subarray(8, 12).toString("latin1"), "WEBP");
  },
);
