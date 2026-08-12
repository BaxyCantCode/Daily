"""
Vercel Python serverless function — replaces server.py's local /api/chat
proxy for production. Same job: forward the chat request body to the
Anthropic API with the real API key attached server-side, so that key
never ships to the browser (bot.html's fetch('/api/chat') doesn't change
at all — it has no idea whether it's talking to server.py or this file).

Vercel auto-detects any file under /api/*.py exporting a `handler` class
built on BaseHTTPRequestHandler and runs it as a serverless function at
the matching path (this file → POST/OPTIONS https://<your-app>/api/chat).
No vercel.json routing config is needed for that part.

Setup: in the Vercel dashboard, Project Settings -> Environment Variables,
add ANTHROPIC_API_KEY with your real key (console.anthropic.com -> API
Keys). Never commit that key to a .env file in this repo — Vercel's own
env var store is where it belongs; see SETUP.md.
"""
import json
import os
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler

API_KEY = os.environ.get('ANTHROPIC_API_KEY', '')


class handler(BaseHTTPRequestHandler):

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length) if length else b''

        if not API_KEY:
            # Fails loudly and specifically rather than passing an empty
            # key through to Anthropic and returning its generic 401 —
            # this is almost always a forgotten Vercel env var, not a
            # request-shape problem, so say so.
            self._respond(500, json.dumps({
                'error': 'ANTHROPIC_API_KEY is not set on the server. '
                         'Add it in Vercel -> Project Settings -> Environment Variables, '
                         'then redeploy.'
            }).encode())
            return

        req = urllib.request.Request(
            'https://api.anthropic.com/v1/messages',
            data=body,
            headers={
                'x-api-key': API_KEY,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                self._respond(r.status, r.read())
        except urllib.error.HTTPError as e:
            self._respond(e.code, e.read())
        except Exception as e:
            self._respond(500, json.dumps({'error': str(e)}).encode())

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors_headers()
        self.end_headers()

    def _respond(self, status, data):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self._cors_headers()
        self.end_headers()
        self.wfile.write(data)

    def _cors_headers(self):
        # Same-origin in practice (the app and this function deploy
        # together on one Vercel project) — kept permissive to match
        # server.py's behavior and avoid surprises if the frontend is
        # ever hosted separately from the API.
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def log_message(self, fmt, *args):
        pass
