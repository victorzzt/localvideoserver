/** Renders, filters and asynchronously hydrates the YouTube-style video grid. */

import { displayTitle, formatTime } from "./utils.js";
import { t } from "./i18n.js";

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
    playbackEnabled = true,
    onThumbnailProgress,
    onThumbnailsComplete,
  }) {
    this.container = container;
    this.emptyState = emptyState;
    this.emptyTitle = emptyTitle;
    this.emptyMessage = emptyMessage;
    this.retryButton = retryButton;
    this.thumbnailGenerator = thumbnailGenerator;
    this.onPlay = onPlay;
    this.onOpenDirectory = onOpenDirectory;
    this.playbackEnabled = playbackEnabled;
    this.onThumbnailProgress = onThumbnailProgress;
    this.onThumbnailsComplete = onThumbnailsComplete;
    this.items = [];
    this.directories = [];
    this.cards = new Map();
    this.filterText = "";
    this.scopePath = "";
    this.destroyed = false;
  }

  /** Replace all cards, prioritize the current folder, then hydrate every preview. */
  render(items, directories = []) {
    this.destroyed = false;
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
    void this.hydrateAll(items);
    this.applyFilter();
  }

  /** Cache-check every card and report file-wide progress for setup mode. */
  async hydrateAll(items) {
    const progress = { ready: 0, processed: 0, failed: 0, total: items.length };
    this.onThumbnailProgress?.({ ...progress });

    await Promise.all(items.map(async (item) => {
      const loaded = await this.loadThumbnail(item);
      progress.processed += 1;
      if (loaded) progress.ready += 1;
      else progress.failed += 1;
      if (!this.destroyed) this.onThumbnailProgress?.({ ...progress });
    }));

    this.thumbnailGenerator.seal();
    if (!this.destroyed) this.onThumbnailsComplete?.({ ...progress });
  }

  /** Build a 16:9 folder card that enters the supplied relative directory. */
  createDirectoryCard(directory) {
    const element = document.createElement("article");
    element.className = "video-card folder-card";

    const button = document.createElement("button");
    button.className = "video-card-button";
    button.type = "button";
    button.setAttribute("aria-label", t("openFolder", { path: directory.relativePath }));

    const thumbnail = document.createElement("div");
    thumbnail.className = "thumbnail-wrap folder-thumbnail";
    const folderVisual = document.createElement("span");
    folderVisual.className = "folder-visual";
    folderVisual.append(createIcon("folder"));
    const typeLabel = document.createElement("span");
    typeLabel.className = "folder-type-label";
    typeLabel.textContent = t("folderType");
    const title = document.createElement("h2");
    title.className = "thumbnail-title";
    title.textContent = directory.name;
    title.title = directory.relativePath;
    const count = document.createElement("span");
    count.className = "duration-badge folder-count";
    count.textContent = t("folderVideoCount", { count: directory.videoCount });
    thumbnail.append(folderVisual, typeLabel, title, count);

    button.append(thumbnail);
    button.addEventListener("click", () => this.onOpenDirectory?.(directory, button));
    element.append(button);
    return { element, button, typeLabel, count };
  }

  /** Build one video card; its actual frame image is populated only when near view. */
  createCard(item) {
    const element = document.createElement("article");
    element.className = "video-card";

    const button = document.createElement("button");
    button.className = "video-card-button";
    button.type = "button";
    button.disabled = !this.playbackEnabled;
    button.setAttribute(
      "aria-label",
      t(this.playbackEnabled ? "playVideo" : "thumbnailPending", { title: item.title }),
    );

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
    button.addEventListener("click", () => {
      if (this.playbackEnabled) this.onPlay(item, button);
    });
    element.append(button);

    return { element, button, image, thumbnailWrap, duration, item, requested: false };
  }

  /** Hydrate a single card and gracefully keep the placeholder on decode failure. */
  async loadThumbnail(item) {
    const card = this.cards.get(item.url);
    if (!card || card.requested) return false;
    card.requested = true;

    try {
      let result = await this.thumbnailGenerator.getCached(item.url);
      if (!result) {
        result = await this.thumbnailGenerator.enqueue(item.url);
        await this.thumbnailGenerator.cacheResult(item.url, result);
      }
      if (this.cards.get(item.url) !== card) return false;
      item.duration = result.duration;
      card.duration.textContent = formatTime(result.duration);
      card.image.addEventListener("load", () => {
        card.image.classList.add("is-ready");
        card.thumbnailWrap.classList.add("has-image");
      }, { once: true });
      card.objectUrl = URL.createObjectURL(result.blob);
      card.image.src = card.objectUrl;
      card.element.classList.add("is-thumbnail-ready");
      return true;
    } catch (error) {
      if (error.name !== "AbortError" && this.cards.get(item.url) === card) {
        card.thumbnailWrap.classList.add("has-error");
        card.duration.textContent = "MP4";
      }
      return false;
    }
  }

  /** Lock setup-mode cards until every thumbnail in the recursive scan is ready. */
  setPlaybackEnabled(enabled) {
    this.playbackEnabled = Boolean(enabled);
    for (const item of this.items) {
      const card = this.cards.get(item.url);
      if (!card) continue;
      card.button.disabled = !this.playbackEnabled;
      card.button.setAttribute(
        "aria-label",
        t(this.playbackEnabled ? "playVideo" : "thumbnailPending", { title: item.title }),
      );
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
        return item.directory === this.scopePath;
      })
      .map((item) => item.url);
    this.thumbnailGenerator.prioritize(urls);
  }

  /** Recompute visibility by combining directory scope and free-text search. */
  applyFilter() {
    let visible = 0;

    for (const directory of this.directories) {
      const isInsideScope = directory.parent === this.scopePath;
      const matchesSearch = !this.filterText ||
        `${directory.name} ${directory.relativePath}`.toLocaleLowerCase().includes(this.filterText);
      const matches = isInsideScope && matchesSearch;
      const card = this.cards.get(directory.url);
      if (card) card.element.hidden = !matches;
      if (matches) visible += 1;
    }

    for (const item of this.items) {
      const isInsideScope = item.directory === this.scopePath;
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
      this.emptyTitle.textContent = t("noVideosTitle");
      this.emptyMessage.textContent = t("noVideosMessage");
      this.retryButton.hidden = false;
    } else if (visible === 0 && this.filterText) {
      this.emptyTitle.textContent = t("noMatchesTitle");
      this.emptyMessage.textContent = t("noMatchesMessage");
      this.retryButton.hidden = true;
    } else if (visible === 0) {
      this.emptyTitle.textContent = t("emptyFolderTitle");
      this.emptyMessage.textContent = t("emptyFolderMessage");
      this.retryButton.hidden = false;
    }
  }

  /** Refresh dynamic card labels and empty-state copy after a language toggle. */
  updateLanguage() {
    for (const directory of this.directories) {
      const card = this.cards.get(directory.url);
      if (!card) continue;
      card.button.setAttribute("aria-label", t("openFolder", { path: directory.relativePath }));
      card.typeLabel.textContent = t("folderType");
      card.count.textContent = t("folderVideoCount", { count: directory.videoCount });
    }
    for (const item of this.items) {
      this.cards.get(item.url)?.button.setAttribute(
        "aria-label",
        t(this.playbackEnabled ? "playVideo" : "thumbnailPending", { title: item.title }),
      );
    }
    this.applyFilter();
  }

  /** Replace the grid with the shared error state. */
  showError(message) {
    this.container.hidden = true;
    this.emptyState.hidden = false;
    this.emptyTitle.textContent = t("directoryReadFailed");
    this.emptyMessage.textContent = message;
    this.retryButton.hidden = false;
  }

  /** Drop card references before a new scan replaces the list and queue. */
  destroy() {
    this.destroyed = true;
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
