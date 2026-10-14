import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PlatformArcusClient } from '../src/arcus/platform-client.js';
import type { ArcusAttributes } from '../src/arcus/types.js';
import { FakeArcusServer, OK, testConfig, until, quietConsole, type ArcusRequest } from './helpers.js';

type Reply = { messageType: string; attributes: Record<string, unknown> };

describe('PlatformArcusClient', () => {
  let server: FakeArcusServer | undefined;
  let client: PlatformArcusClient | undefined;
  before(quietConsole);
  afterEach(async () => {
    // Stop the client first so it doesn't try to reconnect to the stopped server
    (client as unknown as { bridge?: { disconnect(): void } } | undefined)?.bridge?.disconnect();
    await server?.stop();
    server = client = undefined;
  });

  /** Start a fake server and a client in client-bridge mode (token + place, sends SetActivePlace) */
  async function connect(respond: (req: ArcusRequest) => Reply | undefined) {
    server = new FakeArcusServer((req) => respond(req) ?? OK);
    const url = await server.start();
    client = new PlatformArcusClient(testConfig({ arcusBridgeUrl: url, arcusAuthToken: 'token', arcusPlaceId: 'place-1' }));
    return { server, client };
  }

  describe('attributes', () => {
    it("keeps attributes from the device's own capabilities, including string lists", async () => {
      const { client } = await connect((req) => req.messageType === 'place:ListDevices'
        ? { messageType: 'place:ListDevicesResponse', attributes: { devices: [{
            'base:address': 'DRIV:dev:d1',
            'base:caps': ['base', 'dev', 'motdoor', 'leakh2o', 'therm'],
            'dev:name': 'Garage',
            'motdoor:doorstate': 'OPEN',
            'leakh2o:state': 'LEAK',
            'therm:supportedmodes': ['HEAT', 'COOL'],
            'therm:schedule': [{ not: 'strings' }],
            'swit:state': 'ON',
          }] } }
        : undefined);
      await client.connect();

      const [device] = await client.listDevices();
      assert.equal(device.name, 'Garage');
      assert.equal(device.attributes['motdoor:doorstate'], 'OPEN');
      assert.equal(device.attributes['leakh2o:state'], 'LEAK');
      assert.deepEqual(device.attributes['therm:supportedmodes'], ['HEAT', 'COOL']);
      assert.equal('therm:schedule' in device.attributes, false, 'kept a non-string list');
      assert.equal('swit:state' in device.attributes, false, 'kept an attribute from a capability the device lacks');
    });

    it('throws on a malformed device or scene list instead of returning nothing', async () => {
      const { client } = await connect((req) =>
        req.messageType === 'place:ListDevices' || req.messageType === 'scene:ListScenes'
          ? { messageType: 'Error', attributes: { code: 'boom' } }
          : undefined);
      await client.connect();
      await assert.rejects(client.listDevices(), /no device list/);
      await assert.rejects(client.listScenes(), /no scene list/);
    });

    it('fetches the hub as a device', async () => {
      const { client } = await connect((req) => req.messageType === 'place:GetHub'
        ? { messageType: 'place:GetHubResponse', attributes: { hub: {
            'base:address': 'SERV:hub:LWW-1', 'base:caps': ['base', 'hub', 'hubconn'],
            'hub:name': 'Upstairs Hub', 'hub:model': 'IH200', 'hubconn:state': 'ONLINE',
          } } }
        : undefined);
      await client.connect();
      const hub = await client.getHub();
      assert.equal(hub?.name, 'Upstairs Hub');
      assert.equal(hub?.type, 'IH200');
      assert.equal(hub?.attributes['hubconn:state'], 'ONLINE');
    });

    it('forwards live value changes', async () => {
      const { server, client } = await connect(() => undefined);
      const events: Array<[string, ArcusAttributes]> = [];
      client.onDeviceEvent((address, attrs) => events.push([address, attrs]));
      await client.connect();

      server.sendEvent('DRIV:dev:d1', 'base:ValueChange', { 'devconn:state': 'OFFLINE', 'therm:supportedmodes': ['HEAT'] });
      await until(() => events.length === 1, 2000, 'value change');
      assert.deepEqual(events[0], ['DRIV:dev:d1', { 'devconn:state': 'OFFLINE', 'therm:supportedmodes': ['HEAT'] }]);
    });
  });

  describe('active place', () => {
    const unauthorized = { messageType: 'Error', attributes: { code: 'UnauthorizedRequest' } };

    it('fails startup on an Error reply to SetActivePlace, leaving no reconnect loop', async () => {
      const { server, client } = await connect((req) =>
        req.messageType === 'sess:SetActivePlace' ? unauthorized : undefined);
      await assert.rejects(client.connect(), /SetActivePlace failed/);
      await new Promise(r => setTimeout(r, 1500));
      assert.equal(server.connections, 1);
    });

    it('retries a reconnect whose SetActivePlace fails, then reports connected', async () => {
      // Connection 1 (startup) succeeds, 2 is rejected, 3 succeeds
      const { server, client } = await connect((req) =>
        req.messageType === 'sess:SetActivePlace' && req.connection === 2 ? unauthorized : undefined);
      const changes: boolean[] = [];
      client.onConnectionChange((up) => changes.push(up));
      await client.connect();

      server.dropConnection();
      await until(() => changes.includes(true), 6000, 'reconnect');
      assert.deepEqual(changes, [false, true]);
      assert.equal(server.connections, 3);
    });
  });

  describe('alarm', () => {
    it('arms directly when nothing is open', async () => {
      const { server, client } = await connect(() => undefined);
      await client.connect();
      await client.armAlarm('ON');
      assert.deepEqual(server.requests.filter(r => r.messageType.startsWith('subalarm:')).map(r => r.messageType), ['subalarm:Arm']);
    });

    it('arms bypassed when sensors are open', async () => {
      const { server, client } = await connect((req) => req.messageType === 'subalarm:Arm'
        ? { messageType: 'Error', attributes: { code: 'security.triggeredDevices' } }
        : undefined);
      await client.connect();
      await client.armAlarm('PARTIAL');
      const sent = server.requests.filter(r => r.messageType.startsWith('subalarm:'));
      assert.deepEqual(sent.map(r => r.messageType), ['subalarm:Arm', 'subalarm:ArmBypassed']);
      assert.deepEqual(sent[1].attributes, { mode: 'PARTIAL' });
    });

    it('rejects other arming and disarming errors', async () => {
      const { client } = await connect((req) => req.messageType.startsWith('subalarm:')
        ? { messageType: 'Error', attributes: { code: 'security.noDevices' } }
        : undefined);
      await client.connect();
      await assert.rejects(client.armAlarm('ON'), /subalarm:Arm failed/);
      await assert.rejects(client.disarmAlarm(), /subalarm:Disarm failed/);
    });

    it('reads bypassed devices from the alarm state', async () => {
      const { client } = await connect((req) => req.messageType === 'base:GetAttributes'
        ? { messageType: 'base:GetAttributesResponse', attributes: {
            'subsecurity:alarmState': 'ARMED', 'subsecurity:alarmMode': 'ON', 'subsecurity:bypassedDevices': ['DRIV:dev:w1'],
          } }
        : undefined);
      await client.connect();
      assert.deepEqual(await client.getAlarmState(), { securityMode: 'ARMED', alarmMode: 'ON', bypassedDevices: ['DRIV:dev:w1'] });
    });
  });
});
