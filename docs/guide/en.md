# Cognit

Your AI writes code. Cognit remembers why.

Cognit is a small, local-first tool that records the reasoning behind your code so the next Claude session — tomorrow, next week, on a different machine — can pick up without you re-explaining. No server. No cloud. No setup beyond a single command in each project.

---

## The shape of a day with Cognit

**Morning.** Open Claude Code in your project. Start a task.

**During the day.** You work normally. Read files. Edit code. Run tests. Claude proposes a fix, picks between two libraries, runs the test suite, finds one failing. You don't run any Cognit commands — Claude does. It records the reasoning as it goes: *I noticed X*, *I decided Y*, *the test for Z passed*, *the conclusion is W*.

**End of day.** Close the laptop. Everything Claude recorded is saved to `.cognit/` in your project. Nothing is lost.

**Tomorrow.** Open Claude Code again. Ask it to continue where it stopped. Before it answers, it runs:

```bash
cognit continue
```

It reads the output — last observation, what was decided, what evidence exists, what's still open — and picks up the thread without you saying a word.

That's it. That's the whole product.

---

## Getting set up

Requirements: Node.js 22+, pnpm 9, git.

```bash
git clone <cognit-repo-url>
cd cognit
pnpm install
pnpm build
cd apps/cli && pnpm link --global
```

Inside the project you want Cognit to track:

```bash
cd your-project
cognit init
```

This drops a `.cognit/` directory and a `CLAUDE.md` at your project root. The `CLAUDE.md` is what teaches Claude when to use Cognit — you don't need to read it. Re-run `cognit init` any time to refresh the file or re-wire AI tool hooks.

You only run `init` once per project. After that, you forget Cognit exists.

---

## Daily workflow

### Start working

Open Claude Code in a project where Cognit has been initialised. Do your task. Tell Claude what you're doing in plain language. Claude will, on its own:

- Notice facts worth remembering → record an observation.
- Make a non-trivial choice → propose a decision.
- Run a test, lint, build, or typecheck → record a verification.
- Close a decision with a verified claim → propose a conclusion.

You don't type these commands. You don't even need to know they exist. But if you want to peek at what's been recorded, they're available as `cognit observation`, `cognit decision`, `cognit verification`, `cognit conclusion`.

**Example: investigating an auth bug.**

> You: "Investigate why refresh tokens fail on production."
>
> Claude reads the code, runs the existing tests, pokes at the auth module. During this, it records:
>
> - *Observation:* refresh uses a 1h TTL with rotation on each use.
> - *Observation:* repro: with a rotated signing key, the refresh endpoint returns 401.
> - *Decision:* fall back to the previous valid key for 60 seconds while the new key propagates.
> - *Verification:* the regression test for this scenario passes.
> - *Conclusion:* refresh tokens work during the 60-second key-rotation window.

You did none of that bookkeeping. Claude did.

### Resume tomorrow

Open Claude Code. Ask it to continue. Before answering, it runs:

```bash
cognit continue
```

The output is the entire previous session's context in one screen:

```text
Session:    Investigate the refresh-token failure
Status:     active

Doing:
  repro: with a rotated signing key, the refresh endpoint returns 401

Verified:
  [verified]  refresh tokens work during the 60-second key-rotation window

Decided:
  [accepted]  fall back to the previous valid key for 60 seconds

Next:
  Monitor production for one week, then remove the fallback
```

Claude reads that and continues. No hand-off. No re-explaining. No copying notes.

If you ever want to see this yourself — without Claude running it — `cognit continue` works from your shell.

### Find previous work

Two weeks later, you remember you once picked between two libraries for the auth layer, but you don't remember which one. Don't scroll chat history. Don't grep through git log. Run:

```bash
cognit search "auth library"
```

You get a list of sessions that mentioned the topic, ranked by how strongly each one matches, with a one-line reason per match. Click into one (or run `cognit continue <id>`) to read its full memory.

### Capture something yourself

Most of the time Claude drives. But sometimes you, the human, know something Claude doesn't — a constraint from a meeting, a decision from last quarter, a piece of tribal knowledge. Record it directly:

```bash
cognit observation "we sunset the v1 API on 2026-09-01; do not add new endpoints there"
```

One line. Done. Tomorrow's session will see it.

### Recover after an interruption

The laptop battery dies. The terminal crashes. The Claude session is killed mid-thought. None of this matters — every memory is flushed to `.cognit/cognit.db` synchronously. Reopen Claude Code, run `cognit continue`, the session is exactly where it was.

### Share memory with another machine

```bash
cognit export --output project.tar.gz
```

on the source machine, then:

```bash
cognit import --input project.tar.gz
```

on the destination. The bundle contains the project's config, database, and (optionally) the artifacts directory.

### Clean slate

If a project's memory has gone stale — wrong conclusions, abandoned threads, ideas you no longer believe — start over:

```bash
cognit reset --yes
cognit init
```

You'll keep the project config; you'll lose the recorded memories.

---

## The five concepts

Cognit's memory has five shapes. Everything you ever record is one of these.

**Observation.** A fact noticed during work. One line. No lifecycle. *"auth uses refresh tokens with 1h TTL."* *"repro: refresh fails on rotated signing key, returns 401."*

**Decision.** A non-trivial choice. Has a small lifecycle: Claude *proposes* a decision, you (or a verification) *accept* or *reject* it, and later decisions can *supersede* earlier ones. *"fall back to the previous valid key for 60 seconds."*

**Verification.** Evidence that something was true at a moment. Always links to a command that ran — `pnpm test`, `pnpm build`, a shell script, anything. Records whether it passed, failed, or errored. *"regression test for refresh-during-rotation: passed in 1.2s."*

**Conclusion.** A claim, backed by verifications. Starts *pending*, becomes *verified* when a passing verification is linked to it. *"refresh tokens work during the 60-second key-rotation window."*

**Continue / Search.** Two ways to read memory back. Continue shows you the current session, ranked. Search looks across all past sessions for a topic.

That's the whole vocabulary. Everything else — sessions, projects, hooks — is plumbing you don't need to think about.

---

## A worked example, end to end

Day 1. You ask Claude to investigate a flaky test.

```
You: "Investigate why integration/auth.test.ts is flaky on CI."

[Claude reads the test, finds it uses Date.now() in a retry loop,
 proposes a fix, runs the test 20 times, writes up the conclusion.
 All of this is recorded as Cognit memories — you do nothing.]

You: "Stop for today."
```

Day 2. You open Claude Code.

```
You: "Continue the auth flakiness investigation."

[Claude runs `cognit continue`. The output says:

  Doing: "reproed the flake on commit abc123 — retries 3× within 200ms window"
  Verified: "Hypothesis H1 is the actual cause (quorum < 2)"
  Decided: "bump the retry budget from 50ms to 500ms"
  Next: "investigate the second writer's commit ordering"

 Claude continues.]
```

Day 8. You're looking at a different auth bug and wonder if this one connects.

```
You: "Did we ever deal with retry budgets in this project?"

[Claude runs `cognit search "retry budget"`. It finds the
 session from day 1. It summarises: "We bumped the retry
 budget from 50ms to 500ms on day 2 because of a flake in
 auth.test.ts. Evidence: 20 consecutive passing runs."]
```

Day 30. You switch laptops.

```
$ cognit export --output auth-project.tar.gz
$ scp auth-project.tar.gz new-laptop:
$ ssh new-laptop
$ cd auth-project && cognit init
$ cognit import --input auth-project.tar.gz
$ cognit continue     # the full history is back
```

That's the product.

---

## When something goes wrong

`cognit init` failed. The error names the cause. Common fix: `rm -rf .cognit/cognit.db .cognit/cognit.db-* && cognit init`.

`cognit continue` shows "No memory yet." The session has nothing recorded yet. Do some work, then re-run.

`cognit search "x"` returns nothing. No past memory overlaps the query. The output suggests next steps.

`cognit verification "<cmd>"` errored with no message. The subprocess couldn't start (binary missing, permissions, etc.). Try `cognit verification --type exec -- /bin/echo ok` to confirm the project is healthy. If that also fails, run `cognit doctor`.

`cognit` exits with code 2. You forgot a required flag. The error names it. The most common one: `verification` without `--type`.

Want a full health report? `cognit doctor`. Each FAIL line includes a one-line fix.

---

## What's not in this guide

Cognit has roughly 40 commands. This guide covers the 7 you will actually use (or watch Claude use). The rest — dashboard, hooks, packaging, internal lifecycle verbs — exist for power users and contributors. Run `cognit --help` to see them, or `cognit <command> --help` for the flags. The CLAUDE.md that `cognit init` drops into your project tells Claude exactly which of these to reach for and when.

You don't need to memorise any of this. The whole point is that Claude does the bookkeeping so you can forget the tool exists.