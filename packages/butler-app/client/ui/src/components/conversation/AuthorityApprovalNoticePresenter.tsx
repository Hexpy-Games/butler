import {
  Button,
  ButtonContainer,
  CircleAlert,
  Notice,
  Stack,
  Textarea,
  Typo,
} from "@/butler-ds";

/**
 * Pure presenter for one pending authority approval card.
 * It receives only already-bounded display strings and never sees the
 * opaque request reference or any other transport field.
 */
export function AuthorityApprovalNoticePresenter({
  allowLabel,
  denyLabel,
  error,
  meta,
  onAllow,
  onDeny,
  onModify,
  onModifyChange,
  onModifySubmit,
  pending,
  reason,
  title,
  modifyInvalid,
  modifyLabel,
  modifyOpen,
  modifyPlaceholder,
  modifySubmitDisabled,
  modifySubmitLabel,
  modifyValue,
}: {
  allowLabel: string;
  denyLabel: string;
  error?: string;
  meta: string;
  onAllow: () => void;
  onDeny: () => void;
  onModify: () => void;
  onModifyChange: (value: string) => void;
  onModifySubmit: () => void;
  pending: boolean;
  reason: string;
  title: string;
  modifyInvalid?: string;
  modifyLabel: string;
  modifyOpen: boolean;
  modifyPlaceholder: string;
  modifySubmitDisabled: boolean;
  modifySubmitLabel: string;
  modifyValue: string;
}) {
  return (
    <Notice
      icon={<CircleAlert size={18} />}
      message={
        <Stack as="span" align="column" gap="xs">
          <Typo.Body as="span">{reason}</Typo.Body>
          <Typo.Caption>{meta}</Typo.Caption>
          {error && <Typo.Caption role="status">{error}</Typo.Caption>}
        </Stack>
      }
      action={
        <Stack align="column" gap="2">
          <ButtonContainer size="sm">
            <Button disabled={pending} onClick={onAllow} size="sm" type="button">
              {allowLabel}
            </Button>
            <Button
              disabled={pending}
              onClick={onDeny}
              size="sm"
              type="button"
              variant="secondary"
            >
              {denyLabel}
            </Button>
            <Button
              disabled={pending}
              onClick={onModify}
              size="sm"
              type="button"
              variant="outline"
            >
              {modifyLabel}
            </Button>
          </ButtonContainer>
          {modifyOpen && (
            <Stack align="column" gap="2">
              <Textarea
                aria-label={modifyLabel}
                disabled={pending}
                onChange={(event) => onModifyChange(event.target.value)}
                placeholder={modifyPlaceholder}
                rows={3}
                value={modifyValue}
              />
              {modifyInvalid && (
                <Typo.Caption role="status">{modifyInvalid}</Typo.Caption>
              )}
              <Button
                disabled={pending || modifySubmitDisabled}
                onClick={onModifySubmit}
                size="sm"
                type="button"
              >
                {modifySubmitLabel}
              </Button>
            </Stack>
          )}
        </Stack>
      }
      title={title}
      tone="info"
    />
  );
}
