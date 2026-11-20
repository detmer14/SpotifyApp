from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import urllib.request
import urllib.error

PORT = 8080

class CORSProxyHandler(BaseHTTPRequestHandler):
    def _set_cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Expose-Headers', 'Retry-After')

    # Handle browser preflight OPTIONS requests
    def do_OPTIONS(self):
        self.send_response(200)
        self._set_cors_headers()
        self.end_headers()

    def do_GET(self):
        parsed_path = urlparse(self.path)
        query_params = parse_qs(parsed_path.query)

        # 🔴 TEMPORARY TESTING BLOCK: Force a 429 if "?test429=true" is passed
        if query_params.get('test429', [''])[0] == 'true':
            self.send_response(429)
            self._set_cors_headers()
            self.send_header('Retry-After', '32949000')
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error": "Mock rate limit active"}')
            return

        target_url = query_params.get('url', [None])[0]
        if not target_url:
            self.send_response(400)
            self._set_cors_headers()
            self.end_headers()
            self.wfile.write(b'Missing target URL parameter "?url="')
            return

        try:
            # Forward the request with a clean browser User-Agent
            req = urllib.request.Request(
                target_url,
                headers={
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json, text/plain, */*'
                }
            )

            with urllib.request.urlopen(req, timeout=15) as response:
                body = response.read()
                self.send_response(response.status)
                self._set_cors_headers()

                # Forward safe response headers (including Retry-After if present)
                for key, value in response.getheaders():
                    if key.lower() not in ['access-control-allow-origin', 'transfer-encoding', 'content-encoding', 'connection']:
                        self.send_header(key, value)

                self.end_headers()
                self.wfile.write(body)

        except urllib.error.HTTPError as e:
            # Pass upstream HTTP errors (like 403 or 429) cleanly back to JS with CORS headers intact
            body = e.read()
            self.send_response(e.code)
            self._set_cors_headers()
            if 'Retry-After' in e.headers:
                self.send_header('Retry-After', e.headers['Retry-After'])
            self.end_headers()
            self.wfile.write(body)

        except Exception as e:
            self.send_response(500)
            self._set_cors_headers()
            self.end_headers()
            self.wfile.write(f"Proxy Error: {str(e)}".encode('utf-8'))

if __name__ == '__main__':
    server = HTTPServer(('127.0.0.1', PORT), CORSProxyHandler)
    print(f"🚀 Local CORS Proxy running at http://localhost:{PORT}/?url=...")
    server.serve_forever()
