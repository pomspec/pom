# pom

Your app's journeys, pictured and recorded, in every pull request.

```gherkin
Feature: Sign up
  Scenario: Sign up
    # Create an account
    Given I am on "/sign-up"
    When I fill "Email" with "ana@example.com"
    And I press the "Create account" button
    # See the projects
    # as owner
    Then I am on "/projects"
    And I see "No projects yet"
```

pom plays each journey in a real browser at desktop and phone, keeps a picture of every
moment and a video of the whole journey, and shows what changed: in your terminal and
in your pull request — before and after, side by side, with the video playing inline.

## Start

```sh
npm install -D -E pomspec @playwright/test
npx playwright install chromium
npx pomspec init http://localhost:3000
```

`pom init` writes `pom.config.ts` (`pom.config.mts` where your package.json isn't
`"type": "module"`) and `spec/`. In a repository on GitHub (its remote there, or a
`.github` folder), it also writes `.github/workflows/pomspec.yml` at the repository's
root: pom's Action on every pull request (On GitHub Actions, below), starting your app
with your package.json's `dev` script and playing it at the address you gave `pom init`,
or with those lines left for you to fill in. A workflow already there is left as it is.
Then it asks which agent should write your journeys (Claude Code, Codex, Gemini CLI,
Copilot CLI, OpenCode or pi). It runs that agent's own command, signed in as you, on
your machine: pom never signs in anywhere itself. Then it maps your app: every page,
pictured, and the ones no journey visits yet, and says what's next: commit what it
wrote, connect GitHub in pomspec (Settings → GitHub), and open a pull request. Not on
GitHub yet? Once you are, run `pom init` with your app's address again: it adds the
workflow.

## Every day

```sh
npx pomspec check   # every line finds its control on its page; no browser
npx pomspec shots   # every journey, every width: pictures and a video, in .pom/
npx pomspec diff    # what changed against your base branch, in pictures
npx pomspec pr      # put the before and after, and the videos, in your pull request
```

## Where pictures live

- **In `.pom/`**, on the machine that took them, kept by the code that drew them — so a
  pull request's "before" is there once it has been taken.
- **On your pull requests**, as GitHub attachments uploaded with your own `gh`: they stay
  with the pull request, and only people who can see the repository can see them.
- **In git, if you want them there**: `pom shots --commit` keeps each journey's
  checkpoints (where the screen changed) beside it. Committed pictures are compared
  only with pictures drawn on the same platform; `--docker` draws them in Playwright's
  own image, as CI does.

GitHub plays videos up to 100 MB and takes 50 files at a time; past that, pom says so.
[pomspec](https://pomspec.com) keeps every version of every picture, and a map your
whole team can open.

## Videos on pomspec

A machine that plays your journeys can be your organization's runner: create a runner
token in pomspec under Settings → Runners, and upload each run it plays. pomspec keeps
the videos for everyone in the organization, at the pull request's own address with
github.com swapped for pomspec.com/github.

`pom videos` plays your journeys on a pull request's two sides and records them for
pomspec: its head (this checkout's app) and its base (the branch it merges into), both
from this checkout's spec. A journey that stops only on the head is broken, one that
stops only on the base is new, and one whose screens look different on the base has
changed.

```sh
npx pomspec videos --head-url <url> --base-url <url>
npx pomspec videos --start "npm run dev" --ready-url http://localhost:3000 --base-dir ../main
```

Each side is an address, or its app started for its turn (`--start`, else
`pom.config.ts`'s `webServer`) in its own checkout: this one for the head, `--base-dir`
for the base, one side at a time. pom never starts a side where something already
answers: an app that is up already is given by its address. Without a base, only the
head is played. The run is kept in `.pom/runs/<run>/`, its id printed last; `pom upload`
sends the newest unless `--run <id>` names another.

```sh
POM_RUNNER_TOKEN=pomr_… npx pomspec upload --repo <owner/name> --pull <n>
```

`--run` names a folder in `.pom/runs/`. pom sends each video with its still, storyboard
and pictures, and each journey's `.feature`, then prints the run's page, last
(`On pomspec: <url>`). Pictures go up as WebP, about 6 times lighter, where ffmpeg can
write it (Ubuntu's can, Homebrew's can't) or cwebp is installed (`brew install webp`,
which the Action does on a Mac), else as PNG, and pom says so; the run on disk keeps its
PNGs.
With `--pull`, pom first draws the GIF of each video the pull request's comment shows,
with ffmpeg and the project's own `@playwright/test` Chromium (without either it says so
and uploads without them), and puts them and the comment's pictures on the repository's
videos branch.
A project with no GitHub repository takes `--project <slug>` in place of `--repo`, the
default for a spec with no GitHub remote (its name's project); its runs are of no pull
request.
pom uploads to pomspec.com, unless `POM_SERVICE_URL` (or `--service`) says where else
pomspec is; `--replace` uploads a run again. The runner only calls out: pomspec never
calls it.

## On GitHub Actions

pom's Action plays each pull request on your repository's own Actions minutes, records it
and uploads it. pomspec then writes the pull request's comment and its check. Connect the
repository in pomspec (Settings → GitHub), and add this as
`.github/workflows/pomspec.yml` (`pom init` writes it, and in pomspec, Settings → Runners
has it ready to paste):

```yaml
on: pull_request
permissions: { contents: read, deployments: read, pull-requests: read, id-token: write }
jobs:
  videos:
    if: github.actor != 'dependabot[bot]'
    runs-on: ubuntu-latest
    concurrency:
      group: pomspec-${{ github.event.pull_request.head.sha || github.sha }}
      cancel-in-progress: true
    steps:
      - uses: pomspec/pom/action@v0.1.3
        with:
          start: npm run dev
          ready-url: http://localhost:3000
        env:
          POM_OWNER_EMAIL: ${{ secrets.POM_OWNER_EMAIL }}
          POM_OWNER_PASSWORD: ${{ secrets.POM_OWNER_PASSWORD }}
```

The Action and pomspec are released together, at one number: `pomspec/pom/action@v0.1.3`
is made for `pomspec@0.1.3`. `pom init` pins the Action at the pomspec you installed, which
`-E` (Start, above) saved at its exact number; when you update one, update the other with
it. If they differ, the Action warns, says which to raise, and plays all the same.

There's no token to create and no secret to keep: with `id-token: write`, GitHub vouches
for the workflow, and pomspec lets it upload to that repository and the project linked to
it, for two hours at a time. Without it, the Action takes a runner token instead: create
one in Settings → Runners, keep it as the repository secret `POMSPEC_RUNNER_TOKEN`, and
pass it as `runner-token: ${{ secrets.POMSPEC_RUNNER_TOKEN }}`.

The head plays at `head-url`, else at GitHub's latest successful deployment of its
commit that isn't production, else wherever `start` runs it. The base plays at
`base-url`, else wherever `start` runs it, in a checkout of its own. A production
deployment is never played, because journeys sign up and create and change data. If
each push gets a preview, also run the workflow `on: deployment_status`, and its job
only for a successful one:
`if: github.event_name != 'deployment_status' || github.event.deployment_status.state == 'success'`.
A commit plays one run at a time (`concurrency`), and playing it again (a re-run, a later
deployment) replaces its videos. The Action checks out the head itself, installs as your
lockfile says (pnpm, yarn or npm), keeps Playwright's Chromium between runs, and plays
only what's committed. `spec` is the spec's folder (`spec` by default), and the project
needs `pomspec` and `@playwright/test` in its devDependencies. `project` sends the videos
to a pomspec project of yours instead of the one the repository is linked to, with a
runner token: GitHub's word lets a workflow upload to its own repository's project alone.
Each role signs in as its `signIn` module says, with its credentials passed as env from
the repository's secrets. A pull request from a fork gets no ID token and no secrets, so
it can't be played, and the workflow from Settings → Runners skips it.

## Privacy

Pictures show whatever your app shows. Mark anything private with `data-pom-mask` (or
list selectors in `mask`) and pom covers it. In a public repository, attachments on a
pull request are public.

A value typed from a secret never shows. A variable named `*_PASSWORD`, `*_TOKEN` or
`*_SECRET`, or listed in `secrets`, shows as dots in the videos, their captions and
transcripts, and the run's logs. A field it's typed into is masked on the screen too,
whether a journey's line or a role's `signIn` fills it. Inside other text, pom looks
only for a secret listed in `secrets` or named `POM_*`, and only one of 12 characters or
more, so a CI job's database password never turns an ordinary word into dots.

Pictures are drawn by Playwright's Chromium: on a Mac with Mac fonts, in Playwright's
image with Linux ones. They're a faithful render, not a screenshot of your own browser.

## Configuration

`pom.config.ts` — every field is optional:

```ts
import type { PomConfig } from "pomspec";

export default {
  baseURL: "http://localhost:3000",
  webServer: { command: "npm run dev", url: "http://localhost:3000" },
  widths: { desktop: { viewport: { width: 1280, height: 900 } }, phone: { device: "Pixel 7" } },
  roles: { owner: { signIn: "spec/sign-in-as-owner.ts" } },
  mask: ["[data-pom-mask]"],
  secrets: ["STRIPE_KEY"],
} satisfies PomConfig;
```

## The grammar

```gherkin
Given I am on "/path"                    Then I am on "/path"
When I press the "Save" button           When I follow the "Pricing" link
When I fill "Email" with "a@b.co"        When I select "Monthly" in "Billing period"
When I check "Remember me"               When I uncheck "Remember me"
When I press the "Enter" key             Then I see "Saved"
Then "Members" shows "Ana"               Then the "Invite" dialog opens
Then the "Account" menu opens            Given I am signed in as the "owner"
```

`# Caption` starts a step; `# as <role>` marks where the journey changes hands.

## Under the hood

Each page has a `page.tree.yml`: its accessibility tree, as Playwright writes it, cut to
its landmarks, headings, controls and links. `pom snapshot /sign-up` writes it from the
running app (`--as owner` for a signed-in page), with a picture of the page and its
outline, each node's place on the screen marked. With the trees, `pom check` finds every
line's control without a browser, and pom generates Playwright page objects and tests
(`pom test`). A tree you write yourself is never overwritten.

## For agents

`skills/pom/` is an agent skill: map an app into journeys, and for each change define,
build, check, picture, look, compare, and open the pull request with its pictures.

Apache-2.0
