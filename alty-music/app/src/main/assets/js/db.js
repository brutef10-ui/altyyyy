const dbName = 'MyMusicDB_v4';
const dbVersion = 1;
let db;

const initDB = () => new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, dbVersion);
    request.onupgradeneeded = (event) => {
        db = event.target.result;
        if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'id', autoIncrement: true });
        if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id', autoIncrement: true });
    };
    request.onsuccess = (event) => { db = event.target.result; resolve(db); };
    request.onerror = (event) => reject(event.target.error || new Error('IndexedDB error'));
});

const DB = {
    addTrack(trackData) {
        return new Promise((resolve, reject) => {
            const req = db.transaction(['tracks'], 'readwrite').objectStore('tracks').add(trackData);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('Track insert failed'));
        });
    },
    updateTrack(track) {
        return new Promise((resolve, reject) => {
            const req = db.transaction(['tracks'], 'readwrite').objectStore('tracks').put(track);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error || new Error('Track update failed'));
        });
    },
    getAllTracks() {
        return new Promise((resolve, reject) => {
            const req = db.transaction(['tracks'], 'readonly').objectStore('tracks').getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error || new Error('Track read failed'));
        });
    },
    deleteTrack(id) {
        return new Promise((resolve, reject) => {
            const req = db.transaction(['tracks'], 'readwrite').objectStore('tracks').delete(id);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error || new Error('Track delete failed'));
        });
    },
    addPlaylist(name) {
        return new Promise((resolve, reject) => {
            const req = db.transaction(['playlists'], 'readwrite').objectStore('playlists').add({ name, tracks: [], cover: null });
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('Playlist insert failed'));
        });
    },
    getAllPlaylists() {
        return new Promise((resolve, reject) => {
            const req = db.transaction(['playlists'], 'readonly').objectStore('playlists').getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error || new Error('Playlist read failed'));
        });
    },
    updatePlaylist(playlist) {
        return new Promise((resolve, reject) => {
            const req = db.transaction(['playlists'], 'readwrite').objectStore('playlists').put(playlist);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error || new Error('Playlist update failed'));
        });
    },
    deletePlaylist(id) {
        return new Promise((resolve, reject) => {
            const req = db.transaction(['playlists'], 'readwrite').objectStore('playlists').delete(id);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error || new Error('Playlist delete failed'));
        });
    }
};
