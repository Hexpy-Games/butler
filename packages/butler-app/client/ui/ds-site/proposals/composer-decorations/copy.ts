/**
 * Proposed product copy. In the app these live in packages/butler-i18n under
 * `settings.composerDecoration.*` (the key is noted on each line); the composer strings are the
 * existing keys the product composer reads (noted per line). Mirrored here because the proposal
 * changes no product files.
 */
export const COPY = {
  en: {
    // settings.composerDecoration.*
    label: "Message box background",
    description: "Art behind your text. Follows the wallpaper motion settings.",
    none: "None",
    shoreline: "Shoreline",
    cherryBlossom: "Cherry blossom",
    character: "Character",
    characterDescription: "A small friend on top of the message box.",
    // composer.placeholder, composer.messageComposer, composer.featureDrawer, composer.send
    placeholder: "Ask Butler anything",
    messageComposer: "Message composer",
    more: "More options",
    send: "Send",
    // composer.permission + permissions.askFirst (AccessModeMenu)
    permission: "Permission",
    askFirst: "Ask first",
    // ModelMenu: model display name + reasoning label (reasoningLabel("medium"))
    model: "GPT-5.1",
    reasoning: "Medium",
  },
  ko: {
    label: "입력창 배경",
    description: "글자 뒤에 그림을 깝니다. 움직임은 월페이퍼 설정을 따릅니다.",
    none: "없음",
    shoreline: "해안선",
    cherryBlossom: "벚꽃",
    character: "캐릭터",
    characterDescription: "입력창 위에 작은 친구가 앉습니다.",
    placeholder: "Butler에게 무엇이든 물어보세요",
    messageComposer: "메시지 입력",
    more: "추가 기능",
    send: "전송",
    permission: "권한",
    askFirst: "먼저 확인",
    model: "GPT-5.1",
    reasoning: "중간",
  },
} as const;

export type ProposalLocale = keyof typeof COPY;
export type ProposalCopy = (typeof COPY)[ProposalLocale];
