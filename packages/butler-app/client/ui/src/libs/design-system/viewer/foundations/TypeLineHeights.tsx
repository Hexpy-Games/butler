import type { ReactNode } from "react";
import { Bookmark, FileText, Server } from "../../components/Icons";
import { IconSlot, type IconSlotSize } from "../../components/IconSlot";
import { ProviderLogo } from "../../components/ProviderLogo";
import { Typo } from "../../components/Typo";
import s from "./TypeLineHeights.module.css";

/** role, size, old rendered leading (ratio × size), new leading; then the same at 640px and below. */
const SCALE: Array<[string, number, string, number, number?, string?, number?]> = [
  ["h1", 32, "1.25 · 40", 40, 34, "1.25 · 42.5", 42],
  ["h2", 24, "1.3 · 31.2", 32, 26, "1.3 · 33.8", 34],
  ["h3", 20, "1.35 · 27", 28, 22, "1.35 · 29.7", 30],
  ["h4", 18, "1.4 · 25.2", 26, 20, "1.4 · 28", 28],
  ["h5", 16, "1.45 · 23.2", 24, 18, "1.45 · 26.1", 26],
  ["h6", 14, "1.45 · 20.3", 20, 16, "1.45 · 23.2", 24],
  ["body", 14, "1.45 · 20.3", 20, 16, "1.45 · 23.2", 24],
  ["body (document)", 14, "1.58 · 22.1", 22, 16, "1.58 · 25.3", 26],
  ["label", 13, "1.45 · 18.85", 18, 15, "1.45 · 21.75", 22],
  ["label (tight)", 13, "1.2 · 15.6", 16, 15, "1.2 · 18", 18],
  ["caption", 12, "1.45 · 17.4", 16, 14, "1.45 · 20.3", 20],
  ["caption (tight)", 12, "1.2 · 14.4", 14, 14, "1.2 · 16.8", 16],
  ["code", 13, "1.45 · 18.85", 20, 15, "1.45 · 21.75", 22],
  ["app-title", 15, "1.4 · 21", 20, 17, "1.4 · 23.8", 24],
  ["panel-title", 15, "1.3 · 19.5", 20, 17, "1.3 · 22.1", 22],
  ["panel-section-title", 15, "1.45 · 21.75", 22, 17, "1.45 · 24.65", 24],
  ["section-title", 13, "1.45 · 18.85", 18, 15, "1.45 · 21.75", 22],
  ["dashboard-title", 24, "1.3 · 31.2", 32, 26, "1.3 · 33.8", 34],
  ["metric-value", 18, "1.4 · 25.2", 26, 20, "1.4 · 28", 28],
  ["new-chat-title", 48, "1.06 · 50.9", 52],
  ["new-chat-title md", 40, "1.06 · 42.4", 42],
  ["new-chat-title sm", 34, "1.06 · 36", 36, 36, "1.06 · 38.2", 38],
];

/** The integer scale, before and after, at desktop and at 640px and below. */
export function LineHeightTable() {
  return (
    <div className={s.tableFrame}>
      <table className={s.table}>
        <thead>
          <tr><th>Role</th><th>Size</th><th>Before</th><th>After</th><th>≤640 size</th><th>Before</th><th>After</th></tr>
        </thead>
        <tbody>
          {SCALE.map(([role, size, before, after, mSize, mBefore, mAfter]) => (
            <tr key={role}>
              <td><code>{role}</code></td><td>{size}</td><td className={s.old}>{before}</td><td className={s.new}>{after}</td>
              <td>{mSize ?? "–"}</td><td className={s.old}>{mBefore ?? "–"}</td><td className={s.new}>{mAfter ?? "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Sample({ size, icon, children }: { size: IconSlotSize; icon: ReactNode; children: ReactNode }) {
  return (
    <div className={s.sample}>
      <IconSlot minHeight="line" size={size}>{icon}</IconSlot>
      <span className={s.line}>{children}</span>
    </div>
  );
}

/** Icons beside text in each role: the dashed box is the line box; even icons centre on whole pixels. */
export function LineHeightSamples() {
  return (
    <div className={s.samples}>
      <Typo.Caption as="div"><Sample size="xs" icon={<Server size="xs" />}>Caption 12/16 · MCP 서버 · 키 입력 필요</Sample></Typo.Caption>
      <Typo.Label as="div"><Sample size="sm" icon={<Bookmark size="sm" />}>Label 13/18 · 북마크 Bookmarks</Sample></Typo.Label>
      <Typo.Label as="div"><Sample size="sm" icon={<ProviderLogo name="claude" size="sm" />}>Label 13/18 · Claude Code</Sample></Typo.Label>
      <Typo.Body as="div"><Sample size="md" icon={<FileText size="md" />}>Body 14/20 · 지침 Instructions</Sample></Typo.Body>
      <Typo.AppTitle as="div"><Sample size="md" icon={<ProviderLogo name="openai" />}>App title 15/20 · ChatGPT</Sample></Typo.AppTitle>
      <Typo.H5 as="div"><Sample size="md" icon={<Bookmark size="md" />}>H5 16/24 · 방문 기록 History</Sample></Typo.H5>
    </div>
  );
}
