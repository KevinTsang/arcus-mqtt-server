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

interface DiscoveryCache {
  /** Last payload published per discovery topic, so unchanged configs aren't re-sent every poll */
  published: Map<string, string>;
  /** Discovery topics last published by each owner (a device address, or e.g. 'scenes') */
  byOwner: Map<string, Set<string>>;
}

/** Per broker, since the cache describes what that broker currently holds as retained */
const caches = new WeakMap<Broker, DiscoveryCache>();

function cacheFor(broker: Broker): DiscoveryCache {
  let cache = caches.get(broker);
  if (!cache) {
    cache = { published: new Map(), byOwner: new Map() };
    caches.set(broker, cache);
  }
  return cache;
}

/** Publish a retained discovery config, skipping it if the same payload was already published */
export function publishDiscoveryConfig(broker: Broker, topic: string, payload: Record<string, unknown>): void {
  const { published } = cacheFor(broker);
  const json = JSON.stringify(payload);
  if (published.get(topic) === json) return;
  published.set(topic, json);

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

/** Remove a discovery config: an empty retained payload makes HA delete the entity */
function removeDiscoveryConfig(broker: Broker, topic: string): void {
  cacheFor(broker).published.delete(topic);
  broker.publish(
    {
      cmd: 'publish',
      topic,
      payload: Buffer.alloc(0),
      qos: 0,
      dup: false,
      retain: true,
    },
    () => {},
  );
}

/**
 * Publish an owner's full set of discovery configs, removing any it published
 * before that are no longer in the set (e.g. a capability or scene went away).
 */
export function syncOwnedDiscovery(broker: Broker, owner: string, configs: HADiscoveryConfig[]): void {
  const { byOwner } = cacheFor(broker);
  const topics = new Set(configs.map(c => c.topic));
  for (const disc of configs) {
    publishDiscoveryConfig(broker, disc.topic, disc.payload);
  }
  for (const topic of byOwner.get(owner) ?? []) {
    if (!topics.has(topic)) removeDiscoveryConfig(broker, topic);
  }

  if (topics.size > 0) byOwner.set(owner, topics);
  else byOwner.delete(owner);
}

/** Remove every discovery config an owner published (e.g. the device was deleted) */
export function removeOwnedDiscovery(broker: Broker, owner: string): void {
  syncOwnedDiscovery(broker, owner, []);
}
