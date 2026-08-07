import type { Candidate } from "../detection/types.ts";
import type { ManifestSegment } from "./manifest/types.ts";
import type { DownloadRequestOptions } from "./job.ts";
import { parseHlsManifest } from "./manifest/hls.ts";

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

  const res = await fetch(candidate.url, { headers: fetchHeaders });
  if (!res.ok) {
    throw new Error(`failed to fetch HLS media playlist ${candidate.url}: HTTP ${res.status}`);
  }
  const text = await res.text();
  const parsed = parseHlsManifest(text, candidate.url);
  if (parsed.kind !== "segments") {
    throw new Error(`expected ${candidate.url} to be an HLS media playlist, but it was a master playlist`);
  }
  return parsed.segments;
}
