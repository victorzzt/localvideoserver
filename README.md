# Local Video List / 本地视频列表

这是一个用于原型验证的本地 Web 服务器视频工具，适合功能测试或家庭局域网使用。它会读取 Web 服务器提供的目录列表，在浏览器中显示文件夹和 MP4 视频，并提供视频预览与播放界面。

This is a local web-server video tool intended for prototyping. It is suitable for functional testing or home-network use. It reads directory listings supplied by a web server, displays folders and MP4 videos in the browser, and provides video previews and playback.

## 安装 / Installation

将 `videolist.html`、`css` 文件夹和 `js` 文件夹复制到存放视频的目录中。不要直接通过 `file://` 打开页面；浏览器必须通过 HTTP 访问该目录。

Copy `videolist.html` together with the `css` and `js` folders into the directory that contains your videos. Do not open the page directly through `file://`; the browser must access the directory over HTTP.

该目录需要由能够生成目录列表的 Web 服务器提供。可以使用 npm 的 `http-server`、Express、Apache 或 nginx，但必须明确开启并允许访问目录列表，否则页面无法发现文件夹和视频。

The directory must be served by a web server that generates directory listings. npm `http-server`, Express, Apache, or nginx may be used, but directory listing must be explicitly enabled and accessible; otherwise, the page cannot discover folders or videos.

使用 npm `http-server` 时，可以在视频目录中运行 `npx http-server .`，然后通过服务器显示的地址打开 `videolist.html`。Express 需要配置静态文件服务和目录索引中间件；Apache 需要允许目录索引，例如 `Options +Indexes`；nginx 需要为对应位置启用 `autoindex on`。

With npm `http-server`, run `npx http-server .` in the video directory and open `videolist.html` through the address printed by the server. Express requires both static-file serving and directory-index middleware; Apache must allow directory indexes, for example with `Options +Indexes`; nginx must enable `autoindex on` for the relevant location.

## 缩略图缓存文件 / Thumbnail Cache File

通过 `videolist.html?setup=true` 打开缩略图构建模式。页面会扫描最多三层目录，并以最多四个并行任务生成所有视频的缩略图；全部完成前会锁定视频播放，页面顶部的细进度条按“已缓存数量 / 视频总数”推进。完成后点击下载按钮得到 `thumbnail.cache`。

Open `videolist.html?setup=true` to enter thumbnail setup mode. The page scans up to three directory levels and generates previews with no more than four concurrent tasks. Video playback remains locked until every thumbnail is ready, and the thin progress bar at the top advances by completed thumbnails rather than time. When it finishes, use the download button to obtain `thumbnail.cache`.

把下载的 `thumbnail.cache` 放到 `videolist.html` 同一个目录。以后以普通方式打开页面时，会先读取这个文件中的 JPEG 缩略图，再从浏览器缓存查找，其余缺少的记录才会请求视频并按原方式生成。

Place the downloaded `thumbnail.cache` beside `videolist.html`. On later normal visits, the page checks the JPEG records in this file first, then the browser cache, and only requests videos to generate records that are still missing.

如果视频文件发生变化，请重新生成并替换 `thumbnail.cache`。缓存按相对文件路径匹配，因此用新视频覆盖同名文件后，旧缩略图不会自动识别内容变化。

Regenerate and replace `thumbnail.cache` after changing video files. Records are matched by relative file path, so replacing a video under the same filename does not automatically invalidate its old thumbnail.

缓存文件使用一个快速的对称 XOR 混淆，不提供真正的安全性。若要修改密钥，请编辑 `js/thumbnail-file-cache.js` 顶部有明确注释的 `THUMBNAIL_CACHE_CIPHER_KEY`；生成和读取文件时必须使用相同的值。

The cache file uses fast symmetric XOR obfuscation and provides no real security. To change its key, edit the clearly commented `THUMBNAIL_CACHE_CIPHER_KEY` near the top of `js/thumbnail-file-cache.js`; the same value must be used when creating and reading the file.

## 使用范围 / Intended Scope

这个工具在浏览器中扫描目录列表并从视频中生成预览帧，因此不适合包含大量视频的工程。视频数量较多、目录很深或文件很大时，初次加载和预览生成可能消耗较多时间、网络流量和设备资源。

This tool scans directory listings and generates preview frames from videos in the browser, so it is not suitable for projects containing large video collections. When there are many videos, deep directories, or very large files, initial loading and preview generation may consume significant time, bandwidth, and device resources.

本项目是本地原型工具，不包含用户认证、访问控制、媒体转码、数据库索引或面向互联网部署所需的安全加固，因此不适合作为公开网站或 Public Web 工程使用。

This project is a local prototype tool. It does not include user authentication, access control, media transcoding, database indexing, or the security hardening required for Internet deployment, and it should not be used as a public website or Public Web project.

## License / 许可证

本项目使用 MIT-0 许可证，可以自由使用、复制、修改和分发，并且不要求署名。完整条款请参阅 `LICENSE`。

This project is licensed under MIT-0. It may be used, copied, modified, and distributed freely without an attribution requirement. See `LICENSE` for the complete terms.
