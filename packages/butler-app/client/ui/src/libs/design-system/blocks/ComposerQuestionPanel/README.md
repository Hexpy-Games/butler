# ComposerQuestionPanel

## What
DS-only composer form, a sibling of ComposerDecisionPanel. Place it inside ComposerCard instead of editor and toolbar. The collapsed pill belongs above the normal composer; onExpand restores the form.

## Contract
Pass 1–4 questions with unique ids, type, header, text, options and optional allowOther/placeholder. onSubmit returns one answer per question: id, selected option indices, text, other and skipped. Delivery state is caller-owned: open, submitting, error, collapsed or working. Remount with a new key for a new request. defaultAnswers/defaultStep are showcase and restoration seeds. Optional onDraftChange reports snapshots for a caller that remounts the surface when collapsing.

## Behavior
Single-choice tap sends immediately for one question and advances for multiple questions. Multi/text/Other require confirmation. Multi-question review permits skipped answers and edits. Recommendation highlights without selecting. Keyboard: 1–9 choices, up/down highlight, Enter select/advance/send, Space multi toggle, Esc collapse, left/right questions. Inputs preserve typing and IME; Tabs retains native navigation. Touch targets and scroll fades use DS primitives. Labels default to English; showcase supplies Korean.

## DS review rules
Keyboard shortcuts have no visible hint row. Footer actions use `ButtonContainer size="sm" justify="end"`, following ComposerDecisionPanel and DialogForm. Line tabs share the header's token inset so they clear the ComposerCard radius. The focus foundation requires room for every ring: scroll contents have `--space-xs` padding; options and tabs use an inset token outline. Header icon size follows the caption (`sm`) with `IconSlot minHeight="line"` aligned to the first line. GitBranch represents a choice between paths.

Other edits the label inside its existing row, without nesting an input inside Clickable. Input offers only default and compact geometry, not an underline variant; use the unchanged default Input instead of a local border treatment.

## Ownership
No tool, gateway, store, persistence or product wiring. The caller owns collapse, resume, skip, delivery and transcript insertion. New-chat onboarding is a showcase only.

## Review
Open `/?visual=design-system&page=blocks/ComposerQuestionPanel&theme=side-by-side&locale=ko&width=375&motion=reduced`.
