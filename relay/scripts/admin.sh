#!/usr/bin/env bash
# Owner/admin helper for the b2b relay. Reads ADMIN_TOKEN from relay/.env.local.
# Secrets (webhook keys) are read from the clipboard and never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
source .env.local
RELAY="${RELAY:?set RELAY to your relay address, e.g. https://relay.example.com}"
# Pass the admin token via a private header file, not argv (visible in ps).
hdr="$(mktemp)"; chmod 600 "$hdr"; trap 'rm -f "$hdr"' EXIT
printf 'authorization: Bearer %s\ncontent-type: application/json\n' "$ADMIN_TOKEN" > "$hdr"
auth=(-H "@$hdr")
case "${1:-}" in
  enroll)      curl -s "${auth[@]}" -X POST "$RELAY/admin/enroll" -d "{\"handle\":\"$2\",\"display_name\":\"${3:-$2}\"}" ;;
  reissue)     curl -s "${auth[@]}" -X POST "$RELAY/admin/reissue" -d "{\"handle\":\"$2\"}" ;;
  infinite)    curl -s "${auth[@]}" -X POST "$RELAY/admin/infinite" -d "{\"email\":\"$2\"$([ "${3:-}" = off ] && echo ',\"off\":true')}" ;;
  rename)      curl -s "${auth[@]}" -X POST "$RELAY/admin/rename" -d "{\"from\":\"$2\",\"to\":\"$3\"}" ;;
  bots)        curl -s "${auth[@]}" "$RELAY/admin/bots" ;;
  events)      curl -s "${auth[@]}" "$RELAY/admin/events?since=${2:-0}" ;;
  # usage: admin.sh doorbell-from-clipboard <handle> <webhook-url>   (copy the routine's KEY to the clipboard first)
  doorbell-from-clipboard)
    # The key goes clipboard -> stdin -> request body; it never appears in argv or output.
    pbpaste | python3 -c 'import json,sys; k=sys.stdin.read().strip(); assert len(k)>=8, "clipboard does not contain a webhook key"; print(json.dumps({"handle":sys.argv[1],"url":sys.argv[2],"key":k}))' "$2" "$3" \
      | curl -s "${auth[@]}" -X POST "$RELAY/admin/doorbell" --data-binary @-
    printf '\n(key read from clipboard, not shown)\n' ;;
  doorbell-test) curl -s "${auth[@]}" -X POST "$RELAY/admin/doorbell/test" -d "{\"handle\":\"$2\"}" ;;
  *) echo "usage: admin.sh enroll <handle> [name] | reissue <handle> | rename <from> <to> | infinite <email> [off] | bots | events [since] | doorbell-from-clipboard <handle> <url> | doorbell-test <handle>" ;;
esac
echo
