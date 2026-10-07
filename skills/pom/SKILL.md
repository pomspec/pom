---
name: pom
description: Keep a pomspec spec of a web app — journeys in Gherkin, pictured and recorded by pom — and show what changed in pull requests. Use when writing or changing an app's user-facing flows, mapping an app into journeys, or preparing a pull request.
---

# pom: journeys, pictured

pom keeps a spec of the app beside its code: journeys (`spec/**/*.feature`) that
people read, checked against the pages, pictured at every width and recorded. Pictures
live in `.pom/` and on pull requests.

## Map an app into journeys

Follow `map-repo.md` (beside this file): find the routes, roles and flows; write
`spec/` in pomspec's grammar; `npx pomspec snapshot <path>` for each page's tree;
`npx pomspec check`; `npx pomspec shots`; `npx pomspec map` for the pages no journey
visits yet.

## For each change

1. **Define:** write or change the journey first (`.feature`), in pom's grammar.
2. **Build** the change.
3. `npx pomspec check`: every line finds its control.
4. `npx pomspec shots`: every journey at every width. Read the pictures it lists (and
   `.pom/shots/…/<journey>/<width>/<moment>.png`): check them as a person would.
5. `npx pomspec diff`: what changed against the base branch, in pictures
   (`.pom/diff/diff.html`, and the changed checkpoints it names).
6. `npx pomspec pr`: the pull request's before and after, and its videos, in its
   description (with the person's own `gh`).

Never change a journey only to make a check pass: change it when what is meant changes.
