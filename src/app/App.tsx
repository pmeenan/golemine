import { createBrowserRouter, RouterProvider } from "react-router";

import { AppFrame } from "../components/shell/app-frame";
import {
  AndroidGuideRoute,
  BackupOverviewRoute,
  IphoneGuideRoute,
  LandingRoute,
  MessagesRoute,
  NotFoundRoute,
  PrintReportRoute,
  ReportRoute,
  SearchRoute,
} from "../features/m0/route-placeholders";

const router = createBrowserRouter([
  {
    element: <AppFrame />,
    errorElement: <NotFoundRoute />,
    children: [
      {
        path: "/",
        element: <LandingRoute />,
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
        element: <BackupOverviewRoute />,
      },
      {
        path: "/backup/:id/messages",
        element: <MessagesRoute />,
      },
      {
        path: "/backup/:id/search",
        element: <SearchRoute />,
      },
      {
        path: "/backup/:id/report/:reportId",
        element: <ReportRoute />,
      },
      {
        path: "/backup/:id/report/:reportId/print",
        element: <PrintReportRoute />,
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
