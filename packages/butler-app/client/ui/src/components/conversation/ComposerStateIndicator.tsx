import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { ComposerCardExpandedControls, Stack, Typo } from "@/butler-ds";
import { useComposerStore } from "./composerStore";

const indicatorStyle = {
  minWidth: 0,
  flex: "1 1 auto",
  overflow: "hidden",
  color: "var(--text-tertiary)",
  whiteSpace: "nowrap",
} as const;

const fixedSegmentStyle = {
  flex: "0 0 auto",
} as const;

const modeStyle = {
  ...fixedSegmentStyle,
  color: "var(--text-secondary)",
} as const;

const separatorStyle = {
  ...fixedSegmentStyle,
  color: "var(--text-tertiary)",
} as const;

const shortcutStyle = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
} as const;

const SHORTCUT_COPY = {
  modifier_enter_send_enter_newline: () =>
    appCopy.settings.options.modifierEnterSendEnterNewline,
  enter_send_shift_enter_newline: () =>
    appCopy.settings.options.enterSendShiftEnterNewline,
} as const;

export function ComposerStateIndicator() {
  const planMode = useComposerStore((store) => store.planMode);
  const attachmentCount = useComposerStore((store) => store.attachments.length);
  const multilineSendBehavior = useButlerStore(
    (store) => store.settings.multiline_send_behavior,
  );
  const modeLabel = planMode ? appCopy.composer.plan : appCopy.composer.normal;
  const attachmentLabel =
    attachmentCount > 0
      ? appCopy.composer.attachmentCount(attachmentCount)
      : null;
  const shortcutLabel =
    SHORTCUT_COPY[multilineSendBehavior]?.() ??
    appCopy.settings.options.modifierEnterSendEnterNewline;
  const segments = [modeLabel, attachmentLabel, shortcutLabel].filter(
    (segment): segment is string => Boolean(segment),
  );

  return (
    <Stack
      align="row"
      as="div"
      aria-label={segments.join(", ")}
      cross="center"
      data-test-class="composer-state-indicator"
      gap="1"
      role="status"
      style={indicatorStyle}
    >
      <Typo.Caption
        as="span"
        data-slot="composer-state-mode"
        style={modeStyle}
      >
        {modeLabel}
      </Typo.Caption>
      {attachmentLabel ? (
        <>
          <Typo.Caption
            as="span"
            aria-hidden="true"
            style={separatorStyle}
          >
            ·
          </Typo.Caption>
          <Typo.Caption
            as="span"
            data-slot="composer-state-attachments"
            style={fixedSegmentStyle}
          >
            {attachmentLabel}
          </Typo.Caption>
        </>
      ) : null}
      <ComposerCardExpandedControls>
        <Typo.Caption
          as="span"
          aria-hidden="true"
          style={separatorStyle}
        >
          ·
        </Typo.Caption>
        <Typo.Caption
          as="span"
          data-slot="composer-state-shortcut"
          style={shortcutStyle}
        >
          {shortcutLabel}
        </Typo.Caption>
      </ComposerCardExpandedControls>
    </Stack>
  );
}
