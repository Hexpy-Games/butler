# SetupWizardStepCard

## What is this component
One step of a focus-variant setup flow, in the wide (520px) solid card of
`SetupWizardContent`:

1. **Header row**: the back action (`onBack`, `backLabel`, inline `ArrowLeft`)
   at the start and the step indicator (`steps`, `activeIndex`,
   `progressLabel`, rendered by `SetupWizardProgress`) at the end.
2. **Title row**: one 20px glyph with no tile (`icon`), centered on the H4
   title's first line, then the title and an optional one-line description.
3. **Content**: `children`.
4. **Footer row**: `footerStart` (status, a quiet link) at the start and
   `actions` at the end in a large `ButtonContainer`.

`SetupWizardStepAction` is the footer button: large and content-width;
`forward` makes it primary with a trailing `ArrowRight`. Put the forward action
last. Never stretch it.

## When to use this component
Every step after the intro of a first-run or setup flow, including sub-steps
(sign-in, API key, model pick) that keep the flow's header and footer.

## Where to use this component
Inside `SetupWizardShell variant="focus"`, ideally with `anchor="top"` so every
step shares one top edge.

## Why to use this component
It fixes one alignment line, one header, one action placement and one back
affordance across all steps; product screens only pass content.

## How to use this component
```tsx
<SetupWizardShell variant="focus" anchor="top" stepKey="steps" title="Butler">
  <SetupWizardStepCard
    steps={steps} activeIndex={1} progressLabel="Setup steps"
    onBack={backToIntro} backLabel="Back"
    icon={<ShieldCheck size="lg" />} title="Before you start" titleId="setup-step-title"
    contentKey="consent"
    footerStart={<PrepStatus />}
    actions={<><SetupWizardStepAction text="Decline" /><SetupWizardStepAction forward text="Agree and continue" /></>}
  >
    {items}
  </SetupWizardStepCard>
</SetupWizardShell>
```

### Motion
- `contentKey`: a new key fades in the title, content and footer
  (`--motion-base`, opacity only). The card frame, its width and the header row
  stay. The first render never animates, and nothing animates under reduced
  motion.
- Use `SetupWizardShell stepKey` to swap whole cards (intro 420px → steps
  520px): the old card fades out while the new one rises in on the same top
  edge. Widths never animate.

## Who can use this component
First-run setup and any later setup flow that uses the focus shell.

## Best practice
- Derive the title from state (Sign in to ChatGPT → Connected to ChatGPT).
- Keep status in `footerStart` or a neutral `Notice`, not in a banner.
- Only forward actions get the ›.

## Wrong use cases
- The intro or welcome screen: use `SetupWizardContent` with its own centered
  composition.
- A grey `IconTile` behind the title glyph, or a stretched primary button.

## Tags
setup, wizard, step, first-run, onboarding
