import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { Page } from "@playwright/test";

interface FixtureFile {
  base64: string;
  relativePath: string;
}

export function readFixtureFiles(root: string): FixtureFile[] {
  return readFixtureFilesRecursive(root, root);
}

export async function installFixtureDirectoryPicker(
  page: Page,
  payload: { files: readonly FixtureFile[]; rootName: string },
): Promise<void> {
  await page.addInitScript((fixture: { files: readonly FixtureFile[]; rootName: string }) => {
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => {
        const opfsRoot = await navigator.storage.getDirectory();

        await removeIfPresent(opfsRoot, "e2e-source-backups");

        const sourceRoot = await opfsRoot.getDirectoryHandle("e2e-source-backups", {
          create: true,
        });
        const backupRoot = await sourceRoot.getDirectoryHandle(fixture.rootName, {
          create: true,
        });

        for (const file of fixture.files) {
          await writeFixtureFile(backupRoot, file);
        }

        return backupRoot;
      },
    });

    async function writeFixtureFile(
      root: FileSystemDirectoryHandle,
      file: FixtureFile,
    ): Promise<void> {
      const pathParts = file.relativePath.split("/");
      const fileName = pathParts.pop();

      if (fileName === undefined) {
        throw new Error("Fixture file path is empty.");
      }

      let directory = root;
      for (const pathPart of pathParts) {
        directory = await directory.getDirectoryHandle(pathPart, { create: true });
      }

      const fileHandle = await directory.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();

      await writable.write(base64ToArrayBuffer(file.base64));
      await writable.close();
    }

    function base64ToArrayBuffer(base64: string): ArrayBuffer {
      const binary = atob(base64);
      const buffer = new ArrayBuffer(binary.length);
      const bytes = new Uint8Array(buffer);

      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }

      return buffer;
    }

    async function removeIfPresent(
      root: FileSystemDirectoryHandle,
      name: string,
    ): Promise<void> {
      try {
        await root.removeEntry(name, { recursive: true });
      } catch (cause) {
        if (!(cause instanceof Error) || cause.name !== "NotFoundError") {
          throw cause;
        }
      }
    }
  }, payload);
}

function readFixtureFilesRecursive(root: string, current: string): FixtureFile[] {
  const files: FixtureFile[] = [];

  for (const entry of readdirSync(current)) {
    const entryPath = path.join(current, entry);
    const stats = statSync(entryPath);

    if (stats.isDirectory()) {
      files.push(...readFixtureFilesRecursive(root, entryPath));
      continue;
    }

    if (!stats.isFile()) {
      continue;
    }

    files.push({
      relativePath: path.relative(root, entryPath).split(path.sep).join("/"),
      base64: readFileSync(entryPath).toString("base64"),
    });
  }

  return files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}
