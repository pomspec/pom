import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FullConfig, Reporter, Suite, TestCase, TestResult } from "@playwright/test/reporter";
import { masker, secretsIn } from "./secrets.ts";

// `pom shots`' Playwright reporter: one line a journey and width as it ends, and
// what each test saw (its status, its moments' attachments, its video) into
// `<run>/results.json` for `pom shots` to keep. Playwright's own output (and
// `toHaveScreenshot`'s "writing actual" notes) stays out of the way, and a secret's
// value in what it prints is dots (secrets.ts, pure, the one thing of pom's it imports:
// Playwright loads it on its own).

export type Result = {
  error: string | null;
  video: unknown;
  journey: string;
  moments: Array<unknown>;
  project: string;
  status: TestResult["status"];
  title: string;
};

const read = (body: Buffer | undefined) => (body ? JSON.parse(body.toString("utf8")) : null);

export default class PomReporter implements Reporter {
  private results: Array<Result> = [];
  private tests = "";

  onBegin(config: FullConfig, _suite: Suite) {
    this.tests = path.join(path.dirname(config.configFile ?? process.cwd()), "tests");
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const project = test.parent.project()?.name ?? "";
    const journey = path
      .relative(this.tests, test.location.file)
      .replace(/\.spec\.ts$/, "")
      .split(path.sep)
      .join("/");
    const moments = result.attachments
      .filter((a) => a.name === "pom:moment")
      .map((a) => read(a.body));
    const video = read(result.attachments.find((a) => a.name === "pom:video")?.body);
    const error = result.error?.message?.split("\n")[0] ?? null;
    this.results.push({
      error,
      video,
      journey,
      moments,
      project,
      status: result.status,
      title: test.title,
    });
    const mark = result.status === "passed" ? "✓" : result.status === "skipped" ? "-" : "✗";
    const what = project.startsWith("video-") ? "recorded" : `${moments.length} moments`;
    const { mask } = masker(secretsIn(process.env));
    console.log(`  ${mark} ${mask(test.title)} · ${project.replace(/^video-/, "")} · ${what}`);
    if (error) console.log(`    ${mask(error)}`);
  }

  onEnd() {
    const run = process.env.POM_RUN;
    if (!run) return;
    mkdirSync(run, { recursive: true });
    writeFileSync(path.join(run, "results.json"), `${JSON.stringify(this.results, null, 2)}\n`);
  }

  printsToStdio() {
    return true;
  }
}
