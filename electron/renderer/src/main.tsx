import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import "./globals.css";

import AuthLayout from "./layouts/AuthLayout";
import AppShell from "./layouts/AppShell";
import LoginPage from "./pages/Login";
import DashboardPage from "./pages/Dashboard";
import ProjectDetailPage from "./pages/ProjectDetail";
import BillingPage from "./pages/Billing";
import SettingsPage from "./pages/Settings";
import OnboardingPage from "./pages/Onboarding";

const qc = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 5_000, refetchOnWindowFocus: false } },
});

type EntitlementState =
  | { kind: "loading" }
  | { kind: "ok" }
  | { kind: "no_session" }
  | { kind: "denied"; reason: string; message: string };

function useEntitlement(): EntitlementState {
  const [state, setState] = React.useState<EntitlementState>({ kind: "loading" });
  React.useEffect(() => {
    const cf = (window as unknown as {
      clipzard?: { entitlementStatus: () => Promise<unknown> };
    }).clipzard;
    if (!cf?.entitlementStatus) {
      // No preload (e.g. pure web dev). Treat as ok so the app renders.
      setState({ kind: "ok" });
      return;
    }
    let done = false;
    const t = setTimeout(() => {
      if (!done) setState({ kind: "denied", reason: "timeout", message: "Entitlement check timed out." });
    }, 10_000);
    cf.entitlementStatus()
      .then((r) => {
        done = true;
        clearTimeout(t);
        const status = r as { ok: boolean; reason?: string; message?: string };
        if (status?.ok) setState({ kind: "ok" });
        else setState({ kind: "denied", reason: status?.reason ?? "unknown", message: status?.message ?? "Not entitled." });
      })
      .catch((e) => {
        done = true;
        clearTimeout(t);
        setState({ kind: "denied", reason: "error", message: String((e as Error)?.message ?? e) });
      });
    return () => clearTimeout(t);
  }, []);
  return state;
}

function EntitlementGate({ children }: { children: React.ReactNode }) {
  const state = useEntitlement();
  if (state.kind === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center p-8 text-sm text-ink-tertiary">
        Checking your license…
      </div>
    );
  }
  if (state.kind === "ok") return <>{children}</>;
  if (state.kind === "no_session") return <Navigate to="/login" replace />;
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-8 text-center">
      <h1 className="text-lg font-semibold text-ink">ClipZard needs a license</h1>
      <p className="max-w-md text-sm text-ink-tertiary">{state.message}</p>
      <div className="flex gap-3">
        <a
          href="https://clipzard.web.id"
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-9 items-center justify-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink hover:bg-accent-strong"
        >
          Get a license
        </a>
        <a
          href="/login"
          onClick={(e) => { e.preventDefault(); window.location.hash = "#/login"; }}
          className="inline-flex h-9 items-center justify-center rounded-lg border border-line bg-surface-2 px-4 text-sm text-ink hover:bg-surface-3"
        >
          Sign in
        </a>
      </div>
    </div>
  );
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { err: unknown }> {
  state = { err: null as unknown };
  static getDerivedStateFromError(err: unknown) { return { err }; }
  componentDidCatch(err: unknown) { console.error("[renderer] ErrorBoundary", err); }
  render() {
    if (this.state.err) return <div className="p-8 text-sm text-danger">Renderer error: {String((this.state.err as Error)?.message ?? this.state.err)}</div>;
    return this.props.children;
  }
}

function NavigateListener() {
  React.useEffect(() => {
    const cf = (window as unknown as { clipzard?: { onNavigate?: (cb: (p: string) => void) => () => void } }).clipzard;
    if (!cf?.onNavigate) return;
    const off = cf.onNavigate((p) => {
      try {
        const hash = p.startsWith("/") ? `#${p}` : `#/${p}`;
        if (window.location.hash !== hash) window.location.hash = hash;
      } catch {}
    });
    return () => { try { off?.(); } catch {} };
  }, []);
  return null;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={qc}>
        <HashRouter>
          <NavigateListener />
          <Routes>
            <Route path="/onboarding" element={<OnboardingPage />} />
            <Route path="/login" element={<AuthLayout><LoginPage /></AuthLayout>} />
            <Route path="/" element={<EntitlementGate><AppShell><DashboardPage /></AppShell></EntitlementGate>} />
            <Route path="/projects/:id" element={<EntitlementGate><AppShell><ProjectDetailPage /></AppShell></EntitlementGate>} />
            <Route path="/billing" element={<EntitlementGate><AppShell><BillingPage /></AppShell></EntitlementGate>} />
            <Route path="/settings" element={<EntitlementGate><AppShell><SettingsPage /></AppShell></EntitlementGate>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </HashRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
