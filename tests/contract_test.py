#!/usr/bin/env python3
"""Contract test for the examples - the same checks for every language.

Starts a fake formconfirmed API on 127.0.0.1, starts the example with environment
variables pointing to it, submits the contact form and checks what happened:
delivered (HTTP 200, a line in delivered.jsonl), held for review (HTTP 202, a line in
held.jsonl) or rejected (HTTP 403, nothing stored).

Usage (from inside an example folder, after installing its dependencies):

    python3 ../tests/contract_test.py -- php -S 127.0.0.1:{port} -t public public/index.php
    python3 ../tests/contract_test.py -- node app.js

"{port}" in the command is replaced by the port; the example also gets PORT, HOST,
DATA_DIR, FORMCONFIRMED_API, FORMCONFIRMED_SITEKEY and FORMCONFIRMED_SECRET.
Standard library only. The fake API is for tests only - it is not formconfirmed.
"""

import argparse
import http.cookiejar
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SITEKEY = 'fcp_pub_contract"><b>test'  # contains HTML on purpose: must come back escaped
SECRET = "fcp_sec_contract_test"


def answer(action, success, reasons=(), codes=(), score=None):
    return {"success": success, "score": score if score is not None else (0.9 if action == "allow" else 0.0),
            "action": action, "reasons": list(reasons), "error-codes": list(codes)}


# token -> (HTTP status, body). Body "slow" = answer after 8 s (longer than the 5 s timeout).
SCENARIOS = {
    "t-allow": (200, answer("allow", True)),
    "t-flag": (200, answer("flag", True, ["too_fast"], score=0.4)),
    "t-block": (200, answer("block", False, codes=["invalid-input-response"])),
    "t-outage-claim": (200, answer("flag", False, ["service_unavailable"], ["service-unavailable"], 0.35)),
    "t-outage-claim-success": (200, answer("allow", True, ["service_unavailable"], score=0.5)),
    "t-outage-claim-block": (200, answer("block", False, ["service_unavailable"], ["service-unavailable"])),
    "t-bad-secret": (200, answer("block", False, codes=["invalid-input-secret"])),
    "t-site-paused": (200, answer("block", False, codes=["site-paused"])),
    "t-service-disabled": (200, answer("block", False, codes=["service-disabled"])),
    "t-http-500": (500, {"success": False, "error-codes": ["internal-error"]}),
    "t-http-429": (429, {"success": False, "error-codes": ["rate-limited"]}),
    "t-html": (200, "<html><body>Maintenance</body></html>"),
    "t-unknown-action": (200, {"success": True, "action": "maybe"}),
    "t-allow-no-success": (200, {"success": False, "action": "allow"}),
    "t-allow-string-success": (200, {"success": "true", "action": "allow"}),
    "t-slow": (200, "slow"),
}
MISSING = (200, answer("block", False, codes=["missing-input-response"]))
UNKNOWN = (200, answer("block", False, codes=["invalid-input-response"]))

# (name, form fields, expected outcome)
FORM = {"name": "Jane Doe", "email": "jane@example.org", "message": "Hello, I would like to know more about your offer."}
CASES = [
    ("valid token -> delivered", {"fcp-response": "t-allow"}, "delivered"),
    ("flag -> held", {"fcp-response": "t-flag"}, "held"),
    ("block -> rejected", {"fcp-response": "t-block"}, "rejected"),
    ("no token -> rejected", {}, "rejected"),
    ("wrong token -> rejected", {"fcp-response": "something-else"}, "rejected"),
    ("browser outage claim (flag + service_unavailable) -> held", {"fcp-response": "t-outage-claim"}, "held"),
    ("outage claim with success:true -> held", {"fcp-response": "t-outage-claim-success"}, "held"),
    ("outage claim with block -> rejected", {"fcp-response": "t-outage-claim-block"}, "rejected"),
    ("invalid-input-secret -> held", {"fcp-response": "t-bad-secret"}, "held"),
    ("site-paused -> held", {"fcp-response": "t-site-paused"}, "held"),
    ("service-disabled -> held", {"fcp-response": "t-service-disabled"}, "held"),
    ("HTTP 500 -> held", {"fcp-response": "t-http-500"}, "held"),
    ("HTTP 429 -> held", {"fcp-response": "t-http-429"}, "held"),
    ("HTML instead of JSON -> held", {"fcp-response": "t-html"}, "held"),
    ("unknown action -> held", {"fcp-response": "t-unknown-action"}, "held"),
    ("allow without success -> held", {"fcp-response": "t-allow-no-success"}, "held"),
    ("allow with success \"true\" (string) -> held", {"fcp-response": "t-allow-string-success"}, "held"),
    ("API slower than 5 s -> held", {"fcp-response": "t-slow"}, "held"),
]
STATUS = {"delivered": 200, "held": 202, "rejected": 403}


class FakeApi(BaseHTTPRequestHandler):
    requests = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8", "replace")
        if (self.headers.get("Content-Type") or "").startswith("application/json"):
            fields = json.loads(raw or "{}")
        else:
            fields = {k: v[0] for k, v in urllib.parse.parse_qs(raw, keep_blank_values=True).items()}
        FakeApi.requests.append({"path": self.path, "fields": fields})
        if self.path != "/v1/verify":
            return self.reply(404, {"error": "not-found"})
        token = fields.get("response", "")
        status, body = MISSING if token == "" else SCENARIOS.get(token, UNKNOWN)
        if body == "slow":
            time.sleep(8)
            body = answer("allow", True)
        self.reply(status, body)

    def reply(self, status, body):
        data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "text/html" if isinstance(body, str) else "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the example gave up waiting - as it should


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Example:
    def __init__(self, command, api, data_dir, startup):
        self.port = free_port()
        self.base = "http://127.0.0.1:%d/" % self.port
        env = dict(os.environ, PORT=str(self.port), HOST="127.0.0.1", DATA_DIR=data_dir,
                   FORMCONFIRMED_API=api, FORMCONFIRMED_SITEKEY=SITEKEY, FORMCONFIRMED_SECRET=SECRET)
        cmd = [c.replace("{port}", str(self.port)) for c in command]
        self.log = tempfile.TemporaryFile()
        # Own process group, so that a wrapper (npm, mvn, dotnet run) and its child stop together.
        self.proc = subprocess.Popen(cmd, env=env, stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.time() + startup
        while time.time() < deadline:
            if self.proc.poll() is not None:
                break
            try:
                urllib.request.urlopen(self.base, timeout=2).read()
                return
            except urllib.error.HTTPError:
                return
            except Exception:
                time.sleep(0.5)
        self.stop()
        self.log.seek(0)
        sys.exit("The example did not start:\n" + self.log.read().decode("utf-8", "replace")[-3000:])

    def stop(self):
        if self.proc.poll() is None:
            os.killpg(self.proc.pid, signal.SIGTERM)
            try:
                self.proc.wait(20)
            except subprocess.TimeoutExpired:
                os.killpg(self.proc.pid, signal.SIGINT)
                self.proc.wait(10)


def hidden_inputs(html):
    """Hidden fields of the page other than the widget's (e.g. a CSRF token)."""
    out = {}
    for tag in re.findall(r"<input[^>]*>", html):
        if 'type="hidden"' in tag:
            name = re.search(r'name="([^"]*)"', tag)
            value = re.search(r'value="([^"]*)"', tag)
            if name and not name.group(1).startswith("fcp-"):
                out[name.group(1)] = value.group(1) if value else ""
    return out


def submit(base, fields):
    """GET the form (cookies, CSRF), then POST it. Returns (status, html, seconds)."""
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    html = opener.open(base, timeout=10).read().decode()
    data = urllib.parse.urlencode({**hidden_inputs(html), **fields}).encode()
    t0 = time.time()
    try:
        res = opener.open(urllib.request.Request(base, data=data), timeout=30)
        status, body = res.status, res.read().decode()
    except urllib.error.HTTPError as e:
        status, body = e.code, e.read().decode()
    return status, body, time.time() - t0


def lines(data_dir, name):
    try:
        with open(os.path.join(data_dir, name), encoding="utf-8") as f:
            return [json.loads(x) for x in f if x.strip()]
    except FileNotFoundError:
        return []


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--startup", type=int, default=120, help="seconds to wait for the example to start")
    ap.add_argument("command", nargs=argparse.REMAINDER)
    args = ap.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        ap.error("command missing")

    api_server = ThreadingHTTPServer(("127.0.0.1", 0), FakeApi)
    threading.Thread(target=api_server.serve_forever, daemon=True).start()
    api = "http://127.0.0.1:%d/v1" % api_server.server_address[1]
    data_dir = tempfile.mkdtemp(prefix="fc-contract-")
    ok = fail = 0

    def check(name, cond, info=""):
        nonlocal ok, fail
        if cond:
            ok += 1
            print("ok   " + name)
        else:
            fail += 1
            print("FAIL %s %s" % (name, info))

    app = Example(command, api, data_dir, args.startup)
    try:
        html = urllib.request.urlopen(app.base, timeout=10).read().decode()
        check("GET shows the widget", 'class="fcp-widget"' in html and 'data-purpose="contact"' in html)
        check("GET loads widget.js from FORMCONFIRMED_API", api + "/widget.js" in html)
        check("GET escapes the site key", "fcp_pub_contract" in html and '"><b>' not in html)

        for name, extra, want in CASES:
            before = (len(lines(data_dir, "delivered.jsonl")), len(lines(data_dir, "held.jsonl")))
            n_req = len(FakeApi.requests)
            status, body, secs = submit(app.base, {**FORM, **extra})
            after = (len(lines(data_dir, "delivered.jsonl")), len(lines(data_dir, "held.jsonl")))
            stored = {"delivered": (1, 0), "held": (0, 1), "rejected": (0, 0)}[want]
            got = (after[0] - before[0], after[1] - before[1])
            check(name, status == STATUS[want] and got == stored,
                  "status %d (want %d), stored delivered/held %s (want %s)" % (status, STATUS[want], got, stored))
            if extra.get("fcp-response") == "t-slow":
                check("verify gives up after at most 5 s (took %.1f s)" % secs, secs < 7)
            if want == "rejected" or want == "held":
                check(name + ": no success message", "has been sent" not in body)
            if name.startswith("valid token") and len(FakeApi.requests) > n_req:
                f = FakeApi.requests[-1]["fields"]
                check("verify gets secret, token and purpose",
                      f.get("secret") == SECRET and f.get("response") == "t-allow" and f.get("expected_purpose") == "contact", f)
                check("verify gets remoteip, email, content", f.get("remoteip") in ("127.0.0.1", "::1")
                      and f.get("email") == FORM["email"] and f.get("content") == FORM["message"], f)

        status, _, _ = submit(app.base, {**FORM, "fcp-response": "t-allow", "fcp-website": "http://spam.example"})
        f = FakeApi.requests[-1]["fields"]
        check("honeypot value is passed as hp", f.get("hp") == "http://spam.example", f)

        n_req = len(FakeApi.requests)
        status, _, _ = submit(app.base, {"name": "", "email": "x", "message": "", "fcp-response": "t-allow"})
        check("invalid form -> 400 without asking the API", status == 400 and len(FakeApi.requests) == n_req, status)

        held = lines(data_dir, "held.jsonl")
        check("held record says why", all(r.get("why") in ("flag", "unavailable") for r in held), held[-1:])
    finally:
        app.stop()

    # API not reachable at all: a valid-looking token must not get through.
    dead = "http://127.0.0.1:%d/v1" % free_port()
    app = Example(command, dead, data_dir, args.startup)
    try:
        before = (len(lines(data_dir, "delivered.jsonl")), len(lines(data_dir, "held.jsonl")))
        status, _, _ = submit(app.base, {**FORM, "fcp-response": "t-allow"})
        after = (len(lines(data_dir, "delivered.jsonl")), len(lines(data_dir, "held.jsonl")))
        check("API not reachable -> held", status == 202 and after[0] == before[0] and after[1] == before[1] + 1,
              "status %d, delivered/held %s -> %s" % (status, before, after))
    finally:
        app.stop()
        api_server.shutdown()
        shutil.rmtree(data_dir, ignore_errors=True)

    print("\n%d ok, %d failed" % (ok, fail))
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    main()
