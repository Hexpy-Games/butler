import { useRef, type ComponentProps, type ReactNode } from "react";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { IconSlot } from "../../components/IconSlot";
import { ArrowLeft, ArrowRight } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { prefersReducedMotion } from "../../lib/motion";
import { dsClass } from "../../lib/internal";
import { SetupWizardContent, SetupWizardProgress, type SetupWizardStep } from "../SetupWizardShell";
import styles from "./SetupWizardStepCard.module.css";

export interface SetupWizardStepCardProps {
  /** One 20px glyph (an `lg` icon, ProviderLogo or ButlerThinkingMark); it stands on its own, with no tile. */
  icon: ReactNode;
  title: ReactNode;
  /** Id of the title heading, for focus after a step change and for `aria-labelledby`. */
  titleId?: string;
  titleAs?: "h1" | "h2";
  /** One line under the title. */
  description?: ReactNode;
  /** The flow's steps; the indicator shows at the end of the header row. */
  steps?: SetupWizardStep[];
  activeIndex?: number;
  progressLabel?: string;
  /** Shows the back action at the start of the header row. */
  onBack?: () => void;
  backLabel?: string;
  /** A new key fades in the title, body and footer; the card frame and header stay. */
  contentKey?: string;
  /** Status or a quiet link at the start of the footer row. */
  footerStart?: ReactNode;
  /** `SetupWizardStepAction`s at the end of the footer row; the forward action comes last. */
  actions?: ReactNode;
  children?: ReactNode;
}

/**
 * One step of a focus-variant setup flow: header row (back · steps), a title
 * with its glyph on the first line, the step's content and a footer row
 * (status · right-aligned large actions). Always the wide (520px) solid card.
 */
export function SetupWizardStepCard({
  icon, title, titleId, titleAs = "h1", description, steps, activeIndex = 0, progressLabel,
  onBack, backLabel, contentKey, footerStart, actions, children,
}: SetupWizardStepCardProps) {
  const firstKey = useRef(contentKey);
  const fade = useRef(false);
  if (contentKey !== firstKey.current && !fade.current) fade.current = !prefersReducedMotion();
  const header = onBack || steps;
  return (
    <SetupWizardContent width="wide" surface="solid">
      {header ? (
        <Stack align="row" justify={onBack ? "between" : "end"} cross="center" gap="md" data-slot="setup-step-header">
          {onBack ? <Button iconStart={<ArrowLeft size="md" />} size="sm" text={backLabel} type="button" variant="inline" onClick={onBack} /> : null}
          {steps ? <SetupWizardProgress activeIndex={activeIndex} ariaLabel={progressLabel} steps={steps} /> : null}
        </Stack>
      ) : null}
      <Stack className={dsClass(fade.current ? styles.bodyEnter : undefined)} gap="lg" key={contentKey} data-motion={fade.current ? "enter" : undefined} data-slot="setup-step-body">
        <Stack align="row" cross="start" gap="sm">
          <span aria-hidden="true" className={styles.glyph}><IconSlot size="lg" minHeight="line">{icon}</IconSlot></span>
          <Stack gap="xs" minWidth="0">
            <Typo.H4 as={titleAs} id={titleId} tabIndex={-1}>{title}</Typo.H4>
            {description ? <Typo.Body tone="secondary">{description}</Typo.Body> : null}
          </Stack>
        </Stack>
        {children}
        {footerStart || actions ? (
          <Stack align="row" justify="between" cross="center" gap="md" data-slot="setup-step-footer">
            <Stack grow minWidth="0">{footerStart}</Stack>
            {actions ? <ButtonContainer size="lg" justify="end">{actions}</ButtonContainer> : null}
          </Stack>
        ) : null}
      </Stack>
    </SetupWizardContent>
  );
}

export interface SetupWizardStepActionProps extends Omit<ComponentProps<typeof Button>, "size" | "iconEnd" | "stretch"> {
  /** The action that moves the flow on: primary, with a trailing ›. */
  forward?: boolean;
}

/** A footer action of a setup step: large and content-width; `forward` adds the trailing › and the primary look. */
export function SetupWizardStepAction({ forward = false, variant, type = "button", ...props }: SetupWizardStepActionProps) {
  return (
    <Button
      iconEnd={forward ? <ArrowRight size="md" /> : undefined}
      size="lg"
      type={type}
      variant={variant ?? (forward ? "default" : "outline")}
      {...props}
    />
  );
}
