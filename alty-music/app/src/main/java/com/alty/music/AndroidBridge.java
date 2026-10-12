package com.alty.music;

import android.app.Activity;
import android.content.Intent;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;

public class AndroidBridge {
    private final Activity activity;

    public AndroidBridge(Activity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public boolean isAvailable() {
        return true;
    }

    @JavascriptInterface
    public String consumePendingAudioImports() {
        return MainActivity.consumePendingImportsInternal();
    }

    public static void setPendingImports(JSONArray pending) {
        MainActivity.setPendingImportsInternal(pending);
    }

    @JavascriptInterface
    public boolean registerTrack(String id, String name, String nativePath, String coverDataUrl) {
        Intent intent = new Intent(activity, PlaybackService.class)
                .setAction(PlaybackService.ACTION_REGISTER_TRACK)
                .putExtra("id", id)
                .putExtra("name", name)
                .putExtra("nativePath", nativePath)
                .putExtra("coverDataUrl", coverDataUrl);
        return start(intent);
    }

    @JavascriptInterface
    public boolean updateTrack(String id, String name, String coverDataUrl) {
        Intent intent = new Intent(activity, PlaybackService.class)
                .setAction(PlaybackService.ACTION_UPDATE_TRACK)
                .putExtra("id", id)
                .putExtra("name", name)
                .putExtra("coverDataUrl", coverDataUrl);
        return start(intent);
    }

    @JavascriptInterface
    public boolean deleteTrack(String id) {
        Intent intent = new Intent(activity, PlaybackService.class)
                .setAction(PlaybackService.ACTION_DELETE_TRACK)
                .putExtra("id", id);
        return start(intent);
    }

    @JavascriptInterface
    public boolean setQueue(String queueJson, int index, boolean shuffle, int repeatMode) {
        Intent intent = new Intent(activity, PlaybackService.class)
                .setAction(PlaybackService.ACTION_SET_QUEUE)
                .putExtra("queue", queueJson)
                .putExtra("index", index)
                .putExtra("shuffle", shuffle)
                .putExtra("repeat", repeatMode);
        return start(intent);
    }

    @JavascriptInterface
    public boolean playQueue(String queueJson, int index, boolean shuffle, int repeatMode) {
        Intent intent = new Intent(activity, PlaybackService.class)
                .setAction(PlaybackService.ACTION_PLAY_QUEUE)
                .putExtra("queue", queueJson)
                .putExtra("index", index)
                .putExtra("shuffle", shuffle)
                .putExtra("repeat", repeatMode);
        return startPlaybackService(intent);
    }

    @JavascriptInterface
    public boolean play() { return startPlaybackAction(PlaybackService.ACTION_PLAY); }
    @JavascriptInterface
    public boolean pause() { return startPlaybackAction(PlaybackService.ACTION_PAUSE); }
    @JavascriptInterface
    public boolean next() { return startPlaybackAction(PlaybackService.ACTION_NEXT); }
    @JavascriptInterface
    public boolean previous() { return startPlaybackAction(PlaybackService.ACTION_PREVIOUS); }
    @JavascriptInterface
    public boolean stop() { return startPlaybackAction(PlaybackService.ACTION_STOP); }

    @JavascriptInterface
    public boolean seekTo(long positionMs) {
        Intent intent = new Intent(activity, PlaybackService.class)
                .setAction(PlaybackService.ACTION_SEEK)
                .putExtra("positionMs", Math.max(0L, positionMs));
        return start(intent);
    }

    @JavascriptInterface
    public boolean setVolume(float volume) {
        Intent intent = new Intent(activity, PlaybackService.class)
                .setAction(PlaybackService.ACTION_VOLUME)
                .putExtra("volume", volume);
        return start(intent);
    }

    @JavascriptInterface
    public boolean setRepeat(int repeatMode) {
        Intent intent = new Intent(activity, PlaybackService.class)
                .setAction(PlaybackService.ACTION_REPEAT)
                .putExtra("repeat", repeatMode);
        return start(intent);
    }

    @JavascriptInterface
    public String getState() {
        return PlaybackService.getStateJson(activity);
    }

    private boolean startPlaybackAction(String action) {
        return startPlaybackService(new Intent(activity, PlaybackService.class).setAction(action));
    }

    private boolean startPlaybackService(Intent intent) {
        try {
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                activity.startForegroundService(intent);
            } else {
                activity.startService(intent);
            }
            return true;
        } catch (Exception e) {
            android.util.Log.e("ALTY", "Unable to start playback service", e);
            return false;
        }
    }

    private boolean start(Intent intent) {
        try {
            activity.startService(intent);
            return true;
        } catch (Exception e) {
            android.util.Log.e("ALTY", "Unable to start playback service", e);
            return false;
        }
    }
}
