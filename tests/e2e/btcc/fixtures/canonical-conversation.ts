const SANDY_INLINE_VOICE_REQUEST =
  "이제 잘된다! 잘했어. 그런데 이제 음성이 Wav파일이라 그런지 그냥 첨부파일로 붙어버리네. 물론재생 컨트롤은 나오지만 파일이름 없이 재생컨트롤만 나오는 그런 음성메시지로 보낼 수 있는 방법은 없는지 알아봐줄래";

const SANDY_PRIOR_CONVERSATION = [
  "# Sanitized prior conversation",
  "",
  "Project: Sandy bot",
  "Messaging transport: Discord",
  "Prior result: Sandy can now generate playable Korean voice audio and attach it to Discord replies.",
  "Current limitation: Discord renders the generated WAV as a normal named attachment.",
  "The next request asks whether Discord can render it as an inline voice message with playback controls and no filename.",
].join("\n");

export function canonicalLocalMessage(messageRef: string): string | undefined {
  if (messageRef === "app-message:client-5eb83daa-8441-4e0c-9489-126f1684f4b6") {
    return SANDY_INLINE_VOICE_REQUEST;
  }
  return undefined;
}

export function priorConversationFixture(fixtureRef: string): string | undefined {
  if (fixtureRef === "FIXTURE-SANDY-PREVIOUS-FAILURE-V1") {
    return SANDY_PRIOR_CONVERSATION;
  }
  return undefined;
}
