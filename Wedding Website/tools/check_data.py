"""Check guests.json and content.json for mistakes before deploying.

Usage:  python tools/check_data.py
"""
import json
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent / "backend" / "rsvp"
sys.path.insert(0, str(BACKEND))
from names import guest_key  # noqa: E402


def main():
    problems = []
    try:
        content = json.loads((BACKEND / "content.json").read_text(encoding="utf-8"))
        guests = json.loads((BACKEND / "guests.json").read_text(encoding="utf-8"))["guests"]
    except (OSError, ValueError, KeyError) as err:
        sys.exit(f"Could not read the data files: {err}")

    event_ids = [e["id"] for e in content["events"]]
    if len(set(event_ids)) != len(event_ids):
        problems.append("Duplicate event ids in content.json")
    if len({e["order"] for e in content["events"]}) != len(event_ids):
        problems.append("Each event needs a different 'order' number in content.json")

    seen = {}
    for g in guests:
        label = f"{g.get('firstName', '?')} {g.get('lastName', '?')}"
        if not g.get("firstName") or not g.get("lastName"):
            problems.append(f"Guest missing first or last name: {label}")
            continue
        key = guest_key(g["firstName"], g["lastName"])
        if key in seen:
            problems.append(f"Two guests would match the same name: {label} and {seen[key]}")
        seen[key] = label
        for event_id in g.get("events", []):
            if event_id not in event_ids:
                problems.append(f"{label} is invited to unknown event '{event_id}'")
        if not g.get("events"):
            problems.append(f"{label} has no events")

    if problems:
        print("Problems found:")
        for p in problems:
            print("  -", p)
        sys.exit(1)
    print(f"OK: {len(guests)} guests, {len(event_ids)} events.")


if __name__ == "__main__":
    main()
