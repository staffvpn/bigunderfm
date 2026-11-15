package fm.bigunder.radio;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

/**
 * The phone's own media player for the radio: a MediaSession (notification
 * shade, lock screen, Bluetooth and car head units show the track and drive
 * play/pause) on a foreground service that keeps the music going with the
 * screen off. The sound itself plays in the WebView; this mirrors it.
 * Audio focus is left to the WebView: a second focus request from here
 * would make the WebView lose focus and stop the music.
 */
public class AirService extends Service {
    static final String ACTION_PLAY = "fm.bigunder.radio.PLAY";
    static final String ACTION_PAUSE = "fm.bigunder.radio.PAUSE";
    private static final String CHANNEL = "air";
    private static AirService instance;
    private static String artist = "";
    private static String title = "BIGUNDER FM";
    private static boolean playing = false;

    private MediaSession session;
    private Bitmap artwork;
    private PowerManager.WakeLock wake;
    private WifiManager.WifiLock wifi;
    private final Handler main = new Handler(Looper.getMainLooper());

    /** From the web app (any thread). */
    static void update(String a, String t, boolean p) {
        artist = a == null ? "" : a;
        title = t == null || t.isEmpty() ? "BIGUNDER FM" : t;
        playing = p;
        AirService s = instance;
        if (s != null) s.main.post(s::refresh);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Плеер", NotificationManager.IMPORTANCE_LOW);
            channel.setShowBadge(false);
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
        artwork = BitmapFactory.decodeResource(getResources(), R.mipmap.artwork);
        session = new MediaSession(this, "BIGUNDER FM");
        session.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() {
                MainActivity.remote("play");
            }

            @Override
            public void onPause() {
                MainActivity.remote("pause");
            }

            @Override
            public void onStop() {
                MainActivity.remote("pause");
            }
        });
        session.setSessionActivity(PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE));
        session.setActive(true);

        wake = ((PowerManager) getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "bigunderfm:air");
        wifi = ((WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE)).createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "bigunderfm:air");

        Notification note = buildNotification();
        if (Build.VERSION.SDK_INT >= 29) startForeground(1, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(1, note);
        refresh();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_PLAY.equals(action)) MainActivity.remote("play");
        else if (ACTION_PAUSE.equals(action)) MainActivity.remote("pause");
        return START_NOT_STICKY;
    }

    private void refresh() {
        if (session == null) return;
        session.setMetadata(new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist.isEmpty() ? "BIGUNDER FM" : artist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, "BIGUNDER FM")
                .putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, artwork)
                // Live radio: no length, so no seek bar.
                .putLong(MediaMetadata.METADATA_KEY_DURATION, -1)
                .build());
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_STOP)
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, PlaybackState.PLAYBACK_POSITION_UNKNOWN, playing ? 1f : 0f)
                .build());
        if (playing) {
            if (!wake.isHeld()) wake.acquire();
            if (!wifi.isHeld()) wifi.acquire();
        } else {
            if (wake.isHeld()) wake.release();
            if (wifi.isHeld()) wifi.release();
        }
        getSystemService(NotificationManager.class).notify(1, buildNotification());
    }

    private Notification buildNotification() {
        Intent toggle = new Intent(this, AirService.class).setAction(playing ? ACTION_PAUSE : ACTION_PLAY);
        PendingIntent toggleIntent = PendingIntent.getService(this, 1, toggle, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Action action = new Notification.Action.Builder(
                playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                playing ? "Пауза" : "Слушать",
                toggleIntent).build();
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        return b.setSmallIcon(R.drawable.ic_stat)
                .setLargeIcon(artwork)
                .setContentTitle(title)
                .setContentText(artist.isEmpty() ? "BIGUNDER FM" : artist)
                .setContentIntent(PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE))
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setCategory(Notification.CATEGORY_TRANSPORT)
                .setOngoing(playing)
                .setShowWhen(false)
                .addAction(action)
                .setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0))
                .build();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopSelf();
    }

    @Override
    public void onDestroy() {
        instance = null;
        if (session != null) session.release();
        if (wake != null && wake.isHeld()) wake.release();
        if (wifi != null && wifi.isHeld()) wifi.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
