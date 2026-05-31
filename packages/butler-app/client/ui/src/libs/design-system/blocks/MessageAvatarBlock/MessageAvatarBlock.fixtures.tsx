import { Sparkles } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { MessageAvatarBlock } from "./MessageAvatarBlock";

export function MessageAvatarBlockFixture() {
  return (
    <Stack align="row" gap="sm">
      <MessageAvatarBlock active><Sparkles size={15} /></MessageAvatarBlock>
      <MessageAvatarBlock role="user" />
      <MessageAvatarBlock role="system" />
    </Stack>
  );
}
