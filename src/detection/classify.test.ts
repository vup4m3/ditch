import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyResponse } from "./classify.ts";

test("returns an empty list for content types/URLs it doesn't recognize", () => {
  const candidates = classifyResponse("https://example.com/page.html", "text/html", "<html></html>");
  assert.deepEqual(candidates, []);
});

test("expands an HLS master playlist into one candidate per quality variant", () => {
  const text = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=720x480
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1920x1080
hi/index.m3u8
`;

  const candidates = classifyResponse(
    "https://example.com/videos/master.m3u8",
    "application/vnd.apple.mpegurl",
    text,
  );

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0]?.type, "hls");
  assert.equal(candidates[0]?.url, "https://example.com/videos/low/index.m3u8");
  assert.equal(candidates[0]?.label, "480p");
  assert.equal(candidates[0]?.drmProtected, false);
  assert.equal(candidates[1]?.url, "https://example.com/videos/hi/index.m3u8");
  assert.equal(candidates[1]?.label, "1080p");
  assert.ok(candidates[0]?.id);
  assert.notEqual(candidates[0]?.id, candidates[1]?.id);
});

test("recognizes an HLS master playlist by .m3u8 extension even without a matching content-type", () => {
  const text = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=720x480
low/index.m3u8
`;
  const candidates = classifyResponse("https://example.com/videos/master.m3u8", "application/octet-stream", text);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.type, "hls");
});

test("treats an HLS media playlist (no variants) as a single candidate pointing at itself", () => {
  const text = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
seg0.ts
#EXT-X-ENDLIST
`;
  const candidates = classifyResponse("https://example.com/videos/hi/index.m3u8", "application/vnd.apple.mpegurl", text);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.type, "hls");
  assert.equal(candidates[0]?.url, "https://example.com/videos/hi/index.m3u8");
  assert.equal(candidates[0]?.drmProtected, false);
});

test("treats a direct video response as a single non-DRM candidate", () => {
  const candidates = classifyResponse("https://example.com/videos/clip.mp4", "video/mp4", "");
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0], {
    id: candidates[0]!.id,
    url: "https://example.com/videos/clip.mp4",
    type: "direct",
    drmProtected: false,
  });
});

test("recognizes a direct audio response by content-type even with an unfamiliar extension", () => {
  const candidates = classifyResponse("https://example.com/stream?id=42", "audio/mpeg", "");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.type, "direct");
});
