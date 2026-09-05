#!/usr/bin/env bash
# pi-update.sh — periodic pi maintenance.
#
# Steps:
#   1. pi update --self       — update the pi CLI itself
#   2. pi update --extensions — update pi packages (declared in settings.json, installed in npm/)
#   3. git pull --ff-only     — pull this config repo
#
# If there are local changes in tracked files (e.g. settings.json tweaks), the
# script shows git status + diff and asks:
#   [d]iscard  — restore tracked files from the repo, then pull
#   [k]eep     — keep local changes, skip the pull (pi updates still run)
#   [a]bort    — stop without doing anything further

set -uo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

BOLD=$'\033[1m'
GREEN=$'\033[32m'
RED=$'\033[31m'
DIM=$'\033[2m'
RESET=$'\033[0m'

step() { printf '\n%s== %s ==%s\n' "$BOLD" "$*" "$RESET"; }
ok()   { printf '%sOK%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%sWARN%s %s\n' "$RED" "$RESET" "$*"; }

fail=0

run_step() { # run_step <label> <cmd...>
  local label="$1"
  shift
  step "$label"
  if "$@"; then
    ok "$label"
  else
    warn "$label FAILED"
    fail=1
  fi
}

# --- 0. sanity -------------------------------------------------------------
if ! command -v pi >/dev/null 2>&1; then
  warn "pi not found on PATH — is it installed?"
  fail=1
fi
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  warn "not a git repository: $REPO_DIR"
  exit 1
fi

echo "Repo: $REPO_DIR"

# --- 1. update pi itself --------------------------------------------------
run_step "Updating pi itself" pi update --self

# --- 2. update extensions (pi packages) ------------------------------------
run_step "Updating extensions (pi packages)" pi update --extensions

# --- 3. local changes in tracked files -------------------------------------
skip_pull=0
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo
  echo "Local changes detected in tracked files:"
  git status --short --untracked-files=no
  echo
  git diff --stat
  echo
  git diff
  git diff --cached
  echo
  printf 'Discard local changes and overwrite from repo, then pull?\n'
  printf '  [d]iscard  [k]eep (skip pull)  [a]bort [a]: '
  read -r answer
  case "${answer:-a}" in
    d|D)
      step "Discarding local changes (restoring tracked files from HEAD)"
      if git restore --staged --worktree .; then
        ok "local changes discarded"
      else
        warn "could not discard local changes — skipping pull"
        skip_pull=1
      fi
      ;;
    k|K)
      echo "Keeping local changes; skipping git pull."
      skip_pull=1
      ;;
    *)
      echo "Aborted — skipping git pull, local changes left as-is."
      exit 1
      ;;
  esac
else
  echo "No local changes in tracked files."
fi

# --- 4. pull the config repo ----------------------------------------------
if [ "$skip_pull" -eq 1 ]; then
  echo "Skipping git pull."
else
  run_step "Pulling config repo" git pull --ff-only
fi

# --- 5. final status --------------------------------------------------------
echo
step "Final status"
git status --short || true
if [ "$fail" -ne 0 ]; then
  echo
  warn "Some steps failed (see above)."
  exit 1
fi
echo
ok "All done."
