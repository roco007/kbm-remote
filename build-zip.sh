#!/bin/bash
# Build a lean repository zip: tracked git files + clean untracked source files,
# excluding node_modules, dist artifacts, and task-state notes.
set -e
cd /home/ubuntu/kbm-repo
rm -f /home/ubuntu/kbm-remote.zip
{
  git ls-files | grep -v '^TASK-STATE-'
  git ls-files --others --exclude-standard | grep -v node_modules | grep -v '/dist/' | grep -v '\.tsbuildinfo' | grep -v '^TASK-STATE-'
} | zip -q /home/ubuntu/kbm-remote.zip -@
ls -lh /home/ubuntu/kbm-remote.zip
unzip -l /home/ubuntu/kbm-remote.zip | tail -2
