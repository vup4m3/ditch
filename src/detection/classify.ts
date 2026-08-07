import { randomUUID } from "node:crypto";
import { parseHlsManifest } from "../download/manifest/hls.ts";
import { parseDashManifest } from "../download/manifest/dash.ts";
import type { ManifestVariant } from "../download/manifest/types.ts";
import type { Candidate } from "./types.ts";

function isHls(url: string, contentType: string | undefined): boolean {
  return url.endsWith(".m3u8") || !!contentType?.includes("mpegurl");
}

function isDash(url: string, contentType: string | undefined): boolean {
  return url.endsWith(".mpd") || !!contentType?.includes("dash+xml");
}

/** Whether classifyResponse needs the response body (manifests) as opposed to just url/content-type (direct media). */
export function isManifestResponse(url: string, contentType: string | undefined): boolean {
  return isHls(url, contentType) || isDash(url, contentType);
}

const DIRECT_MEDIA_EXTENSIONS = [".mp4", ".webm", ".mkv", ".mp3", ".m4a", ".aac", ".ogg", ".wav"];

function isDirectMedia(url: string, contentType: string | undefined): boolean {
  if (contentType?.startsWith("video/") || contentType?.startsWith("audio/")) return true;
  const path = url.split("?")[0] ?? url;
  return DIRECT_MEDIA_EXTENSIONS.some((ext) => path.endsWith(ext));
}

function variantLabel(variant: ManifestVariant): string | undefined {
  if (variant.height) return `${variant.height}p`;
  if (variant.bandwidth) return `${Math.round(variant.bandwidth / 1000)}kbps`;
  return undefined;
}

function variantToCandidate(variant: ManifestVariant, type: "hls" | "dash"): Candidate {
  return {
    id: randomUUID(),
    url: variant.url,
    type,
    label: variantLabel(variant),
    drmProtected: variant.drmProtected ?? false,
    segments: variant.segments,
  };
}

export function classifyResponse(url: string, contentType: string | undefined, body: string): Candidate[] {
  if (isHls(url, contentType)) {
    const parsed = parseHlsManifest(body, url);
    if (parsed.kind === "variants") {
      return parsed.variants.map((v) => variantToCandidate(v, "hls"));
    }
    return [
      {
        id: randomUUID(),
        url,
        type: "hls",
        drmProtected: parsed.drmProtected,
      },
    ];
  }

  if (isDash(url, contentType)) {
    const parsed = parseDashManifest(body, url);
    return parsed.variants.map((v) => variantToCandidate(v, "dash"));
  }

  if (isDirectMedia(url, contentType)) {
    return [{ id: randomUUID(), url, type: "direct", drmProtected: false }];
  }

  return [];
}
