#!/usr/bin/env bash
# Focused, allocation-free Vercel execution contract tests.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
node --test "$ROOT/tests/vercel.test.mjs"
