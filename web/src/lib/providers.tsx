"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { useState } from "react";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: (count, error) => {
              const status = (error as { status?: number })?.status;
              if (status && [401, 402, 403, 429].includes(status)) return false;
              return count < 1;
            },
            staleTime: 5_000,
            refetchOnWindowFocus: false,
          },
          mutations: {
            retry: (count, error) => {
              const status = (error as { status?: number })?.status;
              if (status && [401, 402, 403, 429].includes(status)) return false;
              return count < 1;
            },
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {process.env.NODE_ENV === "development" && <ReactQueryDevtools />}
    </QueryClientProvider>
  );
}
