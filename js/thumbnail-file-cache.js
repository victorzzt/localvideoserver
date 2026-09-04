/**
 * Portable thumbnail.cache reader/writer.
 *
 * The file contains an obfuscated JSON document with one `jpeg` data URL per
 * video. It is intentionally simple: this only keeps the cache from being
 * immediately human-readable and must not be treated as security.
 */

const CACHE_FILE_HEADER = "LOCAL_VIDEO_THUMBNAIL_CACHE_V1\n";
const CACHE_FILE_FORMAT = "local-video-thumbnail-cache";
const CACHE_FILE_VERSION = 1;
const CACHE_FILE_URL = new URL("../thumbnail.cache", import.meta.url);
const LIBRARY_ROOT_URL = new URL("../", import.meta.url);

/**
 * USER CONFIGURATION: change this string to use a different XOR cipher key.
 * The same value must be present when thumbnail.cache is created and read.
 * Changing it makes previously generated cache files unreadable. This fast
 * symmetric XOR is obfuscation only; a key shipped in frontend JS is public.
 */
export const THUMBNAIL_CACHE_CIPHER_KEY = "local-video-cache-change-me";

function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Apply the same repeating-key XOR operation for encryption and decryption. */
function applyCipher(bytes) {
  const key = new TextEncoder().encode(THUMBNAIL_CACHE_CIPHER_KEY);
  if (key.length === 0) throw new Error("The thumbnail cache cipher key cannot be empty");
  const result = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    result[index] = bytes[index] ^ key[index % key.length];
  }
  return result;
}

function cacheKeyForVideo(url) {
  try {
    const target = new URL(url, LIBRARY_ROOT_URL);
    if (
      target.origin !== LIBRARY_ROOT_URL.origin ||
      !target.pathname.startsWith(LIBRARY_ROOT_URL.pathname)
    ) {
      return null;
    }
    // Keep URL escaping intact so the key is portable across hosts and ports.
    return target.pathname.slice(LIBRARY_ROOT_URL.pathname.length);
  } catch {
    return null;
  }
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:image/jpeg;base64,${bytesToBase64(bytes)}`;
}

function jpegDataUrlToBlob(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/jpeg;base64,")) {
    return null;
  }
  try {
    const bytes = base64ToBytes(dataUrl.slice(dataUrl.indexOf(",") + 1));
    return new Blob([bytes], { type: "image/jpeg" });
  } catch {
    return null;
  }
}

/** Encode the JSON payload into the text-safe, XOR-obfuscated file body. */
export function encodeCachePayload(payload) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(payload));
  return `${CACHE_FILE_HEADER}${bytesToBase64(applyCipher(jsonBytes))}`;
}

/** Decode a thumbnail.cache body, throwing when its key or format is invalid. */
export function decodeCachePayload(fileText) {
  if (!fileText.startsWith(CACHE_FILE_HEADER)) throw new Error("Unknown thumbnail.cache format");
  const encrypted = base64ToBytes(fileText.slice(CACHE_FILE_HEADER.length));
  const json = new TextDecoder("utf-8", { fatal: true }).decode(applyCipher(encrypted));
  const payload = JSON.parse(json);
  if (payload?.format !== CACHE_FILE_FORMAT || payload?.version !== CACHE_FILE_VERSION) {
    throw new Error("Unsupported thumbnail.cache version");
  }
  return payload;
}

/**
 * Loads the optional static file once, serves portable records before
 * IndexedDB, and creates a replacement download in setup mode.
 */
export class ThumbnailFileCache {
  constructor() {
    this.recordsPromise = this.load();
  }

  async load() {
    const records = new Map();
    let response;
    try {
      response = await fetch(CACHE_FILE_URL, {
        cache: "no-cache",
        credentials: "same-origin",
      });
    } catch {
      return records;
    }
    if (!response.ok) return records;

    try {
      const payload = decodeCachePayload(await response.text());
      for (const record of payload.thumbnails || []) {
        if (
          typeof record?.path !== "string" ||
          typeof record?.jpeg !== "string" ||
          !record.jpeg.startsWith("data:image/jpeg;base64,")
        ) {
          continue;
        }
        records.set(record.path, record);
      }
    } catch (error) {
      // Log malformed/key-mismatched files while still falling back to normal
      // browser generation for every record.
      console.warn("thumbnail.cache was ignored:", error);
    }
    return records;
  }

  /** Return a Blob record without requesting the MP4 file. */
  async get(url) {
    const key = cacheKeyForVideo(url);
    if (!key) return null;
    const record = (await this.recordsPromise).get(key);
    if (!record) return null;
    const blob = jpegDataUrlToBlob(record.jpeg);
    if (!blob) return null;
    return {
      blob,
      duration: Number.isFinite(record.duration) ? record.duration : 0,
      capturedAt: Number.isFinite(record.capturedAt) ? record.capturedAt : 0,
      verifiedFrame: true,
      fromCache: true,
      fromFileCache: true,
    };
  }

  /** Build a portable thumbnail.cache Blob from resolved video results. */
  async createFile(entries) {
    const thumbnails = [];
    for (const { url, result } of entries) {
      const path = cacheKeyForVideo(url);
      if (!path || !(result?.blob instanceof Blob) || result.verifiedFrame !== true) continue;
      thumbnails.push({
        path,
        jpeg: await blobToDataUrl(result.blob),
        duration: Number.isFinite(result.duration) ? result.duration : 0,
        capturedAt: Number.isFinite(result.capturedAt) ? result.capturedAt : 0,
      });
    }

    const payload = {
      format: CACHE_FILE_FORMAT,
      version: CACHE_FILE_VERSION,
      createdAt: new Date().toISOString(),
      thumbnails,
    };
    return new Blob([encodeCachePayload(payload)], { type: "application/octet-stream" });
  }
}

// Reuse one fetch across rescans during the same page session.
export const sharedThumbnailFileCache = new ThumbnailFileCache();
