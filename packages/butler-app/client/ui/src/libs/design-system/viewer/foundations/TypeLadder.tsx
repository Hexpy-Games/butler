import { CopyButton } from "../../components/CopyButton";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { tokenCatalog } from "./catalog";
import { px, useComputed } from "./measure";
import { roleComponentName, roleCopy, RoleText, type SampleLocale } from "./typeRoles";
import { typeRoles, type TypeRole } from "./typeScale";
import f from "./Foundations.module.css";

interface Applied { size: number; lineHeight: number; weight: string; tracking: number }

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <div className={f.specCell}>
      <Typo.Caption tone="tertiary">{label}</Typo.Caption>
      <Typo.Label as="span" numeric="tabular">{value}</Typo.Label>
    </div>
  );
}

/** One rung: the sample is set in the role, the spec is read back from it. */
function Rung({ role, locale }: { role: TypeRole; locale: SampleLocale }) {
  const [ref, applied] = useComputed<HTMLElement, Applied>((_, style) => ({
    size: px(style.fontSize), lineHeight: px(style.lineHeight), weight: style.fontWeight, tracking: px(style.letterSpacing),
  }));
  const copy = roleCopy(role.role);
  const other: SampleLocale = locale === "en" ? "ko" : "en";
  const steps = role.steps.map((step) => `${step.name.replace(`${role.prefix}-size-`, "")} ${step.light}`);
  return (
    <div className={f.rung} id={`type-${role.role}`} data-ds-type-role={role.role}>
      <div className={f.rungSample}>
        <RoleText lineBoxes lang={locale} ref={ref} role={role}>{copy[locale]}</RoleText>
        <RoleText lang={other} role={role}>{copy[other]}</RoleText>
      </div>
      <div className={f.rungSpec}>
        <Stack align="row" cross="center" justify="between" gap="xs">
          <Typo.Code truncate>{`${role.prefix}-*`}</Typo.Code>
          <CopyButton text={`var(${role.size.name})`} label={`Copy var(${role.size.name})`} copiedLabel="Copied" />
        </Stack>
        <div className={f.specGrid}>
          <Spec label="Size" value={applied ? `${applied.size}` : role.size.light} />
          <Spec label="Leading" value={applied ? `${applied.lineHeight} · ${role.lineHeight?.light ?? ""}` : role.lineHeight?.light ?? ""} />
          <Spec label="Weight" value={applied?.weight ?? role.weight?.light ?? ""} />
          <Spec label="Tracking" value={applied ? `${applied.tracking}` : role.letterSpacing?.light ?? "0"} />
        </div>
        <Typo.Caption tone="secondary">
          {[roleComponentName(role.role), copy.use, role.compact ? `touch ${role.compact}` : "", steps.length ? `steps ${steps.join(", ")}` : ""].filter(Boolean).join(" · ")}
        </Typo.Caption>
      </div>
    </div>
  );
}

/** Every --typo-* role, largest first, each rendered in its own style. */
export function TypeLadder({ locale }: { locale: SampleLocale }) {
  const roles = typeRoles(tokenCatalog);
  return (
    <div className={f.ladder} data-ds-type-ladder={roles.length}>
      <div className={f.ladderLegend} aria-hidden="true">
        <Typo.Caption tone="tertiary">Specimen · lines show the leading</Typo.Caption>
        <Typo.Caption tone="tertiary">px as applied at this width</Typo.Caption>
      </div>
      {roles.map((role) => <Rung key={role.role} locale={locale} role={role} />)}
    </div>
  );
}
