export type ReadonlySourceHandle = ReadonlySourceFileHandle | ReadonlySourceDirectoryHandle;

export interface ReadonlySourceFileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}

export interface ReadonlySourceDirectoryHandle {
  kind: "directory";
  name: string;
  entries(): AsyncIterableIterator<[string, ReadonlySourceHandle]>;
  getDirectory(name: string): Promise<ReadonlySourceDirectoryHandle>;
  getFile(name: string): Promise<File>;
}

type IterableFileSystemDirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<
    [string, FileSystemDirectoryHandle | FileSystemFileHandle]
  >;
};

export function asReadonlySourceDirectory(
  handle: FileSystemDirectoryHandle,
): ReadonlySourceDirectoryHandle {
  return {
    kind: "directory",
    name: handle.name,
    entries: () => readonlyEntries(handle),
    getDirectory: async (name) =>
      asReadonlySourceDirectory(await handle.getDirectoryHandle(name, { create: false })),
    getFile: async (name) =>
      (await handle.getFileHandle(name, { create: false })).getFile(),
  };
}

function asReadonlySourceFile(handle: FileSystemFileHandle): ReadonlySourceFileHandle {
  return {
    kind: "file",
    name: handle.name,
    getFile: () => handle.getFile(),
  };
}

async function* readonlyEntries(
  handle: FileSystemDirectoryHandle,
): AsyncIterableIterator<[string, ReadonlySourceHandle]> {
  const iterableHandle = handle as IterableFileSystemDirectoryHandle;

  for await (const [name, child] of iterableHandle.entries()) {
    if (child.kind === "directory") {
      yield [name, asReadonlySourceDirectory(child)];
      continue;
    }

    yield [name, asReadonlySourceFile(child)];
  }
}
