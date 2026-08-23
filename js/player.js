/** Custom video player: controls, double-tap seeking and fullscreen gestures. */

import { formatTime, setButtonIcon } from "./utils.js";

const $ = (id) => document.getElementById(id);

/**
 * Custom player controller for one shared `<video>` element.
 *
 * Usage: construct once, then call `open(videoItem, clickedButton)`. The player
 * restores focus to that button when `close()` runs. Fullscreen automatically
 * tries Screen Orientation lock, then falls back to gravity-based rotation on
 * phones whose operating system is locked to portrait.
 */
export class VideoPlayer {
  constructor({ onClose } = {}) {
    this.onClose = onClose;
    this.view = $("playerView");
    this.shell = $("playerShell");
    this.video = $("videoPlayer");
    this.title = $("playerTitle");
    this.backButton = $("backButton");
    this.centerPlayButton = $("centerPlayButton");
    this.playPauseButton = $("playPauseButton");
    this.muteButton = $("muteButton");
    this.fullscreenButton = $("fullscreenButton");
    this.floatingExit = $("floatingExitFullscreen");
    this.timeline = $("timeline");
    this.volumeSlider = $("volumeSlider");
    this.timeDisplay = $("timeDisplay");
    this.spinner = $("playerSpinner");
    this.notice = $("playerNotice");
    this.gestureHint = $("fullscreenGestureHint");
    this.rotationSurface = $("playerRotationSurface");
    this.active = false;
    this.lastTrigger = null;
    this.lastTap = { side: null, time: 0 };
    this.tapTimer = 0;
    this.controlsTimer = 0;
    this.hintTimer = 0;
    this.multiTouchUntil = 0;
    this.threeFingerGesture = null;
    this.motionPermissionRequested = false;
    this.gravityRotation = null;
    this.currentMobileRotation = 90;

    this.bindEvents();
    this.updatePlaybackUi();
  }

  /** Register media, control, keyboard, gesture, fullscreen, and sensor events. */
  bindEvents() {
    this.backButton.addEventListener("click", () => this.close());
    this.centerPlayButton.addEventListener("click", () => this.togglePlayback());
    this.playPauseButton.addEventListener("click", () => this.togglePlayback());
    this.muteButton.addEventListener("click", () => this.toggleMute());
    this.fullscreenButton.addEventListener("click", () => this.toggleFullscreen());
    this.floatingExit.addEventListener("click", () => this.exitFullscreen());

    this.timeline.addEventListener("input", () => {
      if (!Number.isFinite(this.video.duration)) return;
      this.video.currentTime = (Number(this.timeline.value) / 1000) * this.video.duration;
      this.updateProgressUi();
    });

    this.volumeSlider.addEventListener("input", () => {
      this.video.volume = Number(this.volumeSlider.value);
      this.video.muted = this.video.volume === 0;
      this.updateVolumeUi();
    });

    this.video.addEventListener("play", () => this.updatePlaybackUi());
    this.video.addEventListener("pause", () => this.updatePlaybackUi());
    this.video.addEventListener("ended", () => this.updatePlaybackUi());
    this.video.addEventListener("timeupdate", () => this.updateProgressUi());
    this.video.addEventListener("durationchange", () => this.updateProgressUi());
    this.video.addEventListener("loadedmetadata", () => this.handleVideoMetadata());
    this.video.addEventListener("progress", () => this.updateBufferedUi());
    this.video.addEventListener("volumechange", () => this.updateVolumeUi());
    this.video.addEventListener("waiting", () => { this.spinner.hidden = false; });
    this.video.addEventListener("seeking", () => { this.spinner.hidden = false; });
    this.video.addEventListener("playing", () => { this.spinner.hidden = true; });
    this.video.addEventListener("canplay", () => { this.spinner.hidden = true; });
    this.video.addEventListener("seeked", () => { this.spinner.hidden = true; });
    this.video.addEventListener("error", () => this.showNotice("这个视频无法播放，可能是编码格式不受浏览器支持。"));

    this.shell.addEventListener("mousemove", () => this.showControls());
    this.shell.addEventListener("mouseleave", () => {
      if (!this.video.paused) this.hideControls();
    });
    this.shell.addEventListener("focusin", () => this.showControls());

    this.shell.querySelectorAll("[data-seek-direction]").forEach((zone) => {
      zone.addEventListener("pointerup", (event) => {
        const seconds = zone.dataset.seekDirection === "forward" ? 10 : -10;
        this.handleZoneTap(event, seconds);
      });
    });

    this.shell.addEventListener("touchstart", (event) => this.handleTouchStart(event), { passive: true });
    this.shell.addEventListener("touchmove", (event) => this.handleTouchMove(event), { passive: false });
    this.shell.addEventListener("touchend", (event) => this.handleTouchEnd(event), { passive: true });

    document.addEventListener("fullscreenchange", () => this.handleFullscreenChange());
    document.addEventListener("webkitfullscreenchange", () => this.handleFullscreenChange());
    document.addEventListener("keydown", (event) => this.handleKeydown(event));
    window.addEventListener("resize", () => {
      this.updatePortraitPlayerSize();
      this.applyMobileOrientation();
    });
    window.addEventListener("orientationchange", () => {
      window.setTimeout(() => {
        this.updatePortraitPlayerSize();
        this.applyMobileOrientation();
      }, 120);
    });
    window.addEventListener("devicemotion", (event) => this.handleDeviceMotion(event), { passive: true });
  }

  /** Load and begin playing a scanner item; `trigger` is restored on close. */
  open(item, trigger) {
    this.active = true;
    this.lastTrigger = trigger || document.activeElement;
    this.title.textContent = item.title;
    this.notice.hidden = true;
    this.spinner.hidden = false;
    this.view.hidden = false;
    this.view.setAttribute("aria-hidden", "false");
    document.body.classList.add("player-open");
    this.shell.classList.add("is-paused", "controls-visible");
    this.shell.classList.remove("is-portrait-video");
    this.view.classList.remove("portrait-video-open");
    this.shell.style.removeProperty("--video-aspect-ratio");
    this.shell.style.removeProperty("--portrait-player-width");
    this.resetMobileOrientation(false);
    this.video.src = item.url;
    this.video.load();
    this.updateProgressUi();
    this.backButton.focus({ preventScroll: true });

    const playAttempt = this.video.play();
    if (playAttempt) playAttempt.catch(() => this.updatePlaybackUi());
  }

  /** Stop media, leave fullscreen, release orientation state, and return to grid. */
  async close() {
    if (!this.active) return;
    if (document.fullscreenElement === this.shell) {
      try { await document.exitFullscreen(); } catch { /* Browser already exited. */ }
    }

    this.active = false;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.view.hidden = true;
    this.view.setAttribute("aria-hidden", "true");
    this.shell.classList.remove("is-portrait-video");
    this.view.classList.remove("portrait-video-open");
    this.shell.style.removeProperty("--video-aspect-ratio");
    this.shell.style.removeProperty("--portrait-player-width");
    document.body.classList.remove("player-open");
    window.clearTimeout(this.controlsTimer);
    window.clearTimeout(this.tapTimer);
    this.resetMobileOrientation();
    this.onClose?.();
    this.lastTrigger?.focus?.({ preventScroll: true });
  }

  /** Toggle play/pause and restart from zero when the media has ended. */
  togglePlayback() {
    if (this.video.paused || this.video.ended) {
      if (this.video.ended) this.video.currentTime = 0;
      this.video.play().catch(() => this.showNotice("浏览器阻止了自动播放，请再点一次播放。"));
    } else {
      this.video.pause();
    }
  }

  updatePlaybackUi() {
    const paused = this.video.paused || this.video.ended;
    this.shell.classList.toggle("is-paused", paused);
    setButtonIcon(this.playPauseButton, paused ? "play" : "pause");
    setButtonIcon(this.centerPlayButton, paused ? "play" : "pause");
    const label = paused ? "播放" : "暂停";
    this.playPauseButton.setAttribute("aria-label", label);
    this.centerPlayButton.setAttribute("aria-label", label);
    if (paused) this.showControls();
    else this.scheduleControlsHide();
  }

  /** Synchronize timeline, CSS progress fill, and accessible time text. */
  updateProgressUi() {
    const duration = Number.isFinite(this.video.duration) ? this.video.duration : 0;
    const current = Number.isFinite(this.video.currentTime) ? this.video.currentTime : 0;
    const ratio = duration > 0 ? current / duration : 0;
    this.timeline.value = String(Math.round(ratio * 1000));
    this.timeline.style.setProperty("--played", `${ratio * 100}%`);
    this.timeDisplay.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
    this.timeline.setAttribute("aria-valuetext", `${formatTime(current)}，总时长 ${formatTime(duration)}`);
    this.updateBufferedUi();
  }

  updateBufferedUi() {
    const duration = this.video.duration;
    if (!Number.isFinite(duration) || duration <= 0 || this.video.buffered.length === 0) {
      this.timeline.style.setProperty("--buffered", "0%");
      return;
    }
    const end = this.video.buffered.end(this.video.buffered.length - 1);
    this.timeline.style.setProperty("--buffered", `${Math.min(100, (end / duration) * 100)}%`);
  }

  toggleMute() {
    this.video.muted = !this.video.muted;
    if (!this.video.muted && this.video.volume === 0) this.video.volume = 0.5;
    this.updateVolumeUi();
  }

  updateVolumeUi() {
    const muted = this.video.muted || this.video.volume === 0;
    setButtonIcon(this.muteButton, muted ? "muted" : "volume");
    this.muteButton.setAttribute("aria-label", muted ? "取消静音" : "静音");
    this.volumeSlider.value = String(this.video.muted ? 0 : this.video.volume);
    this.volumeSlider.style.setProperty("--played", `${Number(this.volumeSlider.value) * 100}%`);
  }

  /** Distinguish single taps from same-side double taps used for ±10s seeking. */
  handleZoneTap(event, seconds) {
    if (Date.now() < this.multiTouchUntil || event.button > 0) return;
    const side = seconds > 0 ? "right" : "left";
    const now = performance.now();
    const isDoubleTap = this.lastTap.side === side && now - this.lastTap.time < 330;
    window.clearTimeout(this.tapTimer);

    if (isDoubleTap) {
      this.lastTap = { side: null, time: 0 };
      this.seekBy(seconds);
      return;
    }

    this.lastTap = { side, time: now };
    this.tapTimer = window.setTimeout(() => {
      if (event.pointerType === "touch" || event.pointerType === "pen") this.showControls();
      else this.togglePlayback();
      this.lastTap = { side: null, time: 0 };
    }, 335);
  }

  seekBy(seconds) {
    if (!Number.isFinite(this.video.duration)) return;
    this.video.currentTime = Math.max(0, Math.min(this.video.duration, this.video.currentTime + seconds));
    const feedback = $(seconds > 0 ? "seekFeedbackForward" : "seekFeedbackBack");
    feedback.classList.remove("show");
    void feedback.offsetWidth;
    feedback.classList.add("show");
    this.showControls();
  }

  showControls() {
    this.shell.classList.add("controls-visible");
    this.scheduleControlsHide();
  }

  hideControls() {
    if (!this.video.paused && !this.shell.matches(":focus-within")) {
      this.shell.classList.remove("controls-visible");
    }
  }

  scheduleControlsHide() {
    window.clearTimeout(this.controlsTimer);
    if (!this.video.paused) {
      this.controlsTimer = window.setTimeout(() => this.hideControls(), 2600);
    }
  }

  /** Enter/exit fullscreen and request motion permission within the user gesture. */
  async toggleFullscreen() {
    if (document.fullscreenElement === this.shell) {
      await this.exitFullscreen();
      return;
    }

    const motionPermission = this.requestMotionPermission();
    try {
      if (this.shell.requestFullscreen) {
        await this.shell.requestFullscreen();
      } else if (this.video.webkitEnterFullscreen) {
        this.video.webkitEnterFullscreen();
      } else {
        this.showNotice("当前浏览器不支持网页全屏。", 2200);
      }
    } catch {
      this.showNotice("浏览器没有允许进入全屏。", 2200);
    }
    motionPermission.catch(() => {});
  }

  async exitFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.webkitFullscreenElement) await document.webkitExitFullscreen();
    } catch {
      this.showNotice("可以按 Esc 退出全屏。", 2000);
    }
  }

  /** Update controls and start/stop the mobile orientation strategy. */
  handleFullscreenChange() {
    const isFullscreen = document.fullscreenElement === this.shell || document.webkitFullscreenElement === this.shell;
    setButtonIcon(this.fullscreenButton, isFullscreen ? "fullscreen-exit" : "fullscreen");
    this.fullscreenButton.setAttribute("aria-label", isFullscreen ? "退出全屏" : "进入全屏");
    this.floatingExit.hidden = !isFullscreen;

    window.clearTimeout(this.hintTimer);
    this.gestureHint.classList.toggle("is-visible", isFullscreen);
    if (isFullscreen) {
      this.hintTimer = window.setTimeout(() => this.gestureHint.classList.remove("is-visible"), 3400);
      this.lockOrientationForVideo();
      window.requestAnimationFrame(() => this.applyMobileOrientation());
    } else {
      this.resetMobileOrientation();
    }
    this.showControls();
  }

  isMobileDevice() {
    return navigator.maxTouchPoints > 0 && Math.min(window.screen.width, window.screen.height) <= 1100;
  }

  isLandscapeVideo() {
    return this.video.videoWidth > this.video.videoHeight;
  }

  isPlayerFullscreen() {
    return document.fullscreenElement === this.shell || document.webkitFullscreenElement === this.shell;
  }

  handleVideoMetadata() {
    const aspectRatio = this.video.videoWidth / this.video.videoHeight;
    const isPortraitVideo = Number.isFinite(aspectRatio) && aspectRatio < 1;
    this.shell.classList.toggle("is-portrait-video", isPortraitVideo);
    this.view.classList.toggle("portrait-video-open", isPortraitVideo);
    if (Number.isFinite(aspectRatio) && aspectRatio > 0) {
      this.shell.style.setProperty("--video-aspect-ratio", String(aspectRatio));
    }
    this.updatePortraitPlayerSize();

    if (!this.isPlayerFullscreen()) return;
    this.lockOrientationForVideo();
    this.applyMobileOrientation();
  }

  /**
   * Fit a portrait video to phone width, shrinking it only when available
   * viewport height would be exceeded before fullscreen.
   */
  updatePortraitPlayerSize() {
    const aspectRatio = this.video.videoWidth / this.video.videoHeight;
    if (!Number.isFinite(aspectRatio) || aspectRatio <= 0 || aspectRatio >= 1) return;
    const availableHeight = Math.max(220, window.innerHeight - 28);
    const width = Math.min(window.innerWidth, availableHeight * aspectRatio);
    this.shell.style.setProperty("--portrait-player-width", `${Math.round(width)}px`);
  }

  async requestMotionPermission() {
    if (!this.isMobileDevice() || this.motionPermissionRequested) return;
    this.motionPermissionRequested = true;
    const MotionEvent = window.DeviceMotionEvent;
    if (typeof MotionEvent?.requestPermission === "function") {
      try {
        await MotionEvent.requestPermission();
      } catch {
        // Screen orientation and the default rotation remain available as fallbacks.
      }
    }
  }

  /** Prefer native orientation lock based on the decoded video dimensions. */
  async lockOrientationForVideo() {
    if (!this.isMobileDevice() || !this.isPlayerFullscreen() || !this.video.videoWidth) return;
    const orientation = this.isLandscapeVideo() ? "landscape" : "portrait";
    try {
      await window.screen.orientation?.lock?.(orientation);
    } catch {
      // OS orientation lock is common; applyMobileOrientation handles that case.
    } finally {
      window.setTimeout(() => this.applyMobileOrientation(), 100);
    }
  }

  /** Infer which physical side is down from gravity when native lock is blocked. */
  handleDeviceMotion(event) {
    if (!this.isPlayerFullscreen() || !this.isLandscapeVideo()) return;
    const gravity = event.accelerationIncludingGravity;
    if (!gravity || !Number.isFinite(gravity.x) || !Number.isFinite(gravity.y)) return;
    const x = gravity.x;
    const y = gravity.y;
    if (Math.abs(x) < 3 || Math.abs(x) < Math.abs(y) * 1.08) return;

    const rotation = x > 0 ? -90 : 90;
    if (rotation === this.gravityRotation) return;
    this.gravityRotation = rotation;
    this.applyMobileOrientation();
  }

  /** Rotate the full control surface only for landscape video in a portrait viewport. */
  applyMobileOrientation() {
    const needsRotation =
      this.isPlayerFullscreen() &&
      this.isMobileDevice() &&
      this.isLandscapeVideo() &&
      window.innerHeight >= window.innerWidth;

    this.shell.classList.toggle("force-mobile-rotation", needsRotation);
    if (!needsRotation) return;
    this.currentMobileRotation = this.gravityRotation ?? 90;
    this.shell.style.setProperty("--mobile-video-rotation", `${this.currentMobileRotation}deg`);
  }

  /** Remove CSS rotation and optionally release the Screen Orientation lock. */
  resetMobileOrientation(unlockScreen = true) {
    this.shell.classList.remove("force-mobile-rotation");
    this.shell.style.removeProperty("--mobile-video-rotation");
    this.gravityRotation = null;
    this.currentMobileRotation = 90;
    if (unlockScreen && this.isMobileDevice()) {
      try { window.screen.orientation?.unlock?.(); } catch { /* Unsupported or already unlocked. */ }
    }
  }

  /** Begin the three-finger fullscreen-exit gesture. */
  handleTouchStart(event) {
    if (event.touches.length > 1) this.multiTouchUntil = Date.now() + 900;
    const isFullscreen = document.fullscreenElement === this.shell || document.webkitFullscreenElement === this.shell;
    if (event.touches.length !== 3 || !isFullscreen) return;
    const point = this.touchCenter(event.touches);
    this.threeFingerGesture = { startX: point.x, startY: point.y, lastX: point.x, lastY: point.y };
  }

  handleTouchMove(event) {
    if (!this.threeFingerGesture || event.touches.length !== 3) return;
    event.preventDefault();
    const point = this.touchCenter(event.touches);
    this.threeFingerGesture.lastX = point.x;
    this.threeFingerGesture.lastY = point.y;
  }

  /** Finish three-finger swipe-down, accounting for a CSS-rotated phone surface. */
  handleTouchEnd(event) {
    if (!this.threeFingerGesture || event.touches.length === 3) return;
    const gesture = this.threeFingerGesture;
    this.threeFingerGesture = null;
    this.multiTouchUntil = Date.now() + 900;
    const deltaX = gesture.lastX - gesture.startX;
    const deltaY = gesture.lastY - gesture.startY;
    let downwardDistance = deltaY;
    let crossDistance = deltaX;
    if (this.shell.classList.contains("force-mobile-rotation")) {
      downwardDistance = this.currentMobileRotation > 0 ? -deltaX : deltaX;
      crossDistance = deltaY;
    }
    if (downwardDistance > 80 && Math.abs(downwardDistance) > Math.abs(crossDistance) * 1.15) {
      this.exitFullscreen();
    }
  }

  touchCenter(touches) {
    const points = Array.from(touches);
    return {
      x: points.reduce((sum, touch) => sum + touch.clientX, 0) / points.length,
      y: points.reduce((sum, touch) => sum + touch.clientY, 0) / points.length,
    };
  }

  /** Handle YouTube-style shortcuts while leaving focused controls autonomous. */
  handleKeydown(event) {
    if (!this.active) return;
    const targetIsControl = event.target.matches("input, button");

    if (event.key === "Escape") {
      if (document.fullscreenElement || document.webkitFullscreenElement) this.exitFullscreen();
      else this.close();
      return;
    }
    if (targetIsControl) return;

    const key = event.key.toLocaleLowerCase();
    if (key === " " || key === "k") {
      event.preventDefault();
      this.togglePlayback();
    } else if (key === "arrowleft") {
      event.preventDefault();
      this.seekBy(-10);
    } else if (key === "arrowright") {
      event.preventDefault();
      this.seekBy(10);
    } else if (key === "f") {
      event.preventDefault();
      this.toggleFullscreen();
    } else if (key === "m") {
      event.preventDefault();
      this.toggleMute();
    }
  }

  showNotice(message, duration = 0) {
    this.notice.textContent = message;
    this.notice.hidden = false;
    this.spinner.hidden = true;
    if (duration > 0) {
      window.setTimeout(() => { this.notice.hidden = true; }, duration);
    }
  }
}
