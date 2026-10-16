import base64
import hashlib
import hmac
import json
import os
import re
import time
from datetime import datetime, timezone

import boto3

from names import guest_key

HERE = os.path.dirname(os.path.abspath(__file__))
TABLE = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
SNS = boto3.client("sns")
SES = boto3.client("ses")
TOPIC_ARN = os.environ.get("TOPIC_ARN", "")
SENDER = os.environ.get("SENDER_EMAIL", "")
SITE_URL = os.environ.get("SITE_URL", "")
RESEND_AFTER = 600  # seconds: at most one guest confirmation email per guest per 10 minutes
PASSWORD = os.environ["SITE_PASSWORD"]
SIGNING_KEY = hashlib.sha256(("wedding-token:" + PASSWORD).encode()).digest()
TOKEN_TTL = 14 * 24 * 3600
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _load(name):
    with open(os.path.join(HERE, name), encoding="utf-8") as f:
        return json.load(f)


CONTENT = _load("content.json")
GUESTS = {guest_key(g["firstName"], g["lastName"]): g for g in _load("guests.json")["guests"]}
EVENTS = sorted(CONTENT["events"], key=lambda e: e["order"])


# ---------- helpers ----------

def _resp(status, body):
    # CORS headers come from the Function URL config, not from here.
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json", "Cache-Control": "no-store"},
        "body": json.dumps(body),
    }


def _clean(value, max_len):
    return value.strip()[:max_len] if isinstance(value, str) else ""


def _body(event):
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode("utf-8")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("body must be an object")
    return data


def _b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _mac(payload):
    return _b64(hmac.new(SIGNING_KEY, payload.encode(), hashlib.sha256).digest())


def _sign(key):
    payload = _b64(json.dumps({"g": key, "exp": int(time.time()) + TOKEN_TTL}).encode())
    return f"{payload}.{_mac(payload)}"


def _verify(token):
    try:
        payload, sig = token.split(".")
        if not hmac.compare_digest(sig, _mac(payload)):
            return None
        data = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        return data["g"] if data["exp"] > time.time() and data["g"] in GUESTS else None
    except Exception:
        return None


def _auth_key(event):
    header = (event.get("headers") or {}).get("authorization", "")
    return _verify(header[7:]) if header.lower().startswith("bearer ") else None


def _public(guest):
    return {"firstName": guest["firstName"], "lastName": guest["lastName"]}


# ---------- notifications (best effort: a failure never loses an RSVP) ----------

def _answers(responses):
    return "\n".join(f"  {e['name']}: {'Yes' if responses[e['id']] else 'No'}" for e in EVENTS if e["id"] in responses)


def _email_guest(guest, email, responses, dietary, notes, previous):
    if not SENDER:
        return "not configured"
    if previous and previous.get("updated_at"):
        try:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(previous["updated_at"])).total_seconds()
            if age < RESEND_AFTER:
                return "skipped (they replied again within 10 minutes)"
        except ValueError:
            pass
    lines = [f"Hi {guest['firstName']},", "", "Thank you for your reply. This is what we have for you:", "", _answers(responses), ""]
    lines.append(f"Dietary requirements: {dietary or 'none given'}")
    lines.append(f"Other details: {notes or 'none given'}")
    lines += ["", "If anything changes, send the RSVP form again on the website and your latest reply will replace this one."]
    if SITE_URL:
        lines.append(SITE_URL)
    lines += ["", "Nathan and Ashling"]
    try:
        SES.send_email(
            Source=f"Nathan and Ashling <{SENDER}>",
            Destination={"ToAddresses": [email]},
            Message={
                "Subject": {"Data": "Your RSVP for Nathan and Ashling's wedding", "Charset": "UTF-8"},
                "Body": {"Text": {"Data": "\n".join(lines), "Charset": "UTF-8"}},
            },
        )
        return "sent"
    except Exception as err:
        code = getattr(err, "response", {}).get("Error", {}).get("Code", type(err).__name__)
        print(f"Guest confirmation failed: {err}")
        return f"not sent ({code})"


def _notify_owner(guest, email, responses, dietary, notes, updated, confirmation):
    if not TOPIC_ARN:
        return
    subject = f"RSVP {'updated' if updated else 'received'}: {guest['firstName']} {guest['lastName']}"
    subject = " ".join(subject.encode("ascii", "replace").decode().split())[:100]
    message = "\n".join([
        f"{guest['firstName']} {guest['lastName']} {'updated their RSVP' if updated else 'sent an RSVP'}.",
        "",
        f"Email: {email}",
        _answers(responses),
        "",
        f"Dietary requirements: {dietary or 'none given'}",
        f"Other details: {notes or 'none given'}",
        "",
        f"Confirmation email to guest: {confirmation}",
    ])
    try:
        SNS.publish(TopicArn=TOPIC_ARN, Subject=subject, Message=message)
    except Exception as err:
        print(f"Owner notification failed: {err}")


# ---------- routes ----------

def login(event):
    data = _body(event)
    password = data.get("password")

    if isinstance(password, str) and password:
        allowed = hmac.compare_digest(password.encode(), PASSWORD.encode())
        denied = "That password isn't right. Please check your invitation."
    else:
        # Switching guest: an existing valid session proves the password is known.
        allowed = _auth_key(event) is not None
        denied = "Please sign in again with the password from your invitation."
    if not allowed:
        time.sleep(1)  # slows down password guessing
        return _resp(401, {"error": denied})

    first, last = _clean(data.get("firstName"), 60), _clean(data.get("lastName"), 60)
    if not first or not last:
        return _resp(400, {"error": "Please enter your first and last name."})

    key = guest_key(first, last)
    guest = GUESTS.get(key)
    if not guest:
        return _resp(404, {"error": "We couldn't find that name on the guest list. Please check the spelling, or contact us."})

    return _resp(200, {"token": _sign(key), "guest": _public(guest)})


def content(event):
    key = _auth_key(event)
    if not key:
        return _resp(401, {"error": "Please sign in again."})
    guest = GUESTS[key]

    item = TABLE.get_item(Key={"guest": key}).get("Item")
    rsvp = None
    if item:
        rsvp = {k: item.get(k, "") for k in ("email", "dietary", "notes")}
        rsvp["responses"] = item.get("responses", {})

    return _resp(200, {
        "guest": _public(guest),
        "home": CONTENT["home"],
        "events": [e for e in EVENTS if e["id"] in guest["events"]],
        "accommodation": CONTENT["accommodation"],
        "faqs": CONTENT["faqs"],
        "rsvp": rsvp,
    })


def rsvp(event):
    key = _auth_key(event)
    if not key:
        return _resp(401, {"error": "Please sign in again."})
    guest = GUESTS[key]
    data = _body(event)

    email = _clean(data.get("email"), 254).lower()
    if not EMAIL_RE.match(email):
        return _resp(400, {"error": "Please enter a valid email address."})

    sent = data.get("responses")
    sent = sent if isinstance(sent, dict) else {}
    responses = {}
    for event_id in guest["events"]:
        if not isinstance(sent.get(event_id), bool):
            return _resp(400, {"error": "Please say whether you can come to each event."})
        responses[event_id] = sent[event_id]

    dietary = _clean(data.get("dietary"), 500)
    notes = _clean(data.get("notes"), 1000)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    result = TABLE.update_item(
        Key={"guest": key},
        UpdateExpression=(
            "SET firstName = :f, lastName = :l, email = :e, responses = :r, dietary = :d, "
            "notes = :n, updated_at = :t, created_at = if_not_exists(created_at, :t)"
        ),
        ExpressionAttributeValues={
            ":f": guest["firstName"], ":l": guest["lastName"], ":e": email, ":r": responses,
            ":d": dietary, ":n": notes, ":t": now,
        },
        ReturnValues="ALL_OLD",
    )
    previous = result.get("Attributes")

    confirmation = _email_guest(guest, email, responses, dietary, notes, previous)
    _notify_owner(guest, email, responses, dietary, notes, previous is not None, confirmation)
    return _resp(200, {"ok": True})


ROUTES = {("POST", "/login"): login, ("GET", "/content"): content, ("POST", "/rsvp"): rsvp}


def lambda_handler(event, context):
    http = event["requestContext"]["http"]
    handler = ROUTES.get((http["method"], event.get("rawPath", "/").rstrip("/") or "/"))
    if not handler:
        return _resp(404, {"error": "Not found."})
    try:
        return handler(event)
    except ValueError:
        return _resp(400, {"error": "Invalid request."})
