    const app = {
        mediaSessionReady: false,
        backgroundAudioStarted: false,
        tracks: [],
        playlists: [],
        originalQueue: [],
        playbackQueue: [],
        currentIndex: -1,
        isShuffle: false,
        repeatMode: 0,
        activeTab: 'library',
        language: localStorage.getItem('alty_language') || 'ru',
        theme: localStorage.getItem('alty_theme') || 'dark',
        _staticTextNodes: null,
        viewingPlaylistId: null,
        editingTrackId: null,
        tempCoverDataUrl: null,
        deleteTarget: null,
        queueSourcePlaylistId: null,
        movingTrack: null,
        _drag: null,
        hasStartedPlaying: false,
        masterVolume: Number(localStorage.getItem('alty_volume') || '1'),
        nativeState: null,
        nativeStateTimer: null,
		progressDragging: false,
		progressMoved: false,
		progressTouchedAt: 0,
		progressHoldUntil: 0,
        fullPlayerOpen: false,
        _fpHistory: false,
        _playerUIKey: null,
        _progressBar: null,
        _modeChangedAt: 0,
        _fpColorToken: 0,

        t(key) {
            return (I18N[this.language] && I18N[this.language][key]) || key;
        },

        formatTrackCount(count) {
            if (this.language === 'en') return `${count} ${count === 1 ? 'track' : 'tracks'}`;
            const n = Math.abs(count) % 100;
            const n1 = n % 10;
            if (n >= 11 && n <= 19) return `${count} треков`;
            if (n1 === 1) return `${count} трек`;
            if (n1 >= 2 && n1 <= 4) return `${count} трека`;
            return `${count} треков`;
        },

        applyTheme() {
            document.documentElement.classList.toggle('light', this.theme === 'light');
            document.documentElement.style.colorScheme = this.theme === 'light' ? 'light' : 'dark';
            const dark = document.getElementById('theme-dark');
            const light = document.getElementById('theme-light');
            if (dark) dark.classList.toggle('active', this.theme === 'dark');
            if (light) light.classList.toggle('active', this.theme === 'light');
        },

        applyLanguage() {
            document.documentElement.lang = this.language;

            document.querySelectorAll('[data-i18n]').forEach(el => {
                const key = el.getAttribute('data-i18n');
                el.textContent = this.t(key);
            });

            document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
                const key = el.getAttribute('data-i18n-placeholder');
                el.placeholder = this.t(key);
            });

            if (!this._staticTextNodes) {
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                const nodes = [];
                let node;
                while ((node = walker.nextNode())) {
                    const value = node.nodeValue.trim();
                    if (value && STATIC_KEYS.has(value) && !node.parentElement.closest('[data-i18n]')) {
                        nodes.push({ node, key: value });
                    }
                }
                this._staticTextNodes = nodes;
            }

            this._staticTextNodes.forEach(item => {
                if (item.node && item.node.parentNode) item.node.nodeValue = item.node.nodeValue.replace(item.node.nodeValue.trim(), this.t(item.key));
            });

            const ru = document.getElementById('lang-ru');
            const en = document.getElementById('lang-en');
            if (ru) { ru.textContent = this.t('Русский'); ru.classList.toggle('active', this.language === 'ru'); }
            if (en) { en.textContent = 'English'; en.classList.toggle('active', this.language === 'en'); }

            this.renderAll();
            this.updateFullPlayerMeta();
        },

        changeLanguage(lang) {
            if (!I18N[lang]) return;
            this.language = lang;
            localStorage.setItem('alty_language', lang);
            this.applyLanguage();
        },

        changeTheme(theme) {
            if (theme !== 'dark' && theme !== 'light') return;
            this.theme = theme;
            localStorage.setItem('alty_theme', theme);
            this.applyTheme();
        },

        initPreferences() {
            this.applyTheme();
            this.applyLanguage();
        },

        async init() {
            try {
                await initDB();
                await this.loadData();
                this.initPreferences();
                this.setupEventListeners();
                this.setupMediaSessionHandlers();
                this.renderAll();
                this.switchTab('library');

                const state = ALTYNative.getState();
                if (state) this.handleNativeState(state);
            } catch (e) {
                console.error(e);
                this.showToast(this.t("Ошибка базы данных"));
            }
        },

        async loadData() {    
            this.tracks = await DB.getAllTracks();    
            this.playlists = await DB.getAllPlaylists();    
        },    
  
        extractCoverAndTags(file) {    
            return new Promise((resolve) => {    
                if (!window.jsmediatags) { resolve({ name: file.name.replace(/\.[^/.]+$/, ""), cover: null }); return; }    
                    
                jsmediatags.read(file, {    
                    onSuccess: function(tag) {    
                        let title = tag.tags.title || file.name.replace(/\.[^/.]+$/, "");    
                        let artist = tag.tags.artist || "";    
                        let fullName = artist ? `${artist} - ${title}` : title;    
  
                        if (tag.tags.picture) {    
                            const data = tag.tags.picture.data;    
                            const format = tag.tags.picture.format;    
                              
                            // Uint8Array и Blob для мгновенной конвертации  
                            const byteArray = new Uint8Array(data);  
                            const blob = new Blob([byteArray], { type: format });  
                              
                            const reader = new FileReader();  
                            reader.onloadend = function() {  
                                resolve({ name: fullName, cover: reader.result });  
                            };  
                            reader.readAsDataURL(blob);  
                        } else {  
                            resolve({ name: fullName, cover: null });  
                        }    
                    },    
                    onError: function(error) {    
                        resolve({ name: file.name.replace(/\.[^/.]+$/, ""), cover: null });    
                    }    
                });    
            });    
        },    
  
        async handleFiles(e) {
            const files = e.target.files;
            if (!files || files.length === 0) return;

            const pendingImports = ALTYNative.consumeImports();
            this.showToast(`${this.t("Обработка")} ${files.length} ${this.language === "en" ? (files.length === 1 ? "track" : "tracks") : "треков"}...`);

            const usedPending = new Set();
            let imported = 0;

            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const tags = await this.extractCoverAndTags(file);

                let nativeItem = null;
                const exact = pendingImports.findIndex((item, idx) => !usedPending.has(idx) && item.originalName === file.name);
                if (exact >= 0) {
                    nativeItem = pendingImports[exact];
                    usedPending.add(exact);
                } else if (pendingImports[i] && !usedPending.has(i)) {
                    nativeItem = pendingImports[i];
                    usedPending.add(i);
                } else {
                    const firstFree = pendingImports.findIndex((_, idx) => !usedPending.has(idx));
                    if (firstFree >= 0) { nativeItem = pendingImports[firstFree]; usedPending.add(firstFree); }
                }

                const id = await DB.addTrack({
                    name: tags.name,
                    cover: tags.cover,
                    type: file.type,
                    timestamp: Date.now(),
                    nativePath: nativeItem ? nativeItem.nativePath : null
                });

                let ok = true;
                if (ALTYNative.available()) {
                    ok = !!nativeItem && ALTYNative.registerTrack(id, tags.name, nativeItem.nativePath, '');
                }
                if (!ok) {
                    await DB.deleteTrack(id);
                    this.showToast(this.t("Ошибка файла"));
                    continue;
                }
                imported++;
            }

            await this.loadData();
            this.renderAll();
            if (imported > 0) this.showToast(this.t("Треки добавлены!"));
            e.target.value = '';
        },

        setupEventListeners() {
            const progressBar = document.getElementById('progress-bar');
            const volumeBar = document.getElementById('volume-bar');
            const moveInput = document.getElementById('move-track-input');
            const searchInput = document.getElementById('search-input');

            // Перемотка: ползунок мини-плеера и ползунок полноэкранного плеера работают одинаково
            const progressBars = [progressBar, document.getElementById('fp-progress-bar')].filter(Boolean);
            const release = () => this.endProgressDrag();
            progressBars.forEach(bar => {
    bar.step = 'any';
    bar.style.touchAction = 'none';
    const touch = () => { this.progressDragging = true; this.progressTouchedAt = Date.now(); this._progressBar = bar; };
    bar.addEventListener('pointerdown', touch);
    bar.addEventListener('pointermove', () => { if (this.progressDragging) this.progressTouchedAt = Date.now(); });
    bar.addEventListener('input', () => { touch(); this.previewProgress(bar); });
    bar.addEventListener('change', release);
            });
            if (progressBars.length) {
    ['pointerup', 'pointercancel', 'touchend', 'touchcancel', 'blur']
        .forEach(ev => window.addEventListener(ev, release));
            }

            [volumeBar, document.getElementById('fp-volume-bar')].filter(Boolean).forEach(bar => {
    bar.addEventListener('input', (e) => {
        this.masterVolume = Number(e.target.value) / 100;
        localStorage.setItem('alty_volume', String(this.masterVolume));
        ALTYNative.setVolume(this.masterVolume);
        this.renderVolume();
    });
            });
            this.renderVolume();
            this.setupFullPlayer();
            if (moveInput) moveInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.saveTrackMove(); });
            if (searchInput) searchInput.addEventListener('input', (e) => this.renderSearch(e.target.value));
            if (this.nativeStateTimer) clearInterval(this.nativeStateTimer);
            this.nativeStateTimer = setInterval(() => {
                if (document.visibilityState !== 'visible') return;
                const state = ALTYNative.getState();
                if (state) this.handleNativeState(state, true);
            }, 500);
        },
		
		previewProgress(bar = this._progressBar) {
    const d = this.nativeState && Number(this.nativeState.durationMs);
    if (!bar || !d) return;
    this.progressMoved = true;
    this.renderProgress(Number(bar.value), this.formatTime(Number(bar.value) / 100 * d / 1000));
},

endProgressDrag() {
    if (!this.progressDragging) return;
    this.progressDragging = false;
    const moved = this.progressMoved;
    this.progressMoved = false;
    const bar = this._progressBar || document.getElementById('progress-bar');
    const d = this.nativeState && Number(this.nativeState.durationMs);
    if (!moved || !bar || !d) return;
    this.progressHoldUntil = Date.now() + 800; // не даём ползунку дёрнуться назад
    ALTYNative.seekTo(Number(bar.value) / 100 * d);
},

        showPlayerUI() {    
            if (!this.hasStartedPlaying) {    
                this.hasStartedPlaying = true;    
                document.getElementById('bottom-player').classList.remove('translate-y-full');    
                document.getElementById('main-content').classList.remove('pb-20', 'md:pb-0');    
                document.getElementById('main-content').classList.add('pb-36', 'md:pb-24');    
            }    
        },    
  
        setupMediaSessionHandlers() {
            this.mediaSessionReady = ALTYNative.available();
        },

        updateMediaSession(track) {
            if (track) this.updatePlayerUI(track);
        },

        updatePositionState() {
        },

        shuffleArray(array) {
            let arr = [...array];
            for (let i = arr.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [arr[i], arr[j]] = [arr[j], arr[i]];
            }
            return arr;
        },

        setQueueAndPlay(queueList, startIndex = 0, sourcePlaylistId = null) {
            if (!queueList || queueList.length === 0) return;
            this.queueSourcePlaylistId = sourcePlaylistId;
            this.originalQueue = [...queueList];
            if (this.isShuffle) {
                const startTrack = queueList[startIndex];
                const rest = queueList.filter((_, i) => i !== startIndex);
                this.playbackQueue = [startTrack, ...this.shuffleArray(rest)];
                this.currentIndex = 0;
            } else {
                this.playbackQueue = [...queueList];
                this.currentIndex = Math.max(0, Math.min(startIndex, this.playbackQueue.length - 1));
            }

            const ids = this.playbackQueue.map(t => Number(t.id));
            const currentNativeId = this.nativeState ? Number(this.nativeState.id) : -1;
            const selectedId = Number(this.playbackQueue[this.currentIndex].id);
            const sameNativeTrack = currentNativeId === selectedId
                    && Array.isArray(this.nativeState && this.nativeState.queueIds)
                    && this.nativeState.queueIds.length === ids.length
                    && this.nativeState.queueIds.every((id, i) => Number(id) === ids[i]);
            if (sameNativeTrack) ALTYNative.play();
            else ALTYNative.playQueue(ids, this.currentIndex, this.isShuffle, this.repeatMode);
            this.updatePlayerUI(this.playbackQueue[this.currentIndex]);
            this.showPlayerUI();
            this.highlightCurrentTrack();
        },

        playCurrent() {
            if (this.currentIndex < 0 || this.currentIndex >= this.playbackQueue.length) return;
            const track = this.playbackQueue[this.currentIndex];
            const nativeId = this.nativeState ? Number(this.nativeState.id) : -1;
            if (nativeId === Number(track.id)) ALTYNative.play();
            else ALTYNative.playQueue(this.playbackQueue.map(t => Number(t.id)), this.currentIndex, this.isShuffle, this.repeatMode);
            this.updatePlayerUI(track);
            this.showPlayerUI();
            this.highlightCurrentTrack();
        },

        togglePlay() {
            if (!this.playbackQueue.length) return;
            if (this.nativeState && this.nativeState.isPlaying) ALTYNative.pause();
            else ALTYNative.play();
        },

        nextTrack() {
            if (!this.playbackQueue.length) return;
            ALTYNative.next();
        },

        prevTrack() {
            if (!this.playbackQueue.length) return;
            ALTYNative.previous();
        },

        // Вызывается каждые 500 мс из опроса состояния, поэтому перерисовываем только при смене трека
        updatePlayerUI(track) {
            if (!track) return;
            const cover = track.cover || '';
            const key = `${track.id}|${track.name}|${track.type || ''}|${cover.length}|${cover.slice(-32)}`;
            if (key !== this._playerUIKey) {
                this._playerUIKey = key;
                const { title, artist } = this.splitTrackName(track.name);
                [['player-title', 'player-artist'], ['fp-title', 'fp-artist']].forEach(([titleId, artistId]) => {
                    this.setMarqueeText(document.getElementById(titleId), title);
                    const artistEl = document.getElementById(artistId);
                    if (artistEl) {
                        artistEl.classList.toggle('hidden', !artist);
                        this.setMarqueeText(artistEl, artist);
                    }
                });
                this.setCover(document.getElementById('player-cover'), document.getElementById('player-cover-placeholder'), cover);
                this.setCover(document.getElementById('fp-cover-img'), document.getElementById('fp-cover-placeholder'), cover);
                this.applyCoverColor(cover);

                const format = this.getTrackFormat(track);
                const formatEl = document.getElementById('fp-format');
                const losslessEl = document.getElementById('fp-lossless');
                if (formatEl) {
                    formatEl.textContent = format ? format.name : '';
                    formatEl.classList.toggle('hidden', !format);
                }
                if (losslessEl) losslessEl.classList.toggle('hidden', !(format && format.lossless));
            }
            this.updateFullPlayerMeta();
        },

        setCover(img, placeholder, src) {
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
        },

        // Имя трека хранится как «Исполнитель - Название» (см. extractCoverAndTags)
        splitTrackName(name) {
            const full = String(name || '').trim();
            const m = full.match(/^(.+?)\s+[-–—]\s+(.+)$/);
            return m ? { title: m[2].trim(), artist: m[1].trim() } : { title: full, artist: '' };
        },

        getTrackFormat(track) {
            const ext = (String(track.nativePath || '').match(/\.([a-z0-9]{2,5})$/i) || [])[1] || '';
            const probe = `${String(track.type || '').toLowerCase()} ${ext.toLowerCase()}`;
            const formats = [
                ['FLAC', /flac/, true], ['WAV', /wav/, true], ['AIFF', /aif/, true],
                ['OPUS', /opus/, false], ['OGG', /ogg|oga/, false], ['AAC', /aac/, false],
                ['M4A', /m4a|mp4/, false], ['MP3', /mpeg|mp3/, false]
            ];
            const found = formats.find(([, re]) => re.test(probe));
            return found ? { name: found[0], lossless: found[2] } : null;
        },

        getCurrentTrack() {
            const queued = this.currentIndex >= 0 ? this.playbackQueue[this.currentIndex] : null;
            if (!queued) return null;
            return this.tracks.find(t => Number(t.id) === Number(queued.id)) || queued;
        },

        updateFullPlayerMeta() {
            const source = document.getElementById('fp-source');
            const position = document.getElementById('fp-position');
            const playlist = this.queueSourcePlaylistId != null
                ? this.playlists.find(p => p.id === this.queueSourcePlaylistId) : null;
            const sourceText = playlist ? playlist.name : this.t('Медиатека');
            if (source && source.textContent !== sourceText) source.textContent = sourceText;
            const total = this.playbackQueue.length;
            const n = this.currentIndex + 1;
            const positionText = total > 0 && this.currentIndex >= 0
                ? (this.language === 'en' ? `Track ${n} of ${total}` : `Трек ${n} из ${total}`) : '';
            if (position && position.textContent !== positionText) position.textContent = positionText;
        },

        // Фон полноэкранного плеера подкрашивается под средний цвет обложки
        applyCoverColor(cover) {
            const bg = document.getElementById('fp-bg');
            if (!bg) return;
            const fallback = '72, 28, 28';
            const token = ++this._fpColorToken;
            if (!cover) { bg.style.setProperty('--fp-color', fallback); return; }
            const img = new Image();
            img.onload = () => {
                if (token !== this._fpColorToken) return;
                try {
                    const size = 24;
                    const canvas = document.createElement('canvas');
                    canvas.width = canvas.height = size;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, size, size);
                    const data = ctx.getImageData(0, 0, size, size).data;
                    let r = 0, g = 0, b = 0, total = 0;
                    for (let i = 0; i < data.length; i += 4) {
                        const max = Math.max(data[i], data[i + 1], data[i + 2]);
                        const min = Math.min(data[i], data[i + 1], data[i + 2]);
                        const w = 1 + (max - min) / 32; // насыщенные пиксели важнее серого фона
                        r += data[i] * w; g += data[i + 1] * w; b += data[i + 2] * w; total += w;
                    }
                    r /= total; g /= total; b /= total;
                    const peak = Math.max(r, g, b, 1);
                    const k = peak > 120 ? 120 / peak : 1; // достаточно тёмный для белого текста
                    bg.style.setProperty('--fp-color', `${Math.round(r * k)}, ${Math.round(g * k)}, ${Math.round(b * k)}`);
                } catch (e) {
                    bg.style.setProperty('--fp-color', fallback);
                }
            };
            img.onerror = () => { if (token === this._fpColorToken) bg.style.setProperty('--fp-color', fallback); };
            img.src = cover;
        },

        // Бегущая строка включается только если текст не помещается
        setMarqueeText(el, text) {
            if (!el) return;
            text = String(text || '');
            if (el._marqueeText === text && el.firstElementChild) return;
            el._marqueeText = text;
            el.classList.remove('is-overflowing');
            delete el.dataset.marqueeDistance;
            el.textContent = '';
            const track = document.createElement('span');
            track.className = 'alty-marquee-track';
            const label = document.createElement('span');
            label.textContent = text;
            track.appendChild(label);
            el.appendChild(track);
            this.refreshMarquee(el);
        },

        refreshMarquee(el) {
            const track = el && el.firstElementChild;
            if (!track || !track.classList.contains('alty-marquee-track')) return;
            const label = track.firstElementChild;
            const gap = 48;
            const available = el.clientWidth;
            const overflow = available > 0 && label.offsetWidth > available + 1;
            const distance = overflow ? Math.ceil(label.offsetWidth + gap) : 0;
            if (overflow === el.classList.contains('is-overflowing') && String(distance) === el.dataset.marqueeDistance) return;
            el.dataset.marqueeDistance = String(distance);
            while (track.children.length > 1) track.removeChild(track.lastElementChild);
            if (!overflow) { el.classList.remove('is-overflowing'); return; }
            const spacer = document.createElement('span');
            spacer.className = 'alty-marquee-gap';
            const copy = label.cloneNode(true);
            copy.setAttribute('aria-hidden', 'true');
            track.appendChild(spacer);
            track.appendChild(copy);
            el.style.setProperty('--marquee-distance', `-${distance}px`);
            el.style.setProperty('--marquee-duration', `${Math.max(6, distance / 32 / 0.82).toFixed(2)}s`);
            el.classList.add('is-overflowing');
        },

        refreshAllMarquees() {
            document.querySelectorAll('.alty-marquee').forEach(el => this.refreshMarquee(el));
        },

        renderProgress(percent, currentText) {
            const value = Math.max(0, Math.min(100, Number(percent) || 0));
            ['progress-bar', 'fp-progress-bar'].forEach(id => {
                const bar = document.getElementById(id);
                if (!bar) return;
                bar.value = value;
                bar.style.setProperty('--fill', `${value}%`);
            });
            const fill = document.getElementById('mini-progress-fill');
            if (fill) fill.style.width = `${value}%`;
            ['time-current', 'fp-time-current'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.textContent = currentText;
            });
        },

        renderVolume() {
            const value = Math.round(this.masterVolume * 100);
            ['volume-bar', 'fp-volume-bar'].forEach(id => {
                const bar = document.getElementById(id);
                if (!bar) return;
                bar.value = value;
                bar.style.setProperty('--fill', `${value}%`);
            });
        },

        setupFullPlayer() {
            const mini = document.getElementById('bottom-player');
            const panel = document.getElementById('full-player');
            const scroller = document.getElementById('fp-scroll');
            if (mini) mini.addEventListener('click', (e) => {
                if (e.target.closest('button, input, a, label')) return;
                this.openFullPlayer();
            });

            if (window.ResizeObserver) {
                const observer = new ResizeObserver(entries => entries.forEach(entry => this.refreshMarquee(entry.target)));
                document.querySelectorAll('.alty-marquee').forEach(el => observer.observe(el));
            } else {
                window.addEventListener('resize', () => this.refreshAllMarquees());
            }
            if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => this.refreshAllMarquees());

            // Кнопка «Назад» на Android (WebView.goBack) сначала сворачивает плеер
            window.addEventListener('popstate', () => {
                if (!this.fullPlayerOpen) return;
                if (this.isAnyModalOpen()) {
                    this.closeModals();
                    try { history.pushState({ altyFullPlayer: true }, ''); } catch (e) {}
                    return;
                }
                this.closeFullPlayer(true);
            });
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this.fullPlayerOpen && !this.isAnyModalOpen()) this.closeFullPlayer();
            });

            if (!panel || !scroller) return;
            // Свайп вниз сворачивает плеер
            let startX = 0, startY = 0, startT = 0, dy = 0, tracking = false, dragging = false;
            panel.addEventListener('touchstart', (e) => {
                tracking = false;
                if (!this.fullPlayerOpen || e.touches.length !== 1 || e.target.closest('input')) return;
                if (scroller.scrollTop > 0) return;
                tracking = true;
                dragging = false;
                dy = 0;
                startX = e.touches[0].clientX;
                startY = e.touches[0].clientY;
                startT = Date.now();
            }, { passive: true });
            panel.addEventListener('touchmove', (e) => {
                if (!tracking) return;
                const dx = e.touches[0].clientX - startX;
                const moveY = e.touches[0].clientY - startY;
                if (!dragging) {
                    if (Math.abs(moveY) < 8 && Math.abs(dx) < 8) return;
                    if (moveY <= 0 || Math.abs(dx) > Math.abs(moveY)) { tracking = false; return; }
                    dragging = true;
                    panel.classList.add('is-dragging');
                }
                dy = Math.max(0, moveY);
                panel.style.transform = `translateY(${dy}px)`;
                e.preventDefault();
            }, { passive: false });
            const endSwipe = () => {
                if (!tracking) return;
                tracking = false;
                if (!dragging) return;
                dragging = false;
                panel.classList.remove('is-dragging');
                panel.style.transform = '';
                const flick = dy > 60 && Date.now() - startT < 250;
                if (flick || dy > Math.min(160, window.innerHeight * 0.22)) this.closeFullPlayer();
            };
            panel.addEventListener('touchend', endSwipe);
            panel.addEventListener('touchcancel', endSwipe);
        },

        isAnyModalOpen() {
            return !!document.querySelector('[id$="-modal"]:not(.hidden)');
        },

        openFullPlayer() {
            const panel = document.getElementById('full-player');
            const track = this.getCurrentTrack();
            if (!panel || !track || this.fullPlayerOpen) return;
            this.fullPlayerOpen = true;
            this.updatePlayerUI(track);
            panel.style.transform = '';
            panel.classList.add('is-open');
            panel.setAttribute('aria-hidden', 'false');
            try { history.pushState({ altyFullPlayer: true }, ''); this._fpHistory = true; } catch (e) { this._fpHistory = false; }
            this.refreshAllMarquees();
        },

        closeFullPlayer(fromHistory = false) {
            const panel = document.getElementById('full-player');
            if (!panel || !this.fullPlayerOpen) return;
            this.fullPlayerOpen = false;
            if (panel.contains(document.activeElement)) document.activeElement.blur();
            panel.style.transform = '';
            panel.classList.remove('is-open');
            panel.setAttribute('aria-hidden', 'true');
            const hadHistory = this._fpHistory;
            this._fpHistory = false;
            if (hadHistory && !fromHistory) { try { history.back(); } catch (e) {} }
        },

        editCurrentTrack() {
            const track = this.getCurrentTrack();
            if (track) this.openEditTrackModal(track);
        },

        addCurrentTrackToPlaylist() {
            const track = this.getCurrentTrack();
            if (track) this.showAddToPlaylistModal(track.id);
        },

        handleNativeState(state, polling = false) {
            if (!state) return;
            this.nativeState = state;

            if (typeof state.volume === 'number' && !polling) {
                this.masterVolume = Math.max(0, Math.min(1, state.volume));
                localStorage.setItem('alty_volume', String(this.masterVolume));
                this.renderVolume();
            }
            // Сразу после нажатия сервис может ещё не применить новый режим, а без очереди он не хранит наш выбор
            const modesSettled = Date.now() - this._modeChangedAt > 1500;
            if (modesSettled && state.ready !== false) {
                if (typeof state.repeatMode === 'number') this.repeatMode = Math.max(0, Math.min(2, state.repeatMode));
                if (typeof state.shuffle === 'boolean') this.isShuffle = state.shuffle;
            }
            this.updateModeButtons();
            if (Array.isArray(state.queueIds) && state.queueIds.length && this.playbackQueue.length === 0) {
                const byId = new Map(this.tracks.map(track => [Number(track.id), track]));
                const restored = state.queueIds
                    .map(id => byId.get(Number(id)))
                    .filter(Boolean);
                if (restored.length) {
                    this.playbackQueue = restored;
                    this.originalQueue = [...restored];
                    this.currentIndex = Math.max(0, Math.min(Number(state.index) || 0, restored.length - 1));
                    this.queueSourcePlaylistId = null;
                }
            }

            if (state.id != null && Number(state.id) >= 0) {
                const trackId = Number(state.id);
                const index = this.playbackQueue.findIndex(t => Number(t.id) === trackId);
                if (index >= 0) this.currentIndex = index;
                const track = this.tracks.find(t => Number(t.id) === trackId)
                    || (this.currentIndex >= 0 ? this.playbackQueue[this.currentIndex] : null);
                if (track) {
                    this.updatePlayerUI(track);
                    this.showPlayerUI();
                }
            }

            this.updatePlayPauseIcon(!!state.isPlaying);
            const duration = Number(state.durationMs || 0);
            const position = Number(state.positionMs || 0);
            // страховка: если отпускание пальца потерялось, не залипаем
if (this.progressDragging && Date.now() - this.progressTouchedAt > 4000) this.endProgressDrag();
const trackId = Number(state.id);
if (trackId !== this._progressTrackId) { this._progressTrackId = trackId; this.progressHoldUntil = 0; }
const busy = this.progressDragging || Date.now() < this.progressHoldUntil;
if (!busy) this.renderProgress(duration > 0 ? position / duration * 100 : 0, this.formatTime(position / 1000));
['time-total', 'fp-time-total'].forEach(id => {
    const total = document.getElementById(id);
    if (total) total.textContent = this.formatTime(duration / 1000);
});
            this.highlightCurrentTrack();
        },

        toggleShuffle() {
            this.isShuffle = !this.isShuffle;
            this._modeChangedAt = Date.now();
            this.updateModeButtons();

            if (this.playbackQueue.length > 0 && this.currentIndex >= 0) {
                const currentTrack = this.playbackQueue[this.currentIndex];
                if (!currentTrack) return;
                if (this.isShuffle) {
                    const rest = this.originalQueue.filter(t => t.id !== currentTrack.id);
                    this.playbackQueue = [currentTrack, ...this.shuffleArray(rest)];
                    this.currentIndex = 0;
                } else {
                    this.playbackQueue = [...this.originalQueue];
                    this.currentIndex = this.playbackQueue.findIndex(t => t.id === currentTrack.id);
                }
                ALTYNative.setQueue(this.playbackQueue.map(t => Number(t.id)), this.currentIndex, this.isShuffle, this.repeatMode);
                this.highlightCurrentTrack();
            }
        },

        toggleRepeat() {
            this.repeatMode = (this.repeatMode + 1) % 3;
            this._modeChangedAt = Date.now();
            this.updateModeButtons();
            ALTYNative.setRepeat(this.repeatMode);
        },

        // repeatMode: 0 — выкл, 1 — повторять очередь/альбом, 2 — повторять трек
        updateModeButtons() {
            const shuffleOn = this.isShuffle;
            const repeatOn = this.repeatMode !== 0;
            const shuffleBtn = document.getElementById('btn-shuffle');
            const repeatBtn = document.getElementById('btn-repeat');
            if (shuffleBtn) {
                shuffleBtn.classList.toggle('text-red-500', shuffleOn);
                shuffleBtn.classList.toggle('text-gray-400', !shuffleOn);
            }
            if (repeatBtn) {
                repeatBtn.classList.toggle('text-red-500', repeatOn);
                repeatBtn.classList.toggle('text-gray-400', !repeatOn);
            }
            const dot = document.getElementById('shuffle-dot');
            if (dot) dot.classList.toggle('hidden', !shuffleOn);
            const fpShuffle = document.getElementById('fp-btn-shuffle');
            const fpRepeat = document.getElementById('fp-btn-repeat');
            if (fpShuffle) {
                fpShuffle.classList.toggle('is-active', shuffleOn);
                fpShuffle.setAttribute('aria-pressed', String(shuffleOn));
            }
            if (fpRepeat) {
                fpRepeat.classList.toggle('is-active', repeatOn);
                fpRepeat.setAttribute('aria-pressed', String(repeatOn));
            }
            ['repeat-badge', 'fp-repeat-badge'].forEach(id => {
                const badge = document.getElementById(id);
                if (badge) badge.classList.toggle('hidden', this.repeatMode !== 2);
            });
        },

        updatePlayPauseIcon(isPlaying) {    
            [['play-icon', 'pause-icon'], ['fp-play-icon', 'fp-pause-icon']].forEach(([playId, pauseId]) => {
                const play = document.getElementById(playId);
                const pause = document.getElementById(pauseId);
                if (play) play.classList.toggle('hidden', isPlaying);
                if (pause) pause.classList.toggle('hidden', !isPlaying);
            });
        },    
  
        formatTime(seconds) {    
            if (isNaN(seconds)) return "0:00";    
            const m = Math.floor(seconds / 60);    
            const s = Math.floor(seconds % 60);    
            return `${m}:${s < 10 ? '0' : ''}${s}`;    
        },    
  
        switchTab(tabId) {    
            this.activeTab = tabId;    
            if (tabId === 'library' || tabId === 'search') {    
                this.viewingPlaylistId = null;     
            }    
  
            document.querySelectorAll('main > section').forEach(el => el.classList.add('hidden'));    
            document.getElementById(`tab-${tabId}`).classList.remove('hidden');    
                
            ['search', 'library', 'settings'].forEach(id => {    
                const btnD = document.getElementById(`nav-${id}`);    
                const btnM = document.getElementById(`mob-nav-${id}`);    
                if(btnD) { btnD.classList.remove('bg-gray-900', 'text-white'); }    
                if(btnM) { btnM.classList.remove('text-red-500'); btnM.classList.add('text-gray-500'); }    
                    
                if (id === tabId) {    
                    if(btnD) btnD.classList.add('bg-gray-900', 'text-white');    
                    if(btnM) { btnM.classList.remove('text-gray-500'); btnM.classList.add('text-red-500'); }    
                }    
            });    
  
            if (tabId === 'library') {    
                this.renderLibrary();    
                this.renderPlaylistsGrid();    
            }    
            if (tabId === 'search') {    
                this.renderSearch(document.getElementById('search-input').value);    
            }    
            window.scrollTo(0, 0);    
        },    
  
        renderAll() {    
            if(this.activeTab === 'library') {    
                this.renderPlaylistsGrid();    
                this.renderLibrary();    
            } else if (this.activeTab === 'search') {    
                this.renderSearch(document.getElementById('search-input').value);    
            } else if (this.activeTab === 'playlist-view' && this.viewingPlaylistId) {    
                this.openPlaylist(this.viewingPlaylistId);    
            }    
        },    
  
        createTrackElement(track, contextQueue, index, playlistId = null) {    
            const el = document.createElement('div');    
            el.className = `flex items-center justify-between p-2 md:p-3 bg-gray-900/40 hover:bg-gray-800 rounded-xl group track-item cursor-pointer mb-1 border border-transparent hover:border-gray-700 transition`;    
            el.dataset.id = track.id;    
                
            el.onclick = (e) => {    
                if (e.target.closest('button')) return;    
                this.setQueueAndPlay(contextQueue, index, playlistId);    
            };    
  
            const infoDiv = document.createElement('div');    
            infoDiv.className = 'flex items-center flex-1 min-w-0 mr-4';    
                
            const artDiv = document.createElement('div');    
            artDiv.className = 'w-10 h-10 md:w-12 md:h-12 bg-gray-800 rounded flex items-center justify-center shrink-0 mr-3 shadow overflow-hidden relative';    
            if (track.cover) {    
                artDiv.innerHTML = `<img src="${track.cover}" class="w-full h-full object-cover">`;    
            } else {    
                artDiv.innerHTML = `<svg class="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z"/></svg>`;    
            }    
                
            const titleDiv = document.createElement('div');    
            titleDiv.className = 'font-semibold text-sm md:text-base truncate text-gray-200 group-hover:text-white transition';    
            titleDiv.textContent = track.name;    
  
            if (playlistId) {
                const numBtn = document.createElement('button');
                numBtn.className = 'shrink-0 min-w-[1.75rem] h-7 px-1.5 mr-2 rounded-md border border-gray-700 text-[11px] font-bold text-gray-400 hover:text-white hover:border-red-500 transition';
                numBtn.textContent = index + 1;
                numBtn.onclick = (e) => { e.stopPropagation(); this.showMoveTrackModal(playlistId, track.id); };
                infoDiv.appendChild(numBtn);
            }
            infoDiv.appendChild(artDiv);    
            infoDiv.appendChild(titleDiv);    
  
            const actionsDiv = document.createElement('div');    
            actionsDiv.className = 'flex items-center gap-1 opacity-100 md:opacity-0 group-hover:opacity-100 transition shrink-0';    
  
            const editBtn = document.createElement('button');    
            editBtn.className = 'text-gray-400 hover:text-white p-2 rounded-full hover:bg-gray-700 transition';    
            editBtn.innerHTML = '<svg class="w-4 h-4 md:w-5 md:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>';    
            editBtn.onclick = (e) => { e.stopPropagation(); this.openEditTrackModal(track); };    
            actionsDiv.appendChild(editBtn);    
  
            if (playlistId) {    
                const dragBtn = document.createElement('button');
                dragBtn.className = 'drag-handle text-gray-400 hover:text-white p-2 rounded-full hover:bg-gray-700 transition';
                dragBtn.innerHTML = '<svg class="w-4 h-4 md:w-5 md:h-5" fill="currentColor" viewBox="0 0 24 24"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';
                dragBtn.addEventListener('pointerdown', (e) => this.startTrackDrag(e, el, playlistId));
                dragBtn.addEventListener('contextmenu', (e) => e.preventDefault());
                actionsDiv.insertBefore(dragBtn, actionsDiv.firstChild);

                const removeBtn = document.createElement('button');    
                removeBtn.className = 'text-gray-400 hover:text-red-500 p-2 rounded-full hover:bg-gray-700 transition';    
                removeBtn.innerHTML = '<svg class="w-4 h-4 md:w-5 md:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>';    
                removeBtn.onclick = (e) => {    
                    e.stopPropagation();    
                    this.removeFromPlaylist(playlistId, index);    
                };    
                actionsDiv.appendChild(removeBtn);    
            } else {    
                const addBtn = document.createElement('button');    
                addBtn.className = 'text-gray-400 hover:text-white p-2 rounded-full hover:bg-gray-700 transition';    
                addBtn.innerHTML = '<svg class="w-4 h-4 md:w-5 md:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>';    
                addBtn.onclick = (e) => { e.stopPropagation(); this.showAddToPlaylistModal(track.id); };    
                actionsDiv.appendChild(addBtn);    
  
                const deleteBtn = document.createElement('button');    
                deleteBtn.className = 'text-gray-400 hover:text-red-500 p-2 rounded-full hover:bg-gray-700 transition';    
                deleteBtn.innerHTML = '<svg class="w-4 h-4 md:w-5 md:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>';    
                deleteBtn.onclick = (e) => { e.stopPropagation(); this.showDeleteConfirm('track', track.id); };    
                actionsDiv.appendChild(deleteBtn);    
            }    
  
            el.appendChild(infoDiv);    
            el.appendChild(actionsDiv);    
            return el;    
        },    
  
        updateLibraryCount() {
            const badge = document.getElementById('library-track-count');
            if (badge) badge.textContent = this.formatTrackCount(this.tracks.length);
        },

        renderLibrary() {
            this.updateLibraryCount();    
            const list = document.getElementById('all-tracks-list');    
            list.innerHTML = '';    
            if (this.tracks.length === 0) {    
                list.innerHTML = `<div class="text-gray-500 bg-gray-900/50 p-6 rounded-lg text-center border border-gray-800">${this.t("Нет добавленных треков.")}</div>`;    
                return;    
            }    
            const revTracks = [...this.tracks].reverse();    
            revTracks.forEach((track, idx) => list.appendChild(this.createTrackElement(track, revTracks, idx)));    
            this.highlightCurrentTrack();    
        },    
            
        playAllTracksShuffled() {    
            if (this.tracks.length === 0) return;    
            if (!this.isShuffle) this.toggleShuffle();    
            this.setQueueAndPlay([...this.tracks].reverse(), 0);    
        },    
  
        renderSearch(query) {    
            const list = document.getElementById('search-results');    
            list.innerHTML = '';    
            const q = query.toLowerCase().trim();    
            if (!q) {    
                list.innerHTML = `<div class="text-gray-500">${this.t("Начните вводить название...")}</div>`;    
                return;    
            }    
            const results = this.tracks.filter(t => t.name.toLowerCase().includes(q));    
            if (results.length === 0) {    
                list.innerHTML = `<div class="text-gray-500">${this.t("Ничего не найдено.")}</div>`;    
                return;    
            }    
            results.forEach((track, idx) => list.appendChild(this.createTrackElement(track, results, idx)));    
            this.highlightCurrentTrack();    
        },    
  
        renderPlaylistsGrid() {    
            const grid = document.getElementById('playlists-grid');    
            grid.innerHTML = '';    
            if (this.playlists.length === 0) {    
                grid.innerHTML = `<div class="col-span-full text-gray-500 text-sm">${this.t("У вас пока нет плейлистов.")}</div>`;    
                return;    
            }    
  
            this.playlists.forEach(playlist => {    
                const card = document.createElement('div');    
                card.className = 'bg-gray-900 border border-gray-800 p-3 rounded-xl hover:bg-gray-800 transition cursor-pointer group flex flex-col shadow-lg hover:border-gray-600';    
                card.onclick = () => this.openPlaylist(playlist.id);    
                    
                const art = document.createElement('div');    
                art.className = 'w-full aspect-square bg-gray-800 rounded-lg mb-3 flex items-center justify-center shadow-inner overflow-hidden';    
                    
                if (playlist.cover) {    
                    art.innerHTML = `<img src="${playlist.cover}" class="w-full h-full object-cover">`;    
                } else if (playlist.tracks.length > 0) {    
                    const firstTrack = this.tracks.find(t => t.id === playlist.tracks[0]);    
                    if (firstTrack && firstTrack.cover) {    
                        art.innerHTML = `<img src="${firstTrack.cover}" class="w-full h-full object-cover">`;    
                    } else {    
                        art.innerHTML = '<svg class="w-10 h-10 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z"/></svg>';    
                    }    
                } else {    
                    art.innerHTML = '<svg class="w-10 h-10 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z"/></svg>';    
                }    
                    
                const title = document.createElement('div');    
                title.className = 'font-bold text-white truncate text-sm';    
                title.textContent = playlist.name;    
                    
                const count = document.createElement('div');    
                count.className = 'text-xs text-gray-400 mt-1';    
                count.textContent = this.formatTrackCount(playlist.tracks.length);    
  
                card.appendChild(art);    
                card.appendChild(title);    
                card.appendChild(count);    
                grid.appendChild(card);    
            });    
        },    
  
        openPlaylist(id) {    
            const playlist = this.playlists.find(p => p.id === id);    
            if (!playlist) return;    
  
            this.viewingPlaylistId = id;    
            this.activeTab = 'playlist-view';    
                
            document.getElementById('current-playlist-title').textContent = playlist.name;    
            document.getElementById('current-playlist-count').textContent = this.formatTrackCount(playlist.tracks.length);    
                
            const coverImg = document.getElementById('playlist-cover-img');    
            const coverPlace = document.getElementById('playlist-cover-placeholder');    
                
            let displayCover = playlist.cover;    
            if (!displayCover && playlist.tracks.length > 0) {    
                const firstTrack = this.tracks.find(t => t.id === playlist.tracks[0]);    
                if (firstTrack) displayCover = firstTrack.cover;    
            }    
  
            if (displayCover) {    
                coverImg.src = displayCover;    
                coverImg.classList.remove('hidden');    
                coverPlace.classList.add('hidden');    
            } else {    
                coverImg.classList.add('hidden');    
                coverPlace.classList.remove('hidden');    
            }    
  
            const playlistTracks = playlist.tracks.map(trackId => this.tracks.find(t => t.id === trackId)).filter(Boolean);
            document.getElementById('playlist-reorder-hint').classList.toggle('hidden', playlistTracks.length < 2);    
  
            document.getElementById('play-playlist-btn').onclick = () => {    
                if(playlistTracks.length > 0) {    
                    if (this.isShuffle) this.toggleShuffle();    
                    this.setQueueAndPlay(playlistTracks, 0, playlist.id);    
                }    
            };    
            document.getElementById('shuffle-playlist-btn').onclick = () => {    
                if(playlistTracks.length > 0) {    
                    if (!this.isShuffle) this.toggleShuffle();    
                    this.setQueueAndPlay(playlistTracks, 0, playlist.id);    
                }    
            };    
  
            const list = document.getElementById('playlist-tracks-list');    
            list.innerHTML = '';    
            if (playlistTracks.length === 0) {    
                list.innerHTML = `<div class="text-gray-500 mt-4">${this.t("Плейлист пуст. Добавьте треки из медиатеки.")}</div>`;    
            } else {    
                playlistTracks.forEach((track, idx) => list.appendChild(this.createTrackElement(track, playlistTracks, idx, playlist.id)));    
            }    
  
            document.querySelectorAll('main > section').forEach(el => el.classList.add('hidden'));    
            document.getElementById('tab-playlist-view').classList.remove('hidden');    
            this.highlightCurrentTrack();    
        },    
  
        renameCurrentPlaylist() {    
            const playlist = this.playlists.find(p => p.id === this.viewingPlaylistId);    
            if (!playlist) return;    
            document.getElementById('rename-playlist-input').value = playlist.name;  
            document.getElementById('rename-playlist-modal').classList.remove('hidden');  
            document.getElementById('rename-playlist-input').focus();  
        },    
  
        async savePlaylistRename() {  
            const playlist = this.playlists.find(p => p.id === this.viewingPlaylistId);    
            if (!playlist) return;  
            const newName = document.getElementById('rename-playlist-input').value.trim();  
            if (newName && newName !== "") {    
                playlist.name = newName;    
                await DB.updatePlaylist(playlist);    
                await this.loadData();    
                this.openPlaylist(playlist.id);    
                this.showToast(this.t("Название изменено"));    
            }  
            this.closeModals();  
        },  
  
        changePlaylistCover(e) {    
            const file = e.target.files[0];    
            if (!file) return;    
            const reader = new FileReader();    
            reader.onload = async (event) => {    
                const playlist = this.playlists.find(p => p.id === this.viewingPlaylistId);    
                if (playlist) {    
                    playlist.cover = event.target.result;    
                    await DB.updatePlaylist(playlist);    
                    await this.loadData();    
                    this.openPlaylist(playlist.id);    
                    this.showToast(this.t("Обложка плейлиста обновлена"));    
                }    
            };    
            reader.readAsDataURL(file);    
        },    
  
        openEditTrackModal(track) {    
            this.editingTrackId = track.id;    
            this.tempCoverDataUrl = track.cover;    
                
            document.getElementById('track-name-input').value = track.name;    
            const coverImg = document.getElementById('edit-track-cover');    
            const placeholder = document.getElementById('edit-track-placeholder');    
                
            if (track.cover) {    
                coverImg.src = track.cover;    
                coverImg.classList.remove('hidden');    
                placeholder.classList.add('hidden');    
            } else {    
                coverImg.classList.add('hidden');    
                placeholder.classList.remove('hidden');    
            }    
                
            document.getElementById('edit-track-modal').classList.remove('hidden');    
        },    
  
        changeTrackCover(e) {    
            const file = e.target.files[0];    
            if (!file) return;    
            const reader = new FileReader();    
            reader.onload = (event) => {    
                this.tempCoverDataUrl = event.target.result;    
                const coverImg = document.getElementById('edit-track-cover');    
                coverImg.src = this.tempCoverDataUrl;    
                coverImg.classList.remove('hidden');    
                document.getElementById('edit-track-placeholder').classList.add('hidden');    
            };    
            reader.readAsDataURL(file);    
        },    
  
        async saveTrackEdit() {    
            if (!this.editingTrackId) return;    
            const track = this.tracks.find(t => t.id === this.editingTrackId);    
            if (!track) return;    
  
            const newName = document.getElementById('track-name-input').value.trim();    
            if (newName) track.name = newName;    
            track.cover = this.tempCoverDataUrl;    
  
            await DB.updateTrack(track);
            if (ALTYNative.available()) ALTYNative.updateTrack(track.id, track.name, '');
            await this.loadData();    
            this.closeModals();    
            this.renderAll();    
                
            const current = this.getCurrentTrack();
            if (current && current.id === track.id) this.updatePlayerUI(current);
            this.showToast(this.t("Изменения сохранены"));    
        },    
  
        showDeleteConfirm(type, id = null) {    
            this.deleteTarget = { type, id };    
            document.getElementById('confirm-delete-modal').classList.remove('hidden');    
        },    
  
        async executeDelete() {    
            if (!this.deleteTarget) return;    
                
            if (this.deleteTarget.type === 'track') {    
                const deletedTrack = this.tracks.find(t => t.id === this.deleteTarget.id);
                if (ALTYNative.available()) ALTYNative.deleteTrack(this.deleteTarget.id);
                await DB.deleteTrack(this.deleteTarget.id);    
                for (let p of this.playlists) {    
                    if (p.tracks.includes(this.deleteTarget.id)) {    
                        p.tracks = p.tracks.filter(tid => tid !== this.deleteTarget.id);    
                        await DB.updatePlaylist(p);    
                    }    
                }    
                await this.loadData();    
                this.closeModals();    
                this.renderAll();    
                this.showToast(this.t("Трек удален"));    
            }     
            else if (this.deleteTarget.type === 'playlist') {    
                await DB.deletePlaylist(this.viewingPlaylistId);    
                await this.loadData();    
                this.closeModals();    
                this.switchTab('library');    
                this.showToast(this.t("Плейлист удален"));    
            }    
            this.deleteTarget = null;    
        },    
  
        showCreatePlaylistModal() {    
            document.getElementById('playlist-name-input').value = '';    
            document.getElementById('create-playlist-modal').classList.remove('hidden');    
            document.getElementById('playlist-name-input').focus();    
        },    
  
        async createPlaylist() {    
            const name = document.getElementById('playlist-name-input').value.trim();    
            if (!name) return;    
            await DB.addPlaylist(name);    
            await this.loadData();    
            this.closeModals();    
            this.renderPlaylistsGrid();    
            this.showToast(this.t("Плейлист создан"));    
        },    
  
        showAddToPlaylistModal(trackId) {    
            this.trackToAddToPlaylist = trackId;    
            const optionsContainer = document.getElementById('playlist-options');    
            optionsContainer.innerHTML = '';    
  
            if (this.playlists.length === 0) {    
                optionsContainer.innerHTML = `<div class="text-gray-400 bg-gray-800 p-4 rounded text-sm text-center">${this.t("Нет плейлистов")}</div>`;    
            } else {    
                this.playlists.forEach(p => {    
                    const btn = document.createElement('button');    
                    btn.className = 'w-full text-left p-4 hover:bg-gray-800 rounded-lg border border-gray-700 bg-gray-800/50 mb-2 transition font-semibold text-white';    
                    btn.textContent = p.name;    
                    btn.onclick = () => this.addTrackToPlaylist(p.id);    
                    optionsContainer.appendChild(btn);    
                });    
            }    
            document.getElementById('add-to-playlist-modal').classList.remove('hidden');    
        },    
  
        async addTrackToPlaylist(playlistId) {    
            if (!this.trackToAddToPlaylist) return;    
            const playlist = this.playlists.find(p => p.id === playlistId);    
            if (playlist) {    
                if(!playlist.tracks.includes(this.trackToAddToPlaylist)) {    
                    playlist.tracks.push(this.trackToAddToPlaylist);    
                    await DB.updatePlaylist(playlist);    
                    await this.loadData();    
                    this.renderAll();    
                    this.showToast(this.t("Трек добавлен"));    
                } else {    
                    this.showToast(this.t("Трек уже в плейлисте"));    
                }    
                this.closeModals();    
            }    
        },    
  
        getPlaylistTracks(playlist) {
            return playlist.tracks.map(id => this.tracks.find(t => t.id === id)).filter(Boolean);
        },

        // Если сейчас играет этот плейлист, очередь воспроизведения подстраивается под новый порядок
        syncQueueWithPlaylist(playlist) {
            if (this.queueSourcePlaylistId !== playlist.id || this.playbackQueue.length === 0) return;
            const ordered = this.getPlaylistTracks(playlist);
            const current = this.playbackQueue[this.currentIndex];
            this.originalQueue = [...ordered];

            if (ordered.length === 0) {
                this.playbackQueue = [];
                this.currentIndex = -1;
                ALTYNative.setQueue([], 0, false, this.repeatMode);
                return;
            }

            if (!this.isShuffle) {
                this.playbackQueue = [...ordered];
                const newIndex = current ? this.playbackQueue.findIndex(t => t.id === current.id) : -1;
                if (newIndex >= 0) {
                    this.currentIndex = newIndex;
                    ALTYNative.setQueue(this.playbackQueue.map(t => Number(t.id)), this.currentIndex, false, this.repeatMode);
                } else {
                    this.currentIndex = Math.min(Math.max(0, this.currentIndex), this.playbackQueue.length - 1);
                    ALTYNative.playQueue(this.playbackQueue.map(t => Number(t.id)), this.currentIndex, false, this.repeatMode);
                }
                return;
            }

            const currentId = current ? Number(current.id) : -1;
            const stillThere = ordered.some(t => Number(t.id) === currentId);
            if (stillThere) {
                const rest = ordered.filter(t => Number(t.id) !== currentId);
                this.playbackQueue = [ordered.find(t => Number(t.id) === currentId), ...this.shuffleArray(rest)];
                this.currentIndex = 0;
                ALTYNative.setQueue(this.playbackQueue.map(t => Number(t.id)), this.currentIndex, true, this.repeatMode);
            } else {
                this.playbackQueue = [...ordered];
                this.currentIndex = 0;
                ALTYNative.playQueue(this.playbackQueue.map(t => Number(t.id)), this.currentIndex, true, this.repeatMode);
            }
        },

        // Переставляет трек fromId на место, где сейчас стоит трек toId
        async movePlaylistTrack(playlistId, fromId, toId) {
            const playlist = this.playlists.find(p => p.id === playlistId);
            if (!playlist) return;
            const from = playlist.tracks.indexOf(fromId);
            const to = playlist.tracks.indexOf(toId);
            if (from < 0 || to < 0 || from === to) return;
            const [moved] = playlist.tracks.splice(from, 1);
            playlist.tracks.splice(to, 0, moved);
            this.syncQueueWithPlaylist(playlist);
            this.openPlaylist(playlistId);
            try {
                await DB.updatePlaylist(playlist);
            } catch (err) {
                await this.loadData();
                this.openPlaylist(playlistId);
                this.showToast(this.t("Ошибка базы данных"));
            }
        },

        showMoveTrackModal(playlistId, trackId) {
            const playlist = this.playlists.find(p => p.id === playlistId);
            if (!playlist) return;
            const ordered = this.getPlaylistTracks(playlist);
            const pos = ordered.findIndex(t => t.id === trackId);
            if (pos < 0) return;
            this.movingTrack = { playlistId, trackId };
            document.getElementById('move-track-name').textContent = ordered[pos].name;
            document.getElementById('move-track-range').textContent = `(1–${ordered.length})`;
            const input = document.getElementById('move-track-input');
            input.max = ordered.length;
            input.value = pos + 1;
            document.getElementById('move-track-modal').classList.remove('hidden');
            input.focus();
            input.select();
        },

        async saveTrackMove() {
            if (!this.movingTrack) return;
            const { playlistId, trackId } = this.movingTrack;
            const playlist = this.playlists.find(p => p.id === playlistId);
            if (!playlist) { this.closeModals(); return; }
            const ordered = this.getPlaylistTracks(playlist);
            let pos = parseInt(document.getElementById('move-track-input').value, 10);
            if (isNaN(pos)) return;
            pos = Math.max(1, Math.min(ordered.length, pos));
            const target = ordered[pos - 1];
            this.closeModals();
            if (target && target.id !== trackId) {
                await this.movePlaylistTrack(playlistId, trackId, target.id);
                this.showToast(this.t("Порядок изменён"));
            }
        },

        startTrackDrag(e, rowEl, playlistId) {
            if (this._drag) return;
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            const list = document.getElementById('playlist-tracks-list');
            const rows = Array.from(list.querySelectorAll('.track-item'));
            const n = rows.length;
            const fromIdx = rows.indexOf(rowEl);
            if (n < 2 || fromIdx < 0) return;
            const step = rows[1].offsetTop - rows[0].offsetTop;
            if (step <= 0) return;
            e.preventDefault();
            e.stopPropagation();

            const scroller = document.getElementById('main-content');
            const player = document.getElementById('bottom-player');
            const pointerId = e.pointerId;
            const startY = e.clientY;
            const startScroll = scroller.scrollTop;
            let lastY = e.clientY;
            let prevY = e.clientY;
            let dir = 0;
            let moved = false;
            let newIdx = fromIdx;
            let rafId = null;

            this._drag = true;
            rowEl.classList.add('dragging-row');
            list.classList.add('is-dragging');

            const update = () => {
                const dy = (lastY - startY) + (scroller.scrollTop - startScroll);
                const clamped = Math.max(-fromIdx * step, Math.min((n - 1 - fromIdx) * step, dy));
                rowEl.style.transform = `translateY(${clamped}px)`;
                newIdx = Math.max(0, Math.min(n - 1, fromIdx + Math.round(clamped / step)));
                rows.forEach((r, i) => {
                    if (r === rowEl) return;
                    let shift = 0;
                    if (fromIdx < newIdx && i > fromIdx && i <= newIdx) shift = -step;
                    else if (fromIdx > newIdx && i >= newIdx && i < fromIdx) shift = step;
                    r.style.transform = shift ? `translateY(${shift}px)` : '';
                });
            };

            const tick = () => {
                const rect = scroller.getBoundingClientRect();
                const bottomEdge = Math.min(rect.bottom, player ? player.getBoundingClientRect().top : rect.bottom);
                const zone = 70;
                let v = 0;
                if (moved && lastY < rect.top + zone && dir <= 0) v = -(rect.top + zone - lastY) / 5;
                else if (moved && lastY > bottomEdge - zone && dir >= 0) v = (lastY - (bottomEdge - zone)) / 5;
                v = Math.max(-22, Math.min(22, v));
                if (Math.abs(v) >= 1) {
                    scroller.scrollTop += v;
                    update();
                }
                rafId = requestAnimationFrame(tick);
            };

            const onMove = (ev) => {
                if (ev.pointerId !== pointerId) return;
                lastY = ev.clientY;
                if (Math.abs(lastY - startY) > 6) moved = true;
                if (Math.abs(lastY - prevY) >= 2) { dir = lastY > prevY ? 1 : -1; prevY = lastY; }
                update();
            };
            const end = (cancelled) => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                window.removeEventListener('pointercancel', onCancel);
                cancelAnimationFrame(rafId);
                this._drag = null;
                list.classList.remove('is-dragging');
                if (!cancelled && newIdx !== fromIdx) {
                    const ids = rows.map(r => parseInt(r.dataset.id, 10));
                    this.movePlaylistTrack(playlistId, ids[fromIdx], ids[newIdx]);
                }
                if (rowEl.isConnected) {
                    rowEl.classList.remove('dragging-row');
                    rows.forEach(r => { r.style.transform = ''; });
                }
            };
            const onUp = (ev) => { if (ev.pointerId === pointerId) end(false); };
            const onCancel = (ev) => { if (ev.pointerId === pointerId) end(true); };

            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            window.addEventListener('pointercancel', onCancel);
            rafId = requestAnimationFrame(tick);
        },

        async removeFromPlaylist(playlistId, trackIndexInArray) {    
            const playlist = this.playlists.find(p => p.id === playlistId);    
            if (playlist) {    
                playlist.tracks.splice(trackIndexInArray, 1);    
                await DB.updatePlaylist(playlist);    
                await this.loadData();    
                this.openPlaylist(playlistId);    
                this.renderPlaylistsGrid();    
            }    
        },    
  
        showSupportModal() {    
            document.getElementById('support-modal').classList.remove('hidden');    
        },    
  
        closeModals() {    
            ['create-playlist-modal', 'rename-playlist-modal', 'add-to-playlist-modal', 'edit-track-modal', 'confirm-delete-modal', 'support-modal', 'move-track-modal'].forEach(id => {    
                document.getElementById(id).classList.add('hidden');    
            });    
            this.trackToAddToPlaylist = null;    
            this.editingTrackId = null;    
            this.tempCoverDataUrl = null;
            this.movingTrack = null;    
            this.deleteTarget = null;    
        },    
  
        highlightCurrentTrack() {    
            document.querySelectorAll('.track-item').forEach(el => {    
                el.classList.remove('text-red-500', 'border-red-500/50');    
                if (this.playbackQueue.length > 0 && this.currentIndex !== -1) {    
                   if(parseInt(el.dataset.id) === this.playbackQueue[this.currentIndex].id) {    
                       el.classList.add('text-red-500', 'border-red-500/50');    
                   }    
                }    
            });    
        },    
  
        showToast(msg) {    
            const container = document.getElementById('toast-container');    
            const toast = document.createElement('div');    
            toast.className = 'bg-gray-800 text-white px-6 py-3 rounded-full shadow-2xl text-sm font-bold toast-enter border border-gray-700 pointer-events-auto';    
            toast.textContent = msg;    
            container.appendChild(toast);    
            setTimeout(() => {    
                toast.style.opacity = '0';    
                toast.style.transform = 'translateY(20px)';    
                toast.style.transition = 'all 0.3s ease';    
                setTimeout(() => toast.remove(), 300);    
            }, 3000);    
        }    
    };    
  
      

    window.app = app;

    document.getElementById('confirm-delete-btn').addEventListener('click', () => app.executeDelete());
    window.addEventListener('beforeunload', () => {
        if (app.nativeStateTimer) {
            clearInterval(app.nativeStateTimer);
            app.nativeStateTimer = null;
        }
    });
    window.addEventListener('DOMContentLoaded', () => app.init());
