/** Renders, filters and asynchronously hydrates the YouTube-style video grid. */

import { displayTitle, formatTime } from "./utils.js";

function createIcon(iconName) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#icon-${iconName}`);
  svg.append(use);
  return svg;
}

/**
 * Owns the mixed folder/video card grid, text filtering, directory scoping, and
 * Worker-queued thumbnail hydration.
 *
 * Usage: create one instance per scan, call `render(videos, directories)`, then
 * call `setDirectoryScope("A001")` as the user navigates. All video cards are
 * submitted at render time; the Worker limits actual decoding concurrency.
 */
export class VideoList {
  constructor({
    container,
    emptyState,
    emptyTitle,
    emptyMessage,
    retryButton,
    thumbnailGenerator,
    onPlay,
    onOpenDirectory,
  }) {
    this.container = container;
    this.emptyState = emptyState;
    this.emptyTitle = emptyTitle;
    this.emptyMessage = emptyMessage;
    this.retryButton = retryButton;
    this.thumbnailGenerator = thumbnailGenerator;
    this.onPlay = onPlay;
    this.onOpenDirectory = onOpenDirectory;
    this.items = [];
    this.directories = [];
    this.cards = new Map();
    this.filterText = "";
    this.scopePath = "";
  }

  /** Replace all cards, prioritize the current folder, then hydrate every preview. */
  render(items, directories = []) {
    this.releaseObjectUrls();
    this.container.replaceChildren();
    this.cards.clear();
    this.items = items;
    this.directories = directories;

    for (const directory of directories) {
      const card = this.createDirectoryCard(directory);
      this.container.append(card.element);
      this.cards.set(directory.url, card);
    }

    for (const item of items) {
      item.title = displayTitle(item.fileName);
      const card = this.createCard(item);
      this.container.append(card.element);
      this.cards.set(item.url, card);
    }

    this.updateThumbnailPriority();
    this.hydrateAll(items);
    this.applyFilter();
  }

  /** Cache-check all cards in parallel and seal the Worker after all work settles. */
  async hydrateAll(items) {
    await Promise.allSettled(items.map((item) => this.loadThumbnail(item)));
    this.thumbnailGenerator.seal();
  }

  /** Build a 16:9 folder card that enters the supplied relative directory. */
  createDirectoryCard(directory) {
    const element = document.createElement("article");
    element.className = "video-card folder-card";

    const button = document.createElement("button");
    button.className = "video-card-button";
    button.type = "button";
    button.setAttribute("aria-label", `打开文件夹 ${directory.relativePath}`);

    const thumbnail = document.createElement("div");
    thumbnail.className = "thumbnail-wrap folder-thumbnail";
    const folderVisual = document.createElement("span");
    folderVisual.className = "folder-visual";
    folderVisual.append(createIcon("folder"));
    const typeLabel = document.createElement("span");
    typeLabel.className = "folder-type-label";
    typeLabel.textContent = "FOLDER";
    const title = document.createElement("h2");
    title.className = "thumbnail-title";
    title.textContent = directory.name;
    title.title = directory.relativePath;
    const count = document.createElement("span");
    count.className = "duration-badge folder-count";
    count.textContent = `${directory.videoCount} 个视频`;
    thumbnail.append(folderVisual, typeLabel, title, count);

    button.append(thumbnail);
    button.addEventListener("click", () => this.onOpenDirectory?.(directory, button));
    element.append(button);
    return { element };
  }

  /** Build one video card; its actual frame image is populated only when near view. */
  createCard(item) {
    const element = document.createElement("article");
    element.className = "video-card";

    const button = document.createElement("button");
    button.className = "video-card-button";
    button.type = "button";
    button.setAttribute("aria-label", `播放 ${item.title}`);

    const thumbnailWrap = document.createElement("div");
    thumbnailWrap.className = "thumbnail-wrap";
    const image = document.createElement("img");
    image.className = "thumbnail-image";
    image.alt = "";
    image.decoding = "async";

    const placeholder = document.createElement("span");
    placeholder.className = "thumbnail-placeholder";
    placeholder.append(createIcon("video"));

    const playMark = document.createElement("span");
    playMark.className = "thumbnail-play";
    playMark.append(createIcon("play"));

    const duration = document.createElement("span");
    duration.className = "duration-badge";
    duration.textContent = "--:--";
    const title = document.createElement("h2");
    title.className = "thumbnail-title";
    title.textContent = item.title;
    title.title = item.fileName;

    thumbnailWrap.append(image, placeholder, playMark, title, duration);
    button.append(thumbnailWrap);
    button.addEventListener("click", () => this.onPlay(item, button));
    element.append(button);

    return { element, image, thumbnailWrap, duration, requested: false };
  }

  /** Hydrate a single card and gracefully keep the placeholder on decode failure. */
  async loadThumbnail(item) {
    const card = this.cards.get(item.url);
    if (!card || card.requested) return;
    card.requested = true;

    try {
      let result = await this.thumbnailGenerator.getCached(item.url);
      if (!result) {
        result = await this.thumbnailGenerator.enqueue(item.url);
        this.thumbnailGenerator.cacheResult(item.url, result);
      }
      if (this.cards.get(item.url) !== card) return;
      item.duration = result.duration;
      card.duration.textContent = formatTime(result.duration);
      card.image.addEventListener("load", () => {
        card.image.classList.add("is-ready");
        card.thumbnailWrap.classList.add("has-image");
      }, { once: true });
      card.objectUrl = URL.createObjectURL(result.blob);
      card.image.src = card.objectUrl;
    } catch (error) {
      if (error.name !== "AbortError" && this.cards.get(item.url) === card) {
        card.thumbnailWrap.classList.add("has-error");
        card.duration.textContent = "MP4";
      }
    }
  }

  /** Apply a case-insensitive name/path search within the active directory scope. */
  setFilter(value) {
    this.filterText = value.trim().toLocaleLowerCase();
    this.applyFilter();
  }

  /**
   * Limit visible entries to direct children of a relative path.
   * An empty string selects root. Descendant videos remain hidden until their
   * immediate parent folder is entered, preventing very long flattened lists.
   */
  setDirectoryScope(relativePath = "") {
    this.scopePath = relativePath.replace(/^\/+|\/+$/g, "");
    this.updateThumbnailPriority();
    this.applyFilter();
  }

  /** Tell the Worker which directly visible video URLs should occupy its slots first. */
  updateThumbnailPriority() {
    const urls = this.items
      .filter((item) => {
        const parentPath = item.directory === "当前目录" ? "" : item.directory;
        return parentPath === this.scopePath;
      })
      .map((item) => item.url);
    this.thumbnailGenerator.prioritize(urls);
  }

  /** Recompute visibility by combining directory scope and free-text search. */
  applyFilter() {
    let visible = 0;

    for (const directory of this.directories) {
      const parentPath = directory.parent === "当前目录" ? "" : directory.parent;
      const isInsideScope = parentPath === this.scopePath;
      const matchesSearch = !this.filterText ||
        `${directory.name} ${directory.relativePath}`.toLocaleLowerCase().includes(this.filterText);
      const matches = isInsideScope && matchesSearch;
      const card = this.cards.get(directory.url);
      if (card) card.element.hidden = !matches;
      if (matches) visible += 1;
    }

    for (const item of this.items) {
      const parentPath = item.directory === "当前目录" ? "" : item.directory;
      const isInsideScope = parentPath === this.scopePath;
      const matchesSearch = !this.filterText ||
        `${item.title} ${item.relativePath}`.toLocaleLowerCase().includes(this.filterText);
      const matches = isInsideScope && matchesSearch;
      const card = this.cards.get(item.url);
      if (card) card.element.hidden = !matches;
      if (matches) visible += 1;
    }

    this.container.hidden = visible === 0;
    this.emptyState.hidden = visible !== 0;

    if (this.items.length + this.directories.length === 0) {
      this.emptyTitle.textContent = "没有找到 MP4 视频";
      this.emptyMessage.textContent = "把视频放进当前目录或子目录，然后重新扫描。";
      this.retryButton.hidden = false;
    } else if (visible === 0 && this.filterText) {
      this.emptyTitle.textContent = "没有匹配的视频";
      this.emptyMessage.textContent = "换一个关键词试试。";
      this.retryButton.hidden = true;
    } else if (visible === 0) {
      this.emptyTitle.textContent = "这个文件夹是空的";
      this.emptyMessage.textContent = "当前文件夹没有直属视频或子文件夹。";
      this.retryButton.hidden = false;
    }
  }

  /** Replace the grid with the shared error state. */
  showError(message) {
    this.container.hidden = true;
    this.emptyState.hidden = false;
    this.emptyTitle.textContent = "目录读取失败";
    this.emptyMessage.textContent = message;
    this.retryButton.hidden = false;
  }

  /** Drop card references before a new scan replaces the list and queue. */
  destroy() {
    this.releaseObjectUrls();
    this.cards.clear();
  }

  /** Release Blob URLs created from IndexedDB/generated JPEG data. */
  releaseObjectUrls() {
    for (const card of this.cards.values()) {
      if (card.objectUrl) URL.revokeObjectURL(card.objectUrl);
    }
  }
}
