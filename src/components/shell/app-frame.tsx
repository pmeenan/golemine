import { useEffect, useRef } from "react";
import { Outlet, useLocation } from "react-router";

import { TopBar } from "./top-bar";

export function AppFrame() {
  const location = useLocation();
  const hasMounted = useRef(false);

  useEffect(() => {
    if (!hasMounted.current) {
      hasMounted.current = true;
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>("#main-content")?.focus({
        preventScroll: true,
      });
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-bg text-text">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <TopBar />
      <Outlet />
    </div>
  );
}
