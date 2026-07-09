// Ambient declarations for the Chrome-only File System Access API surface the
// app depends on. The boot capability gate (src/lib/capabilities.ts) guarantees
// these exist at runtime on workspace routes, so they are declared as
// non-optional here and call sites use them without per-file structural casts.

interface FileSystemHandlePermissionDescriptor {
  mode?: "read" | "readwrite";
}

interface FileSystemHandle {
  queryPermission(
    descriptor?: FileSystemHandlePermissionDescriptor,
  ): Promise<PermissionState>;
  requestPermission(
    descriptor?: FileSystemHandlePermissionDescriptor,
  ): Promise<PermissionState>;
}

interface FileSystemFileHandle {
  // Chrome-only removal of the file backing this handle. Used to clean up the
  // zero-byte stub showSaveFilePicker creates when an extraction fails before
  // any bytes are committed.
  remove(): Promise<void>;
}

interface DataTransferItem {
  getAsFileSystemHandle(): Promise<FileSystemHandle | null>;
}

interface DirectoryPickerOptions {
  id?: string;
  mode?: "read" | "readwrite";
  startIn?: FileSystemHandle | string;
}

interface FilePickerAcceptType {
  accept: Record<string, string[]>;
  description?: string;
}

interface SaveFilePickerOptions {
  excludeAcceptAllOption?: boolean;
  id?: string;
  startIn?: FileSystemHandle | string;
  suggestedName?: string;
  types?: FilePickerAcceptType[];
}

interface Window {
  showDirectoryPicker(
    options?: DirectoryPickerOptions,
  ): Promise<FileSystemDirectoryHandle>;
  showSaveFilePicker(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
}
