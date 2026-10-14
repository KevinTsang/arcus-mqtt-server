import type { ArcusDevice } from '../arcus/types.js';
import type { Config } from '../config.js';
import { deviceId, availabilityTopic, bridgeAvailabilityTopic } from './topics.js';

export interface HADiscoveryConfig {
  /** HA MQTT Discovery topic */
  topic: string;
  /** JSON payload for the config message */
  payload: Record<string, unknown>;
}

export interface HADeviceInfo {
  identifiers: string[];
  name: string;
  model: string;
  manufacturer: string;
}

export function buildDeviceInfo(config: Config, device: ArcusDevice): HADeviceInfo {
  return {
    identifiers: [`${config.deviceIdPrefix}_${deviceId(device.address)}`],
    name: device.name,
    model: device.type,
    manufacturer: 'Arcus',
  };
}

/**
 * Availability fields for a discovery payload. An entity is available only while
 * both the bridge's Arcus connection and the device itself are online.
 */
export function buildAvailability(config: Config, device: ArcusDevice) {
  return {
    availability: [
      {
        topic: bridgeAvailabilityTopic(config),
        payload_available: 'online',
        payload_not_available: 'offline',
      },
      {
        topic: availabilityTopic(config, device.address),
        payload_available: 'online',
        payload_not_available: 'offline',
      },
    ],
    availability_mode: 'all',
  };
}
