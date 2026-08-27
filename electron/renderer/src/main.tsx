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

const qc = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 5_000, refetchOnWindowFocus: false } },
});

function LicenseGate({ children }: { children: React.ReactNode }) {
  const [licensed, setLicensed] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    const cf = (window as unknown as { clipforge?: { licenseStatus: () => Promise<{ licensed: boolean }> } }).clipforge;
    if (!cf?.licenseStatus) {
      setLicensed(false);
      return;
    }
    let done = false;
    const t = setTimeout(() => {
      if (!done) setLicensed(false);
    }, 3000);
    cf.licenseStatus()
      .then((r) => {
        done = true;
        clearTimeout(t);
        setLicensed(!!(r as { licensed: boolean }).licensed);
      })
      .catch(() => {
        done = true;
        clearTimeout(t);
        setLicensed(false);
      });
    return () => clearTimeout(t);
  }, []);
  if (licensed === null) return <div className="flex min-h-dvh items-center justify-center p-8 text-sm text-ink-tertiary">Checking license…</div>;
  if (!licensed) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <HashRouter>
        <Routes>
          <Route path="/login" element={<AuthLayout><LoginPage /></AuthLayout>} />
          <Route path="/" element={<LicenseGate><AppShell><DashboardPage /></AppShell></LicenseGate>} />
          <Route path="/projects/:id" element={<LicenseGate><AppShell><ProjectDetailPage /></AppShell></LicenseGate>} />
          <Route path="/billing" element={<LicenseGate><AppShell><BillingPage /></AppShell></LicenseGate>} />
          <Route path="/settings" element={<LicenseGate><AppShell><SettingsPage /></AppShell></LicenseGate>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </QueryClientProvider>
  </React.StrictMode>
);

declare global {
  interface Window {
    clipforge?: {
      licenseStatus: () => Promise<{ licensed: boolean }>;
      licenseVerify: (k: string, e?: string) => Promise<{ valid: boolean; message?: string }>;
      projectsList: () => Promise<unknown[]>;
      projectGet: (id: string) => Promise<unknown>;
      projectCreate: (d: unknown) => Promise<unknown>;
      systemInfo: () => Promise<{ tier: string; licensed: boolean }>;
    };
  }
}
