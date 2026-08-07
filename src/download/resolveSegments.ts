import type { Candidate } from "../detection/types.ts";
import type { ManifestSegment } from "./manifest/types.ts";
import type { DownloadRequestOptions } from "./job.ts";
import { parseHlsManifest } from "./manifest/hls.ts";
import { createBrowserSession } from "./browserFetch.ts";
import { DESKTOP_CHROME_USER_AGENT } from "../detection/stealth.ts";

// Some CDNs block Node's fetch outright (Cloudflare, etc.) regardless of headers — fall back
// to a browser session (warmed up at the original referer page) when that happens (ADR-0003).
async function fetchManifestText(
  url: string,
  fetchHeaders: Record<string, string>,
  options: DownloadRequestOptions,
): Promise<string> {
  const res = await fetch(url, { headers: fetchHeaders });
  if (res.ok) {
    return await res.text();
  }
  if (!options.referer) {
    throw new Error(`failed to fetch HLS media playlist ${url}: HTTP ${res.status}`);
  }
  const session = await createBrowserSession(options.referer, options.userAgent ?? DESKTOP_CHROME_USER_AGENT);
  try {
    const buffer = await session.fetchBuffer(url);
    return buffer.toString("utf8");
  } finally {
    await session.close();
  }
}

/** Resolves a chosen Candidate into the concrete list of segments a Download Job should fetch. */
export async function resolveSegments(candidate: Candidate, headers: DownloadRequestOptions): Promise<ManifestSegment[]> {
  if (candidate.type === "direct") {
    return [{ url: candidate.url, durationSeconds: 0, encryption: { method: "NONE" } }];
  }

  if (candidate.type === "dash") {
    if (!candidate.segments) {
      throw new Error(`DASH candidate ${candidate.url} is missing its resolved segments`);
    }
    return candidate.segments;
  }

  // HLS: candidate.url is a media playlist, resolved once already by detection when it
  // walked past the master playlist — fetch it fresh in case it's changed since detection.
  const fetchHeaders: Record<string, string> = {};
  if (headers.referer) fetchHeaders["Referer"] = headers.referer;
  if (headers.cookie) fetchHeaders["Cookie"] = headers.cookie;
  if (headers.userAgent) fetchHeaders["User-Agent"] = headers.userAgent;

  const text = await fetchManifestText(candidate.url, fetchHeaders, headers);
  const parsed = parseHlsManifest(text, candidate.url);
  if (parsed.kind !== "segments") {
    throw new Error(`expected ${candidate.url} to be an HLS media playlist, but it was a master playlist`);
  }
  return parsed.segments;
}
