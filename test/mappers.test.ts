import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { binarySensorMapper } from '../src/mappers/binary-sensor.js';
import { sensorMapper } from '../src/mappers/sensor.js';
import { lockMapper } from '../src/mappers/lock.js';
import { hubMapper } from '../src/mappers/hub.js';
import { climateMapper } from '../src/mappers/climate.js';
import { valveMapper } from '../src/mappers/valve.js';
import { matchingMappers } from '../src/mappers/index.js';
import type { Mapper } from '../src/mappers/index.js';
import type { ArcusAttributes } from '../src/arcus/types.js';
import { makeDevice, testConfig } from './helpers.js';

const config = testConfig();

function discoveryById(mapper: Mapper, device: ReturnType<typeof makeDevice>): Map<string, Record<string, unknown>> {
  return new Map(mapper.buildDiscovery(config, device).map(d => [String(d.payload.object_id), d.payload]));
}

describe('binary sensor mapper', () => {
  const cases: Array<{ cap: string; attr: string; on: string; off: string; key: string; deviceClass: string }> = [
    { cap: 'leakh2o', attr: 'leakh2o:state', on: 'LEAK', off: 'SAFE', key: 'leak', deviceClass: 'moisture' },
    { cap: 'smoke', attr: 'smoke:smoke', on: 'DETECTED', off: 'SAFE', key: 'smoke', deviceClass: 'smoke' },
    { cap: 'co', attr: 'co:co', on: 'DETECTED', off: 'SAFE', key: 'co', deviceClass: 'carbon_monoxide' },
    { cap: 'glass', attr: 'glass:break', on: 'DETECTED', off: 'SAFE', key: 'glass', deviceClass: 'safety' },
    // Tilt sensors sit on garage door panels: flat means the door is open
    { cap: 'tilt', attr: 'tilt:tiltstate', on: 'FLAT', off: 'UPRIGHT', key: 'tilt', deviceClass: 'garage_door' },
  ];

  for (const c of cases) {
    it(`maps ${c.cap} to a ${c.deviceClass} binary sensor`, () => {
      const device = makeDevice('DRIV:dev:s1', [c.cap], { [c.attr]: c.off });
      const [disc] = binarySensorMapper.buildDiscovery(config, device);
      assert.equal(disc.payload.device_class, c.deviceClass);
      assert.equal(disc.payload.value_template, `{{ value_json.${c.key} }}`);

      assert.deepEqual(binarySensorMapper.buildState(config, device), { [c.key]: 'OFF' });
      device.attributes[c.attr] = c.on;
      assert.deepEqual(binarySensorMapper.buildState(config, device), { [c.key]: 'ON' });
    });
  }

  it('gives a combo smoke/CO detector both sensors', () => {
    const device = makeDevice('DRIV:dev:s1', ['smoke', 'co'], { 'smoke:smoke': 'SAFE', 'co:co': 'DETECTED' });
    assert.equal(binarySensorMapper.buildDiscovery(config, device).length, 2);
    assert.deepEqual(binarySensorMapper.buildState(config, device), { smoke: 'OFF', co: 'ON' });
  });

  it('uses the window device class for contact sensors hinted as windows', () => {
    const device = makeDevice('DRIV:dev:c1', ['cont'], { 'cont:contact': 'OPENED', 'cont:usehint': 'WINDOW' });
    assert.equal(binarySensorMapper.buildDiscovery(config, device)[0].payload.device_class, 'window');
  });
});

describe('sensor mapper', () => {
  it('maps power use to power (W) and energy (Wh, total_increasing) sensors', () => {
    const device = makeDevice('DRIV:dev:p1', ['pow'], { 'pow:instantaneous': 42, 'pow:cumulative': 12450 });
    const disc = discoveryById(sensorMapper, device);
    assert.equal(disc.get('p1_power')?.unit_of_measurement, 'W');
    assert.equal(disc.get('p1_energy')?.unit_of_measurement, 'Wh');
    assert.equal(disc.get('p1_energy')?.state_class, 'total_increasing');
    assert.deepEqual(sensorMapper.buildState(config, device), { power: 42, energy: 12450 });
  });

  it('only adds a battery sensor for battery-powered devices', () => {
    const mains = makeDevice('DRIV:dev:b1', ['devpow'], { 'devpow:source': 'LINE', 'devpow:battery': 100 });
    const battery = makeDevice('DRIV:dev:b2', ['devpow'], { 'devpow:source': 'BATTERY', 'devpow:battery': 80 });
    assert.equal(sensorMapper.matches(mains), false);
    assert.equal(sensorMapper.matches(battery), true);
  });
});

describe('lock mapper', () => {
  it('declares all four Arcus lock states and passes them through', () => {
    const device = makeDevice('DRIV:dev:l1', ['doorlock'], { 'doorlock:lockstate': 'LOCKED' });
    const [disc] = lockMapper.buildDiscovery(config, device);
    assert.equal(disc.payload.state_locking, 'LOCKING');
    assert.equal(disc.payload.state_unlocking, 'UNLOCKING');

    device.attributes['doorlock:lockstate'] = 'UNLOCKING';
    assert.deepEqual(lockMapper.buildState(config, device), { lock: 'UNLOCKING' });
  });

  it('translates lock commands', () => {
    const device = makeDevice('DRIV:dev:l1', ['doorlock']);
    assert.deepEqual(lockMapper.handleCommand(config, device, 'lock', 'UNLOCK'), { 'doorlock:lockstate': 'UNLOCKED' });
    assert.equal(lockMapper.handleCommand(config, device, 'lock', 'BOGUS'), null);
  });
});

describe('hub mapper', () => {
  const hub = (attrs: ArcusAttributes) =>
    makeDevice('SERV:hub:LWW-1', ['base', 'hub', 'hubconn', 'hubpow'], attrs, 'Hub');

  it('reports connectivity, mains power and battery', () => {
    const device = hub({ 'hubconn:state': 'ONLINE', 'hubpow:source': 'MAINS', 'hubpow:Battery': 90 });
    assert.deepEqual(hubMapper.buildState(config, device), { connectivity: 'ON', mains_power: 'ON', battery: 90 });
  });

  it('shows a power cut as mains power off', () => {
    const device = hub({ 'hubconn:state': 'OFFLINE', 'hubpow:source': 'BATTERY' });
    assert.deepEqual(hubMapper.buildState(config, device), { connectivity: 'OFF', mains_power: 'OFF' });
  });

  it('does not tie hub entities to the hub connection topic', () => {
    const device = hub({ 'hubconn:state': 'ONLINE' });
    for (const disc of hubMapper.buildDiscovery(config, device)) {
      const topics = (disc.payload.availability as Array<{ topic: string }>).map(a => a.topic);
      assert.ok(!topics.some(t => t.endsWith('/connection')), `${disc.topic} depends on the hub connection`);
    }
  });
});

describe('climate mapper', () => {
  const thermostat = (attrs: ArcusAttributes) => makeDevice('DRIV:dev:t1', ['therm', 'temp'], {
    'therm:hvacmode': 'HEAT',
    'therm:heatsetpoint': 20,
    'therm:coolsetpoint': 25,
    'temp:temperature': 19,
    'therm:active': 'RUNNING',
    'therm:fanmode': 0,
    ...attrs,
  });
  const state = (attrs: ArcusAttributes) => climateMapper.buildState(config, thermostat(attrs));

  describe('hvac action (Arcus reports RUNNING/NOTRUNNING)', () => {
    const cases: Array<[string, ArcusAttributes, string]> = [
      ['heat mode, running', {}, 'heating'],
      ['cool mode, running', { 'therm:hvacmode': 'COOL' }, 'cooling'],
      ['not running', { 'therm:active': 'NOTRUNNING' }, 'idle'],
      ['not running, fan on', { 'therm:active': 'NOTRUNNING', 'therm:fanmode': 1 }, 'fan'],
      ['auto mode, nearer the heat setpoint', { 'therm:hvacmode': 'AUTO', 'temp:temperature': 19 }, 'heating'],
      ['auto mode, nearer the cool setpoint', { 'therm:hvacmode': 'AUTO', 'temp:temperature': 26 }, 'cooling'],
      ['off', { 'therm:hvacmode': 'OFF' }, 'off'],
    ];
    for (const [label, attrs, expected] of cases) {
      it(label, () => assert.equal(state(attrs).climate_action, expected));
    }
  });

  it('offers only the modes the thermostat supports', () => {
    const [disc] = climateMapper.buildDiscovery(config, thermostat({ 'therm:supportedmodes': ['OFF', 'HEAT', 'ECO'] }));
    assert.deepEqual(disc.payload.modes, ['off', 'heat']);
    assert.deepEqual(disc.payload.preset_modes, ['eco']);
  });

  it('offers all modes and no eco preset when supported modes are unknown', () => {
    const [disc] = climateMapper.buildDiscovery(config, thermostat({}));
    assert.deepEqual(disc.payload.modes, ['off', 'heat', 'cool', 'heat_cool']);
    assert.equal(disc.payload.preset_modes, undefined);
  });

  it('shows ECO as heat_cool (or heat) with the eco preset', () => {
    const withAuto = ['OFF', 'HEAT', 'COOL', 'AUTO', 'ECO'];
    assert.equal(state({ 'therm:hvacmode': 'ECO', 'therm:supportedmodes': withAuto }).climate_mode, 'heat_cool');
    assert.equal(state({ 'therm:hvacmode': 'ECO', 'therm:supportedmodes': ['OFF', 'HEAT', 'ECO'] }).climate_mode, 'heat');
    assert.equal(state({ 'therm:hvacmode': 'ECO', 'therm:supportedmodes': withAuto }).climate_preset, 'eco');
    assert.equal(state({ 'therm:supportedmodes': withAuto }).climate_preset, 'none');
  });

  it('enters and leaves eco, and ignores "none" when not in eco', () => {
    const modes = ['OFF', 'HEAT', 'COOL', 'AUTO', 'ECO'];
    const cmd = (attrs: ArcusAttributes, payload: string) =>
      climateMapper.handleCommand(config, thermostat({ 'therm:supportedmodes': modes, ...attrs }), 'climate_preset', payload);
    assert.deepEqual(cmd({}, 'eco'), { 'therm:hvacmode': 'ECO' });
    assert.deepEqual(cmd({ 'therm:hvacmode': 'ECO' }, 'none'), { 'therm:hvacmode': 'AUTO' });
    assert.equal(cmd({ 'therm:hvacmode': 'HEAT' }, 'none'), null);
  });

  describe('fan modes', () => {
    it('labels single-speed fans off/on (HomeKit needs an "off" mode)', () => {
      const [disc] = climateMapper.buildDiscovery(config, thermostat({ 'therm:maxfanspeed': 1 }));
      assert.deepEqual(disc.payload.fan_modes, ['off', 'on']);
      assert.equal(state({ 'therm:fanmode': 0 }).climate_fan_mode, 'off');
      assert.equal(state({ 'therm:fanmode': 1 }).climate_fan_mode, 'on');
    });

    it('offers speeds for multi-speed fans', () => {
      const [disc] = climateMapper.buildDiscovery(config, thermostat({ 'therm:maxfanspeed': 3 }));
      assert.deepEqual(disc.payload.fan_modes, ['off', 'low', 'medium', 'high']);
      assert.equal(state({ 'therm:maxfanspeed': 3, 'therm:fanmode': 3 }).climate_fan_mode, 'high');
    });

    it('translates fan commands, still accepting the old "auto" name', () => {
      const device = thermostat({ 'therm:maxfanspeed': 3 });
      const cmd = (payload: string) => climateMapper.handleCommand(config, device, 'climate_fan_mode', payload);
      assert.deepEqual(cmd('off'), { 'therm:fanmode': 0 });
      assert.deepEqual(cmd('high'), { 'therm:fanmode': 3 });
      assert.deepEqual(cmd('auto'), { 'therm:fanmode': 0 });
      assert.equal(cmd('turbo'), null);
    });
  });
});

describe('valve mapper', () => {
  const valve = (state?: string) => makeDevice('DRIV:dev:v1', ['valv'], state ? { 'valv:valvestate': state } : {});

  it('maps a water valve with Arcus states', () => {
    const [disc] = valveMapper.buildDiscovery(config, valve('OPEN'));
    assert.equal(disc.topic, 'homeassistant/valve/arcus/v1_valve/config');
    assert.equal(disc.payload.device_class, 'water');
    assert.equal(disc.payload.state_closing, 'CLOSING');
    assert.deepEqual(valveMapper.buildState(config, valve('CLOSING')), { valve: 'CLOSING' });
  });

  it('reports obstruction or a missing state as unknown', () => {
    assert.deepEqual(valveMapper.buildState(config, valve('OBSTRUCTION')), { valve: 'None' });
    assert.deepEqual(valveMapper.buildState(config, valve()), { valve: 'None' });
  });

  it('opens and closes', () => {
    assert.deepEqual(valveMapper.handleCommand(config, valve(), 'valve', 'CLOSE'), { 'valv:valvestate': 'CLOSED' });
    assert.deepEqual(valveMapper.handleCommand(config, valve(), 'valve', 'OPEN'), { 'valv:valvestate': 'OPEN' });
    assert.equal(valveMapper.handleCommand(config, valve(), 'valve', 'STOP'), null);
  });
});

describe('mapper registry', () => {
  it('has no camera mapper', () => {
    assert.equal(matchingMappers(makeDevice('DRIV:dev:cam', ['camera'])).length, 0);
  });
});
