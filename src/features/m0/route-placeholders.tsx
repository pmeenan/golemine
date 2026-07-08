import { FileText, MessageSquareText, Search } from "lucide-react";
import { Link, useParams } from "react-router";
import { type ReactNode } from "react";

import {
  MetadataRow,
  PageShell,
  Panel,
  PanelHeader,
} from "../../components/layout/page-shell";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { appName, appVersion } from "../../lib/constants";
import { cn } from "../../lib/cn";

const sampleThreads = [
  "Pat Example",
  "Case team thread with a deliberately long placeholder name",
  "+1 555 010 0199",
] as const;

function BackupIdBadge({ backupId }: { backupId: string }) {
  return (
    <Badge className="max-w-[var(--layout-content-text)] truncate font-mono" variant="neutral">
      backup:{backupId}
    </Badge>
  );
}

function useBackupId() {
  const { id } = useParams<{ id: string }>();
  return id ?? "unknown";
}

function useReportId() {
  const { reportId } = useParams<{ reportId: string }>();
  return reportId ?? "draft";
}

export function MessagesRoute() {
  const backupId = useBackupId();

  return (
    <PageShell
      actions={<BackupIdBadge backupId={backupId} />}
      description="The three-pane messages route is wired for layout verification; no backup rows are loaded in M0."
      eyebrow="Messages"
      maxWidth="full"
      title="Message browser"
    >
      <div className="grid min-h-[var(--layout-workspace-min)] overflow-hidden rounded-lg border border-border bg-surface shadow-1 [grid-template-columns:var(--pane-threads)_minmax(var(--pane-timeline-min),1fr)_var(--pane-detail)]">
        <Pane title="Threads">
          <div className="divide-y divide-border">
            {sampleThreads.map((thread) => (
              <div className="px-4 py-3" key={thread}>
                <p className="truncate text-body font-[var(--font-weight-strong)] text-text">{thread}</p>
                <p className="mt-1 truncate text-caption text-text-secondary">Placeholder conversation row</p>
              </div>
            ))}
          </div>
        </Pane>

        <Pane className="border-l border-r border-border" title="Timeline">
          <div className="flex min-h-[var(--layout-workspace-min)] items-center justify-center px-8">
            <div className="max-w-[var(--layout-content-text)] text-center">
              <MessageSquareText
                aria-hidden="true"
                className="mx-auto size-6 text-text-tertiary"
              />
              <h2 className="mt-3 text-heading text-text">No messages loaded</h2>
              <p className="mt-1 text-body text-text-secondary">
                Virtualized message rows, attachments, reactions, and provenance metadata connect after ingest.
              </p>
            </div>
          </div>
        </Pane>

        <Pane title="Details">
          <dl className="grid gap-3 p-4">
            <MetadataRow label="Message id" value="pending" />
            <MetadataRow label="Source GUID" value="pending" />
            <MetadataRow label="Source row id" value="pending" />
            <MetadataRow label="Raw timestamp" value="pending" />
          </dl>
        </Pane>
      </div>
    </PageShell>
  );
}

function Pane({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title: string;
}) {
  return (
    <section className={cn("min-w-0 bg-surface", className)}>
      <div className="flex h-[var(--layout-pane-header)] items-center border-b border-border px-4">
        <h2 className="text-heading text-text">{title}</h2>
      </div>
      {children}
    </section>
  );
}

export function SearchRoute() {
  const backupId = useBackupId();

  return (
    <PageShell
      actions={<BackupIdBadge backupId={backupId} />}
      description="Search UI is routed and styled. Query execution waits for the db-worker and FTS5 milestone."
      eyebrow="Search"
      title="Search backup"
    >
      <Panel>
        <div className="flex items-center gap-3">
          <input
            aria-label="Search messages"
            className="h-[var(--control-height-lg)] min-w-0 flex-1 rounded-md border border-border-strong bg-surface-sunken px-3 text-body text-text placeholder:text-text-tertiary disabled:opacity-[var(--opacity-disabled)]"
            disabled
            placeholder="Search is not connected in M0"
            type="search"
          />
          <Button disabled size="lg" type="button">
            <Search aria-hidden="true" className="size-4" />
            Search
          </Button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Badge variant="neutral">Conversation filter</Badge>
          <Badge variant="neutral">Date range</Badge>
          <Badge variant="neutral">Has attachment</Badge>
          <Badge variant="neutral">Participant</Badge>
        </div>
      </Panel>

      <Panel>
        <PanelHeader
          badge={<Badge variant="neutral">0 results</Badge>}
          description="FTS5 snippets and jump-to-context actions will appear here after ingest exists."
          title="Results"
        />
      </Panel>
    </PageShell>
  );
}

export function ReportRoute() {
  const backupId = useBackupId();
  const reportId = useReportId();

  return (
    <PageShell
      actions={
        <>
          <BackupIdBadge backupId={backupId} />
          <Badge className="font-mono" variant="neutral">
            report:{reportId}
          </Badge>
        </>
      }
      description="The report builder route is ready for future selections, case metadata, and print preview data."
      eyebrow="Report builder"
      title="Draft report"
    >
      <div className="grid grid-cols-2 gap-6">
        <Panel>
          <PanelHeader
            badge={<Badge variant="neutral">0 items</Badge>}
            description="Selected messages will be ordered here."
            title="Report items"
          />
          <div className="mt-6 rounded-lg border border-border bg-surface-sunken p-6 text-center text-caption text-text-secondary">
            No messages have been added to this report.
          </div>
        </Panel>

        <Panel>
          <PanelHeader
            badge={<Badge variant="info">Placeholder</Badge>}
            description="Case fields remain disabled until report storage exists."
            title="Case metadata"
          />
          <dl className="mt-4 grid gap-3">
            <MetadataRow label="Title" value="pending" />
            <MetadataRow label="Matter" value="pending" />
            <MetadataRow label="Preparer" value="pending" />
          </dl>
        </Panel>
      </div>

      <div className="flex items-center justify-end">
        <Button asChild variant="secondary">
          <Link to={`/backup/${backupId}/report/${reportId}/print`}>
            <FileText aria-hidden="true" className="size-4" />
            Print route
          </Link>
        </Button>
      </div>
    </PageShell>
  );
}

export function PrintReportRoute() {
  const backupId = useBackupId();
  const reportId = useReportId();

  return (
    <PageShell
      actions={
        <>
          <BackupIdBadge backupId={backupId} />
          <Badge className="font-mono" variant="neutral">
            report:{reportId}
          </Badge>
        </>
      }
      description="This route reserves the report print rendering surface. The current page is a non-exporting placeholder."
      eyebrow="Print report"
      maxWidth="text"
      title="Print preview route"
    >
      <article className="rounded-lg border border-border bg-surface p-6 shadow-1 print:border-0 print:shadow-none">
        <div className="flex items-start justify-between gap-4 border-b border-border pb-4">
          <div>
            <p className="text-micro text-text-tertiary">{appName}</p>
            <h2 className="mt-2 text-title text-text">Report placeholder</h2>
          </div>
          <p className="font-mono text-caption text-text-secondary">v{appVersion}</p>
        </div>
        <div className="grid gap-3 py-4">
          <MetadataRow label="Backup id" value={backupId} />
          <MetadataRow label="Report id" value={reportId} />
          <MetadataRow label="Provenance appendix" value="pending" />
        </div>
      </article>
    </PageShell>
  );
}

export function NotFoundRoute() {
  return (
    <PageShell
      description="The requested route is not registered in this app shell."
      eyebrow="Route missing"
      maxWidth="text"
      title="Page not found"
    >
      <Panel>
        <Button asChild variant="primary">
          <Link to="/">Return to workspace</Link>
        </Button>
      </Panel>
    </PageShell>
  );
}
