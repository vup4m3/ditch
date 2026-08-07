declare module "mpd-parser" {
  import type { Manifest, PlaylistItem as BasePlaylistItem, Segment as BaseSegment } from "m3u8-parser";

  export interface Segment extends BaseSegment {
    resolvedUri?: string;
    map?: BaseSegment["map"] & { resolvedUri?: string };
  }

  export interface PlaylistItem extends Omit<BasePlaylistItem, "segments"> {
    resolvedUri?: string;
    segments: Segment[];
  }

  export interface DashManifest extends Omit<Manifest, "playlists"> {
    playlists?: PlaylistItem[];
  }

  export function parse(manifestString: string, options?: { manifestUri?: string }): DashManifest;
}
