package com.alty.music;

import android.app.*;
import android.content.*;
import android.graphics.*;
import android.media.*;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.*;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class PlaybackService extends Service {
    // ---- Публичный API сервиса (не менять — на него завязан плагин/интерфейс) ----
    public static final String ACTION_REGISTER_TRACK = "com.alty.music.REGISTER_TRACK";
    public static final String ACTION_UPDATE_TRACK = "com.alty.music.UPDATE_TRACK";
    public static final String ACTION_DELETE_TRACK = "com.alty.music.DELETE_TRACK";
    public static final String ACTION_SET_QUEUE = "com.alty.music.SET_QUEUE";
    public static final String ACTION_PLAY_QUEUE = "com.alty.music.PLAY_QUEUE";
    public static final String ACTION_PLAY = "com.alty.music.PLAY";
    public static final String ACTION_PAUSE = "com.alty.music.PAUSE";
    public static final String ACTION_NEXT = "com.alty.music.NEXT";
    public static final String ACTION_PREVIOUS = "com.alty.music.PREVIOUS";
    public static final String ACTION_STOP = "com.alty.music.STOP";
    public static final String ACTION_SEEK = "com.alty.music.SEEK";
    public static final String ACTION_VOLUME = "com.alty.music.VOLUME";
    public static final String ACTION_REPEAT = "com.alty.music.REPEAT";

    private static final String TAG = "ALTYPlayback";
    private static final String PREFS = "alty_playback_state";
    private static final String META_PREFIX = "track_meta_";
    private static final String CHANNEL_ID = "alty_music";
    private static final int NOTIFICATION_ID = 1907;
    private static final String ACTION_STATE = "com.alty.music.PLAYBACK_STATE";
    private static final String ACTION_NOISY = "android.media.AUDIO_BECOMING_NOISY";

    private static final int REPEAT_OFF = 0;   // без повтора
    private static final int REPEAT_ALL = 1;   // повтор очереди (плейлист / альбом) по кругу
    private static final int REPEAT_ONE = 2;   // повтор одного трека
    private static final float DUCK_VOLUME = 0.2f;
    private static final long PERSIST_INTERVAL_MS = 2000L;

    private static volatile PlaybackService instance;

    // ---- Системные объекты ----
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService backgroundExecutor = Executors.newSingleThreadExecutor();
    private final AudioAttributes audioAttributes = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
            .build();
    // ВАЖНО: один и тот же listener на всё время жизни сервиса (см. requestAudioFocus)
    private final AudioManager.OnAudioFocusChangeListener focusListener = this::onAudioFocusChange;

    private MediaPlayer player;
    private MediaSession mediaSession;
    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;
    private BroadcastReceiver noisyReceiver;

    // ---- Состояние воспроизведения ----
    private boolean preparing;                // плеер готовит трек
    private boolean shouldResume;             // "хотим играть" (нажали play / выбрали трек)
    private boolean hasAudioFocus;
    private boolean ducked;                   // нас временно приглушили (уведомление и т.п.)
    private boolean resumeAfterTransientLoss; // пауза из-за звонка/другого приложения
    private boolean inForeground;
    private int failedInRow;                  // сколько треков подряд не открылось (защита от цикла)

    // ---- Очередь и настройки ----
    // Порядок в queue = порядок воспроизведения. Перемешивание делает интерфейс:
    // он присылает уже перемешанную очередь вместе с флагом shuffle.
    private List<Integer> queue = new ArrayList<>();
    private int currentIndex = -1;
    private int repeatMode = REPEAT_OFF;
    private boolean shuffle;
    private long savedPositionMs;
    private float masterVolume = 1f;

    // ---- Обложка ----
    private Bitmap cachedArtwork;
    private int cachedArtworkTrackId = -1;
    private String cachedArtworkPath;

    // =====================================================================
    //  Жизненный цикл
    // =====================================================================

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        audioManager = (AudioManager) getSystemService(AUDIO_SERVICE);

        createNotificationChannel();
        createMediaSession();
        registerNoisyReceiver();
        restorePersistedState(); // только восстанавливаем очередь; музыка сама НЕ стартует
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && intent.getAction() != null) handleIntent(intent);
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        if (!isPlaying() && !preparing) stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        if (player != null) savedPositionMs = safePosition();
        persistState();
        handler.removeCallbacksAndMessages(null);
        backgroundExecutor.shutdownNow();
        if (noisyReceiver != null) {
            try { unregisterReceiver(noisyReceiver); } catch (Exception ignored) {}
        }
        abandonAudioFocus();
        releasePlayer();
        if (mediaSession != null) {
            try { mediaSession.setActive(false); mediaSession.release(); } catch (Exception ignored) {}
        }
        if (inForeground) {
            try { stopForeground(true); } catch (Exception ignored) {}
        }
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private void handleIntent(Intent intent) {
        String action = intent.getAction();
        Log.d(TAG, "action=" + action);
        try {
            switch (action) {
                case ACTION_REGISTER_TRACK:
                    registerTrack(intent.getStringExtra("id"), intent.getStringExtra("name"),
                            intent.getStringExtra("nativePath"), intent.getStringExtra("coverDataUrl"));
                    break;
                case ACTION_UPDATE_TRACK:
                    updateTrackMetadata(intent.getStringExtra("id"), intent.getStringExtra("name"),
                            intent.getStringExtra("coverDataUrl"));
                    break;
                case ACTION_DELETE_TRACK:
                    deleteTrack(intent.getStringExtra("id"));
                    break;
                case ACTION_SET_QUEUE:
                    applyQueue(intent.getStringExtra("queue"), intent.getIntExtra("index", 0),
                            intent.getBooleanExtra("shuffle", false), intent.getIntExtra("repeat", 0), false);
                    break;
                case ACTION_PLAY_QUEUE:
                    applyQueue(intent.getStringExtra("queue"), intent.getIntExtra("index", 0),
                            intent.getBooleanExtra("shuffle", false), intent.getIntExtra("repeat", 0), true);
                    break;
                case ACTION_PLAY: play(); break;
                case ACTION_PAUSE: pause(); break;
                case ACTION_NEXT: nextTrack(false); break;
                case ACTION_PREVIOUS: previousTrack(); break;
                case ACTION_STOP: stopPlayback(); break;
                case ACTION_SEEK: seekTo(intent.getLongExtra("positionMs", 0L)); break;
                case ACTION_VOLUME: setMasterVolume(intent.getFloatExtra("volume", masterVolume)); break;
                case ACTION_REPEAT:
                    repeatMode = clampRepeat(intent.getIntExtra("repeat", 0));
                    syncState();
                    break;
            }
        } catch (Exception e) {
            Log.e(TAG, "handleIntent error", e);
            broadcastState();
        }
    }

    // Единая точка обновления: сохранить, обновить сессию, интерфейс и уведомление
    private void syncState() {
        persistState();
        updateMediaSessionPlaybackState();
        broadcastState();
        updateNotification();
    }

    // =====================================================================
    //  Управление воспроизведением: play / pause / stop / seek / next / prev
    // =====================================================================

    private void play() {
        if (currentTrackId() < 0) return;
        ensureForeground();
        shouldResume = true;

        if (preparing) { syncState(); return; }                 // стартует сам, когда подготовится
        if (player == null) { playCurrent(savedPositionMs); return; }
        if (isPlaying()) { syncState(); return; }

        if (!requestAudioFocus()) { shouldResume = false; syncState(); return; }
        if (!startPlayer()) { playCurrent(safePosition()); return; } // плеер "сломался" — пересоздаём
        syncState();
    }

    private void pause() {
        if (player != null && !preparing) {
            try { if (player.isPlaying()) player.pause(); } catch (Exception ignored) {}
            savedPositionMs = safePosition();
        }
        shouldResume = false;
        resumeAfterTransientLoss = false;
        stopProgressUpdates();
        abandonAudioFocus();
        syncState();
    }

    private void stopPlayback() {
        shouldResume = false;
        resumeAfterTransientLoss = false;
        stopProgressUpdates();
        releasePlayer();
        savedPositionMs = 0L;
        abandonAudioFocus();
        syncState();

        if (inForeground) {
            stopForeground(true);
            inForeground = false;
        }
        stopSelf();
    }

    private void seekTo(long positionMs) {
        long position = Math.max(0L, positionMs);
        if (player != null && !preparing) {
            long duration = getDuration();
            if (duration > 0) position = Math.min(position, duration);
            try { player.seekTo((int) position); } catch (Exception e) { Log.w(TAG, "seek failed", e); }
        }
        savedPositionMs = position;
        syncState();
    }

    // Следующий трек. fromCompletion = true, когда трек доиграл сам.
    private void nextTrack(boolean fromCompletion) {
        if (queue.isEmpty()) return;
        int next = nextIndex(!fromCompletion);
        if (next < 0) { stopPlayback(); return; } // дошли до конца очереди без повтора
        currentIndex = next;
        startNewTrack();
    }

    // Предыдущий трек — один тап = один предыдущий трек.
    private void previousTrack() {
        if (queue.isEmpty()) return;
        if (currentIndex > 0) currentIndex--;
        else if (repeatMode == REPEAT_ALL) currentIndex = queue.size() - 1;
        // иначе мы на первом треке без повтора — просто запускаем его заново
        startNewTrack();
    }

    // Индекс следующего трека; -1 = очередь закончилась.
    // manual = нажатие кнопки "следующий" (по кругу даже без повтора).
    private int nextIndex(boolean manual) {
        if (currentIndex + 1 < queue.size()) return currentIndex + 1;
        return (manual || repeatMode == REPEAT_ALL) ? 0 : -1;
    }

    private void startNewTrack() {
        shouldResume = true;
        ensureForeground();
        playCurrent(0L);
    }

    // =====================================================================
    //  Работа с MediaPlayer
    // =====================================================================

    private void playCurrent(long positionMs) {
        TrackInfo info = getCurrentTrackInfo();
        if (info == null || info.nativePath.isEmpty() || !new File(info.nativePath).canRead()) {
            onTrackFailed();
            return;
        }

        releasePlayer();
        savedPositionMs = Math.max(0L, positionMs);
        preparing = true;
        loadArtworkIfNeeded(info);

        try {
            final MediaPlayer mp = new MediaPlayer();
            player = mp;
            mp.setAudioAttributes(audioAttributes);
            mp.setWakeMode(getApplicationContext(), PowerManager.PARTIAL_WAKE_LOCK);
            mp.setOnPreparedListener(p -> onPlayerPrepared(p, info));
            mp.setOnCompletionListener(this::onPlayerCompleted);
            mp.setOnErrorListener((p, what, extra) -> { onPlayerError(p); return true; });
            mp.setDataSource(info.nativePath);
            mp.prepareAsync();
            updateMediaSessionMetadata(info, 0L);
            syncState();
        } catch (Exception e) {
            Log.e(TAG, "playCurrent failed", e);
            onTrackFailed();
        }
    }

    private void onPlayerPrepared(MediaPlayer mp, TrackInfo info) {
        if (mp != player) return;
        preparing = false;
        failedInRow = 0;

        long duration = getDuration();
        if (savedPositionMs > 0L && duration > 0L) {
            try { mp.seekTo((int) Math.min(savedPositionMs, duration)); } catch (Exception ignored) {}
        }
        updateMediaSessionMetadata(info, duration);
        applyVolume();

        if (shouldResume && !(requestAudioFocus() && startPlayer())) {
            shouldResume = false; // фокус не дали (звонок и т.п.) — остаёмся на паузе
        }
        syncState();
    }

    private void onPlayerCompleted(MediaPlayer mp) {
    if (mp != player) return;

    savedPositionMs = 0L;

    if (repeatMode == REPEAT_ONE) {
        // Повторяем ТОЛЬКО текущий трек.
        // Очередь и currentIndex вообще не меняются.
        shouldResume = true;
        playCurrent(0L);
    } else {
        nextTrack(true);
    }
}

    private void onPlayerError(MediaPlayer mp) {
        if (mp != player) return;
        onTrackFailed();
    }

    // Трек не открылся: если играли — пробуем следующий, иначе просто встаём на паузу
    private void onTrackFailed() {
        releasePlayer();
        int next = nextIndex(false);
        if (shouldResume && next >= 0 && ++failedInRow < queue.size()) {
            currentIndex = next;
            playCurrent(0L);
        } else {
            failedInRow = 0;
            shouldResume = false;
            syncState();
        }
    }

    private boolean startPlayer() {
        try {
            applyVolume();
            player.start();
            resumeAfterTransientLoss = false;
            startProgressUpdates();
            return true;
        } catch (Exception e) {
            Log.w(TAG, "player.start failed", e);
            return false;
        }
    }

    private void releasePlayer() {
        preparing = false;
        if (player != null) {
            try { player.reset(); player.release(); } catch (Exception ignored) {}
            player = null;
        }
    }

    private boolean isPlaying() {
        try { return player != null && player.isPlaying(); } catch (Exception e) { return false; }
    }

    // "Играет" с точки зрения интерфейса: включая момент загрузки трека после тапа
    private boolean isActive() { return shouldResume && (isPlaying() || preparing); }

    private long safePosition() {
        if (player == null || preparing) return savedPositionMs;
        try { return Math.max(0L, player.getCurrentPosition()); } catch (Exception e) { return savedPositionMs; }
    }

    private long getDuration() {
        if (player == null || preparing) return 0L;
        try { return Math.max(0L, player.getDuration()); } catch (Exception e) { return 0L; }
    }

    // =====================================================================
    //  Очередь и треки
    // =====================================================================

    private void applyQueue(String queueJson, int index, boolean shuffle, int repeat, boolean startPlaying) throws Exception {
        JSONArray array = new JSONArray(queueJson == null ? "[]" : queueJson);
        List<Integer> newQueue = new ArrayList<>(array.length());
        for (int i = 0; i < array.length(); i++) newQueue.add(array.getInt(i));

        if (newQueue.isEmpty()) {
            queue.clear();
            currentIndex = -1;
            stopPlayback();
            return;
        }

        int oldId = currentTrackId();
        queue = newQueue;
        currentIndex = Math.max(0, Math.min(index, queue.size() - 1));
        this.shuffle = shuffle;
        this.repeatMode = clampRepeat(repeat);

        boolean sameTrack = (oldId == currentTrackId());
        if (!sameTrack) {
            releasePlayer();
            savedPositionMs = 0L;
        }

        if (startPlaying) {
            if (sameTrack && player != null) play();
            else startNewTrack();
        } else if (!sameTrack) {
            pause(); 
        } else {
            syncState();
        }
    }

    private void deleteTrack(String idString) {
        try {
            int id = Integer.parseInt(idString);
            TrackInfo info = getTrackInfo(id);
            if (info != null) {
                deleteFileQuiet(info.nativePath);
                deleteFileQuiet(info.coverPath);
            }
            prefs().edit().remove(metaKey(id)).apply();

            if (queue.isEmpty()) return;

            boolean wasCurrent = (currentTrackId() == id);
            int removedBeforeCurrent = 0;
            for (int i = 0; i < currentIndex; i++) {
                if (queue.get(i) == id) removedBeforeCurrent++;
            }
            queue.removeIf(trackId -> trackId == id);

            if (queue.isEmpty()) {
                currentIndex = -1;
                stopPlayback();
                return;
            }

            currentIndex = Math.max(0, Math.min(currentIndex - removedBeforeCurrent, queue.size() - 1));

            if (wasCurrent) {
                savedPositionMs = 0L;
                if (shouldResume) {
                    startNewTrack();
                } else {
                    releasePlayer();
                    syncState();
                }
            } else {
                syncState();
            }
        } catch (Exception e) {
            Log.e(TAG, "deleteTrack failed", e);
        }
    }

    private int currentTrackId() {
        return (currentIndex >= 0 && currentIndex < queue.size()) ? queue.get(currentIndex) : -1;
    }

    private TrackInfo getCurrentTrackInfo() {
        int id = currentTrackId();
        return id < 0 ? null : getTrackInfo(id);
    }


    private boolean requestAudioFocus() {
        if (hasAudioFocus) return true;
        if (audioManager == null) return false;
        try {
            int result;
            if (Build.VERSION.SDK_INT >= 26) {
                if (audioFocusRequest == null) {
                    audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                            .setAudioAttributes(audioAttributes)
                            .setOnAudioFocusChangeListener(focusListener, handler)
                            .build();
                }
                result = audioManager.requestAudioFocus(audioFocusRequest);
            } else {
                result = audioManager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
            }
            hasAudioFocus = (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED);
        } catch (Exception e) {
            hasAudioFocus = false;
        }
        return hasAudioFocus;
    }

    private void abandonAudioFocus() {
        if (audioManager != null) {
            try {
                if (Build.VERSION.SDK_INT >= 26) {
                    if (audioFocusRequest != null) audioManager.abandonAudioFocusRequest(audioFocusRequest);
                } else {
                    audioManager.abandonAudioFocus(focusListener);
                }
            } catch (Exception ignored) {}
        }
        hasAudioFocus = false;
        ducked = false;
    }

    private void onAudioFocusChange(int change) {
        switch (change) {
            case AudioManager.AUDIOFOCUS_GAIN:
                hasAudioFocus = true;
                ducked = false;
                applyVolume();
                if (resumeAfterTransientLoss && shouldResume && player != null && !preparing && !isPlaying()) {
                    if (startPlayer()) syncState();
                }
                resumeAfterTransientLoss = false;
                break;

            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT: // звонок и т.п. и пауза, потом вернёмся
                hasAudioFocus = false;
                if (isPlaying()) {
                    try { player.pause(); } catch (Exception ignored) {}
                    savedPositionMs = safePosition();
                    resumeAfterTransientLoss = true;
                    stopProgressUpdates();
                    syncState();
                }
                break;

            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK: 
                ducked = true;
                applyVolume();
                break;

            case AudioManager.AUDIOFOCUS_LOSS:
                pause();
                break;
        }
    }


    private void setMasterVolume(float value) {
        masterVolume = Math.max(0f, Math.min(1f, value));
        applyVolume();
        syncState();
    }

    private void applyVolume() {
        if (player == null) return;
        float v = masterVolume * (ducked ? DUCK_VOLUME : 1f);
        try { player.setVolume(v, v); } catch (Exception ignored) {}
    }

    private final Runnable progressRunnable = new Runnable() {
        @Override public void run() {
            if (!isPlaying()) return;
            prefs().edit().putLong("position", safePosition()).apply();
            handler.postDelayed(this, PERSIST_INTERVAL_MS);
        }
    };

    private void startProgressUpdates() {
        handler.removeCallbacks(progressRunnable);
        handler.postDelayed(progressRunnable, PERSIST_INTERVAL_MS);
    }

    private void stopProgressUpdates() { handler.removeCallbacks(progressRunnable); }

    private int clampRepeat(int value) { return Math.max(REPEAT_OFF, Math.min(REPEAT_ONE, value)); }

    
    private void ensureForeground() {
        if (inForeground) return;
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, buildNotification(),
                        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIFICATION_ID, buildNotification());
            }
            inForeground = true;
        } catch (Exception e) {
            Log.w(TAG, "startForeground failed", e);
        }
    }

    private void updateNotification() {
        if (!inForeground) return;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification());
    }

    private Notification buildNotification() {
        TrackInfo current = getCurrentTrackInfo();
        String title = (current == null || current.name.isEmpty()) ? "ALTY" : current.name;
        boolean active = isActive();

        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        builder.setSmallIcon(R.drawable.ic_stat_music)
                .setContentTitle(title)
                .setContentText(splitArtist(title))
                .setContentIntent(mediaSession.getController().getSessionActivity())
                .setOngoing(active)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setStyle(new Notification.MediaStyle()
                        .setMediaSession(mediaSession.getSessionToken())
                        .setShowActionsInCompactView(0, 1, 2))
                .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_previous,
                        "Previous", servicePending(ACTION_PREVIOUS, 201)).build())
                .addAction(new Notification.Action.Builder(
                        active ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                        "Play/Pause", servicePending(active ? ACTION_PAUSE : ACTION_PLAY, 202)).build())
                .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_next,
                        "Next", servicePending(ACTION_NEXT, 203)).build());

        if (current != null && current.id == cachedArtworkTrackId && cachedArtwork != null) {
            builder.setLargeIcon(cachedArtwork);
        }
        return builder.build();
    }

    private PendingIntent servicePending(String action, int requestCode) {
        Intent intent = new Intent(this, PlaybackService.class).setAction(action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return Build.VERSION.SDK_INT >= 26
                ? PendingIntent.getForegroundService(this, requestCode, intent, flags)
                : PendingIntent.getService(this, requestCode, intent, flags);
    }

    private void createMediaSession() {
        mediaSession = new MediaSession(this, "ALTY");
        mediaSession.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { play(); }
            @Override public void onPause() { pause(); }
            @Override public void onSkipToNext() { nextTrack(false); }
            @Override public void onSkipToPrevious() { previousTrack(); }
            @Override public void onStop() { stopPlayback(); }
            @Override public void onSeekTo(long pos) { seekTo(pos); }
        });
        Intent launchIntent = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        mediaSession.setSessionActivity(PendingIntent.getActivity(this, 100, launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        mediaSession.setActive(true);
    }

    private void updateMediaSessionPlaybackState() {
        if (mediaSession == null) return;
        boolean playing = isPlaying();
        int state = playing ? PlaybackState.STATE_PLAYING
                : (preparing && shouldResume ? PlaybackState.STATE_BUFFERING : PlaybackState.STATE_PAUSED);
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
                | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                | PlaybackState.ACTION_STOP | PlaybackState.ACTION_SEEK_TO;
        mediaSession.setPlaybackState(new PlaybackState.Builder()
                .setActions(actions)
                .setState(state, safePosition(), playing ? 1f : 0f)
                .build());
    }

    private void updateMediaSessionMetadata(TrackInfo info, long duration) {
        if (mediaSession == null || info == null) return;
        String title = info.name.isEmpty() ? "ALTY" : info.name;
        MediaMetadata.Builder builder = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, splitArtist(title))
                .putString(MediaMetadata.METADATA_KEY_ALBUM, "ALTY");
        if (duration > 0) builder.putLong(MediaMetadata.METADATA_KEY_DURATION, duration);
        if (info.id == cachedArtworkTrackId && cachedArtwork != null) {
            builder.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, cachedArtwork);
        }
        mediaSession.setMetadata(builder.build());
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID,
                getString(R.string.media_channel_name), NotificationManager.IMPORTANCE_LOW);
        channel.setShowBadge(false);
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private void registerNoisyReceiver() {
        noisyReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                if (ACTION_NOISY.equals(intent.getAction())) pause(); // выдернули наушники
            }
        };
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                registerReceiver(noisyReceiver, new IntentFilter(ACTION_NOISY), Context.RECEIVER_NOT_EXPORTED);
            } else {
                registerReceiver(noisyReceiver, new IntentFilter(ACTION_NOISY));
            }
        } catch (Exception e) {
            noisyReceiver = null;
        }
    }

    
    private SharedPreferences prefs() { return getSharedPreferences(PREFS, MODE_PRIVATE); }

    private void persistState() {
        try {
            prefs().edit()
                    .putString("queue", new JSONArray(queue).toString())
                    .putInt("index", currentIndex)
                    .putInt("repeat", repeatMode)
                    .putBoolean("shuffle", shuffle)
                    .putLong("position", safePosition())
                    .putFloat("volume", masterVolume)
                    .apply();
        } catch (Exception ignored) {}
    }

    private void restorePersistedState() {
        try {
            SharedPreferences p = prefs();
            JSONArray array = new JSONArray(p.getString("queue", "[]"));
            queue.clear();
            for (int i = 0; i < array.length(); i++) queue.add(array.getInt(i));
            currentIndex = queue.isEmpty() ? -1 : Math.max(0, Math.min(p.getInt("index", 0), queue.size() - 1));
            repeatMode = clampRepeat(p.getInt("repeat", 0));
            shuffle = p.getBoolean("shuffle", false);
            savedPositionMs = Math.max(0L, p.getLong("position", 0L));
            masterVolume = Math.max(0f, Math.min(1f, p.getFloat("volume", 1f)));
        } catch (Exception e) {
            queue.clear();
            currentIndex = -1;
        }
    }

    private void broadcastState() {
        sendBroadcast(new Intent(ACTION_STATE).setPackage(getPackageName())
                .putExtra("state", buildStateJson().toString()));
    }

    public static String getStateJson(Context context) {
        PlaybackService service = instance;
        if (service != null) return service.buildStateJson().toString();

        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS, MODE_PRIVATE);
            JSONArray q = new JSONArray(prefs.getString("queue", "[]"));
            int idx = q.length() == 0 ? -1 : Math.max(0, Math.min(prefs.getInt("index", 0), q.length() - 1));
            int id = idx >= 0 ? q.getInt(idx) : -1;
            String meta = id >= 0 ? prefs.getString(META_PREFIX + id, null) : null;

            return new JSONObject()
                    .put("ready", q.length() > 0)
                    .put("id", id)
                    .put("index", idx)
                    .put("name", meta != null ? new JSONObject(meta).optString("name", "") : "")
                    .put("isPlaying", false)
                    .put("preparing", false)
                    .put("positionMs", prefs.getLong("position", 0L))
                    .put("durationMs", 0L)
                    .put("volume", prefs.getFloat("volume", 1f))
                    .put("repeatMode", Math.max(0, Math.min(2, prefs.getInt("repeat", 0))))
                    .put("shuffle", prefs.getBoolean("shuffle", false))
                    .put("queueIds", q)
                    .toString();
        } catch (Exception e) {
            return null;
        }
    }

    private JSONObject buildStateJson() {
        JSONObject state = new JSONObject();
        try {
            TrackInfo current = getCurrentTrackInfo();
            state.put("ready", !queue.isEmpty())
                    .put("id", current == null ? -1 : current.id)
                    .put("index", currentIndex)
                    .put("name", current == null ? "" : current.name)
                    .put("isPlaying", isActive()) // true и пока трек ещё загружается
                    .put("preparing", preparing)
                    .put("positionMs", safePosition())
                    .put("durationMs", getDuration())
                    .put("volume", masterVolume)
                    .put("repeatMode", repeatMode)
                    .put("shuffle", shuffle)
                    .put("queueIds", new JSONArray(queue));
        } catch (Exception ignored) {}
        return state;
    }

    private void registerTrack(String idStr, String name, String path, String coverUrl) {
        try {
            int id = Integer.parseInt(idStr);
            if (path == null || path.isEmpty() || !new File(path).isFile()) return;
            TrackInfo old = getTrackInfo(id);
            String oldCover = old != null ? old.coverPath : null;
            String cover = (coverUrl != null && !coverUrl.isEmpty()) ? saveCoverDataUrl(id, coverUrl, oldCover) : oldCover;
            saveTrackInfo(new TrackInfo(id, name, path, cover));
        } catch (Exception e) {
            Log.w(TAG, "registerTrack failed", e);
        }
    }

    private void updateTrackMetadata(String idStr, String name, String coverUrl) {
        try {
            TrackInfo info = getTrackInfo(Integer.parseInt(idStr));
            if (info == null) return;
            info.name = name == null ? "" : name;
            if (coverUrl != null) {
                if (coverUrl.isEmpty()) {
                    deleteFileQuiet(info.coverPath);
                    info.coverPath = null;
                } else {
                    info.coverPath = saveCoverDataUrl(info.id, coverUrl, info.coverPath);
                }
            }
            saveTrackInfo(info);

            if (info.id == currentTrackId()) {
                cachedArtworkTrackId = -1; // принудительно перечитать обложку
                loadArtworkIfNeeded(info);
                updateMediaSessionMetadata(info, getDuration());
                syncState();
            }
        } catch (Exception e) {
            Log.w(TAG, "updateTrackMetadata failed", e);
        }
    }

    private String saveCoverDataUrl(int id, String url, String oldPath) throws Exception {
        deleteFileQuiet(oldPath);
        int comma = url.indexOf(',');
        if (comma < 0) return null;
        String header = url.substring(0, comma).toLowerCase(Locale.US);
        if (!header.contains(";base64")) return null;

        File dir = new File(getFilesDir(), "covers");
        if (!dir.exists() && !dir.mkdirs()) return null;

        String ext = header.contains("image/png") ? ".png" : header.contains("image/webp") ? ".webp" : ".jpg";
        File file = new File(dir, "cover_" + id + ext);
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(Base64.decode(url.substring(comma + 1), Base64.DEFAULT));
        }
        return file.getAbsolutePath();
    }

    private void loadArtworkIfNeeded(TrackInfo info) {
        if (info.id == cachedArtworkTrackId && Objects.equals(info.coverPath, cachedArtworkPath)) return;
        cachedArtworkTrackId = info.id;
        cachedArtworkPath = info.coverPath;
        cachedArtwork = null;

        final String path = info.coverPath;
        final int id = info.id;
        if (path == null) return;

        backgroundExecutor.execute(() -> {
            Bitmap bmp = decodeScaled(path, 512);
            handler.post(() -> {
                if (instance != this || bmp == null || id != cachedArtworkTrackId || id != currentTrackId()) return;
                cachedArtwork = bmp;
                updateMediaSessionMetadata(getCurrentTrackInfo(), getDuration());
                updateNotification();
            });
        });
    }

    private static Bitmap decodeScaled(String path, int maxSize) {
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(path, bounds);
            int sample = 1;
            while (bounds.outWidth / sample > maxSize || bounds.outHeight / sample > maxSize) sample *= 2;

            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            opts.inPreferredConfig = Bitmap.Config.RGB_565;
            return BitmapFactory.decodeFile(path, opts);
        } catch (Exception e) {
            return null;
        }
    }

    private void deleteFileQuiet(String path) {
        if (path == null || path.isEmpty()) return;
        try { new File(path).delete(); } catch (Exception ignored) {}
    }

    private String metaKey(int id) { return META_PREFIX + id; }
    private String splitArtist(String title) {
        return title != null && title.contains(" - ") ? title.substring(0, title.indexOf(" - ")) : "ALTY";
    }

    private TrackInfo getTrackInfo(int id) {
        try {
            String json = prefs().getString(metaKey(id), null);
            return json != null ? TrackInfo.fromJson(new JSONObject(json)) : null;
        } catch (Exception e) {
            return null;
        }
    }

    private void saveTrackInfo(TrackInfo info) throws Exception {
        prefs().edit().putString(metaKey(info.id), info.toJson().toString()).apply();
    }

    private static final class TrackInfo {
        final int id;
        String name;
        final String nativePath;
        String coverPath;

        TrackInfo(int id, String name, String nativePath, String coverPath) {
            this.id = id;
            this.name = name == null ? "" : name;
            this.nativePath = nativePath == null ? "" : nativePath;
            this.coverPath = coverPath;
        }

        JSONObject toJson() throws Exception {
            return new JSONObject()
                    .put("id", id)
                    .put("name", name)
                    .put("nativePath", nativePath)
                    .put("coverPath", coverPath == null ? JSONObject.NULL : coverPath);
        }

        static TrackInfo fromJson(JSONObject o) {
            String cover = o.isNull("coverPath") ? null : o.optString("coverPath", "");
            if (cover != null && cover.isEmpty()) cover = null;
            return new TrackInfo(o.optInt("id", -1), o.optString("name", ""), o.optString("nativePath", ""), cover);
        }
    }
}
