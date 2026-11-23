import { useState } from "react";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { icons, ListRow, Sheet } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { StewardDetails } from "./StewardCard";
import { useSessionViewData } from "./useSessionView";

export function WorkResultRow({ sessionId, title }: { sessionId: string; title: string }) {
  const [open, setOpen] = useState(false);
  const app = getAppCopy(useAppLocale());
  const copy = useMobileCopy();
  const { view } = useSessionViewData(open ? sessionId : undefined);
  return <>
    <ListRow icon={icons.Eye} title={title} description={app.conversation.initiated.viewWork}
      descriptionLines={1} onPress={() => setOpen(true)} />
    <Sheet open={open} onClose={() => setOpen(false)} title={title} cancelLabel={copy.chat.close}>
      <StewardDetails view={view} />
    </Sheet>
  </>;
}
