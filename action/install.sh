#!/usr/bin/env bash
# A checkout's dependencies, as its lockfile says: pnpm, yarn (classic or berry) or npm,
# run in the folder named. pom's GitHub Action installs each side's checkout with it.
set -euo pipefail
cd "$1"
if [ -f pnpm-lock.yaml ]; then
  corepack enable >/dev/null 2>&1 || npm install -g pnpm
  pnpm install --frozen-lockfile
elif [ -f yarn.lock ]; then
  corepack enable >/dev/null 2>&1 || npm install -g yarn
  if [ -f .yarnrc.yml ]; then yarn install --immutable; else yarn install --frozen-lockfile; fi
elif [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi
