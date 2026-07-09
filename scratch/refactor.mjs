import fs from 'fs';

const filePath = 'src/features/m3/messages-route.tsx';
let content = fs.readFileSync(filePath, 'utf-8');

// The original AttachmentView function definition
const originalAttachmentViewStart = `function AttachmentView({`;
const startIndex = content.indexOf(originalAttachmentViewStart);

if (startIndex === -1) {
  console.error("Could not find AttachmentView");
  process.exit(1);
}

// Find the end of AttachmentView
const endStr = `\nfunction DetailPane({`;
const endIndex = content.indexOf(endStr);

const attachmentViewContent = content.substring(startIndex, endIndex);

// Now we need to extract useAttachmentPreview
const hookDef = `function useAttachmentPreview({
  attachment,
  getBackupClient,
  getMediaClient,
  record,
  runPreviewTask,
}: {
  attachment: DbAttachmentSummary;
  getBackupClient: () => BackupWorkerClient;
  getMediaClient: () => MediaWorkerClient;
  record: RecentBackupRecord;
  runPreviewTask: RunPreviewTask;
}) {
  const [previewState, setPreviewState] = useState<AttachmentPreviewState>({
    kind: "idle",
  });
  const mountedRef = useRef(true);
  const previewRequestIdRef = useRef(0);
  const canReadSource = attachment.sourceDomain !== undefined && attachment.sourcePath !== undefined;

  const commitPreviewState = useCallback(
    (requestId: number, nextState: AttachmentPreviewState): boolean => {
      if (!mountedRef.current || previewRequestIdRef.current !== requestId) {
        revokePreviewStateUrl(nextState);
        return false;
      }
      setPreviewState(nextState);
      return true;
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      previewRequestIdRef.current += 1;
    };
  }, []);

  const loadPreview = useCallback(
    async (requestPermission: boolean) => {
      const requestId = previewRequestIdRef.current + 1;
      previewRequestIdRef.current = requestId;

      if (!isInlinePreviewMediaKind(attachment.mediaKind)) {
        return;
      }

      commitPreviewState(requestId, { kind: "loading" });

      if (isThumbnailPreviewMediaKind(attachment.mediaKind)) {
        let cachedResult:
          | Awaited<
              ReturnType<
                MediaWorkerClient["api"]["getCachedAttachmentThumbnail"]
              >
            >
          | undefined;

        try {
          const mediaClient = getMediaClient();
          cachedResult = await mediaClient.api.getCachedAttachmentThumbnail({
            backupId: record.id,
            cacheKey: attachment.thumbnailCacheKey,
            mediaKind: attachment.mediaKind,
          });
        } catch {
          cachedResult = undefined;
        }

        if (!mountedRef.current || previewRequestIdRef.current !== requestId) {
          if (cachedResult?.ok === true && cachedResult.value.status === "ok") {
            revokePreviewStateUrl(createThumbnailPreviewState(cachedResult.value));
          }
          return;
        }

        if (cachedResult?.ok === true && cachedResult.value.status === "ok") {
          commitPreviewState(
            requestId,
            createThumbnailPreviewState(cachedResult.value),
          );
          return;
        }
      }

      if (!canReadSource) {
        commitPreviewState(requestId, {
          kind: "unsupported",
          message: "Preview unavailable because source provenance is incomplete.",
        });
        return;
      }

      const permission = await ensureRecentBackupDirectoryPermission(record, {
        request: requestPermission,
      });

      if (permission !== "granted") {
        commitPreviewState(requestId, { kind: "needs-permission" });
        return;
      }

      try {
        await runPreviewTask(async () => {
          if (!mountedRef.current || previewRequestIdRef.current !== requestId) {
            return;
          }

          const backupClient = getBackupClient();
          const sourceResult = await backupClient.api.readUnencryptedSourceFile(
            record.directoryHandle,
            {
              backupId: record.id,
              expectedSha256: attachment.sha256,
              filename: attachment.filename,
              maxReadBytes:
                attachment.mediaKind === "video"
                  ? previewVideoMaxBytes
                  : previewImageMaxBytes,
              mime: attachment.mime,
              sourceDomain: attachment.sourceDomain ?? "",
              sourceGuid: attachment.sourceGuid,
              sourcePath: attachment.sourcePath ?? "",
            },
          );

          if (!sourceResult.ok) {
            commitPreviewState(requestId, {
              kind: "error",
              message: formatWorkerResultError(sourceResult.error),
            });
            return;
          }

          if (attachment.mediaKind === "video") {
            commitPreviewState(
              requestId,
              createOriginalMediaPreviewState(
                "video",
                sourceResult.value.bytes,
                sourceResult.value.mime ?? attachment.mime,
              ),
            );
            return;
          }

          const mediaClient = getMediaClient();
          const originalPreview = attachment.mediaKind === "image"
            ? createOriginalMediaPreviewState(
                "image",
                sourceResult.value.bytes,
                sourceResult.value.mime ?? attachment.mime,
              )
            : undefined;
          let originalPreviewHandled = false;

          const commitThumbnailFallback = (
            reason: "failed" | "unsupported",
            detail: string,
          ) => {
            if (originalPreview === undefined) {
              commitPreviewState(
                requestId,
                reason === "unsupported"
                  ? { kind: "unsupported", message: detail }
                  : {
                      kind: "error",
                      message: \`HEIC thumbnail generation failed: \${detail}\`,
                    },
              );
              return;
            }

            commitPreviewState(requestId, {
              ...originalPreview,
              caption: \`Showing original image because thumbnail generation \${
                reason === "unsupported" ? "is unsupported" : "failed"
              }: \${detail}\`,
            });
            originalPreviewHandled = true;
          };

          try {
            const thumbnailResult = await mediaClient.api.createAttachmentThumbnail(
              transfer(
                {
                  backupId: record.id,
                  bytes: sourceResult.value.bytes,
                  cacheKey: attachment.thumbnailCacheKey,
                  mediaKind: attachment.mediaKind,
                  mime: attachment.mime,
                  maxPixelSize: defaultThumbnailMaxPixelSize,
                },
                [sourceResult.value.bytes.buffer as ArrayBuffer],
              ),
            );

            if (!thumbnailResult.ok) {
              commitThumbnailFallback(
                "failed",
                formatWorkerResultError(thumbnailResult.error),
              );
              return;
            }

            if (thumbnailResult.value.status === "unsupported") {
              commitThumbnailFallback(
                "unsupported",
                thumbnailResult.value.message,
              );
              return;
            }

            const thumbnailPreview = createThumbnailPreviewState(
              thumbnailResult.value,
            );

            if (commitPreviewState(requestId, thumbnailPreview)) {
              if (originalPreview !== undefined) {
                URL.revokeObjectURL(originalPreview.url);
              }
              originalPreviewHandled = true;
            }
          } catch (cause) {
            commitThumbnailFallback("failed", formatError(cause));
          } finally {
            if (originalPreview !== undefined && !originalPreviewHandled) {
              URL.revokeObjectURL(originalPreview.url);
            }
          }
        });
      } catch (cause) {
        commitPreviewState(requestId, { kind: "error", message: formatError(cause) });
      }
    },
    [
      attachment,
      canReadSource,
      commitPreviewState,
      getBackupClient,
      getMediaClient,
      record,
      runPreviewTask,
    ],
  );

  useEffect(() => {
    previewRequestIdRef.current += 1;
    if (attachment.mediaKind === "video") {
      setPreviewState({ kind: "idle" });
      return;
    }
    if (!isThumbnailPreviewMediaKind(attachment.mediaKind)) {
      setPreviewState({
        kind: "unsupported",
        message: unsupportedAttachmentMessage(attachment),
      });
      return;
    }
    void loadPreview(false);
  }, [attachment, attachment.mediaKind, loadPreview]);

  useEffect(
    () => () => {
      if (previewState.kind === "image" || previewState.kind === "video") {
        URL.revokeObjectURL(previewState.url);
      }
    },
    [previewState],
  );

  return { previewState, loadPreview };
}

function AttachmentPreview({
  attachment,
  getBackupClient,
  getMediaClient,
  record,
  runPreviewTask,
}: {
  attachment: DbAttachmentSummary;
  getBackupClient: () => BackupWorkerClient;
  getMediaClient: () => MediaWorkerClient;
  record: RecentBackupRecord;
  runPreviewTask: RunPreviewTask;
}) {
  const { previewState, loadPreview } = useAttachmentPreview({
    attachment,
    getBackupClient,
    getMediaClient,
    record,
    runPreviewTask,
  });

  return (
    <span className="block">
      {previewState.kind === "image" ? (
        <>
          <img
            alt={attachment.filename ?? "Attachment preview"}
            className="max-h-[calc(var(--space-64)_+_var(--space-64)_+_var(--space-64)_+_var(--space-64)_+_var(--space-64))] max-w-[calc(var(--space-64)_+_var(--space-64)_+_var(--space-64)_+_var(--space-64)_+_var(--space-64))] rounded-md border border-border object-contain bg-surface-sunken"
            height={previewState.height}
            src={previewState.url}
            width={previewState.width}
          />
          {previewState.caption === undefined ? null : (
            <span className="mt-2 block text-caption text-text-secondary">
              {previewState.caption}
            </span>
          )}
        </>
      ) : previewState.kind === "video" ? (
        <video
          className="max-h-[calc(var(--space-64)_+_var(--space-64)_+_var(--space-64)_+_var(--space-64)_+_var(--space-64))] max-w-[calc(var(--space-64)_+_var(--space-64)_+_var(--space-64)_+_var(--space-64)_+_var(--space-64))] rounded-md border border-border bg-surface-sunken"
          controls
          preload="metadata"
          src={previewState.url}
        >
          Video preview is unavailable in this browser runtime.
        </video>
      ) : previewState.kind === "loading" ? (
        <span className="text-caption text-text-secondary">Loading preview.</span>
      ) : previewState.kind === "needs-permission" ? (
        <Button
          onClick={(e) => {
            e.stopPropagation();
            void loadPreview(true);
          }}
          size="sm"
          type="button"
          variant="secondary"
        >
          Load preview
        </Button>
      ) : previewState.kind === "unsupported" ? (
        <span className="text-caption text-text-secondary">{previewState.message}</span>
      ) : previewState.kind === "error" ? (
        <span className="text-caption text-danger">{previewState.message}</span>
      ) : attachment.mediaKind === "video" ? (
        <Button
          onClick={(e) => {
            e.stopPropagation();
            void loadPreview(true);
          }}
          size="sm"
          type="button"
          variant="secondary"
        >
          <Video aria-hidden="true" className="size-4" />
          Load video preview
        </Button>
      ) : null}
    </span>
  );
}

function AttachmentDetailCard({
  attachment,
  getBackupClient,
  getMediaClient,
  record,
  runPreviewTask,
}: {
  attachment: DbAttachmentSummary;
  getBackupClient: () => BackupWorkerClient;
  getMediaClient: () => MediaWorkerClient;
  record: RecentBackupRecord;
  runPreviewTask: RunPreviewTask;
}) {
  const [extractState, setExtractState] = useState<
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "permission-granted" }
    | { kind: "success" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  
  const mountedRef = useRef(true);
  const extractStubCleanupRef = useRef<(() => void) | undefined>(undefined);
  const canReadSource = attachment.sourceDomain !== undefined && attachment.sourcePath !== undefined;

  const setExtractStateIfMounted = useCallback(
    (nextState: typeof extractState) => {
      if (mountedRef.current) {
        setExtractState(nextState);
      }
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      extractStubCleanupRef.current?.();
      extractStubCleanupRef.current = undefined;
    };
  }, []);

  const extractOriginal = async () => {
    if (!canReadSource) {
      setExtractStateIfMounted({
        kind: "error",
        message: "Cannot extract this attachment because source provenance is incomplete.",
      });
      return;
    }

    setExtractStateIfMounted({ kind: "running" });

    try {
      let permission = await ensureRecentBackupDirectoryPermission(record, {
        request: false,
      });
      let requestedPermission = false;

      if (permission !== "granted") {
        requestedPermission = true;
        permission = await ensureRecentBackupDirectoryPermission(record, {
          request: true,
        });
      }

      if (permission !== "granted") {
        setExtractStateIfMounted({
          kind: "error",
          message: \`Chrome did not grant read access to \${record.friendlyName}.\`,
        });
        return;
      }

      if (requestedPermission && !navigator.userActivation.isActive) {
        setExtractStateIfMounted({ kind: "permission-granted" });
        return;
      }

      const fileHandle = await window.showSaveFilePicker({
        suggestedName: attachment.filename ?? "attachment",
        types:
          attachment.mime === undefined
            ? undefined
            : [
                {
                  accept: { [attachment.mime]: [extensionForAttachment(attachment)] },
                  description: attachment.mime,
                },
              ],
      });

      let stubPending = true;
      const removeStub = async () => {
        if (!stubPending) {
          return;
        }

        stubPending = false;
        extractStubCleanupRef.current = undefined;

        try {
          await fileHandle.remove();
        } catch {
        }
      };

      extractStubCleanupRef.current = () => {
        void removeStub();
      };

      try {
        const backupClient = getBackupClient();
        const sourceResult = await backupClient.api.readUnencryptedSourceFile(
          record.directoryHandle,
          {
            backupId: record.id,
            expectedSha256: attachment.sha256,
            filename: attachment.filename,
            maxReadBytes: extractMaxReadBytes,
            mime: attachment.mime,
            sourceDomain: attachment.sourceDomain ?? "",
            sourceGuid: attachment.sourceGuid,
            sourcePath: attachment.sourcePath ?? "",
          },
        );

        if (!sourceResult.ok) {
          setExtractStateIfMounted({
            kind: "error",
            message: formatWorkerResultError(sourceResult.error),
          });
          return;
        }

        const writable = await fileHandle.createWritable();

        try {
          await writable.write(sourceResult.value.bytes as Uint8Array<ArrayBuffer>);
        } finally {
          await writable.close();
        }

        stubPending = false;
        extractStubCleanupRef.current = undefined;
        setExtractStateIfMounted({ kind: "success" });
      } finally {
        await removeStub();
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") {
        setExtractStateIfMounted({ kind: "idle" });
        return;
      }
      setExtractStateIfMounted({ kind: "error", message: formatError(cause) });
    }
  };

  return (
    <div className="rounded-md border border-border bg-surface-sunken p-3">
      <span className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex size-[var(--control-height-md)] shrink-0 items-center justify-center rounded-md bg-surface text-text-tertiary shadow-sm border border-border">
          {attachment.mediaKind === "video" ? (
            <Video aria-hidden="true" className="size-4" />
          ) : (
            <Image aria-hidden="true" className="size-4" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body font-[var(--font-weight-strong)] text-text">
            {attachment.filename ?? "Unnamed attachment"}
          </span>
          <span className="mt-1 block text-caption text-text-secondary">
            {attachment.mediaKind} / {formatBytes(attachment.bytes)}
          </span>
        </span>
      </span>

      <span className="mt-3 block">
        <AttachmentPreview
          attachment={attachment}
          getBackupClient={getBackupClient}
          getMediaClient={getMediaClient}
          record={record}
          runPreviewTask={runPreviewTask}
        />
      </span>

      <dl className="mt-4 grid gap-2">
        <DataRow label="Source domain" value={attachment.sourceDomain} />
        <DataRow label="Source path" value={attachment.sourcePath} />
        <DataRow label="Source GUID" value={attachment.sourceGuid} />
        <DataRow label="SHA-256" value={attachment.sha256} />
      </dl>

      <span className="mt-4 flex items-center gap-2 border-t border-border pt-4">
        <Button
          disabled={!canReadSource || extractState.kind === "running"}
          onClick={() => {
            void extractOriginal();
          }}
          size="sm"
          type="button"
          variant="secondary"
        >
          <Download aria-hidden="true" className="size-4" />
          Extract original
        </Button>
        {extractState.kind === "success" ? (
          <span className="text-caption text-success">Saved</span>
        ) : null}
      </span>
      {extractState.kind === "permission-granted" ? (
        <span
          className="mt-2 block rounded-md bg-[var(--info-subtle)] px-3 py-2 text-caption text-[var(--info-foreground)]"
          role="status"
        >
          Chrome granted read access to {record.friendlyName}. Click Extract
          original again to choose where to save the file.
        </span>
      ) : null}
      {extractState.kind === "error" ? (
        <span className="mt-2 block text-caption text-danger">{extractState.message}</span>
      ) : null}
    </div>
  );
}
`;

const newContent = content.substring(0, startIndex) + hookDef + content.substring(endIndex);

fs.writeFileSync(filePath, newContent, 'utf-8');
console.log("Successfully replaced AttachmentView with hook and new components.");
