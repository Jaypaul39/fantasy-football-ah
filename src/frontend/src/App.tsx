import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { Suspense, lazy } from "react";
import Layout from "./components/Layout";

// Lazy-load pages
const IndexPage = lazy(() => import("./pages/RoomsPage"));
const RoomPage = lazy(() => import("./pages/RoomPage"));
const AdminPage = lazy(() => import("./components/AdminPanel"));

// Root layout route
const rootRoute = createRootRoute({
  component: () => (
    <Layout>
      <Outlet />
    </Layout>
  ),
});

// Index route — room list
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => (
    <Suspense fallback={<PageLoader />}>
      <IndexPage />
    </Suspense>
  ),
});

// Room auction dashboard
const roomRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/room/$roomId",
  component: () => (
    <Suspense fallback={<PageLoader />}>
      <RoomPage />
    </Suspense>
  ),
});

// Admin panel — only accessible by the admin principal
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: () => (
    <Suspense fallback={<PageLoader />}>
      <AdminPage />
    </Suspense>
  ),
});

const routeTree = rootRoute.addChildren([indexRoute, roomRoute, adminRoute]);

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-[40vh]">
      <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
    </div>
  );
}

export default function App() {
  return <RouterProvider router={router} />;
}
