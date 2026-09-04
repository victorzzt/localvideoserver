/**
 * Application entry point.
 *
 * Startup flow: read `?dir=` -> scan directory indexes -> render cards -> play.
 * Directory changes are stored in the URL, so reload and browser history keep
 * the user in the same virtual folder without requiring server-side routing.
 */

import { scanVideoDirectory } from "./directory-scanner.js";
import { ThumbnailGenerator } from "./thumbnail-generator.js";
import { VideoList } from "./video-list.js";
import { VideoPlayer } from "./player.js";
import { initializeLanguage, t, toggleLanguage } from "./i18n.js";

// Apply the saved preference before controllers render their first UI state.
initializeLanguage();

const elements = {
  grid: document.getElementById("videoGrid"),
  emptyState: document.getElementById("emptyState"),
  emptyTitle: document.getElementById("emptyTitle"),
  emptyMessage: document.getElementById("emptyMessage"),
  retryButton: document.getElementById("emptyRetryButton"),
  refreshButton: document.getElementById("refreshButton"),
  languageToggle: document.getElementById("languageToggle"),
  search: document.getElementById("videoSearch"),
  status: document.getElementById("scanStatus"),
  directoryLabel: document.getElementById("directoryLabel"),
  directoryLabelText: document.getElementById("directoryLabelText"),
  brandHome: document.getElementById("brandHome"),
  setupProgress: document.getElementById("setupProgress"),
  setupProgressBar: document.getElementById("setupProgressBar"),
  setupPanel: document.getElementById("setupPanel"),
  setupSummary: document.getElementById("setupSummary"),
  downloadCacheButton: document.getElementById("downloadCacheButton"),
};

const rootUrl = new URL("./", window.location.href);
const setupMode = new URL(window.location.href).searchParams.get("setup") === "true";

document.body.classList.toggle("setup-mode", setupMode);
elements.setupProgress.hidden = !setupMode;
elements.setupPanel.hidden = !setupMode;
if (setupMode) {
  const setupHome = new URL("./videolist.html", window.location.href);
  setupHome.searchParams.set("setup", "true");
  elements.brandHome.href = setupHome;
}

let scanController = null;
let thumbnails = null;
let videoList = null;
let currentDirectory = "";
let currentStatus = { key: "scanningEllipsis", values: {}, state: "scanning" };
let currentScanError = null;
let libraryLoadInProgress = false;
let playerOpening = false;
let scannedVideos = [];
let setupThumbnailState = { ready: 0, processed: 0, failed: 0, total: 0, finished: false };
let setupExportState = "idle";

const player = new VideoPlayer({
  // The video source is released before onClose runs, so preview connections
  // can safely resume without competing with playback.
  onClose: () => thumbnails?.resume(),
});

/** Store and render the status pill so it can be translated without rescanning. */
function setStatus(key, state = "ready", values = {}) {
  currentStatus = { key, state, values };
  elements.status.querySelector("span:last-child").textContent = t(key, values);
  elements.status.classList.toggle("is-scanning", state === "scanning");
  elements.status.classList.toggle("is-error", state === "error");
}

/** Render setup progress from completed thumbnails rather than elapsed time. */
function renderSetupProgress() {
  if (!setupMode) return;
  const { ready, failed, total, finished } = setupThumbnailState;
  const allReady = finished && total > 0 && ready === total && failed === 0;
  const percentage = total > 0 ? Math.min(100, (ready / total) * 100) : 0;

  elements.setupProgressBar.style.width = `${percentage}%`;
  elements.setupProgress.setAttribute("aria-valuemax", String(total));
  elements.setupProgress.setAttribute("aria-valuenow", String(ready));
  elements.setupProgress.classList.toggle("is-complete", allReady);

  if (setupExportState === "preparing") {
    elements.setupSummary.textContent = t("preparingThumbnailCache");
  } else if (setupExportState === "error") {
    elements.setupSummary.textContent = t("thumbnailCacheDownloadFailed");
  } else if (finished && failed > 0) {
    elements.setupSummary.textContent = t("setupFailed", { ready, total, failed });
  } else if (allReady) {
    elements.setupSummary.textContent = t("setupReady", { total });
  } else if (total > 0) {
    elements.setupSummary.textContent = t("setupCaching", { ready, total });
  } else {
    elements.setupSummary.textContent = t("setupWaiting");
  }

  elements.downloadCacheButton.textContent = t(
    setupExportState === "preparing" ? "preparingThumbnailCache" : "downloadThumbnailCache",
  );
  elements.downloadCacheButton.disabled = !allReady || setupExportState === "preparing";
}

/** Update the count while the four-slot queue resolves cache hits and captures. */
function updateSetupProgress(progress, finished = false) {
  if (!setupMode) return;
  setupThumbnailState = { ...progress, finished };
  setupExportState = "idle";
  renderSetupProgress();
}

/** Refresh path affordances whose wording depends on the selected language. */
function updateDirectoryLabel() {
  elements.directoryLabel.title = currentDirectory ? t("goUp") : t("currentRoot");
}

function localizedScanError(error) {
  const message = error?.i18nKey ? t(error.i18nKey, error.i18nValues) : error?.message;
  return t("serverReadHint", { message: message || t("scanFailed") });
}

/**
 * Normalize an untrusted GET parameter or card path into a safe relative path.
 * The scanner only supports three directory levels, so URL state follows the
 * same limit. `.` and `..` are discarded to prevent navigation outside root.
 */
function normalizeDirectoryPath(value = "") {
  return String(value)
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .slice(0, 3)
    .join("/");
}

/** Read the current folder from a URL such as `videolist.html?dir=A001/B001`. */
function readDirectoryFromAddress() {
  return normalizeDirectoryPath(new URL(window.location.href).searchParams.get("dir") || "");
}

/**
 * Write the current folder to the GET address without reloading the document.
 * `push` is used for user navigation; `replace` initializes or repairs state.
 */
function writeDirectoryToAddress(relativePath, mode = "push") {
  const url = new URL(window.location.href);
  if (relativePath) url.searchParams.set("dir", relativePath);
  else url.searchParams.delete("dir");
  const method = mode === "replace" ? "replaceState" : "pushState";
  window.history[method]({ directory: relativePath }, "", url);
}

/**
 * Enter a virtual folder and update the path pill, filtering, scroll position,
 * and optionally the browser address.
 *
 * Usage: `showDirectory("A001/B001")` for a user click, or pass
 * `{ historyMode: "none" }` while handling a browser Back/Forward event.
 */
function showDirectory(relativePath = "", options = {}) {
  const { historyMode = "push", scroll = true } = options;
  currentDirectory = normalizeDirectoryPath(relativePath);
  elements.directoryLabelText.textContent = currentDirectory ? `/${currentDirectory}` : "/";
  elements.directoryLabel.disabled = !currentDirectory;
  updateDirectoryLabel();
  elements.search.value = "";
  videoList?.setFilter("");
  videoList?.setDirectoryScope(currentDirectory);
  if (historyMode !== "none") writeDirectoryToAddress(currentDirectory, historyMode);
  if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
}

/** Create a fresh renderer and a Worker queue fixed at four preview requests. */
function createVideoList() {
  thumbnails = new ThumbnailGenerator({ concurrency: 4 });
  const list = new VideoList({
    container: elements.grid,
    emptyState: elements.emptyState,
    emptyTitle: elements.emptyTitle,
    emptyMessage: elements.emptyMessage,
    retryButton: elements.retryButton,
    thumbnailGenerator: thumbnails,
    playbackEnabled: !setupMode,
    onThumbnailProgress: (progress) => {
      if (videoList === list) updateSetupProgress(progress, false);
    },
    onThumbnailsComplete: (progress) => {
      if (videoList !== list) return;
      const allReady = progress.total > 0 && progress.ready === progress.total && progress.failed === 0;
      list.setPlaybackEnabled(!setupMode || allReady);
      updateSetupProgress(progress, true);
    },
    onPlay: async (item, trigger) => {
      if (playerOpening || player.active) return;
      playerOpening = true;
      const activeQueue = thumbnails;
      try {
        await activeQueue?.pause();
        if (activeQueue === thumbnails) player.open(item, trigger);
      } finally {
        playerOpening = false;
      }
    },
    onOpenDirectory: (directory) => {
      showDirectory(directory.relativePath);
    },
  });
  videoList = list;
}

/**
 * Abort any previous scan, recursively read up to three levels, and render the
 * resulting folder/video cards. Call this after files change on the server.
 */
async function loadLibrary() {
  if (libraryLoadInProgress) return;
  libraryLoadInProgress = true;
  elements.refreshButton.classList.add("is-spinning");
  elements.refreshButton.disabled = true;
  currentScanError = null;
  scannedVideos = [];
  if (setupMode) {
    setupThumbnailState = { ready: 0, processed: 0, failed: 0, total: 0, finished: false };
    setupExportState = "idle";
    renderSetupProgress();
  }
  setStatus("scanningDirectory", "scanning");

  scanController?.abort();
  videoList?.destroy();
  const previousThumbnails = thumbnails;
  thumbnails = null;
  await previousThumbnails?.dispose();
  scanController = new AbortController();
  createVideoList();

  elements.grid.hidden = false;
  elements.emptyState.hidden = true;

  try {
    const result = await scanVideoDirectory(rootUrl, {
      recursive: true,
      maxDepth: 3,
      signal: scanController.signal,
      onProgress: ({ directories, videos }) => {
        setStatus("scanProgress", "scanning", { directories, videos });
      },
    });

    scannedVideos = result.videos;
    videoList.render(result.videos, result.directories);
    if (currentDirectory && !result.directories.some((item) => item.relativePath === currentDirectory)) {
      showDirectory("", { historyMode: "replace", scroll: false });
    }
    videoList.setDirectoryScope(currentDirectory);
    videoList.setFilter(elements.search.value);
    setStatus("scanComplete", "ready", {
      videos: result.videos.length,
      folders: result.directories.length,
      failed: result.failedDirectories,
    });
  } catch (error) {
    if (error.name === "AbortError") return;
    currentScanError = error;
    videoList.showError(localizedScanError(error));
    setStatus("scanFailed", "error");
  } finally {
    libraryLoadInProgress = false;
    if (!scanController.signal.aborted) {
      elements.refreshButton.classList.remove("is-spinning");
      elements.refreshButton.disabled = false;
    }
  }
}

/** Build the obfuscated cache only after every video in this scan is ready. */
async function downloadThumbnailCache() {
  const { ready, failed, total, finished } = setupThumbnailState;
  if (
    !setupMode ||
    !finished ||
    total === 0 ||
    ready !== total ||
    failed > 0 ||
    setupExportState === "preparing"
  ) {
    return;
  }

  const activeGenerator = thumbnails;
  setupExportState = "preparing";
  renderSetupProgress();
  elements.refreshButton.disabled = true;

  try {
    const file = await activeGenerator.createCacheFile(scannedVideos);
    if (activeGenerator !== thumbnails) return;
    const downloadUrl = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = "thumbnail.cache";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    setupExportState = "idle";
  } catch (error) {
    console.error("Could not create thumbnail.cache:", error);
    setupExportState = "error";
  } finally {
    if (!libraryLoadInProgress) elements.refreshButton.disabled = false;
    renderSetupProgress();
  }
}

elements.search.addEventListener("input", () => videoList?.setFilter(elements.search.value));
elements.languageToggle.addEventListener("click", toggleLanguage);
elements.directoryLabel.addEventListener("click", () => {
  const parts = currentDirectory.split("/").filter(Boolean);
  parts.pop();
  showDirectory(parts.join("/"));
});
elements.refreshButton.addEventListener("click", loadLibrary);
elements.retryButton.addEventListener("click", loadLibrary);
elements.downloadCacheButton.addEventListener("click", downloadThumbnailCache);
window.addEventListener("popstate", () => {
  showDirectory(readDirectoryFromAddress(), { historyMode: "none" });
});
window.addEventListener("beforeunload", () => {
  scanController?.abort();
  void thumbnails?.dispose();
});
window.addEventListener("languagechange", () => {
  updateDirectoryLabel();
  setStatus(currentStatus.key, currentStatus.state, currentStatus.values);
  videoList?.updateLanguage();
  player.updateLanguage();
  renderSetupProgress();
  if (currentScanError) videoList?.showError(localizedScanError(currentScanError));
});

showDirectory(readDirectoryFromAddress(), { historyMode: "replace", scroll: false });
renderSetupProgress();
loadLibrary();
