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
};

const rootUrl = new URL("./", window.location.href);

let scanController = null;
let thumbnails = null;
let videoList = null;
let currentDirectory = "";
let currentStatus = { key: "scanningEllipsis", values: {}, state: "scanning" };
let currentScanError = null;

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

/** Create a fresh renderer and a Worker queue capped at four preview requests. */
function createVideoList() {
  thumbnails = new ThumbnailGenerator({ concurrency: 4 });
  videoList = new VideoList({
    container: elements.grid,
    emptyState: elements.emptyState,
    emptyTitle: elements.emptyTitle,
    emptyMessage: elements.emptyMessage,
    retryButton: elements.retryButton,
    thumbnailGenerator: thumbnails,
    onPlay: (item, trigger) => {
      thumbnails?.pause();
      player.open(item, trigger);
    },
    onOpenDirectory: (directory) => {
      showDirectory(directory.relativePath);
    },
  });
}

/**
 * Abort any previous scan, recursively read up to three levels, and render the
 * resulting folder/video cards. Call this after files change on the server.
 */
async function loadLibrary() {
  scanController?.abort();
  videoList?.destroy();
  thumbnails?.dispose();
  scanController = new AbortController();
  createVideoList();

  elements.grid.hidden = false;
  elements.emptyState.hidden = true;
  elements.refreshButton.classList.add("is-spinning");
  elements.refreshButton.disabled = true;
  currentScanError = null;
  setStatus("scanningDirectory", "scanning");

  try {
    const result = await scanVideoDirectory(rootUrl, {
      recursive: true,
      maxDepth: 3,
      signal: scanController.signal,
      onProgress: ({ directories, videos }) => {
        setStatus("scanProgress", "scanning", { directories, videos });
      },
    });

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
    if (!scanController.signal.aborted) {
      elements.refreshButton.classList.remove("is-spinning");
      elements.refreshButton.disabled = false;
    }
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
window.addEventListener("popstate", () => {
  showDirectory(readDirectoryFromAddress(), { historyMode: "none" });
});
window.addEventListener("beforeunload", () => {
  scanController?.abort();
  thumbnails?.dispose();
});
window.addEventListener("languagechange", () => {
  updateDirectoryLabel();
  setStatus(currentStatus.key, currentStatus.state, currentStatus.values);
  videoList?.updateLanguage();
  player.updateLanguage();
  if (currentScanError) videoList?.showError(localizedScanError(currentScanError));
});

showDirectory(readDirectoryFromAddress(), { historyMode: "replace", scroll: false });
loadLibrary();
