import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Role } from './types';

/**
 * 本地只保留「个人偏好」：当前扮演的角色和只读演示开关。
 * 处置记录、审批、时间线全部以服务端为准，不再进 localStorage。
 */
interface PreferenceState {
  role: Role;
  demoMode: boolean;
  hydrated: boolean;
  setRole: (role: Role) => void;
  toggleDemo: () => void;
  markHydrated: () => void;
}

export const usePreferenceStore = create<PreferenceState>()(
  persist(
    (set) => ({
      role: 'analyst',
      demoMode: false,
      hydrated: false,
      setRole: (role) => set({ role }),
      toggleDemo: () => set((state) => ({ demoMode: !state.demoMode })),
      markHydrated: () => set({ hydrated: true })
    }),
    {
      name: 'yf56-preferences',
      partialize: (state) => ({ role: state.role, demoMode: state.demoMode }),
      onRehydrateStorage: () => (state) => state?.markHydrated()
    }
  )
);
