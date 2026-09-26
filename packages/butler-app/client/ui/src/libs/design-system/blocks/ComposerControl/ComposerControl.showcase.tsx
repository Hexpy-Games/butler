import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { AlertCircle, GitBranch, Monitor, Search, ShieldCheck, SlidersHorizontal } from "../../components/Icons";
import { Select, SelectContent, SelectItem, SelectValue } from "../../components/Select";
import { Stack } from "../../components/Stack";
import { ComposerControl } from "./ComposerControl";
import { ComposerSelectControl } from "./ComposerSelectControl";
import styles from "./ComposerControl.module.css";

export const meta: ShowcaseMeta = {
  title: "ComposerControl",
  category: "Composer",
  tags: ["composer", "toolbar", "pill", "select"],
  status: "stable",
};

const copy = {
  "en-US": { ask: "Ask", workspace: "workspace", reasoning: "Reasoning", medium: "medium", access: "Full access", modelError: "Model unavailable", local: "Local", worktree: "Worktree", workspaceLabel: "Workspace" },
  "ko-KR": { ask: "질문", workspace: "워크스페이스", reasoning: "추론", medium: "보통", access: "전체 권한", modelError: "모델을 쓸 수 없음", local: "로컬", worktree: "워크트리", workspaceLabel: "작업 공간" },
} as const;

function WorkspaceSelect({ locale }: ShowcaseRenderContext) {
  const text = copy[locale];
  const [value, setValue] = useState("local");
  return (
    <Select value={value} onValueChange={setValue}>
      <ComposerSelectControl aria-label={text.workspaceLabel} icon={value === "local" ? <Monitor size="sm" /> : <GitBranch size="sm" />}>
        <SelectValue>{value === "local" ? text.local : text.worktree}</SelectValue>
      </ComposerSelectControl>
      <SelectContent position="popper" side="top">
        <SelectItem value="local">{text.local}</SelectItem>
        <SelectItem value="worktree">{text.worktree}</SelectItem>
      </SelectContent>
    </Select>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "Controls",
    states: ["default", "active", "compact"],
    render: ({ locale }) => {
      const text = copy[locale];
      return (
        <div className={styles.fixture}>
          <Stack align="row" gap="sm" wrap>
            <ComposerControl icon={<Search size="md" />} label={text.ask} detail={text.workspace} active />
            <ComposerControl icon={<SlidersHorizontal size="md" />} label={text.reasoning} detail={text.medium} />
            <ComposerControl icon={<ShieldCheck size="md" />} label={text.access} compact="icon" />
          </Stack>
        </div>
      );
    },
  },
  {
    name: "Error tone",
    states: ["error"],
    render: ({ locale }) => (
      <div className={styles.fixture}>
        <ComposerControl icon={<AlertCircle size="md" />} label={copy[locale].modelError} tone="danger" />
      </div>
    ),
  },
  {
    name: "Select trigger (workspace chip)",
    states: ["open"],
    render: (context) => (
      <div className={styles.fixture}>
        <Stack align="row" gap="sm">
          <ComposerControl icon={<ShieldCheck size="md" />} label={copy[context.locale].access} />
          <WorkspaceSelect {...context} />
        </Stack>
      </div>
    ),
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "active", "selected", "disabled"],
  variants: ["label", "icon"],
  render: (context) => (
    <ComposerControl active={context.state === "selected"} compact={context.variant === "icon" ? "icon" : "label"}
      disabled={context.state === "disabled"} icon={<ShieldCheck size="md" />} label={copy[context.locale].access} />
  ),
};
