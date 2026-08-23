/**
 * Reads HTML directory indexes exposed by static servers such as npm http-server.
 * It follows ordinary subdirectory links and returns same-origin MP4 file URLs.
 */

import { decodeUrlPath } from "./utils.js";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".svn",
  "node_modules",
  "css",
  "js",
]);

const naturalOrder = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function directoryUrl(input) {
  const url = new URL(input);
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function isInsideRoot(pathname, rootPath) {
  return pathname === rootPath || pathname.startsWith(rootPath);
}

function lastPathPart(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  return decodeUrlPath(parts.at(-1) || "");
}

function relativePath(url, rootPath) {
  return decodeUrlPath(url.pathname.slice(rootPath.length));
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException("Directory scan aborted", "AbortError");
  }
}

/**
 * Recursively parse same-origin HTML directory indexes for folders and MP4s.
 *
 * `startUrl` must point to a directory listing produced by a static server.
 * `maxDepth` counts root children as level 1 and defaults to 3. Pass an
 * AbortSignal when a refresh should cancel an older scan.
 *
 * Usage:
 *   const result = await scanVideoDirectory(new URL("./", location.href), {
 *     maxDepth: 3,
 *     onProgress: ({ videos }) => console.log(videos),
 *   });
 *
 * Returns sorted `{ videos, directories, visitedDirectories,
 * failedDirectories }`. CSS, JS, VCS, hidden, and node_modules folders are
 * excluded before they can enter the recursive queue.
 */
export async function scanVideoDirectory(startUrl, options = {}) {
  const {
    recursive = true,
    maxDepth = 3,
    signal,
    onProgress = () => {},
  } = options;

  const root = directoryUrl(startUrl);
  const rootPath = root.pathname;
  const pending = [{ url: root, depth: 0 }];
  const visited = new Set();
  const videos = new Map();
  const directories = new Map();
  let failedDirectories = 0;

  while (pending.length > 0) {
    throwIfAborted(signal);
    const entry = pending.shift();
    const key = entry.url.href;
    if (visited.has(key)) continue;
    visited.add(key);

    let response;
    try {
      response = await fetch(entry.url, {
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (error.name === "AbortError") throw error;
      if (entry.depth === 0) {
        throw new Error(`无法读取目录索引（${error.message}）`);
      }
      failedDirectories += 1;
      continue;
    }

    const html = await response.text();
    const documentIndex = new DOMParser().parseFromString(html, "text/html");
    const anchors = documentIndex.querySelectorAll("a[href]");

    for (const anchor of anchors) {
      const rawHref = anchor.getAttribute("href")?.trim();
      if (
        !rawHref ||
        rawHref.startsWith("#") ||
        rawHref.startsWith("?") ||
        /^(?:javascript|mailto|data):/i.test(rawHref)
      ) {
        continue;
      }

      let target;
      try {
        target = new URL(rawHref, entry.url);
      } catch {
        continue;
      }

      target.hash = "";
      target.search = "";
      if (target.origin !== root.origin || !isInsideRoot(target.pathname, rootPath)) continue;
      if (target.pathname === entry.url.pathname) continue;

      const linkLooksLikeDirectory =
        target.pathname.endsWith("/") || anchor.textContent.trim().endsWith("/");

      if (linkLooksLikeDirectory) {
        const nextDepth = entry.depth + 1;
        if (nextDepth > maxDepth) continue;
        const directoryName = lastPathPart(target.pathname);
        if (
          !directoryName ||
          directoryName.startsWith(".") ||
          IGNORED_DIRECTORIES.has(directoryName.toLocaleLowerCase())
        ) {
          continue;
        }

        const normalizedDirectory = directoryUrl(target);
        const path = relativePath(normalizedDirectory, rootPath).replace(/\/$/, "");
        directories.set(normalizedDirectory.href, {
          url: normalizedDirectory.href,
          name: directoryName,
          relativePath: path,
          parent: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "当前目录",
        });

        if (recursive) {
          pending.push({ url: normalizedDirectory, depth: nextDepth });
        }
        continue;
      }

      if (!/\.mp4$/i.test(target.pathname)) continue;
      const path = relativePath(target, rootPath);
      const fileName = path.split("/").at(-1) || path;
      videos.set(target.href, {
        url: target.href,
        fileName,
        relativePath: path,
        directory: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "当前目录",
      });
    }

    onProgress({
      directories: visited.size,
      folders: directories.size,
      videos: videos.size,
      queuedDirectories: pending.length,
    });
  }

  // Folder badges reflect only directly contained videos, matching single-level browsing.
  const sortedVideos = [...videos.values()].sort((a, b) => naturalOrder.compare(a.relativePath, b.relativePath));
  const sortedDirectories = [...directories.values()]
    .map((directory) => ({
      ...directory,
      videoCount: sortedVideos.filter((video) => video.directory === directory.relativePath).length,
    }))
    .sort((a, b) => naturalOrder.compare(a.relativePath, b.relativePath));

  return {
    videos: sortedVideos,
    directories: sortedDirectories,
    visitedDirectories: visited.size,
    failedDirectories,
  };
}
