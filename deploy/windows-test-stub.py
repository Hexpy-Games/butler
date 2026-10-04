"""Loopback-only synthetic provider for the portable launcher's stub chat."""
import argparse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path

ANSWER = 'Traceable Windows ready.'


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        if self.path != '/v1/responses':
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        text = ANSWER
        if body.get('text', {}).get('format', {}).get('name') == 'memory_meaning_v4':
            text = json.dumps(dict(status='processed', entities=[], items=[], attributes=[]))
        response = dict(id='resp_stub', object='response', status='completed', model='gpt-6-luna',
                        output=[dict(type='message', id='msg_stub', role='assistant', status='completed',
                                     content=[dict(type='output_text', text=text, annotations=[])])],
                        usage=dict(input_tokens=100, output_tokens=20, total_tokens=120,
                                   input_tokens_details=dict(cached_tokens=40)))
        if body.get('stream'):
            payload = ('event: response.completed\ndata: ' +
                       json.dumps(dict(type='response.completed', response=response)) + '\n\n').encode()
            content_type = 'text/event-stream'
        else:
            payload, content_type = json.dumps(response).encode(), 'application/json'
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    root = parser.parse_args().root
    data = root / 'data'
    now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    fixtures = {
        'butler.config.json': dict(user=dict(name='E2E', language='en'),
                                  system=dict(defaultModel='openai/gpt-6-luna'), metrics=dict(enabled=False)),
        'personalization/onboarding.json': dict(schema='butler.first_chat_onboarding.v1', status='complete',
                                               gateway='any', fields={}, skipped_fields=[], created_at=now,
                                               updated_at=now, completed_at=now),
    }
    for job in ['session-sync', 'consolidation-cycle']:
        fixtures[f'state/scheduler/{job}.json'] = dict(lastRunDate=now[:10], lastRunAt=now, status='ok')
    for relative, value in fixtures.items():
        path = data / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding='utf-8')
    server = HTTPServer(('127.0.0.1', 0), Provider)
    (root / 'stub-port.txt').write_text(str(server.server_port), encoding='ascii')
    server.serve_forever()


if __name__ == '__main__':
    main()
