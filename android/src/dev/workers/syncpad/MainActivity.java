package dev.workers.syncpad;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.VibrationAttributes;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

public class MainActivity extends Activity {
    private static final String APP_URL = "https://syncpad.muamer-arifi.workers.dev/";
    private static final String APP_HOST = "syncpad.muamer-arifi.workers.dev";
    private static final String PREFS_UI = "sp_ui";
    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int MAX_SHARE_FILE_BYTES = 15 * 1024 * 1024;
    private static final int MAX_SHARE_TOTAL_BYTES = 24 * 1024 * 1024;

    private FrameLayout rootContainer;
    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private boolean pageReady = false;
    private boolean showingOfflineScreen = false;
    private String pendingShareJson = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        applySavedThemeImmediately();

        rootContainer = new FrameLayout(this);
        rootContainer.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
        setContentView(rootContainer);

        initWebView(savedInstanceState);

        if (savedInstanceState == null) {
            handleShareIntent(getIntent());
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleShareIntent(intent);
    }

    private void applySavedThemeImmediately() {
        SharedPreferences prefs = getSharedPreferences(PREFS_UI, MODE_PRIVATE);
        int nightMask = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        boolean systemDark = nightMask == Configuration.UI_MODE_NIGHT_YES;
        boolean dark = prefs.contains("dark") ? prefs.getBoolean("dark", systemDark) : systemDark;
        String barHex = prefs.getString("barHex", dark ? "#16181e" : "#ffffff");
        String bgHex = prefs.getString("bgHex", dark ? "#0e1014" : "#fcfcfd");
        applySystemBars(dark, barHex, bgHex);
    }

    private void initWebView(Bundle savedInstanceState) {
        pageReady = false;
        showingOfflineScreen = false;

        webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));
        webView.setHapticFeedbackEnabled(true);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        webView.setScrollbarFadingEnabled(true);
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);

        SharedPreferences prefs = getSharedPreferences(PREFS_UI, MODE_PRIVATE);
        int nightMask = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        boolean dark = prefs.getBoolean("dark", nightMask == Configuration.UI_MODE_NIGHT_YES);
        String bgHex = prefs.getString("bgHex", dark ? "#0e1014" : "#fcfcfd");
        webView.setBackgroundColor(parseColorSafe(bgHex, dark ? 0xFF0E1014 : 0xFFFCFCFD));

        rootContainer.removeAllViews();
        rootContainer.addView(webView);

        configureWebViewSettings(webView);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new SyncPadBridge(), "SyncPadAndroid");
        webView.setWebViewClient(createWebViewClient());
        webView.setWebChromeClient(createWebChromeClient());
        webView.setDownloadListener(createDownloadListener());

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(APP_URL);
        }
    }

    @SuppressWarnings("deprecation")
    private void configureWebViewSettings(WebView wv) {
        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString(s.getUserAgentString() + " SyncPadAndroid/3.0.62");

        if (Build.VERSION.SDK_INT >= 33) {
            s.setAlgorithmicDarkeningAllowed(false);
        } else if (Build.VERSION.SDK_INT >= 29) {
            s.setForceDark(WebSettings.FORCE_DARK_OFF);
        }
    }

    private WebViewClient createWebViewClient() {
        return new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                if (!showingOfflineScreen) {
                    pageReady = false;
                }
                injectVibratePolyfill(view);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String host = uri != null ? uri.getHost() : null;
                if (host != null && host.equalsIgnoreCase(APP_HOST)) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {}
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (showingOfflineScreen || url == null || !url.contains(APP_HOST)) {
                    return;
                }
                pageReady = true;
                injectVibratePolyfill(view);
                syncThemeFromPage(view);
                flushPendingShare();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request != null && request.isForMainFrame()) {
                    showOfflineRetryScreen(view);
                }
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            if (webView != null) {
                                rootContainer.removeView(webView);
                                webView.destroy();
                                webView = null;
                            }
                        } catch (Exception ignored) {}
                        initWebView(null);
                    }
                });
                return true;
            }
        };
    }

    private WebChromeClient createWebChromeClient() {
        return new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                    fileCallback = null;
                }
                fileCallback = callback;
                try {
                    Intent baseIntent = params.createIntent();
                    baseIntent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);

                    if (params.isCaptureEnabled()) {
                        Intent captureIntent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                        if (captureIntent.resolveActivity(getPackageManager()) != null) {
                            Intent chooser = Intent.createChooser(baseIntent, "Select or capture");
                            chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{ captureIntent });
                            startActivityForResult(chooser, REQ_FILE_CHOOSER);
                            return true;
                        }
                    }

                    startActivityForResult(baseIntent, REQ_FILE_CHOOSER);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
            }
        };
    }

    private DownloadListener createDownloadListener() {
        return new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimeType, long contentLength) {
                if (url == null) return;
                String filename = sanitizeFilename(URLUtil.guessFileName(url, contentDisposition, mimeType));
                if (url.startsWith("blob:") || url.startsWith("data:")) {
                    String safeName = filename.replace("\\", "\\\\").replace("'", "\\'");
                    String safeMime = (mimeType != null ? mimeType : "application/octet-stream").replace("'", "");
                    webView.evaluateJavascript(
                            "(async function(){try{" +
                            "const r=await fetch('" + url.replace("'", "\\'") + "');" +
                            "const b=await r.blob();" +
                            "const fr=new FileReader();" +
                            "fr.onloadend=function(){if(window.SyncPadAndroid)window.SyncPadAndroid.saveBase64File(String(fr.result||''),'" + safeName + "','" + safeMime + "');};" +
                            "fr.readAsDataURL(b);" +
                            "}catch(e){}})();",
                            null
                    );
                    return;
                }
                try {
                    DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                    req.setMimeType(mimeType);
                    String cookie = CookieManager.getInstance().getCookie(url);
                    if (cookie != null) req.addRequestHeader("Cookie", cookie);
                    req.addRequestHeader("User-Agent", userAgent);
                    req.setTitle(filename);
                    req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename);
                    DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                    if (dm != null) {
                        dm.enqueue(req);
                        triggerHaptic("success");
                        Toast.makeText(MainActivity.this, "Downloading " + filename, Toast.LENGTH_SHORT).show();
                    }
                } catch (Exception e) {
                    triggerHaptic("error");
                    try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) {}
                }
            }
        };
    }

    private void injectVibratePolyfill(WebView view) {
        if (view == null) return;
        view.evaluateJavascript(
                "(function(){try{" +
                "if(window.__spVibHooked||!window.SyncPadAndroid)return;" +
                "window.__spVibHooked=true;" +
                "navigator.vibrate=function(p){try{" +
                "if(Array.isArray(p)){window.SyncPadAndroid.vibratePattern(p.join(','));}" +
                "else{var n=Number(p);if(n>0)window.SyncPadAndroid.vibrateMs(Math.round(n));}" +
                "return true;}catch(e){return false;}};" +
                "}catch(e){}})();",
                null
        );
    }

    private void syncThemeFromPage(WebView view) {
        if (view == null) return;
        view.evaluateJavascript(
                "(function(){try{" +
                "var d=document.documentElement.dataset.theme==='dark';" +
                "var cs=getComputedStyle(document.documentElement);" +
                "var bar=cs.getPropertyValue('--surface').trim()||(d?'#16181e':'#ffffff');" +
                "var bg=cs.getPropertyValue('--bg').trim()||(d?'#0e1014':'#fcfcfd');" +
                "if(window.SyncPadAndroid)window.SyncPadAndroid.setTheme(d,bar,bg);" +
                "}catch(e){}})();",
                null
        );
    }

    private void showOfflineRetryScreen(WebView view) {
        showingOfflineScreen = true;
        pageReady = false;
        SharedPreferences prefs = getSharedPreferences(PREFS_UI, MODE_PRIVATE);
        int nightMask = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        boolean dark = prefs.getBoolean("dark", nightMask == Configuration.UI_MODE_NIGHT_YES);
        String bg = dark ? "#0e1014" : "#fcfcfd";
        String surface = dark ? "#16181e" : "#ffffff";
        String fg = dark ? "#eceff4" : "#11161f";
        String muted = dark ? "#939cad" : "#5d6875";
        String html = "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'>" +
                "<style>html,body{margin:0;height:100%;font-family:system-ui,-apple-system,sans-serif;background:" + bg + ";color:" + fg + ";display:grid;place-items:center;padding:24px;box-sizing:border-box}" +
                ".card{max-width:340px;width:100%;background:" + surface + ";border-radius:20px;padding:24px;text-align:center;box-shadow:0 12px 32px rgba(0,0,0,.18)}" +
                "h2{margin:0 0 8px;font-size:18px}p{margin:0 0 20px;color:" + muted + ";font-size:14px;line-height:1.45}" +
                "button{border:0;background:#16a34a;color:#fff;font-weight:600;font-size:15px;padding:12px 22px;border-radius:999px;cursor:pointer;width:100%}</style></head>" +
                "<body><div class='card'><h2>Offline</h2><p>Unable to reach SyncPad right now. Check your connection and try again.</p>" +
                "<button onclick=\"if(window.SyncPadAndroid)SyncPadAndroid.retryLoad();else location.replace('" + APP_URL + "');\">Retry</button></div></body></html>";
        view.loadDataWithBaseURL(APP_URL, html, "text/html", "UTF-8", null);
    }

    @SuppressWarnings("deprecation")
    private void handleShareIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;
        if (intent.getBooleanExtra("sp_handled", false)) return;
        intent.putExtra("sp_handled", true);

        CharSequence extraText = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        final String sharedText = extraText != null ? extraText.toString() : null;

        final List<Uri> uris = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri single = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (single != null && seen.add(single.toString())) uris.add(single);
        } else {
            ArrayList<Uri> many = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (many != null) {
                for (Uri u : many) {
                    if (u != null && seen.add(u.toString())) uris.add(u);
                }
            }
        }
        ClipData clip = intent.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri cu = clip.getItemAt(i).getUri();
                if (cu != null && seen.add(cu.toString())) uris.add(cu);
            }
        }

        if ((sharedText == null || sharedText.trim().isEmpty()) && uris.isEmpty()) return;

        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    JSONObject payload = new JSONObject();
                    if (sharedText != null && !sharedText.trim().isEmpty()) {
                        payload.put("text", sharedText.trim());
                    }
                    JSONArray files = new JSONArray();
                    int totalBytes = 0;
                    boolean skippedLarge = false;
                    ContentResolver cr = getContentResolver();

                    for (Uri uri : uris) {
                        String name = queryDisplayName(cr, uri);
                        String mime = cr.getType(uri);
                        if (mime == null || mime.isEmpty()) mime = "application/octet-stream";
                        byte[] data = readUriBytes(cr, uri, MAX_SHARE_FILE_BYTES);
                        if (data == null) {
                            skippedLarge = true;
                            continue;
                        }
                        if (totalBytes + data.length > MAX_SHARE_TOTAL_BYTES) {
                            skippedLarge = true;
                            continue;
                        }
                        totalBytes += data.length;
                        JSONObject fo = new JSONObject();
                        fo.put("name", name);
                        fo.put("type", mime);
                        fo.put("base64", Base64.encodeToString(data, Base64.NO_WRAP));
                        files.put(fo);
                    }
                    payload.put("files", files);

                    final boolean warnLarge = skippedLarge;
                    final String json = payload.toString()
                            .replace("\u2028", "\\u2028")
                            .replace("\u2029", "\\u2029");
                    final boolean hasData = files.length() > 0 || (sharedText != null && !sharedText.trim().isEmpty());

                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (warnLarge) {
                                Toast.makeText(MainActivity.this, "Shared file too large (max 15 MB)", Toast.LENGTH_SHORT).show();
                            }
                            if (!hasData) return;
                            pendingShareJson = json;
                            flushPendingShare();
                        }
                    });
                } catch (Exception ignored) {}
            }
        }).start();
    }

    private void flushPendingShare() {
        if (!pageReady || showingOfflineScreen || pendingShareJson == null || webView == null) return;
        String payload = pendingShareJson;
        pendingShareJson = null;
        String js = "(function(p){try{" +
                "if(typeof window.__spReceiveAndroidShare==='function'){window.__spReceiveAndroidShare(p);}" +
                "else{window.__spAndroidShareQueue=window.__spAndroidShareQueue||[];window.__spAndroidShareQueue.push(p);}" +
                "}catch(e){}})(" + payload + ");";
        webView.evaluateJavascript(js, null);
    }

    private static String queryDisplayName(ContentResolver cr, Uri uri) {
        String name = null;
        try (Cursor c = cr.query(uri, new String[]{ OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) name = c.getString(idx);
            }
        } catch (Exception ignored) {}
        if (name == null || name.trim().isEmpty()) {
            name = uri.getLastPathSegment();
        }
        return sanitizeFilename((name == null || name.trim().isEmpty()) ? "shared-file" : name);
    }

    private static byte[] readUriBytes(ContentResolver cr, Uri uri, int maxBytes) {
        try (InputStream is = cr.openInputStream(uri)) {
            if (is == null) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int total = 0;
            int n;
            while ((n = is.read(buf)) >= 0) {
                total += n;
                if (total > maxBytes) return null;
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        } catch (Exception e) {
            return null;
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE_CHOOSER && fileCallback != null) {
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null && clip.getItemCount() > 0) {
                    List<Uri> list = new ArrayList<>();
                    for (int i = 0; i < clip.getItemCount(); i++) {
                        Uri u = clip.getItemAt(i).getUri();
                        if (u != null) list.add(u);
                    }
                    if (!list.isEmpty()) results = list.toArray(new Uri[0]);
                } else if (data.getData() != null) {
                    results = new Uri[]{ data.getData() };
                }
            }
            fileCallback.onReceiveValue(results);
            fileCallback = null;
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (webView == null || showingOfflineScreen) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript(
                "(function(){try{return !!(window.__spAndroidBack&&window.__spAndroidBack());}catch(e){return false;}})();",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if ("true".equalsIgnoreCase(value)) {
                            triggerHaptic("tick");
                            return;
                        }
                        if (webView != null && webView.canGoBack()) {
                            webView.goBack();
                        } else {
                            fallbackBackPressed();
                        }
                    }
                }
        );
    }

    @SuppressWarnings("deprecation")
    private void fallbackBackPressed() {
        super.onBackPressed();
    }

    private Vibrator getVibrator() {
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                VibratorManager vm = (VibratorManager) getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                return vm != null ? vm.getDefaultVibrator() : null;
            }
            @SuppressWarnings("deprecation")
            Vibrator v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            return v;
        } catch (Exception e) {
            return null;
        }
    }

    @SuppressWarnings("deprecation")
    private void playVibrationEffect(Vibrator v, VibrationEffect effect) {
        if (v == null || effect == null) return;
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                VibrationAttributes attrs = new VibrationAttributes.Builder()
                        .setUsage(VibrationAttributes.USAGE_TOUCH)
                        .build();
                v.vibrate(effect, attrs);
            } else {
                AudioAttributes attrs = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build();
                v.vibrate(effect, attrs);
            }
        } catch (Exception ignored) {}
    }

    private boolean isPredefinedSupported(Vibrator v, int effectId) {
        if (Build.VERSION.SDK_INT < 29 || v == null) return false;
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                return v.areEffectsSupported(effectId)[0] == Vibrator.VIBRATION_EFFECT_SUPPORT_YES;
            } catch (Exception e) {
                return false;
            }
        }
        return true;
    }

    private void triggerHaptic(final String kindRaw) {
        final String kind = kindRaw == null ? "tick" : kindRaw.trim().toLowerCase(Locale.US);
        Vibrator v = getVibrator();
        if (v != null && v.hasVibrator()) {
            boolean amp = v.hasAmplitudeControl();
            if ("error".equals(kind)) {
                long[] t = new long[]{ 0, 22, 38, 22, 38, 34 };
                VibrationEffect ef = amp
                        ? VibrationEffect.createWaveform(t, new int[]{ 0, 210, 0, 210, 0, 245 }, -1)
                        : VibrationEffect.createWaveform(t, -1);
                playVibrationEffect(v, ef);
                return;
            }
            if ("success".equals(kind)) {
                long[] t = new long[]{ 0, 14, 44, 24 };
                VibrationEffect ef = amp
                        ? VibrationEffect.createWaveform(t, new int[]{ 0, 150, 0, 235 }, -1)
                        : VibrationEffect.createWaveform(t, -1);
                playVibrationEffect(v, ef);
                return;
            }
            if ("warning".equals(kind)) {
                long[] t = new long[]{ 0, 18, 50, 22 };
                VibrationEffect ef = amp
                        ? VibrationEffect.createWaveform(t, new int[]{ 0, 175, 0, 195 }, -1)
                        : VibrationEffect.createWaveform(t, -1);
                playVibrationEffect(v, ef);
                return;
            }
            if ("double".equals(kind) || "select".equals(kind)) {
                if (Build.VERSION.SDK_INT >= 29 && isPredefinedSupported(v, VibrationEffect.EFFECT_DOUBLE_CLICK)) {
                    playVibrationEffect(v, VibrationEffect.createPredefined(VibrationEffect.EFFECT_DOUBLE_CLICK));
                    return;
                }
                long[] t = new long[]{ 0, 14, 40, 18 };
                VibrationEffect ef = amp
                        ? VibrationEffect.createWaveform(t, new int[]{ 0, 165, 0, 185 }, -1)
                        : VibrationEffect.createWaveform(t, -1);
                playVibrationEffect(v, ef);
                return;
            }
            if ("heavy".equals(kind)) {
                if (Build.VERSION.SDK_INT >= 29 && isPredefinedSupported(v, VibrationEffect.EFFECT_HEAVY_CLICK)) {
                    playVibrationEffect(v, VibrationEffect.createPredefined(VibrationEffect.EFFECT_HEAVY_CLICK));
                    return;
                }
                playVibrationEffect(v, VibrationEffect.createOneShot(24, amp ? 225 : VibrationEffect.DEFAULT_AMPLITUDE));
                return;
            }
            if ("click".equals(kind)) {
                if (Build.VERSION.SDK_INT >= 29 && isPredefinedSupported(v, VibrationEffect.EFFECT_CLICK)) {
                    playVibrationEffect(v, VibrationEffect.createPredefined(VibrationEffect.EFFECT_CLICK));
                    return;
                }
                playVibrationEffect(v, VibrationEffect.createOneShot(14, amp ? 150 : VibrationEffect.DEFAULT_AMPLITUDE));
                return;
            }
            if (Build.VERSION.SDK_INT >= 29 && isPredefinedSupported(v, VibrationEffect.EFFECT_TICK)) {
                playVibrationEffect(v, VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK));
                return;
            }
            playVibrationEffect(v, VibrationEffect.createOneShot(10, amp ? 95 : VibrationEffect.DEFAULT_AMPLITUDE));
            return;
        }

        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (webView == null) return;
                int flag = HapticFeedbackConstants.CLOCK_TICK;
                if ("heavy".equals(kind) || "error".equals(kind)) flag = HapticFeedbackConstants.LONG_PRESS;
                else if ("click".equals(kind) || "success".equals(kind)) flag = HapticFeedbackConstants.KEYBOARD_TAP;
                webView.performHapticFeedback(flag, HapticFeedbackConstants.FLAG_IGNORE_VIEW_SETTING);
            }
        });
    }

    private static int parseColorSafe(String hex, int fallback) {
        if (hex == null) return fallback;
        String s = hex.trim();
        if (!s.startsWith("#")) return fallback;
        try {
            return Color.parseColor(s);
        } catch (Exception e) {
            return fallback;
        }
    }

    private static String sanitizeFilename(String raw) {
        if (raw == null || raw.trim().isEmpty()) return "syncpad-file";
        String s = raw.trim().replaceAll("[\\\\/:*?\"<>|\\x00-\\x1F]", "_");
        return s.isEmpty() ? "syncpad-file" : s;
    }

    private static File makeUniqueFile(File dir, String filename) {
        File candidate = new File(dir, filename);
        if (!candidate.exists()) return candidate;
        int dot = filename.lastIndexOf('.');
        String base = dot > 0 ? filename.substring(0, dot) : filename;
        String ext = dot > 0 ? filename.substring(dot) : "";
        for (int i = 1; i < 1000; i++) {
            File next = new File(dir, base + " (" + i + ")" + ext);
            if (!next.exists()) return next;
        }
        return new File(dir, base + "-" + System.currentTimeMillis() + ext);
    }

    @SuppressWarnings("deprecation")
    private void applySystemBars(final boolean dark, final String barHex, final String bodyHex) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Window w = getWindow();
                if (w == null) return;
                int barColor = parseColorSafe(barHex, dark ? 0xFF16181E : 0xFFFFFFFF);
                int bgColor = parseColorSafe(bodyHex, dark ? 0xFF0E1014 : 0xFFFCFCFD);

                w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
                w.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS | WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION);
                w.setStatusBarColor(barColor);
                w.setNavigationBarColor(barColor);
                w.setBackgroundDrawable(new ColorDrawable(bgColor));
                if (webView != null) webView.setBackgroundColor(bgColor);

                if (Build.VERSION.SDK_INT >= 29) {
                    w.setNavigationBarContrastEnforced(false);
                }

                if (Build.VERSION.SDK_INT >= 30) {
                    WindowInsetsController ic = w.getInsetsController();
                    if (ic != null) {
                        int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                        ic.setSystemBarsAppearance(dark ? 0 : mask, mask);
                    }
                } else {
                    View decor = w.getDecorView();
                    int flags = decor.getSystemUiVisibility();
                    int lightFlags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                    if (dark) flags &= ~lightFlags;
                    else flags |= lightFlags;
                    decor.setSystemUiVisibility(flags);
                }
            }
        });
    }

    public class SyncPadBridge {
        @JavascriptInterface
        public void setTheme(boolean dark, String barHex, String bodyHex) {
            try {
                getSharedPreferences(PREFS_UI, MODE_PRIVATE).edit()
                        .putBoolean("dark", dark)
                        .putString("barHex", barHex != null ? barHex : (dark ? "#16181e" : "#ffffff"))
                        .putString("bgHex", bodyHex != null ? bodyHex : (dark ? "#0e1014" : "#fcfcfd"))
                        .apply();
            } catch (Exception ignored) {}
            applySystemBars(dark, barHex, bodyHex);
        }

        @JavascriptInterface
        public void haptic(String kind) {
            triggerHaptic(kind);
        }

        @JavascriptInterface
        public void vibrateMs(int ms) {
            if (ms <= 0) return;
            int clamped = Math.min(Math.max(ms, 8), 500);
            Vibrator v = getVibrator();
            if (v != null && v.hasVibrator()) {
                int amp = v.hasAmplitudeControl() ? Math.min(255, 80 + clamped * 3) : VibrationEffect.DEFAULT_AMPLITUDE;
                playVibrationEffect(v, VibrationEffect.createOneShot(clamped, amp));
            }
        }

        @JavascriptInterface
        public void vibratePattern(String csv) {
            if (csv == null || csv.trim().isEmpty()) return;
            Vibrator v = getVibrator();
            if (v == null || !v.hasVibrator()) return;
            String[] parts = csv.split(",");
            long[] timings = new long[parts.length];
            for (int i = 0; i < parts.length; i++) {
                try {
                    timings[i] = Math.max(0L, Math.min(500L, Long.parseLong(parts[i].trim())));
                } catch (Exception e) {
                    timings[i] = 0L;
                }
            }
            if (timings.length == 1 && timings[0] > 0) {
                vibrateMs((int) timings[0]);
                return;
            }
            if (timings.length > 0) {
                playVibrationEffect(v, VibrationEffect.createWaveform(timings, -1));
            }
        }

        @JavascriptInterface
        public void retryLoad() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (webView != null) {
                        showingOfflineScreen = false;
                        webView.loadUrl(APP_URL);
                    }
                }
            });
        }

        @JavascriptInterface
        public void saveBase64File(String dataUrl, String filename, String mimeType) {
            try {
                String payload = dataUrl;
                int comma = dataUrl.indexOf(',');
                if (comma >= 0) payload = dataUrl.substring(comma + 1);
                byte[] bytes = Base64.decode(payload, Base64.DEFAULT);
                final String safeName = sanitizeFilename(filename);
                String safeMime = (mimeType == null || mimeType.isEmpty()) ? "application/octet-stream" : mimeType;

                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
                    cv.put(MediaStore.Downloads.MIME_TYPE, safeMime);
                    cv.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    ContentResolver cr = getContentResolver();
                    Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (uri != null) {
                        try (OutputStream os = cr.openOutputStream(uri)) {
                            if (os != null) os.write(bytes);
                        }
                    }
                } else {
                    File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                    if (!dir.exists()) dir.mkdirs();
                    File out = makeUniqueFile(dir, safeName);
                    try (FileOutputStream fos = new FileOutputStream(out)) {
                        fos.write(bytes);
                    }
                }
                triggerHaptic("success");
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(MainActivity.this, "Saved " + safeName, Toast.LENGTH_SHORT).show();
                    }
                });
            } catch (Exception e) {
                triggerHaptic("error");
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(MainActivity.this, "Download failed", Toast.LENGTH_SHORT).show();
                    }
                });
            }
        }
    }
}
