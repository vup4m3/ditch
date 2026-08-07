import type { ManifestSegment } from "../download/manifest/types.ts";

export type CandidateType = "hls" | "dash" | "direct";

export interface Candidate {
  id: string;
  /** For hls/dash: the manifest URL (media playlist or the DASH variant's own URL). For direct: the file URL. */
  url: string;
  type: CandidateType;
  label?: string;
  drmProtected: boolean;
  /**
   * Populated for DASH, whose segments are already fully known from the single top-level
   * manifest parse. Left undefined for HLS (the media playlist at `url` must still be
   * fetched at download time) and direct files (no manifest at all).
   */
  segments?: ManifestSegment[];
}
