import type { Broker } from './broker.js';
import type { ArcusClient } from './arcus/client.js';
import type { ArcusDevice, SceneInfo } from './arcus/types.js';
import type { Config } from './config.js';
import { matchingMappers } from './mappers/index.js';
import { DeviceConnection, DeviceAdvanced, Hub, HubConnection } from './arcus/capabilities.js';
import { publishState, publishAvailability, publishBridgeAvailability, publishHubConnection, isDeviceOnline, clearDeviceTopics } from './ha/state.js';
import type { HADiscoveryConfig } from './ha/discovery.js';
import { syncOwnedDiscovery, removeOwnedDiscovery } from './ha/discovery.js';
import { setupCommandHandler } from './ha/command.js';
import { publishAlarmDiscovery, publishAlarmState, publishAlarmAvailability, setupAlarmCommandHandler } from './ha/alarm.js';
import { publishSceneDiscovery, publishSceneFired, setupSceneCommandHandler } from './ha/scenes.js';

/** Protocols whose devices pair through the hub (others, e.g. IPCD Wi-Fi devices, talk to the platform directly) */
const HUB_PROTOCOLS = new Set(['ZIGB', 'ZWAV']);

/** Publish HA MQTT Discovery config for a device (only configs that changed; stale ones are removed) */
function publishDiscovery(broker: Broker, config: Config, device: ArcusDevice): void {
  const configs: HADiscoveryConfig[] = [];
  for (const mapper of matchingMappers(device)) {
    configs.push(...mapper.buildDiscovery(config, device));
  }
  syncOwnedDiscovery(broker, device.address, configs);
}

/** Perform a full sync: fetch devices, publish discovery + state + availability */
async function fullSync(
  broker: Broker,
  config: Config,
  client: ArcusClient,
  devices: Map<string, ArcusDevice>,
  scenes: SceneInfo[],
): Promise<void> {
  const deviceList = await client.listDevices();
  console.log(`[Sync] Fetched ${deviceList.length} devices`);

  // The hub isn't in the device list; fetch it separately and track it alongside the
  // devices so its real-time value changes flow through the same event path.
  let hub: ArcusDevice | null | undefined;
  try {
    hub = await client.getHub();
  } catch (err) {
    console.error('[Sync] Hub fetch error:', err);
    // Keep the last known hub so its entities and via_device links don't flap
    hub = [...devices.values()].find(d => d.caps.has(Hub.NAMESPACE));
  }
  if (hub) {
    for (const device of deviceList) {
      const protocol = device.attributes[DeviceAdvanced.ATTR_PROTOCOL];
      if (HUB_PROTOCOLS.has(String(protocol))) device.hubAddress = hub.address;
    }
    deviceList.push(hub);
    // Before device discovery, so hub-paired devices don't start out waiting on this topic
    publishHubConnection(broker, config, hub);
  }

  // Update the devices map in-place (don't clear — avoids dropping real-time events mid-sync)
  const freshAddresses = new Set<string>();
  for (const device of deviceList) {
    freshAddresses.add(device.address);
    devices.set(device.address, device);
  }
  // Remove devices no longer present, from the map and from HA
  for (const [address, device] of devices) {
    if (!freshAddresses.has(address)) {
      devices.delete(address);
      removeOwnedDiscovery(broker, address);
      clearDeviceTopics(broker, config, device);
      console.log(`[Sync] Removed device: ${device.name} (${address})`);
    }
  }

  // Publish discovery, state, and availability for each device
  for (const device of deviceList) {
    publishDiscovery(broker, config, device);
    publishState(broker, config, device);
    publishAvailability(broker, config, device);
  }

  // Sync alarm: discovery + state + availability
  publishAlarmDiscovery(broker, config);
  try {
    const alarmState = await client.getAlarmState();
    publishAlarmState(broker, alarmState, (address) => devices.get(address)?.name ?? address);
    publishAlarmAvailability(broker, true);
  } catch (err) {
    console.error('[Sync] Alarm state fetch error:', err);
    publishAlarmAvailability(broker, false);
  }

  // Sync scenes: refresh list + publish discovery
  try {
    const freshScenes = await client.listScenes();
    scenes.length = 0;
    scenes.push(...freshScenes);
    publishSceneDiscovery(broker, config, scenes);
  } catch (err) {
    console.error('[Sync] Scene list error:', err);
  }
}

/** Start the sync loop: initial sync, then poll + event handling */
export async function startSync(
  broker: Broker,
  config: Config,
  client: ArcusClient,
): Promise<{ stop(): void }> {
  const devices = new Map<string, ArcusDevice>();
  const scenes: SceneInfo[] = [];
  let connected = false;

  // Entities stay unavailable until the first sync succeeds
  publishBridgeAvailability(broker, config, false);

  // Only one full sync runs at a time. A request that arrives mid-sync (e.g. a
  // reconnect during a poll) shares the running sync and makes it run once more.
  let syncing: Promise<void> | null = null;
  let rerun = false;

  /** Full sync, then mark the bridge online if the connection is still up */
  const syncAndMarkOnline = (): Promise<void> => {
    if (syncing) {
      rerun = true;
      return syncing;
    }
    syncing = (async () => {
      try {
        do {
          rerun = false;
          try {
            await fullSync(broker, config, client, devices, scenes);
            if (connected) publishBridgeAvailability(broker, config, true);
          } catch (err) {
            // A sync requested meanwhile (typically a reconnect) supersedes this failure
            if (!rerun) throw err;
            console.warn('[Sync] Sync failed, rerunning for a newer request:', err);
          }
        } while (rerun);
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  };

  // Upstream connection drops mark every entity unavailable; a reconnect resyncs
  // to pick up anything that changed during the outage.
  client.onConnectionChange((up) => {
    connected = up;
    if (!up) {
      console.warn('[Sync] Arcus connection lost, marking bridge offline');
      publishBridgeAvailability(broker, config, false);
      return;
    }
    console.log('[Sync] Arcus connection restored, resyncing');
    syncAndMarkOnline().catch((err) => {
      console.error('[Sync] Resync after reconnect failed:', err);
    });
  });

  // Set up command handling (HA → Arcus)
  setupCommandHandler(broker, config, client, devices);

  // Set up alarm command handling and event listening
  const deviceName = (address: string) => devices.get(address)?.name ?? address;
  setupAlarmCommandHandler(broker, client, deviceName);
  client.onAlarmEvent((alarmState) => {
    publishAlarmState(broker, alarmState, deviceName);
    console.log(`[Sync] Real-time alarm update: ${alarmState.securityMode}`);
  });

  // Set up scene command handling and event listening
  setupSceneCommandHandler(broker, config, client, scenes);
  client.onSceneEvent((sceneAddress) => {
    publishSceneFired(broker, config, scenes, sceneAddress);
  });

  // Listen for real-time device events
  client.onDeviceEvent((address, attributes) => {
    const device = devices.get(address);
    if (!device) {
      console.debug(`[Sync] Event for unknown device ${address}, skipping`);
      return;
    }

    // Update local state
    const wasOnline = isDeviceOnline(device);
    Object.assign(device.attributes, attributes);

    // Re-publish state immediately
    publishState(broker, config, device);

    if (HubConnection.ATTR_STATE in attributes && device.caps.has(Hub.NAMESPACE)) {
      publishHubConnection(broker, config, device);
      console.log(`[Sync] Hub is now ${attributes[HubConnection.ATTR_STATE]}`);
    }

    if (DeviceConnection.ATTR_STATE in attributes) {
      publishAvailability(broker, config, device);
      const online = isDeviceOnline(device);
      if (online !== wasOnline) {
        console.log(`[Sync] ${device.name} (${address}) is now ${online ? 'online' : 'offline'}`);
      }
    }

    // Fire any event-driven mappers (e.g. button triggers)
    for (const mapper of matchingMappers(device)) {
      mapper.onEvent?.(broker, config, device, attributes);
    }

    console.log(`[Sync] Real-time update: ${device.name} (${address})`);
  });

  // Connect to the upstream client
  await client.connect();
  connected = true;

  // Initial full sync (includes alarm discovery + state + scenes)
  await syncAndMarkOnline();

  // Periodic poll, a safety net for missed events; skipped while disconnected
  // since the reconnect handler resyncs.
  const interval = setInterval(async () => {
    if (!connected) return;
    try {
      await syncAndMarkOnline();
    } catch (err) {
      console.error('[Sync] Poll error:', err);
    }
  }, config.pollIntervalMs);

  return {
    stop() {
      clearInterval(interval);
    },
  };
}
