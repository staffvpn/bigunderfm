package fm.bigunder.radio;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** The radio's own web app in a full-screen WebView; AirService keeps it playing in the background. */
public class MainActivity extends Activity {
    private static final String HOME = "https://bigunderfm.pages.dev/";
    private WebView web;
    private static MainActivity instance;

    /** Player buttons (notification, lock screen, headphones, car) into the web app. */
    static void remote(String action) {
        MainActivity a = instance;
        if (a == null) return;
        a.runOnUiThread(() -> a.web.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('bfm-remote',{detail:'" + action + "'}))", null));
    }

    /** The web app tells the phone's player what is on air. */
    public static class Bridge {
        @JavascriptInterface
        public void update(String artist, String title, boolean playing) {
            AirService.update(artist, title, playing);
        }
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        instance = this;
        web = new WebView(this);
        web.addJavascriptInterface(new Bridge(), "BigunderApp");
        web.setBackgroundColor(0xFF0A0A0A);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " BigunderFMApp");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("bigunderfm.pages.dev".equals(uri.getHost())) return false;
                // Telegram, Instagram and other links open in their own apps.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                }
                return true;
            }
        });
        setContentView(web);
        if (state == null) web.loadUrl(HOME);
        else web.restoreState(state);

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
        Intent air = new Intent(this, AirService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(air);
        else startService(air);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    // No web.onPause() anywhere: the music goes on when the app is in the background.

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true);
    }

    @Override
    protected void onDestroy() {
        stopService(new Intent(this, AirService.class));
        if (instance == this) instance = null;
        web.destroy();
        super.onDestroy();
    }
}
