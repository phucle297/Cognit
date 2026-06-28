# How do I undo or revisit?

When AI does something wrong, how do you find the reasoning and
undo it?

## Short answer

```bash
cognit recovery search "why did we drop the JWT refresh"
```

This opens the matching session and shows you:

1. The full chain of hypotheses the AI worked through.
2. The verification results — what passed, what failed.
3. The decision rationale — why the AI picked what it picked.
4. A **Resume this investigation** button that reopens the session
   with all prior context loaded.

## Example

You notice a file changed last month and you have no idea why:

```bash
cognit recovery search "JWT refresh rotation"
```

Cognit returns sessions whose observations, hypotheses, or decisions
mentioned JWT rotation. Open the one from the date you care about.
Read the chain. If the decision looks wrong, click **Resume this
investigation** to fork the session and try a different path — the
original reasoning stays intact as history.

## When you only have a symptom

Describe what you see, not what you think happened:

```bash
cognit recovery search "login fails on mobile"
cognit recovery search "memory grew after deploy"
cognit recovery search "auth header missing"
```

Search is fuzzy and works on the actual words the AI used, not on
file names or commit hashes.

## Where to go next

For the full CLI surface — flags, filters, and the JSON output
mode for scripts — see [cli.md](cli.md).