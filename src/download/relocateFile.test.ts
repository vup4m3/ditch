import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, copyFile as realCopyFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relocateFile } from "./relocateFile.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ditch-relocate-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("moves a file within the same filesystem via rename", async () => {
  await withTempDir(async (dir) => {
    const source = join(dir, "source.ts");
    const dest = join(dir, "dest.ts");
    await writeFile(source, "hello");

    await relocateFile(source, dest);

    assert.equal(await readFile(dest, "utf8"), "hello");
    await assert.rejects(access(source));
  });
});

test("falls back to copy+delete when rename fails with EXDEV (cross-device, e.g. SSD cache -> NFS destination)", async () => {
  await withTempDir(async (dir) => {
    const source = join(dir, "source.ts");
    const dest = join(dir, "dest.ts");
    await writeFile(source, "hello");

    const calls: string[] = [];
    await relocateFile(source, dest, {
      rename: async () => {
        calls.push("rename");
        throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
      },
      copyFile: async (src, d) => {
        calls.push("copyFile");
        await realCopyFile(src as string, d as string);
      },
      unlink: async (p) => {
        calls.push("unlink");
        await rm(p as string);
      },
    });

    assert.deepEqual(calls, ["rename", "copyFile", "unlink"]);
    assert.equal(await readFile(dest, "utf8"), "hello");
    await assert.rejects(access(source));
  });
});

test("propagates non-EXDEV rename errors instead of falling back", async () => {
  await withTempDir(async (dir) => {
    const source = join(dir, "source.ts");
    const dest = join(dir, "dest.ts");
    await writeFile(source, "hello");

    let copyFileCalled = false;
    await assert.rejects(
      relocateFile(source, dest, {
        rename: async () => {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        },
        copyFile: async (...args) => {
          copyFileCalled = true;
          await realCopyFile(...(args as [string, string]));
        },
        unlink: async (p) => rm(p as string),
      }),
      /permission denied/,
    );
    assert.equal(copyFileCalled, false);
  });
});
