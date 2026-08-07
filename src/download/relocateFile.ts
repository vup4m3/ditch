import { rename, copyFile, unlink } from "node:fs/promises";

export interface RelocateFileFns {
  rename: typeof rename;
  copyFile: typeof copyFile;
  unlink: typeof unlink;
}

const defaultFns: RelocateFileFns = { rename, copyFile, unlink };

/**
 * Moves a file from `sourcePath` to `destPath`. Tries an atomic rename first; when source and
 * destination live on different filesystems (e.g. an SSD cache and an NFS-mounted destination),
 * rename fails with EXDEV, so this falls back to copying the bytes and then deleting the source.
 */
export async function relocateFile(sourcePath: string, destPath: string, fns: RelocateFileFns = defaultFns): Promise<void> {
  try {
    await fns.rename(sourcePath, destPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await fns.copyFile(sourcePath, destPath);
    await fns.unlink(sourcePath);
  }
}
