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

const elements = {
  grid: document.getElementById("videoGrid"),
  emptyState: document.getElementById("emptyState"),
  emptyTitle: document.getElementById("emptyTitle"),
  emptyMessage: document.getElementById("emptyMessage"),
  retryButton: document.getElementById("emptyRetryButton"),
  refreshButton: document.getElementById("refreshButton"),
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

const player = new VideoPlayer();

/** Update the status pill shown above the video grid. */
function setStatus(message, state = "ready") {
  elements.status.querySelector("span:last-child").textContent = message;
  elements.status.classList.toggle("is-scanning", state === "scanning");
  elements.status.classList.toggle("is-error", state === "error");
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
  elements.directoryLabel.title = currentDirectory ? "返回上一级目录" : "当前根目录";
  elements.search.value = "";
  videoList?.setFilter("");
  videoList?.setDirectoryScope(currentDirectory);
  if (historyMode !== "none") writeDirectoryToAddress(currentDirectory, historyMode);
  if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
}

/** Create a fresh renderer and a two-worker lazy thumbnail queue. */
function createVideoList() {
  thumbnails = new ThumbnailGenerator({ concurrency: 2 });
  videoList = new VideoList({
    container: elements.grid,
    emptyState: elements.emptyState,
    emptyTitle: elements.emptyTitle,
    emptyMessage: elements.emptyMessage,
    retryButton: elements.retryButton,
    thumbnailGenerator: thumbnails,
    onPlay: (item, trigger) => player.open(item, trigger),
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
  setStatus("正在扫描目录…", "scanning");

  try {
    const result = await scanVideoDirectory(rootUrl, {
      recursive: true,
      maxDepth: 3,
      signal: scanController.signal,
      onProgress: ({ directories, videos }) => {
        setStatus(`已查看 ${directories} 个目录 · 找到 ${videos} 个视频`, "scanning");
      },
    });

    videoList.render(result.videos, result.directories);
    if (currentDirectory && !result.directories.some((item) => item.relativePath === currentDirectory)) {
      showDirectory("", { historyMode: "replace", scroll: false });
    }
    videoList.setDirectoryScope(currentDirectory);
    videoList.setFilter(elements.search.value);
    const failedSuffix = result.failedDirectories > 0 ? ` · ${result.failedDirectories} 个目录无法读取` : "";
    setStatus(`${result.videos.length} 个视频 · ${result.directories.length} 个文件夹${failedSuffix}`);
  } catch (error) {
    if (error.name === "AbortError") return;
    videoList.showError(`${error.message}。请确认是通过当前 http-server 打开此页面。`);
    setStatus("扫描失败", "error");
  } finally {
    if (!scanController.signal.aborted) {
      elements.refreshButton.classList.remove("is-spinning");
      elements.refreshButton.disabled = false;
    }
  }
}

elements.search.addEventListener("input", () => videoList?.setFilter(elements.search.value));
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

showDirectory(readDirectoryFromAddress(), { historyMode: "replace", scroll: false });
loadLibrary();
