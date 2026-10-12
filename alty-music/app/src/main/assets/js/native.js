window.ALTYNative = {
    available() {
        try { return !!window.AndroidBridge && AndroidBridge.isAvailable && AndroidBridge.isAvailable(); }
        catch (e) { return false; }
    },
    consumeImports() {
        if (!this.available()) return [];
        try {
            const raw = AndroidBridge.consumePendingAudioImports();
            return JSON.parse(raw || '[]');
        } catch (e) { return []; }
    },
    registerTrack(id, name, nativePath, coverDataUrl) {
        if (!this.available()) return false;
        try { return !!AndroidBridge.registerTrack(String(id), name || '', nativePath || '', coverDataUrl || ''); }
        catch (e) { return false; }
    },
    updateTrack(id, name, coverDataUrl) {
        if (!this.available()) return;
        try { AndroidBridge.updateTrack(String(id), name || '', coverDataUrl || ''); } catch (e) {}
    },
    deleteTrack(id) {
        if (!this.available()) return;
        try { AndroidBridge.deleteTrack(String(id)); } catch (e) {}
    },
    setQueue(ids, index, shuffle, repeatMode) {
        if (!this.available()) return;
        try { AndroidBridge.setQueue(JSON.stringify(ids || []), Number(index) || 0, !!shuffle, Number(repeatMode) || 0); } catch (e) {}
    },
    playQueue(ids, index, shuffle, repeatMode) {
        if (!this.available()) return;
        try { AndroidBridge.playQueue(JSON.stringify(ids || []), Number(index) || 0, !!shuffle, Number(repeatMode) || 0); } catch (e) {}
    },
    play() { if (this.available()) try { AndroidBridge.play(); } catch (e) {} },
    pause() { if (this.available()) try { AndroidBridge.pause(); } catch (e) {} },
    next() { if (this.available()) try { AndroidBridge.next(); } catch (e) {} },
    previous() { if (this.available()) try { AndroidBridge.previous(); } catch (e) {} },
    stop() { if (this.available()) try { AndroidBridge.stop(); } catch (e) {} },
    seekTo(ms) { if (this.available()) try { AndroidBridge.seekTo(Math.max(0, Math.round(ms || 0))); } catch (e) {} },
    setVolume(value) { if (this.available()) try { AndroidBridge.setVolume(Number(value) || 0); } catch (e) {} },
    setRepeat(mode) { if (this.available()) try { AndroidBridge.setRepeat(Number(mode) || 0); } catch (e) {} },
    getState() {
        if (!this.available()) return null;
        try { return JSON.parse(AndroidBridge.getState() || 'null'); } catch (e) { return null; }
    }
};

window.altyNativeState = function(stateJson) {
    try {
        const state = typeof stateJson === 'string' ? JSON.parse(stateJson) : stateJson;
        if (window.app && typeof window.app.handleNativeState === 'function') window.app.handleNativeState(state);
    } catch (e) {
        console.error('ALTY native state error', e);
    }
};
