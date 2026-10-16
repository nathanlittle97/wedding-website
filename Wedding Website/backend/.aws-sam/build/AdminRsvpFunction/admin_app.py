"""Read-only API for the Cognito-authenticated RSVP dashboard."""
import json
import os
from pathlib import Path

import boto3

from names import guest_key

HERE = Path(__file__).resolve().parent
TABLE = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
GUESTS = json.loads((HERE / "guests.json").read_text(encoding="utf-8"))["guests"]
EVENTS = sorted(
    json.loads((HERE / "content.json").read_text(encoding="utf-8"))["events"],
    key=lambda event: event["order"],
)


def lambda_handler(event, context):
    replies = {}
    kwargs = {}
    while True:
        page = TABLE.scan(**kwargs)
        replies.update({item["guest"]: item for item in page["Items"]})
        if "LastEvaluatedKey" not in page:
            break
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]

    known = {guest_key(guest["firstName"], guest["lastName"]): guest for guest in GUESTS}
    for key, item in replies.items():
        known.setdefault(
            key,
            {
                "firstName": item.get("firstName", ""),
                "lastName": item.get("lastName", ""),
                "events": list(item.get("responses", {})),
            },
        )

    guests = []
    for key, guest in sorted(
        known.items(),
        key=lambda pair: (
            pair[1]["lastName"].casefold(),
            pair[1]["firstName"].casefold(),
        ),
    ):
        item = replies.get(key)
        guests.append(
            {
                "firstName": guest["firstName"],
                "lastName": guest["lastName"],
                "replied": item is not None,
                "email": item.get("email", "") if item else "",
                "responses": item.get("responses", {}) if item else {},
                "events": guest["events"],
                "dietary": item.get("dietary", "") if item else "",
                "notes": item.get("notes", "") if item else "",
                "updatedAt": item.get("updated_at", "") if item else "",
            }
        )

    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json", "Cache-Control": "no-store"},
        "body": json.dumps(
            {
                "events": [{"id": event["id"], "name": event["name"]} for event in EVENTS],
                "guests": guests,
            }
        ),
    }
