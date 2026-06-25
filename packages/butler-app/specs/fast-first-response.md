# Fast First Response

## Scope

Butler must show immediate, truthful feedback when a user submits a message,
especially from a new chat. This spec covers two visible surfaces:

- the runtime-authored first public progress sentence for app turns
- the app UI shell shown while a newly submitted draft chat is becoming a real
  session

## Ownership

- App UI owns local optimistic state. It may show service-prepared status text,
  skeleton geometry, and the user's pending message before the server returns a
  durable session id.
- App gateway/store owns durable session ids, navigation summaries, accepted
  messages, replay, and session-view reconciliation.
- Native runtime owns assistant-authored first public progress prose. The app
  must not substitute a fixed assistant sentence for this prose.
- Design system owns reusable skeleton primitives. Product components may
  compose those primitives into session-specific loading shells.

## Runtime First Progress Contract

When the app transport durably accepts an inbound user turn, the session actor
must attempt to emit `turn.first_progress` before context preparation and before
tool or runtime work can create a later progress row.

The `turn.first_progress` payload must use assistant-authored prose generated
from the active model provider, with the same ownership style as generated
session titles. It must:

- be in the user's language when the model can infer it
- be short public prose suitable for a visible progress row
- describe immediate orientation or next action without claiming completed
  evidence
- contain no hidden reasoning, raw prompts, raw paths, secrets, tool payloads,
  or private ids
- be delivered best-effort so failure to generate or deliver it never fails the
  turn

If generation fails or returns unsafe/empty text, the runtime must skip the
assistant-authored first progress event instead of replacing it with a fixed
assistant-like sentence. Service status labels may still show non-assistant
states such as "thinking" or "starting session" through the UI status contract.

## Optimistic New Session State

When a user submits from `draft:chat` or `draft:project:*`, the UI must
immediately transition from the empty new-chat screen to a session-like shell
without waiting for `/sessions`.

The optimistic state must include:

- a local optimistic session id used only inside the renderer
- a pending navigation row at the top of the relevant chat/project session list
- the user's pending message with the selected attachments
- loading skeletons for assistant/runtime-owned content that cannot be known
  until the server accepts and starts the turn
- service-prepared localized status text for the pending session row

When `/sessions` returns, the UI must reconcile the optimistic id to the durable
session id, preserve the pending user message, and continue through `/messages`
submission. When later navigation or session-view snapshots arrive, canonical
server data replaces the optimistic row and skeletons.

If session creation or message submission fails, the optimistic row and pending
message must be removed, the composer must remain usable, and a normal error
notification must be shown.

## Skeleton Primitive

The Butler design system must expose a `Skeleton` primitive based on the
shadcn/ui skeleton pattern. The primitive must:

- support width/height through normal style/class composition
- use design tokens for surface colors, radius, and animation
- expose an accessible hidden label only when callers provide one
- avoid domain-specific copy or app state imports
- render in the design-system registry fixture

## UX Contract

- Submitting a new chat clears the composer and immediately changes the main
  conversation surface.
- The user sees their submitted message immediately.
- Unknown assistant/runtime content is represented by shimmer skeletons, not a
  blank panel.
- The sidebar immediately reflects that a new session is starting.
- Fixed service status labels are allowed only for UI state. They must not be
  presented as assistant-authored first response prose.

## Acceptance Criteria

- Unit tests prove first progress generation imports and exercises the real
  generator/sanitizer and does not use the prior fixed Korean sentence.
- Session actor tests prove app first progress uses the injected generated text
  and skips the event when generation returns null.
- Store tests prove draft-chat submission immediately creates an optimistic
  session shell before `/sessions` resolves, then reconciles it to the durable
  id.
- UI/design tests prove the Skeleton primitive is exported through the design
  system and the conversation/sidebar surfaces render skeleton or pending state
  instead of a blank draft screen.
- Targeted tests, typecheck, and `git diff --check` pass before reporting the
  work complete.
