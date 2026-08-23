/**
 * Persistent thumbnail cache backed by IndexedDB.
 *
 * JPEG Blobs are stored directly, avoiding LocalStorage's small quota and the
 * Base64 size expansion. Records are origin-scoped, expire after 30 days, and
 * are trimmed by least-recent access to a maximum of 500 entries.
 */

const DATABASE_NAME = "local-video-thumbnail-cache";
const DATABASE_VERSION = 1;
const STORE_NAME = "thumbnails";
const MAX_ENTRIES = 500;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", resolve, { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error), { once: true });
  });
}

/** Open the cache once. Failures degrade to an in-memory-only preview session. */
function openDatabase() {
  if (!("indexedDB" in window)) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      const store = database.createObjectStore(STORE_NAME, { keyPath: "url" });
      store.createIndex("accessedAt", "accessedAt");
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
    request.addEventListener("blocked", () => reject(new Error("缩略图缓存数据库被其他页面占用")), { once: true });
  });
}

export class ThumbnailCache {
  constructor() {
    this.databasePromise = openDatabase().catch(() => null);
    this.writeCount = 0;
    this.trimRunning = false;
  }

  /**
   * Return a cached Blob without touching the remote video. Expired or invalid
   * records are deleted and treated as misses.
   */
  async get(url) {
    try {
      const database = await this.databasePromise;
      if (!database) return null;
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore(STORE_NAME);
      const record = await requestResult(store.get(url));

      if (!record || !(record.blob instanceof Blob)) {
        await done;
        return null;
      }

      if (Date.now() - record.createdAt > MAX_AGE_MS) {
        store.delete(url);
        await done;
        return null;
      }

      record.accessedAt = Date.now();
      store.put(record);
      await done;
      return {
        blob: record.blob,
        duration: record.duration,
        capturedAt: record.capturedAt,
        fromCache: true,
      };
    } catch {
      return null;
    }
  }

  /** Store one generated JPEG Blob; cache errors never block card rendering. */
  async put(url, result) {
    if (!(result?.blob instanceof Blob)) return;

    try {
      const database = await this.databasePromise;
      if (!database) return;
      const now = Date.now();
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore(STORE_NAME).put({
        url,
        blob: result.blob,
        duration: result.duration,
        capturedAt: result.capturedAt,
        createdAt: now,
        accessedAt: now,
      });
      await done;

      this.writeCount += 1;
      if (this.writeCount % 25 === 0) this.trim();
    } catch {
      // Private browsing, quota limits, or eviction must not break the list.
    }
  }

  /** Delete least-recently-used records above the bounded cache size. */
  async trim() {
    if (this.trimRunning) return;
    this.trimRunning = true;

    try {
      const database = await this.databasePromise;
      if (!database) return;
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore(STORE_NAME);
      const count = await requestResult(store.count());
      let toDelete = Math.max(0, count - MAX_ENTRIES);

      if (toDelete > 0) {
        await new Promise((resolve, reject) => {
          const cursorRequest = store.index("accessedAt").openCursor();
          cursorRequest.addEventListener("error", () => reject(cursorRequest.error), { once: true });
          cursorRequest.addEventListener("success", () => {
            const cursor = cursorRequest.result;
            if (!cursor || toDelete <= 0) {
              resolve();
              return;
            }
            cursor.delete();
            toDelete -= 1;
            cursor.continue();
          });
        });
      }

      await done;
    } catch {
      // Browsers may evict origin storage independently; trimming is best effort.
    } finally {
      this.trimRunning = false;
    }
  }
}
