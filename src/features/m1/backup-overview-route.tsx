import { Database, FileText, MessageSquareText, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";

import {
  CapabilityLink,
  MetadataRow,
  PageShell,
  Panel,
  PanelHeader,
} from "../../components/layout/page-shell";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { appVersion, derivedDbVersion } from "../../lib/constants";
import {
  createBackupRecentsStore,
  ensureRecentBackupDirectoryPermission,
  type RecentBackupIngestStatus,
  type RecentBackupRecord,
} from "../../lib/recents";
import {
  createBackupWorkerClient,
  createDbWorkerClient,
  proxiedWorkerProgress,
} from "../../lib/worker-client";
import {
  formatWorkerErrorPayload,
  type BackupIngestRequest,
  type DbIngestSummary,
  type WorkerProgressEvent,
} from "../../lib/worker-types";

type IngestUiStatus =
  | { kind: "idle" }
  | { kind: "running"; label: string }
  | { kind: "success"; label: string }
  | { kind: "error"; label: string };

export function BackupOverviewRoute() {
  // react-router already percent-decodes route params; decoding again would
  // corrupt (or throw on) ids that legitimately contain "%".
  const { id } = useParams<{ id: string }>();
  const decodedId = id ?? "";
  const recentsStore = useMemo(() => createBackupRecentsStore(), []);
  const [record, setRecord] = useState<RecentBackupRecord | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ingestStatus, setIngestStatus] = useState<IngestUiStatus>({ kind: "idle" });
  const [summary, setSummary] = useState<DbIngestSummary | null>(null);
  // Lets startIngest release the read-only summary db-worker synchronously,
  // before ingest can reach prepareIngest, instead of relying on React to
  // commit the "running" state and run the summary effect cleanup in time
  // (the two workers must not contend for the same per-backup SAH pool,
  // D-024). release() is idempotent, so the effect cleanup staying in place
  // is safe.
  const summaryReaderRelease = useRef<(() => void) | null>(null);

  useEffect(() => {
    let active = true;

    async function loadRecord() {
      setIsLoading(true);
      setError(null);

      try {
        const recent = decodedId === "" ? undefined : await recentsStore.get(decodedId);

        if (active) {
          setRecord(recent ?? null);
        }
      } catch (cause) {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    }

    void loadRecord();

    return () => {
      active = false;
    };
  }, [decodedId, recentsStore]);

  useEffect(() => {
    if (record?.ingestStatus !== "ingested" || ingestStatus.kind === "running") {
      setSummary(null);
      return;
    }

    const active = { current: true };
    const client = createDbWorkerClient();
    summaryReaderRelease.current = client.release;

    void (async () => {
      try {
        const result = await client.api.getIngestSummary(record.id);

        if (!active.current) {
          return;
        }

        if (result.ok) {
          setSummary(result.value ?? null);
        }
      } finally {
        client.release();
      }
    })();

    return () => {
      active.current = false;
      client.release();
      summaryReaderRelease.current = null;
    };
  }, [record, ingestStatus.kind]);

  if (isLoading) {
    return (
      <PageShell
        description="Loading stored metadata for this backup."
        eyebrow="Backup overview"
        title="Backup workspace"
      >
        <Panel>
          <p className="text-body text-text-secondary">Loading backup metadata.</p>
        </Panel>
      </PageShell>
    );
  }

  if (error !== null) {
    return (
      <PageShell
        description="The recent backup list could not be read."
        eyebrow="Backup overview"
        title="Backup unavailable"
      >
        <Panel>
          <p className="text-body text-danger">{error}</p>
          <div className="mt-4">
            <Button asChild variant="secondary">
              <Link to="/">Return to workspace</Link>
            </Button>
          </div>
        </Panel>
      </PageShell>
    );
  }

  if (record === null) {
    return (
      <PageShell
        description="This backup is not in the local recent-backups list for this browser profile."
        eyebrow="Backup overview"
        title="Backup not found"
      >
        <Panel>
          <p className="text-body text-text-secondary">
            Open the backup folder again to recognize it and restore the local recent entry.
          </p>
          <div className="mt-4">
            <Button asChild variant="primary">
              <Link to="/">Open backup</Link>
            </Button>
          </div>
        </Panel>
      </PageShell>
    );
  }

  const detailRows = buildDeviceRows(record);
  const startIngest = async () => {
    // startIngest is void-invoked from the click handler, so nothing may
    // escape it: even a rejection from navigator.locks.request itself (for
    // example when the document is not fully active) must surface in the UI
    // instead of becoming an unhandled rejection.
    try {
      await runWithOptionalIngestLock(
        `golemine-ingest:${record.id}`,
        async () => {
          await runIngest();
        },
        () => {
          setIngestStatus({
            kind: "error",
            label: "Another tab is already rebuilding this backup.",
          });
        },
      );
    } catch (cause) {
      setIngestStatus({
        kind: "error",
        label: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };
  const runIngest = async () => {
    if (record.isEncrypted) {
      setIngestStatus({
        kind: "error",
        label: "Encrypted backup ingest arrives in M4. Open an unencrypted backup for M2 ingest.",
      });
      return;
    }

    const didPrepareDerivedDb = { current: false };

    const updateStoredIngestStatus = async (
      status: RecentBackupIngestStatus,
    ): Promise<RecentBackupRecord | undefined> => {
      try {
        const updated = await recentsStore.updateIngestStatus(record.id, status);

        setRecord(updated);

        return updated;
      } catch (cause) {
        console.warn(`Could not update recent backup ingest status to ${status}.`, cause);

        return undefined;
      }
    };
    const markPrepared = async () => {
      if (didPrepareDerivedDb.current) {
        return;
      }

      didPrepareDerivedDb.current = true;
      await updateStoredIngestStatus("ingesting");
    };

    setIngestStatus({
      kind: "running",
      label: "Requesting read permission for this backup.",
    });
    setSummary(null);
    summaryReaderRelease.current?.();
    summaryReaderRelease.current = null;

    try {
      const permission = await ensureRecentBackupDirectoryPermission(record, {
        request: true,
      });

      if (permission !== "granted") {
        setIngestStatus({
          kind: "error",
          label: `Chrome did not grant read access to ${record.friendlyName}.`,
        });
        return;
      }

      await navigator.storage.persist();
      const backupClient = createBackupWorkerClient();

      try {
        const request = buildIngestRequest(record);
        const result = await backupClient.api.ingestUnencryptedBackupToDb(
          record.directoryHandle,
          request,
          proxiedWorkerProgress(async (progress: WorkerProgressEvent) => {
            // Any phase past "starting" (beginning with "prepare", which the
            // worker awaits before the destructive prepareIngest call) means
            // the derived database is about to be, or has been, rebuilt.
            if (progress.phase !== "starting") {
              await markPrepared();
            }

            setIngestStatus({
              kind: "running",
              label: formatIngestProgressLabel(progress),
            });
          }),
        );

        if (!result.ok) {
          if (didPrepareDerivedDb.current) {
            await updateStoredIngestStatus("failed");
          }

          setIngestStatus({
            kind: "error",
            label: formatWorkerErrorPayload(result.error),
          });
          return;
        }

        // updateStoredIngestStatus already calls setRecord; the [record]
        // effect owns summary fetching and refetches it when the record
        // flips to "ingested". The success label sources its counts from
        // the ingest result, so no manual summary fetch is needed here.
        const ingested = await updateStoredIngestStatus("ingested");

        if (ingested === undefined) {
          // The IndexedDB write failed (already logged and reflected in the
          // degraded success label below), but the ingest itself succeeded.
          // Update the in-memory record so this session's UI matches reality:
          // the button re-enables and the [record] effect fetches the summary.
          // A reload re-reads the stored (stale) status, which is recoverable.
          setRecord({ ...record, ingestStatus: "ingested", derivedDbVersion });
        }

        setIngestStatus({
          kind: "success",
          label:
            ingested === undefined
              ? `Extracted ${result.value.counts.messages.toLocaleString()} messages from ${result.value.counts.conversations.toLocaleString()} conversations, but the recent-backup metadata could not be updated.`
              : `Extracted ${result.value.counts.messages.toLocaleString()} messages from ${result.value.counts.conversations.toLocaleString()} conversations.`,
        });
      } finally {
        backupClient.release();
      }
    } catch (cause) {
      if (didPrepareDerivedDb.current) {
        await updateStoredIngestStatus("failed");
      }

      setIngestStatus({
        kind: "error",
        label: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };
  const isIngestRunning =
    ingestStatus.kind === "running" || record.ingestStatus === "ingesting";

  return (
    <PageShell
      actions={
        <>
          <Badge variant={record.isEncrypted ? "warning" : "neutral"}>
            {record.isEncrypted ? "Encrypted" : "Unencrypted"}
          </Badge>
          <Badge className="font-mono" variant="neutral">
            v{appVersion}
          </Badge>
        </>
      }
      description="The backup was recognized from local iPhone backup metadata. Run ingest to build or refresh the local message database."
      eyebrow="Backup overview"
      title={record.friendlyName}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_var(--pane-threads)] gap-6">
        <Panel>
          <PanelHeader
            badge={<Badge variant="success">Recognized</Badge>}
            description="Device identity comes from Info.plist and Manifest.plist."
            title="Device info"
          />
          <dl className="mt-4 grid grid-cols-2 gap-3">
            {detailRows.map((row) => (
              <MetadataRow key={row.label} label={row.label} value={row.value} />
            ))}
          </dl>
        </Panel>

        <Panel>
          <PanelHeader
            badge={<Badge variant={record.ingestStatus === "ingested" ? "success" : "info"}>M2</Badge>}
            description="Unencrypted message extraction rebuilds the derived OPFS database from source."
            title="Ingest"
          />
          <div className="mt-4 rounded-md border border-border bg-surface-sunken p-3">
            <div className="flex items-center gap-3">
              <Database aria-hidden="true" className="size-5 text-text-tertiary" />
              <div>
                <p className="text-body font-[var(--font-weight-strong)] text-text">
                  {formatIngestStatus(record.ingestStatus)}
                </p>
                <p className="mt-1 font-mono text-caption text-text-secondary">
                  derivedDbVersion {derivedDbVersion}
                </p>
              </div>
            </div>
          </div>
          {summary ? (
            <dl className="mt-3 grid grid-cols-2 gap-2">
              <MetadataRow label="Messages" value={String(summary.counts.messages)} />
              <MetadataRow label="Conversations" value={String(summary.counts.conversations)} />
              <MetadataRow label="Attachments" value={String(summary.counts.attachments)} />
              <MetadataRow label="Warnings" value={String(summary.counts.warnings)} />
            </dl>
          ) : null}
          <IngestStatusMessage status={ingestStatus} />
          <Button
            className="mt-4 w-full"
            disabled={record.isEncrypted || isIngestRunning}
            onClick={() => {
              void startIngest();
            }}
            size="lg"
            type="button"
            variant="primary"
          >
            {record.ingestStatus === "ingested" ? "Rebuild messages" : "Ingest messages"}
          </Button>
          {record.isEncrypted ? (
            <p className="mt-2 text-caption text-text-secondary">
              Encrypted backup ingest is scheduled for M4.
            </p>
          ) : null}
        </Panel>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <CapabilityLink
          description="Thread browser route reserved for ingested messages."
          icon={<MessageSquareText aria-hidden="true" className="size-5" />}
          label="Messages"
          to={`/backup/${encodeURIComponent(record.id)}/messages`}
        />
        <CapabilityLink
          description="Search route reserved for the derived FTS index."
          icon={<Search aria-hidden="true" className="size-5" />}
          label="Search"
          to={`/backup/${encodeURIComponent(record.id)}/search`}
        />
        <CapabilityLink
          description="Report builder route reserved for selected messages."
          icon={<FileText aria-hidden="true" className="size-5" />}
          label="Reports"
          to={`/backup/${encodeURIComponent(record.id)}/report/draft`}
        />
      </div>
    </PageShell>
  );
}

function buildIngestRequest(record: RecentBackupRecord): BackupIngestRequest {
  return {
    backupId: record.id,
    provider: "ios-itunes",
    sourceKind: "itunes-finder",
    sourceFolderName: record.directoryHandle.name,
    friendlyName: record.friendlyName,
    deviceInfo: {
      udid: record.deviceInfo.udid ?? record.id,
      ...(record.deviceInfo.name === undefined ? {} : { name: record.deviceInfo.name }),
      ...(record.deviceInfo.model === undefined ? {} : { model: record.deviceInfo.model }),
      ...(record.deviceInfo.osVersion === undefined
        ? {}
        : { osVersion: record.deviceInfo.osVersion }),
      ...(record.deviceInfo.serialNumber === undefined
        ? {}
        : { serialNumber: record.deviceInfo.serialNumber }),
      ...(record.deviceInfo.phoneNumber === undefined
        ? {}
        : { phoneNumber: record.deviceInfo.phoneNumber }),
    },
    isEncrypted: record.isEncrypted,
    derivedDbVersion,
  };
}

async function runWithOptionalIngestLock(
  lockName: string,
  operation: () => Promise<void>,
  onUnavailable: () => void,
): Promise<void> {
  const locks = getBrowserLocks();

  if (locks === undefined) {
    await operation();
    return;
  }

  await locks.request(lockName, { ifAvailable: true }, async (lock) => {
    if (lock === null) {
      onUnavailable();
      return;
    }

    await operation();
  });
}

function getBrowserLocks(): LockManager | undefined {
  return "locks" in navigator ? navigator.locks : undefined;
}

function IngestStatusMessage({ status }: { status: IngestUiStatus }) {
  if (status.kind === "idle") {
    return null;
  }

  return (
    <p
      className={
        status.kind === "error"
          ? "mt-3 rounded-md border border-danger bg-danger-subtle px-3 py-2 text-caption text-danger"
          : status.kind === "success"
            ? "mt-3 rounded-md bg-[var(--success-subtle)] px-3 py-2 text-caption text-[var(--success-foreground)]"
            : "mt-3 rounded-md bg-[var(--info-subtle)] px-3 py-2 text-caption text-[var(--info-foreground)]"
      }
      role={status.kind === "error" ? "alert" : "status"}
    >
      {status.label}
    </p>
  );
}

function buildDeviceRows(record: RecentBackupRecord): readonly { label: string; value: string }[] {
  const info = record.deviceInfo;

  return [
    { label: "Friendly name", value: record.friendlyName },
    { label: "Source folder", value: record.directoryHandle.name },
    { label: "Device name", value: info.name ?? "Unknown" },
    { label: "Model", value: info.model ?? "Unknown" },
    { label: "OS version", value: info.osVersion ?? "Unknown" },
    { label: "Serial number", value: info.serialNumber ?? "Not present" },
    { label: "UDID", value: info.udid ?? record.id },
    { label: "Phone number", value: info.phoneNumber ?? "Not present" },
    { label: "Last backup", value: info.lastBackupDate ?? "Not present" },
  ];
}

function formatIngestStatus(status: RecentBackupRecord["ingestStatus"]): string {
  switch (status) {
    case "not-ingested":
      return "Not ingested";
    case "ingesting":
      return "Ingesting";
    case "ingested":
      return "Ingested";
    case "needs-reingest":
      return "Needs re-ingest";
    case "failed":
      return "Failed";
  }
}

function formatIngestProgressLabel(progress: WorkerProgressEvent): string {
  if (
    progress.completedUnits === undefined ||
    progress.totalUnits === undefined ||
    progress.totalUnits <= 10
  ) {
    return progress.label;
  }

  return `${progress.label} (${progress.completedUnits.toLocaleString()} / ${progress.totalUnits.toLocaleString()})`;
}
