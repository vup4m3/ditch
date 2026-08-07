import { open, type FileHandle } from "node:fs/promises";
import type { ManifestSegment } from "./manifest/types.ts";
import { decryptAes128Cbc } from "./crypto.ts";
import { createBrowserSession, type BrowserSession } from "./browserFetch.ts";
import { DESKTOP_CHROME_USER_AGENT } from "../detection/stealth.ts";

export interface DownloadRequestOptions {
  referer?: string;
  cookie?: string;
  userAgent?: string;
}

export interface DownloadProgress {
  completedSegments: number;
  totalSegments: number;
}

function buildHeaders(options: DownloadRequestOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options.referer) headers["Referer"] = options.referer;
  if (options.cookie) headers["Cookie"] = options.cookie;
  if (options.userAgent) headers["User-Agent"] = options.userAgent;
  return headers;
}

async function fetchBuffer(url: string, headers: Record<string, string>): Promise<Buffer> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`failed to fetch ${url}: HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function downloadToFile(
  segments: ManifestSegment[],
  outputPath: string,
  options: DownloadRequestOptions,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<void> {
  const headers = buildHeaders(options);
  const file: FileHandle = await open(outputPath, "w");
  let writtenInitSegmentUrl: string | undefined;
  const keyCache = new Map<string, Buffer>();
  let browserSession: BrowserSession | undefined;

  // Some CDNs (Cloudflare, etc.) block Node's fetch outright regardless of headers — the
  // browser earned clearance Node has no way to replicate (ADR-0003). Falls back once a
  // job actually needs it, then reuses the same warmed-up session for the rest of the job.
  async function fetchWithFallback(url: string): Promise<Buffer> {
    try {
      return await fetchBuffer(url, headers);
    } catch (nodeErr) {
      if (!options.referer) throw nodeErr;
      browserSession ??= await createBrowserSession(options.referer, options.userAgent ?? DESKTOP_CHROME_USER_AGENT);
      return await browserSession.fetchBuffer(url);
    }
  }

  async function getKey(keyUri: string): Promise<Buffer> {
    const cached = keyCache.get(keyUri);
    if (cached) return cached;
    const key = await fetchWithFallback(keyUri);
    keyCache.set(keyUri, key);
    return key;
  }

  try {
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      if (segment.initSegmentUrl && segment.initSegmentUrl !== writtenInitSegmentUrl) {
        const initData = await fetchWithFallback(segment.initSegmentUrl);
        await file.write(initData);
        writtenInitSegmentUrl = segment.initSegmentUrl;
      }

      let data = await fetchWithFallback(segment.url);
      const { encryption } = segment;
      if (encryption.method === "AES-128") {
        if (!encryption.keyUri || !encryption.iv) {
          throw new Error(`segment ${segment.url} is marked AES-128 but is missing keyUri/iv`);
        }
        const key = await getKey(encryption.keyUri);
        data = decryptAes128Cbc(data, key, encryption.iv);
      } else if (encryption.method === "DRM") {
        throw new Error(`segment ${segment.url} is DRM-protected and cannot be downloaded`);
      }

      await file.write(data);
      onProgress?.({ completedSegments: i + 1, totalSegments: segments.length });
    }
  } finally {
    await file.close();
    await browserSession?.close();
  }
}
