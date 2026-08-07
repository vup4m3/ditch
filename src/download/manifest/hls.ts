import { Parser, type Manifest, type PlaylistItem, type Segment } from "m3u8-parser";
import type { ParsedManifest, ManifestVariant, ManifestSegment, SegmentEncryption } from "./types.ts";
import { sequenceNumberToIv, uint32ArrayToBufferBE } from "./iv.ts";

function hasContentProtection(contentProtection: PlaylistItem["contentProtection"]): boolean {
  return !!contentProtection && Object.keys(contentProtection).length > 0;
}

function toVariant(item: PlaylistItem, manifestUrl: string): ManifestVariant {
  const resolution = item.attributes.RESOLUTION;
  return {
    url: new URL(item.uri, manifestUrl).href,
    bandwidth: item.attributes.BANDWIDTH,
    width: resolution?.width,
    height: resolution?.height,
    codecs: item.attributes.CODECS,
    drmProtected: hasContentProtection(item.contentProtection),
  };
}

function toEncryption(
  key: Segment["key"],
  manifestUrl: string,
  absoluteSequenceNumber: number,
  manifestHasContentProtection: boolean,
): SegmentEncryption {
  if (manifestHasContentProtection) {
    // FairPlay/PlayReady/Widevine key formats are recorded on the manifest's
    // contentProtection rather than attached to individual segments — the whole
    // playlist is protected, not just the segments that happen to carry a `key`.
    return { method: "DRM" };
  }
  if (!key || key.method === "NONE") {
    return { method: "NONE" };
  }
  if (key.method !== "AES-128") {
    return { method: "DRM" };
  }
  const iv = key.iv ? uint32ArrayToBufferBE(key.iv) : sequenceNumberToIv(absoluteSequenceNumber);
  return { method: "AES-128", keyUri: new URL(key.uri, manifestUrl).href, iv };
}

function toSegment(
  segment: Segment,
  manifestUrl: string,
  absoluteSequenceNumber: number,
  manifestHasContentProtection: boolean,
): ManifestSegment {
  return {
    url: new URL(segment.uri, manifestUrl).href,
    durationSeconds: segment.duration,
    initSegmentUrl: segment.map ? new URL(segment.map.uri, manifestUrl).href : undefined,
    encryption: toEncryption(segment.key, manifestUrl, absoluteSequenceNumber, manifestHasContentProtection),
  };
}

export function parseHlsManifest(text: string, manifestUrl: string): ParsedManifest {
  const parser = new Parser({ uri: manifestUrl });
  parser.push(text);
  parser.end();
  const manifest: Manifest = parser.manifest;

  if (manifest.playlists && manifest.playlists.length > 0) {
    return {
      kind: "variants",
      variants: manifest.playlists.map((item) => toVariant(item, manifestUrl)),
    };
  }

  const mediaSequence = manifest.mediaSequence ?? 0;
  const manifestHasContentProtection = hasContentProtection(manifest.contentProtection);
  const segments = manifest.segments.map((segment, index) =>
    toSegment(segment, manifestUrl, mediaSequence + index, manifestHasContentProtection),
  );
  return {
    kind: "segments",
    segments,
    live: !manifest.endList,
    drmProtected: segments.some((s) => s.encryption.method === "DRM") || manifestHasContentProtection,
  };
}
