import type { CanonAgent } from "@/app/canonApi.ts";
import { useCanonPersonName } from "./useCanonPersonName.ts";
import { Avatar, Bot } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { LOCAL_PERSON_ID, personLabel } from "./localPerson.ts";
export function CanonAvatar({ person, agent }: { person: string | null; agent?: CanonAgent | null }) {
  const localName = useCanonPersonName();
  person = agent?.person ?? person;
  if (!person) return null;
  const self = person === LOCAL_PERSON_ID;
  const name = self ? localName : personLabel(person);
  return <Avatar name={name} size="xs" tone={self ? "self" : "other"} badge={agent ? <Bot aria-hidden="true" data-test-class="canon-agent-mark" /> : undefined} label={agent ? appCopy.canon.mcp.working(name, agent.via) : appCopy.canon.personLabel(name, self)} />;
}
