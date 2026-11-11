#!/bin/bash
# Safety-net playlist: copies the library from the Worker into /var/radio/playlist.m3u
# (only rewritten when it changed). The Worker's own picks normally go through the queue.
set -eu
. /etc/radio.env
tmp=$(mktemp)
trap 'rm -f "$tmp" "$tmp.m3u"' EXIT
curl -fsS --max-time 30 -H "X-Internal-Secret: $INTERNAL_SECRET" "$WORKER_URL/internal/playlist.tsv" -o "$tmp" || exit 0
[ -s "$tmp" ] || exit 0
python3 - "$tmp" "$tmp.m3u" "$R2_PUBLIC_BASE" <<'PY'
import sys
src, dst, base = sys.argv[1:4]
def esc(s):
    return s.replace('\\', '').replace('"', '\\"').replace('\r', ' ').replace('\n', ' ')
with open(src, encoding='utf-8') as f, open(dst, 'w', encoding='utf-8') as out:
    for line in f:
        parts = line.rstrip('\n').split('\t')
        if len(parts) < 3 or not parts[0]:
            continue
        path, title, artist = parts[0], parts[1], parts[2]
        if artist == 'Unknown Artist':
            artist = ''
        out.write(f'annotate:title="{esc(title)}",artist="{esc(artist)}":{base}/{path}\n')
PY
if ! cmp -s "$tmp.m3u" /var/radio/playlist.m3u; then
  cat "$tmp.m3u" > /var/radio/playlist.m3u
fi
