# RollingSwap

## What is this component

A one-line viewport that rolls the previous content up and out while the next
content rolls in from below, keyed by `itemKey`. It is the motion behind the
live work-activity line in a running turn.

## When to use this component

Use it when a single line of status is replaced often (the latest tool call,
the current step) and the change itself should be noticed. Pass `motion={false}`
when the content is historical rather than live. Do not use it for lists or
for content taller than one line.

## Motion

Uses the adaptive panel duration and easing tokens. Under reduced motion the
outgoing frame is hidden and the incoming frame appears without travel. Reduced
motion is read through `lib/motion` `prefersReducedMotion()`, so both the OS
setting and the `data-motion="reduced"` scope (DS Viewer toggle, proposal
stages) turn the roll off.
