import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDashManifest } from "./dash.ts";

const SAMPLE_MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT4S" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period>
    <AdaptationSet mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">
      <Representation id="v0" bandwidth="1000000" width="1280" height="720" codecs="avc1.4d401f">
        <SegmentTemplate media="v0-$Number$.m4s" initialization="v0-init.mp4" duration="2" startNumber="1" timescale="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>
`;

test("parses a DASH manifest into variants with their segments already resolved", () => {
  const result = parseDashManifest(SAMPLE_MPD, "https://example.com/videos/manifest.mpd");

  assert.equal(result.kind, "variants");
  assert.equal(result.variants.length, 1);
  const variant = result.variants[0]!;
  assert.equal(variant.bandwidth, 1000000);
  assert.equal(variant.width, 1280);
  assert.equal(variant.height, 720);
  assert.equal(variant.codecs, "avc1.4d401f");
  assert.equal(variant.drmProtected, false);

  assert.ok(variant.segments);
  assert.equal(variant.segments!.length, 2);
  assert.deepEqual(variant.segments![0], {
    url: "https://example.com/videos/v0-1.m4s",
    durationSeconds: 2,
    initSegmentUrl: "https://example.com/videos/v0-init.mp4",
    encryption: { method: "NONE" },
  });
  assert.deepEqual(variant.segments![1], {
    url: "https://example.com/videos/v0-2.m4s",
    durationSeconds: 2,
    initSegmentUrl: "https://example.com/videos/v0-init.mp4",
    encryption: { method: "NONE" },
  });
});

const DRM_MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT2S" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period>
    <AdaptationSet mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" value="widevine"/>
      <Representation id="v0" bandwidth="1000000" width="1280" height="720" codecs="avc1.4d401f">
        <SegmentTemplate media="v0-$Number$.m4s" initialization="v0-init.mp4" duration="2" startNumber="1" timescale="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>
`;

test("marks a Widevine-protected representation as DRM, with every segment reflecting it", () => {
  const result = parseDashManifest(DRM_MPD, "https://example.com/videos/manifest.mpd");

  assert.equal(result.kind, "variants");
  const variant = result.variants[0]!;
  assert.equal(variant.drmProtected, true);
  assert.ok(variant.segments && variant.segments.length > 0);
  for (const segment of variant.segments!) {
    assert.equal(segment.encryption.method, "DRM");
  }
});
