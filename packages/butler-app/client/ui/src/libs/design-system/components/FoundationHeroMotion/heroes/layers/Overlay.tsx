import { useId, type CSSProperties } from "react";
import { DialogForm } from "../../../../blocks/DialogForm";
import { cn } from "../../../../lib/utils";
import type { OverlayPart } from "./LayersOverlays";
import tip from "../../../../shadcn/ui/tooltip.module.css";
import { Button } from "../../../Button";
import { ButtonContainer } from "../../../ButtonContainer";
import dialog from "../../../Dialog/Dialog.module.css";
import { Field, FieldLabel } from "../../../Field";
import { CheckIcon, XIcon } from "../../../Icons";
import { Input } from "../../../Input";
import { SelectButton } from "../../../Select";
import select from "../../../Select/Select.module.css";
import { Textarea } from "../../../Textarea";
import { tintedGlassSurfaceClassName } from "../../../TintedGlass";
import { PICKED, type LayersCopy } from "./layersCopy";
import s from "./LayersHero.module.css";

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
