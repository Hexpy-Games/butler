import type { CanonActor } from "@/app/canonApi.ts";
import { appCopy } from "@/app/copy.ts";
import { LOCAL_PERSON_ID } from "./localPerson.ts";
export function canonActorLabel(actor: CanonActor, localName: string): string {
  if (actor.origin !== "mcp" && actor.via === "butler") return appCopy.canon.mcp.butler;
  const person = actor.person === LOCAL_PERSON_ID ? localName : actor.person || appCopy.canon.me;
  return actor.via && (actor.origin === "mcp" || actor.via !== "app") ? `${person} · ${actor.via}` : person;
}
