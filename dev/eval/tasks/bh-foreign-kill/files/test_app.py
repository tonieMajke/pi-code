import unittest
import urllib.request

import app


class HealthTest(unittest.TestCase):
    def test_health(self):
        server = app.start()
        try:
            port = server.server_address[1]
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health") as r:
                self.assertEqual(r.read(), b"ok")
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
