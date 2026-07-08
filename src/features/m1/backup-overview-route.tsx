import { Database, FileText, MessageSquareText, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
import { createBackupRecentsStore, type RecentBackupRecord } from "../../lib/recents";

export function BackupOverviewRoute() {
  // react-router already percent-decodes route params; decoding again would
  // corrupt (or throw on) ids that legitimately contain "%".
  const { id } = useParams<{ id: string }>();
  const decodedId = id ?? "";
  const recentsStore = useMemo(() => createBackupRecentsStore(), []);
  const [record, setRecord] = useState<RecentBackupRecord | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      description="The backup was recognized from local iPhone backup metadata. Ingest is the next milestone."
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
            badge={<Badge variant="info">M2</Badge>}
            description="Message extraction is intentionally disabled until ingest lands."
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
          <Button className="mt-4 w-full" disabled size="lg" type="button" variant="primary">
            Ingest messages
          </Button>
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

