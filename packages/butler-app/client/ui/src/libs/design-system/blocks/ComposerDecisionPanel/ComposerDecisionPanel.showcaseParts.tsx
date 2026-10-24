import type { ShowcaseRenderContext } from "../../showcase";
import { getAppCopy } from "../../../../../../../../butler-i18n/src/locale.ts";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Lock, ShieldCheck, Square } from "../../components/Icons";
import { Tag } from "../../components/Tag";
import { LIVE_PAGES, demoTabs } from "../LiveTabCard/fixtures";
import { LiveTabFrame } from "../LiveTabCard/LiveTabFrame";
import { useDemoFrame } from "../LiveTabCard/liveTabDemo";
import { SplitButton } from "../SplitButton";
import { ComposerDecisionPanel, type ComposerDecisionPanelProps } from "./ComposerDecisionPanel";

const words = {
  "en-US": { eyebrow: "Permission", click: "Click ‘Book now’", detail: "Pine Grove Campground · Oct 20 and 22, deck site, 2 nights · $84", medium: "Medium risk",
    deny: "Deny", once: "Allow once", scope: "Allow scope", conversation: "Always allow in this conversation", open: "Open tab" },
  "ko-KR": { eyebrow: "권한", click: "‘예약하기’ 버튼 클릭", detail: "가평 솔숲 캠핑장 · 10월 20일, 22일 데크 2박 · 110,000원", medium: "위험 보통",
    deny: "거절", once: "이번만 허용", scope: "허용 범위", conversation: "이 대화에서 계속 허용", open: "탭 열기" },
} as const;

/** A browser-action approval with the tab's frame as `media`: one decoded ImageBitmap, as the App draws it (static while the decision waits). */
export function BrowserApproval({ locale, placement }: ShowcaseRenderContext & Pick<ComposerDecisionPanelProps, "placement">) {
  const text = words[locale];
  const tab = demoTabs(locale)[0]!;
  const frame = useDemoFrame(LIVE_PAGES.bookingApproval);
  return (
    <ComposerDecisionPanel placement={placement} icon={<ShieldCheck aria-hidden="true" size="lg" />} eyebrow={text.eyebrow} title={text.click} onOpen={() => undefined}
      details={[text.detail]} aside={<Tag tone="warning">{text.medium}</Tag>}
      media={{ content: <LiveTabFrame frame={frame} favicon={tab.favicon} />, label: `${text.open} · ${tab.title}`, onOpen: () => undefined }}
      actions={<ButtonContainer size="sm" justify="end">
        <Button type="button" size="sm" variant="secondary">{text.deny}</Button>
        <SplitButton size="sm" text={text.once} onClick={() => undefined} menuLabel={text.scope} menuSide="top"
          items={[{ key: "conversation", label: text.conversation, onSelect: () => undefined }]} />
      </ButtonContainer>} />
  );
}

/** A sign-in hand-off: the page thumbnail, Stop task and the renamed primary action 열어서 확인 / Open to check. */
export function BrowserHandoff({ locale }: ShowcaseRenderContext) {
  const copy = getAppCopy(locale);
  const handoff = copy.interfaceTemplates.approvalRequest.signInHandoff;
  const tab = demoTabs(locale)[1]!;
  return (
    <ComposerDecisionPanel icon={<Lock aria-hidden="true" size="lg" />} eyebrow={handoff.eyebrow} title={handoff.title} onOpen={() => undefined}
      details={[`${tab.site} · ${copy.browser.mfa}`, handoff.inTab]}
      media={{ content: <LiveTabFrame frame={LIVE_PAGES.sitesSignIn} favicon={tab.favicon} />, label: `${copy.browser.rail.openToCheck} · ${tab.title}`, onOpen: () => undefined }}
      actions={<ButtonContainer size="sm" justify="end">
        <Button type="button" size="sm" variant="secondary" iconStart={<Square size="sm" />} text={handoff.stop} />
        <Button type="button" size="sm">{copy.browser.rail.openToCheck}</Button>
      </ButtonContainer>} />
  );
}
