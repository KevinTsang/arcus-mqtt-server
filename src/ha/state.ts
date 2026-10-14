import type { Broker } from '../broker.js';
import type { ArcusDevice } from '../arcus/types.js';
import type { Config } from '../config.js';
import { DeviceConnection } from '../arcus/capabilities.js';
import { matchingMappers } from '../mappers/index.js';
import { stateTopic, availabilityTopic, bridgeAvailabilityTopic } from './topics.js';

/** Publish the combined JSON state for a device across all matching mappers */
export function publishState(
  broker: Broker,
  config: Config,
  device: ArcusDevice,
): void {
  const matched = matchingMappers(device);
  if (matched.length === 0) return;

  // Merge state from all matching mappers into one JSON object
  let state: Record<string, unknown> = {};
  for (const mapper of matched) {
    state = { ...state, ...mapper.buildState(config, device) };
  }

  const topic = stateTopic(config, device.address);
  const payload = JSON.stringify(state);

  broker.publish(
    {
      cmd: 'publish',
      topic,
      payload: Buffer.from(payload),
      qos: 0,
      dup: false,
      retain: true,
    },
    () => {},
  );
}

/** A device is online unless Arcus reports its connection as OFFLINE */
export function isDeviceOnline(device: ArcusDevice): boolean {
  return device.attributes[DeviceConnection.ATTR_STATE] !== DeviceConnection.STATE_OFFLINE;
}

/** Publish availability for a device, following devconn:state */
export function publishAvailability(
  broker: Broker,
  config: Config,
  device: ArcusDevice,
): void {
  const topic = availabilityTopic(config, device.address);
  const online = isDeviceOnline(device);

  broker.publish(
    {
      cmd: 'publish',
      topic,
      payload: Buffer.from(online ? 'online' : 'offline'),
      qos: 0,
      dup: false,
      retain: true,
    },
    () => {},
  );
}

/** Publish the bridge-wide availability (whether the Arcus connection is up) */
export function publishBridgeAvailability(broker: Broker, config: Config, online: boolean): void {
  broker.publish(
    {
      cmd: 'publish',
      topic: bridgeAvailabilityTopic(config),
      payload: Buffer.from(online ? 'online' : 'offline'),
      qos: 0,
      dup: false,
      retain: true,
    },
    () => {},
  );
}
