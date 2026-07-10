import {
  AlertCircle,
  CheckCircle2,
  FolderOpen,
  HardDrive,
  Pencil,
  RotateCw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Link, useNavigate } from "react-router";

import {
  EmptyState,
  PageShell,
  Panel,
  PanelHeader,
} from "../../components/layout/page-shell";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmationDialog } from "../../components/ui/confirmation-dialog";
import { Tooltip, TooltipProvider } from "../../components/ui/tooltip";
import { cn } from "../../lib/cn";
import { firstDroppedDirectoryHandle } from "../../lib/drag-drop";
import {
  createBackupRecentsStore,
  ensureRecentBackupDirectoryPermission,
  type RecentBackupRecord,
} from "../../lib/recents";
import {
  createBackupWorkerClient,
  proxiedWorkerProgress,
} from "../../lib/worker-client";
import {
  formatWorkerErrorPayload,
  type BackupDetectionResult,
  type WorkerProgressEvent,
} from "../../lib/worker-types";
import { WorkerDiagnostics } from "../m0/worker-diagnostics";

type OpeningStatus =
  | { kind: "idle" }
  | { kind: "running"; label: string }
  | { kind: "success"; label: string }
  | { kind: "error"; label: string };

interface ReplacementPromptState {
  detection: BackupDetectionResult;
  existing: RecentBackupRecord;
}

type ReplacementDecision = "keep" | "replace" | "unmounted";

export function LandingRoute() {
  const navigate = useNavigate();
  const recentsStore = useMemo(() => createBackupRecentsStore(), []);
  const [recents, setRecents] = useState<RecentBackupRecord[]>([]);
  const [openingStatus, setOpeningStatus] = useState<OpeningStatus>({ kind: "idle" });
  const [isDragging, setIsDragging] = useState(false);
  const [isLoadingRecents, setIsLoadingRecents] = useState(true);
  const [replacementPrompt, setReplacementPrompt] =
    useState<ReplacementPromptState | null>(null);
  const replacementResolverRef = useRef<
    ((decision: ReplacementDecision) => void) | null
  >(null);
  const routeActiveRef = useRef(true);

  const reportError = useCallback((cause: unknown) => {
    setOpeningStatus({
      kind: "error",
      label: cause instanceof Error ? cause.message : String(cause),
    });
  }, []);

  const refreshRecents = useCallback(async () => {
    setIsLoadingRecents(true);
    try {
      setRecents(await recentsStore.list());
    } catch (cause) {
      reportError(cause);
    } finally {
      setIsLoadingRecents(false);
    }
  }, [recentsStore, reportError]);

  useEffect(() => {
    void refreshRecents();
  }, [refreshRecents]);

  useEffect(() => {
    routeActiveRef.current = true;

    return () => {
      routeActiveRef.current = false;
      replacementResolverRef.current?.("unmounted");
      replacementResolverRef.current = null;
    };
  }, []);

  const resolveReplacementPrompt = useCallback((decision: "keep" | "replace") => {
    const resolve = replacementResolverRef.current;

    replacementResolverRef.current = null;
    setReplacementPrompt(null);
    resolve?.(decision);
  }, []);

  const requestReplacementConfirmation = useCallback(
    (
      existing: RecentBackupRecord,
      detection: BackupDetectionResult,
    ): Promise<ReplacementDecision> =>
      new Promise((resolve) => {
        if (!routeActiveRef.current) {
          resolve("unmounted");
          return;
        }

        replacementResolverRef.current?.("keep");
        replacementResolverRef.current = resolve;
        setReplacementPrompt({ detection, existing });
      }),
    [],
  );

  // Serializes detection runs: the drop zone and per-row Open buttons stay
  // clickable while a detection is in flight, and two interleaved runs could
  // race recordDetection writes and navigate() calls.
  const isOpeningRef = useRef(false);

  const openDetectedBackup = useCallback(
    async (handle: FileSystemDirectoryHandle, previousRecordId?: string) => {
      if (isOpeningRef.current) {
        return;
      }

      isOpeningRef.current = true;
      setOpeningStatus({
        kind: "running",
        label: "Reading backup metadata in backup-worker.",
      });

      // A fresh worker per detection keeps the flow self-healing: a worker
      // that crashed or failed to load its chunk is discarded with release()
      // instead of poisoning later opens, and the per-call progress proxy is
      // reclaimed on terminate.
      const client = createBackupWorkerClient();

      try {
        const result = await client.api.detectBackup(
          handle,
          proxiedWorkerProgress((progress: WorkerProgressEvent) => {
            setOpeningStatus({ kind: "running", label: progress.label });
          }),
        );

        if (!result.ok) {
          setOpeningStatus({
            kind: "error",
            label: formatWorkerErrorPayload(result.error),
          });
          return;
        }

        if (!routeActiveRef.current) {
          return;
        }

        const replacementCandidate =
          await recentsStore.findReplacementCandidate(result.value, handle);
        let replaceExisting = false;

        if (replacementCandidate !== undefined) {
          setOpeningStatus({
            kind: "running",
            label: "Waiting for backup replacement confirmation.",
          });
          const replacementDecision = await requestReplacementConfirmation(
            replacementCandidate,
            result.value,
          );

          if (replacementDecision === "unmounted") {
            return;
          }

          replaceExisting = replacementDecision === "replace";

          if (!replaceExisting) {
            setOpeningStatus({
              kind: "success",
              label: `Kept the existing backup for ${
                replacementCandidate.deviceInfo.name ??
                replacementCandidate.friendlyName
              }. The selected folder was not opened.`,
            });
            return;
          }

          setOpeningStatus({
            kind: "running",
            label: "Removing the existing local ingest.",
          });
        }

        const recent = await recentsStore.recordDetection(result.value, handle, {
          previousRecordId,
          replaceExisting,
        });

        setOpeningStatus({
          kind: "success",
          label: `Recognized ${recent.friendlyName}.`,
        });
        void navigate(`/backup/${encodeURIComponent(recent.id)}`);
      } catch (cause) {
        reportError(cause);
      } finally {
        client.release();
        isOpeningRef.current = false;
      }
    },
    [
      navigate,
      recentsStore,
      reportError,
      requestReplacementConfirmation,
    ],
  );

  const pickBackupFolder = useCallback(async () => {
    try {
      const handle = await window.showDirectoryPicker({ mode: "read" });
      await openDetectedBackup(handle);
    } catch (cause) {
      if (isAbortError(cause)) {
        return;
      }

      reportError(cause);
    }
  }, [openDetectedBackup, reportError]);

  const openRecent = useCallback(
    async (record: RecentBackupRecord) => {
      try {
        const permission = await ensureRecentBackupDirectoryPermission(record, {
          request: true,
        });

        if (permission !== "granted") {
          setOpeningStatus({
            kind: "error",
            label: `Chrome did not grant read access to ${record.friendlyName}.`,
          });
          return;
        }
      } catch (cause) {
        reportError(cause);
        return;
      }

      await openDetectedBackup(record.directoryHandle, record.id);
    },
    [openDetectedBackup, reportError],
  );

  const renameRecent = useCallback(
    async (record: RecentBackupRecord, friendlyName: string): Promise<boolean> => {
      try {
        await recentsStore.rename(record.id, friendlyName);
        await refreshRecents();
        return true;
      } catch (cause) {
        reportError(cause);
        return false;
      }
    },
    [recentsStore, refreshRecents, reportError],
  );

  const removeRecent = useCallback(
    async (record: RecentBackupRecord) => {
      try {
        await recentsStore.remove(record.id);
        await refreshRecents();
      } catch (cause) {
        reportError(cause);
      }
    },
    [recentsStore, refreshRecents, reportError],
  );

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    setIsDragging(false);
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);

      // The handle promises must be collected synchronously during drop
      // dispatch (see firstDroppedDirectoryHandle); only the follow-up work
      // is async.
      const handlePromise = firstDroppedDirectoryHandle(event.dataTransfer.items);

      void (async () => {
        try {
          const handle = await handlePromise;

          if (handle === undefined) {
            setOpeningStatus({
              kind: "error",
              label: "Drop an iPhone backup folder, not individual files.",
            });
            return;
          }

          await openDetectedBackup(handle);
        } catch (cause) {
          reportError(cause);
        }
      })();
    },
    [openDetectedBackup, reportError],
  );

  return (
    <PageShell
      description="Open a local iPhone Finder or iTunes backup, recognize the device, and keep a private recent-backups list on this computer."
      eyebrow="Local backup workspace"
      title="Local backup workspace"
    >
      <div className="grid grid-cols-[minmax(0,1.15fr)_minmax(var(--pane-threads),0.85fr)] gap-6">
        <Panel>
          <PanelHeader
            badge={<Badge variant="accent">M1</Badge>}
            description="Your backup data never leaves this machine. Source folders are opened read-only."
            title="Open backup"
          />

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              disabled={openingStatus.kind === "running"}
              onClick={() => {
                void pickBackupFolder();
              }}
              size="lg"
              type="button"
              variant="primary"
            >
              <FolderOpen aria-hidden="true" className="size-4" />
              Open backup
            </Button>
            <Button asChild size="lg" variant="secondary">
              <Link to="/guide/iphone">iPhone guide</Link>
            </Button>
            <Button asChild size="lg" variant="ghost">
              <Link to="/guide/android">Android status</Link>
            </Button>
          </div>

          <div
            className={cn(
              "mt-6 rounded-lg border border-dashed border-border-strong bg-surface-sunken p-6 text-center",
              isDragging && "border-accent bg-accent-subtle",
            )}
            onDragLeave={onDragLeave}
            onDragOver={onDragOver}
            onDrop={onDrop}
          >
            <HardDrive aria-hidden="true" className="mx-auto size-6 text-text-tertiary" />
            <p className="mt-3 text-body text-text">Drop an iPhone backup folder</p>
            <p className="mt-1 text-caption text-text-secondary">
              Detection runs in the backup worker and reads only metadata files.
            </p>
          </div>

          <OpeningStatusMessage status={openingStatus} />
        </Panel>

        <Panel>
          <PanelHeader
            badge={<Badge variant={recents.length === 0 ? "neutral" : "accent"}>{recents.length}</Badge>}
            description="Stored directory handles remain on this device and require Chrome permission to reopen."
            title="Recent backups"
          />
          <div className="mt-4">
            <RecentsList
              isLoading={isLoadingRecents}
              onOpen={openRecent}
              onRemove={removeRecent}
              onRename={renameRecent}
              recents={recents}
            />
          </div>
        </Panel>
      </div>

      <Panel>
        <div className="flex items-start gap-3">
          <span className="inline-flex size-[var(--control-height-lg)] items-center justify-center rounded-lg bg-surface-sunken text-text-tertiary">
            <ShieldCheck aria-hidden="true" className="size-5" />
          </span>
          <div>
            <h2 className="text-heading text-text">Privacy boundary</h2>
            <p className="mt-1 text-body text-text-secondary">
              Golemine is a static offline app. It does not upload backups, run analytics,
              or load code from a CDN. Derived data is rebuildable and can be wiped when a
              recent backup is removed.
            </p>
          </div>
        </div>
      </Panel>

      <WorkerDiagnostics />

      <BackupReplacementDialog
        onCancel={() => {
          resolveReplacementPrompt("keep");
        }}
        onConfirm={() => {
          resolveReplacementPrompt("replace");
        }}
        prompt={replacementPrompt}
      />
    </PageShell>
  );
}

function BackupReplacementDialog({
  onCancel,
  onConfirm,
  prompt,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  prompt: ReplacementPromptState | null;
}) {
  const deviceName =
    prompt?.existing.deviceInfo.name ?? prompt?.existing.friendlyName;

  return (
    <ConfirmationDialog
      cancelLabel="Keep existing"
      confirmLabel="Replace backup"
      onCancel={onCancel}
      onConfirm={onConfirm}
      open={prompt !== null}
      title="Replace existing backup?"
    >
      {prompt === null ? null : (
        <>
          <p>
            A backup for {deviceName} is already loaded. Replacing it permanently
            removes the existing local ingest and generated previews, then opens
            the selected backup ready for a clean ingest. Source backup folders
            are not modified.
          </p>
          <dl className="mt-4 grid gap-3 rounded-md border border-border bg-surface-sunken p-3 text-caption">
            <div>
              <dt className="text-text-secondary">Loaded source</dt>
              <dd className="mt-1 break-all font-mono text-text">
                {prompt.existing.directoryHandle.name}
              </dd>
            </div>
            <div>
              <dt className="text-text-secondary">Selected source</dt>
              <dd className="mt-1 break-all font-mono text-text">
                {prompt.detection.sourceFolderName}
              </dd>
            </div>
          </dl>
        </>
      )}
    </ConfirmationDialog>
  );
}

function OpeningStatusMessage({ status }: { status: OpeningStatus }) {
  if (status.kind === "idle") {
    return null;
  }

  const Icon = status.kind === "error" ? AlertCircle : status.kind === "success" ? CheckCircle2 : RotateCw;

  return (
    <div
      className={cn(
        "mt-4 flex items-start gap-3 rounded-md border px-3 py-2 text-caption",
        status.kind === "error" && "border-danger bg-danger-subtle text-danger",
        status.kind === "success" &&
          "border-transparent bg-[var(--success-subtle)] text-[var(--success-foreground)]",
        status.kind === "running" &&
          "border-transparent bg-[var(--info-subtle)] text-[var(--info-foreground)]",
      )}
      role={status.kind === "error" ? "alert" : "status"}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>{status.label}</span>
    </div>
  );
}

interface RecentRowCallbacks {
  onOpen: (record: RecentBackupRecord) => Promise<void>;
  onRemove: (record: RecentBackupRecord) => Promise<void>;
  onRename: (record: RecentBackupRecord, friendlyName: string) => Promise<boolean>;
}

function RecentsList({
  isLoading,
  onOpen,
  onRemove,
  onRename,
  recents,
}: RecentRowCallbacks & {
  isLoading: boolean;
  recents: readonly RecentBackupRecord[];
}) {
  if (isLoading) {
    return (
      <EmptyState icon={<RotateCw aria-hidden="true" className="size-6" />}>
        Loading recent backups.
      </EmptyState>
    );
  }

  if (recents.length === 0) {
    return (
      <EmptyState
        action={
          <Button asChild variant="secondary">
            <Link to="/guide/iphone">Create an iPhone backup</Link>
          </Button>
        }
        icon={<FolderOpen aria-hidden="true" className="size-6" />}
      >
        No recent backups are stored.
      </EmptyState>
    );
  }

  return (
    <TooltipProvider>
      <div className="grid gap-3">
        {recents.map((record) => (
          <RecentRow
            key={record.id}
            onOpen={onOpen}
            onRemove={onRemove}
            onRename={onRename}
            record={record}
          />
        ))}
      </div>
    </TooltipProvider>
  );
}

function RecentRow({
  onOpen,
  onRemove,
  onRename,
  record,
}: RecentRowCallbacks & { record: RecentBackupRecord }) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [isConfirmingRemove, setIsConfirmingRemove] = useState(false);

  const saveRename = async () => {
    if (await onRename(record, renameValue)) {
      setIsRenaming(false);
      setRenameValue("");
    }
  };

  return (
    <article className="rounded-lg border border-border bg-surface-sunken p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {isRenaming ? (
            <label className="block">
              <span className="block text-caption text-text-secondary">Backup name</span>
              <input
                className="mt-1 h-[var(--control-height-md)] w-full rounded-md border border-border-strong bg-surface-sunken px-2 text-body text-text"
                onChange={(event) => {
                  setRenameValue(event.currentTarget.value);
                }}
                value={renameValue}
              />
            </label>
          ) : (
            <h3 className="truncate text-body font-[var(--font-weight-strong)] text-text">
              {record.friendlyName}
            </h3>
          )}
          <p className="mt-1 truncate font-mono text-caption text-text-secondary">
            {record.deviceInfo.udid ?? record.id}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant={record.isEncrypted ? "warning" : "neutral"}>
              {record.isEncrypted ? "Encrypted" : "Unencrypted"}
            </Badge>
            <Badge variant="neutral">{record.ingestStatus}</Badge>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isRenaming ? (
            <>
              <Button
                onClick={() => {
                  void saveRename();
                }}
                size="sm"
                type="button"
                variant="primary"
              >
                Save
              </Button>
              <Tooltip content="Cancel rename">
                <Button
                  onClick={() => {
                    setIsRenaming(false);
                    setRenameValue("");
                  }}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <X aria-hidden="true" className="size-4" />
                  <span className="sr-only">Cancel rename</span>
                </Button>
              </Tooltip>
            </>
          ) : (
            <>
              <Button
                onClick={() => {
                  void onOpen(record);
                }}
                size="sm"
                type="button"
                variant="secondary"
              >
                Open
              </Button>
              <Tooltip content="Rename backup">
                <Button
                  onClick={() => {
                    setIsConfirmingRemove(false);
                    setRenameValue(record.friendlyName);
                    setIsRenaming(true);
                  }}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <Pencil aria-hidden="true" className="size-4" />
                  <span className="sr-only">Rename backup</span>
                </Button>
              </Tooltip>
              <Tooltip content="Remove recent backup">
                <Button
                  onClick={() => {
                    setIsRenaming(false);
                    setIsConfirmingRemove(true);
                  }}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                  <span className="sr-only">Remove recent backup</span>
                </Button>
              </Tooltip>
            </>
          )}
        </div>
      </div>

      {isConfirmingRemove ? (
        <div className="mt-3 rounded-md border border-danger bg-danger-subtle p-3">
          <p className="text-caption text-danger">
            Remove {record.friendlyName} from recents and wipe its derived data.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button
              onClick={() => {
                setIsConfirmingRemove(false);
              }}
              size="sm"
              type="button"
              variant="secondary"
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                void onRemove(record);
              }}
              size="sm"
              type="button"
              variant="destructive"
            >
              Remove {record.friendlyName}
            </Button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}
