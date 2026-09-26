"""Observe one real public turn through SSE plus durable App messages/turns."""

from __future__ import annotations

import queue
import re
import threading
import time
from dataclasses import dataclass
from typing import Any

from app_protocol import AppClient, AppProtocolError, EventStream


@dataclass(frozen=True)
class TurnObservation:
    session_id: str
    turn_id: str
    request_ns: int
    admission_ns: int
    final_ns: int | None
    first_public_activity_ns: int | None
    terminal_state: str | None
    final_text: str | None  # keep private; never serialize to a public report
    event_stream_status: str
    public_tool_progress: dict[str, Any]


@dataclass(frozen=True)
class DelegatedObservation:
    relation_id: str
    child_session_id: str
    child_turn_id: str
    status: str
    final_ns: int
    final_text: str | None  # private; never serialize into the report


def observe_delegated_result(client: AppClient, *, parent_session_id: str,
                             parent_turn_id: str, deadline_s: float = 300) -> DelegatedObservation:
    """Wait for the one child actually related to this parent Turn, not its acknowledgement."""
    expires = time.monotonic() + deadline_s
    while time.monotonic() < expires:
        response = client.session_view(parent_session_id)
        children = response.data.get("steward_children")
        if not isinstance(children, list):
            raise AppProtocolError("delegated_relation_projection_unavailable")
        matching = [row for row in children if isinstance(row, dict) and
                    isinstance(row.get("relation"), dict) and
                    row["relation"].get("parent_turn_id") == parent_turn_id]
        if len(matching) > 1:
            raise AppProtocolError("delegated_relation_ambiguous")
        if matching:
            child = matching[0]
            if child.get("terminal") is True:
                relation = child["relation"]
                result = child.get("result")
                if not isinstance(result, dict) or not all(
                    isinstance(value, str) and value for value in (
                        relation.get("relation_id"), child.get("session_id"),
                        result.get("child_turn_id"), result.get("status"))
                ):
                    raise AppProtocolError("delegated_result_incomplete")
                return DelegatedObservation(
                    relation_id=relation["relation_id"],
                    child_session_id=child["session_id"],
                    child_turn_id=result["child_turn_id"],
                    status=result["status"], final_ns=response.response_ns,
                    final_text=result.get("summary") if isinstance(result.get("summary"), str) else None,
                )
        time.sleep(0.15)
    raise AppProtocolError("delegated_result_timeout")


class _PublicToolProgress:
    """Pair public progress states by opaque call id without retaining the id."""

    _STARTED = {"running", "started", "active"}
    _TERMINAL = {"failed", "cancelled", "delivered", "complete", "completed", "stopped"}

    def __init__(self, turn_id: str):
        self.turn_id = turn_id
        self.pending: dict[str, tuple[str, int]] = {}
        self.finished: set[str] = set()
        self.intervals: list[tuple[str, int, int]] = []
        self.event_count = 0
        self.start_event_count = 0
        self.unmatched_terminal_count = 0
        self.peak_active = 0

    def observe(self, event: dict[str, Any], observed_ns: int) -> None:
        if event.get("type") not in {"agent.turn_event.progress", "progress.summary"}:
            return
        payload = event.get("payload")
        if not isinstance(payload, dict) or payload.get("turn_id") != self.turn_id:
            return
        row = payload.get("row")
        if not isinstance(row, dict):
            return
        call_id = row.get("tool_call_id")
        state = row.get("state")
        if not isinstance(call_id, str) or not call_id or not isinstance(state, str):
            return
        tool_name = row.get("safe_tool_name")
        if not isinstance(tool_name, str) or not tool_name:
            tool_name = "unknown"
        else:
            # The public row already applies the product's safe-value projection;
            # keep output to the usual short identifier shape as a second boundary.
            tool_name = tool_name if re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", tool_name) else "other"
        self.event_count += 1
        if state in self._STARTED:
            self.start_event_count += 1
            self.pending.setdefault(call_id, (tool_name, observed_ns))
            self.peak_active = max(self.peak_active, len(self.pending))
        elif state in self._TERMINAL:
            started = self.pending.pop(call_id, None)
            if started is None:
                if call_id not in self.finished:
                    self.unmatched_terminal_count += 1
            else:
                self.intervals.append((started[0], started[1], observed_ns))
                self.finished.add(call_id)

    def summary(self, request_ns: int) -> dict[str, Any]:
        complete = bool(self.intervals) and not self.pending and not self.unmatched_terminal_count
        status = "observed" if complete else "partial" if self.intervals else "unavailable"
        return {
            "status": status,
            "basis": "public_progress_sse_observation",
            "reason": None if status == "observed" else "complete_public_tool_interval_unavailable",
            "event_count": self.event_count,
            "completed_interval_count": len(self.intervals),
            "start_event_count": self.start_event_count,
            "unmatched_terminal_count": self.unmatched_terminal_count,
            "unfinished_interval_count": len(self.pending),
            "peak_active_tool_calls": self.peak_active if self.start_event_count else None,
            "intervals": [
                {"tool_name": name,
                 "start_after_request_ms": (start - request_ns) / 1_000_000,
                 "end_after_request_ms": (end - request_ns) / 1_000_000,
                 "duration_ms": (end - start) / 1_000_000}
                for name, start, end in self.intervals
            ],
        }


class _EventPump:
    def __init__(self, stream: EventStream):
        self.stream = stream
        self.records: queue.Queue[tuple[dict[str, Any] | None, int]] = queue.Queue()
        self.error: str | None = None
        self.thread = threading.Thread(target=self._read, name="rust-benchmark-sse", daemon=True)

    def start(self) -> None:
        self.thread.start()

    def _read(self) -> None:
        try:
            while True:
                self.records.put(self.stream.next_record())
        except AppProtocolError as error:
            self.error = error.code

    def close(self) -> None:
        self.stream.close()
        self.thread.join(timeout=2)


def observe_turn(client: AppClient, *, session_id: str, client_message_id: str,
                 prompt: str, model: str, reasoning_effort: str,
                 deadline_s: float = 300,
                 require_assistant_message: bool = True) -> TurnObservation:
    cursor = client.event_cursor()
    stream = client.open_events(cursor)
    # live-events.ts emits heartbeat after replay. Waiting for it proves the
    # subscription has been installed before we submit the input.
    while True:
        event, _ = stream.next_record()
        if event is None:
            break
        if event.get("type") == "stream.reconcile_required":
            stream.close()
            raise AppProtocolError("event_stream_reconciliation_required")
    pump = _EventPump(stream)
    pump.start()
    try:
        admission = client.submit(session_id, client_message_id, prompt, model, reasoning_effort)
        turn = admission.data.get("turn")
        if not isinstance(turn, dict) or not isinstance(turn.get("id"), str):
            raise AppProtocolError("turn_admission_missing")
        turn_id = turn["id"]
        tool_progress = _PublicToolProgress(turn_id)
        first_public: int | None = None
        final_ns: int | None = None
        final_text: str | None = None
        terminal: str | None = None
        expires = time.monotonic() + deadline_s
        while time.monotonic() < expires:
            while True:
                try:
                    event, observed_ns = pump.records.get_nowait()
                except queue.Empty:
                    break
                if not event:
                    continue
                if event.get("type") == "stream.reconcile_required":
                    raise AppProtocolError("event_stream_reconciliation_required")
                payload = event.get("payload")
                tool_progress.observe(event, observed_ns)
                if (first_public is None and isinstance(payload, dict) and
                    payload.get("turn_id") == turn_id and
                    event.get("type") in {"agent.turn_event.progress", "progress.summary"} and
                    isinstance(payload.get("row"), dict) and payload["row"]):
                    first_public = observed_ns
            turns = client.turns(session_id).data.get("turns", [])
            selected = next((row for row in turns if row.get("id") == turn_id), None)
            if selected and selected.get("state") in {"delivered", "failed", "runtime_fault", "cancelled"}:
                terminal = selected["state"]
                messages = client.messages(session_id).data.get("messages", [])
                final = next((row for row in reversed(messages)
                              if row.get("turn_id") == turn_id and row.get("role") == "assistant"
                              and row.get("status") in {"delivered", "failed", "cancelled"}), None)
                if final is not None or not require_assistant_message:
                    final_ns = time.monotonic_ns()
                    final_text = (final.get("text") if isinstance(final.get("text"), str)
                                  else None) if final is not None else None
                    break
            time.sleep(0.15)
        if final_ns is None:
            raise AppProtocolError("turn_terminal_timeout")
        return TurnObservation(
            session_id=session_id, turn_id=turn_id,
            request_ns=admission.request_ns, admission_ns=admission.response_ns,
            final_ns=final_ns, first_public_activity_ns=first_public,
            terminal_state=terminal, final_text=final_text,
            event_stream_status=pump.error or "observed",
            public_tool_progress=tool_progress.summary(admission.request_ns),
        )
    finally:
        pump.close()
