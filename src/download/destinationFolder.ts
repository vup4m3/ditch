/**
 * Validates and normalizes a user-supplied relative folder path (e.g. "電影/2024") for use as a
 * Destination Folder under DOWNLOADS_DIR (see ADR-0008). Rejects path traversal (`..`), absolute
 * paths, and empty segments; returns a clean `/`-joined relative path, or "" for the root.
 */
export function sanitizeDestinationFolder(relativeFolder: unknown): string {
  const raw = typeof relativeFolder === "string" ? relativeFolder : "";
  const segments = raw
    .split(/[\\/]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error(`invalid destination folder segment: "${segment}"`);
    }
  }

  return segments.join("/");
}

/** Validates a single new folder name (one level — no path separators, see ADR-0008). */
export function sanitizeFolderName(name: unknown): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed || trimmed === "." || trimmed === ".." || /[\\/]/.test(trimmed)) {
    throw new Error(`invalid folder name: "${String(name)}"`);
  }
  return trimmed;
}
