#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
command -v node >/dev/null || { echo 'Install Node.js 24.9+ first.'; exit 1; }
if [[ ! -d node_modules ]]; then
  echo 'Downloading project-local dependencies; no model weights.'
  npm ci --ignore-scripts
fi
if [[ ! -x .venv/bin/python ]]; then
  echo 'Creating the isolated project Python environment.'
  npm run setup
fi
npm run build
npm start
