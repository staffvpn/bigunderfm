#!/usr/bin/env python3
"""Control bridge between the Cloudflare Worker and Liquidsoap (telnet on 127.0.0.1:1234).

nginx exposes it at /skip-bridge/ ; every call needs `Authorization: Bearer $SKIP_BRIDGE_SECRET`.
The Worker feeds tracks through POST /queue. Liquidsoap 2.2 cannot remove a track from its
queue, so the bridge keeps the not-yet-loaded tracks itself (removable) and hands Liquidsoap
exactly one track ahead of the one on air.
"""
import hmac
import json
import os
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SECRET = os.environ["SKIP_BRIDGE_SECRET"]
STATE = "/var/radio/pending.json"
PENDING_BASE = 1_000_000  # ids of tracks held by the bridge; Liquidsoap's own request ids are small

lock = threading.Lock()
pending = []  # [{"id": int, "uri": str}]
counter = PENDING_BASE


def tel(cmd, timeout=5):
    with socket.create_connection(("127.0.0.1", 1234), timeout=timeout) as s:
        s.settimeout(timeout)
        s.sendall((cmd + "\nquit\n").encode())
        data = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            data += chunk
    lines = data.decode("utf-8", "replace").replace("\r", "").split("\n")
    out = []
    for line in lines:
        if line == "END":
            break
        out.append(line)
    return "\n".join(out).strip()


def rids(cmd):
    return [int(x) for x in tel(cmd).split() if x.isdigit()]


def metadata_uri(rid):
    for line in tel(f"request.metadata {rid}").split("\n"):
        if line.startswith("initial_uri="):
            return json.loads(line[len("initial_uri="):])
    return ""


def upcoming_rids():
    air = set(rids("request.on_air"))
    return [r for r in rids("queue.queue") if r not in air]


def save():
    try:
        with open(STATE, "w") as f:
            json.dump({"pending": pending, "counter": counter}, f)
    except OSError:
        pass


def load():
    global pending, counter
    try:
        with open(STATE) as f:
            d = json.load(f)
        pending = d.get("pending", [])
        counter = max(d.get("counter", PENDING_BASE), PENDING_BASE)
    except (OSError, ValueError):
        pass


def feeder():
    while True:
        time.sleep(2)
        try:
            with lock:
                if pending and not upcoming_rids():
                    item = pending.pop(0)
                    tel("queue.push " + item["uri"])
                    save()
        except Exception as err:  # Liquidsoap restarting etc.
            print("feeder:", err, flush=True)


def list_items():
    items = []
    for r in upcoming_rids():
        items.append({"rid": r, "uri": metadata_uri(r)})
    for p in pending:
        items.append({"rid": p["id"], "uri": p["uri"]})
    return items


def get_float(name):
    return float(tel(f"var.get {name}"))


def set_float(name, value):
    tel(f"var.set {name} = {float(value)}")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return {}

    def authorized(self):
        got = self.headers.get("Authorization", "")
        return hmac.compare_digest(got, f"Bearer {SECRET}")

    def handle_any(self, method):
        if not self.authorized():
            return self.reply(401, {"error": "unauthorized"})
        path = self.path.split("?")[0].rstrip("/")
        try:
            with lock:
                return self.route(method, path)
        except Exception as err:
            return self.reply(502, {"error": f"liquidsoap: {err}"})

    def route(self, method, path):
        global counter
        if method == "POST" and path == "/skip":
            tel("radio.skip")
            return self.reply(200, {"ok": True})
        if method == "GET" and path == "/queue":
            return self.reply(200, {"items": list_items()})
        if method == "POST" and path == "/queue":
            uri = str(self.body().get("uri", "")).replace("\n", " ").replace("\r", " ").strip()
            if not uri:
                return self.reply(400, {"error": "uri required"})
            counter += 1
            pending.append({"id": counter, "uri": uri})
            save()
            return self.reply(200, {"ok": True, "rid": counter})
        if method == "POST" and path == "/queue/remove":
            rid = int(self.body().get("rid", 0))
            for i, p in enumerate(pending):
                if p["id"] == rid:
                    pending.pop(i)
                    save()
                    return self.reply(200, {"ok": True})
            return self.reply(409, {"error": "Трек уже загружен в эфир, убрать нельзя"})
        if method == "GET" and path == "/upnext":
            up = upcoming_rids()
            if up:
                return self.reply(200, {"uri": metadata_uri(up[0])})
            if pending:
                return self.reply(200, {"uri": pending[0]["uri"]})
            return self.reply(404, {"error": "nothing queued"})
        names = {"/voice-gain": "voice_gain", "/music-volume": "music_under_voice"}
        if path in names:
            if method == "GET":
                return self.reply(200, {"value": get_float(names[path])})
            if method == "POST":
                set_float(names[path], self.body().get("value"))
                return self.reply(200, {"ok": True})
        return self.reply(404, {"error": "not found"})

    def do_GET(self):
        self.handle_any("GET")

    def do_POST(self):
        self.handle_any("POST")


if __name__ == "__main__":
    load()
    threading.Thread(target=feeder, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", 8001), Handler).serve_forever()
