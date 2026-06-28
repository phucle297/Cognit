# Why did AI make this change?

When your AI tool changes a file, where do you see *why*?

## Short answer

1. Run `cognit dashboard` and open it in your browser.
2. Click **Timeline**.
3. Click the session that contains the change.
4. The session row opens a side panel showing the chain of guesses
   and checks that led to the change.

## The four-step journey

**Step 1: open the dashboard.**

```bash
cognit dashboard
```

The browser opens at `http://localhost:5173` (or `:6970` if you used
`--docker`).

**Step 2: navigate to Timeline.**

The Timeline view shows what your AI has been doing, in order, for
the active session. Each row is one decision, observation, or
verification.

**Step 3: pick a session.**

Sessions group related work — for example, "Investigate memory leak"
or "Migrate auth to OAuth." Click one to open the detail panel.

**Step 4: read the reasoning chain.**

The side panel shows, in order:

- what the AI observed
- what it hypothesised
- what it checked
- what it decided, and why

You see the same trail the AI saw, in the same order it saw it.

## Where to go next

For the full route reference and every dashboard tab, see
[dashboard.md](dashboard.md).