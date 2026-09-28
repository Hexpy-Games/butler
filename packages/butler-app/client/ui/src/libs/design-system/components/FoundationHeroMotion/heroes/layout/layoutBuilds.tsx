import { NavRow } from "../../../../blocks/NavRow";
import { TitlebarShell } from "../../../../blocks/TitlebarShell";
import { Box } from "../../../Box";
import { Button } from "../../../Button";
import { Folder, MessageSquare, PanelLeft, Search } from "../../../Icons";
import { Stack } from "../../../Stack";
import { Typo } from "../../../Typo";
import { spaceToken, valueLabel } from "../shared/labels";
import { Mark } from "../shared/Mark";
import { Reveal as R } from "../shared/Reveal";
import { Topic } from "../shared/Topic";
import type { BuildSpec } from "../shared/types";
import type { LayoutCopy } from "./layoutCopy";
import s from "./LayoutHero.module.css";

/** The shell's navigation rows (`<prefix><k>` reveals). */
function Nav({ copy, prefix }: { copy: LayoutCopy; prefix: string }) {
  const rows = [[copy.chats, <MessageSquare key="i" size="sm" />], [copy.projects, <Folder key="i" size="sm" />], [copy.files, <Search key="i" size="sm" />]] as const;
  return <>{rows.map(([label, icon], k) => <NavRow active={k === 0} icon={icon} key={label} label={<R name={`${prefix}${k}`}>{label}</R>} />)}</>;
}

/** A titlebar with the sidebar toggle and the app's name (`<prefix>app`). */
function Bar({ copy, prefix }: { copy: LayoutCopy; prefix: string }) {
  return (
    <TitlebarShell leading={<Button aria-label={copy.app} iconStart={<PanelLeft size="md" />} size="icon-sm" variant="ghost" />}
      title={<R name={`${prefix}app`}>{copy.app}</R>} />
  );
}

/**
 * Whole screens, built at a lower zoom: the expanded app shell (titlebar
 * and sidebar measured), a card grid on the layout basis, and the compact
 * screen at 375 with its safe area and the sidebar as a drawer.
 */
export function layoutBuilds(copy: LayoutCopy): BuildSpec[] {
  const { topics, cards, notes } = copy;
  return [
    {
      id: "shell",
      render: (
        <Topic id="t1" title={topics.shell}>
          <Mark block n="shell" sketch>
            <div className={s.shell}>
              <Mark block fill n="sh-title"><div className={s.titlebarHost}><Bar copy={copy} prefix="sh-" /></div></Mark>
              <div className={s.shellBody}>
                <Mark block fill n="sh-side" sketch><div className={s.shellSide}><Nav copy={copy} prefix="sh-r" /></div></Mark>
                <div className={s.shellMain}>{cards.map((card, k) => <Typo.Body key={card}><R name={`sh-m${k}`}>{card}</R></Typo.Body>)}</div>
              </div>
            </div>
          </Mark>
        </Topic>
      ),
      steps: [
        { text: ["t1-topic"] },
        { parts: ["sh-title"], text: ["sh-app"], annots: [{ kind: "size", target: "sh-title", axis: "h", label: valueLabel("--titlebar-height") }] },
        { parts: ["sh-side"], text: ["sh-r0", "sh-r1", "sh-r2"], annots: [{ kind: "size", target: "sh-side", axis: "w", label: valueLabel("--sidebar-width") }] },
        { text: ["sh-m0", "sh-m1", "sh-m2"], secondary: true },
      ],
    },
    {
      id: "grid",
      render: (
        <Topic id="t2" title={topics.grid}>
          <div className={s.cardGrid}>
            {[0, 1].map((k) => (
              <Mark block key={k} n={`c${k}`} part sketch>
                <Box border="hairline" padding="md" radius="panel" surface="raised">
                  <Stack gap="xs">
                    <Typo.PanelTitle><R name={`c${k}-t`}>{cards[k]!}</R></Typo.PanelTitle>
                    <Typo.Caption><R name={`c${k}-n`}>{notes[k]!}</R></Typo.Caption>
                  </Stack>
                </Box>
              </Mark>
            ))}
          </div>
        </Topic>
      ),
      steps: [
        { text: ["t2-topic"] },
        { parts: ["c0"], text: ["c0-t", "c0-n"], annots: [{ kind: "size", target: "c0", axis: "w", label: valueLabel("--layout-basis-sm") }] },
        { parts: ["c1"], text: ["c1-t", "c1-n"], annots: [{ kind: "gap", from: "c0", to: "c1", label: valueLabel(spaceToken) }] },
      ],
    },
    {
      id: "compact",
      render: (
        <Topic id="t3" title={topics.compact}>
          <Mark block n="phone" sketch>
            <div className={s.phone}>
              <Mark block fill n="ph-safe"><span className={s.safe} /></Mark>
              <div className={s.phoneBar}><Bar copy={copy} prefix="ph-" /></div>
              <div className={s.phoneBody}>
                {cards.map((card, k) => <Box border="hairline" key={card} padding="md" radius="panel" surface="raised"><Typo.Body><R name={`ph-c${k}`}>{card}</R></Typo.Body></Box>)}
              </div>
              <span className={s.safe} data-edge="b" />
              <Mark block fill n="ph-dim"><span className={s.dim} /></Mark>
              <Mark block fill n="ph-drawer" sketch><div className={s.phoneDrawer}><Nav copy={copy} prefix="ph-d" /></div></Mark>
            </div>
          </Mark>
        </Topic>
      ),
      steps: [
        { text: ["t3-topic"] },
        { text: ["ph-app", "ph-c0", "ph-c1", "ph-c2"], annots: [{ kind: "size", target: "phone", axis: "w", label: ["compactMax 640", "375 ≤ compactMax 640"] }] },
        { parts: ["ph-safe"], annots: [{ kind: "tag", target: "ph-safe", label: ["--safe-area-top"] }] },
        { parts: ["ph-dim", "ph-drawer"], text: ["ph-d0", "ph-d1", "ph-d2"], annots: [{ kind: "size", target: "ph-drawer", axis: "w", label: valueLabel("--sidebar-width") }] },
      ],
    },
  ];
}
