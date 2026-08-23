/**
 * Browser-side thumbnail extraction.
 * Videos are processed through a small queue. Long videos use the 15-second
 * frame for quick access; videos of 15 seconds or less use the 1/3 frame.
 */

import { abortError } from "./utils.js";
import { ThumbnailCache } from "./thumbnail-cache.js";

function waitForMedia(video, eventName, { timeout = 30000, signal } = {}) {
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
    // Avoid a slow deep seek: long videos stop at 15s; short ones use one third.
    const targetTime = duration > 15 ? 15 : duration > 0 ? duration / 3 : 0;

    if (targetTime > 0.05) {
      if (signal?.aborted) throw abortError();
      const seeked = waitForMedia(video, "seeked", { signal });
      video.currentTime = targetTime;
      await seeked;
    } else if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForMedia(video, "loadeddata", { signal });
    }

    if (signal?.aborted) throw abortError();

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
    };
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
}

/**
 * Web Worker-coordinated queue for expensive browser video decoding.
 *
 * Usage:
 *   const queue = new ThumbnailGenerator({ concurrency: 4 });
 *   const { dataUrl, duration } = await queue.enqueue(videoUrl);
 *   queue.seal();  // no more videos; Worker exits after all tasks finish
 *   queue.pause(); // abort/requeue active preview requests before playback
 *   queue.resume();
 */
export class ThumbnailGenerator {
  constructor({ concurrency = 4 } = {}) {
    this.concurrency = Math.max(1, Math.min(4, concurrency));
    this.disposed = false;
    this.paused = false;
    this.sealed = false;
    this.nextTaskId = 1;
    this.tasks = new Map();
    this.taskIdsByUrl = new Map();
    this.controllers = new Map();
    this.priorityUrls = new Set();
    this.cache = new ThumbnailCache();
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

  /** Read a persistent JPEG Blob; a hit performs no request to the video URL. */
  getCached(url) {
    return this.cache.get(url);
  }

  /** Save a newly generated Blob in the persistent IndexedDB cache. */
  cacheResult(url, result) {
    return this.cache.put(url, result);
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
  pause() {
    if (this.disposed || this.paused || !this.worker) return;
    this.paused = true;
    this.worker.postMessage({ type: "pause" });
    for (const controller of this.controllers.values()) controller.abort();
  }

  /** Continue queued previews after the player returns to the list view. */
  resume() {
    if (this.disposed || !this.paused || !this.worker) return;
    this.paused = false;
    this.worker.postMessage({ type: "resume" });
  }

  /** Execute or cancel DOM-bound work requested by the Worker scheduler. */
  handleWorkerMessage(message = {}) {
    if (this.disposed) return;

    if (message.type === "run") {
      this.runTask(message.id);
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
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const error = abortError();
    for (const controller of this.controllers.values()) controller.abort();
    for (const task of this.tasks.values()) task.reject(error);
    this.tasks.clear();
    this.taskIdsByUrl.clear();
    this.controllers.clear();
    this.worker?.terminate();
    this.worker = null;
  }
}
