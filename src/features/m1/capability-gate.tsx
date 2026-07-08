import { AlertTriangle, ExternalLink, HardDrive } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  getBootBrowserCapabilities,
  getResolvedBootBrowserCapabilities,
  type BrowserCapabilitySnapshot,
} from "../../lib/capabilities";

export function WorkspaceCapabilityGate({ children }: { children: ReactNode }) {
  const snapshot = useBootBrowserCapabilitySnapshot();

  if (snapshot === null) {
    return <CapabilityCheckingScreen />;
  }

  if (snapshot.isSupported) {
    return children;
  }

  return <UnsupportedBrowserScreen snapshot={snapshot} />;
}

function useBootBrowserCapabilitySnapshot(): BrowserCapabilitySnapshot | null {
  // Seed from the already-resolved snapshot so in-app navigation between
  // gated routes doesn't flash the checking screen on every remount.
  const [snapshot, setSnapshot] = useState<BrowserCapabilitySnapshot | null>(
    () => getResolvedBootBrowserCapabilities() ?? null,
  );

  useEffect(() => {
    let active = true;

    void getBootBrowserCapabilities().then((nextSnapshot) => {
      if (active) {
        setSnapshot(nextSnapshot);
      }
    });

    return () => {
      active = false;
    };
  }, []);

  return snapshot;
}

function CapabilityCheckingScreen() {
  return (
    <main className="mx-auto flex min-h-[calc(100vh-var(--layout-top-bar))] w-full max-w-[var(--layout-content-text)] items-center px-6 py-12">
      <section className="w-full rounded-lg border border-border bg-surface p-6 shadow-1">
        <div className="flex items-start gap-4">
          <span className="inline-flex size-[var(--control-height-lg)] shrink-0 items-center justify-center rounded-lg bg-[var(--info-subtle)] text-info">
            <HardDrive aria-hidden="true" className="size-5" />
          </span>
          <div>
            <h1 className="text-title text-text">Checking Chrome capabilities</h1>
            <p className="mt-2 text-body text-text-secondary">
              Golemine is verifying local folder and OPFS support before opening the
              workspace.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}

function UnsupportedBrowserScreen({ snapshot }: { snapshot: BrowserCapabilitySnapshot }) {
  return (
    <main className="mx-auto flex min-h-[calc(100vh-var(--layout-top-bar))] w-full max-w-[var(--layout-content-text)] items-center px-6 py-12">
      <section className="w-full rounded-lg border border-border bg-surface p-6 shadow-1">
        <div className="flex items-start gap-4">
          <span className="inline-flex size-[var(--control-height-lg)] shrink-0 items-center justify-center rounded-lg bg-[var(--warning-subtle)] text-warning">
            <AlertTriangle aria-hidden="true" className="size-5" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-title text-text">Chrome is required for this workspace</h1>
              <Badge variant="warning">Unsupported browser</Badge>
            </div>
            <p className="mt-2 text-body text-text-secondary">
              Golemine opens phone backups directly from local folders and stores derived
              data in Chrome's Origin Private File System. This browser is missing one or
              more required APIs.
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-3">
          {snapshot.checks.map((check) => (
            <div
              className="flex items-center justify-between gap-4 rounded-md border border-border bg-surface-sunken px-3 py-2"
              key={check.id}
            >
              <div className="flex min-w-0 items-center gap-3">
                <HardDrive aria-hidden="true" className="size-4 shrink-0 text-text-tertiary" />
                <span className="truncate text-body text-text">{check.label}</span>
              </div>
              <Badge variant={check.supported ? "success" : "danger"}>
                {check.supported ? "Available" : "Missing"}
              </Badge>
            </div>
          ))}
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Button asChild variant="primary">
            <a href="https://www.google.com/chrome/" rel="noreferrer" target="_blank">
              <ExternalLink aria-hidden="true" className="size-4" />
              Get Chrome
            </a>
          </Button>
          <Button asChild variant="secondary">
            <Link to="/guide/iphone">Read iPhone guide</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link to="/guide/android">Read Android guide</Link>
          </Button>
        </div>
      </section>
    </main>
  );
}
