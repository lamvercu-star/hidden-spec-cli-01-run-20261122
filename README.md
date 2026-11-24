[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/lamvercu-star/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/lamvercu-star/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
# mend — one patch tool for every AI edit format

`main.ts` is mend, the command-line tool specified by `SPEC.md` in the
make.fun kit (`hidden-spec-cli-01-run-20261122`): it applies edits AI models
write — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks,
V4A patches, and text-editor tool calls as JSON — to a tree of text files,
finding the lines an edit names even when their whitespace or indentation
drifted, and changing every file or none.

Built by lamvercu-star (GitHub: `lamvercu-star`) for the make.fun bounty
"Build mend, one patch tool for every AI edit format".

## Run

Node 22, standard library only, nothing installed:

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a patch file, or `-`/absent for standard input. See SPEC.md for
the full contract (exit codes, output, the three matching tiers, atomicity).

## Files

- `main.ts` — the CLI.
- `runner.ts` — the kit's trial runner, kept as shipped.
- `check.ts` — run the kit's public practice set:
  `node check.ts <kit>/program/generator/practice.json`
- `LICENSE` — MIT.

## Practice result

100 of 100 practice checks pass (practice score 1000), plus 41 of 41
self-made edge checks covering SPEC sentences the practice set does not show
(no-newline-at-end-of-file, empty insertions, rename-only moves, move-then-
recreate, `--strict`, usage errors, V4A move-only sections, and more).
