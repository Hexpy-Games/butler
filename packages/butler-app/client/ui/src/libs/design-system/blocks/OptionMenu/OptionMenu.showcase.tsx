import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { ChevronRight, Eye, FileText, ImageIcon, ListChecks, MessageSquarePlus, Paperclip, ShieldCheck, ShieldQuestion, X } from "../../components/Icons";
import { Inline } from "../../components/Inline";
import { OptionMenu, OptionMenuItem, OptionMenuSection } from "./OptionMenu";

export const meta: ShowcaseMeta = {
  title: "OptionMenu",
  category: "Navigation",
  tags: ["menu", "composer", "popover", "chooser"],
  status: "stable",
};

const labels = {
  "en-US": {
    add: "Add to message", attachments: "Attachments", documents: "Project documents", attach: "Attach file",
    attachImage: "Attach image", noImages: "Model doesn't accept images",
    mode: "Response mode", normal: "Normal", plan: "Plan", permission: "Permission",
    full: "Full access", fullHint: "Can read files, write files, and run commands",
    ask: "Ask first", askHint: "Ask before changing files or running commands",
    read: "Read only", readHint: "Can only read files",
    allowed: "Allowed in this conversation", revoke: "Revoke: run bun test", revokeHint: "Allowed once at 14:02",
  },
  "ko-KR": {
    add: "메시지에 추가", attachments: "첨부", documents: "프로젝트 문서", attach: "파일 첨부",
    attachImage: "이미지 첨부", noImages: "이미지 미지원 모델",
    mode: "응답 방식", normal: "일반", plan: "계획", permission: "권한",
    full: "전체 권한", fullHint: "파일을 읽고 쓰고 명령을 실행할 수 있습니다",
    ask: "먼저 묻기", askHint: "파일을 바꾸거나 명령을 실행하기 전에 묻습니다",
    read: "읽기 전용", readHint: "파일을 읽기만 합니다",
    allowed: "이 대화에서 허용됨", revoke: "허용 취소: bun test 실행", revokeHint: "14:02에 한 번 허용함",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** AccessModeMenu: block descriptions, tones per mode. */
function PermissionMenu({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  return (
    <OptionMenu title={copy.permission}>
      <OptionMenuItem selected icon={<ShieldCheck size="md" />} tone="warning" label={copy.full} description={copy.fullHint}
        descriptionPlacement="block" permissionTone="full" />
      <OptionMenuItem icon={<ShieldQuestion size="md" />} tone="accent" label={copy.ask} description={copy.askHint}
        descriptionPlacement="block" permissionTone="ask" />
      <OptionMenuItem icon={<Eye size="md" />} label={copy.read} description={copy.readHint} descriptionPlacement="block"
        permissionTone="read" />
    </OptionMenu>
  );
}

export const stories: ShowcaseStory[] = [
  {
    // ComposerAttachmentMenu: the composer "+" menu.
    name: "Composer add menu",
    render: (context) => {
      const copy = text(context);
      return (
        <OptionMenu title={copy.add} size="fit">
          <OptionMenuSection title={copy.attachments}>
            <OptionMenuItem icon={<FileText size="md" />} label={copy.documents} description={<ChevronRight size="sm" />} />
            <OptionMenuItem icon={<Paperclip size="md" />} label={copy.attach} />
            <OptionMenuItem icon={<ImageIcon size="md" />} label={copy.attachImage} />
          </OptionMenuSection>
          <OptionMenuSection title={copy.mode}>
            <OptionMenuItem selected icon={<MessageSquarePlus size="md" />} label={copy.normal} />
            <OptionMenuItem icon={<ListChecks size="md" />} label={copy.plan} />
          </OptionMenuSection>
        </OptionMenu>
      );
    },
  },
  {
    // ComposerAttachmentMenu with a text-only model: the image option explains itself on hover.
    name: "Composer add menu, text-only model",
    render: (context) => {
      const copy = text(context);
      return (
        <OptionMenu title={copy.add} size="fit">
          <OptionMenuSection title={copy.attachments}>
            <OptionMenuItem icon={<Paperclip size="md" />} label={copy.attach} />
            <OptionMenuItem icon={<ImageIcon size="md" />} label={copy.attachImage} disabledReason={copy.noImages} />
          </OptionMenuSection>
        </OptionMenu>
      );
    },
  },
  {
    name: "Access menu with grants",
    widths: ["320", "375", "app"],
    render: (context) => (
      <Inline gap="2xl" cross="start" wrap>
        <PermissionMenu context={context} />
        <OptionMenu title={text(context).allowed}>
          <OptionMenuItem icon={<X size="md" />} tone="muted" label={text(context).revoke} description={text(context).revokeHint} />
        </OptionMenu>
      </Inline>
    ),
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "selected", "disabled"],
  render: (context) => (
    <OptionMenuItem disabled={context.state === "disabled"} icon={<Paperclip size="md" />} label={text(context).attach}
      selected={context.state === "selected"} />
  ),
};
