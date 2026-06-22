# Cognit — Hướng dẫn sử dụng

> **Git cho nhận thức AI.**
> Code có Git. Task có Jira. AI có Cognit.

Cognit ghi lại những gì worker AI **học**, **thử**, **bác bỏ**, **xác minh**, và **kết luận** trong quá trình kỹ thuật. Trạng thái là vĩnh viễn. Worker là tạm thời. **Bạn không tự chạy điều tra** — **AI supervisor** đảm nhiệm việc sinh giả thuyết, xếp hạng, và xác minh. Bạn cung cấp quan sát, chạy supervisor, và lái khi cần.

---

## 1. Cognit là gì (và không phải là gì)

| Cognit là | Cognit **không** phải là |
| --- | --- |
| Lớp quyết định bền vững | Cơ sở dữ liệu lịch sử chat |
| Đồ thị tri thức có kiểu | Framework agent |
| Kho sự kiện điều tra | Workflow engine |
| Hộp thư worker-agnostic | Công cụ backup |
| **Vòng lặp do AI-supervisor điều khiển** | Công cụ gõ giả thuyết thủ công |

Supervisor (một worker AI) đọc trạng thái session, suy luận, phát ra sự kiện có cấu trúc. **Bạn** không gõ giả thuyết — AI làm. **Bạn** xem lại kết quả và lái khi AI lệch hướng.

---

## 2. Cài đặt

Yêu cầu: **Node.js 24 LTS**, **pnpm 9**, **git**.

```bash
pnpm install
pnpm build
pnpm link --global
```

Kiểm tra:

```bash
cognit --version
cognit agent --help    # xác nhận subcommand supervisor đã nối
```

> Mẹo: workspace exec cũng chạy được. Từ repo root: `pnpm exec cognit <subcommand>`.

---

## 3. Khởi tạo trong repo

Trong repo bạn muốn Cognit theo dõi:

```bash
cd your-project
cognit init
```

Tạo ra:

```text
.cognit/
├─ cognit.db      # SQLite store (nguồn sự thật)
├─ cognit.yaml    # cấu hình project
├─ .gitignore     # quy tắc ignore cho store
├─ inbox/         # vùng thả sự kiện từ worker AI
├─ artifacts/     # bằng chứng (log, diff, screenshot)
├─ snapshots/     # checkpoint replay
└─ archive/       # artifact sau khi gc
```

Nối vào `.gitignore` của repo:

```gitignore
.cognit/cognit.db
.cognit/inbox/
.cognit/snapshots/
.cognit/archive/
.cognit/.gitignore
```

Commit `cognit.yaml` (cấu hình của bạn). Commit artifact đã chọn lọc nếu muốn share. **Không** commit `cognit.db` — state chỉ cục bộ.

---

## 4. Luồng AI-supervisor (chuẩn)

Vòng lặp chuẩn là **observation vào, AI suy luận ra**. Bạn chụp quan sát, supervisor đọc state và phát sự kiện có cấu trúc, Gravity xếp hạng theo phán đoán AI, bạn xem lại.

### 4.1 Tạo session

```bash
cognit session create "Fix Next.js memory leak"
```

In session id (ULID). Dùng `--session <id>` cho chính xác sau đó.

### 4.2 Chụp quan sát

Cách 1 — chạy lệnh và wrap:

```bash
cognit wrap -- pnpm run bench:memory
# mỗi dòng stderr → sự kiện observation_recorded
# exit code cuối → verification_passed / verification_failed
```

Cách 2 — ghi trực tiếp:

```bash
cognit observation add "Next.js reaches 18GB VmPeak during local dev"
cognit observation add "Memory growth starts after HMR updates"
```

Observation nằm trong store. Chúng là sự thật thô mà supervisor suy luận trên.

### 4.3 Chạy supervisor

```bash
# mock LLM (không cần API key, canned decisions tất định)
cognit agent run --session <id> --provider mock

# provider thật — set env tương ứng
export ANTHROPIC_API_KEY=...     # anthropic
# hoặc OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_KEY / OLLAMA_BASE_URL
cognit agent run --session <id> --provider anthropic --model claude-sonnet-4-6
cognit agent run --session <id> --provider openai    --model gpt-4o
cognit agent run --session <id> --provider google    --model gemini-2.5-pro
cognit agent run --session <id> --provider ollama    --model llama3.1

# một lượt rồi thoát
cognit agent run --session <id> --once

# bounded run
cognit agent run --session <id> --max-ticks 5 --tick-interval-ms 2000
```

Mỗi tick:

1. Đọc event kể từ cursor.
2. Replay state qua reducer.
3. Dựng prompt (cap 50 giả thuyết mặc định).
4. Gọi LLM, parse JSON vào schema `AgentDecision`.
5. Áp quyết định (tối đa 5 action mỗi tick mặc định).
6. Phát sự kiện `hypothesis_ranked` mà Gravity Engine tiêu thụ.

SIGINT bật cờ loop kiểm tra giữa tick; SIGINT lần hai thoát cứng.

### 4.4 Giám sát từ terminal khác

```bash
cognit agent status --session <id>   # đang chạy, tick count, last tick id
cognit agent stop   --session <id>   # idempotent
```

### 4.5 Gravity xếp hạng theo điểm AI

Khi supervisor phát `hypothesis_ranked`, **Gravity Engine** (v1.2.0) đọc điểm AI và dùng làm xếp hạng chính thức. Điểm rule-based 5 trục (evidence + reproducibility + confidence + actor trust + freshness decay) trở thành **fallback** cho giả thuyết AI chưa chấm.

Mỗi `RankedHypothesis` mang `source: "ai" | "rule"` để bạn biết đường nào đã tạo điểm.

### 4.6 Xem recovery surface

```bash
# v0.2 recovery envelope đầy đủ cho một session
cognit recovery <session-id>

# tìm mờ qua nhiều session
cognit recovery search "memory leak"

# đầu ra reducer thô
cognit session show <id-or-goal>

# live-tail các lần rank
cognit events --type hypothesis_ranked --follow
```

### 4.7 Lái vòng lặp

Khi giả thuyết top sai, hoặc bạn muốn AI nhìn chỗ khác:

- **Gửi observation mới** để xô AI.
- **Bác bỏ chọn lựa của AI** bằng cách tự phát `hypothesis_rejected` (CLI thủ công ở đây là công cụ debug, không phải luồng chính).

---

## 5. CLI thủ công — fallback debug

Lệnh CLI trực tiếp vẫn còn. Dùng để xem, vá, hoặc gieo state — không phải luồng chính.

```bash
# gieo theory / hypothesis thủ công để test
cognit theory add "HMR resource retention"
cognit hypothesis add "Turbopack cache is leaking memory" \
  --belongs-to "HMR resource retention" --confidence 0.7

# chạy experiment thủ công
cognit experiment add "Disable Turbopack and measure memory growth" \
  --tests "Turbopack cache is leaking memory"
cognit experiment complete \
  --result "Memory still increases after disabling Turbopack" \
  --contradicts "Turbopack cache is leaking memory"

# bác bỏ giả thuyết với lý do có kiểu
cognit hypothesis reject "Turbopack cache is leaking memory" \
  --reason "Disabling Turbopack did not stop memory growth" \
  --reason-type evidence
```

Dùng cho debug một lần. AI supervisor là người viết chính các sự kiện này.

---

## 6. Nối AI worker tùy biến vào Cognit

Nếu không muốn dùng `cognit agent run` có sẵn, bạn có thể tự chạy LLM và feed event vào inbox. Hợp đồng supervisor là sự kiện `hypothesis_ranked`.

### 6.1 Shim `cognit wrap`

Wrap bất kỳ lệnh nào. Dòng stderr → `observation_recorded`. Exit code → `verification_passed` / `_failed` / `_errored`.

```bash
cognit wrap -- claude-code --print "Investigate the memory leak"
cognit wrap -- pnpm test
cognit wrap -- ./scripts/smoke.sh
```

Chụp tool call, exit code, stderr. Helper atomic-write (`packages/wrap/src/atomic-write.ts`) chặn partial file.

### 6.2 Hook Claude Code

Trong `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": "cognit observation add",
    "PreToolUse":  "cognit hypothesis add"
  }
}
```

### 6.3 Worker inbox adapter (mọi AI tool)

Bất kỳ worker nào phát sự kiện bằng cách ghi file JSON vào `.cognit/inbox/`. Watcher (chokidar) validate schema, redact secret, append vào store qua ranh giới duy nhất `appendEvent`.

**Giao thức ghi nguyên tử** (bắt buộc — partial write bị bỏ):

```bash
cat > event.json.tmp <<'JSON'
{
  "schema_version": "1.2.0",
  "type": "hypothesis_ranked",
  "session_id": "01HXY...",
  "actor": { "type": "worker", "name": "ai-supervisor" },
  "source": { "tool": "ai-supervisor", "command": "tick-3" },
  "payload": {
    "hypothesis_id": "01HXY...",
    "score": 0.82,
    "reasoning": "Strongest reproducer; matches 3 supporting findings; recently verified.",
    "evaluator": "ai-supervisor",
    "override_rule_based": true,
    "context_event_ids": ["01HXY...", "01HXY..."]
  }
}
JSON
sync
mv event.json.tmp event.json
```

Actor lạ tự đăng ký với trust score mặc định từ `cognit.yaml`. Đưa `ai-supervisor` vào `actors.known` để có trust score cao hơn.

### 6.4 Schema payload `hypothesis_ranked` (v1.2.0)

```ts
{
  hypothesis_id: string,                   // required, non-empty
  score: number,                            // required, [0, 1]
  reasoning: string,                        // required, non-empty
  evaluator: "ai-supervisor",               // literal — hiện chỉ supervisor phát
  override_rule_based: boolean,             // true = AI thắng, false = chỉ fallback
  context_event_ids?: string[],             // tuỳ chọn, các sự kiện trước AI đã thấy
}
```

Reducer áp điểm AI cho giả thuyết mục tiêu. `linked_hypothesis_id` **không** dùng (FK đó dành cho verification). Điểm được clamp về `[0, 1]`; giá trị không hữu hạn rơi về rule-based.

---

## 7. Khái niệm cốt lõi trên một màn hình

| Khái niệm | Là gì |
| --- | --- |
| **Project** | Một cho mỗi repo (mỗi `.cognit/`). |
| **Session** | Một cuộc điều tra / mục tiêu kỹ thuật. Fork được từ session trước qua `cognit session resume`. |
| **Actor** | Nguồn sự kiện: `human`, `worker` (Claude Code, Codex, OpenCode, Gemini CLI, `ai-supervisor`, …), hoặc `system`. Mỗi actor có trust score. |
| **Observation** | Sự thật thô — chụp bởi `cognit wrap` hoặc `cognit observation add`. |
| **Finding** | Diễn giải của một hoặc nhiều observation. |
| **Hypothesis** | Khẳng định có thể kiểm chứng. Vòng đời: `active → weakened \| rejected \| promoted`. Bác bỏ mang `reason_type`: `evidence \| superseded \| constraint`. Mang `ai_rank_score` tuỳ chọn (v1.2.0). |
| **Theory** | Nhóm các giả thuyết liên quan. Hạng nhất — merge hoặc archive được. |
| **Experiment** | Một bài kiểm thử. Luôn liên kết qua cạnh `tests` tới giả thuyết mà nó kiểm tra. |
| **Conclusion** | Khẳng định đã xác minh. Phải có ít nhất một verification `passed`. |
| **Decision** | Cam kết hành động, `based_on` một hoặc nhiều conclusion. |
| **Verification** | Lần chạy lệnh lặp lại được (build, test, lint, typecheck, benchmark, custom). Vòng đời: `started → passed \| failed \| errored \| cancelled`. |
| **Edge** | Quan hệ có kiểu (`tests`, `supports`, `contradicts`, `supersedes`, `caused`, `based_on`, `belongs_to`, `derived_from`, `references`). |
| **Artifact** | File bằng chứng, định danh bằng sha256 (log terminal, screenshot, diff). |

Đồ thị quan trọng:

```text
Decision ──based_on──▶ Conclusion ──verified_by──▶ Verification
   │
   └──caused──▶ Experiment ──tests──▶ Hypothesis ──ai_rank_score──▶ Ranker
                                              │
                            Experiment ──supports──▶ giả thuyết khác
                            Experiment ──contradicts──▶ nữa
```

---

## 8. Tiếp tục điều tra sau này

```bash
cognit session resume "Fix Next.js memory leak"
```

Mặc định fork session mới. Trả về tóm tắt ngữ cảnh — supervisor AI (hoặc bạn) bắt đầu với bức tranh toàn cục, không cần cuộn chat cũ:

```text
Previous session found (01HXY...).

Goal:
Fix Next.js memory leak

Rejected hypotheses:
- Turbopack cache leak (reason: evidence)
- Production memory leak (reason: evidence)

Verified conclusions:
- Memory leak is in the HMR module graph, not Turbopack (verified by 01HXY...)

Accepted decisions:
- Disable HMR module caching in CI

Suggested next step:
Investigate module graph retention; strongest active hypothesis: "module listener leak"
```

Truyền `--fork=false` để nối cùng session. Truyền `--id <ulid>` khi nhiều session khớp.

Dòng **Suggested next step** là xếp hạng Gravity Engine v0.2 với AI-rank override v1.2.0. Nếu AI đã chấm giả thuyết top, điểm đó thắng; nếu không thì công thức 5 trục.

`cognit recovery search "<query>"` tìm mờ qua goals, findings, hypotheses, decisions, và conclusions để tìm session cũ muốn resume.

---

## 9. Quan sát từ terminal

```bash
# trạng thái session đầy đủ (đầu ra reducer)
cognit session show <id-or-goal>

# live-tail luồng sự kiện
cognit events --session <id> --follow

# lọc theo kiểu — tiện xem supervisor phát gì
cognit events --type hypothesis_ranked --follow
cognit events --type verification_failed --follow

# recovery surface (top hypothesis + decisions + bước tiếp gợi ý)
cognit recovery <session-id>
cognit recovery search "memory leak"

# envelope JSON (kịch bản hóa được)
cognit --json session list
cognit --json events --type hypothesis_ranked --limit 5 | jq '.data[0].payload'
```

`cognit --json <command>` bọc mỗi lệnh trong envelope ổn định `{ version: 1, kind, data }` mà `jq` đọc được.

---

## 10. Dashboard

```bash
cognit dashboard
```

Mở `http://localhost:6970` (mặc định).

| Trang | Hiển thị |
| --- | --- |
| **Overview** | Goal, confidence, tiến độ, giả thuyết mạnh nhất hiện tại, verification mới nhất. |
| **Timeline** | Tiến hóa luồng sự kiện. Lọc theo kiểu và actor. |
| **Knowledge Graph** | Tất cả entity là node, tất cả edge là liên kết. Chuyển layout free / physics. |
| **Decision Graph** | Decision với `based_on` → conclusion và `caused` → experiment. |
| **Verification** | Tất cả verification kèm lịch sử rerun. |
| **Recovery Center** | Giả thuyết bị bác bỏ (kèm lý do), kết luận đã xác minh, quyết định đã chấp nhận, gợi ý bước tiếp. |
| **AI Reasoning** | Live SSE feed sự kiện `hypothesis_ranked`, lịch sử AI rank, decision log. So sánh điểm AI với rule-based cho từng giả thuyết. |
| **Settings** | Cấu hình project, pattern redaction, chính sách cleanup, dung lượng lưu trữ, export/import. |

Port `6970` bận: `--port <n>`. API server chạy riêng trên `6971` (Hono chỉ-đọc trên loopback).

---

## 11. Redaction secret — mặc định đáng tin

Mỗi sự kiện được quét tìm secret **lúc ingest**, trước khi chạm vào store. Pattern có sẵn:

- JWT
- `key=`, `api_key=`, `token=` giá trị nội tuyến
- Khối PEM private-key
- Trường `password=`

Thêm pattern riêng của project trong `cognit.yaml`:

```yaml
redaction:
  enabled: true
  patterns:
    - name: internal_bearer
      regex: "Bearer [A-Za-z0-9._-]{20,}"
      replacement: "Bearer [REDACTED]"
```

Kiểm tra trước khi lưu:

```bash
cognit redaction test "Authorization: Bearer eyJhbGciOi...xyz"
```

> Redaction là ingest, không phải retro. Nếu secret thật đã nằm trong sự kiện cũ, restore từ `cognit export` trước rồi re-import.

---

## 12. Verification — buộc khẳng định phải chứng minh

Verification là một lần chạy có kiểu, lặp lại được.

```bash
# bắt đầu verification
cognit verify --type benchmark --command "pnpm run bench:memory" \
  --tests "Module graph listener leak in HMR"

# kiểm soát vòng đời tường minh (cho runner tùy biến)
cognit verify start --type custom --command "./scripts/smoke.sh"
cognit verify pass --id <verification-id>
cognit verify fail --id <verification-id>

# rerun — lần trước liên kết qua parent_verification_id
cognit verify rerun --parent <verification-id> --command "..." --type test
```

| Trạng thái | Ý nghĩa |
| --- | --- |
| `started` | Đang chạy. |
| `passed` | Exit code 0. |
| `failed` | Exit code ≠ 0. |
| `errored` | Không chạy được (ENOENT, EACCES, EPERM). |
| `cancelled` | SIGINT / SIGTERM. |

`failed` và `errored` khác nhau cố ý — phân biệt "code dưới test gãy" với "harness không chạy được". Output > 1 KB được chụp làm artifact khóa sha256 trong `.cognit/artifacts/`.

---

## 13. Constraint — tự động tỉa giả thuyết

```bash
cognit constraint add --json '{
  "condition": {
    "all": [
      { "event": "experiment_completed", "contradicts_includes": "$h.id" },
      { "entity": "hypothesis", "id": "$h.id", "state": "active" },
      { "entity": "hypothesis", "id": "$h.id", "confidence": { "lt": 0.3 } }
    ]
  },
  "actions": [
    {
      "type": "reject_hypothesis",
      "reason": "Contradicted by experiment and low confidence",
      "reason_type": "constraint"
    }
  ]
}'
```

Rule kích hoạt trên `experiment_completed` và `verification_failed`. Hành động có sẵn: `reject_hypothesis`, `weaken_hypothesis`, `promote_hypothesis`, `create_finding`. Một thí nghiệm phủ định có thể tự động tỉa cả nhánh.

---

## 14. Export, import, chia sẻ

Một session là một bundle di động.

```bash
cognit export --output investigation-2026-06-12.tar.gz --include-artifacts
cognit import --input investigation-2026-06-12.tar.gz --merge-strategy skip
```

Chiến lược merge:

| Chiến lược | Khi xung đột |
| --- | --- |
| `skip` (mặc định) | Giữ cục bộ, bỏ imported. Re-run an toàn. |
| `overwrite` | Thay cục bộ bằng imported. |
| `fork` | Viết lại mọi id imported và remap cột FK. Cả hai bên sống sót. |

Nội dung bundle: `manifest.json`, `cognit.yaml`, `cognit.db`, tuỳ chọn `artifacts/`.

---

## 15. Tham chiếu CLI hằng ngày

```bash
# vòng đời session
cognit session create "goal" [--parent session-id]
cognit session list [--status active|paused|closed]
cognit session resume "goal-or-id" [--fork=true] [--id ulid]
cognit session pause
cognit session close
cognit session show <id-or-goal>
cognit recovery <session-id>
cognit recovery search "<query>"

# observation (input thô cho supervisor)
cognit observe "text" [--session <id>] [--confidence 0..1]
cognit observation add "text"

# AI supervisor
cognit agent run    [--session] [--provider mock|anthropic|openai|google|ollama]
                    [--model] [--once] [--max-ticks N] [--tick-interval-ms N]
cognit agent status [--session]
cognit agent stop   [--session]

# quản lý entity (fallback thủ công / debug)
cognit finding "text" [--related <obs-id,obs-id>]
cognit hypothesis propose "title" [--text "body"]
cognit hypothesis weaken --id <h-id> --reason-type evidence|superseded|constraint
cognit hypothesis reject --id <h-id> --reason "..."
cognit hypothesis promote --id <h-id>
cognit theory add "text"
cognit theory merge --id <theory-id> --into <target-id>
cognit theory archive --id <theory-id>
cognit experiment add "text" --tests <h-id>
cognit experiment complete --id <exp-id> --result "text"
cognit decision propose "text" [--based-on <conclusion-id,id>]
cognit decision accept --id <d-id> --reason "..."
cognit decision reject --id <d-id> --reason "..."
cognit conclusion propose "text" [--based-on <h-id,id>]
cognit conclusion verify --id <c-id> --with <verification-id>

# verification
cognit verify start --type build|test|lint|typecheck|benchmark|custom --command "cmd"
cognit verify pass --id <v-id>
cognit verify fail --id <v-id>
cognit verify error --id <v-id> --reason "..."
cognit verify cancel --id <v-id>
cognit verify rerun --parent <v-id> --command "cmd" --type <type>

# edge
cognit edge add --from <entity:id> --to <entity:id> \
  --kind supports|contradicts|tests|based_on|derived_from|references
cognit edge list [--session <id>] [--kind <kind>]

# constraint
cognit constraint add --json '{...}'
cognit constraint list
cognit constraint test --type <event-type> [--payload <json|file>]

# vận hành
cognit events [--session <id>] [--type <event-type>] [--limit <n>] [--follow]
cognit export --output <bundle.tar.gz> [--include-artifacts]
cognit import --input <bundle.tar.gz> [--merge-strategy skip|overwrite|fork]
cognit gc [--dry-run] [--force] [--max-age-days N]
cognit redaction test "<raw string>"
cognit snapshot
cognit inbox [--watch|--process]
cognit schema-dump
cognit server [--host <ip>] [--port <n>]
cognit dashboard [--port <n>]
cognit wrap -- <command> [args...]

# con trỏ session dính — set tự động bởi `session create` / `resume`
# ghi đè theo lệnh với --session <id>
```

---

## 16. Cấu hình (`cognit.yaml`)

```yaml
project:
  name: my-project   # tự set từ tên thư mục khi init

redaction:
  enabled: true
  patterns:
    - name: internal_bearer
      regex: "Bearer [A-Za-z0-9._-]{20,}"
      replacement: "Bearer [REDACTED]"

cleanup:
  artifact_max_age_days: 30
  unreferenced_action: archive  # archive | delete | keep
  max_db_size_mb: 1024

session:
  snapshot_every_n_events: 100
  fork_on_resume: true

actors:
  defaults:
    human: 0.9
    worker: 0.6
    system: 1.0
  known:
    - name: claude-code
      trust_score: 0.7
    - name: codex
      trust_score: 0.65
    - name: ai-supervisor
      trust_score: 0.75

inbox:
  watch: true
  debounce_ms: 200
  atomic_write_required: true

# trọng số gravity cấu hình được (tổng phải 1.0 ± 0.001)
gravity:
  weights:
    evidence: 0.30
    reproducibility: 0.30
    confidence: 0.20
    trust: 0.10
    freshness: 0.10
  freshness_half_life_days: 14

# cấu hình vòng supervisor (C2)
agent:
  provider: mock          # mock | anthropic | openai | google | ollama
  model: mock-1
  max_actions_per_tick: 5 # 0 = tick chỉ-rank
  max_prompt_hypotheses: 50
```

Sửa trực tiếp:

```bash
cognit config --edit    # mở $EDITOR
cognit config --show    # in cấu hình hiệu lực
```

---

## 17. Công thức thường dùng

### Xoá toàn bộ store cục bộ và init lại

```bash
rm -rf .cognit
cognit init
```

### Xem rank của supervisor theo thời gian thực

```bash
cognit events --type hypothesis_ranked --follow
```

### Lấy giả thuyết top hiện tại

```bash
cognit --json recovery <session-id> | jq '.data.suggested_next_steps[0]'
```

### Replay-debug một quyết định rank

```bash
cognit --json events --type hypothesis_ranked --limit 1 | \
  jq '.data[0].payload | {hypothesis_id, score, reasoning, context_event_ids}'
```

`context_event_ids` liệt kê các sự kiện trước AI đã thấy khi quyết. Dùng để tái dựng view của AI.

### Backup trước khi thí nghiệm rủi ro

```bash
cognit export --output backup-$(date +%F).tar.gz --include-artifacts
```

### Chuyển session sang máy khác

```bash
# bên nguồn
cognit export --output session.tar.gz --include-artifacts

# bên đích
cognit import --input session.tar.gz --merge-strategy fork
```

`fork` viết lại mọi id imported để session nằm song song cục bộ mà không xung đột.

### Chạy supervisor trong CI / batch

```bash
cognit agent run --session <id> --once --max-ticks 1
```

### Docker nhanh

```bash
docker compose up -d
open http://localhost:6970   # đăng nhập bằng token "dev-token"
```

Wipe và seed lại:

```bash
docker compose down -v && docker compose up -d
```

---

## 18. Xử lý sự cố

| Triệu chứng | Nguyên nhân | Cách sửa |
| --- | --- | --- |
| `command not found: cognit` | Chưa `pnpm link`, hoặc PATH thiếu global bin | `pnpm link --global`, kiểm tra `pnpm bin -g` |
| `no current session` | Con trỏ dính chưa set | `cognit session create "..."` hoặc truyền `--session <id>` |
| Dashboard không mở | Port `6970` bận | `cognit dashboard --port 7770` |
| Sự kiện worker không được nhặt | File ghi không atomic | Ghi `.tmp`, `fsync`, rồi `mv` sang `.json` |
| `hypothesis_ranked` bị bỏ | Giả thuyết mục tiêu thiếu (orphan rank) | Kiểm state; đảm bảo `hypothesis_created` đến trước rank |
| Điểm AI bị clamp hoặc rơi về fallback | `score` ngoài range hoặc không hữu hạn | Đảm bảo LLM xuất số hữu hạn trong `[0, 1]` |
| Supervisor lỗi tick đầu | Thiếu API key cho provider đã chọn | Export env tương ứng hoặc dùng `--provider mock` |
| Secret trong sự kiện cũ | Redaction chỉ ở ingest | Restore từ `cognit export` trước, re-import |
| `cognit recovery --session <id>` bị từ chối | Subcommand nhận `<session-id>` vị trí, không phải `--session` | `cognit recovery <session-id>` |
| Lỗi migration lúc khởi động | Lệch phiên bản schema | Kiểm `.cognit/cognit.db`; re-init nếu chỉ cục bộ |

---

## 19. Kiến trúc tổng quan

| Package | Vai trò |
| --- | --- |
| `@cognit/core` | Domain types, Effect Schema, reducer, redaction, Effect services. |
| `@cognit/db` | Drizzle ORM, `appendEvent` (ranh giới redaction duy nhất), inbox watcher. |
| `@cognit/gravity` | Pure scoring fn + AI-rank override (v1.2.0). |
| `@cognit/agent` | Effect supervisor loop, prompt builder, schema `AgentDecision`, apply step. |
| `@cognit/llm` | Vercel AI SDK provider layer (Anthropic / OpenAI / Google / Ollama). |
| `@cognit/verification` | Subprocess engine: spawn, capture, truncation 1 MB, sha256 artifact, terminal-event mapping. |
| `@cognit/wrap` | Producer envelope inbox cho `cognit wrap -- <cmd>`. |
| `@cognit/sdk` | API lập trình cho worker. |
| `@cognit/recovery` | v0.2 recovery envelope + tìm mờ. |
| `apps/cli` | binary `cognit` — cây lệnh commander, layer build. |
| `apps/server` | Hono read API trên loopback `:6971`. |
| `apps/dashboard` | Vite + React 19 SPA trên `:6970`. |

---

## 20. Đi đâu tiếp

- `README.md` — tham chiếu đầy đủ (kiến trúc, schema, kiểu sự kiện).
- `ARCHITECTURE.md` — góc nhìn hệ thống, bản đồ package.
- `STACK.md` — Node 24, pnpm 9, Effect, Drizzle, Hono, Vite.
- `CONVENTIONS.md` — đặt tên, bố cục, anti-pattern.
- `plan.xml` — mô hình dữ liệu và đặc tả tính năng.
- Dashboard tại `http://localhost:6970` sau khi `cognit dashboard`.
- Tab AI Reasoning — live feed `hypothesis_ranked` trên dashboard.
