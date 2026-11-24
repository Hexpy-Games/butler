import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { Button, ButtonContainer, Clock3, Input, ListRow, NativeSelect, NativeSelectOption, Notice, Presence, Section, Skeleton, Spinner, Stack, UserRound } from "@/butler-ds";
import type { useCanonOnlineDialog } from "./useCanonOnlineDialog.ts";

export function CanonOnlineMembers({ state, owner }: { state: ReturnType<typeof useCanonOnlineDialog>; owner: boolean }) {
  const copy = appCopy.canon.online;
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const { members, loadFailed, busy, account } = state;
  const disabled = Boolean(busy);
  const canInvite = email.includes("@") && !disabled;
  const invite = () => { if (canInvite) void state.invite(email, role, () => setEmail("")); };
  const roles = (["editor", "viewer"] as const).map(role => (
    <NativeSelectOption key={role} value={role}>{copy.roles[role]}</NativeSelectOption>
  ));
  return <Section title={copy.members}>
    <Stack gap="sm">
      {loadFailed ? <Notice tone="error" message={copy.loadFailed} action={
        <Button variant="outline" disabled={disabled} onClick={() => void state.reload()}>{appCopy.feedback.retry}</Button>
      } /> : !members ? <><Skeleton height="row" /><Skeleton height="row" /></> : <>
        {members.members.map(member => {
          const me = member.account_id === account.accountId;
          return <Presence key={member.account_id} present motion="fade">
            <Stack align="row" cross="center" gap="sm" wrap>
              <Stack grow minWidth="0"><ListRow icon={<UserRound size="md" />} title={member.email}
                description={me ? `${copy.roles[member.role]} · ${appCopy.canon.me}` : copy.roles[member.role]} /></Stack>
              {owner && member.role !== "owner" && !me && <>
                <NativeSelect size="sm" aria-label={copy.roleOf(member.email)} value={member.role} disabled={disabled}
                  onChange={event => void state.setRole(member.account_id, event.target.value as "editor" | "viewer")}>{roles}</NativeSelect>
                <Button size="sm" variant="outline" disabled={disabled}
                  iconStart={busy === member.account_id ? <Spinner size={14} /> : undefined}
                  onClick={() => void state.remove(member.account_id, member.email)}>{copy.remove}</Button>
              </>}
            </Stack>
          </Presence>;
        })}
        {members.invites.map(invite => <Presence key={invite.id} present motion="fade">
          <Stack align="row" cross="center" gap="sm" wrap>
            <Stack grow minWidth="0"><ListRow icon={<Clock3 size="md" />} title={invite.email}
              description={copy.invited(copy.roles[invite.role])} /></Stack>
            {owner && <Button size="sm" variant="outline" disabled={disabled}
              iconStart={busy === invite.id ? <Spinner size={14} /> : undefined}
              onClick={() => void state.revoke(invite.id)}>{copy.revokeInvite}</Button>}
          </Stack>
        </Presence>)}
        {owner && <Stack align="row" gap="sm" wrap>
          <Stack grow minWidth="0"><Input type="email" aria-label={copy.email} placeholder={copy.email}
            value={email} disabled={disabled} onChange={event => setEmail(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); invite(); }
            }} /></Stack>
          <NativeSelect aria-label={copy.roleLabel} value={role} disabled={disabled}
            onChange={event => setRole(event.target.value as "editor" | "viewer")}>{roles}</NativeSelect>
          <Button size="lg" disabled={!canInvite} iconStart={busy === "invite" ? <Spinner size={14} /> : undefined}
            onClick={invite}>{copy.invite}</Button>
        </Stack>}
      </>}
      {!owner && <ButtonContainer size="sm" justify="end">
        <Button size="sm" variant="outline" disabled={disabled} iconStart={busy === "leave" ? <Spinner size={14} /> : undefined}
          onClick={() => void state.leave()}>{copy.leave}</Button>
      </ButtonContainer>}
    </Stack>
  </Section>;
}
