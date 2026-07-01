# Project Ledger Package

`packages/project-ledger/` contains the portable Project Ledger implementation.
It owns the CLI, record helpers, state machine, renderer, migration support,
templates, and distributable skill files.

## Module Map

- `bin/`: executable CLI entrypoint.
- `src/`: parser, commands, record IO, renderer, state machine, and git evidence
  helpers.
- `templates/`: default project, work, and task records.
- `examples/`: small example records for CLI and skill validation.
- `SKILL.md`: distributable skill instructions.

## Boundaries

Project Ledger stores project-management records outside Butler Agent and
Butler App. Butler packages may integrate with it through the CLI or a narrow
client, but they should not duplicate Ledger state.

## Usage Notes

Start with `project-ledger status` and `project-ledger query --kind
next-actions`, or the equivalent `pl status` / `pl list next-actions` short UX
when available. Use `pl list <kind> --status STATE` only for narrower record
filters. Mutate records only through Project Ledger CLI/native tools. Close
out source changes with index, dashboard/handoff/roadmap render using `--write`,
then sequential status and check.

## Related Specs

- `SPEC-PROJECT-LEDGER` - Project Ledger
