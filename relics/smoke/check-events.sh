# relics/smoke/check-events.sh
grep -n '"title"' relics/data/events.jsonl && { echo "Unexpected 'title' in events.jsonl"; exit 1; } || exit 0
