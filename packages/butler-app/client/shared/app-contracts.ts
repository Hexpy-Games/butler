/** Public shared app wire-contract surface for the UI and Electron clients. */
export {
  APP_PROTOCOL_VERSION,
  WORKER_PROFILE_ID_PATTERN,
  isMessageContent,
  isProjectSourceContentPart,
  messageContentText,
} from "./message-session-contracts.ts";
export type {
  AppEventEnvelope,
  ChatKind,
  ChatSummary,
  MessageContent,
  MessageContentPart,
  ProgressDetailRow,
  ProgressSummaryRow,
  ProjectSourceContentPart,
  ProjectSourceReference,
  ProjectStatus,
  ProjectSummary,
  SessionArtifactSummary,
  SessionBranchRequest,
  SessionBranchSeed,
  SessionSummary,
  TurnState,
  WorkerActivityPhase,
  WorkerActivitySummary,
  WorkerActivityWorkBlock,
} from "./message-session-contracts.ts";

export { isSpaceCommand } from "./dashboard-space-contracts.ts";
export type {
  DashboardArtifactPage,
  DashboardBoardCard,
  DashboardBoardPage,
  DashboardBriefingContent,
  DashboardBriefingSource,
  DashboardBriefingView,
  DashboardHistoryPage,
  DashboardMaterialsPage,
  DashboardOverview,
  DashboardStatisticSeries,
  DashboardStatisticSource,
  DashboardStatisticsView,
  DashboardWorkCard,
  NavigationView,
  ProjectDashboardActivityDay,
  ProjectDashboardDocument,
  ProjectDashboardDocumentType,
  ProjectDashboardView,
  SpaceCommand,
  SpaceGroup,
  SpaceMutationResult,
  SpaceNode,
  SpaceView,
} from "./dashboard-space-contracts.ts";

/** Structured answer contract, mirrored from the runtime JSON Schema. */
export type AnswerBlockId = string;

export type AnswerBlockTitle = string;

export type Checked = string;

export type AssetId = string;

export type AnswerMedia = "1:1" | "4:5" | "3:4" | "16:9";

export type CardItem = {
  key?: string;
  label?: string;
  title: string;
  sub?: string;
  img?: AssetId;
  facts?: Array<string>;
  text?: string;
  checked?: Checked;
  value?: CardValue;
  source?: AnswerSource;
};

export type AnswerCell = string | number | null;

export type AnswerSource = string;

export type CardValue = {
  amount: number;
  was?: number;
  note?: string;
} & ({ unit?: string; cur?: never } | { unit?: never; cur?: string });

export type CardsBlock = {
  type: "cards";
  id?: AnswerBlockId;
  title?: AnswerBlockTitle;
  media?: AnswerMedia;
  items: Array<CardItem>;
};

export type TableBlock = {
  type: "table";
  id?: AnswerBlockId;
  title?: AnswerBlockTitle;
  columns: Array<string>;
  rows: Array<Array<AnswerCell>>;
};

export type GalleryBlock = {
  type: "gallery";
  id?: AnswerBlockId;
  title?: AnswerBlockTitle;
  media?: AnswerMedia;
  items: Array<{
  img: AssetId;
  caption?: string;
  source?: AnswerSource;
}>;
};

export type FactsBlock = {
  type: "facts";
  id?: AnswerBlockId;
  title?: AnswerBlockTitle;
  items: Array<{
  label: string;
  value: string;
  checked?: Checked;
  source?: AnswerSource;
}>;
};

export type MetricsBlock = {
  type: "metrics";
  id?: AnswerBlockId;
  title?: AnswerBlockTitle;
  items: Array<{
  label: string;
  value: string | number;
  unit?: string;
  delta?: string;
  checked?: Checked;
  source?: AnswerSource;
}>;
};

export type ChartBlock = {
  type: "chart";
  id?: AnswerBlockId;
  title?: AnswerBlockTitle;
  kind: "bar" | "line";
  x: Array<string>;
  series: Array<{
  name: string;
  values: Array<number | null>;
}>;
  unit?: string;
  checked?: Checked;
  source?: AnswerSource;
};

export type CalloutBlock = {
  type: "callout";
  id?: AnswerBlockId;
  title?: AnswerBlockTitle;
  tone?: "neutral" | "info" | "success" | "warning";
  text: string;
};

export type ActionsBlock = {
  type: "actions";
  id?: AnswerBlockId;
  title?: AnswerBlockTitle;
  items: Array<{
  ask: string;
} | {
  open: AnswerSource;
  label: string;
}>;
};

export type AnswerBlock = CardsBlock | TableBlock | GalleryBlock | FactsBlock | MetricsBlock | ChartBlock | CalloutBlock | ActionsBlock;

export type AnswerBlocks = {
  v: 1;
  blocks: Array<AnswerBlock>;
};
