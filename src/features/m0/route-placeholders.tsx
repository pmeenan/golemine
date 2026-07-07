import {
  ArrowRight,
  CheckCircle2,
  Database,
  FileText,
  FolderOpen,
  HardDrive,
  MessageSquareText,
  Search,
  ShieldCheck,
  Smartphone,
  Wrench,
} from "lucide-react";
import { Link, useParams } from "react-router";
import { type ReactNode } from "react";

import { Badge, type BadgeProps } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { appName, appVersion, derivedDbVersion } from "../../lib/constants";
import { cn } from "../../lib/cn";
import { WorkerDiagnostics } from "./worker-diagnostics";

type ReadinessState = "ready" | "placeholder" | "notConnected";

interface ReadinessItem {
  description: string;
  icon: typeof ShieldCheck;
  label: string;
  state: ReadinessState;
}

interface RouteLink {
  label: string;
  to: string;
}

interface PageShellProps {
  actions?: ReactNode;
  children: ReactNode;
  description: string;
  eyebrow: string;
  maxWidth?: "text" | "wide" | "full";
  title: string;
}

const readinessCopy: Record<ReadinessState, { label: string; variant: BadgeProps["variant"] }> = {
  ready: { label: "Ready", variant: "success" },
  placeholder: { label: "Placeholder", variant: "info" },
  notConnected: { label: "Not connected", variant: "warning" },
};

const routeLinks: readonly RouteLink[] = [
  { label: "Workspace", to: "/" },
  { label: "iPhone guide", to: "/guide/iphone" },
  { label: "Android guide", to: "/guide/android" },
  { label: "Backup overview", to: "/backup/sample" },
  { label: "Messages", to: "/backup/sample/messages" },
  { label: "Search", to: "/backup/sample/search" },
  { label: "Report builder", to: "/backup/sample/report/draft" },
  { label: "Print report", to: "/backup/sample/report/draft/print" },
];

const m0ReadinessItems: readonly ReadinessItem[] = [
  {
    description: "The Vite app shell and service worker registration are present.",
    icon: ShieldCheck,
    label: "Offline PWA shell",
    state: "ready",
  },
  {
    description: "Comlink demo APIs are wired for backup, database, and media workers.",
    icon: Wrench,
    label: "Worker surfaces",
    state: "ready",
  },
  {
    description: `Derived database version ${String(derivedDbVersion)} is reserved and smoke-tested in OPFS.`,
    icon: Database,
    label: "SQLite OPFS",
    state: "ready",
  },
  {
    description: "All requested M0 routes are registered in react-router.",
    icon: CheckCircle2,
    label: "Route map",
    state: "ready",
  },
];

const sampleThreads = [
  "Pat Example",
  "Case team thread with a deliberately long placeholder name",
  "+1 555 010 0199",
] as const;

function PageShell({ actions, children, description, eyebrow, maxWidth = "wide", title }: PageShellProps) {
  return (
    <main
      className={cn(
        "mx-auto flex w-full flex-col gap-6 px-6 py-8",
        maxWidth === "text" && "max-w-[var(--layout-content-text)]",
        maxWidth === "wide" && "max-w-[var(--layout-content-wide)]",
        maxWidth === "full" && "max-w-none",
      )}
    >
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <p className="text-micro text-accent-text">{eyebrow}</p>
          <h1 className="mt-2 text-title text-text">{title}</h1>
          <p className="mt-2 max-w-[var(--layout-content-text)] text-body text-text-secondary">
            {description}
          </p>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </main>
  );
}

function Panel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-lg border border-border bg-surface p-4 shadow-1", className)}>
      {children}
    </section>
  );
}

function PanelHeader({
  badge,
  description,
  title,
}: {
  badge?: ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-heading text-text">{title}</h2>
        {description ? <p className="mt-1 text-caption text-text-secondary">{description}</p> : null}
      </div>
      {badge}
    </div>
  );
}

function ReadinessGrid({ items }: { items: readonly ReadinessItem[] }) {
  return (
    <div className="grid grid-cols-4 gap-4">
      {items.map(({ description, icon: Icon, label, state }) => {
        const badge = readinessCopy[state];

        return (
          <Panel className="flex flex-col gap-4" key={label}>
            <div className="flex items-start justify-between gap-3">
              <Icon aria-hidden="true" className="size-5 text-text-tertiary" />
              <Badge variant={badge.variant}>{badge.label}</Badge>
            </div>
            <div>
              <h3 className="text-body font-[var(--font-weight-strong)] text-text">{label}</h3>
              <p className="mt-1 text-caption text-text-secondary">{description}</p>
            </div>
          </Panel>
        );
      })}
    </div>
  );
}

function RouteMap() {
  return (
    <Panel>
      <PanelHeader
        badge={<Badge variant="accent">M0</Badge>}
        description="Placeholder destinations for the app frame and future feature slices."
        title="Registered routes"
      />
      <div className="mt-4 grid grid-cols-4 gap-3">
        {routeLinks.map((route) => (
          <Link
            className="group flex min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-surface-sunken px-3 py-2 text-body text-text-secondary hover:bg-surface-raised hover:text-text"
            key={route.to}
            to={route.to}
          >
            <span className="truncate">{route.label}</span>
            <ArrowRight
              aria-hidden="true"
              className="size-4 shrink-0 text-text-tertiary group-hover:text-accent-text"
            />
          </Link>
        ))}
      </div>
    </Panel>
  );
}

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

export function LandingRoute() {
  return (
    <PageShell
      description="No backup is open. This shell proves the route frame, theme contract, offline registration, and placeholder worker/database surfaces for M0."
      eyebrow="M0 app shell"
      title="Local backup workspace"
    >
      <div className="grid grid-cols-2 gap-6">
        <Panel>
          <PanelHeader
            badge={<Badge variant="warning">M1</Badge>}
            description="Folder access and backup detection are intentionally not connected in M0."
            title="Open backup"
          />
          <div className="mt-4 flex items-center gap-2">
            <Button disabled size="lg" type="button">
              <FolderOpen aria-hidden="true" className="size-4" />
              Open backup
            </Button>
            <Button asChild size="lg" variant="secondary">
              <Link to="/guide/iphone">iPhone guide</Link>
            </Button>
          </div>
          <div className="mt-6 rounded-lg border border-dashed border-border-strong bg-surface-sunken p-6 text-center">
            <FolderOpen aria-hidden="true" className="mx-auto size-6 text-text-tertiary" />
            <p className="mt-3 text-body text-text">Backup drop target placeholder</p>
            <p className="mt-1 text-caption text-text-secondary">
              Source folders remain untouched; read-only access is a later worker path.
            </p>
          </div>
        </Panel>

        <Panel>
          <PanelHeader
            badge={<Badge variant="neutral">Empty</Badge>}
            description="Recents will persist directory handles after the M1 opening flow."
            title="Recent backups"
          />
          <div className="mt-6 flex min-h-[var(--layout-pane-header)] items-center justify-center rounded-lg border border-border bg-surface-sunken px-4 text-caption text-text-secondary">
            No recent backups are stored.
          </div>
        </Panel>
      </div>

      <ReadinessGrid items={m0ReadinessItems} />
      <WorkerDiagnostics />
      <RouteMap />
    </PageShell>
  );
}

export function IphoneGuideRoute() {
  return (
    <GuideRoute
      description="This route reserves the iPhone backup guide page. Final Finder and iTunes copy lands with the M1 opening flow."
      icon={<Smartphone aria-hidden="true" className="size-5" />}
      platform="iPhone"
    />
  );
}

export function AndroidGuideRoute() {
  return (
    <GuideRoute
      description="This route reserves Android guidance for the later provider milestone while keeping navigation stable in M0."
      icon={<Smartphone aria-hidden="true" className="size-5" />}
      platform="Android"
    />
  );
}

function GuideRoute({
  description,
  icon,
  platform,
}: {
  description: string;
  icon: ReactNode;
  platform: string;
}) {
  return (
    <PageShell description={description} eyebrow="Guide route" maxWidth="text" title={`${platform} backup guide`}>
      <Panel>
        <div className="flex items-start gap-3">
          <span className="inline-flex size-[var(--control-height-lg)] items-center justify-center rounded-lg bg-surface-sunken text-text-tertiary">
            {icon}
          </span>
          <div>
            <h2 className="text-heading text-text">Content placeholder</h2>
            <p className="mt-1 text-body text-text-secondary">
              The page exists so links, theming, and offline routing can be verified before provider work begins.
            </p>
          </div>
        </div>
      </Panel>
      <RouteMap />
    </PageShell>
  );
}

export function BackupOverviewRoute() {
  const backupId = useBackupId();

  return (
    <PageShell
      actions={<BackupIdBadge backupId={backupId} />}
      description="A backup overview route is present, with ingest and device data held as placeholders until the read-only provider path exists."
      eyebrow="Backup overview"
      title="Backup workspace"
    >
      <ReadinessGrid
        items={[
          {
            description: "No directory handle has been requested from the browser.",
            icon: HardDrive,
            label: "Source folder",
            state: "notConnected",
          },
          {
            description: "Device identity will come from backup metadata after detection.",
            icon: Smartphone,
            label: "Device info",
            state: "placeholder",
          },
          {
            description: "Ingest progress will stream from workers after M2.",
            icon: Wrench,
            label: "Ingest",
            state: "placeholder",
          },
          {
            description: `Derived DB version ${String(derivedDbVersion)} is visible for future invalidation.`,
            icon: Database,
            label: "Derived data",
            state: "placeholder",
          },
        ]}
      />

      <div className="grid grid-cols-3 gap-4">
        <CapabilityLink
          description="Thread browser placeholder route"
          icon={<MessageSquareText aria-hidden="true" className="size-5" />}
          label="Messages"
          to={`/backup/${backupId}/messages`}
        />
        <CapabilityLink
          description="Full-text search placeholder route"
          icon={<Search aria-hidden="true" className="size-5" />}
          label="Search"
          to={`/backup/${backupId}/search`}
        />
        <CapabilityLink
          description="Report builder placeholder route"
          icon={<FileText aria-hidden="true" className="size-5" />}
          label="Reports"
          to={`/backup/${backupId}/report/draft`}
        />
      </div>
    </PageShell>
  );
}

function CapabilityLink({
  description,
  icon,
  label,
  to,
}: {
  description: string;
  icon: ReactNode;
  label: string;
  to: string;
}) {
  return (
    <Link
      className="flex items-start gap-3 rounded-lg border border-border bg-surface p-4 shadow-1 hover:bg-surface-raised"
      to={to}
    >
      <span className="inline-flex size-[var(--control-height-lg)] items-center justify-center rounded-lg bg-surface-sunken text-text-tertiary">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-heading text-text">{label}</span>
        <span className="mt-1 block text-caption text-text-secondary">{description}</span>
      </span>
    </Link>
  );
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

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-sunken p-3">
      <dt className="text-micro text-text-tertiary">{label}</dt>
      <dd className="mt-1 break-all font-mono text-caption text-text-secondary">{value}</dd>
    </div>
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
