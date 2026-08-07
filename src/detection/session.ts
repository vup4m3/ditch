import { chromium } from "playwright";
import { classifyResponse, isManifestResponse } from "./classify.ts";
import type { Candidate } from "./types.ts";

export interface DetectionResult {
  candidates: Candidate[];
  referer: string;
  userAgent: string;
  cookie?: string;
  /** The page's <title>, offered to the user as a default download filename (Q13). */
  pageTitle: string;
}

export interface RunDetectionOptions {
  /** How long to let the page run (play() + network activity) before collecting results. */
  timeoutMs?: number;
  /** Invoked as each new candidate is found, before the session finishes (Q20: live-streamed list). */
  onCandidate?: (candidate: Candidate) => void;
}

const DEFAULT_TIMEOUT_MS = 8000;

// Patches the Blob constructor so client-built manifests (e.g. a player assembling an
// HLS/DASH manifest in memory before handing it to MediaSource via a blob: URL) are
// caught even though they never touch the network. Runs in-page via addInitScript.
const BLOB_DETECTOR_INIT_SCRIPT = `(() => {
  window.__ditchBlobManifests = [];
  const OriginalBlob = window.Blob;
  function DitchBlob(parts, options) {
    try {
      const text = (parts || []).map((p) => (typeof p === "string" ? p : "")).join("");
      if (text.includes("#EXTM3U") || text.includes("<MPD")) {
        window.__ditchBlobManifests.push({ text, type: options && options.type });
      }
    } catch (e) {}
    return new OriginalBlob(parts, options);
  }
  DitchBlob.prototype = OriginalBlob.prototype;
  window.Blob = DitchBlob;
})();`;

interface PlayerGlobalSource {
  url: string;
}

/** Best-effort introspection of common player libraries' exposed source URLs (JW Player, Video.js). */
function collectPlayerGlobalSources(): PlayerGlobalSource[] {
  const found: PlayerGlobalSource[] = [];
  try {
    const jw = (window as unknown as { jwplayer?: () => { getPlaylist?: () => unknown } }).jwplayer;
    if (typeof jw === "function") {
      const playlist = jw().getPlaylist?.();
      if (Array.isArray(playlist)) {
        for (const item of playlist as Array<{ file?: string; sources?: Array<{ file?: string }> }>) {
          if (item?.file) found.push({ url: item.file });
          for (const source of item?.sources ?? []) {
            if (source?.file) found.push({ url: source.file });
          }
        }
      }
    }
  } catch {
    // best-effort only
  }
  try {
    const videojs = (window as unknown as { videojs?: { getAllPlayers?: () => Array<{ currentSrc?: () => string }> } })
      .videojs;
    const players = videojs?.getAllPlayers?.() ?? [];
    for (const player of players) {
      const src = player.currentSrc?.();
      if (src) found.push({ url: src });
    }
  } catch {
    // best-effort only
  }
  return found;
}

export async function runDetectionSession(
  pageUrl: string,
  options: RunDetectionOptions = {},
): Promise<DetectionResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(BLOB_DETECTOR_INIT_SCRIPT);

    const candidates: Candidate[] = [];
    const seenUrls = new Set<string>();

    function addCandidates(found: Candidate[]): void {
      for (const candidate of found) {
        if (seenUrls.has(candidate.url)) continue;
        seenUrls.add(candidate.url);
        candidates.push(candidate);
        options.onCandidate?.(candidate);
      }
    }

    page.on("response", (response) => {
      void (async () => {
        try {
          const url = response.url();
          const contentType = response.headers()["content-type"];
          const body = isManifestResponse(url, contentType) ? await response.text() : "";
          addCandidates(classifyResponse(url, contentType, body));
        } catch {
          // response body may be unreadable (e.g. binary data on a false-positive URL match) — ignore
        }
      })();
    });

    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });

    // Triggers loading for players that only fetch their manifest once playback starts.
    await page.evaluate(() => {
      for (const video of Array.from(document.querySelectorAll("video"))) {
        video.play().catch(() => {});
      }
    });

    await page.waitForTimeout(timeoutMs);

    const blobManifests = (await page.evaluate(() => (window as { __ditchBlobManifests?: unknown }).__ditchBlobManifests)) as
      | Array<{ text: string; type?: string }>
      | undefined;
    for (const blob of blobManifests ?? []) {
      addCandidates(classifyResponse(`${pageUrl}#blob`, blob.type, blob.text));
    }

    const playerSources = await page.evaluate(collectPlayerGlobalSources);
    for (const source of playerSources) {
      try {
        const text = await page.evaluate(async (url) => {
          const res = await fetch(url);
          return res.ok ? await res.text() : "";
        }, source.url);
        if (text) addCandidates(classifyResponse(source.url, undefined, text));
      } catch {
        // player-reported URL may not be independently fetchable — ignore
      }
    }

    const userAgent = await page.evaluate(() => navigator.userAgent);
    const cookies = await context.cookies(pageUrl);
    const cookie = cookies.length > 0 ? cookies.map((c) => `${c.name}=${c.value}`).join("; ") : undefined;
    const pageTitle = await page.title();

    return { candidates, referer: pageUrl, userAgent, cookie, pageTitle };
  } finally {
    await browser.close();
  }
}
