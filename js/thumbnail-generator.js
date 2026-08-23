/**
 * Browser-side thumbnail extraction.
 * Videos are processed through a small queue. Long videos use the 15-second
 * frame for quick access; videos of 15 seconds or less use the 1/3 frame.
 */

import { abortError } from "./utils.js";

function waitForMedia(video, eventName, timeout = 20000) {
  return new Promise((resolve, reject) => {
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

    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener(eventName, onSuccess);
      video.removeEventListener("error", onError);
    };

    video.addEventListener(eventName, onSuccess, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

/** Load one video, seek to the selected frame, and return a 640x360 JPEG. */
async function extractFrame(url) {
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  try {
    await waitForMedia(video, "loadedmetadata");
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    // Avoid a slow deep seek: long videos stop at 15s; short ones use one third.
    const targetTime = duration > 15 ? 15 : duration > 0 ? duration / 3 : 0;

    if (targetTime > 0.05) {
      const seeked = waitForMedia(video, "seeked");
      video.currentTime = targetTime;
      await seeked;
    } else if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForMedia(video, "loadeddata");
    }

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

    return {
      dataUrl: canvas.toDataURL("image/jpeg", 0.8),
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
 * Small concurrency-limited queue for expensive browser video decoding.
 *
 * Usage:
 *   const queue = new ThumbnailGenerator({ concurrency: 2 });
 *   const { dataUrl, duration } = await queue.enqueue(videoUrl);
 *   queue.dispose(); // reject work that has not started during a refresh
 */
export class ThumbnailGenerator {
  constructor({ concurrency = 2 } = {}) {
    this.concurrency = Math.max(1, concurrency);
    this.active = 0;
    this.queue = [];
    this.disposed = false;
  }

  enqueue(url) {
    if (this.disposed) return Promise.reject(abortError());

    return new Promise((resolve, reject) => {
      this.queue.push({ url, resolve, reject });
      this.drain();
    });
  }

  /** Start queued jobs until the configured worker limit has been reached. */
  drain() {
    while (!this.disposed && this.active < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift();
      this.active += 1;

      extractFrame(task.url)
        .then(task.resolve, task.reject)
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }

  /** Reject waiting jobs; already-decoding browser media is allowed to finish. */
  dispose() {
    this.disposed = true;
    const error = abortError();
    this.queue.splice(0).forEach((task) => task.reject(error));
  }
}
