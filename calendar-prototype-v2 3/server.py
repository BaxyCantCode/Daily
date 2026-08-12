#!/usr/bin/env python3
"""
Calendar prototype local server.
Serves static HTML files and proxies /api/chat → Anthropic API.

Usage:  python3 server.py
Then open: http://localhost:5173
"""
import json
import os
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

# ── Load .env ─────────────────────────────────────────────────────────
def load_env(path='.env'):
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, _, v = line.partition('=')
            v = v.strip().strip('"').strip("'")
            os.environ.setdefault(k.strip(), v)

# Always run from the directory this file lives in
os.chdir(os.path.dirname(os.path.abspath(__file__)))
load_env()

API_KEY = os.environ.get('ANTHROPIC_API_KEY', '')

# ── Request handler ───────────────────────────────────────────────────
class Handler(SimpleHTTPRequestHandler):

    # ── Static-file guard ─────────────────────────────────────────────
    # SimpleHTTPRequestHandler will happily serve ANY file under this
    # directory that the URL path resolves to — including dotfiles. With
    # no filtering, a plain GET /.env serves the raw file back verbatim,
    # handing over ANTHROPIC_API_KEY to whoever requests it. Block any
    # path with a dot-prefixed segment (.env, .git/config, .gitignore,
    # etc.) before falling through to the normal static-file behavior.
    def do_GET(self):
        if self._is_blocked_path(self.path):
            self.send_error(403, 'Forbidden')
            return
        super().do_GET()

    def do_HEAD(self):
        if self._is_blocked_path(self.path):
            self.send_error(403, 'Forbidden')
            return
        super().do_HEAD()

    def _is_blocked_path(self, path):
        clean = path.split('?', 1)[0].split('#', 1)[0]
        return any(seg.startswith('.') for seg in clean.split('/') if seg)

    # ── Proxy endpoint ──────────────────────────────────────────────
    def do_POST(self):
        if self.path != '/api/chat':
            self.send_error(404)
            return

        length = int(self.headers.get('Content-Length', 0))
        body   = self.rfile.read(length)

        req = urllib.request.Request(
            'https://api.anthropic.com/v1/messages',
            data=body,
            headers={
                'x-api-key':         API_KEY,
                'anthropic-version': '2023-06-01',
                'content-type':      'application/json',
            },
        )
        try:
            with urllib.request.urlopen(req) as r:
                self._respond(r.status, r.read())
        except urllib.error.HTTPError as e:
            self._respond(e.code, e.read())
        except Exception as e:
            self._respond(500, json.dumps({'error': str(e)}).encode())

    # ── CORS preflight ──────────────────────────────────────────────
    def do_OPTIONS(self):
        self.send_response(200)
        self._cors_headers()
        self.end_headers()

    # ── Helpers ─────────────────────────────────────────────────────
    def end_headers(self):
        # Static files are actively edited during dev — without this the
        # browser can keep serving an old cached copy of a page after a
        # save, with no visible sign anything is stale.
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _respond(self, status, data):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self._cors_headers()
        self.end_headers()
        self.wfile.write(data)

    def _cors_headers(self):
        self.send_header('Access-Control-Allow-Origin',  '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def log_message(self, fmt, *args):
        # Cleaner console output
        try:
            parts = args[0].split()
            method, path = parts[0], parts[1]
            code = args[1]
            print(f'  {code}  {method:6s} {path}')
        except Exception:
            pass

# ── Start ─────────────────────────────────────────────────────────────
if __name__ == '__main__':
    PORT = 5173
    status = 'loaded' if API_KEY else 'MISSING — check your .env file'
    print(f'\n  Calendar server   http://localhost:{PORT}')
    print(f'  API key           {status}')
    print(f'  Serving           {os.getcwd()}  (localhost only)')
    print(f'\n  Press Ctrl+C to stop.\n')
    try:
        # Threading, not plain HTTPServer: a /api/chat proxy call blocks on
        # the Anthropic round-trip for 1-3s, during which a single-threaded
        # server can't serve anything else (a static page load, a second
        # chat message) — they'd all queue behind it.
        # Bound to 127.0.0.1, not '' (all interfaces) — this proxy holds a
        # live Anthropic API key with no auth of its own, so it must not be
        # reachable from anyone else on the same network/Wi-Fi.
        ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print('\n  Server stopped.')
