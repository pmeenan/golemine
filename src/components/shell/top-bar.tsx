import { Database, HardDrive, Search } from "lucide-react";
import { Link, NavLink, type NavLinkRenderProps } from "react-router";

import { appName } from "../../lib/constants";
import { cn } from "../../lib/cn";
import { ThemeToggle } from "./theme-toggle";

const navItemClassName = ({ isActive }: NavLinkRenderProps) =>
  cn(
    "inline-flex h-[var(--control-height-md)] items-center gap-1.5 rounded-md px-2 text-body font-[var(--font-weight-strong)] text-text-secondary hover:bg-surface-raised hover:text-text",
    isActive && "bg-accent-subtle text-accent-text",
  );

export function TopBar() {
  return (
    <header className="app-topbar sticky top-0 z-10 flex h-[var(--layout-top-bar)] items-center gap-3 border-b border-border px-4">
      <Link
        className="inline-flex h-[var(--control-height-lg)] items-center gap-2 rounded-md px-2 text-text hover:bg-surface-raised"
        to="/"
      >
        <span className="inline-flex size-[var(--control-height-md)] items-center justify-center rounded-md bg-accent-subtle text-accent-text">
          <Database aria-hidden="true" className="size-4" />
        </span>
        <span className="text-heading">{appName}</span>
      </Link>

      <nav aria-label="Guides" className="flex items-center gap-1">
        <NavLink className={navItemClassName} to="/guide/iphone">
          iPhone guide
        </NavLink>
        <NavLink className={navItemClassName} to="/guide/android">
          Android guide
        </NavLink>
      </nav>

      <div className="ml-auto flex items-center gap-2">
        <NavLink className={navItemClassName} to="/backup/sample">
          <HardDrive aria-hidden="true" className="size-4" />
          Backup route
        </NavLink>
        <NavLink className={navItemClassName} to="/backup/sample/search">
          <Search aria-hidden="true" className="size-4" />
          Search
        </NavLink>
        <ThemeToggle />
      </div>
    </header>
  );
}
