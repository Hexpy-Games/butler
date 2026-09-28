import type { Box, Track } from "../../heroTimeline";
import { motionDistance } from "../../../../lib/motion";
import type { SceneGeometry } from "../scene/types";
import { select } from "../shared/Reveal";
import { arrive, fillNote, inside, looped, playhead, shown } from "./motionKeys";
import { AT, SCORE_SPAN, TWIN_SPAN, beatsOf, scoreNotes, twinNotes } from "./motionScore";

/**
 * The send flight (lib/sendFlight.ts): the bubble starts with its text's
 * right edge on the composer text box's right edge and its text top on the
 * composer text's top, then flies home with translate only (decelerate, slow).
 */
function flight(ask: Box | undefined, origin: { right: number; top: number } | null): { x: number; y: number } {
  if (!ask || !origin) return { x: 0, y: 0 };
  return { x: Math.round(origin.right - (ask.x + ask.w)), y: Math.round(origin.top - ask.y) };
}

/** A user row: hidden until `at`, its bubble flying from `from` (or fading in place when reduced), its footer fading in. */
function userRow(id: string, at: number, from: { x: number; y: number } | null, close: number): Track[] {
  const body = inside(`${id}-user`, "message-body");
  const foot = inside(`${id}-user`, "user-message-footer");
  const base = beatsOf("base");
  const bubble: Track = from
    ? { select: body, keys: looped([{ at: 0, ...from }, { at, ...from }, { at: at + beatsOf("slow"), x: 0, y: 0, ease: "decelerate" }], close) }
    : arrive(body, at, base, {}, close);
  return [
    shown(`${id}-user`, from ? at - 0.01 : at, null, close, 0.01), bubble,
    // The footer shows as the bubble lands (it would sit under the flight at half speed).
    arrive(foot, from ? at + 1 : at, base, {}, close),
  ];
}

/** A row entering as the product inserts it (message-enter: --motion-base, a --motion-distance-sm rise; fade only when reduced). */
const enter = (target: string, at: number, close: number, reduced = false) =>
  arrive(target, at, beatsOf("base"), reduced ? {} : { y: motionDistance("sm") || 4 }, close);

/** The score: Send, flight, thinking, the answer and its settled status; each note fills as the playhead crosses it. */
export function scoreTracks(g: SceneGeometry, close: number): Track[] {
  const S = AT.s;
  const ed = g.boxes["sc-ed"];
  const from = flight(g.boxes["sc-ask"], ed ? { right: ed.x + ed.w, top: ed.y } : null);
  const press = beatsOf("instant");
  const rise = motionDistance("sm") || 4;
  const send = inside("sc-draft", "composer-send-button");
  const notes = scoreNotes();
  return [
    { select: send, keys: looped([{ at: 0, s: 1 }, { at: S + 1, s: 1 }, { at: S + 1 + press, s: 0.97, ease: "standard" }, { at: S + 1 + 2 * press, s: 1, ease: "standard" }], close) },
    { select: select("sc-draft"), keys: looped([{ at: 0, o: 1 }, { at: S + 2 - 0.01, o: 1 }, { at: S + 2, o: 0 }], close) },
    shown("sc-stop", S + 2 - 0.01, S + 14, close, 0.01),
    shown("sc-idle", S + 14, null, close),
    ...userRow("sc", S + 2, from, close),
    { select: select("sc-act"), keys: looped([{ at: 0, y: rise, o: 0 }, { at: S + 4, y: rise, o: 0 }, { at: S + 5, y: 0, o: 1, ease: "decelerate" }, { at: S + 12, o: 1 }, { at: S + 12.1, o: 0 }], close) },
    enter("sc-reply", S + 12, close),
    arrive(inside("sc-reply", "assistant-footer"), S + 14, beatsOf("base"), {}, close),
    arrive(inside("sc-reply", "assistant-terminal-status-row"), S + 14, beatsOf("base"), {}, close),
    ...notes.flatMap((note, k) => fillNote(`sr-n${k}`, [[S + note.at, note.len]], close)),
    playhead("sr-play", S, SCORE_SPAN, close),
  ];
}

/** The twins: Full (the bubble flies, the answer rises), then Reduced (both only fade); the idle twin dims to 40%. */
export function twinTracks(g: SceneGeometry, close: number): Track[] {
  const dim = (name: string, off: number, on: number): Track => ({
    select: select(name), keys: looped([{ at: 0, o: 1 }, { at: off, o: 1 }, { at: off + 0.5, o: 0.4 }, { at: on, o: 0.4 }, { at: on + 0.5, o: 1 }], close),
  });
  const origin = g.boxes["twf-origin"];
  // The compact composer's text box: its right content edge, its text vertically centred.
  const from = flight(g.boxes["twf-ask"], origin ? { right: origin.x + origin.w - 56, top: origin.y + origin.h / 2 - (g.boxes["twf-ask"]?.h ?? 0) / 2 } : null);
  const side = (id: "f" | "r", at: number): Track[] => [
    ...userRow(`tw${id}`, at, id === "f" ? from : null, close),
    enter(`tw${id}-reply`, at + 2, close, id === "r"),
    ...twinNotes(id === "r").flatMap((note, k) => fillNote(`tr${id}-n${k}`, [[at + note.at, note.len]], close)),
    playhead(`tr${id}-play`, at, TWIN_SPAN, close),
  ];
  return [
    dim("tw-r", AT.full - 0.75, AT.reduced - 0.75), dim("tw-f", AT.reduced - 0.75, AT.twinsRest),
    ...side("f", AT.full), ...side("r", AT.reduced),
  ];
}

