import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHlsManifest } from "./hls.ts";
import { sequenceNumberToIv } from "./iv.ts";

test("parses a master playlist into variants, resolving relative URLs", () => {
  const text = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=720x480,CODECS="avc1.4d001f"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1920x1080,CODECS="avc1.4d001f"
hi/index.m3u8
`;

  const result = parseHlsManifest(text, "https://example.com/videos/master.m3u8");

  assert.equal(result.kind, "variants");
  if (result.kind !== "variants") return;
  assert.equal(result.variants.length, 2);
  assert.deepEqual(result.variants[0], {
    url: "https://example.com/videos/low/index.m3u8",
    bandwidth: 1280000,
    width: 720,
    height: 480,
    codecs: "avc1.4d001f",
    drmProtected: false,
  });
  assert.deepEqual(result.variants[1], {
    url: "https://example.com/videos/hi/index.m3u8",
    bandwidth: 2560000,
    width: 1920,
    height: 1080,
    codecs: "avc1.4d001f",
    drmProtected: false,
  });
});

test("parses an unencrypted VOD media playlist into segments, resolving relative URLs", () => {
  const text = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
seg0.ts
#EXTINF:9.5,
seg1.ts
#EXT-X-ENDLIST
`;

  const result = parseHlsManifest(text, "https://example.com/videos/hi/index.m3u8");

  assert.equal(result.kind, "segments");
  if (result.kind !== "segments") return;
  assert.equal(result.live, false);
  assert.equal(result.drmProtected, false);
  assert.deepEqual(result.segments, [
    {
      url: "https://example.com/videos/hi/seg0.ts",
      durationSeconds: 10.0,
      initSegmentUrl: undefined,
      encryption: { method: "NONE" },
    },
    {
      url: "https://example.com/videos/hi/seg1.ts",
      durationSeconds: 9.5,
      initSegmentUrl: undefined,
      encryption: { method: "NONE" },
    },
  ]);
});

test("marks a media playlist without EXT-X-ENDLIST as live", () => {
  const text = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
seg0.ts
`;

  const result = parseHlsManifest(text, "https://example.com/videos/hi/index.m3u8");

  assert.equal(result.kind, "segments");
  if (result.kind !== "segments") return;
  assert.equal(result.live, true);
});

test("resolves an explicit EXT-X-KEY IV for AES-128 segments", () => {
  const text = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000001
#EXTINF:10.0,
seg0.ts
#EXT-X-ENDLIST
`;

  const result = parseHlsManifest(text, "https://example.com/videos/hi/index.m3u8");

  assert.equal(result.kind, "segments");
  if (result.kind !== "segments") return;
  assert.equal(result.drmProtected, false);
  assert.deepEqual(result.segments[0]?.encryption, {
    method: "AES-128",
    keyUri: "https://example.com/videos/hi/key.bin",
    iv: sequenceNumberToIv(1),
  });
});

test("derives the default IV from the segment's absolute media sequence number when EXT-X-KEY has no IV", () => {
  const text = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:5
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:10.0,
seg0.ts
#EXTINF:10.0,
seg1.ts
#EXT-X-ENDLIST
`;

  const result = parseHlsManifest(text, "https://example.com/videos/hi/index.m3u8");

  assert.equal(result.kind, "segments");
  if (result.kind !== "segments") return;
  assert.deepEqual(result.segments[0]?.encryption.iv, sequenceNumberToIv(5));
  assert.deepEqual(result.segments[1]?.encryption.iv, sequenceNumberToIv(6));
});

test("treats SAMPLE-AES (and other non AES-128 key methods) as DRM", () => {
  const text = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://example.com/key"
#EXTINF:10.0,
seg0.ts
#EXT-X-ENDLIST
`;

  const result = parseHlsManifest(text, "https://example.com/videos/hi/index.m3u8");

  assert.equal(result.kind, "segments");
  if (result.kind !== "segments") return;
  assert.equal(result.drmProtected, true);
  assert.equal(result.segments[0]?.encryption.method, "DRM");
});

test("resolves EXT-X-MAP as the segment's fMP4 init segment URL", () => {
  const text = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:10
#EXT-X-MAP:URI="init.mp4"
#EXTINF:10.0,
seg0.m4s
#EXT-X-ENDLIST
`;

  const result = parseHlsManifest(text, "https://example.com/videos/hi/index.m3u8");

  assert.equal(result.kind, "segments");
  if (result.kind !== "segments") return;
  assert.equal(result.segments[0]?.initSegmentUrl, "https://example.com/videos/hi/init.mp4");
});

test("treats FairPlay-signaled content (KEYFORMAT com.apple.streamingkeydelivery) as DRM for every segment", () => {
  // m3u8-parser records FairPlay/PlayReady/Widevine KEYFORMAT-tagged keys on
  // manifest.contentProtection instead of attaching a `key` to segments, since
  // the whole playlist is protected rather than a single rotating key.
  const text = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:10.0,
seg0.ts
#EXT-X-ENDLIST
`;

  const result = parseHlsManifest(text, "https://example.com/videos/hi/index.m3u8");

  assert.equal(result.kind, "segments");
  if (result.kind !== "segments") return;
  assert.equal(result.drmProtected, true);
  assert.equal(result.segments[0]?.encryption.method, "DRM");
});
