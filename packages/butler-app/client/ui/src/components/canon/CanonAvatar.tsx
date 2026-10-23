import { Avatar } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { LOCAL_PERSON_ID, personLabel } from "./localPerson.ts";
export function CanonAvatar({ person }: { person: string | null }) {
  if (!person) return null;
  const self = person === LOCAL_PERSON_ID;
  const name = personLabel(person);
  return <Avatar name={name} size="xs" tone={self ? "self" : "other"} label={appCopy.canon.personLabel(name, self)} />;
}
