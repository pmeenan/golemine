import { createBrowserRouter, RouterProvider } from "react-router";
import { type ReactNode } from "react";

import { AppFrame } from "../components/shell/app-frame";
import { BackupOverviewRoute } from "../features/m1/backup-overview-route";
import { WorkspaceCapabilityGate } from "../features/m1/capability-gate";
import { AndroidGuideRoute, IphoneGuideRoute } from "../features/m1/guide-routes";
import { LandingRoute } from "../features/m1/landing-route";
import { MessagesRoute } from "../features/m3/messages-route";
import { NotFoundRoute } from "../features/m0/route-placeholders";
import {
  PrintReportRoute,
  ReportRoute,
  ReportsRoute,
} from "../features/report/report-routes";

function workspaceRoute(element: ReactNode) {
  return <WorkspaceCapabilityGate>{element}</WorkspaceCapabilityGate>;
}

const router = createBrowserRouter([
  {
    element: <AppFrame />,
    errorElement: <NotFoundRoute />,
    children: [
      {
        path: "/",
        element: workspaceRoute(<LandingRoute />),
      },
      {
        path: "/guide/iphone",
        element: <IphoneGuideRoute />,
      },
      {
        path: "/guide/android",
        element: <AndroidGuideRoute />,
      },
      {
        path: "/backup/:id",
        element: workspaceRoute(<BackupOverviewRoute />),
      },
      {
        path: "/backup/:id/messages",
        element: workspaceRoute(<MessagesRoute />),
      },
      {
        path: "/backup/:id/reports",
        element: workspaceRoute(<ReportsRoute />),
      },
      {
        path: "/backup/:id/report/:reportId",
        element: workspaceRoute(<ReportRoute />),
      },
      {
        path: "/backup/:id/report/:reportId/print",
        element: workspaceRoute(<PrintReportRoute />),
      },
      {
        path: "*",
        element: <NotFoundRoute />,
      },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
