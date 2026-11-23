import type { ShowcaseRenderContext } from "../../showcase";
import { Button } from "../Button";
import { ButtonContainer } from "../ButtonContainer";
import { Input } from "../Input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./Dialog";

const labels = {
  "en-US": { publicLink: "Public link", unpublish: "Unpublish", open: "Open", update: "Update" },
  "ko-KR": { publicLink: "공개 링크", unpublish: "공개 중단", open: "열기", update: "최신 내용으로 갱신" },
} as const;

export function FooterThatWraps({ locale, closeLabel }: ShowcaseRenderContext & { closeLabel: string }) {
  const copy = labels[locale];
  return (
    <Dialog>
      <DialogTrigger asChild><Button variant="outline" size="sm" text={copy.publicLink} /></DialogTrigger>
      <DialogContent closeLabel={closeLabel}>
        <DialogHeader><DialogTitle>{copy.publicLink}</DialogTitle></DialogHeader>
        <Input aria-label={copy.publicLink} value="https://example.com/page" readOnly />
        <DialogFooter>
          <ButtonContainer size="sm">
            <Button size="sm" variant="ghost" text={copy.unpublish} />
            <Button size="sm" variant="outline" text={copy.open} />
            <Button size="sm" text={copy.update} />
          </ButtonContainer>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
