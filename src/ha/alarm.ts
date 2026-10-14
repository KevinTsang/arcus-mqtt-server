import type { Broker } from '../broker.js';
import type { ArcusClient } from '../arcus/client.js';
import type { AlarmState } from '../arcus/types.js';
import type { Config } from '../config.js';
import { discoveryTopic, bridgeAvailabilityTopic } from './topics.js';
import { publishDiscoveryConfig } from './discovery.js';

const ALARM_STATE_TOPIC = 'arcus/alarm/state';
const ALARM_COMMAND_TOPIC = 'arcus/alarm/set';
const ALARM_AVAILABILITY_TOPIC = 'arcus/alarm/availability';
const ALARM_ATTRIBUTES_TOPIC = 'arcus/alarm/attributes';

/** Resolves a device address to its display name */
export type DeviceNameLookup = (address: string) => string;

function mapAlarmState(alarm: AlarmState): string {
  switch (alarm.securityMode) {
    case 'ARMING':
      return 'arming';
    case 'ARMED':
      return alarm.alarmMode === 'PARTIAL' ? 'armed_home' : 'armed_away';
    case 'SOAKING':
      return 'pending';
    case 'ALERT':
    case 'CLEARING':
      return 'triggered';
    case 'DISARMED':
    default:
      return 'disarmed';
  }
}

export function publishAlarmDiscovery(broker: Broker, config: Config): void {
  const topic = discoveryTopic(config, 'alarm_control_panel', 'alarm');
  const payload = {
    name: 'Security Alarm',
    unique_id: `${config.deviceIdPrefix}_alarm`,
    object_id: `${config.deviceIdPrefix}_alarm`,
    state_topic: ALARM_STATE_TOPIC,
    command_topic: ALARM_COMMAND_TOPIC,
    // Available only while both the bridge's Arcus connection and the alarm state fetch are good
    availability: [
      { topic: bridgeAvailabilityTopic(config), payload_available: 'online', payload_not_available: 'offline' },
      { topic: ALARM_AVAILABILITY_TOPIC, payload_available: 'online', payload_not_available: 'offline' },
    ],
    availability_mode: 'all',
    json_attributes_topic: ALARM_ATTRIBUTES_TOPIC,
    supported_features: ['arm_home', 'arm_away'],
    code_arm_required: false,
    code_disarm_required: false,
    device: {
      identifiers: [`${config.deviceIdPrefix}_alarm`],
      name: 'Arcus Security',
      model: 'Security Subsystem',
      manufacturer: 'Arcus',
    },
  };

  publishDiscoveryConfig(broker, topic, payload);

  // On while the alarm is armed with sensors excluded (e.g. a window left open),
  // so HA can notify about it. Attributes list the bypassed sensors by name.
  publishDiscoveryConfig(broker, discoveryTopic(config, 'binary_sensor', 'alarm_bypassed'), {
    name: 'Bypassed sensors',
    unique_id: `${config.deviceIdPrefix}_alarm_bypassed`,
    object_id: `${config.deviceIdPrefix}_alarm_bypassed`,
    state_topic: ALARM_ATTRIBUTES_TOPIC,
    value_template: '{{ value_json.bypassed }}',
    payload_on: 'ON',
    payload_off: 'OFF',
    json_attributes_topic: ALARM_ATTRIBUTES_TOPIC,
    json_attributes_template: '{{ {"bypassed_sensors": value_json.bypassed_sensors} | tojson }}',
    device_class: 'problem',
    availability: payload.availability,
    availability_mode: 'all',
    device: payload.device,
  });
}

export function publishAlarmState(broker: Broker, alarm: AlarmState, nameOf: DeviceNameLookup): void {
  const state = mapAlarmState(alarm);

  // Bypasses only matter while the alarm is (being) armed
  const bypassed = alarm.securityMode === 'DISARMED' ? [] : alarm.bypassedDevices.map(nameOf);
  broker.publish(
    {
      cmd: 'publish',
      topic: ALARM_ATTRIBUTES_TOPIC,
      payload: Buffer.from(JSON.stringify({
        bypassed: bypassed.length > 0 ? 'ON' : 'OFF',
        bypassed_sensors: bypassed,
      })),
      qos: 0,
      dup: false,
      retain: true,
    },
    () => {},
  );

  broker.publish(
    {
      cmd: 'publish',
      topic: ALARM_STATE_TOPIC,
      payload: Buffer.from(state),
      qos: 0,
      dup: false,
      retain: true,
    },
    () => {},
  );
}

export function publishAlarmAvailability(broker: Broker, online: boolean): void {
  broker.publish(
    {
      cmd: 'publish',
      topic: ALARM_AVAILABILITY_TOPIC,
      payload: Buffer.from(online ? 'online' : 'offline'),
      qos: 0,
      dup: false,
      retain: true,
    },
    () => {},
  );
}

export function setupAlarmCommandHandler(broker: Broker, client: ArcusClient, nameOf: DeviceNameLookup): void {
  const refreshState = async () => {
    try {
      const state = await client.getAlarmState();
      publishAlarmState(broker, state, nameOf);
    } catch (err) {
      console.error('[Alarm] Failed to refresh state:', err);
    }
  };

  broker.on('publish', (packet, _client) => {
    if (packet.topic !== ALARM_COMMAND_TOPIC) return;
    const command = packet.payload.toString();

    switch (command) {
      case 'ARM_AWAY':
        console.log('[Alarm] Command: ARM_AWAY');
        client.armAlarm('ON').then(refreshState, err => {
          console.error('[Alarm] Failed to arm (away):', err);
        });
        break;
      case 'ARM_HOME':
        console.log('[Alarm] Command: ARM_HOME');
        client.armAlarm('PARTIAL').then(refreshState, err => {
          console.error('[Alarm] Failed to arm (home):', err);
        });
        break;
      case 'DISARM':
        console.log('[Alarm] Command: DISARM');
        client.disarmAlarm().then(refreshState, err => {
          console.error('[Alarm] Failed to disarm:', err);
        });
        break;
      default:
        console.warn(`[Alarm] Unknown command: ${command}`);
    }
  });
}
