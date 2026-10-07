// A journey is Gherkin in a closed grammar, each line one Playwright call:
//
//   Given I am on "/sign-up"              page.goto, through the page object
//   Then I am on "/new"                   the URL, then the page's tree
//   When I press the "Save" button        getByRole("button", { name })
//   When I press the "Archive" tab        …any role, by its name
//   When I follow the "Pricing" link      getByRole("link", { name })
//   When I fill "Email" with "a@b.co"     the field named "Email"
//   When I select "Monthly" in "Billing"  an option of the list named "Billing"
//   When I check "Remember me"            a checkbox, radio or switch (or uncheck it)
//   When I press the "Enter" key          a key, as Playwright names it
//   Then I see "The plan"                 that text, visible
//   Then "Members" shows "Ana"            the node named "Members" holds it
//   Then the "Invite" dialog opens        the dialog, and its tree (a menu's too)
//   Given I am signed in as the "owner"   the journey that makes a visitor one, first
//
// `# Caption` starts a step, `# Note: …` explains the line above, and
// `# when <state>` says what state the app is in from there on (`# when empty`): with
// the role and the width, the variation of each page the journey sees.
// `# as <role>` says who acts from there on: a journey starts as the visitor,
// and signing in, out or handing over is where it says so. `And`/`But` repeat
// the keyword before them. Anything else is refused, with its line.

export type Action =
  | { path: string; verb: "arrive" | "go" }
  | { name: string; role: string; verb: "press" }
  | { name: string; value: string; verb: "fill" }
  | { name: string; value: string; verb: "select" }
  | { checked: boolean; name: string; verb: "check" }
  | { key: string; verb: "key" }
  | { text: string; verb: "see" }
  | { name: string; text: string; verb: "shows" }
  | { kind: "dialog" | "menu"; name: string; verb: "opens" }
  | { role: string; verb: "signin" };

/** Who a journey starts as, until it says otherwise. */
export const VISITOR = "visitor";

/** A variation's name as files carry it (`page.<name>.tree.yml`): `with projects` → `with-projects`. */
export const variationName = (words: string) =>
  words
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** `role`: who acts at this line; `state`: what state the app is in (`# when …`), if the journey says. */
export type Line = Readonly<{
  action: Action;
  line: number;
  role: string;
  source: string;
  state: string | null;
}>;

export type Step = Readonly<{ caption: string; lines: ReadonlyArray<Line> }>;

export type Journey = Readonly<{
  background: ReadonlyArray<Line>;
  /** Who acts at its last line. */
  endsAs: string;
  file: string;
  steps: ReadonlyArray<Step>;
  title: string;
}>;

const Q = `"((?:[^"\\\\]|\\\\.)*)"`;
const unquote = (text: string) => JSON.parse(`"${text}"`) as string;

const GRAMMAR: ReadonlyArray<[RegExp, (m: RegExpExecArray, keyword: string) => Action]> = [
  [
    new RegExp(`^I am on ${Q}$`),
    (m, keyword) => ({ path: unquote(m[1]!), verb: keyword === "Given" ? "go" : "arrive" }),
  ],
  // A key is pressed, not a control: "key" is no role.
  [new RegExp(`^I press the ${Q} key$`), (m) => ({ key: unquote(m[1]!), verb: "key" })],
  [
    new RegExp(`^I press the ${Q} ([a-z]+)$`),
    (m) => ({ name: unquote(m[1]!), role: m[2]!, verb: "press" }),
  ],
  [
    new RegExp(`^I follow the ${Q} link$`),
    (m) => ({ name: unquote(m[1]!), role: "link", verb: "press" }),
  ],
  [
    new RegExp(`^I fill ${Q} with ${Q}$`),
    (m) => ({ name: unquote(m[1]!), value: unquote(m[2]!), verb: "fill" }),
  ],
  [
    new RegExp(`^I select ${Q} in ${Q}$`),
    (m) => ({ name: unquote(m[2]!), value: unquote(m[1]!), verb: "select" }),
  ],
  [
    new RegExp(`^I (check|uncheck) ${Q}$`),
    (m) => ({ checked: m[1] === "check", name: unquote(m[2]!), verb: "check" }),
  ],
  [new RegExp(`^I see ${Q}$`), (m) => ({ text: unquote(m[1]!), verb: "see" })],
  [
    new RegExp(`^${Q} shows ${Q}$`),
    (m) => ({ name: unquote(m[1]!), text: unquote(m[2]!), verb: "shows" }),
  ],
  [
    new RegExp(`^the ${Q} (dialog|menu) opens$`),
    (m) => ({ kind: m[2] as "dialog" | "menu", name: unquote(m[1]!), verb: "opens" }),
  ],
  [new RegExp(`^I am signed in as the ${Q}$`), (m) => ({ role: unquote(m[1]!), verb: "signin" })],
];

/** Which keyword each kind of line takes. */
const KEYWORD: Record<Action["verb"], string> = {
  arrive: "Then",
  check: "When",
  fill: "When",
  go: "Given",
  key: "When",
  opens: "Then",
  press: "When",
  see: "Then",
  select: "When",
  shows: "Then",
  signin: "Given",
};

export class SpecError extends Error {}

export function readFeature(source: string, file: string): Journey {
  const fail = (line: number, message: string): never => {
    throw new SpecError(`${file}:${line}: ${message}`);
  };
  let title = "";
  let scenario = "";
  let section: "background" | "none" | "scenario" = "none";
  let keyword = "";
  let role = VISITOR;
  let state: string | null = null;
  const background: Array<Line> = [];
  const steps: Array<{ caption: string; lines: Array<Line> }> = [];

  source.split("\n").forEach((raw, index) => {
    const line = index + 1;
    const text = raw.trim();
    if (!text) return;
    if (text.startsWith("Feature:")) {
      title = text.slice("Feature:".length).trim();
      return;
    }
    if (text === "Background:") {
      section = "background";
      keyword = "";
      return;
    }
    if (text.startsWith("Scenario:")) {
      if (scenario) fail(line, "a journey is one Scenario");
      scenario = text.slice("Scenario:".length).trim();
      section = "scenario";
      keyword = "";
      return;
    }
    if (text.startsWith("#")) {
      const comment = text.slice(1).trim();
      if (comment.startsWith("Note:")) return;
      const when = /^when (.+)$/.exec(comment);
      if (when) {
        state = variationName(when[1]!) || null;
        return;
      }
      const as = /^as (\S+)$/.exec(comment);
      if (as) {
        role = as[1]!;
        return;
      }
      if (section !== "scenario") fail(line, "a caption belongs to a step, inside the Scenario");
      steps.push({ caption: comment, lines: [] });
      return;
    }
    const match = /^(Given|When|Then|And|But) (.+)$/.exec(text);
    if (!match) return fail(line, `not a line of a journey: ${text}`);
    const said = match[1]!;
    if (said === "And" || said === "But") {
      if (!keyword) fail(line, `"${said}" repeats the keyword before it, and there is none`);
    } else keyword = said;
    let action: Action | null = null;
    for (const [pattern, make] of GRAMMAR) {
      const found = pattern.exec(match[2]!);
      if (found) {
        action = make(found, keyword);
        break;
      }
    }
    if (!action) return fail(line, `not in the grammar: ${text}`);
    if (KEYWORD[action.verb] !== keyword) {
      fail(line, `"${match[2]}" is a ${KEYWORD[action.verb]} line, not ${keyword}`);
    }
    if (action.verb === "signin") role = action.role;
    const read: Line = { action, line, role, source: text, state };
    if (section === "background") background.push(read);
    else if (section === "scenario") {
      const step = steps.at(-1) ?? fail(line, "a step starts with its caption (# Caption)");
      step.lines.push(read);
    } else fail(line, "a line belongs to a Background or the Scenario");
  });

  if (!title) fail(1, "a journey starts with Feature: and its title");
  if (scenario !== title) fail(1, "the Scenario is named as its Feature");
  const empty = steps.find((step) => step.lines.length === 0);
  if (empty) fail(1, `the step "${empty.caption}" has no lines`);
  return { background, endsAs: role, file, steps, title };
}
