import type { ReactNode } from "react";
import { Notice } from "../../../../blocks/Notice";
import { Button } from "../../../Button";
import { Card } from "../../../Card";
import { CheckCircle2 } from "../../../Icons";
import { Input } from "../../../Input";
import { Stack } from "../../../Stack";
import { Switch } from "../../../Switch";
import { Tag } from "../../../Tag";
import { Typo } from "../../../Typo";
import { Mark } from "../shared/Mark";
import { contrast } from "../shared/measure";
import { Reveal as R } from "../shared/Reveal";
import type { BuildSpec, Label } from "../shared/types";
import type { ColorCopy } from "./colorCopy";
import s from "./ColorHero.module.css";

/** A badge that names the color, then adds what it is for (and the text's contrast on its surface). */
function why(token: string, meaning: string, ratio = false): Label {
  return (m) => {
    const value = ratio ? contrast(m.color, m.bg) : "";
    return [token, `${token} · ${value ? `${value}:1 · ` : ""}${meaning}`];
  };
}

function group(id: string, topic: string, children: ReactNode) {
  return (
    <div className={s.group}>
      <Typo.SectionTitle><R name={`${id}-topic`}>{topic}</R></Typo.SectionTitle>
      {children}
    </div>
  );
}

/**
 * Components grouped by topic (contrast, action, status, states). Each is
 * drawn as its blueprint first, uncolored; then its colors fill in one at a
 * time, each with a badge naming the token and what it is for.
 */
export function colorBuilds(copy: ColorCopy): BuildSpec[] {
  const { why: w } = copy;
  return [
    {
      id: "contrast", holdSketch: true,
      render: group("g1", copy.topics.contrast, (
        <Mark block fill n="card" sketch>
          <Card padding="md">
            <Stack gap="xs">
              <Mark n="c-title"><Typo.Label as="span"><R name="c-title">{copy.cardTitle}</R></Typo.Label></Mark>
              <Mark n="c-body"><Typo.Body tone="secondary"><R name="c-body">{copy.cardBody}</R></Typo.Body></Mark>
              <Mark n="c-meta"><Typo.Caption tone="tertiary"><R name="c-meta">{copy.cardMeta}</R></Typo.Caption></Mark>
            </Stack>
          </Card>
        </Mark>
      )),
      steps: [
        { text: ["g1-topic"] },
        { parts: ["card"], annots: [{ kind: "tag", target: "card", label: ["--surface-raised", `--surface-raised · ${w.surface}`] }] },
        { text: ["c-title"], annots: [{ kind: "contrast", fg: "c-title", bg: "card", label: why("--text-primary", w.heading, true) }] },
        { text: ["c-body"], annots: [{ kind: "contrast", fg: "c-body", bg: "card", label: why("--text-secondary", w.body, true) }] },
        { text: ["c-meta"], annots: [{ kind: "contrast", fg: "c-meta", bg: "card", label: why("--text-tertiary", w.caption, true) }] },
      ],
    },
    {
      id: "action", holdSketch: true,
      render: group("g2", copy.topics.action, (
        <div className={s.row}>
          <Mark fill n="a-primary" sketch><Button text={<R name="a-primary-t">{copy.publish}</R>} /></Mark>
          <Mark fill n="a-outline" sketch><Button text={<R name="a-outline-t">{copy.later}</R>} variant="outline" /></Mark>
          <span className={s.switchRow}>
            <Mark fill n="a-switch" sketch><Switch aria-label={copy.autoSave} checked onCheckedChange={() => undefined} /></Mark>
            <Typo.Caption tone="secondary"><R name="a-switch-t">{copy.autoSave}</R></Typo.Caption>
          </span>
        </div>
      )),
      steps: [
        { text: ["g2-topic"] },
        { parts: ["a-primary"], text: ["a-primary-t"], annots: [{ kind: "tag", target: "a-primary", label: why("--primary", w.primary) }] },
        { parts: ["a-outline"], text: ["a-outline-t"], annots: [{ kind: "tag", target: "a-outline", label: why("--line", w.line) }] },
        { parts: ["a-switch"], text: ["a-switch-t"], annots: [{ kind: "tag", target: "a-switch", label: why("--accent", w.accent) }] },
      ],
    },
    {
      id: "status", holdSketch: true,
      render: group("g3", copy.topics.status, (
        <>
          <div className={s.row}>
            <Mark fill n="t-ok" sketch><Tag tone="success"><R name="t-ok-t">{copy.done}</R></Tag></Mark>
            <Mark fill n="t-warn" sketch><Tag tone="warning"><R name="t-warn-t">{copy.attention}</R></Tag></Mark>
            <Mark fill n="t-bad" sketch><Tag tone="danger"><R name="t-bad-t">{copy.failed}</R></Tag></Mark>
          </div>
          <Mark block fill n="n-info" sketch>
            <Notice tone="info" icon={<CheckCircle2 size="md" />} message={<R name="n-info-t">{copy.info}</R>} />
          </Mark>
        </>
      )),
      steps: [
        { text: ["g3-topic"] },
        { parts: ["t-ok"], text: ["t-ok-t"], annots: [{ kind: "tag", target: "t-ok", label: why("--color-success", w.success) }] },
        { parts: ["t-warn"], text: ["t-warn-t"], annots: [{ kind: "tag", target: "t-warn", label: why("--color-warning", w.warning) }] },
        { parts: ["t-bad"], text: ["t-bad-t"], annots: [{ kind: "tag", target: "t-bad", label: why("--color-danger", w.danger) }] },
        { parts: ["n-info"], text: ["n-info-t"], annots: [{ kind: "tag", target: "n-info", label: why("--color-info-bg", w.info) }] },
      ],
    },
    {
      id: "states", holdSketch: true,
      render: group("g4", copy.topics.states, (
        <div className={s.column}>
          <Mark block n="x-dis" sketch sweep><Input disabled readOnly value={copy.readOnly} /></Mark>
          <Mark block n="x-focus" sketch sweep><Input readOnly value={copy.focused} /></Mark>
        </div>
      )),
      steps: [
        { text: ["g4-topic"] },
        { parts: ["x-dis"], annots: [{ kind: "tag", target: "x-dis", label: why("--color-disabled-bg", w.disabled) }] },
        { parts: ["x-focus"], annots: [{ kind: "ring", target: "x-focus", label: why("--focus-ring-color", w.focus) }] },
      ],
    },
  ];
}
