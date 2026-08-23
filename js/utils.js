/** Shared formatting and DOM helpers used by list, thumbnails, and player. */

/** Convert media seconds to `m:ss`, or `h:mm:ss` for long videos. */
export function formatTime(value) {
  if (!Number.isFinite(value) || value < 0) return "0:00";

  const totalSeconds = Math.floor(value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Remove only the final `.mp4` extension while preserving the original name. */
export function displayTitle(fileName) {
  return fileName.replace(/\.mp4$/i, "");
}

/** Decode each URL path segment without failing the whole path on bad encoding. */
export function decodeUrlPath(pathname) {
  return pathname
    .split("/")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .join("/");
}

/** Swap the SVG symbol used by a control button, e.g. play -> pause. */
export function setButtonIcon(button, iconName) {
  button.querySelector("use")?.setAttribute("href", `#icon-${iconName}`);
}

/** Create the conventional error used to reject work removed from async queues. */
export function abortError() {
  return new DOMException("Operation aborted", "AbortError");
}
