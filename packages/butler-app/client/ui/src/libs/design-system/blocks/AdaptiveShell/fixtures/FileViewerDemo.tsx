import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Box } from "../../../components/Box";
import { Button } from "../../../components/Button";
import { ButtonContainer } from "../../../components/ButtonContainer";
import { IconButton } from "../../../components/IconButton";
import { Expand, FileText, ImageIcon, Library, X } from "../../../components/Icons";
import { PageContainer } from "../../../components/PageContainer";
import { Separator } from "../../../components/Separator";
import { Stack } from "../../../components/Stack";
import { Typo } from "../../../components/Typo";
import { ArtifactPreview, ArtifactPreviewImage, ArtifactPreviewPre } from "../../ArtifactPreview";
import { MarkdownContent } from "../../MarkdownContent";
import { ScrollArea } from "../../ScrollArea";
import { TabStrip } from "../../TabStrip";
import { demoLabels } from "../../TabStrip/TabStrip.demo";
import { AdaptiveShellCard } from "../index";

type Locale = "en-US" | "ko-KR";
export type FileViewerKind = "markdown" | "code" | "image" | "short";

const CODE = `// Global shortcuts wait while an IME is composing: Cmd+K mid-composition must not
// open the palette or drop the pending syllable.
export function shouldHandleShortcut(event: KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
}`;

const IMAGE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1240' height='700' viewBox='0 0 1240 700'%3E%3Crect width='1240' height='700' fill='%231d1e22'/%3E%3Crect x='330' y='136' width='580' height='320' rx='14' fill='%232f3036' stroke='%23464851'/%3E%3Crect x='342' y='210' width='556' height='40' rx='8' fill='%23404149'/%3E%3Crect x='232' y='580' width='776' height='66' rx='18' fill='%232a2b30' stroke='%23464851'/%3E%3Crect x='620' y='542' width='360' height='34' rx='6' fill='%23de4545'/%3E%3C/svg%3E";

const COPY = {
  "en-US": {
    files: { markdown: "release-notes.md", code: "ime-guard.ts", image: "shortcut-clash.png", short: "todo.txt" },
    meta: { markdown: "document / 1.4 KB · now", code: "code / 612 B · now", image: "image / 277.6 KB · now", short: "text / 32 B · now" },
    markdown: "# Release notes\n\n## New\n\n- **Session info**: pending requests, tasks, results and context beside the chat.\n- **Task draft card**: register or revise a draft Butler made, in place.\n\n## Fixed\n\n1. Cmd+K no longer drops a syllable mid-composition.\n2. Search results sort by last edit.\n\n> A very long context can slow the first reply after compaction.\n\n| Item | Before | Now |\n| --- | --- | --- |\n| Session info | Inspector tab | Chat margin |\n| Context | 12 lines | 5 lines |",
    short: "Ship the viewer after review.",
    files_: "Files", open: "Open in Library", save: "Save", close: "Close file", enlarge: "Enlarge",
  },
  "ko-KR": {
    files: { markdown: "릴리스-노트.md", code: "ime-guard.ts", image: "단축키-충돌.png", short: "할일.txt" },
    meta: { markdown: "document / 1.4 KB · 지금", code: "code / 612 B · 지금", image: "image / 277.6 KB · 지금", short: "text / 32 B · 지금" },
    markdown: "# 릴리스 노트\n\n## 새 기능\n\n- **세션 정보**: 답을 기다리는 요청, 과제, 결과물, 컨텍스트를 대화 옆에 모아 보여 줍니다.\n- **과제 초안 카드**: 버틀러가 만든 초안을 그 자리에서 등록하거나 고칩니다.\n\n## 고친 점\n\n1. 한글 조합 중에 ⌘K를 눌러도 글자가 사라지지 않습니다.\n2. 검색 결과가 최근 수정순으로 정렬됩니다.\n\n> 컨텍스트가 매우 길면 자동 압축 직후 첫 답변이 조금 늦을 수 있습니다.\n\n| 항목 | 이전 | 지금 |\n| --- | --- | --- |\n| 세션 정보 | 인스펙터 탭 | 대화 여백 |\n| 컨텍스트 | 12줄 | 5줄 |",
    short: "검토 후 뷰어를 내보내기.",
    files_: "파일", open: "서랍에서 열기", save: "저장하기", close: "파일 닫기", enlarge: "크게 보기",
  },
} as const;

const fileIcon = (kind: FileViewerKind) => (kind === "image" ? <ImageIcon size="md" /> : <FileText size="md" />);

function FileBody({ locale, kind }: { locale: Locale; kind: FileViewerKind }) {
  const copy = COPY[locale];
  if (kind === "markdown") return <MarkdownContent><ReactMarkdown remarkPlugins={[remarkGfm]}>{copy.markdown}</ReactMarkdown></MarkdownContent>;
  if (kind === "image") return <ArtifactPreviewImage alt={copy.files.image} src={IMAGE} />;
  return <ArtifactPreviewPre>{kind === "code" ? CODE : copy.short}</ArtifactPreviewPre>;
}

/**
 * A docked file viewer in AdaptiveShellSplit's right slot: tabs (more than one file), the file's header, and the
 * file as a reading page (ArtifactPreview surface="page"). PageContainer's gutter plus the Box padding give 48px
 * reading insets on every side.
 */
export function FileViewerDemo({ locale, kind, tabs = false }: { locale: Locale; kind: FileViewerKind; tabs?: boolean }) {
  const copy = COPY[locale];
  const kinds: FileViewerKind[] = ["markdown", "code", "image"];
  return (
    <AdaptiveShellCard aria-label={copy.files_}>
      <Stack fill gap="none">
        {tabs ? (
          <Box paddingX="sm" paddingY="xs">
            <TabStrip hideChip panelId={`file-viewer-demo-${locale}`} activeTabId={kind} labels={demoLabels(locale)} onActivate={() => undefined} onClose={() => undefined}
              groups={[{ id: "files", kind: "mine", label: copy.files_, tabs: kinds.map((item) => ({ id: item, title: copy.files[item], icon: fileIcon(item) })) }]} />
          </Box>
        ) : null}
        <Box paddingX="2xl" paddingY="md">
          <Stack align="row" cross="center" gap="md">
            <Stack gap="none" grow minWidth="0">
              <Typo.PanelTitle as="h2" truncate>{copy.files[kind]}</Typo.PanelTitle>
              <Typo.Caption tone="secondary" truncate>{copy.meta[kind]}</Typo.Caption>
            </Stack>
            <ButtonContainer size="sm" justify="end">
              {kind === "image" ? <IconButton label={copy.enlarge}><Expand size="md" /></IconButton> : null}
              <Button size="sm" variant="outline" iconStart={<Library size="sm" />} text={copy.open} />
              <Button size="sm" variant="outline" text={copy.save} />
              <IconButton label={copy.close}><X size="md" /></IconButton>
            </ButtonContainer>
          </Stack>
        </Box>
        <Separator space="none" />
        <ScrollArea fill>
          <PageContainer width="narrow" gutter="2xl">
            <Box paddingY="2xl">
              <Box padding="2xl">
                <ArtifactPreview surface="page"><FileBody locale={locale} kind={kind} /></ArtifactPreview>
              </Box>
            </Box>
          </PageContainer>
        </ScrollArea>
      </Stack>
    </AdaptiveShellCard>
  );
}
