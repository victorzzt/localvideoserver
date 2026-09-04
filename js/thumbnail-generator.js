/**
 * Browser-side thumbnail extraction.
 * Videos are processed through a small queue. Long videos use the 15-second
 * frame for quick access; videos of 15 seconds or less use the 1/3 frame.
 */

import { abortError } from "./utils.js";
import { ThumbnailCache } from "./thumbnail-cache.js";
import { sharedThumbnailFileCache } from "./thumbnail-file-cache.js";

const MAX_CONCURRENT_PREVIEWS = 4;

function waitForMedia(video, eventName, { timeout = 45000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`等待 ${eventName} 超时`));
    }, timeout);

    const onSuccess = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(new Error("浏览器无法解码这个视频"));
    };

    const onAbort = () => {
      cleanup();
      reject(abortError());
    };

    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener(eventName, onSuccess);
      video.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };

    video.addEventListener(eventName, onSuccess, { once: true });
    video.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function nextAnimationFrame(signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
    const onAbort = () => {
      window.cancelAnimationFrame(frame);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Wait until the seeked frame has reached the browser's video compositor. */
async function waitForDecodedFrame(video, targetTime, signal) {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    await waitForMedia(video, "loadeddata", { signal });
  }

  if (typeof video.requestVideoFrameCallback !== "function") {
    await nextAnimationFrame(signal);
    await nextAnimationFrame(signal);
    return;
  }

  await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    let callbackId = 0;
    const cleanup = () => {
      window.clearTimeout(timer);
      if (callbackId && typeof video.cancelVideoFrameCallback === "function") {
        video.cancelVideoFrameCallback(callbackId);
      }
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const onFrame = (_now, metadata = {}) => {
      const mediaTime = Number(metadata.mediaTime);
      const isTargetFrame =
        !Number.isFinite(mediaTime) ||
        Math.abs(mediaTime - targetTime) <= 2 ||
        Math.abs(video.currentTime - targetTime) <= 0.1;
      if (!video.seeking && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && isTargetFrame) {
        cleanup();
        resolve();
        return;
      }
      callbackId = video.requestVideoFrameCallback(onFrame);
    };
    const timer = window.setTimeout(() => {
      cleanup();
      // Some browsers do not issue callbacks while paused. `seeked` plus
      // HAVE_CURRENT_DATA is still safe to probe; blank detection follows.
      resolve();
    }, 4000);

    signal?.addEventListener("abort", onAbort, { once: true });
    callbackId = video.requestVideoFrameCallback(onFrame);
  });

  await nextAnimationFrame(signal);
}

/** Reset the media element and wait for its resource selection to be emptied. */
async function releaseVideo(video) {
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeEventListener("emptied", onEmptied);
      // Let the browser process network cancellation before freeing a slot.
      window.setTimeout(resolve, 0);
    };
    const onEmptied = () => finish();
    const timer = window.setTimeout(finish, 250);

    video.addEventListener("emptied", onEmptied, { once: true });
    video.pause();
    video.preload = "none";
    if ("srcObject" in video) video.srcObject = null;
    video.removeAttribute("src");
    video.load();
  });
}

/** Detect an undecoded all-black canvas before it can enter persistent cache. */
function frameLooksBlank(video) {
  const canvas = document.createElement("canvas");
  canvas.width = 48;
  canvas.height = 27;
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!context) return false;

  try {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let visiblePixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 30) visiblePixels += 1;
    }
    return visiblePixels < (pixels.length / 4) * 0.002;
  } catch {
    // If canvas inspection is blocked, keep the frame instead of breaking all
    // thumbnails. Directory videos are normally same-origin and inspectable.
    return false;
  }
}

/** Build the preferred timestamp followed by nearby black-frame fallbacks. */
function captureTimes(duration) {
  const preferred = duration > 15 ? 15 : duration > 0 ? duration / 3 : 0;
  const end = duration > 0 ? Math.max(0, duration - 0.1) : 0;
  const candidates = [preferred, Math.min(end, preferred + 2), Math.max(0, preferred - 2)];
  if (duration > 15) candidates.push(duration / 3);
  return [...new Set(candidates.map((value) => Math.max(0, Math.min(end, value)).toFixed(3)))]
    .map(Number);
}

/** Seek and wait for decoded pixels, rather than trusting `seeked` by itself. */
async function seekToFrame(video, targetTime, signal) {
  if (targetTime > 0.05 && Math.abs(video.currentTime - targetTime) > 0.01) {
    const seeked = waitForMedia(video, "seeked", { signal });
    video.currentTime = targetTime;
    await seeked;
  } else if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    await waitForMedia(video, "loadeddata", { signal });
  }
  await waitForDecodedFrame(video, targetTime, signal);
}

function canvasBlob(canvas, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    canvas.toBlob((blob) => {
      if (signal?.aborted) reject(abortError());
      else if (blob) resolve(blob);
      else reject(new Error("无法生成 JPEG 预览"));
    }, "image/jpeg", 0.8);
  });
}

/** Load one video, seek to the selected frame, and return a 640x360 JPEG. */
async function extractFrame(url, signal) {
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  try {
    await waitForMedia(video, "loadedmetadata", { signal });
    if (signal?.aborted) throw abortError();
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    let targetTime = 0;
    let foundUsableFrame = false;

    // Retry nearby frames only when decoded pixels are effectively empty. This
    // prevents a slow seek from permanently caching an all-black JPEG.
    for (const candidate of captureTimes(duration)) {
      if (signal?.aborted) throw abortError();
      await seekToFrame(video, candidate, signal);
      if (!frameLooksBlank(video)) {
        targetTime = candidate;
        foundUsableFrame = true;
        break;
      }
    }

    if (!foundUsableFrame) throw new Error("视频帧尚未完成解码");

    const sourceWidth = video.videoWidth || 640;
    const sourceHeight = video.videoHeight || 360;
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#090a0b";
    context.fillRect(0, 0, canvas.width, canvas.height);

    const scale = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight);
    const width = sourceWidth * scale;
    const height = sourceHeight * scale;
    context.drawImage(video, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);

    const blob = await canvasBlob(canvas, signal);
    return {
      blob,
      duration,
      capturedAt: targetTime,
      verifiedFrame: true,
    };
  } finally {
    await releaseVideo(video);
  }
}

/**
 * Web Worker-coordinated queue for expensive browser video decoding.
 *
 * Usage:
 *   const queue = new ThumbnailGenerator({ concurrency: 4 });
 *   const { blob, duration } = await queue.enqueue(videoUrl);
 *   queue.seal();  // no more videos; Worker exits after all tasks finish
 *   queue.pause(); // abort/requeue active preview requests before playback
 *   queue.resume();
 */
export class ThumbnailGenerator {
  constructor({ concurrency = 4, checkpointToIndexedDb = false } = {}) {
    // Keep exactly four possible preview slots regardless of future callers.
    void concurrency;
    this.concurrency = MAX_CONCURRENT_PREVIEWS;
    this.checkpointToIndexedDb = Boolean(checkpointToIndexedDb);
    this.disposed = false;
    this.paused = false;
    this.pausePromise = null;
    this.sealed = false;
    this.nextTaskId = 1;
    this.tasks = new Map();
    this.taskIdsByUrl = new Map();
    this.controllers = new Map();
    this.activeRuns = new Set();
    this.priorityUrls = new Set();
    // Setup mode must survive reloads, so its checkpoint store is not trimmed
    // to the normal 500-entry browsing limit while the build is in progress.
    this.cache = new ThumbnailCache({
      maxEntries: this.checkpointToIndexedDb ? Number.POSITIVE_INFINITY : undefined,
    });
    this.fileCache = sharedThumbnailFileCache;
    this.resolvedResults = new Map();
    this.worker = null;
    this.workerError = null;

    try {
      this.worker = new Worker(new URL("./thumbnail-worker.js", import.meta.url), {
        type: "module",
        name: "video-thumbnail-queue",
      });
      this.worker.addEventListener("message", (event) => this.handleWorkerMessage(event.data));
      this.worker.addEventListener("error", () => this.handleWorkerFailure());
      this.worker.postMessage({ type: "init", concurrency: this.concurrency });
    } catch (error) {
      this.workerError = error;
    }
  }

  /** Add a URL to the Worker-owned queue and resolve when its card frame exists. */
  enqueue(url) {
    if (this.disposed) return Promise.reject(abortError());
    if (this.workerError || !this.worker) {
      return Promise.reject(this.workerError || new Error("缩略图 Worker 不可用"));
    }
    if (this.sealed) return Promise.reject(new Error("缩略图队列已经关闭"));

    return new Promise((resolve, reject) => {
      const id = this.nextTaskId++;
      this.tasks.set(id, { id, url, resolve, reject });
      this.taskIdsByUrl.set(url, id);
      this.worker.postMessage({
        type: "enqueue",
        id,
        url,
        priority: this.priorityUrls.has(url),
      });
    });
  }

  /**
   * Normal mode reads thumbnail.cache before IndexedDB. Setup mode reverses
   * that order and imports file hits into IndexedDB as durable checkpoints.
   */
  async getCached(url) {
    let result;
    if (this.checkpointToIndexedDb) {
      result = await this.cache.get(url);
      if (!result) {
        result = await this.fileCache.get(url);
        if (result && !(await this.cache.put(url, result))) {
          throw new Error("Could not save the thumbnail checkpoint to IndexedDB");
        }
      }
    } else {
      result = await this.fileCache.get(url) || await this.cache.get(url);
    }
    if (result) this.resolvedResults.set(url, result);
    return result;
  }

  /** Save a generated Blob; setup completion requires a durable checkpoint. */
  async cacheResult(url, result) {
    const stored = await this.cache.put(url, result);
    if (this.checkpointToIndexedDb && !stored) {
      throw new Error("Could not save the thumbnail checkpoint to IndexedDB");
    }
    if (result?.verifiedFrame === true) this.resolvedResults.set(url, result);
    return stored;
  }

  /** Create a downloadable file from durable setup checkpoints. */
  async createCacheFile(items) {
    let entries;
    if (this.checkpointToIndexedDb) {
      entries = [];
      // Read in moderate batches: no MP4 requests occur, but thousands of
      // simultaneous IndexedDB transactions can still stall some browsers.
      for (let offset = 0; offset < items.length; offset += 32) {
        const batch = await Promise.all(items.slice(offset, offset + 32).map(async (item) => ({
          url: item.url,
          result: await this.cache.get(item.url),
        })));
        entries.push(...batch.filter((entry) => entry.result));
      }
    } else {
      entries = items
        .map((item) => ({ url: item.url, result: this.resolvedResults.get(item.url) }))
        .filter((entry) => entry.result);
    }
    if (entries.length !== items.length) {
      return Promise.reject(new Error("Not every scanned video has a resolved thumbnail"));
    }
    return this.fileCache.createFile(entries);
  }

  /**
   * Move directly visible videos ahead of other pending work. The Worker may
   * cancel/requeue non-current active tasks so all four slots serve this folder.
   */
  prioritize(urls) {
    this.priorityUrls = new Set(urls);
    if (!this.worker || this.disposed) return;
    const ids = urls.map((url) => this.taskIdsByUrl.get(url)).filter(Number.isFinite);
    this.worker.postMessage({ type: "prioritize", ids });
  }

  /** Tell the Worker all video URLs have been submitted so it may exit when done. */
  seal() {
    if (this.disposed || this.sealed || !this.worker) return;
    this.sealed = true;
    this.worker.postMessage({ type: "seal" });
  }

  /**
   * Pause scheduling and abort active media elements to release server slots.
   * Aborted tasks remain unresolved and the Worker requeues them for resume().
   */
  async pause() {
    if (this.disposed || !this.worker) return;
    if (this.paused) return this.pausePromise;
    this.paused = true;
    this.worker.postMessage({ type: "pause" });
    for (const controller of this.controllers.values()) controller.abort();
    this.pausePromise = Promise.allSettled([...this.activeRuns]);
    await this.pausePromise;
  }

  /** Continue queued previews after the player returns to the list view. */
  resume() {
    if (this.disposed || !this.paused || !this.worker) return;
    this.paused = false;
    this.pausePromise = null;
    this.worker.postMessage({ type: "resume" });
  }

  /** Execute or cancel DOM-bound work requested by the Worker scheduler. */
  handleWorkerMessage(message = {}) {
    if (this.disposed) return;

    if (message.type === "run") {
      const activeRun = this.runTask(message.id);
      this.activeRuns.add(activeRun);
      activeRun.finally(() => this.activeRuns.delete(activeRun));
    } else if (message.type === "cancel") {
      this.controllers.get(message.id)?.abort();
    } else if (message.type === "drained") {
      this.worker = null;
    }
  }

  /** Capture one frame and report completion/cancellation back to the Worker. */
  async runTask(id) {
    const task = this.tasks.get(id);
    if (!task || !this.worker) return;
    if (this.paused) {
      this.worker.postMessage({ type: "cancelled", id });
      return;
    }

    const controller = new AbortController();
    this.controllers.set(id, controller);

    try {
      const result = await extractFrame(task.url, controller.signal);
      if (this.disposed) return;
      task.resolve(result);
      this.tasks.delete(id);
      this.taskIdsByUrl.delete(task.url);
      this.worker?.postMessage({ type: "complete", id });
    } catch (error) {
      if (this.disposed) return;
      if (error.name === "AbortError") {
        this.worker?.postMessage({ type: "cancelled", id });
      } else {
        task.reject(error);
        this.tasks.delete(id);
        this.taskIdsByUrl.delete(task.url);
        this.worker?.postMessage({ type: "failed", id });
      }
    } finally {
      this.controllers.delete(id);
    }
  }

  /** Reject every task if the Worker script itself cannot start or crashes. */
  handleWorkerFailure() {
    const error = new Error("缩略图 Worker 运行失败");
    this.workerError = error;
    for (const controller of this.controllers.values()) controller.abort();
    for (const task of this.tasks.values()) task.reject(error);
    this.tasks.clear();
    this.taskIdsByUrl.clear();
    this.controllers.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  /** Terminate scheduling and reject all preview promises during a rescan/unload. */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const error = abortError();
    for (const controller of this.controllers.values()) controller.abort();
    for (const task of this.tasks.values()) task.reject(error);
    this.tasks.clear();
    this.taskIdsByUrl.clear();
    this.worker?.terminate();
    this.worker = null;
    await Promise.allSettled([...this.activeRuns]);
    this.activeRuns.clear();
    this.controllers.clear();
    this.resolvedResults.clear();
  }
}
