package com.alty.music;

import android.Manifest;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.webkit.ConsoleMessage;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST = 7001;
    private static final int NOTIFICATION_PERMISSION_REQUEST = 7002;
    private static final String ACTION_STATE = "com.alty.music.PLAYBACK_STATE";

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private final ExecutorService ioExecutor = Executors.newSingleThreadExecutor();
    private BroadcastReceiver stateReceiver;
    private boolean receiverRegistered = false;
    private boolean currentChooserIsAudio = false;
    private boolean activityResumed = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        webView = findViewById(R.id.webview);

        configureWebView();
        registerPlaybackReceiver();

        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
        }

        webView.loadUrl("file:///android_asset/index.html");
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(false);

        webView.setBackgroundColor(0xFF000000);
        webView.setOverScrollMode(WebView.OVER_SCROLL_NEVER);
        webView.addJavascriptInterface(new AndroidBridge(this), "AndroidBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
                android.util.Log.d("ALTYWeb", consoleMessage.message() + " @" + consoleMessage.lineNumber());
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view,
                                             ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (MainActivity.this.filePathCallback != null) {
                    MainActivity.this.filePathCallback.onReceiveValue(null);
                }
                MainActivity.this.filePathCallback = callback;

                String accept = "";
                String[] types = params.getAcceptTypes();
                if (types != null) {
                    for (String type : types) {
                        if (type != null) accept += type.toLowerCase(Locale.US) + " ";
                    }
                }

                boolean audioChooser = accept.contains("audio") || accept.trim().isEmpty();
                currentChooserIsAudio = audioChooser;

                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                intent.setType(audioChooser ? "audio/*" : "image/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,
                        params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE || audioChooser);

                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                } catch (Exception e) {
                    MainActivity.this.filePathCallback = null;
                    currentChooserIsAudio = false;
                    Toast.makeText(MainActivity.this,
                            "Не удалось открыть выбор файлов", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST) return;

        final ValueCallback<Uri[]> callback = filePathCallback;
        filePathCallback = null;
        final boolean audioChooser = currentChooserIsAudio;
        currentChooserIsAudio = false;

        if (callback == null) return;
        if (resultCode != RESULT_OK || data == null) {
            callback.onReceiveValue(null);
            return;
        }

        Uri[] uris = extractUris(data);
        if (uris.length == 0) {
            callback.onReceiveValue(null);
            return;
        }

        if (!audioChooser) {
            callback.onReceiveValue(uris);
            return;
        }

        prepareNativeAudioFilesAsync(uris, callback);
    }

    private Uri[] extractUris(Intent data) {
        List<Uri> list = new ArrayList<>();
        ClipData clipData = data.getClipData();
        if (clipData != null) {
            for (int i = 0; i < clipData.getItemCount(); i++) {
                Uri uri = clipData.getItemAt(i).getUri();
                if (uri != null) list.add(uri);
            }
        } else if (data.getData() != null) {
            list.add(data.getData());
        }
        return list.toArray(new Uri[0]);
    }

    private void prepareNativeAudioFilesAsync(final Uri[] uris, final ValueCallback<Uri[]> callback) {
        ioExecutor.execute(() -> {
            JSONArray pending = new JSONArray();
            List<File> copiedFiles = new ArrayList<>();
            Exception failure = null;

            try {
                File musicDir = new File(getFilesDir(), "music");
                if (!musicDir.exists() && !musicDir.mkdirs()) {
                    throw new IllegalStateException("Cannot create music directory");
                }

                for (Uri uri : uris) {
                    String name = queryDisplayName(uri);
                    String lower = name == null ? "" : name.toLowerCase(Locale.US);
                    String mime = getContentResolver().getType(uri);
                    boolean audio = (mime != null && mime.toLowerCase(Locale.US).startsWith("audio/"))
                            || lower.endsWith(".mp3")
                            || lower.endsWith(".wav")
                            || lower.endsWith(".flac")
                            || lower.endsWith(".m4a")
                            || lower.endsWith(".aac")
                            || lower.endsWith(".ogg")
                            || lower.endsWith(".opus")
                            || lower.endsWith(".mp4")
                            || lower.endsWith(".3gp")
                            || lower.endsWith(".m4b");
                    if (!audio) {
                        throw new IllegalArgumentException("Выбран не аудиофайл: " + name);
                    }

                    String extension = getExtension(name);
                    File target = new File(musicDir,
                            UUID.randomUUID().toString().replace("-", "") + extension);
                    copyUriToFile(uri, target);
                    copiedFiles.add(target);

                    JSONObject item = new JSONObject();
                    item.put("originalName", name == null ? target.getName() : name);
                    item.put("nativePath", target.getAbsolutePath());
                    pending.put(item);
                }
            } catch (Exception e) {
                failure = e;
                android.util.Log.e("ALTY", "Audio import failed", e);
            }

            final JSONArray finalPending = pending;
            final Exception finalFailure = failure;
            runOnUiThread(() -> {
                if (finalFailure != null || finalPending.length() != uris.length) {
                    for (File f : copiedFiles) {
                        try { f.delete(); } catch (Exception ignored) {}
                    }
                    AndroidBridge.setPendingImports(new JSONArray());
                    Toast.makeText(MainActivity.this,
                            "Не удалось сохранить один или несколько аудиофайлов",
                            Toast.LENGTH_LONG).show();
                    callback.onReceiveValue(null);
                    return;
                }

                AndroidBridge.setPendingImports(finalPending);
                callback.onReceiveValue(uris);
            });
        });
    }

    private void copyUriToFile(Uri uri, File target) throws Exception {
        try (InputStream input = getContentResolver().openInputStream(uri);
             FileOutputStream output = new FileOutputStream(target)) {
            if (input == null) throw new IllegalStateException("Cannot open input stream");
            byte[] buffer = new byte[1024 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
            output.flush();
        }
    }

    private String queryDisplayName(Uri uri) {
        android.database.Cursor cursor = null;
        try {
            cursor = getContentResolver().query(uri,
                    new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                return cursor.getString(0);
            }
        } catch (Exception ignored) {
        } finally {
            if (cursor != null) cursor.close();
        }
        String s = uri.getLastPathSegment();
        return s == null ? "track" : s;
    }

    private String getExtension(String name) {
        if (name == null) return ".audio";
        int dot = name.lastIndexOf('.');
        if (dot >= 0 && dot < name.length() - 1) {
            String ext = name.substring(dot).toLowerCase(Locale.US);
            if (ext.length() <= 8) return ext;
        }
        return ".audio";
    }

    private void registerPlaybackReceiver() {
        stateReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (!ACTION_STATE.equals(intent.getAction())) return;
                String state = intent.getStringExtra("state");
                if (state != null) sendStateToWebView(state);
            }
        };

        IntentFilter filter = new IntentFilter(ACTION_STATE);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(stateReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(stateReceiver, filter);
        }
        receiverRegistered = true;
    }

    public void sendStateToWebView(final String stateJson) {
        if (webView == null || !activityResumed) return;
        final String quoted;
        try {
            quoted = JSONObject.quote(stateJson);
        } catch (Exception e) {
            return;
        }
        runOnUiThread(() -> {
            if (webView != null) {
                webView.evaluateJavascript("window.altyNativeState(" + quoted + ");", null);
            }
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        activityResumed = true;
        if (webView != null) {
            webView.onResume();
            webView.resumeTimers();
            String state = PlaybackService.getStateJson(this);
            if (state != null) sendStateToWebView(state);
        }
    }

    @Override
    protected void onPause() {
        activityResumed = false;
        if (webView != null) {
            webView.onPause();
            webView.pauseTimers();
        }
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (receiverRegistered && stateReceiver != null) {
            try { unregisterReceiver(stateReceiver); } catch (Exception ignored) {}
        }
        receiverRegistered = false;
        ioExecutor.shutdownNow();
        if (filePathCallback != null) {
            try { filePathCallback.onReceiveValue(null); } catch (Exception ignored) {}
            filePathCallback = null;
        }
        if (webView != null) {
            webView.onPause();
            webView.pauseTimers();
            webView.removeJavascriptInterface("AndroidBridge");
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    static final class PendingImportHolder {
        static JSONArray pending = new JSONArray();
    }

    public static void setPendingImportsInternal(JSONArray array) {
        synchronized (PendingImportHolder.class) {
            PendingImportHolder.pending = array == null ? new JSONArray() : array;
        }
    }

    public static String consumePendingImportsInternal() {
        synchronized (PendingImportHolder.class) {
            JSONArray result = PendingImportHolder.pending;
            PendingImportHolder.pending = new JSONArray();
            return result.toString();
        }
    }
}
