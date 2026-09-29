'use client';
import { useEffect, useRef, useState } from 'react';
import { usePreferenceStore } from './preferences';
import * as api from './api';

const LEGACY_KEY = 'yf56-incident-store';

export interface MigrationState {
  status: 'idle' | 'running' | 'done' | 'fresh' | 'error';
  migrated: boolean;
  legacyCount: number;
  message?: string;
}

/**
 * 首次进入作战室时：
 * 1. 读取旧版浏览器本地处置记录（zustand persist 格式）；
 * 2. 连同角色/演示偏好一起上报 /api/bootstrap，由服务端决定迁移还是初始化；
 * 3. 迁移成功后把老 key 改名备份，避免下次重复导入；之后一切以服务端为准。
 * 两个人同时首次打开也没关系：服务端 bootstrap 是互斥且幂等的，只有第一份记录落库。
 */
export function useBootstrap(): MigrationState {
  const hydrated = usePreferenceStore((state) => state.hydrated);
  const setRole = usePreferenceStore((state) => state.setRole);
  const setDemo = usePreferenceStore((state) => state.toggleDemo);
  const attempted = useRef(false);
  const [migration, setMigration] = useState<MigrationState>({ status: 'idle', migrated: false, legacyCount: 0 });

  useEffect(() => {
    if (!hydrated || attempted.current) return;
    attempted.current = true;

    const run = async () => {
      setMigration({ status: 'running', migrated: false, legacyCount: 0 });
      let legacy: unknown = null;
      try {
        const raw = window.localStorage.getItem(LEGACY_KEY);
        if (raw) {
          const persisted = JSON.parse(raw) as { state?: { incident?: unknown; role?: unknown; demoMode?: unknown } };
          legacy = persisted?.state?.incident ?? null;
          // 老版本里的角色和演示偏好也照旧保留
          if (persisted?.state && typeof persisted.state === 'object') {
            const old = persisted.state;
            if (old.role === 'analyst' || old.role === 'responder' || old.role === 'legal' || old.role === 'viewer') {
              setRole(old.role);
            }
            if (old.demoMode === true) setDemo();
          }
        }
      } catch {
        legacy = null;
      }

      try {
        const role = usePreferenceStore.getState().role;
        const result = await api.bootstrap(legacy, role);
        if (raw2legacyPresent(legacy) && result.migrated) {
          // 备份而非删除：迁移结果可追溯，且刷新后不会二次导入
          window.localStorage.setItem(`${LEGACY_KEY}.migrated-backup`, window.localStorage.getItem(LEGACY_KEY) ?? '');
          window.localStorage.removeItem(LEGACY_KEY);
        }
        setMigration({
          status: result.migrated ? 'done' : 'fresh',
          migrated: result.migrated,
          legacyCount: result.legacyCount
        });
      } catch (error) {
        setMigration({
          status: 'error',
          migrated: false,
          legacyCount: 0,
          message: error instanceof Error ? error.message : '服务端引导失败'
        });
      }
    };

    void run();
  }, [hydrated, setRole, setDemo]);

  return migration;
}

function raw2legacyPresent(legacy: unknown): boolean {
  return Boolean(legacy && typeof legacy === 'object');
}
