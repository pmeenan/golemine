import { HardDriveDownload, KeyRound, Smartphone, Wrench } from "lucide-react";
import { Link } from "react-router";

import { PageShell, Panel, PanelHeader } from "../../components/layout/page-shell";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";

interface GuideStep {
  detail: string;
  label: string;
}

const iphoneSteps: readonly GuideStep[] = [
  {
    label: "Connect the iPhone to the computer that will run Golemine",
    detail:
      "Use the cable and trust prompt as you normally would for a Finder or iTunes backup.",
  },
  {
    label: "Create a local backup in Finder or iTunes",
    detail:
      "On macOS Catalina or newer, use Finder. On Windows or older macOS, use iTunes. Choose a local computer backup rather than iCloud.",
  },
  {
    label: "Encrypted backups are OK",
    detail:
      "Encrypted iPhone backups preserve more message and account metadata. Golemine will ask for the password later and keeps it in memory only.",
  },
  {
    label: "Open the backup folder",
    detail:
      "Use the folder picker or drag the backup folder onto the landing page. The source backup is read-only and is never modified.",
  },
];

export function IphoneGuideRoute() {
  return (
    <PageShell
      description="Create a local iPhone backup that Golemine can read directly in Chrome."
      eyebrow="Backup guide"
      maxWidth="text"
      title="iPhone backup guide"
    >
      <Panel>
        <PanelHeader
          badge={<Badge variant="accent">Finder or iTunes</Badge>}
          description="Use a local backup folder. iCloud backups are not opened directly by this app."
          title="Prepare the backup"
        />
        <ol className="mt-4 grid gap-3">
          {iphoneSteps.map((step, index) => (
            <li className="flex gap-3 rounded-md border border-border bg-surface-sunken p-3" key={step.label}>
              <span className="inline-flex size-[var(--control-height-md)] shrink-0 items-center justify-center rounded-full bg-accent-subtle font-mono text-caption text-accent-text">
                {index + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-body font-[var(--font-weight-strong)] text-text">
                  {step.label}
                </span>
                <span className="mt-1 block text-caption text-text-secondary">{step.detail}</span>
              </span>
            </li>
          ))}
        </ol>
      </Panel>

      <Panel>
        <div className="flex items-start gap-3">
          <span className="inline-flex size-[var(--control-height-lg)] items-center justify-center rounded-lg bg-surface-sunken text-text-tertiary">
            <KeyRound aria-hidden="true" className="size-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-heading text-text">Encrypted backup note</h2>
            <p className="mt-1 text-body text-text-secondary">
              The password is only needed when encrypted-backup ingest lands. It will never
              be saved, uploaded, or written to derived storage.
            </p>
          </div>
        </div>
      </Panel>

      <div className="flex justify-end">
        <Button asChild variant="primary">
          <Link to="/">
            <HardDriveDownload aria-hidden="true" className="size-4" />
            Open backup
          </Link>
        </Button>
      </div>
    </PageShell>
  );
}

export function AndroidGuideRoute() {
  return (
    <PageShell
      description="Android backup support is planned for a later provider milestone."
      eyebrow="Backup guide"
      maxWidth="text"
      title="Android backup guide"
    >
      <Panel>
        <div className="flex items-start gap-3">
          <span className="inline-flex size-[var(--control-height-lg)] items-center justify-center rounded-lg bg-surface-sunken text-text-tertiary">
            <Smartphone aria-hidden="true" className="size-5" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-heading text-text">Future provider</h2>
              <Badge variant="info">Later</Badge>
            </div>
            <p className="mt-1 text-body text-text-secondary">
              Golemine's M1 opening flow recognizes iPhone Finder and iTunes backups.
              Android formats remain in the backlog until the provider shape is decided.
            </p>
          </div>
        </div>
      </Panel>

      <Panel>
        <div className="flex items-start gap-3">
          <span className="inline-flex size-[var(--control-height-lg)] items-center justify-center rounded-lg bg-surface-sunken text-text-tertiary">
            <Wrench aria-hidden="true" className="size-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-heading text-text">Current recommendation</h2>
            <p className="mt-1 text-body text-text-secondary">
              Keep Android evidence in its original export location and wait for the Android
              provider milestone before importing it into Golemine.
            </p>
          </div>
        </div>
      </Panel>
    </PageShell>
  );
}
