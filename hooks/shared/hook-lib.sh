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
    tp="$(jq -r '.transcript_path // .transcriptPath // empty' <<<"$json" 2>/dev/null || true)"
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

# ---------------------------------------------------------------------------
# Host CLI detection (CLI-agnostic source labeling)
# ---------------------------------------------------------------------------
#
# Supported hosts (minimum bar): claude-code, codex, grok.
# Also: gemini-cli, opencode (env/plugin), generic "agent".
#
# cognits_detect_host [hook_json] [fallback_host]
#   prints: <host_id>\t<hook_command>
#   e.g.    grok	PostToolUse
#
# cognits_normalize_hook_event <raw>
#   post_tool_use / PostToolUse / preToolUse → PostToolUse / PreToolUse / …

cognits_normalize_hook_event() {
  local raw="${1:-}"
  local key
  key="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
  case "$key" in
    posttooluse|posttool)                               printf '%s' "PostToolUse" ;;
    aftertool|aftertoolexecution)                        printf '%s' "AfterTool" ;;
    pretooluse|pretool|beforetool)                     printf '%s' "PreToolUse" ;;
    posttoolusefailure)                                printf '%s' "PostToolUseFailure" ;;
    sessionstart)                                      printf '%s' "SessionStart" ;;
    sessionend)                                        printf '%s' "SessionEnd" ;;
    userpromptsubmit)                                  printf '%s' "UserPromptSubmit" ;;
    stop)                                              printf '%s' "Stop" ;;
    *)
      # Empty raw → empty (caller supplies host-specific default).
      if [[ -n "$raw" ]]; then printf '%s' "$raw"
      else printf '%s' ""
      fi
      ;;
  esac
}

# Map host id → default actor family label (before model detection).
cognits_host_actor_default() {
  case "${1:-agent}" in
    claude-code|claude) printf '%s' "claude" ;;
    grok|grok-build)    printf '%s' "grok" ;;
    codex)              printf '%s' "codex" ;;
    gemini-cli|gemini)  printf '%s' "gemini" ;;
    opencode)           printf '%s' "opencode" ;;
    cursor)             printf '%s' "cursor" ;;
    *)                  printf '%s' "${1:-agent}" ;;
  esac
}

cognits_detect_host() {
  local json="${1:-}"
  local fallback="${2:-agent}"
  local host="" raw_event="" event=""
  local has_camel has_snake transcript

  # 1) Explicit env from host runtimes (highest confidence)
  if [[ -n "${GROK_HOOK_EVENT:-}" || -n "${GROK_HOOK_NAME:-}" || -n "${GROK_WORKSPACE_ROOT:-}" ]]; then
    host="grok"
    raw_event="${GROK_HOOK_EVENT:-}"
  fi

  # 2) JSON body signals
  if [[ -n "$json" ]] && command -v jq >/dev/null 2>&1; then
    if [[ -z "$raw_event" ]]; then
      raw_event="$(jq -r '
        .hook_event_name // .hookEventName // .event // .event_name // empty
      ' <<<"$json" 2>/dev/null || true)"
      [[ "$raw_event" == "null" ]] && raw_event=""
    fi

    if [[ -z "$host" ]]; then
      has_camel="$(jq -r 'if has("toolName") or has("hookEventName") or has("toolInput") or has("toolResult") or has("transcriptPath") then "1" else "0" end' <<<"$json" 2>/dev/null || echo 0)"
      has_snake="$(jq -r 'if has("tool_name") or has("hook_event_name") or has("tool_input") or has("tool_response") or has("transcript_path") then "1" else "0" end' <<<"$json" 2>/dev/null || echo 0)"
      transcript="$(jq -r '.transcript_path // .transcriptPath // empty' <<<"$json" 2>/dev/null || true)"

      if [[ "$has_camel" == "1" && "$has_snake" != "1" ]]; then
        if [[ "$transcript" == *".grok/"* ]]; then
          host="grok"
        elif [[ -n "${CURSOR_TRACE_ID:-}" || "$transcript" == *".cursor/"* ]]; then
          host="cursor"
        else
          host="grok"
        fi
      elif [[ "$has_snake" == "1" ]]; then
        if [[ "$fallback" == "codex" || "$fallback" == "gemini-cli" || "$fallback" == "gemini" ]]; then
          host="$fallback"
        else
          host="claude-code"
        fi
      fi
    fi
  fi

  # 3) Fallback from caller (script knows which installer wired it)
  if [[ -z "$host" ]]; then
    host="$fallback"
  fi
  case "$host" in
    claude|cc) host="claude-code" ;;
    grok-build|grokbuild) host="grok" ;;
    gemini) host="gemini-cli" ;;
  esac

  event="$(cognits_normalize_hook_event "$raw_event")"
  printf '%s|%s' "$host" "$event"
}

# ---------------------------------------------------------------------------
# Tool-field extraction (Claude snake_case + Grok camelCase + peers)
# ---------------------------------------------------------------------------

# Optional debug dump when COGNIT_HOOK_DEBUG=1.
cognits_hook_debug_dump() {
  local json="${1:-}"
  [[ "${COGNIT_HOOK_DEBUG:-0}" == "1" ]] || return 0
  mkdir -p ./.cognit/debug 2>/dev/null || return 0
  printf '%s' "$json" > ./.cognit/debug/last-hook-stdin.json 2>/dev/null || true
  {
    printf 'len=%s keys=' "${#json}"
    printf '%s' "$json" | jq -c 'if type=="object" then keys else type end' 2>/dev/null \
      || echo "no-json"
  } >> ./.cognit/debug/last-hook-meta.txt 2>/dev/null || true
}

# Recover tool name from Claude transcript when hook JSON lacks tool_name.
cognits_tool_from_transcript() {
  local json="$1"
  local tp id name
  [[ -n "$json" ]] || return 1
  command -v jq >/dev/null 2>&1 || return 1
  tp="$(jq -r '.transcript_path // .transcriptPath // empty' <<<"$json" 2>/dev/null || true)"
  id="$(jq -r '.tool_use_id // .toolUseId // empty' <<<"$json" 2>/dev/null || true)"
  [[ -n "$tp" && -f "$tp" && -n "$id" && "$id" != "null" ]] || return 1
  name="$(
    tail -n 400 "$tp" 2>/dev/null \
      | jq -r --arg id "$id" '
          select(type=="object")
          | (.message.content // empty)
          | if type=="array" then .[] else empty end
          | select(type=="object" and .type=="tool_use" and .id==$id)
          | .name // empty
        ' 2>/dev/null \
      | tail -n 1
  )"
  [[ -n "$name" && "$name" != "null" ]] || return 1
  printf '%s' "$name"
}

# Parse tool fields from host hook JSON.
# Args: <hook_json> [pre|post]
# Prints compact JSON:
#   {tool, tool_input, tool_response, file_path, command, text, tool_use_id}
#
# Multi-path:
#   Claude Code: tool_name / tool_input / tool_response (snake_case)
#   Grok Build:  toolName / toolInput / toolResult (camelCase)
#   Codex/etc:   name / arguments
# Large strings/arrays truncated so envelopes stay under shell limits.
cognits_tool_fields_json() {
  local json="${1:-}"
  local phase="${2:-post}"
  local fields recovered tool

  if [[ -z "$json" ]] || ! command -v jq >/dev/null 2>&1; then
    if [[ "$phase" == "pre" ]]; then
      printf '%s' '{"tool":"unknown","tool_input":{},"tool_response":null,"file_path":"","command":"","text":"agent intends to invoke unknown","tool_use_id":""}'
    else
      printf '%s' '{"tool":"unknown","tool_input":{},"tool_response":null,"file_path":"","command":"","text":"tool unknown returned","tool_use_id":""}'
    fi
    return 0
  fi

  # NOTE: never use `select` + `as $var` — empty select kills the whole jq stream.
  fields="$(
    jq -c --arg phase "$phase" '
      def trunc:
        if type == "string" then
          if length > 800 then .[0:800] + "…" else . end
        elif type == "object" then
          with_entries(.value |= trunc)
        elif type == "array" then
          if length > 40 then (.[0:40] | map(trunc)) + ["…"] else map(trunc) end
        else . end;

      def str_or_empty:
        if type == "string" and length > 0 and . != "null" then . else "" end;

      def tool_name:
        (.tool_name // .toolName // .name // .tool // .function_name // .functionName // "unknown")
        | if type == "string" and length > 0 and . != "null" then . else "unknown" end;

      def tool_in:
        .tool_input // .toolInput // .arguments // .input // .parameters // {};

      def tool_out:
        .tool_response // .toolResponse // .tool_output // .toolOutput // .toolResult // .response // .output // null;

      def path_of:
        (.file_path // .filePath // .path // .target_file // .targetFile
         // .notebook_path // .notebookPath // "")
        | str_or_empty;

      def cmd_of:
        (.command // .cmd // "")
        | str_or_empty;

      (tool_name) as $tool
      | (tool_in) as $raw_in
      | (if ($raw_in | type) == "object" or ($raw_in | type) == "array" then $raw_in else {} end) as $in
      | (tool_out) as $raw_out
      | (($in | path_of)
          // (if ($raw_out | type) == "object" then ($raw_out | path_of) else "" end)
          // "") as $path
      | (($in | cmd_of) // "") as $cmd
      | (
          if $phase == "pre" then
            if $path != "" then "agent intends to \($tool) \($path)"
            elif $cmd != "" then "agent intends to \($tool): \($cmd[0:200])"
            else "agent intends to invoke \($tool)"
            end
          else
            if $path != "" then "tool \($tool) → \($path)"
            elif $cmd != "" then "tool \($tool): \($cmd[0:200])"
            else "tool \($tool) returned"
            end
          end
        ) as $text
      | {
          tool: $tool,
          tool_input: ($in | trunc),
          tool_response: (if $raw_out == null then null else ($raw_out | trunc) end),
          file_path: $path,
          command: $cmd,
          text: $text,
          tool_use_id: ((.tool_use_id // .toolUseId // "") | tostring)
        }
    ' <<<"$json" 2>/dev/null || true
  )"

  if [[ -z "$fields" ]]; then
    if [[ "$phase" == "pre" ]]; then
      printf '%s' '{"tool":"unknown","tool_input":{},"tool_response":null,"file_path":"","command":"","text":"agent intends to invoke unknown","tool_use_id":""}'
    else
      printf '%s' '{"tool":"unknown","tool_input":{},"tool_response":null,"file_path":"","command":"","text":"tool unknown returned","tool_use_id":""}'
    fi
    return 0
  fi

  tool="$(jq -r '.tool // "unknown"' <<<"$fields" 2>/dev/null || echo unknown)"
  if [[ "$tool" == "unknown" || -z "$tool" || "$tool" == "null" ]]; then
    recovered="$(cognits_tool_from_transcript "$json" || true)"
    if [[ -n "$recovered" ]]; then
      fields="$(
        jq -c --arg t "$recovered" --arg phase "$phase" '
          .tool = $t
          | .text = (
              if $phase == "pre" then
                if .file_path != "" then "agent intends to \($t) \(.file_path)"
                elif .command != "" then "agent intends to \($t): \(.command[0:200])"
                else "agent intends to invoke \($t)"
                end
              else
                if .file_path != "" then "tool \($t) → \(.file_path)"
                elif .command != "" then "tool \($t): \(.command[0:200])"
                else "tool \($t) returned"
                end
              end
            )
        ' <<<"$fields"
      )"
    fi
  fi

  printf '%s' "$fields"
}

cognits_atomic_write_json() {
  local dest="$1"
  local payload="$2"
  local payload_file
  payload_file="$(mktemp "${dest}.payload.XXXXXX")"
  printf '%s' "$payload" > "$payload_file"
  python3 - "$dest" "$payload_file" <<'PY'
import os, sys
path, payload_path = sys.argv[1], sys.argv[2]
with open(payload_path, "rb") as f:
    data = f.read()
try:
    os.unlink(payload_path)
except OSError:
    pass
tmp = path + ".tmp"
fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
try:
    os.write(fd, data)
    os.fsync(fd)
finally:
    os.close(fd)
os.rename(tmp, path)
PY
}
