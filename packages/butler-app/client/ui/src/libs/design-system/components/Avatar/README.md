# Avatar

## What is this component
A person's initial in a small circle (`xs` 16px, `sm` 20px, `md` 24px), with an optional badge slot: a corner mark that shows an agent working for that person.

## When to use this component
To show who an item is assigned to, right after its title, and whether an agent (Claude Code, Codex, Butler) is working on it for them. Also beside an author's name in activity rows.

## Where to use this component
Sidebar rows (`NavRow` label, after the title), board cards and list rows (`xs`), panel titles and activity rows (`sm`), headers (`md`).

## Why to use this component
One look for people across the sidebar, board and inspector; the badge shows agent work without another column and never resizes the circle (a small end margin holds its overhang).

## Motion
The badge pops in from `--motion-scale-check` while fading in over `--motion-base` (decelerate) and fades out over `--motion-exit-base` (accelerate). Both are transitions, so a badge that comes back mid-exit reverses in place. Reduced motion sets the scale token to 1: a plain fade. The circle itself does not move.

## How to use this component
`<Avatar name="하린" label="하린 · Claude Code 작업 중" badge={<AgentGlyph />} />`. `tone="self"` for the signed-in person, `"other"` for anyone else. `label` is the accessible name and the tooltip. `decorative` when the name is written next to it. `initials` overrides the derived initial.

## Who can use this component
Product components and blocks.

## Best practice
People only. Put the agent in the badge and in the label, never as an avatar of its own. One avatar per item, right after the title; the title truncates before it.

## Wrong use cases
- Do not use it for message authors in a conversation; use `MessageAvatarBlock`.
- Do not show an agent or provider as an avatar; use the badge, or `ProviderLogo` alone.
- Do not put a status (spinner, unread) in the badge; those belong in the row's trailing slot.

## Tags
avatar, initials, assignee, person, badge, agent
