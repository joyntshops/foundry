/**
 * Store resolver — returns a StateStore based on config.
 *
 * Currently only 'file' is supported. Extend the switch when adding
 * database-backed stores (sqlite, postgres, etc.).
 */
import type { StateStore } from '../state-store.js';
import { FileStateStore } from './file-store.js';

export type StateStoreConfig = {
  type: 'file';
};

let _default: StateStore | undefined;

export function resolveStateStore(config?: StateStoreConfig): StateStore {
  const storeType = config?.type ?? 'file';

  switch (storeType) {
    case 'file':
      if (!_default) _default = new FileStateStore();
      return _default;
    default:
      throw new Error(`Unknown state_store type: ${storeType}`);
  }
}

export { FileStateStore } from './file-store.js';
