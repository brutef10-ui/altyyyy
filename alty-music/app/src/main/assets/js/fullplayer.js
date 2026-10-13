// ALTY: полноэкранный плеер (как в Spotify).
// Подключается после app.js и не меняет его код: оборачивает несколько методов app,
// чтобы большой плеер показывал то же, что мини-плеер, и добавляет свои методы.
(function () {
    'use strict';

    var app = window.app;
    if (!app) return;

    // Перевод надписи «Сейчас играет» (data-i18n в разметке плеера)
    if (typeof I18N !== 'undefined') {
        if (I18N.ru) I18N.ru['Сейчас играет'] = 'Сейчас играет';
        if (I18N.en) I18N.en['Сейчас играет'] = 'Now playing';
    }

    var byId = function (id) { return document.getElementById(id); };
    var clamp = function (v) { return Math.max(0, Math.min(100, Number(v) || 0)); };

    var fp = {
        open: false,
        history: false,
        renderKey: null,
        colorToken: 0,
        trackId: null,
        dragging: false,
        moved: false,
        touchedAt: 0,
        holdUntil: 0,
        modeOverride: null // сразу после нажатия сервис может ещё не применить новый режим
    };

    // ---------- данные текущего трека ----------

    function currentTrack() {
        var queued = app.currentIndex >= 0 ? app.playbackQueue[app.currentIndex] : null;
        if (!queued) return null;
        return app.tracks.find(function (t) { return Number(t.id) === Number(queued.id); }) || queued;
    }

    // Имя трека хранится как «Исполнитель - Название» (см. app.extractCoverAndTags)
    function splitName(name) {
        var full = String(name || '').trim();
        var m = full.match(/^(.+?)\s+[-–—]\s+(.+)$/);
        return m ? { title: m[2].trim(), artist: m[1].trim() } : { title: full, artist: '' };
    }

    function trackFormat(track) {
        var ext = (String(track.nativePath || '').match(/\.([a-z0-9]{2,5})$/i) || [])[1] || '';
        var probe = String(track.type || '').toLowerCase() + ' ' + ext.toLowerCase();
        var formats = [
            ['FLAC', /flac/, true], ['WAV', /wav/, true], ['AIFF', /aif/, true],
            ['OPUS', /opus/, false], ['OGG', /ogg|oga/, false], ['AAC', /aac/, false],
            ['M4A', /m4a|mp4/, false], ['MP3', /mpeg|mp3/, false]
        ];
        for (var i = 0; i < formats.length; i++) {
            if (formats[i][1].test(probe)) return { name: formats[i][0], lossless: formats[i][2] };
        }
        return null;
    }

    // ---------- бегущая строка: только если текст не помещается ----------

    function setMarquee(el, text) {
        if (!el) return;
        text = String(text || '');
        if (el._fpText === text && el.firstElementChild) return;
        el._fpText = text;
        el.classList.remove('is-overflowing');
        el._fpDistance = null;
        el.textContent = '';
        var track = document.createElement('span');
        track.className = 'fp-marquee-track';
        var label = document.createElement('span');
        label.textContent = text;
        track.appendChild(label);
        el.appendChild(track);
        refreshMarquee(el);
    }

    function refreshMarquee(el) {
        var track = el && el.firstElementChild;
        if (!track || !track.classList.contains('fp-marquee-track')) return;
        var label = track.firstElementChild;
        var gap = 48;
        var available = el.clientWidth;
        var overflow = available > 0 && label.offsetWidth > available + 1;
        var distance = overflow ? Math.ceil(label.offsetWidth + gap) : 0;
        if (overflow === el.classList.contains('is-overflowing') && distance === el._fpDistance) return;
        el._fpDistance = distance;
        while (track.children.length > 1) track.removeChild(track.lastElementChild);
        if (!overflow) { el.classList.remove('is-overflowing'); return; }
        var spacer = document.createElement('span');
        spacer.className = 'fp-marquee-gap';
        var copy = label.cloneNode(true);
        copy.setAttribute('aria-hidden', 'true');
        track.appendChild(spacer);
        track.appendChild(copy);
        el.style.setProperty('--fp-marquee-distance', '-' + distance + 'px');
        el.style.setProperty('--fp-marquee-duration', Math.max(6, distance / 32 / 0.82).toFixed(2) + 's');
        el.classList.add('is-overflowing');
    }

    function refreshAllMarquees() {
        document.querySelectorAll('#full-player .fp-marquee').forEach(refreshMarquee);
    }

    // ---------- отрисовка ----------

    function setCover(src) {
        var img = byId('fp-cover-img');
        var placeholder = byId('fp-cover-placeholder');
        if (!img || !placeholder) return;
        if (src) {
            if (img.getAttribute('src') !== src) img.src = src;
            img.classList.remove('hidden');
            placeholder.classList.add('hidden');
        } else {
            img.removeAttribute('src');
            img.classList.add('hidden');
            placeholder.classList.remove('hidden');
        }
    }

    // Фон подкрашивается под средний цвет обложки
    function applyCoverColor(cover) {
        var bg = byId('fp-bg');
        if (!bg) return;
        var fallback = '72, 28, 28';
        var token = ++fp.colorToken;
        if (!cover) { bg.style.setProperty('--fp-color', fallback); return; }
        var img = new Image();
        img.onload = function () {
            if (token !== fp.colorToken) return;
            try {
                var size = 24;
                var canvas = document.createElement('canvas');
                canvas.width = canvas.height = size;
                var ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, size, size);
                var data = ctx.getImageData(0, 0, size, size).data;
                var r = 0, g = 0, b = 0, total = 0;
                for (var i = 0; i < data.length; i += 4) {
                    var max = Math.max(data[i], data[i + 1], data[i + 2]);
                    var min = Math.min(data[i], data[i + 1], data[i + 2]);
                    var w = 1 + (max - min) / 32; // насыщенные пиксели важнее серого фона
                    r += data[i] * w; g += data[i + 1] * w; b += data[i + 2] * w; total += w;
                }
                r /= total; g /= total; b /= total;
                var peak = Math.max(r, g, b, 1);
                var k = peak > 120 ? 120 / peak : 1; // достаточно тёмный для белого текста
                bg.style.setProperty('--fp-color', Math.round(r * k) + ', ' + Math.round(g * k) + ', ' + Math.round(b * k));
            } catch (e) {
                bg.style.setProperty('--fp-color', fallback);
            }
        };
        img.onerror = function () { if (token === fp.colorToken) bg.style.setProperty('--fp-color', fallback); };
        img.src = cover;
    }

    // Вызывается из app.updatePlayerUI (в том числе каждые 500 мс), поэтому рисуем только при смене трека
    function renderTrack(track) {
        if (!track) return;
        var cover = track.cover || '';
        var key = track.id + '|' + track.name + '|' + (track.type || '') + '|' + cover.length + '|' + cover.slice(-32);
        if (key === fp.renderKey) return;
        fp.renderKey = key;

        var parts = splitName(track.name);
        setMarquee(byId('fp-title'), parts.title);
        var artist = byId('fp-artist');
        if (artist) {
            artist.classList.toggle('hidden', !parts.artist);
            setMarquee(artist, parts.artist);
        }
        setCover(cover);
        applyCoverColor(cover);

        var format = trackFormat(track);
        var formatEl = byId('fp-format');
        var losslessEl = byId('fp-lossless');
        if (formatEl) {
            formatEl.textContent = format ? format.name : '';
            formatEl.classList.toggle('hidden', !format);
        }
        if (losslessEl) losslessEl.classList.toggle('hidden', !(format && format.lossless));
    }

    function renderMeta() {
        var source = byId('fp-source');
        var position = byId('fp-position');
        var playlist = app.queueSourcePlaylistId != null
            ? app.playlists.find(function (p) { return p.id === app.queueSourcePlaylistId; }) : null;
        var sourceText = playlist ? playlist.name : app.t('Медиатека');
        if (source && source.textContent !== sourceText) source.textContent = sourceText;
        var total = app.playbackQueue.length;
        var n = app.currentIndex + 1;
        var positionText = total > 0 && app.currentIndex >= 0
            ? (app.language === 'en' ? 'Track ' + n + ' of ' + total : 'Трек ' + n + ' из ' + total) : '';
        if (position && position.textContent !== positionText) position.textContent = positionText;
    }

    function renderPlayIcon(isPlaying) {
        var play = byId('fp-play-icon');
        var pause = byId('fp-pause-icon');
        if (play) play.classList.toggle('hidden', !!isPlaying);
        if (pause) pause.classList.toggle('hidden', !isPlaying);
    }

    // repeatMode: 0 — выкл, 1 — повторять очередь/альбом, 2 — повторять трек
    function renderModes(queueReady) {
        var shuffle = app.isShuffle;
        var repeat = app.repeatMode;
        var override = fp.modeOverride;
        if (override && Date.now() < override.until) { shuffle = override.shuffle; repeat = override.repeat; }

        var fpShuffle = byId('fp-btn-shuffle');
        var fpRepeat = byId('fp-btn-repeat');
        var fpBadge = byId('fp-repeat-badge');
        if (fpShuffle) { fpShuffle.classList.toggle('is-active', shuffle); fpShuffle.setAttribute('aria-pressed', String(shuffle)); }
        if (fpRepeat) { fpRepeat.classList.toggle('is-active', repeat !== 0); fpRepeat.setAttribute('aria-pressed', String(repeat !== 0)); }
        if (fpBadge) fpBadge.classList.toggle('hidden', repeat !== 2);

        // Кнопки мини-плеера красим так же, как app.toggleShuffle / app.toggleRepeat,
        // чтобы оба плеера не показывали разное (например, режимы, восстановленные сервисом).
        // Без очереди сервис не хранит выбор, поэтому мини-плеер в этом случае не трогаем.
        if (!queueReady) return;
        var btn = byId('btn-shuffle');
        var dot = byId('shuffle-dot');
        var rbtn = byId('btn-repeat');
        var badge = byId('repeat-badge');
        if (btn) { btn.classList.toggle('text-red-500', shuffle); btn.classList.toggle('text-gray-400', !shuffle); }
        if (dot) dot.classList.toggle('hidden', !shuffle);
        if (rbtn) { rbtn.classList.toggle('text-red-500', repeat !== 0); rbtn.classList.toggle('text-gray-400', repeat === 0); }
        if (badge) badge.classList.toggle('hidden', repeat !== 2);
    }

    function renderVolume() {
        var bar = byId('fp-volume-bar');
        if (!bar) return;
        var value = Math.round(app.masterVolume * 100);
        bar.value = value;
        bar.style.setProperty('--fill', value + '%');
    }

    function renderProgress(state) {
        var bar = byId('fp-progress-bar');
        var current = byId('fp-time-current');
        var total = byId('fp-time-total');
        var duration = Number(state.durationMs || 0);
        var position = Number(state.positionMs || 0);
        if (Number(state.id) !== fp.trackId) { fp.trackId = Number(state.id); fp.holdUntil = 0; }
        if (fp.dragging && Date.now() - fp.touchedAt > 4000) releaseSeek(); // страховка, как в app
        if (total) total.textContent = app.formatTime(duration / 1000);
        if (fp.dragging || Date.now() < fp.holdUntil) return;
        var value = duration > 0 ? clamp(position / duration * 100) : 0;
        if (bar) { bar.value = value; bar.style.setProperty('--fill', value + '%'); }
        if (current) current.textContent = app.formatTime(position / 1000);
    }

    // ---------- перемотка в полноэкранном плеере ----------

    function previewSeek() {
        var bar = byId('fp-progress-bar');
        var current = byId('fp-time-current');
        var d = app.nativeState && Number(app.nativeState.durationMs);
        if (!bar || !d) return;
        fp.moved = true;
        bar.style.setProperty('--fill', clamp(bar.value) + '%');
        if (current) current.textContent = app.formatTime(Number(bar.value) / 100 * d / 1000);
    }

    function releaseSeek() {
        if (!fp.dragging) return;
        fp.dragging = false;
        var moved = fp.moved;
        fp.moved = false;
        var bar = byId('fp-progress-bar');
        var d = app.nativeState && Number(app.nativeState.durationMs);
        if (!moved || !bar || !d) return;
        fp.holdUntil = Date.now() + 800;
        app.progressHoldUntil = Date.now() + 800; // ползунок мини-плеера тоже не дёргается назад
        ALTYNative.seekTo(Number(bar.value) / 100 * d);
    }

    // ---------- открытие / закрытие ----------

    function isAnyModalOpen() {
        return !!document.querySelector('[id$="-modal"]:not(.hidden)');
    }

    function openFullPlayer() {
        var panel = byId('full-player');
        var track = currentTrack();
        if (!panel || !track || fp.open) return;
        fp.open = true;
        renderTrack(track);
        renderMeta();
        renderVolume();
        renderModes(true);
        if (app.nativeState) {
            renderProgress(app.nativeState);
            renderPlayIcon(!!app.nativeState.isPlaying);
        }
        panel.style.transform = '';
        panel.classList.add('is-open');
        panel.setAttribute('aria-hidden', 'false');
        // Кнопка «Назад» на Android (WebView.goBack в MainActivity) сначала свернёт плеер
        try { history.pushState({ altyFullPlayer: true }, ''); fp.history = true; } catch (e) { fp.history = false; }
        refreshAllMarquees();
    }

    function closeFullPlayer(fromHistory) {
        var panel = byId('full-player');
        if (!panel || !fp.open) return;
        fp.open = false;
        if (panel.contains(document.activeElement)) document.activeElement.blur();
        panel.style.transform = '';
        panel.classList.remove('is-open');
        panel.setAttribute('aria-hidden', 'true');
        var hadHistory = fp.history;
        fp.history = false;
        if (hadHistory && fromHistory !== true) { try { history.back(); } catch (e) {} }
    }

    // ---------- новые методы app (вызываются из разметки) ----------

    var methods = {
        openFullPlayer: openFullPlayer,
        closeFullPlayer: function () { closeFullPlayer(false); },
        fullPlayerEditTrack: function () {
            var track = currentTrack();
            if (track) app.openEditTrackModal(track);
        },
        fullPlayerAddToPlaylist: function () {
            var track = currentTrack();
            if (track) app.showAddToPlaylistModal(track.id);
        }
    };
    Object.keys(methods).forEach(function (name) {
        if (typeof app[name] === 'undefined') app[name] = methods[name];
    });

    // ---------- обёртки существующих методов (оригинал вызывается первым и без изменений) ----------

    function after(name, extra) {
        var original = app[name];
        if (typeof original !== 'function') return;
        app[name] = function () {
            var result = original.apply(this, arguments);
            try { extra.apply(this, arguments); } catch (e) { console.error('ALTY full player', e); }
            return result;
        };
    }

    after('updatePlayerUI', function (track) {
        renderTrack(track);
        renderMeta();
    });
    after('updatePlayPauseIcon', function (isPlaying) {
        renderPlayIcon(isPlaying);
    });
    after('handleNativeState', function (state, polling) {
        if (!state) return;
        if (typeof state.volume === 'number' && !polling) renderVolume();
        renderModes(state.ready !== false);
        renderProgress(state);
        renderMeta();
    });
    ['toggleShuffle', 'toggleRepeat'].forEach(function (name) {
        after(name, function () {
            fp.modeOverride = { until: Date.now() + 1500, shuffle: app.isShuffle, repeat: app.repeatMode };
            renderModes(false);
        });
    });
    after('applyLanguage', function () {
        renderMeta();
    });

    // ---------- обработчики ----------

    function setup() {
        var mini = byId('bottom-player');
        var panel = byId('full-player');
        var scroller = byId('fp-scroll');
        var seekBar = byId('fp-progress-bar');
        var volumeBar = byId('fp-volume-bar');
        var miniVolume = byId('volume-bar');
        if (!panel) return;

        // Нажатие на мини-плеер (кроме кнопок и ползунков) открывает большой плеер
        if (mini) mini.addEventListener('click', function (e) {
            if (e.target.closest('button, input, a, label')) return;
            openFullPlayer();
        });

        if (seekBar) {
            seekBar.step = 'any';
            seekBar.style.touchAction = 'none';
            var touch = function () { fp.dragging = true; fp.touchedAt = Date.now(); };
            seekBar.addEventListener('pointerdown', touch);
            seekBar.addEventListener('pointermove', function () { if (fp.dragging) fp.touchedAt = Date.now(); });
            seekBar.addEventListener('input', function () { touch(); previewSeek(); });
            seekBar.addEventListener('change', releaseSeek);
            ['pointerup', 'pointercancel', 'touchend', 'touchcancel', 'blur'].forEach(function (ev) {
                window.addEventListener(ev, releaseSeek);
            });
        }

        // Громкость: та же логика, что у ползунка volume-bar в app.setupEventListeners
        if (volumeBar) volumeBar.addEventListener('input', function (e) {
            app.masterVolume = Number(e.target.value) / 100;
            localStorage.setItem('alty_volume', String(app.masterVolume));
            ALTYNative.setVolume(app.masterVolume);
            if (miniVolume) miniVolume.value = Math.round(app.masterVolume * 100);
            renderVolume();
        });
        if (miniVolume) miniVolume.addEventListener('input', renderVolume);
        renderVolume();

        if (window.ResizeObserver) {
            var observer = new ResizeObserver(function (entries) {
                entries.forEach(function (entry) { refreshMarquee(entry.target); });
            });
            document.querySelectorAll('#full-player .fp-marquee').forEach(function (el) { observer.observe(el); });
        } else {
            window.addEventListener('resize', refreshAllMarquees);
        }

        window.addEventListener('popstate', function () {
            if (!fp.open) return;
            if (isAnyModalOpen()) {
                app.closeModals();
                try { history.pushState({ altyFullPlayer: true }, ''); } catch (e) {}
                return;
            }
            closeFullPlayer(true);
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && fp.open && !isAnyModalOpen()) closeFullPlayer(false);
        });

        // Свайп вниз сворачивает плеер
        if (!scroller) return;
        var startX = 0, startY = 0, startT = 0, dy = 0, tracking = false, dragging = false;
        panel.addEventListener('touchstart', function (e) {
            tracking = false;
            if (!fp.open || e.touches.length !== 1 || e.target.closest('input')) return;
            if (scroller.scrollTop > 0) return;
            tracking = true;
            dragging = false;
            dy = 0;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            startT = Date.now();
        }, { passive: true });
        panel.addEventListener('touchmove', function (e) {
            if (!tracking) return;
            var dx = e.touches[0].clientX - startX;
            var moveY = e.touches[0].clientY - startY;
            if (!dragging) {
                if (Math.abs(moveY) < 8 && Math.abs(dx) < 8) return;
                if (moveY <= 0 || Math.abs(dx) > Math.abs(moveY)) { tracking = false; return; }
                dragging = true;
                panel.classList.add('is-dragging');
            }
            dy = Math.max(0, moveY);
            panel.style.transform = 'translateY(' + dy + 'px)';
            e.preventDefault();
        }, { passive: false });
        var endSwipe = function () {
            if (!tracking) return;
            tracking = false;
            if (!dragging) return;
            dragging = false;
            panel.classList.remove('is-dragging');
            panel.style.transform = '';
            var flick = dy > 60 && Date.now() - startT < 250;
            if (flick || dy > Math.min(160, window.innerHeight * 0.22)) closeFullPlayer(false);
        };
        panel.addEventListener('touchend', endSwipe);
        panel.addEventListener('touchcancel', endSwipe);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
    else setup();
})();
