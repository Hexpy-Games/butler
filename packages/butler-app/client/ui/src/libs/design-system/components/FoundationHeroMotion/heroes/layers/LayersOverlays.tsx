import { useId, type CSSProperties } from "react";
import { ChromeFloatingToggleLayer } from "../../../../blocks/ChromeFrame";
import { DialogForm } from "../../../../blocks/DialogForm";
import { TitlebarShell } from "../../../../blocks/TitlebarShell";
import { cn } from "../../../../lib/utils";
import tip from "../../../../shadcn/ui/tooltip.module.css";
import { Button } from "../../../Button";
import { ButtonContainer } from "../../../ButtonContainer";
import dialog from "../../../Dialog/Dialog.module.css";
import { Field, FieldLabel } from "../../../Field";
import { IconButton } from "../../../IconButton";
import { CheckIcon, MoreHorizontal, PanelLeft, PanelLeftOpen, PanelRight, XIcon } from "../../../Icons";
import { Input } from "../../../Input";
import { SelectButton } from "../../../Select";
import select from "../../../Select/Select.module.css";
import { Textarea } from "../../../Textarea";
import { tintedGlassSurfaceClassName } from "../../../TintedGlass";
import { PICKED, type LayersCopy } from "./layersCopy";
import s from "./LayersHero.module.css";

/** The sticky layer: the window chrome's sidebar toggle and the titlebar pinned over the workspace. */
export function Sticky({ copy, compact }: { copy: LayersCopy; compact: boolean }) {
  return (
    <>
      <div className={s.titlebar}>
        <TitlebarShell
          collapsed={compact}
          dragRegion
          title={copy.sessions[0]}
          trailing={
            <ButtonContainer size="icon-sm">
              <IconButton label={copy.sessionActions}>
                <MoreHorizontal size="md" />
              </IconButton>
              <IconButton label={copy.showRight}>
                <PanelRight size="md" />
              </IconButton>
            </ButtonContainer>
          }
        />
      </div>
      <ChromeFloatingToggleLayer>
        <IconButton label={copy.showLeft}>
          {compact ? <PanelLeft size="md" /> : <PanelLeftOpen size="md" />}
        </IconButton>
      </ChromeFloatingToggleLayer>
    </>
  );
}

/** The overlay layer: the dialog's scrim over the whole window. */
export function Scrim() {
  return <span className={cn(dialog.overlay, s.scrim)} data-slot="dialog-overlay" />;
}

/** The open select's list, item-aligned on its trigger as Radix places it (the picked interval over the value). */
function Menu({ copy }: { copy: LayersCopy }) {
  return (
    <div className={cn(tintedGlassSurfaceClassName, select.content, s.menu)} data-align-trigger="true" data-glass="popover" data-radius="popover" data-slot="select-content" style={{ "--picked": PICKED } as CSSProperties}>
      <div className={select.viewport} data-position="item-aligned">
        {copy.intervals.map((interval, k) => (
          <div className={cn(select.item, k === PICKED && s.hovered)} data-slot="select-item" key={interval}>
            <span className={select.indicator}>{k === PICKED ? <CheckIcon /> : null}</span>
            <span>{interval}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A tooltip as the Tooltip primitive draws it, 8px under its trigger. */
function Tip({ label }: { label: string }) {
  return (
    <span className={cn(tintedGlassSurfaceClassName, tip.tooltip, s.tip)} data-glass="popover" data-radius="control" data-slot="tooltip-content" role="tooltip">
      {label}
    </span>
  );
}

export type OverlayPart = "dialog" | "popover" | "tooltip";

/**
 * The dialog (DialogContent's surface with a DialogForm) with the select
 * opened from it and the close button's tooltip. Each of the three upper
 * sheets draws the same dialog so the menu and the tooltip sit exactly on
 * their triggers, but shows only its own part (`part`).
 */
export function Overlay({ copy, part }: { copy: LayersCopy; part: OverlayPart }) {
  const id = useId();
  return (
    <div className={s.dialogBox} data-part={part}>
      <div className={cn(tintedGlassSurfaceClassName, dialog.content)} data-glass="popover" data-layout="flow" data-radius="composer" data-size="sm" data-slot="dialog-content" data-surface="tinted-glass" role="dialog">
        <DialogForm
          title={copy.dialogTitle}
          footer={
            <ButtonContainer justify="end" size="default">
              <Button text={copy.cancel} type="button" variant="ghost" />
              <Button text={copy.create} type="button" />
            </ButtonContainer>
          }
        >
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>{copy.nameLabel}</FieldLabel>
            <Input defaultValue={copy.sessions[0]} id={`${id}-name`} />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-prompt`}>{copy.promptLabel}</FieldLabel>
            <Textarea defaultValue={copy.prompt} id={`${id}-prompt`} rows={2} />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-repeat`}>{copy.repeatLabel}</FieldLabel>
            <span className={s.anchor}>
              <SelectButton id={`${id}-repeat`}>{copy.intervals[PICKED]}</SelectButton>
              {part === "popover" ? <Menu copy={copy} /> : null}
            </span>
          </Field>
        </DialogForm>
        <span className={dialog.close}>
          <Button size="icon-sm" type="button" variant="ghost">
            <XIcon />
            <span className="sr-only">{copy.close}</span>
          </Button>
          {part === "tooltip" ? <Tip label={copy.close} /> : null}
        </span>
      </div>
    </div>
  );
}
