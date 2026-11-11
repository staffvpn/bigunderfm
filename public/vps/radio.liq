# BIGUNDER FM broadcast: queue (fed by the Worker) -> playlist safety net,
# live voice over music, MP3 to Icecast. Values come from /etc/radio.env.
settings.log.stdout := true
settings.log.file := false
settings.log.level := 3
settings.server.telnet := true
settings.server.telnet.bind_addr := "127.0.0.1"
settings.server.telnet.port := 1234
settings.harbor.bind_addrs := ["127.0.0.1"]

interactive.persistent("/var/radio/vars.json")
voice_gain = interactive.float("voice_gain", 2.5)
music_under_voice = interactive.float("music_under_voice", 0.2)

live_password = environment.get(default="", "LIVE_PASSWORD")
icecast_password = environment.get(default="", "ICECAST_SOURCE_PASSWORD")

queue = request.queue(id="queue")
safety = playlist(id="safety", mode="randomize", reload_mode="watch", "/var/radio/playlist.m3u")
radio = fallback(id="radio", track_sensitive=true, [queue, safety])
radio = mksafe(radio)

live1 = input.harbor("live1", port=8005, password=live_password, id="live1")
live2 = input.harbor("live2", port=8005, password=live_password, id="live2")
live3 = input.harbor("live3", port=8005, password=live_password, id="live3")
live = fallback(track_sensitive=false, [live1, live2, live3])

music = amplify(fun () -> if source.is_ready(live) then music_under_voice() else 1.0 end, radio)
voice = amplify(voice_gain, live)
final = add(normalize=false, [music, voice])

server.register(namespace="radio", description="Skip the current track", usage="skip", "skip", fun (_) -> begin
  source.skip(radio)
  "Done"
end)

output.icecast(
  %mp3(bitrate=128, samplerate=44100, stereo=true),
  host="127.0.0.1", port=8000, password=icecast_password, mount="/radio",
  name="BIGUNDER FM", genre="Hip-Hop", description="BIGUNDER FM",
  final)

# The same air cut into short files (HLS). Cloudflare hands these out to listeners
# whose network or VPN cannot open this server directly (functions/hls).
output.file.hls(
  playlist="live.m3u8", segment_duration=8., segments=5, segments_overhead=6,
  "/var/radio/hls",
  [("aac", %ffmpeg(format="mpegts", %audio(codec="aac", b="96k", ar=44100, channels=2)))],
  final)
