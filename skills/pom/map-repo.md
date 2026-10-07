# Write this repository's pomspec spec

You are writing a spec of this app that people read and watch: its journeys, in
Gherkin, beside the pages they visit. pom checks every line against the pages and
pictures every journey. Work in the repository you were started in.

## 1. Find the app's pages, roles and flows

- The framework and its routes: file-based (`app/`, `pages/`, `routes/`, SvelteKit's
  `src/routes`) or a route table (React Router, Rails' `config/routes.rb`, Django's
  `urls.py`, Express).
- Who uses it: a visitor (signed out) and each signed-in role (guards, middleware,
  `before_action`, `login_required`, role checks).
- What people do: the forms and the actions that change things (mutations, POST
  handlers, server actions). Each is a flow worth a journey: sign up, sign in, create
  the main thing, change it, invite someone, pay.

## 2. Write `spec/` as pomspec's tree

Folders route as Next.js's `app/` does: a folder is a path segment, `[id]` a dynamic
one, `(group)` none. A group named after a role, `(visitor)`, holds that role's pages.

```
spec/
  (visitor)/sign-up/page.tree.yml
  (visitor)/sign-up/sign-up.feature
  (owner)/projects/[id]/page.tree.yml
```

A journey is `<name>.feature` beside the page it starts on, in exactly this grammar:

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

- `Feature` and `Scenario` are the journey's title. `# <caption>` starts a step.
- `Given I am on "<path>"`, `Then I am on "<path>"`.
- `When I press the "<name>" <role>` (button, tab, menuitem…), `When I follow the
"<name>" link`, `When I fill "<label>" with "<value>"`, `When I select "<option>" in
"<label>"`, `When I check "<label>"`, `When I uncheck "<label>"`, `When I press the
"<key>" key`.
- `Then I see "<text>"`, `Then "<name>" shows "<text>"`, `Then the "<name>" dialog
opens`, `Then the "<name>" menu opens`.
- `# as <role>` where the journey changes hands (signing in or out).
  `Given I am signed in as the "<role>"` plays first the journey that makes a visitor
  that role.
- Names are what the screen reads, exactly: a button's text, a field's label.

Each page needs a `page.tree.yml`. When the app can run, `pom snapshot` writes it (step 3).
When it cannot yet, write a short one by hand: the controls the journeys use, under
the landmarks they sit in.

```yaml
- main:
    - heading "Sign up" [level=1]
    - textbox "Email"
    - button "Create account"
```

## 3. Check, then picture

- With the app running (`baseURL` or `webServer` in `pom.config.ts`):
  `npx pomspec snapshot <path>…` writes the trees of the pages the journeys visit, the
  visitor's first; then `--as <role>` for pages behind a sign-in (it signs in through
  the journey that makes that role, so that journey must check first). Look at the
  pictures it names, and find what you see in the outline beside each: every node
  says where it is on the screen (`[box=x,y,width,height]`).
- `npx pomspec check` until every line finds its control.
- `npx pomspec shots` pictures every journey. Look at the pictures it names: they are
  what people see.
- `npx pomspec map` lists pages no journey visits yet: write journeys for those that
  matter, and snapshot their pages.

Stop when the main flows have journeys and `pom check` passes. Do not commit: tell the
person what you wrote and which pages have no journey yet.
