"""Expose healthy HTTP while lifecycle readiness is held by the test."""
import http.server
import json
import os
from pathlib import Path

data = Path(os.environ["BUTLER_DATA"])
record_path = data / "state/butler-agent-native-service.json"
record_path.parent.mkdir(parents=True, exist_ok=True)


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        (data / "healthy-observed").write_text("healthy")
        payload = b'{"data":{"ok":true}}'
        self.send_response(200)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
record_path.write_text(json.dumps({
    "pid": os.getpid(), "state": "starting", "nonce": "fixture",
    "app_endpoint": f"http://127.0.0.1:{server.server_port}",
}))
server.serve_forever()
