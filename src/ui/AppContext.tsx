import React, { createContext, useContext } from "react";
import type { App } from "obsidian";
import type { IIndexClient } from "@/embeddings/IIndexClient";

interface AppCtxValue {
  app: App;
  indexClient: IIndexClient | null;
}

const AppContext = createContext<AppCtxValue | null>(null);

export function AppProvider({
  app,
  indexClient = null,
  children,
}: {
  app: App;
  indexClient?: IIndexClient | null;
  children: React.ReactNode;
}) {
  return <AppContext.Provider value={{ app, indexClient }}>{children}</AppContext.Provider>;
}

export function useApp(): App {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp() called outside AppProvider");
  return ctx.app;
}

export function useMaybeApp(): App | null {
  return useContext(AppContext)?.app ?? null;
}

export function useIndexClient(): IIndexClient | null {
  return useContext(AppContext)?.indexClient ?? null;
}
