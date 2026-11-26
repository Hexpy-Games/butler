import { fetch as expoFetch } from "expo/fetch";
import type { FetchLike } from "../../../butler-protocol/src/client/index.ts";
/** expo/fetch as the protocol client's FetchLike; forwards the signal only when it is a real AbortSignal. */
export const nativeFetch: FetchLike = (url, init) => expoFetch(url, {
  method: init.method, headers: init.headers, body: init.body as RequestInit["body"],
  signal: init.signal instanceof AbortSignal ? init.signal : undefined,
});
