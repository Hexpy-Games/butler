# StatusCapsule

## What is this component
A glass `PillButton` that summarizes running work: title · detail · progress. Each part truncates within its own cap (`--status-capsule-title-max`, `--status-capsule-detail-max`).

## When to use this component
Use it for background work (Workers, reports) shown above the composer.

## Where to use this component
Composer capsule rows.

## Why to use this component
The truncation caps and part colors live in the DS instead of product CSS.

## How to use this component
`<StatusCapsule icon={mark} title={task} detail={activity} progress="2/3" aria-label={summary} onClick={open} />`

## Who can use this component
Composer and conversation components.

## Best practice
Repeat all parts in `aria-label`; keep `detail` short.

## Wrong use cases
Do not use it for composer settings. Use `ComposerControl`.

## Tags
capsule, progress, worker, composer, pill
