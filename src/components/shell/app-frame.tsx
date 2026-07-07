import { Outlet } from "react-router";

import { TopBar } from "./top-bar";

export function AppFrame() {
  return (
    <div className="min-h-screen bg-bg text-text">
      <TopBar />
      <Outlet />
    </div>
  );
}
