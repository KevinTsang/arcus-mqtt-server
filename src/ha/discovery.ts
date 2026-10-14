import type { Broker } from '../broker.js';
import type { ArcusDevice } from '../arcus/types.js';
import { Device, Hub } from '../arcus/capabilities.js';
import type { Config } from '../config.js';
import { deviceId, availabilityTopic, bridgeAvailabilityTopic, hubConnectionTopic } from './topics.js';

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
  via_device?: string;
}

function deviceIdentifier(config: Config, address: string): string {
  return `${config.deviceIdPrefix}_${deviceId(address)}`;
}

export function buildDeviceInfo(config: Config, device: ArcusDevice): HADeviceInfo {
  const attrs = device.attributes;
  const vendor = attrs[Device.ATTR_VENDOR] ?? attrs[Hub.ATTR_VENDOR];
  const model = attrs[Device.ATTR_MODEL] ?? attrs[Hub.ATTR_MODEL];

  const info: HADeviceInfo = {
    identifiers: [deviceIdentifier(config, device.address)],
    name: device.name,
    model: model ? String(model) : device.type,
    manufacturer: vendor ? String(vendor) : 'Arcus',
  };
  if (device.hubAddress) {
    info.via_device = deviceIdentifier(config, device.hubAddress);
  }
  return info;
}

/**
 * Availability fields for a discovery payload. An entity is available only while
 * the bridge's Arcus connection, the device itself, and (for hub-paired devices)
 * the hub are all online.
 */
export function buildAvailability(config: Config, device: ArcusDevice) {
  const topics = [bridgeAvailabilityTopic(config), availabilityTopic(config, device.address)];
  if (device.hubAddress) topics.push(hubConnectionTopic(config, device.hubAddress));

  return {
    availability: topics.map(topic => ({
      topic,
      payload_available: 'online',
      payload_not_available: 'offline',
    })),
    availability_mode: 'all',
  };
}

/** Last payload published per discovery topic, so unchanged configs aren't re-sent every poll */
const publishedDiscovery = new Map<string, string>();

/** Publish a retained discovery config, skipping it if the same payload was already published */
export function publishDiscoveryConfig(broker: Broker, topic: string, payload: Record<string, unknown>): void {
  const json = JSON.stringify(payload);
  if (publishedDiscovery.get(topic) === json) return;
  publishedDiscovery.set(topic, json);

  broker.publish(
    {
      cmd: 'publish',
      topic,
      payload: Buffer.from(json),
      qos: 0,
      dup: false,
      retain: true,
    },
    () => {},
  );
}
