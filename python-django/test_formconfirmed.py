"""Unit test of the answer handling. Run: python -m unittest"""

import unittest

from formconfirmed import decide, read_answer

NO = lambda: False  # noqa: E731
YES = lambda: True  # noqa: E731

CASES = [
    # (name, HTTP status, body, independent check, expected decision)
    ("allow", 200, '{"success":true,"score":0.9,"action":"allow","reasons":[],"error-codes":[]}', NO, "deliver"),
    ("flag", 200, '{"success":true,"score":0.5,"action":"flag","reasons":["too_fast"]}', NO, "hold"),
    ("flag + own check", 200, '{"success":true,"score":0.5,"action":"flag","reasons":["too_fast"]}', YES, "hold"),
    ("block", 200, '{"success":false,"action":"block","error-codes":["invalid-input-response"]}', NO, "reject"),
    ("browser outage claim", 200,
     '{"success":false,"score":0.35,"action":"flag","reasons":["service_unavailable"],"error-codes":["service-unavailable"]}', NO, "hold"),
    ("outage claim + own check", 200, '{"success":false,"action":"flag","reasons":["service_unavailable"]}', YES, "deliver"),
    ("outage claim with success", 200, '{"success":true,"action":"allow","reasons":["service_unavailable"]}', NO, "hold"),
    ("wrong secret", 200, '{"success":false,"action":"block","error-codes":["invalid-input-secret"]}', NO, "hold"),
    ("site paused", 200, '{"success":false,"action":"block","error-codes":["site-paused"]}', NO, "hold"),
    ("no answer", 0, "", NO, "hold"),
    ("HTTP 500", 500, '{"success":false}', NO, "hold"),
    ("not JSON", 200, "<html>maintenance</html>", NO, "hold"),
    ("unknown action", 200, '{"success":true,"action":"maybe"}', NO, "hold"),
    ("allow without success", 200, '{"success":false,"action":"allow"}', NO, "hold"),
    ("allow with string success", 200, '{"success":"true","action":"allow"}', NO, "hold"),
    ("allow with success 1", 200, '{"success":1,"action":"allow"}', NO, "hold"),
]


class AnswerTest(unittest.TestCase):
    def test_cases(self):
        for name, status, body, check, want in CASES:
            with self.subTest(name):
                self.assertEqual(decide(read_answer(status, body), check), want)


if __name__ == "__main__":
    unittest.main()
