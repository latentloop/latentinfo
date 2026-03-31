import { createContext, useContext } from "react";

export interface AppTab {
  id: string;
  label: string;
  url: string;
}

export interface TabContextValue {
  openTab: (id: string, label: string, route: string, params?: Record<string, string | number>) => void;
}

export const TabContext = createContext<TabContextValue | null>(null);

export function useAppTabs(): TabContextValue | null {
  return useContext(TabContext);
}
