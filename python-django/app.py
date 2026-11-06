"""Contact form protected by formconfirmed - Django in a single file.

GET / shows the form with the widget, POST / checks the token on the server.
Run: python app.py runserver 127.0.0.1:8000
"""

import json
import os
import re
import secrets
import sys
from datetime import datetime, timezone

from django.conf import settings

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

settings.configure(
    DEBUG=os.environ.get("DJANGO_DEBUG") == "1",
    # Set DJANGO_SECRET_KEY in production (used for the CSRF cookie).
    SECRET_KEY=os.environ.get("DJANGO_SECRET_KEY") or secrets.token_urlsafe(32),
    ALLOWED_HOSTS=os.environ.get("ALLOWED_HOSTS", "127.0.0.1,localhost").split(","),
    ROOT_URLCONF=__name__,
    MIDDLEWARE=[
        "django.middleware.security.SecurityMiddleware",
        "django.middleware.csrf.CsrfViewMiddleware",
    ],
    TEMPLATES=[{"BACKEND": "django.template.backends.django.DjangoTemplates", "DIRS": [], "APP_DIRS": False}],
    DATA_UPLOAD_MAX_MEMORY_SIZE=64 * 1024,
)

import django  # noqa: E402

django.setup()

from django.http import HttpResponse  # noqa: E402
from django.middleware.csrf import get_token  # noqa: E402
from django.template import engines  # noqa: E402
from django.urls import path  # noqa: E402

import formconfirmed as fc  # noqa: E402

cfg = fc.config()
DATA_DIR = os.environ.get("DATA_DIR") or os.path.join(BASE_DIR, "data")

# Django templates escape every {{ value }}.
PAGE = engines["django"].from_string("""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Contact - formconfirmed Django example</title>
  <script src="{{ api }}/widget.js" async defer></script>
  <style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem}label{display:block;margin:.75rem 0}input,textarea{display:block;width:100%;box-sizing:border-box}</style>
</head>
<body>
  <h1>Contact</h1>
  {% if notice %}<p role="status">{{ notice }}</p>{% endif %}
  <form method="post" action="/">
    <input type="hidden" name="csrfmiddlewaretoken" value="{{ csrf }}">
    <label>Name <input name="name" maxlength="60" required></label>
    <label>E-mail <input type="email" name="email" maxlength="80" required></label>
    <label>Message <textarea name="message" rows="6" maxlength="5000" required></textarea></label>
    <div class="fcp-widget" data-sitekey="{{ sitekey }}" data-purpose="{{ purpose }}"></div>
    <button type="submit">Send</button>
  </form>
</body>
</html>""")


def page(request, status, notice=""):
    html = PAGE.render({"api": cfg["api"], "sitekey": cfg["sitekey"], "purpose": fc.PURPOSE,
                        "notice": notice, "csrf": get_token(request)})
    return HttpResponse(html, status=status)


def store(file, record):
    """Appends one message as a JSON line - stands in for sending an e-mail or a moderation queue."""
    os.makedirs(DATA_DIR, mode=0o700, exist_ok=True)
    record = {"time": datetime.now(timezone.utc).isoformat(), **record}
    with open(os.path.join(DATA_DIR, file), "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def independent_check_passed(request, form):
    """Hook for an independent check of your own application that may stand in when formconfirmed gave
    no clear answer - e.g. request.user is logged in, or a strict CAPTCHA you already run has passed.
    It must not depend on formconfirmed. Without such a check, return False: the message is held."""
    return False


def contact(request):
    if request.method != "POST":
        return page(request, 200)

    p = request.POST
    form = {k: p.get(k, "").strip() for k in ("name", "email", "message")}
    limits = {"name": 60, "email": 80, "message": 5000}
    if any(not form[k] or len(form[k]) > n for k, n in limits.items()):
        return page(request, 400, "Please fill in all fields (name up to 60, e-mail up to 80, message up to 5000 characters).")
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", form["email"]):
        return page(request, 400, "Please enter a valid e-mail address.")

    result = fc.verify(
        cfg,
        response=p.get(fc.FIELD, ""),
        hp=p.get(fc.HONEYPOT, ""),
        remoteip=request.META.get("REMOTE_ADDR", ""),  # behind a proxy: the real visitor address
        email=form["email"],
        name=form["name"],
        content=form["message"],
    )
    decision = fc.decide(result, lambda: independent_check_passed(request, form))

    if decision == "deliver":
        # Send the e-mail here. The example writes the message to data/delivered.jsonl.
        store("delivered.jsonl", {**form, "score": result["score"]})
        return page(request, 200, "Thank you. Your message has been sent.")
    if decision == "hold":
        # HOLD FOR REVIEW: no clear pass (flag, or no clear answer from the service).
        # Keep the message for a human to look at - never deliver it silently.
        why = "unavailable" if result["unavailable"] else result["action"]
        store("held.jsonl", {**form, "why": why, "codes": result["codes"], "reasons": result["reasons"]})
        return page(request, 202, "Thank you. Your message has been received and will be reviewed before it is processed.")
    if "service_unavailable" in result["reasons"]:
        return page(request, 403, "Your message could not be checked right now. Please try again in a few minutes.")
    return page(request, 403, "Your message could not be sent. Please reload the page and try again.")


urlpatterns = [path("", contact)]

if __name__ == "__main__":
    from django.core.management import execute_from_command_line

    execute_from_command_line(sys.argv)
