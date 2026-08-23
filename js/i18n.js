/**
 * Minimal English/Chinese localization shared by the library and player.
 *
 * English is the first-run default. The selected language is stored for this
 * origin in LocalStorage and restored on reload or directory navigation.
 */

const STORAGE_KEY = "local-video-library-language";

const messages = {
  en: {
    brandHomeLabel: "Return to the video library",
    searchPlaceholder: "Search local videos",
    refreshDirectory: "Rescan folders",
    switchToChinese: "Switch language to Chinese",
    switchToEnglish: "Switch language to English",
    locationAndStatus: "Folder location and scan status",
    goUp: "Go to parent folder",
    currentRoot: "Current root folder",
    scanningEllipsis: "Scanning…",
    localVideos: "Local videos",
    noVideosTitle: "No MP4 videos found",
    noVideosMessage: "Add videos to this folder or a subfolder, then rescan.",
    noMatchesTitle: "No matching videos",
    noMatchesMessage: "Try a different search term.",
    emptyFolderTitle: "This folder is empty",
    emptyFolderMessage: "This folder has no direct videos or subfolders.",
    directoryReadFailed: "Could not read the folder",
    rescan: "Rescan",
    videoPlayer: "Video player",
    backToList: "Back to video list",
    nowPlaying: "NOW PLAYING",
    video: "Video",
    mirrorVideo: "Mirror video horizontally",
    unmirrorVideo: "Stop mirroring video",
    secondsShort: "sec",
    play: "Play",
    pause: "Pause",
    loading: "Loading",
    exitFullscreen: "Exit fullscreen",
    enterFullscreen: "Enter fullscreen",
    threeFingerExit: "Swipe down with three fingers to exit fullscreen",
    videoProgress: "Video progress",
    volume: "Volume",
    mute: "Mute",
    unmute: "Unmute",
    playerHelp: "Double-click / double-tap the left or right side to seek back or forward 10 seconds",
    noScript: "JavaScript is required to read folders and generate video previews.",
    folderType: "FOLDER",
    openFolder: ({ path }) => `Open folder ${path}`,
    playVideo: ({ title }) => `Play ${title}`,
    folderVideoCount: ({ count }) => `${count} ${count === 1 ? "video" : "videos"}`,
    timelineValue: ({ current, duration }) => `${current}, total duration ${duration}`,
    scanningDirectory: "Scanning folders…",
    scanProgress: ({ directories, videos }) =>
      `Scanned ${directories} ${directories === 1 ? "folder" : "folders"} · Found ${videos} ${videos === 1 ? "video" : "videos"}`,
    scanComplete: ({ videos, folders, failed }) => {
      const result = `${videos} ${videos === 1 ? "video" : "videos"} · ${folders} ${folders === 1 ? "folder" : "folders"}`;
      return failed > 0 ? `${result} · ${failed} unreadable ${failed === 1 ? "folder" : "folders"}` : result;
    },
    scanFailed: "Scan failed",
    directoryIndexError: ({ message }) => `Could not read the directory index (${message})`,
    serverReadHint: ({ message }) => `${message}. Make sure this page is opened through the current HTTP server.`,
    videoPlaybackError: "This video cannot be played. Its codec may not be supported by the browser.",
    autoplayBlocked: "The browser blocked autoplay. Tap play again.",
    fullscreenUnsupported: "This browser does not support webpage fullscreen.",
    fullscreenDenied: "The browser did not allow fullscreen.",
    fullscreenEscapeHint: "Press Esc to exit fullscreen.",
  },
  zh: {
    brandHomeLabel: "返回视频库",
    searchPlaceholder: "搜索本地视频",
    refreshDirectory: "重新扫描目录",
    switchToChinese: "切换为中文",
    switchToEnglish: "切换为英文",
    locationAndStatus: "目录位置与扫描状态",
    goUp: "返回上一级目录",
    currentRoot: "当前根目录",
    scanningEllipsis: "正在扫描…",
    localVideos: "本地视频",
    noVideosTitle: "没有找到 MP4 视频",
    noVideosMessage: "把视频放进当前目录或子目录，然后重新扫描。",
    noMatchesTitle: "没有匹配的视频",
    noMatchesMessage: "换一个关键词试试。",
    emptyFolderTitle: "这个文件夹是空的",
    emptyFolderMessage: "当前文件夹没有直属视频或子文件夹。",
    directoryReadFailed: "目录读取失败",
    rescan: "重新扫描",
    videoPlayer: "视频播放器",
    backToList: "返回视频列表",
    nowPlaying: "正在播放",
    video: "视频",
    mirrorVideo: "左右镜像视频",
    unmirrorVideo: "取消左右镜像",
    secondsShort: "秒",
    play: "播放",
    pause: "暂停",
    loading: "正在加载",
    exitFullscreen: "退出全屏",
    enterFullscreen: "进入全屏",
    threeFingerExit: "三指下滑退出全屏",
    videoProgress: "视频进度",
    volume: "音量",
    mute: "静音",
    unmute: "取消静音",
    playerHelp: "双击 / 双点左、右侧可后退或快进 10 秒",
    noScript: "这个页面需要 JavaScript 才能读取目录并生成视频预览。",
    folderType: "文件夹",
    openFolder: ({ path }) => `打开文件夹 ${path}`,
    playVideo: ({ title }) => `播放 ${title}`,
    folderVideoCount: ({ count }) => `${count} 个视频`,
    timelineValue: ({ current, duration }) => `${current}，总时长 ${duration}`,
    scanningDirectory: "正在扫描目录…",
    scanProgress: ({ directories, videos }) => `已查看 ${directories} 个目录 · 找到 ${videos} 个视频`,
    scanComplete: ({ videos, folders, failed }) => {
      const result = `${videos} 个视频 · ${folders} 个文件夹`;
      return failed > 0 ? `${result} · ${failed} 个目录无法读取` : result;
    },
    scanFailed: "扫描失败",
    directoryIndexError: ({ message }) => `无法读取目录索引（${message}）`,
    serverReadHint: ({ message }) => `${message}。请确认是通过当前 HTTP 服务器打开此页面。`,
    videoPlaybackError: "这个视频无法播放，可能是编码格式不受浏览器支持。",
    autoplayBlocked: "浏览器阻止了自动播放，请再点一次播放。",
    fullscreenUnsupported: "当前浏览器不支持网页全屏。",
    fullscreenDenied: "浏览器没有允许进入全屏。",
    fullscreenEscapeHint: "可以按 Esc 退出全屏。",
  },
};

let currentLanguage = readStoredLanguage();

function readStoredLanguage() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "zh" ? "zh" : "en";
  } catch {
    return "en";
  }
}

/** Translate a key and optionally interpolate values through a message function. */
export function t(key, values = {}) {
  const message = messages[currentLanguage][key] ?? messages.en[key] ?? key;
  return typeof message === "function" ? message(values) : message;
}

export function getLanguage() {
  return currentLanguage;
}

/** Apply translations declared as data attributes in the static HTML. */
export function applyStaticTranslations(root = document) {
  const bindings = [
    ["data-i18n", "textContent"],
    ["data-i18n-placeholder", "placeholder"],
    ["data-i18n-aria-label", "aria-label"],
    ["data-i18n-title", "title"],
  ];

  for (const [attribute, property] of bindings) {
    root.querySelectorAll(`[${attribute}]`).forEach((element) => {
      const value = t(element.getAttribute(attribute));
      if (property === "textContent") element.textContent = value;
      else element.setAttribute(property, value);
    });
  }
}

function updateDocumentLanguage() {
  document.documentElement.lang = currentLanguage === "zh" ? "zh-CN" : "en";
  const toggle = document.getElementById("languageToggle");
  if (!toggle) return;
  const label = currentLanguage === "en" ? t("switchToChinese") : t("switchToEnglish");
  toggle.dataset.currentLanguage = currentLanguage;
  toggle.setAttribute("aria-label", label);
  toggle.title = label;
}

/** Restore the saved language before controllers render their first state. */
export function initializeLanguage() {
  updateDocumentLanguage();
  applyStaticTranslations();
}

/** Persist a new language, refresh static copy, then notify dynamic views. */
export function setLanguage(language) {
  const nextLanguage = language === "zh" ? "zh" : "en";
  if (nextLanguage === currentLanguage) return;
  currentLanguage = nextLanguage;
  try {
    window.localStorage.setItem(STORAGE_KEY, currentLanguage);
  } catch {
    // Storage may be unavailable in private browsing; switching still works now.
  }
  updateDocumentLanguage();
  applyStaticTranslations();
  window.dispatchEvent(new CustomEvent("languagechange", { detail: { language: currentLanguage } }));
}

export function toggleLanguage() {
  setLanguage(currentLanguage === "en" ? "zh" : "en");
}
