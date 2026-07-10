import { type ReactNode } from "react";
import { Link } from "react-router";

import { cn } from "../../lib/cn";

interface PageShellProps {
  actions?: ReactNode;
  children: ReactNode;
  description: string;
  eyebrow: string;
  maxWidth?: "text" | "wide" | "full";
  title: string;
}

export function PageShell({
  actions,
  children,
  description,
  eyebrow,
  maxWidth = "wide",
  title,
}: PageShellProps) {
  return (
    <main
      className={cn(
        "mx-auto flex min-h-[calc(100dvh_-_var(--layout-top-bar))] w-full flex-col gap-6 px-6 py-8 print:min-h-0",
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

export function Panel({
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

export function PanelHeader({
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

export function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-sunken p-3">
      <dt className="text-micro text-text-tertiary">{label}</dt>
      <dd className="mt-1 break-all font-mono text-caption text-text-secondary">{value}</dd>
    </div>
  );
}

export function CapabilityLink({
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

export function EmptyState({
  action,
  children,
  icon,
}: {
  action?: ReactNode;
  children: ReactNode;
  icon: ReactNode;
}) {
  return (
    <div className="flex min-h-[var(--layout-pane-header)] flex-col items-center justify-center rounded-lg border border-border bg-surface-sunken px-4 py-6 text-center">
      <div className="text-text-tertiary">{icon}</div>
      <p className="mt-3 max-w-[var(--layout-content-text)] text-body text-text-secondary">
        {children}
      </p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
