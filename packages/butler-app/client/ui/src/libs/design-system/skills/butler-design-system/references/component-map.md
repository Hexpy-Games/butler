# Butler Design System Component Map

Use this map before creating or selecting UI. It is intentionally lightweight:
it gives agents a search and decision surface without requiring a RAG service.
Read this before adding primitives, blocks, product containers, or CSS.

## Selection Order

1. Identify the user's task: layout, text, action, form, navigation, overlay, data, or status.
2. Pick the smallest design-system component that matches the task.
3. Compose primitives before creating a new component.
4. Move domain-specific behavior into `packages/butler-app/client/ui/src/components`.
5. Add a new design-system component only when the need is reusable across features.
6. Verify the chosen component in DS Viewer or with `bun run render`.

## Quick Intent Index

| Intent               | Start Here                                                       | Use A Block When                                                                                        | Wrong Turn                                                 |
| -------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Page or panel layout | `Stack`, `Grid`, `Section`, `Space`, `Separator`                 | Repeated shell or panel pattern exists, such as `SurfacePanel` or `PanelHeader`                         | Fixed-width local wrappers                                 |
| Text hierarchy       | `Typo`                                                           | Text appears inside a block with a named slot                                                           | Raw font sizes or document headings in app chrome          |
| Commands             | `Button`, `PillButton`, `IconButton`, `Clickable`                | Row or toolbar action pattern repeats, such as `RowActionCluster`                                       | Nested `<button>` elements                                 |
| Forms/settings       | `Field`, `Input`, `Textarea`, `Select`, `NativeSelect`, `Switch` | Responsive label/control layout is needed, such as `SettingsField`, `FormRow`, `TokenInputControl`      | Placeholder-only labels or local form CSS                  |
| Navigation           | `Tabs`, `Breadcrumb`, `Separator`                                | Sidebar/list navigation is needed, such as `NavRow`, `NavSection`, `CollapsibleNavGroup`, `SettingsNav` | Active outlines, shadows, or indented collapsible children |
| Overlays             | `Dialog`, `Popover`, `Tooltip`, menus                            | Modal form composition is needed, such as `DialogForm` or `CommandPanel`                                | Long workflows in popovers                                 |
| Surfaces             | `Card`, `TintedGlass`                                            | Repeated panel or overlay treatment is needed, such as `SurfacePanel`                                   | Local glass gradients or Radix wrapper DOM                 |
| Status and feedback  | `Icons`, `Typo`, `ProgressMeter`                                 | Empty, notice, activity, or worker rows repeat                                                          | Decorative charts or status hard-coded in CSS              |
| App shell            | `Stack`, `Grid`, `Typo`                                          | Window/titlebar/frame pattern repeats, such as `ChromeFrame`, `TitlebarShell`                           | Decorative cards that imitate shell chrome                 |

## Layout

Use `Stack` for one-dimensional flow: vertical panels, toolbar rows, sidebar sections, form groups, and compact repeated content.

Use `Grid` for repeated peers that should wrap responsively: stats, cards, setting groups, document tiles, or component galleries.

Use `Section` for a titled region with optional description, icon, action, or body content. Prefer it over hand-written `<section>` blocks in inspectors, dashboards, and settings panels.

Use `Space` only for intentional empty spacing where composition cannot express the gap. Prefer `Stack` or `Grid` gap props first.

Wrong turns:

- Do not use `Grid` for two controls that must stay in a strict row; use `Stack align="row"` with wrapping.
- Do not use `Section` as a decorative card. Use it when the region has semantic title or grouped purpose.
- Do not use fixed widths to force alignment. Use responsive tracks and token spacing.

Tags: layout, responsive, spacing, region, density

## Surfaces

Use `Card` for a simple bordered content container that should not imply an
overlay or window material.

Use `TintedGlass` for compact translucent containers that need Butler's fixed
20px edge fade, tokenized tint, and 4px backdrop blur. Use
`tintedGlassSurfaceClassName` instead of wrapping when another primitive already
owns the accessible content element, such as Radix select, popover, or menu
content.

Wrong turns:

- Do not recreate tinted-glass gradients in product CSS.
- Do not add extra wrapper DOM around Radix content just to apply glass styling.
- Do not use TintedGlass as a decorative page section.

Tags: surface, card, container, glass, overlay

## Typography

Use `Typo` variants for all reusable text hierarchy.

Use document-style variants (`H1` through `H6`, `Body`, `Caption`, `Label`, `Code`) for content and readable text.

Use app-chrome variants (`AppTitle`, `PanelTitle`, `DashboardTitle`, `SectionTitle`, `PanelSectionTitle`, `MetricValue`) for dense product UI, sidebars, dashboards, and settings surfaces.

Wrong turns:

- Do not use document headings inside compact sidebars, titlebars, cards, or toolbars.
- Do not hard-code font size, weight, line height, or letter spacing.
- Do not use `Label` from `Typo` for form control association when the shadcn `Label` component is required.

Tags: typography, hierarchy, app-chrome, content

## Actions

Use `Button` for visible commands with text, icon plus text, destructive actions, and primary or secondary flows.
Button labels use regular weight. Selected or primary states must be shown with
surface, color, icon, or placement instead of heavier typography.

Use `ButtonContainer` whenever two or more buttons appear next to each other.
Set `size` on the container and use that same size on all contained buttons so
the size-specific gap is applied consistently.

Use `PillButton` for borderless compact commands with fully rounded ends, especially composer toolbar controls and mode selectors.

Use `IconButton` for compact icon-only commands. Always provide a `label`; the component supplies accessible naming and tooltip behavior.

Use `Clickable` for row-like interactive containers that need `role="button"` because they contain nested action buttons.

Use `DropdownMenu` for a command list opened from a button when choices are actions, not form values.

Use `ContextMenu` for secondary actions tied to a specific row, message, item, or surface.

Wrong turns:

- Do not use `IconButton` when the action is not obvious without text in a high-risk flow; use `Button`.
- Do not place adjacent `Button` elements in a raw `Stack`; use `ButtonContainer`.
- Do not use native `Button` as a row container when it contains another button; use `Clickable`.
- Do not recreate composer pill CSS locally; use `PillButton`.
- Do not use `DropdownMenu` as a form select; use `Select` or `NativeSelect`.
- Do not expose destructive actions only in hover-only UI on mobile-critical surfaces.

Tags: action, command, menu, icon, toolbar

## Interaction And Motion

Interactive primitives and blocks should expose all meaningful states in
fixtures: default, hover-ready structure, active/selected, disabled, expanded,
loading when applicable, empty/error when applicable, and narrow-width behavior.

Use fast, subtle transitions. Dialogs and popovers should open with a quick
fade/scale or fade/slide motion; collapsible groups should animate expansion
without changing row alignment. Navigation hover should transition background
and small motion only.

Wrong turns:

- Do not remove interaction animation from rows, collapsibles, popovers, or
  dialogs unless reduced-motion handling requires it.
- Do not introduce active outlines, shadows, glows, or inset borders for
  navigation.
- Do not make hover-only controls the only path to a critical action on mobile.

Tags: interaction, motion, animation, active, hover

## Forms

Use `Field` to group a label, control, description, validation, or help text.

Use `Input` for short free text.

Use `Textarea` for multi-line user text, prompts, notes, or descriptions.

Use `Switch` for immediate binary settings.

Use `Select` for styled option picking where the option set is short and the custom trigger matters.

Use `NativeSelect` for mobile-friendly selection, dense settings, or where native platform behavior is preferred.

Use `Label` for accessible control labels.

Wrong turns:

- Do not use `Switch` for choices that require confirmation or have irreversible effects; use `Button` plus `Dialog`.
- Do not use `Select` for command execution; use `DropdownMenu`.
- Do not use placeholder text as the only label.

Tags: form, input, settings, validation, mobile

## Overlays

Use `Dialog` for focused tasks, confirmation, editing flows, and modal surfaces that require user attention.

Use `Popover` for lightweight contextual content anchored to a trigger: details, previews, short controls, or hover/click adjuncts.

Use `Tooltip` for short help text on controls, especially icon-only controls.

Wrong turns:

- Do not use `Tooltip` for required information or interactive content.
- Do not use `Popover` for destructive confirmation; use `Dialog`.
- Do not put long workflows inside a popover.

Tags: overlay, modal, help, contextual

## Navigation

Use `Tabs` for switching between peer views within one bounded area.

Use `Breadcrumb` for hierarchical location, especially project, folder, or document paths.

Use `Separator` to divide dense groups when spacing alone is not enough.

Wrong turns:

- Do not use `Tabs` for global app navigation.
- Do not use `Breadcrumb` as decorative metadata.
- Do not overuse `Separator`; prefer spacing and headings first.

Tags: navigation, hierarchy, view-switching, structure

## Data And Visualization

Use `Chart` for token-backed visual analytics where data comparison is the main content.

Use `Grid` plus domain components for repeated data summaries before inventing a table or card system.

Wrong turns:

- Do not use `Chart` as decoration.
- Do not encode business metrics inside the design-system component. Keep data shaping in domain code.

Tags: data, analytics, chart, metric

## Icons

Use `Icons` exports from `@/butler-ds` for actions, status, navigation, and repeated symbolic language.

Pair unfamiliar icons with visible text or `IconButton` labels. Prefer existing icon names before adding aliases.

Wrong turns:

- Do not import icon packages directly in app code.
- Do not use an icon-only control without an accessible label.

Tags: icon, status, action, navigation

## Blocks

Blocks are compositional presentational components built from design-system primitives. They own layout, states, and accessibility but must not import Butler domain data, stores, app copy, or `window.butlerApp`.

### Navigation Blocks

Use `NavRow` for sidebar navigation items with icon, label, badge, active state, and inline actions.

`NavRow` layout has two regions: label and control. The label region contains
the icon plus text and expands with `minmax(0, 1fr)`; label text truncates only
when it reaches the control region. The control region is right-aligned and uses
the same right padding balance as the row's left padding.

Use `NavSection` for grouping navigation items under a titled section with optional actions.

Use `CollapsibleNavGroup` for expandable/collapsible navigation hierarchies like project folders with sessions.
Children in a collapsible navigation group use the same row size and alignment
as other rows; do not indent them unless a separate hierarchy block is designed.

Use `RowActionCluster` for inline action buttons within rows that need click
isolation; it delegates spacing to `ButtonContainer`.

Use `OverflowActionMenu` for dropdown menus containing overflow actions accessed via a "more" button.

Wrong turns:

- Do not use NavRow for non-navigation list items; use ListRow.
- Do not use NavSection for form sections; use FormSection.
- Do not nest CollapsibleNavGroup more than 2 levels deep.
- Do not add active outline, shadow, glow, or inset border treatments.
- Do not center-align row labels as a group; icon and label are left-aligned,
  controls are right-aligned.

Tags: navigation, sidebar, row, section, collapsible, actions

### Form Blocks

Use `FormRow` for form fields with label, input, help text, and error message layout.

Use `FormSection` for grouping related form fields under a titled section.

Wrong turns:

- Do not use FormRow for non-form content.
- Do not use FormSection for navigation sections; use NavSection.

Tags: form, field, input, validation, section

### Panel Blocks

Use `PanelHeader` for panel titles with optional description and actions.

Use `SurfacePanel` for card/panel containers with elevation and padding.

Wrong turns:

- Do not use PanelHeader for page-level headings; use H1-H6.
- Do not use SurfacePanel when simple background suffices.

Tags: panel, header, card, surface, elevation

### Metrics Blocks

Use `MetricCard` for displaying a single metric with value, label, trend, and change indicator.

Use `MetricGrid` for laying out multiple MetricCards in a responsive grid.

Wrong turns:

- Do not use MetricCard for non-numeric data displays.
- Do not use MetricGrid for non-metric content.

Tags: metric, dashboard, analytics, kpi, stats, grid

### List Blocks

Use `ListRow` for list items with icon, title, description, and metadata (non-navigation).

Use `ResourceTile` for resources like projects or documents in a card/tile format.

Wrong turns:

- Do not use ListRow for clickable navigation; use NavRow.
- Do not use ResourceTile for list layouts; use ListRow.

Tags: list, row, item, tile, card, resource

### Utility Blocks

Use `EmptyLine` for empty state displays with icon, message, and optional action.

Use `Notice` for alert/notice banners with info, warning, error, or success tones.

Wrong turns:

- Do not use `Notice` for inline field validation when the validation belongs to one field. Use `FormRow` or `SettingsField`.
- Do not use `EmptyLine` as placeholder copy in populated panels. Use real section content.

Tags: empty, state, notice, alert, banner

### Conversation And Composer Blocks

Use `ComposerControl` for compact pill controls in the composer toolbar, including access mode, model, and reasoning controls.

Use `AttachmentList` for displaying uploaded or message-attached files after the caller has resolved file names, sizes, and safe URLs.

Use `MessageAvatarBlock` for assistant, user, and system avatar shells. Pass product-specific Butler marks as children.

Use `ActivityFeed` for small chronological or status rows in conversation, worker, and dashboard surfaces.

Use `DisclosureRow` for expandable tool calls, progress details, and audit entries. Keep expansion state in the caller.

Wrong turns:

- Do not use `ComposerControl` for destructive or page-level actions. Use `Button`.
- Do not put upload logic or `window.butlerApp` inside `AttachmentList`; map attachment props in a product container.
- Do not use `DisclosureRow` for sidebar hierarchy. Use `CollapsibleNavGroup`.

Tags: composer, attachment, message, activity, disclosure

### Inspector And Feedback Blocks

Use `InspectorPanel` for right-inspector sections that contain diagnostics, context, artifacts, or worker summaries.

Use `KeyValueRow` for read-only label/value facts, optional descriptions, and swatches.

Use `ProgressMeter` for bounded progress or percent values after the caller has computed a 0-100 value.

Use `WorkerActivityRow` for worker status rows with optional inline controls.

Wrong turns:

- Do not use `KeyValueRow` for editable settings. Use `SettingsField`.
- Do not use `ProgressMeter` for indeterminate loading.
- Do not pass worker lifecycle commands into the design system as domain actions; pass already constructed action nodes.

Tags: inspector, diagnostics, key-value, progress, worker

### Settings Blocks

Use `SettingsHeader` for settings detail pages.

Use `SettingsNav` for settings category navigation.

Use `SettingsField` for responsive label, description, control, and helper/meta layout.

Use `FormSection` for each top-level logical settings group. It is the bordered
settings card. Use `Section` only for unframed grouping inside a larger surface.

Use `SurfacePanel` for repeated editable settings entities inside a
`FormSection`, such as worker rules or registered local-model rows.

Use `TokenInputControl` for token-like setting inputs where parsing is owned by the caller.

Use `PercentInputControl` for numeric percent settings that benefit from a visual meter.

Wrong turns:

- Do not use `SettingsHeader` for dashboard pages. Use `DashboardHeader`.
- Do not use `Section` as an outer settings card.
- Do not place a switch in a section header when it is a setting. Use `SettingsField`.
- Do not render native `input[type="range"]` directly in product settings. Use `Slider`.
- Do not parse or persist token values inside `TokenInputControl`.
- Do not use `PercentInputControl` for read-only progress. Use `ProgressMeter`.

Tags: settings, nav, field, tokens, percent

### Management And Shell Blocks

Use `DashboardHeader` for management and project dashboard page headers with one primary action.

Use `DocumentTile` for Project Ledger docs and document-like resources.

Use `SessionRow` for chat/session summary rows.

Use `AutomationRow` for automation definitions and status.

Use `AutomationRunList` for automation run history.

Use `CommandPanel` for command palette search and result shells.

Use `DialogForm` inside `DialogContent` for modal create, edit, rename, or confirmation forms.

Use `ChromeFrame` and `TitlebarShell` for app-shell previews and shell presenter composition.

Wrong turns:

- Do not put routing, IPC, scheduling, or command execution into these blocks.
- Do not use `DashboardHeader` for settings pages.
- Do not use `ChromeFrame` as a decorative card.

Tags: dashboard, document, session, automation, command, dialog, shell

Wrong turns:

- Do not use EmptyLine for error messages; use Notice with error tone.
- Do not use Notice for empty states; use EmptyLine.
- Do not use Notice for critical blocking errors; use Dialog.

Tags: empty, state, notice, alert, banner, feedback

### Container vs Presenter Pattern

All blocks are **presenters**. They own visual layout, states, responsive behavior, and accessibility.

**Container responsibilities** (in `packages/butler-app/client/ui/src/components`):

- Fetch or select domain data from stores
- Map domain types to block props
- Provide app copy for labels, messages, and descriptions
- Supply event handlers that execute domain logic
- Choose appropriate blocks based on context

**Presenter responsibilities** (blocks in `@/butler-ds/blocks`):

- Render semantic UI with prop-driven variants
- Manage local UI state (hover, expanded, etc.) only when not domain-critical
- Provide accessible markup and ARIA attributes
- Respond to viewport changes
- Compose from DS primitives

When refactoring a mixed component, extract the visual layer into a block presenter and keep domain logic in a container wrapper.

## CSS Ownership Map

Use this map before adding a stylesheet:

| CSS Owner            | Allowed                                                                                                                                         | Not Allowed                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `tokens.css`         | Palette/semantic tokens, typography roles, spacing/radius/elevation/motion tokens, theme classes, reset, `.sr-only`, `.drag-region`, `.no-drag` | Component `[data-slot]` internals, app-domain classes, product layout, component keyframes |
| Primitive CSS module | One primitive's implementation, Radix/shadcn wrapper classes, state scoped to owned classes                                                     | App-specific variants, product copy, broad `:global` patches                               |
| Block CSS module     | Reusable presenter structure composed from primitives                                                                                           | Domain data, store state, app routes, app commands                                         |
| Product container    | Shell-specific layout only when it cannot be a reusable block                                                                                   | Reusable visual structure, imported legacy component CSS, bridge style maps                |

If a style would be useful in two product surfaces, make or use a block. If a
style describes a single primitive's internals, keep it with that primitive. If
it describes global meaning, make it a token.

## New Component Checklist

Create a new design-system component only when all are true:

- The pattern is reusable across at least two product surfaces.
- Existing components cannot express it through composition.
- The API can stay domain-neutral.
- It can be rendered in the design-system workbench.
- It can be documented with wrong-use alternatives.

When the pattern is domain-specific, create a domain component under `packages/butler-app/client/ui/src/components` and compose `@/butler-ds`.

## Agent Quality Gates

Run the smallest gate set that covers the change:

- Documentation or skill map changes: `bun test tests/unit/app-client-design.test.ts`
  and Project Ledger check.
- Primitive or block API changes: design test, typecheck, `bun run lint:design`,
  and the component's `bun run render <Name>` screenshot.
- CSS changes: add `bun run lint:css`.
- Product adoption changes: design test, typecheck, relevant app test or smoke,
  and a render check for affected DS components.

Do not mark a stage complete until its Project Ledger task records validation
and review evidence.

## Future Search Upgrade

Do not build RAG until this map and component READMEs are no longer enough. Upgrade later when there are repeated misses, many more components, or a need for semantic retrieval across examples. The first upgrade should be a generated static index from README headings and tags before any vector database.
