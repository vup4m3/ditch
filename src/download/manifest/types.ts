export type EncryptionMethod = "NONE" | "AES-128" | "DRM";

export interface SegmentEncryption {
  method: EncryptionMethod;
  /** Present when method is "AES-128". */
  keyUri?: string;
  /** Present when method is "AES-128"; resolved from EXT-X-KEY or derived from the segment's sequence number. */
  iv?: Buffer;
}

export interface ManifestSegment {
  url: string;
  durationSeconds: number;
  /** fMP4 initialization segment URL (DASH, or HLS CMAF via EXT-X-MAP). */
  initSegmentUrl?: string;
  encryption: SegmentEncryption;
}

export interface ManifestVariant {
  url: string;
  bandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  /** Best-effort DRM signal at the variant level (mainly populated for DASH ContentProtection). */
  drmProtected?: boolean;
  /**
   * Populated when segments are already known from parsing the top-level manifest (DASH).
   * Left undefined when the caller must fetch `url` as a media playlist to get segments (HLS master playlist).
   */
  segments?: ManifestSegment[];
}

export type ParsedManifest =
  | { kind: "variants"; variants: ManifestVariant[] }
  | { kind: "segments"; segments: ManifestSegment[]; live: boolean; drmProtected: boolean };
