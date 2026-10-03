"""No-cache static server rooted at the repo, so the poster loads the real popup."""
import functools, http.server, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

http.server.ThreadingHTTPServer(('127.0.0.1', 8766), functools.partial(H, directory=str(ROOT))).serve_forever()
