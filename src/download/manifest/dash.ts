import { parse, type PlaylistItem } from "mpd-parser";
import type { ManifestVariant, ManifestSegment } from "./types.ts";

function hasContentProtection(contentProtection: PlaylistItem["contentProtection"]): boolean {
  return !!contentProtection && Object.keys(contentProtection).length > 0;
}

function toSegment(segment: PlaylistItem["segments"][number], drmProtected: boolean): ManifestSegment {
  return {
    url: segment.resolvedUri ?? segment.uri,
    durationSeconds: segment.duration,
    initSegmentUrl: segment.map ? (segment.map.resolvedUri ?? segment.map.uri) : undefined,
    encryption: drmProtected ? { method: "DRM" } : { method: "NONE" },
  };
}

function toVariant(item: PlaylistItem): ManifestVariant {
  const resolution = item.attributes.RESOLUTION;
  const drmProtected = hasContentProtection(item.contentProtection);
  return {
    url: item.resolvedUri ?? item.uri,
    bandwidth: item.attributes.BANDWIDTH,
    width: resolution?.width,
    height: resolution?.height,
    codecs: item.attributes.CODECS,
    drmProtected,
    segments: item.segments.map((segment) => toSegment(segment, drmProtected)),
  };
}

export function parseDashManifest(text: string, manifestUrl: string): { kind: "variants"; variants: ManifestVariant[] } {
  const manifest = parse(text, { manifestUri: manifestUrl });
  return {
    kind: "variants",
    variants: (manifest.playlists ?? []).map(toVariant),
  };
}
