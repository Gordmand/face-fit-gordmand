// Хранилище фото пользователя.
//   - сам файл (Blob) → IndexedDB (у chrome.storage.local жёсткая квота ~10 МБ);
//   - метаданные (размеры, 5 опорных точек, дата) → chrome.storage.local.
// Всё только на устройстве пользователя, наружу ничего не уходит.

const DB_NAME = "face-fit";
const DB_VERSION = 1;
const STORE = "assets";
const PHOTO_KEY = "userPhoto";
const META_KEY = "userPhotoMeta";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function idbSet(key, value) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, "readwrite");
        t.objectStore(STORE).put(value, key);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

function idbGet(key) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const req = tx(db, "readonly").get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      }),
  );
}

function idbDelete(key) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, "readwrite");
        t.objectStore(STORE).delete(key);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      }),
  );
}

/**
 * @param {Blob} blob исходный файл фото
 * @param {object} meta { width, height, type, size, fivePoints }
 */
export async function saveUserPhoto(blob, meta) {
  await idbSet(PHOTO_KEY, blob);
  await chrome.storage.local.set({
    [META_KEY]: { ...meta, savedAt: Date.now() },
  });
}

/** @returns {Promise<Blob|null>} */
export function getUserPhotoBlob() {
  return idbGet(PHOTO_KEY);
}

/** @returns {Promise<object|null>} */
export async function getUserPhotoMeta() {
  const res = await chrome.storage.local.get(META_KEY);
  return res[META_KEY] ?? null;
}

export async function clearUserPhoto() {
  await idbDelete(PHOTO_KEY);
  await chrome.storage.local.remove(META_KEY);
}
