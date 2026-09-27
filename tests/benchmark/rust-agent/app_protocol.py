"""Headless App public-path driver for the later isolated benchmark campaign.

The caller owns process launch, deadlines, credentials, and evidence redaction.
This module never starts Butler or submits a message on import.
"""

from __future__ import annotations

import json
import math
import socket
import time
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import ProxyHandler, Request, build_opener


class AppProtocolError(Exception):
    def __init__(self, code: str, status: int | None = None, *,
                 request_kind: str | None = None, elapsed_ms: float | None = None,
                 cause_code: str | None = None):
        self.code = code
        self.status = status
        self.request_kind = request_kind
        self.elapsed_ms = elapsed_ms
        self.cause_code = cause_code
        super().__init__(code)


def _normalize_event_cursor(value: Any) -> int | None:
    if type(value) is int:
        return value if value >= 0 else None
    if type(value) is float and math.isfinite(value) and value.is_integer() and \
       0 <= value <= 9_007_199_254_740_991:
        return int(value)
    return None


@dataclass(frozen=True)
class TimedResponse:
    data: dict[str, Any]
    request_ns: int
    response_ns: int


class AppClient:
    def __init__(self, base_url: str, bearer_token: str, timeout_s: float = 10):
        url = urlsplit(base_url)
        if url.scheme != "http" or url.hostname not in {"127.0.0.1", "::1"} or not url.port:
            raise ValueError("App benchmark endpoint must be explicit loopback HTTP")
        if not bearer_token:
            raise ValueError("authenticated App benchmark endpoint requires a token")
        self.base_url = base_url.rstrip("/")
        self._token = bearer_token
        self.timeout_s = timeout_s
        self._opener = build_opener(ProxyHandler({}))

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> TimedResponse:
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        request = Request(
            self.base_url + path,
            data=raw,
            method=method,
            headers={
                "Authorization": "Bearer " + self._token,
                "Accept": "application/json",
                **({"Content-Type": "application/json"} if body is not None else {}),
            },
        )
        route = path.partition("?")[0]
        request_kind = f"{method} {route}" if route in {
            "/health", "/runtime-readiness", "/settings", "/messages",
            "/turns", "/session-view", "/sessions",
        } else method + " other_route"
        started = time.monotonic_ns()
        try:
            with self._opener.open(request, timeout=self.timeout_s) as response:
                raw_response = response.read(8_000_001)
                status = response.status
        except HTTPError as error:
            # Avoid writing response bodies, paths, or authorization into evidence.
            raise AppProtocolError("app_http_error", error.code,
                                   request_kind=request_kind,
                                   elapsed_ms=(time.monotonic_ns() - started) / 1_000_000,
                                   cause_code="http_response") from None
        except OSError as error:
            reason = getattr(error, "reason", error)
            cause = ("timeout" if isinstance(reason, (TimeoutError, socket.timeout)) else
                     "connection_refused" if isinstance(reason, ConnectionRefusedError) else
                     "connection_reset" if isinstance(reason, ConnectionResetError) else
                     "broken_pipe" if isinstance(reason, BrokenPipeError) else "other_os_error")
            raise AppProtocolError("app_transport_unavailable", request_kind=request_kind,
                                   elapsed_ms=(time.monotonic_ns() - started) / 1_000_000,
                                   cause_code=cause) from None
        ended = time.monotonic_ns()
        if len(raw_response) > 8_000_000:
            raise AppProtocolError("app_response_too_large", status)
        try:
            envelope = json.loads(raw_response)
            if envelope.get("protocol_version") != "butler.app.v1" or not isinstance(envelope.get("data"), dict):
                raise ValueError("invalid envelope")
        except (UnicodeDecodeError, ValueError, TypeError, AttributeError):
            raise AppProtocolError("app_response_invalid", status) from None
        return TimedResponse(envelope["data"], started, ended)

    def health(self) -> TimedResponse:
        return self._request("GET", "/health")

    def readiness(self) -> TimedResponse:
        return self._request("GET", "/runtime-readiness")

    def settings(self) -> TimedResponse:
        return self._request("GET", "/settings")

    def update_model_settings(self, model: str, reasoning_effort: str) -> TimedResponse:
        if not model or not reasoning_effort:
            raise ValueError("explicit model and reasoning effort are required")
        return self._request("PATCH", "/settings", {
            "model": model,
            "reasoning_effort": reasoning_effort,
        })

    def event_cursor(self) -> int:
        cursor = 0
        for _ in range(1000):
            result = self._request("GET", f"/events?cursor={cursor}&limit=200").data
            events = result.get("events")
            next_cursor = _normalize_event_cursor(result.get("next_cursor"))
            if not isinstance(events, list) or next_cursor is None or next_cursor < cursor:
                raise AppProtocolError("event_cursor_invalid")
            if not events:
                return cursor
            if next_cursor == cursor:
                raise AppProtocolError("event_cursor_stalled")
            cursor = next_cursor
        raise AppProtocolError("event_cursor_did_not_settle")

    def create_project(self, folder_selection_token: str) -> TimedResponse:
        return self._request("POST", "/projects", {
            "source": "existing_folder",
            "display_name": "Rust benchmark",
            "folder_selection_token": folder_selection_token,
        })

    def create_session(self, project_id: str, session_hint: str) -> TimedResponse:
        return self._request("POST", "/sessions", {
            "kind": "project",
            "workspace_mode": "local",
            "project_id": project_id,
            "session_hint": session_hint,
            "title": "Rust benchmark",
        })

    def create_readiness_session(self, session_hint: str) -> TimedResponse:
        return self._request("POST", "/sessions", {
            "kind": "chat",
            "workspace_mode": "local",
            "session_hint": session_hint,
            "title": "Rust benchmark readiness",
        })

    def set_controls(self, session_id: str, model: str, reasoning_effort: str) -> TimedResponse:
        return self._request("PATCH", f"/sessions/{quote(session_id, safe='')}/controls", {
            "model": model,
            "reasoning_effort": reasoning_effort,
            "access_mode": "full_access",
            "plan_mode": False,
        })

    def submit(self, session_id: str, client_message_id: str, text: str,
               model: str, reasoning_effort: str) -> TimedResponse:
        return self._request("POST", "/messages", {
            "chat_id": session_id,
            "client_message_id": client_message_id,
            "text": text,
            "model": model,
            "reasoning_effort": reasoning_effort,
            "access_mode": "full_access",
            "plan_mode": False,
            "queue_policy": "send_now",
        })

    def messages(self, session_id: str, cursor: int = 0) -> TimedResponse:
        query = urlencode({"chat_id": session_id, "cursor": cursor})
        return self._request("GET", "/messages?" + query)

    def turns(self, session_id: str, cursor: int = 0) -> TimedResponse:
        query = urlencode({"chat_id": session_id, "cursor": cursor})
        return self._request("GET", "/turns?" + query)

    def session_view(self, session_id: str) -> TimedResponse:
        return self._request("GET", "/session-view?" + urlencode({"session_id": session_id}))

    def open_events(self, cursor: int) -> "EventStream":
        request = Request(
            self.base_url + "/events/live?" + urlencode({"cursor": cursor}),
            headers={"Authorization": "Bearer " + self._token, "Accept": "text/event-stream"},
        )
        try:
            response = self._opener.open(request, timeout=max(self.timeout_s, 45))
        except HTTPError as error:
            raise AppProtocolError("event_stream_http_error", error.code) from None
        except OSError:
            raise AppProtocolError("event_stream_unavailable") from None
        if response.status != 200 or "text/event-stream" not in response.headers.get("Content-Type", ""):
            response.close()
            raise AppProtocolError("event_stream_invalid")
        return EventStream(response)


class EventStream:
    def __init__(self, response: Any):
        self._response = response

    def close(self) -> None:
        self._response.close()

    def next_record(self) -> tuple[dict[str, Any] | None, int]:
        """Read one SSE record; heartbeat yields None. Timestamp is observation time."""
        lines: list[str] = []
        while True:
            try:
                raw = self._response.readline()
            except (OSError, AttributeError):
                raise AppProtocolError("event_stream_interrupted") from None
            if not raw:
                raise AppProtocolError("event_stream_closed")
            line = raw.decode("utf-8").rstrip("\r\n")
            if line:
                lines.append(line)
                continue
            observed = time.monotonic_ns()
            data = [line[5:].lstrip() for line in lines if line.startswith("data:")]
            lines.clear()
            if not data or data == ["null"]:
                return None, observed
            try:
                event = json.loads("\n".join(data))
            except ValueError:
                raise AppProtocolError("event_stream_record_invalid") from None
            if not isinstance(event, dict):
                raise AppProtocolError("event_stream_record_invalid")
            return event, observed
