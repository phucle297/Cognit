# hooks/shared/hook-lib.sh — sourced by every shell producer.
# Installed as ~/.cognit/hooks/hook-lib.sh next to cc-post.sh etc.
#
# Provides:
#   cognits_hook_dir   absolute dir of this installed hook set
#   cognits_ulid       mint a 26-char Crockford ULID (stdout, no newline)
#   cognits_session_id resolve/bind sticky Cognit session id for this project

# shellcheck shell=bash

cognits_hook_dir() {
  # Directory that holds ulid.mjs (same dir as this lib, or caller dir).
  local here src d
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "$here/ulid.mjs" ]]; then
    printf '%s' "$here"
    return 0
  fi
  src="${BASH_SOURCE[1]:-${BASH_SOURCE[0]}}"
  d="$(cd "$(dirname "$src")" && pwd)"
  if [[ -f "$d/ulid.mjs" ]]; then
    printf '%s' "$d"
    return 0
  fi
  if [[ -f "$d/../shared/ulid.mjs" ]]; then
    cd "$d/../shared" && pwd
    return 0
  fi
  printf '%s' "$here"
}

cognits_ulid() {
  local dir
  dir="$(cognits_hook_dir)"
  local helper="$dir/ulid.mjs"
  if [[ -f "$helper" ]]; then
    # Prefer pure helper (no npm). Fail loudly if node is broken.
    node "$helper" && return 0
  fi
  # Last resort: try npm ulid if present on NODE_PATH / cwd.
  if node -e 'process.stdout.write(require("ulid")())' 2>/dev/null; then
    return 0
  fi
  # Inline pure Crockford (duplicate of ulid.mjs) so a missing file
  # still never emits a short fake id.
  node -e '
const E="0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const {randomBytes}=require("crypto");
let t=Date.now(),out="";
for(let i=0;i<10;i++){out=E[t%32]+out;t=Math.floor(t/32);}
const b=randomBytes(16);for(let i=0;i<16;i++)out+=E[b[i]&31];
process.stdout.write(out);
'
}

# Valid Crockford ULID shape (26 chars).
cognits_is_ulid() {
  [[ "$1" =~ ^[0-9A-HJKMNP-TV-Z]{26}$ ]]
}

# Resolve session id for inbox envelopes:
#   1. $COGNIT_SESSION_ID
#   2. ./.cognit/current-session (valid ULID only)
#   3. mint new ULID, write sticky pointer, use it
#
# Writes the sticky pointer so a burst of hooks collapses onto one
# session id; SessionService.ingest lazy-creates the DB row on drain.
cognits_session_id() {
  local s="${COGNIT_SESSION_ID:-}"
  if cognits_is_ulid "$s"; then
    printf '%s' "$s"
    return 0
  fi
  if [[ -f ./.cognit/current-session ]]; then
    s="$(tr -d '[:space:]' < ./.cognit/current-session || true)"
    if cognits_is_ulid "$s"; then
      printf '%s' "$s"
      return 0
    fi
  fi
  s="$(cognits_ulid)"
  mkdir -p ./.cognit
  # Atomic-ish write: tmp + mv
  local tmp="./.cognit/current-session.tmp.$$"
  printf '%s' "$s" > "$tmp"
  mv -f "$tmp" ./.cognit/current-session
  printf '%s' "$s"
}
