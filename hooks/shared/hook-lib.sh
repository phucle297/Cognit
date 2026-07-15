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


# Build actor display/storage name: <model>+<hash6>
#
# Model detection order (no manual export required for normal use):
#   1. Hook JSON fields (.model / .model_id / …) when the host provides them
#   2. Last assistant `message.model` in transcript_path (Claude Code truth)
#   3. Host env (Claude settings often set ANTHROPIC_MODEL=GLM-5.2 etc.)
#   4. tool_default family (claude|gemini|codex|opencode)
#
# hash: last 6 chars of Cognit session ULID (stable per session).
#
# Usage: cognits_actor_name <session_ulid> <tool_default> [hook_json]

# Pretty-compact model label for storage/display.
cognits_format_model() {
  local model="$1"
  # keep alnum . _ - ( ) space; collapse spaces to -
  printf '%s' "$model" \
    | tr -d '\n\r' \
    | sed 's/+/ /g; s/[^A-Za-z0-9._() -]//g; s/  */ /g; s/^ //; s/ $//' \
    | tr ' ' '-' \
    | cut -c1-48
}

# Read most recent model from a Claude-style JSONL transcript.
# Lines look like: {"type":"assistant","message":{"model":"glm-5.2",...},...}
cognits_model_from_transcript() {
  local path="$1"
  [[ -n "$path" && -f "$path" ]] || return 1
  # Last matching assistant model in the tail (recent turns only).
  tail -n 200 "$path" 2>/dev/null \
    | jq -r 'select(type=="object")
        | (.message.model // .model // empty)
        | select(type=="string" and length>0)' 2>/dev/null \
    | tail -n 1
}

cognits_detect_model() {
  local tool_default="${1:-agent}"
  local json="${2:-}"
  local model="" tp

  # 1) Explicit override (optional; not required for normal use)
  model="${COGNIT_MODEL:-}"

  # 2) Hook JSON body
  if [[ -z "$model" && -n "$json" ]] && command -v jq >/dev/null 2>&1; then
    model="$(jq -r '
      .model // .model_id // .modelName // .model_name //
      .agent.model // .llm.model // .payload.model // empty
    ' <<<"$json" 2>/dev/null || true)"
    [[ "$model" == "null" ]] && model=""
  fi

  # 3) Claude Code transcript_path → last assistant model (ground truth)
  if [[ -z "$model" && -n "$json" ]] && command -v jq >/dev/null 2>&1; then
    tp="$(jq -r '.transcript_path // empty' <<<"$json" 2>/dev/null || true)"
    if [[ -n "$tp" && "$tp" != "null" ]]; then
      model="$(cognits_model_from_transcript "$tp" || true)"
    fi
  fi

  # 4) Host env injected by the agent runtime / settings.json
  if [[ -z "$model" ]]; then model="${ANTHROPIC_MODEL:-}"; fi
  if [[ -z "$model" ]]; then model="${CLAUDE_MODEL:-}"; fi
  if [[ -z "$model" ]]; then model="${ANTHROPIC_DEFAULT_SONNET_MODEL:-}"; fi
  if [[ -z "$model" ]]; then model="${ANTHROPIC_DEFAULT_OPUS_MODEL:-}"; fi
  if [[ -z "$model" ]]; then model="${ANTHROPIC_DEFAULT_HAIKU_MODEL:-}"; fi
  if [[ -z "$model" ]]; then model="${CLAUDE_CODE_SUBAGENT_MODEL:-}"; fi
  if [[ -z "$model" ]]; then model="${GEMINI_MODEL:-}"; fi
  if [[ -z "$model" ]]; then model="${OPENAI_MODEL:-}"; fi
  if [[ -z "$model" ]]; then model="${LITELLM_MODEL:-}"; fi
  if [[ -z "$model" ]]; then model="${XAI_MODEL:-}"; fi
  if [[ -z "$model" ]]; then model="${GROK_MODEL:-}"; fi

  if [[ -z "$model" || "$model" == "null" ]]; then
    model="$tool_default"
  fi
  cognits_format_model "$model"
}

cognits_actor_name() {
  local session="$1"
  local tool_default="${2:-agent}"
  local json="${3:-}"
  local short hash

  if ! cognits_is_ulid "$session"; then
    hash="000000"
  else
    hash="${session: -6}"
  fi

  short="$(cognits_detect_model "$tool_default" "$json")"
  [[ -z "$short" ]] && short="$tool_default"

  printf '%s+%s' "$short" "$hash"
}
