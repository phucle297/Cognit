# D-M2-02 — Shell completion

## Problem

No fish/zsh/bash completion; power users discover flags slowly.

## Chosen solution

`cognit completion <shell>` prints script to stdout (commander built-in or small generator). Document install one-liners in README.

Depends on D-M0-03 so completed flags work.

## Tests required

- Command exists; output non-empty for fish/bash/zsh; contains `continue`, `observation`, `--root`.
