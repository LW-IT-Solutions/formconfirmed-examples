"""Minimal formconfirmed client: ask /v1/verify and turn the answer into a decision.

Outage rule: anything that is not a clear answer of the service is never a pass.
No answer, a timeout, an HTTP error, an unknown answer, an error code that means
"no check took place", or a token in which the visitor's browser only *claims*
that the service was unreachable (reason service_unavailable) - all of these are
"unavailable". Such a message is delivered only if an independent check of your
own application passed; otherwise it is held for review.

Standard library only (urllib), so it works with any framework.
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request

FIELD = "fcp-response"  # hidden field with the token (added by the widget)
HONEYPOT = "fcp-website"  # trap field (added by the widget)
PURPOSE = "contact"  # must match data-purpose of the widget
TIMEOUT = 5  # seconds, never more

# Error codes that mean "no check took place" (not the visitor's fault).
NO_CHECK_CODES = ("service-disabled", "site-paused", "invalid-input-secret", "missing-input-secret", "bad-request")


def config():
    return {
        "api": (os.environ.get("FORMCONFIRMED_API") or "https://formconfirmed.com/v1").rstrip("/"),
        "sitekey": os.environ.get("FORMCONFIRMED_SITEKEY", ""),
        "secret": os.environ.get("FORMCONFIRMED_SECRET", ""),
    }


def verify(cfg, response="", hp="", remoteip="", email="", name="", content=""):
    """Sends the token to POST /verify and returns the result of read_answer()."""
    body = {
        "secret": cfg["secret"],
        "response": response[:4000],
        "hp": hp[:2048],
        "remoteip": remoteip,
        "expected_purpose": PURPOSE,
        "form_mode": "interactive",
    }
    for key, value in (("email", email), ("name", name), ("content", content)):
        if value:
            body[key] = value
    req = urllib.request.Request(cfg["api"] + "/verify", data=urllib.parse.urlencode(body).encode(), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            return read_answer(res.status, res.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        return read_answer(e.code, "")
    except Exception:  # network error, timeout, TLS error ...
        return read_answer(0, "")


def read_answer(status, body):
    """Result dict: action (allow|flag|block|none), unavailable, score, reasons, codes. status 0 = no answer."""
    none = {"action": "none", "unavailable": True, "score": None, "reasons": [],
            "codes": ["no-answer" if status == 0 else "http-%d" % status]}
    if status != 200:
        return none
    try:
        j = json.loads(body)
    except ValueError:
        j = None
    if not isinstance(j, dict) or not isinstance(j.get("action"), str):
        return {**none, "codes": ["invalid-answer"]}

    def strings(v):
        v = v if isinstance(v, list) else ([] if v is None else [v])
        return [x for x in v if isinstance(x, str)]

    codes = strings(j.get("error-codes"))
    reasons = strings(j.get("reasons"))
    no_check = [c for c in codes if c in NO_CHECK_CODES]
    if no_check:
        return {**none, "codes": no_check}
    if j["action"] not in ("allow", "flag", "block") or (j["action"] == "allow" and j.get("success") is not True):
        return {**none, "codes": ["invalid-answer"]}
    score = j.get("score")
    return {
        "action": j["action"],
        # The browser could not reach the service: an unsigned claim, not a check.
        "unavailable": j["action"] != "block" and "service_unavailable" in reasons,
        "score": float(score) if isinstance(score, (int, float)) and not isinstance(score, bool) else None,
        "reasons": reasons,
        "codes": codes,
    }


def decide(result, independent_check):
    """'deliver', 'hold' or 'reject'. independent_check: your own check that does not depend on formconfirmed."""
    if result["action"] == "block":
        return "reject"
    if result["unavailable"]:
        return "deliver" if independent_check() else "hold"
    if result["action"] == "flag":
        return "hold"  # flag is never a pass
    return "deliver" if result["action"] == "allow" else "hold"
