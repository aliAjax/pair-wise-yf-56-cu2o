import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Role } from './types';

/**
 * 浏览器端只保留界面偏好（角色、演示模式）。
 * 事件、动作、审批与时间线全部以服务端为准，不再持久化到本地。
 * 旧版本地存档（yf56-incident-store）由迁移逻辑一次性读取并上报服务端。
 */
interface UiState {
  role: Role;
  demoMode: boolean;
  setRole: (role: Role) => void;
  toggleDemo: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      role: 'analyst',
      demoMode: false,
      setRole: (role) => set({ role }),
      toggleDemo: () => set((state) => ({ demoMode: !state.demoMode }))
    }),
    { name: 'yf56-ui-prefs' }
  )
);
