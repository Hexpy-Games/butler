import type { ReactNode } from "react";
import { Typo } from "../../../Typo";
import { Reveal as R } from "./Reveal";
import c from "./ChapterHero.module.css";

/**
 * A build's topic: its title (revealed as the build's first step, Reveal
 * name `<id>-topic`) over the components that show it.
 */
export function Topic({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <div className={c.topic}>
      <Typo.SectionTitle><R name={`${id}-topic`}>{title}</R></Typo.SectionTitle>
      {children}
    </div>
  );
}
