"""Bakes the RARE SHIT voice intros into copies of their tracks.

For every entry in intros/intros.json without a baked file yet, downloads the
original track from the app's media route, lays the voice over its opening
(the music eases down under the voice and back up after it) and writes
public/intro/<trackId>.mp3, the same length as the original. The worker plays
that copy instead of the original on some of the track's airings.

Run by .github/workflows/intros.yml. Local test: LOCAL_DIR=<dir with <filePath>> python3 scripts/bake_intros.py
"""
import json, os, subprocess, sys, urllib.request, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEDIA = 'https://bigunderfm.pages.dev/media/'
LEAD = 2.5      # seconds of untouched music before the voice
DOWN = 1.5      # music eases down over this long before the voice
UP = 3.0        # and back up over this long after it
LOW = 0.22      # music level under the voice


def run(*a, **k):
    return subprocess.run(a, check=True, capture_output=True, text=True, **k)


def duration(path):
    return float(run('ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path).stdout)


def loudness(path):
    """Integrated loudness of the track's first minute, so the voice sits level with it."""
    r = subprocess.run(['ffmpeg', '-hide_banner', '-t', '60', '-i', path, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'],
                       capture_output=True, text=True)
    txt = r.stderr[r.stderr.rfind('{'):]
    try:
        return float(json.loads(txt)['input_i'])
    except Exception:
        return -12.0


def bake(entry, out):
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, 'src')
        local = os.environ.get('LOCAL_DIR')
        if local:
            src = os.path.join(local, entry['filePath'])
        else:
            url = MEDIA + '/'.join(urllib.request.quote(p) for p in entry['filePath'].split('/'))
            req = urllib.request.Request(url, headers={'User-Agent': 'bigunderfm-intros'})
            with urllib.request.urlopen(req, timeout=120) as r, open(src, 'wb') as f:
                f.write(r.read())
        total = duration(src)
        voice = os.path.join(ROOT, entry['voice'])
        vdur = duration(voice)
        end = LEAD + vdur
        target = max(-18.0, min(-10.0, loudness(src) - 1.0))
        a, b = LEAD - DOWN, end + 0.3
        vol = (f"volume='if(lt(t,{a}),1,if(lt(t,{LEAD}),1-(1-{LOW})*(0.5-0.5*cos(PI*(t-{a})/{DOWN})),"
               f"if(lt(t,{b}),{LOW},if(lt(t,{b + UP}),{LOW}+(1-{LOW})*(0.5-0.5*cos(PI*(t-{b})/{UP})),1))))':eval=frame")
        ms = int(LEAD * 1000)
        run('ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-i', voice, '-filter_complex',
            f"[0]aresample=44100,{vol}[m];[1]aresample=44100,loudnorm=I={target}:TP=-2,adelay={ms}|{ms}[v];"
            f"[m][v]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95[o]",
            '-map', '[o]', '-t', str(total), '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '192k', out)
        print(f"{entry['artist']} - {entry['title']}: {total:.0f}s, voice {vdur:.1f}s at {target:.1f} LUFS", flush=True)


def main():
    entries = json.load(open(os.path.join(ROOT, 'intros', 'intros.json')))
    outdir = os.path.join(ROOT, 'public', 'intro')
    os.makedirs(outdir, exist_ok=True)
    failed = 0
    for e in entries:
        out = os.path.join(outdir, e['trackId'] + '.mp3')
        if os.path.exists(out):
            continue
        try:
            bake(e, out)
        except Exception as err:
            failed += 1
            print(f"FAILED {e['artist']} - {e['title']}: {err}", file=sys.stderr, flush=True)
            if os.path.exists(out):
                os.remove(out)
    sys.exit(1 if failed == len(entries) and failed else 0)


if __name__ == '__main__':
    main()
