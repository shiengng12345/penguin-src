import { create } from "zustand";

// Transient UI state for the Extras page. Extras renders as a full page in the
// content area (not a modal), layered above the current primary module without
// touching activeModule. `selectedId` is the submodule whose detail is shown
// inside the Extras page (master → detail); null = the tile grid. Nothing here
// is persisted (session-only per design).
interface SubmoduleUIState {
  launcherOpen: boolean;
  selectedId: string | null;
  openLauncher: () => void;
  closeLauncher: () => void;
  selectSubmodule: (id: string) => void;
  clearSelection: () => void;
}

export const useSubmoduleStore = create<SubmoduleUIState>((set) => ({
  launcherOpen: false,
  selectedId: null,
  openLauncher: () => set({ launcherOpen: true }),
  closeLauncher: () => set({ launcherOpen: false, selectedId: null }),
  selectSubmodule: (id) => set({ selectedId: id }),
  clearSelection: () => set({ selectedId: null }),
}));
