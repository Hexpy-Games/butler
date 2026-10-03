import type { CSSProperties, ReactNode } from "react";
import { ComposerCard, ComposerCardTextarea, ComposerCardToolbar, ComposerCardToolbarSpacer, ComposerSendButton } from "../../blocks/ComposerCard";
import { MessageRow } from "../../blocks/MessageRow";
import { NavRow } from "../../blocks/NavRow";
import { NavSection } from "../../blocks/NavSection";
import { WorkActivityBlock } from "../../blocks/WorkActivityBlock";
import { IconButton } from "../../components/IconButton";
import { FileText, GeneralChat, MoreHorizontal, Notebook, PanelRight, Plus, Search } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Tag } from "../../components/Tag";
import { Typo } from "../../components/Typo";
import type { ShowcaseRenderContext } from "../../showcase";
import type { SidebarDensity } from "../../blocks/SidebarShell";
import styles from "../DesignSystemViewer.module.css";

export type AssembleStage = "screen" | "tokens" | "components" | "blocks";

const COPY = {
  "en-US": {
    chats: "Chats", general: "General", projects: "Projects", sessions: ["Token page review", "Settings S7", "Motion trace"],
    title: "Token page review", ask: "Make the token pages generated from tokens.css.", work: "Reading tokens.css", search: "Search",
    answer: "Done: every token in tokens.css, light and dark side by side.", placeholder: "Ask for follow-up changes", plan: "Plan 2/4",
  },
  "ko-KR": {
    chats: "채팅", general: "일반", projects: "프로젝트", sessions: ["토큰 페이지 검토", "설정 S7", "모션 추적"],
    title: "토큰 페이지 검토", ask: "토큰 페이지를 tokens.css에서 생성해 줘.", work: "tokens.css 읽는 중", search: "검색",
    answer: "완료: tokens.css의 모든 토큰을 라이트와 다크로 나란히 보여 줍니다.", placeholder: "후속 변경사항 요청", plan: "계획 2/4",
  },
} as const;

function Part({ layer, label, children, index }: { layer: "token" | "component" | "block"; label: string; children: ReactNode; index: number }) {
  return (
    <div className={styles.part} data-label={label} data-layer={layer} style={{ "--part-index": index } as CSSProperties}>
      {children}
    </div>
  );
}

/** A Butler conversation screen made only of DS pieces; the stage x-rays one layer. */
export function AssembledScreen({ context, stage, density, run }: {
  context: ShowcaseRenderContext; stage: AssembleStage; density: SidebarDensity; run: number;
}) {
  const copy = COPY[context.locale];
  return (
    <div className={styles.stageFrame} data-stage={stage} key={run} data-ds-assemble={stage}>
      <div className={styles.stage} data-sidebar-density={density}>
        <aside className={styles.stageSidebar}>
          <Part index={0} label="NavSection" layer="block">
            <NavSection title={copy.chats}><NavRow icon={<GeneralChat size="md" />} label={copy.general} active /></NavSection>
          </Part>
          <Part index={1} label="NavRow" layer="block">
            <NavSection title={copy.projects}>
              {copy.sessions.map((session) => <NavRow icon={<Notebook size="md" />} key={session} label={session} />)}
            </NavSection>
          </Part>
        </aside>
        <div className={styles.stageMain}>
          <Stack align="row" cross="center" justify="between" gap="sm">
            <Part index={2} label="Typo.PanelTitle" layer="component"><Typo.PanelTitle>{copy.title}</Typo.PanelTitle></Part>
            <Part index={3} label="--accent · --space-xs" layer="token">
              <div className={styles.swatchStrip}>
                {["--accent", "--color-success", "--color-warning", "--text-secondary"].map((name) => (
                  <span className={styles.swatchDot} key={name} style={{ "--swatch": `var(${name})` } as CSSProperties} />
                ))}
              </div>
            </Part>
            <Part index={4} label="IconButton" layer="component">
              <Stack align="row" gap="xs">
                <IconButton label={copy.search}><Search size="md" /></IconButton>
                <IconButton label="Inspector"><PanelRight size="md" /></IconButton>
                <IconButton label="More"><MoreHorizontal size="md" /></IconButton>
              </Stack>
            </Part>
          </Stack>
          <div className={styles.stageThread}>
            <Part index={5} label="MessageRow" layer="block"><MessageRow role="user">{copy.ask}</MessageRow></Part>
            <Part index={6} label="WorkActivityBlock" layer="block">
              <WorkActivityBlock connected density="compact" title={copy.work}
                tools={[{ id: "read", icon: <FileText size="md" />, title: "tokens.css", summaryLabel: copy.search }]} />
            </Part>
            <Part index={7} label="Tag" layer="component"><Stack align="row"><Tag tone="accent">{copy.plan}</Tag></Stack></Part>
            <Part index={8} label="MessageRow" layer="block"><MessageRow role="assistant"><Typo.Body>{copy.answer}</Typo.Body></MessageRow></Part>
          </div>
          <Part index={9} label="ComposerCard" layer="block">
            <ComposerCard onSubmit={(event) => event.preventDefault()} controls={<ComposerCardToolbar>
                <IconButton label="More options"><Plus size="md" /></IconButton>
                <ComposerCardToolbarSpacer />
                <ComposerSendButton aria-label="Send" />
              </ComposerCardToolbar>}>
              <ComposerCardTextarea aria-label={copy.placeholder} placeholder={copy.placeholder} rows={1} />

            </ComposerCard>
          </Part>
        </div>
      </div>
    </div>
  );
}
