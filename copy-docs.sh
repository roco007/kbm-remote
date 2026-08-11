#!/usr/bin/env bash
# Copies the finalized design documents into docs/ of the scaffolded repo.
set -euo pipefail
cd "$(dirname "$0")"
SRC=/home/ubuntu/kbm-remote
mkdir -p docs
cp "$SRC/Architecture-Design-Document.md" docs/
cp "$SRC/Technology-Evaluation-Report.md" docs/
cp "$SRC/UX-Design-Document.md" docs/
cp "$SRC/Protocol-Documentation.md" docs/
mkdir -p docs/diagrams
cp "$SRC/diagrams/architecture.png" "$SRC/diagrams/pairing.png" \
   "$SRC/diagrams/input_flow.png" "$SRC/diagrams/discovery.png" docs/diagrams/
cp -r "$SRC/ux-design" docs/ux-design 2>/dev/null || true
ls -R docs | head -40
