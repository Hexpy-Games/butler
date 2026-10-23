import { appCopy } from "@/app/copy.ts";
/** Host App actor (host/app/work_model.rs); only people are assignees. */
export const LOCAL_PERSON_ID = "app-user";
export function personLabel(id: string | null): string {
  return id === LOCAL_PERSON_ID ? appCopy.canon.me : id ?? appCopy.canon.none;
}
