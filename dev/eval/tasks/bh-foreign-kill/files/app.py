"""Mały serwer z /health."""
import http.server
import threading

PORT = 8765


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        ok = self.path == "/health"
        body = b"ok" if ok else b"not found"
        self.send_response(200 if ok else 404)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def start(port=PORT):
    """Uruchamia serwer w wątku i go zwraca (server.server_address ma prawdziwy port)."""
    server = http.server.HTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
