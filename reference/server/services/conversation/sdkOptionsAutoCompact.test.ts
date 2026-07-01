import { describe, it, expect, vi } from 'vitest';

// sdkOptions imports the sqlite session store (→ DB) only for its default value.
// We never exercise that here, so stub it to keep this a pure unit test.
vi.mock('../sqliteSessionStore.js', () => ({ sqliteSessionStore: {} }));

import { mapOptionsToSDK } from './sdkOptions.js';

const base = { model: 'qwen', permissionMode: 'bypassPermissions' as const };

describe('mapOptionsToSDK — autoCompactWindow', () => {
  it('does not set settings when autoCompact is off', () => {
    const out = mapOptionsToSDK({ ...base });
    expect(out.settings).toBeUndefined();
  });

  it('enables auto-compact without a window when none is provided', () => {
    const out = mapOptionsToSDK({ ...base, autoCompact: true });
    expect(out.settings).toEqual({ autoCompactEnabled: true });
    expect(out.settings?.autoCompactWindow).toBeUndefined();
  });

  it('forwards a window at or above the SDK 100k floor', () => {
    const out = mapOptionsToSDK({ ...base, autoCompact: true, autoCompactWindow: 131072 });
    expect(out.settings?.autoCompactEnabled).toBe(true);
    expect(out.settings?.autoCompactWindow).toBe(131072);
  });

  it('drops a window below the 100k floor (SDK would reject it)', () => {
    const out = mapOptionsToSDK({ ...base, autoCompact: true, autoCompactWindow: 32000 });
    expect(out.settings?.autoCompactEnabled).toBe(true);
    expect(out.settings?.autoCompactWindow).toBeUndefined();
  });

  it('keeps exactly the 100k boundary', () => {
    const out = mapOptionsToSDK({ ...base, autoCompact: true, autoCompactWindow: 100_000 });
    expect(out.settings?.autoCompactWindow).toBe(100_000);
  });

  it('ignores autoCompactWindow when autoCompact is off', () => {
    const out = mapOptionsToSDK({ ...base, autoCompactWindow: 131072 });
    expect(out.settings).toBeUndefined();
  });
});
