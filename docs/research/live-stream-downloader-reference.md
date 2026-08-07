# Primary-Source Reference: `chandler-stimson/live-stream-downloader`

This is a **primary-source research summary of a third-party open-source project** —
the "Live Stream Downloader" browser extension (Chrome/Firefox, homepage
`webextension.org/listing/hls-downloader.html`) — for reference while designing a
*different, new* project. It is not a specification, endorsement, or design proposal
for the new project. Every claim below is inline-cited to a specific file (and, where
useful, function/line range) fetched directly from the GitHub repository at commit
`103c3c6d9dca50f559d738887c9ade5de18d7fb4` on branch `master` (fetched 2026-08-07). No
architecture or implementation recommendations are made here — this is observation
only.

The repo actually contains **two independently maintained extension versions living
side by side**:

- `v2/` — a Manifest V2 build (older Chrome/Firefox), version `0.1.7` per
  `v2/manifest.json`.
- `v3/` — a Manifest V3 build (current), version `0.5.8` per `v3/manifest.json`. This
  is the actively developed version (its background is a real `service_worker`; v2's
  is an MV2 persistent background page).

Where the two versions differ materially, both are called out below.

---

## 1. Core detection mechanism

The extension uses **both** `webRequest` network sniffing and DOM/JS-runtime
inspection — it does not rely on one exclusively.

**Network sniffing (webRequest), v3:**
- `v3/worker.js` registers `chrome.webRequest.onHeadersReceived` listeners (not
  `onBeforeRequest`) in three places:
  - One for `types: ['media']` requests on all URLs (`urls: ['*://*/*']`) — the
    `observe` function, `v3/worker.js` lines 198-201.
  - One for `xmlhttprequest` requests matching a dynamic list of extensions built
    from `network.types({core:true})` (e.g. `*.m3u8*`, `*.mpd*`, `*.mp4*`, etc.) —
    `v3/worker.js` lines 204-213.
  - One for subtitle types (`.vtt`, `.srt`, etc.) on `xmlhttprequest`/`other` — lines
    218-228.
  - An optional, opt-in "mime-watch" listener that inspects `Content-Type` response
    headers on **all** XHR traffic for `video/`/`audio/` MIME types (`observe.mime`,
    lines 172-180, 230-247) — disabled by default, gated by a `chrome.storage.local`
    flag.
  - The extension type list itself (which extensions count as "media") is defined in
    `network.types()` in `v3/network/core.js` lines 30-52 (`CORE`, `EXTRA`, `SUB`
    arrays).
  - Detected URLs are pushed into a per-tab `self.storage` `Map` via
    `chrome.scripting.executeScript` injection (`v3/worker.js` lines 133-170), and
    the toolbar badge count is updated from the map size.
- `v2/downloads/manager.js` (older MV2 build) instead uses
  `chrome.webRequest.onBeforeRequest` with `types: ['media']` and a hard-coded list of
  extension-matching URL patterns (`*.flv*`, `*.m3u8*`, etc.) — see `webRequest.apply()`,
  lines 51-72. It keeps a per-tab cache of observed URLs (`cache[d.tabId][d.url]`).

**DOM / in-page inspection:**
- `v3/data/job/extract.js` defines three extraction strategies run against a given
  tab via `chrome.scripting.executeScript`:
  - `extract.storage` — reads a `self.storage` Map that content-script code
    populates (lines 25-43).
  - `extract.performance` — reads `performance.getEntriesByType('resource')` in the
    page's `MAIN` world and filters entries by `contentType` or filename extension
    (lines 46-80).
  - `extract.player` — introspects known JS player globals in the page's `MAIN`
    world: `jwplayer().getPlaylist()`, `videojs.getAllPlayers()`/`video-js` DOM
    elements' `.player` property, and `soundManager.sounds` (lines 83-178). This is
    explicit support for JW Player, Video.js, and SoundManager — not generic
    `<video>`/`<source>` tag scraping.
- A separate **Blob-interception plugin**, `v3/plugins/blob-detector/`, patches the
  page's `Blob` constructor via a `Proxy` (`v3/plugins/blob-detector/inject/main.js`)
  to catch in-page code that builds an HLS manifest as a `Blob` with MIME type
  `application/vnd.apple.mpegurl` (common when a player generates a manifest
  client-side), then relays the captured text to the isolated content-script world
  (`v3/plugins/blob-detector/inject/isolated.js`) which forwards it to the background
  via `chrome.runtime.sendMessage`. This plugin is opt-in, toggled by the same
  `mime-watch` storage flag and (de)registered dynamically with
  `chrome.scripting.registerContentScripts`/`unregisterContentScripts` in
  `v3/plugins/blob-detector/core.js`.
- There is no code found that queries `document.querySelectorAll('video, source')`
  directly; DOM discovery is done through the player-library introspection above,
  plus the Performance API and Blob patch, not raw HTML markup scraping.

Detected entries flow into a single popup "job" page (`v3/data/job/index.html`,
controller `v3/data/job/index.js`) which merges `extract.storage`,
`extract.performance`, `extract.player`, and any URLs appended via context menu into
one `Map` keyed by URL (`v3/data/job/index.js` lines 33-73).

---

## 2. Formats/protocols supported for downloading

- **Container/extension allow-list** (drives both webRequest filters and the
  "is this URL a stream vs. a plain file" decision) is defined in
  `v3/network/core.js` lines 30-41:
  - `CORE`: `flv, avi, wmv, mov, mp4, webm, mkv` (video); `pcm, wav, mp3, aac, ogg,
    wma, m4a, weba, opus` (audio); `m3u8, mpd` (stream manifests).
  - `EXTRA` (opt-in, non-media): `zip, rar, 7z, tar.gz, img, iso, bin, exe, dmg, deb`.
  - `SUB` (opt-in subtitles): `vtt, webvtt, srt`.
- **HLS (`.m3u8`)** and **DASH (`.mpd`)** are both explicitly parsed, via vendored
  third-party libraries identified in `v3/data/job/externals/README.txt`:
  - `m3u8-parser@7.2.0` (video.js project, Apache-2.0) — file
    `v3/data/job/externals/m3u8-parser.js`.
  - `mpd-parser@1.3.1` (video.js project, Apache-2.0) — file
    `v3/data/job/externals/mpd-parser.js`.
  - Dispatch between the two happens in `v3/data/job/parse.js` lines 56-69: if the
    href/content looks like an MPD (`.mpd` in URL or `<MPD` in content) it uses
    `mpdParser.parse`, otherwise `m3u8Parser.Parser`.
- **Plain progressive files** (`mp4`, `webm`, `mkv`, audio formats, etc.) are
  downloaded directly without manifest parsing — `helper.downloadable()` in
  `v3/context.js` lines 107-120 decides this by checking the URL/extension is *not*
  `.m3u8`/`.mpd`/related MIME strings.
- **`mp4box.all.js`** (GPAC's MP4Box.js, BSD-3-Clause, per its header comment in
  `v3/data/job/externals/mp4box.all.js`) is used to introspect fMP4/CMAF segment
  boxes for codec detection and in-browser preview eligibility — see
  `v3/data/job/plugins/codec.js` (`CodecGet` class, uses `MP4Box.createFile()` to read
  box info and populate `this.meta.codec`/`this.meta.preview`), not for muxing output.
- **DRM handling**: the vendored `m3u8-parser` *parses* DRM-related tags — it
  recognizes Widevine content protection via the DASH-IF Widevine UUID
  (`urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed`) and validates
  `SAMPLE-AES`/`SAMPLE-AES-CTR`/`SAMPLE-AES-CENC` key methods, per
  `v2/data/add/m3u8-parser.js` lines 900-1058 (same vendored parser logic, present in
  the v2 copy that was inspected in full; the v3 copy is the same upstream library at
  a newer version). However, the extension's **actual decrypt/download code
  explicitly refuses anything except plain HLS `AES-128`**:
  - v3: `v3/data/job/mget/plugins/decrypt.js` line 58-64 — `if
    (segment.key.method.toUpperCase() === 'AES-128') {...} else { throw
    Error('UNSUPPORTED_ENCRYPTION'); }`.
  - v2: `v2/downloads/file.js` lines 175-187 — same pattern: `if (key.method ===
    'AES-128') {...} else { reject(Error(`"${key.method}" encryption is not
    supported`)); }`.
  - Conclusion: the extension **detects** DRM-flagged streams (via the parser) but
    does **not** decrypt Widevine/PlayReady/FairPlay/SAMPLE-AES DRM — it only
    decrypts the non-DRM "AES-128" content-key scheme defined in the base HLS spec.
    User report corroborating a DRM-related failure: GitHub issue
    [#47](https://github.com/chandler-stimson/live-stream-downloader/issues/47),
    "Does not work with VEEPS Live Streams", describing a `widevine_cmaf_avc.m3u8`
    playlist that fails to download correctly (fetched via GitHub API, no maintainer
    reply present at fetch time).

---

## 3. Download/mux mechanism

**No ffmpeg (native or wasm) and no "wasm" reference of any kind appear anywhere in
the fetched source tree** (checked by grepping every fetched `.js` file for
`ffmpeg`/`wasm` — zero matches). The mechanism is pure JS, using the Streams API,
`fetch()`, and the File System Access API.

- The core multi-threaded fetch/write engine is a class called `MGet` ("MyGet"),
  defined in `v3/data/job/mget/mget.js` (self-described in its file header as "MyGet
  - A multi-thread downloading library"). Key mechanics:
  - `MGet.fetch(segments, params)` (lines 106-164) walks a segment array, spawning up
    to `options.threads` concurrent `pipe()` calls (default `threads: 2`, see
    `MGet.OPTIONS` lines 406-416).
  - `pipe()` (lines 225-404) does a `fetch(request)` per segment, and if the server
    supports byte ranges and the segment is larger than `options['thread-size']`
    (default 3 MB), it splits that single segment into further ranged sub-fetches
    for parallelism, via a custom `PolicyStream`/`StatsStream` (`TransformStream`
    subclasses, lines 20-52) piped into a `BasicWriter`/`MemoryWriter`
    (`WritableStream`, lines 54-73) that tracks byte offsets so segments can be
    written in the correct order regardless of fetch completion order.
  - Output is plugin-composed: base `MyGet` is progressively subclassed/overridden by
    files under `v3/data/job/mget/plugins/` (`decrypt.js`, `disk.js`, `cache.js`,
    `static.js`, `error.js`) and `v3/data/job/plugins/` (`codec.js`, etc.), each
    reassigning `self.MyGet` to a subclass that layers in a capability — e.g.
    `v3/data/job/mget/plugins/disk.js` (`FGet` class, lines 42-58) overrides the
    writer to stream chunks straight to a `FileSystemWritableFileStream` obtained via
    the File System Access API (`file.createWritable()`), rather than buffering in
    memory.
  - HLS/DASH **segment concatenation is simply sequential byte-offset writes to one
    output file/handle** — there is no remuxing step; MPEG-TS segments (the common
    HLS case) are concatenation-safe by design, and the code performs no container
    conversion.
  - fMP4/CMAF segment boxes are inspected via `mp4box.all.js` for codec/preview
    purposes only (`v3/data/job/plugins/codec.js`), not muxed into a different
    container.
- **AES-128 decryption**: `v3/data/job/mget/plugins/decrypt.js` defines `DGet extends
  MyGet`. For key-protected segments it buffers the raw ciphertext in a side cache
  (`this['basic-cache']`), fetches the key file over the network
  (`this.native(href, ...)`, lines 72-77), derives the IV either from the manifest's
  `EXT-X-KEY` `IV` attribute or — if absent — synthesizes it from the segment
  sequence number per the HLS spec (lines 91-103, comment: "since the manifest does
  not provide an IV, HLS.js will automatically generate one based on the segment
  sequence number"), then calls the **native browser WebCrypto API**
  (`crypto.subtle.importKey`/`crypto.subtle.decrypt` with `AES-CBC`, lines 105-113)
  to decrypt — no JS-userland crypto library, no ffmpeg. The decrypted bytes are then
  written into the shared output cache at a position-corrected offset (lines
  116-123). v2's equivalent is `v2/downloads/file.js` lines 170-188 (`decrypt(key,
  chunk)` method), using the identical `crypto.subtle` + `AES-CBC` approach.
- Quality/variant selection happens before any of this: `v3/data/job/parse.js`
  (lines 98-203) sorts available HLS variant playlists / DASH representations by
  resolution/bandwidth and either prompts the user to pick one (`quality: 'selector'`,
  the default) or auto-picks the highest/lowest per a stored preference
  (`v3/data/job/plugins/quality.js`).
- Multi-timeline / ad-break handling: `v3/data/job/index.js` lines 124-172 groups
  segments by their `segment.timeline` value (from discontinuities in the manifest)
  and, if more than one timeline is present, prompts the user to choose one timeline,
  download each separately, or ignore the split — explicit acknowledgment that ad
  segments interleaved via `#EXT-X-DISCONTINUITY` are a known, handled case.

---

## 4. Live (indefinite-duration) stream handling

**No evidence of playlist re-polling / live "keep appending new segments" logic was
found in the fetched source.** Specifically:

- A repo-wide grep across every fetched `.js` file for `EXT-X-ENDLIST`,
  `playlist-type`, `isLive`, `VOD`, `poll`, `refresh`/`refetch` found **no matches**
  except a single unrelated `setInterval` in `v3/data/job/index.js` line 251, which
  is a UI progress-title ticker (updates `document.title` with percent/throughput
  every 750ms) — it does not re-fetch the manifest.
- The actual flow, read end-to-end in `v3/data/job/index.js` (the `download()`
  function, lines 120-319, and the form submit handler, lines 321-426): when the user
  clicks "Download," `parse()` (`v3/data/job/parse.js`) is called **once**, fetches
  the manifest **once**, extracts whatever segments are listed in it **at that
  moment**, and passes that fixed array to `MyGet.fetch(segments)`. Once that finite
  array is exhausted, the job resolves (`this.meta.done = true; resolve();` in
  `v3/data/job/mget/mget.js` line 151) and the file is finalized/renamed
  (`v3/data/job/index.js` lines 289-311). There is no loop back to re-request the
  playlist for newly-appeared segments.
- Practical implication (inferred directly from the above code path, not from a
  README statement): for a genuinely live/growing HLS playlist, this extension
  captures only the segments present in the manifest at the instant of the download
  click — it is not a continuous/indefinite live-capture tool by way of automatic
  playlist polling.
- Corroborating (but not conclusive) circumstantial evidence: GitHub issue
  [#184](https://github.com/chandler-stimson/live-stream-downloader/issues/184),
  "Found a new extension on gitHub inspired by this one that support live stream
  downloading," in which a user points to a different, newer extension
  specifically because it "support[s] live stream downloading" — suggesting (from a
  user's perspective, not a maintainer statement) that this capability is not
  perceived as present here. No maintainer reply was present on that issue at fetch
  time, so this is **not** an authoritative confirmation, only a corroborating
  signal alongside the code-level finding above.
- The repo's own description field (via the GitHub API) reads "Download M3U8 live
  streams to the local disk" — i.e., "live" in the product name/description appears
  to refer to capturing an HLS stream that is *currently airing* (as opposed to a
  static on-demand VOD file), not to indefinite/continuous polling of a
  growing playlist. This is an interpretation, not a literal quote confirming or
  denying continuous capture.

---

## 5. Extension architecture

**v3 (Manifest V3, current), per `v3/manifest.json`:**
- `manifest_version: 3`, `version: "0.5.8"`, `name: "Live Stream Downloader"`.
- `permissions`: `storage`, `contextMenus`, `webRequest`,
  `declarativeNetRequestWithHostAccess`, `declarativeContent`, `scripting`, `alarms`.
- `host_permissions`: `*://*/*`.
- `background.service_worker`: `worker.js`, with `background.scripts` (loaded via
  `importScripts` for browsers needing it) listing, in order: `network/core.js`,
  `network/icon.js`, `context.js`, `plugins/blob-detector/core.js`,
  `data/job/extract.js`, `worker.js`.
- No `content_scripts` are statically declared in the manifest; content-script-like
  injection happens dynamically at runtime via `chrome.scripting.executeScript` (for
  one-off extraction, e.g. `extract.js`) and
  `chrome.scripting.registerContentScripts`/`unregisterContentScripts` (for the
  opt-in blob-detector world scripts, `v3/plugins/blob-detector/core.js` lines 42-56).
- No `action.default_popup` — `action.default_title` only ("Download HLS Streams");
  clicking the toolbar icon opens a full extension **window** (not a popup dropdown)
  pointing at `/data/job/index.html`, created via `chrome.windows.create(...)` in the
  `open()` function, `v3/worker.js` lines 47-75.
- `browser_specific_settings.gecko` block sets a Firefox add-on ID, `strict_min_version:
  "148.0"`, and a `data_collection_permissions: {required: ["none"]}` declaration.
- File-level organization (per repo tree, branch `master`):
  - `v3/worker.js` — service worker entry point, badge/icon updates, context menu
    dispatch glue, install/uninstall handling, and (per lines 287-424) an
    **external-messaging surface** (`chrome.runtime.onMessageExternal`,
    `chrome.runtime.onConnectExternal`) that exposes `mcp.json`/`mcp.output` and a
    `find-media`/`download-media` command pair for other extensions/agents to drive
    media discovery and downloads — this is the integration point referenced by the
    README's "MCP Server" section (see `v3/mcp/mcp.json`, a JSON-RPC 2.0 tool
    definition file listing tools such as `find_media`).
  - `v3/network/core.js` — the type allow-lists and the blocked-host/blocked-stream
    filter (`network.blocked()`), sourced from `v3/network/blocked.json` (a small
    opt-out list for specific hosts/streams, e.g. `.youtube.com`, `.globo.com`,
    `.gstatic.com`) or a CDN-hosted mirror
    (`cdn.jsdelivr.net/gh/chandler-stimson/live-stream-downloader@latest/...`).
  - `v3/context.js` — context-menu registration/handling.
  - `v3/data/job/` — the popup/job **window** UI: `index.html`/`index.js` (main
    controller), `parse.js` (manifest parsing dispatch), `extract.js` (tab
    scraping), `helper.js` (filename/save-dialog option building, UI prompt/notify
    helpers), `build.js` (a Node build script, not shipped runtime code), and a
    `plugins/` directory of small independent UI feature modules (`format.js`,
    `filename.js`, `quality.js`, `batch.js`, `codec.js`, `directory-access.js`,
    `permission.js`, `threads.js`, `referer.js`, `mime.js`, `links.js`, `drop.js`,
    `preview.js`, `footer.js`, `tools.js`, `unload.js`, `error.js`).
  - `v3/data/job/mget/` — the download engine: `mget.js` (base `MGet` class) plus
    `plugins/` that each `class X extends MyGet { ... }; self.MyGet = X;` to layer in
    disk-writing (`disk.js`), AES-128 decryption (`decrypt.js`), caching
    (`cache.js`), static/local-file handling (`static.js`), and error-recovery
    (`error.js`).
  - `v3/plugins/blob-detector/` — the opt-in Blob-patch detector described in
    section 1.
  - `v3/_locales/` — i18n message bundles for 16 locales.
  - `v3/mcp/` — `mcp.json` (JSON-RPC 2.0 / JSON Schema tool manifest) and
    `mcp.output`, supporting the README-documented MCP (agent-tool) integration.

**v2 (Manifest V2, legacy), per `v2/manifest.json`:**
- `manifest_version: 2`, `version: "0.1.7"`.
- `permissions`: `storage`, `webRequest`, `webRequestBlocking`, a set of per-extension
  match patterns (`*://*/*.flv*`, `.avi*`, `.wmv*`, `.mov*`, `.mp4*`, `.pcm*`,
  `.wav*`, `.mp3*`, `.aac*`, `.ogg*`, `.wma*`, `.m3u8*`), `downloads`,
  `notifications`, `contextMenus`.
- `background.scripts` (persistent background page, not a service worker):
  `downloads/file.js`, `downloads/get.js`, `downloads/manager.js`, `background.js`.
- `browser_action.default_title`: "Download HLS Streams or Abort active tab's Jobs".
- `web_accessible_resources`: `data/scripts/user.html`.
- `v2/downloads/` vendors logic from a related project by the same author family,
  explicitly headed in its file comments as **"Turbo Download Manager"** (by
  "InBasic", `github.com/inbasic/turbo-download-manager-v2`) — see the file header
  in `v2/downloads/file.js` and `v2/downloads/manager.js`. It uses
  `chrome.webRequest.onBeforeRequest` for detection and a `CONFIG` object (in
  `v2/background.js` lines 4-15) with tunables like `max-number-of-threads: 3`,
  `max-retires: 10`, and a `use-native-when-possible` flag (default `false`)
  suggesting an option to fall back to the browser's native `chrome.downloads` API
  for non-segmented files versus the custom multi-thread fetcher for HLS.
- `v2/data/add/` is the equivalent job/UI window (`index.html`/`index.js`), including
  its own bundled copy of `m3u8-parser.js`.

---

## 6. Output

- **Manifest-based downloads (HLS/DASH)**: the user-facing "default format" setting
  (`v3/data/job/plugins/format.js`, backed by `chrome.storage.local` key
  `default-format`, default value `'mkv'`) offers a choice between `.ts` and `.mkv`
  as the container extension for the saved file — see `v3/context.js`
  `helper.options()`, lines 122-147: if `default-format === 'ts'` the save dialog
  filters/suggests `.ts` (`video/MP2T`), otherwise `.mkv` (labeled `video/mkv` in the
  save-picker's `accept` map). Note the extension does **not** perform any container
  transcoding to actually produce a valid Matroska file — segments are still written
  as raw concatenated bytes (see section 3); the `.mkv` extension here is simply the
  suggested output filename/extension, not a demonstrated remux step in the fetched
  code.
- **Direct/progressive downloads** (a URL that is already `.mp4`, `.webm`, `.mkv`,
  audio, etc., per `helper.downloadable()`): the original extension/MIME of the
  source URL is preserved as the output extension (`v3/context.js` lines 148-167,
  `meta.ext`/`meta.mime` driven).
- **Filename/naming**: controlled by a `chrome.storage.local` key `filename`
  (default template `'[meta.name]'`) and a boolean `online-resolve-name` option, set
  via `v3/data/job/plugins/filename.js`. The actual suggested name assembled for the
  browser's native Save-File-Picker is `(meta.gname || meta.name || 'Untitled') + (' -
  ' + meta.index if present) + '.' + extension`, per `helper.options()` in
  `v3/context.js` lines 143-167. Illegal filesystem characters are stripped with a
  regex fallback if `showSaveFilePicker` rejects the suggested name
  (`v3/data/job/index.js` lines 344-364, referencing GitHub issue #46 in a code
  comment).
- **Saving mechanism**: v3 uses the browser's native **File System Access API**
  (`window.showSaveFilePicker` / `window.showDirectoryPicker`) to get a writable file
  handle, then streams chunks to disk via `file.createWritable()`
  (`v3/data/job/mget/plugins/disk.js`), rather than using `chrome.downloads`. On
  Firefox, which lacks the File System Access API, a fallback path calls
  `file.download(file.name)` when `'download' in file` (`v3/data/job/index.js` line
  290-292) implying a Firefox-specific polyfill object is used in that browser (not
  directly inspected in this pass).
- **Batch mode**: `v3/data/job/plugins/batch.js` (`self.batch`) picks a directory via
  `showDirectoryPicker`, de-duplicates filenames already present in that directory by
  appending `-1`, `-2`, etc., and downloads a list of jobs (e.g. one file per
  timeline/discontinuity group) sequentially into it.
- v2 used the `downloads` permission and (per `CONFIG['use-native-when-possible']` in
  `v2/background.js`) apparently could hand off to the browser's native download
  manager for some cases, alongside its own IndexedDB-backed chunk store
  (`v2/downloads/file.js`, `File` class managing an IndexedDB `chunks` object store).

---

## 7. Limitations / known issues (from README.md and GitHub Issues)

Directly from **README.md** (fetched from `master`):
- The README is short; its only explicit functional caveat is a content-creator
  opt-out mechanism: site owners can submit a pull request against
  `v3/network/blocked.json` (or file a bug report) to have the extension ignore
  their site's streams entirely, and the maintainer states a requirement for an
  email confirming the pull-request link from the site owner "to ensure protection
  against misuse" (README.md, "Content Creators" section).
- The README documents an MCP (Model Context Protocol) server-style integration
  for coding agents (e.g. "OpenCode"), pointing to `v3/mcp/mcp.json` as the tool
  definition file (README.md, "MCP Server" section). This is a feature note, not a
  limitation.
- No other explicit "does not support X" statement appears in README.md as fetched.

From **GitHub Issues** (fetched via the GitHub Search/Issues API; note these are
user reports, not maintainer-confirmed limitations unless stated):
- Issue [#47](https://github.com/chandler-stimson/live-stream-downloader/issues/47),
  "Does not work with VEEPS Live Streams" — a user reports a `206` caching error on a
  Widevine-CMAF-named playlist (`widevine_cmaf_avc.m3u8`) and worked around it by
  guessing an alternate manifest filename (`veeps.m3u8`) referenced in the source.
  This is consistent with the code-level finding in section 2 that DRM'd
  (Widevine/SAMPLE-AES) content is not decryptable by this extension.
- Issue [#39](https://github.com/chandler-stimson/live-stream-downloader/issues/39),
  "No longer works with Tiktok Live Streams" (title only fetched; not read in
  detail — flagged as unverified detail below).
- Issue [#184](https://github.com/chandler-stimson/live-stream-downloader/issues/184)
  — a user links to a different extension ("liveDownload") explicitly because it
  "support[s] live stream downloading," which a user evidently did not perceive this
  extension as doing (see section 4 caveats — this is circumstantial, not a
  maintainer admission).
- Issue [#10](https://github.com/chandler-stimson/live-stream-downloader/issues/10),
  "Crash during downloading at ~80% or even at 100% percent" (title only; not
  read in detail).
- The repository has a large number of open issues (114 open at fetch time, per the
  GitHub repo API metadata) and 134 forks; this document does **not** claim to have
  surveyed them systematically — only the handful specifically searched for
  DRM/live-stream keywords, as listed above.
- The repo's wiki (`has_wiki: true` in repo metadata) was checked at
  `https://github.com/chandler-stimson/live-stream-downloader/wiki` and **redirects
  to the plain repository landing page** (HTTP 302 → 200, final page title is just
  the repo's own GitHub page) — i.e., no separate wiki content was found to exist or
  be reachable.

---

## Sources

All fetched at commit `103c3c6d9dca50f559d738887c9ade5de18d7fb4` (branch `master`) on
2026-08-07, via the GitHub REST API and `raw.githubusercontent.com`, except where noted:

- Repo metadata: `https://api.github.com/repos/chandler-stimson/live-stream-downloader`
- Full recursive file tree: `https://api.github.com/repos/chandler-stimson/live-stream-downloader/git/trees/master?recursive=1`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/README.md`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/manifest.json`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v2/manifest.json`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/worker.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/network/core.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/network/icon.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/network/blocked.json`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/context.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/extract.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/parse.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/index.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/helper.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/build.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/mget/mget.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/mget/plugins/decrypt.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/mget/plugins/disk.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/mget/plugins/cache.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/mget/plugins/static.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/mget/plugins/error.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/plugins/format.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/plugins/filename.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/plugins/codec.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/plugins/quality.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/plugins/batch.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/plugins/directory-access.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/plugins/permission.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/plugins/threads.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/plugins/referer.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/plugins/mime.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/plugins/links.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/plugins/drop.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/plugins/preview.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/plugins/footer.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/plugins/tools.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/plugins/unload.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/plugins/error.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/plugins/blob-detector/core.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/plugins/blob-detector/inject/isolated.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/plugins/blob-detector/inject/main.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/mcp/mcp.json`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/externals/README.txt`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/externals/m3u8-parser.js` (header only)
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/externals/mpd-parser.js` (header only)
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v3/data/job/externals/mp4box.all.js` (header only)
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v2/background.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v2/data/add/index.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v2/data/add/m3u8-parser.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v2/downloads/file.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v2/downloads/get.js` (fetched, not fully read)
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v2/downloads/manager.js`
- `https://raw.githubusercontent.com/chandler-stimson/live-stream-downloader/master/v2/data/scripts/user.js`
- GitHub Issues API search: `https://api.github.com/search/issues?q=repo:chandler-stimson/live-stream-downloader+DRM+in:title,body`
- GitHub Issues API search: `https://api.github.com/search/issues?q=repo:chandler-stimson/live-stream-downloader+%22live+stream%22+in:title`
- `https://api.github.com/repos/chandler-stimson/live-stream-downloader/issues/184` + `/comments`
- `https://api.github.com/repos/chandler-stimson/live-stream-downloader/issues/47` + `/comments`
- Wiki check: `https://github.com/chandler-stimson/live-stream-downloader/wiki` (redirects to repo root)

---

## Unverified / Could Not Access

- **Firefox-specific download fallback path**: `v3/data/job/index.js` line 290-292
  references `file.download(file.name)` for Firefox (`'download' in file`), implying
  a polyfill/shim object providing a `.download()` method on the file handle when the
  File System Access API isn't available — the source of that shim was not located
  or inspected in this pass (candidate file
  `v3/data/job/file-picker-polyfill.js` exists in the tree per the recursive file
  listing but was **not fetched or read**).
- **`v2/downloads/get.js`** (1245 lines) and **`v2/downloads/manager.js`** beyond the
  first ~80 lines were fetched but not read in full; deeper v2-specific mechanics
  (e.g. its exact IndexedDB chunk-merge/finalization logic) are not verified beyond
  what's cited above.
- **Full content of `v3/data/job/plugins/error.js`, `mime.js`, `links.js`, `drop.js`,
  `preview.js`, `footer.js`, `unload.js`, `permission.js`, `threads.js`, and
  `v3/data/job/mget/plugins/static.js`/`cache.js`/`error.js`** were fetched
  successfully but not read/analyzed in this pass beyond confirming they exist and
  do not reference ffmpeg/wasm/DRM; their detailed behavior is not documented here.
- **GitHub Issues survey is not exhaustive.** Only two issues (#47, #184) were opened
  and read in full; issue #39 ("No longer works with Tiktok Live Streams") and #10
  ("Crash during downloading...") were seen only as titles via the search API and
  were **not** opened/read — their content, root cause, and any maintainer resolution
  are unverified. The repository has 114 open issues total (per repo metadata) which
  were not systematically reviewed.
- **Repository Wiki**: `has_wiki: true` is set in the repo's metadata, but the wiki
  URL redirects to the plain repository page with no distinguishable wiki content —
  it is unverified whether this means the wiki is genuinely empty, disabled for
  anonymous/unauthenticated viewing, or something else; no wiki content could be
  retrieved either way.
- **Whether `.mkv` output is a genuine valid Matroska container or just a
  file-extension label on raw concatenated segment bytes** — the fetched code shows
  segments are written via straight offset-based byte concatenation with no
  container-remux step (`v3/data/job/mget/mget.js`, `v3/data/job/mget/plugins/disk.js`);
  no code was found that constructs Matroska (EBML) structure. This document treats
  `.mkv` as an output *filename extension* only, not as confirmed proof of an actual
  valid Matroska mux — but the possibility that some other unread plugin file
  performs such a mux (e.g., something in the unread `error.js`/`static.js`/`cache.js`
  files) cannot be fully ruled out from the files that were read.
- **No independent confirmation from a maintainer statement (issue comment, README,
  or release notes) that live/indefinite polling is categorically unsupported** —
  section 4's conclusion is derived from tracing the actual code path
  (`parse()` → fixed segment array → `MyGet.fetch()`), which is strong evidence, but
  it is a code-reading inference rather than an explicit maintainer statement to that
  effect.
- Two of the repo's topics (`mcp-server`) reflect the newest feature area
  (`v3/mcp/mcp.json`); this document read roughly the first 60 lines of that
  174-line file (one tool definition, `find_media`) and did not fully enumerate every
  MCP tool the file defines.
