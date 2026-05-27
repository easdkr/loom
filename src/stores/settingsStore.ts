import { create } from "zustand";
import type { LoomMode } from "@core/index";

interface SettingsState {
  mode: LoomMode;
  setMode: (mode: LoomMode) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  mode: "single",
  setMode: (mode) => set({ mode }),
}));
