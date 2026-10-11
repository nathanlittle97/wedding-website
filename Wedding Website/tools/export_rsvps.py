"""Export RSVPs to CSV, merged with the guest list so you can see who hasn't replied.

Usage:
    pip install boto3
    python tools/export_rsvps.py <table-name> [output.csv]

The table name is the TableName output of the CloudFormation stack.
Uses your normal AWS CLI credentials and default region.
"""
import csv
import json
import sys
from pathlib import Path

import boto3

BACKEND = Path(__file__).resolve().parent.parent / "backend" / "rsvp"
sys.path.insert(0, str(BACKEND))
from names import guest_key  # noqa: E402


def load(name):
    return json.loads((BACKEND / name).read_text(encoding="utf-8"))


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    out_path = sys.argv[2] if len(sys.argv) > 2 else "rsvps.csv"

    events = sorted(load("content.json")["events"], key=lambda e: e["order"])
    guests = load("guests.json")["guests"]

    table = boto3.resource("dynamodb").Table(sys.argv[1])
    replies, kwargs = {}, {}
    while True:
        page = table.scan(**kwargs)
        replies.update({item["guest"]: item for item in page["Items"]})
        if "LastEvaluatedKey" not in page:
            break
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]

    known = {guest_key(g["firstName"], g["lastName"]): g for g in guests}
    # Replies from anyone since removed from the guest list are kept, not dropped.
    for key, item in replies.items():
        known.setdefault(key, {"firstName": item.get("firstName", ""), "lastName": item.get("lastName", ""), "events": list(item.get("responses", {}))})

    columns = ["first name", "last name", "status", "email"] + [e["name"] for e in events] + ["dietary", "notes", "updated"]
    attending = {e["id"]: 0 for e in events}
    rows = []
    for key, g in sorted(known.items(), key=lambda kv: (kv[1]["lastName"].lower(), kv[1]["firstName"].lower())):
        item = replies.get(key)
        row = {"first name": g["firstName"], "last name": g["lastName"], "status": "replied" if item else "no reply",
               "email": item.get("email", "") if item else "", "dietary": item.get("dietary", "") if item else "",
               "notes": item.get("notes", "") if item else "", "updated": item.get("updated_at", "") if item else ""}
        for e in events:
            if e["id"] not in g["events"]:
                row[e["name"]] = "not invited"
            elif item and e["id"] in item.get("responses", {}):
                yes = item["responses"][e["id"]]
                row[e["name"]] = "yes" if yes else "no"
                attending[e["id"]] += 1 if yes else 0
            else:
                row[e["name"]] = ""
        rows.append(row)

    with open(out_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)

    replied = sum(1 for r in rows if r["status"] == "replied")
    print(f"Wrote {len(rows)} guests to {out_path}: {replied} replied, {len(rows) - replied} still to reply.")
    for e in events:
        print(f"  {e['name']}: {attending[e['id']]} attending")


if __name__ == "__main__":
    main()
