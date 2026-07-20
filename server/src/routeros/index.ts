import type { ConnectResult, DeviceTarget } from './types.js';
import { restConnect } from './rest.js';
import { legacyConnect } from './legacy.js';

export type Transport = 'rest' | 'legacy';

/** Connect to a device with the given transport and pull its system snapshot. */
export function connectDevice(transport: Transport, target: DeviceTarget): Promise<ConnectResult> {
  return transport === 'legacy' ? legacyConnect(target) : restConnect(target);
}

export { RouterOsError } from './rest.js';
export type { ConnectResult, DeviceTarget, RouterSystemInfo } from './types.js';
