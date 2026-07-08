/**
 * Extracts the first dropped directory handle from a drop event's items.
 *
 * Every getAsFileSystemHandle() call is issued synchronously during drop
 * dispatch: the drag data store deactivates as soon as the handler yields to
 * the event loop, so awaiting between items would make every later item
 * return null. The boot capability gate guarantees the API exists on
 * workspace routes, so items are not re-probed here.
 */
export async function firstDroppedDirectoryHandle(
  items: DataTransferItemList,
): Promise<FileSystemDirectoryHandle | undefined> {
  const handlePromises = Array.from(items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFileSystemHandle());
  const handles = await Promise.all(handlePromises);

  return handles.find(isDirectoryHandle);
}

function isDirectoryHandle(
  handle: FileSystemHandle | null,
): handle is FileSystemDirectoryHandle {
  return handle?.kind === "directory";
}
