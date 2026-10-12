import json
from pathlib import Path

import pandas as pd

CSV_PATH = Path(r"C:\Users\natha\OneDrive\Desktop\Wedding\guest_list.csv")
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "backend" / "rsvp" / "guests.json"
EVENT_COLUMNS = ["welcome", "wedding", "brunch"]


def is_invited(value):
    if pd.isna(value):
        return False
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "invite", "invited"}
    return bool(value)


def split_name(value):
    name = str(value).strip()
    if not name:
        return "", ""

    if "," in name:
        last_name, first_name = [part.strip() for part in name.split(",", 1)]
        return first_name, last_name

    parts = name.split()
    if len(parts) == 1:
        return parts[0], ""
    return " ".join(parts[:-1]), parts[-1]


guests = []
guest_list = pd.read_csv(CSV_PATH)

for _, row in guest_list.iterrows():
    full_name = row.get("Guest Name", "")
    first_name, last_name = split_name(full_name)
    if not first_name or not last_name:
        continue

    events = [event for event in EVENT_COLUMNS if is_invited(row.get(event))]
    guests.append({"firstName": first_name, "lastName": last_name, "events": events})

output = {"guests": guests}
OUTPUT_PATH.write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(json.dumps(output, indent=2, ensure_ascii=False))