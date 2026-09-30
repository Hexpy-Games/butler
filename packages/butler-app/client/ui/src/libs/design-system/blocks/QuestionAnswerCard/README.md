# QuestionAnswerCard

## What
Answer summary wrapped in a user MessageRow. Supports answered, skipped and message variants; partial responses retain skipped questions.

## Contract
Pass the original questions and answers. Supply localized status labels and the actual message for the message variant. Do not wrap in another MessageRow.

## Behavior
Single-choice tap sends immediately for one question and advances for multiple questions. Multi/text/Other require confirmation. Multi-question review permits skipped answers and edits. Recommendation highlights without selecting. Keyboard: 1–9 choices, up/down highlight, Enter select/advance/send, Space multi toggle, Esc collapse, left/right questions. Inputs preserve typing and IME; Tabs retains native navigation. Touch targets and scroll fades use DS primitives. Labels default to English; showcase supplies Korean.

## Ownership
No tool, gateway, store, persistence or product wiring. The caller owns collapse, resume, skip, delivery and transcript insertion. New-chat onboarding is a showcase only.

## Review
Open `/?visual=design-system&page=blocks/QuestionAnswerCard&theme=side-by-side&locale=ko&width=375&motion=reduced`.
