const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

let fixtureState;
class FakeProvider {
  constructor(kind, options) { this.id = kind; this.options = options; fixtureState.providers.push(this); }
  async list() { fixtureState.providerReads++; return []; }
  async prepare() { fixtureState.providerWrites++; throw new Error('Unexpected prepare'); }
  async apply() { fixtureState.providerWrites++; throw new Error('Unexpected write'); }
}
class FakeController extends EventEmitter {
  constructor(persistPath, providers) {
    super(); this.persistPath = persistPath; this.providers = providers;
    this.householdPresence = fixtureState.initialPresence ?? null;
    this.holidayActive = fixtureState.initialHoliday ?? false;
    this.calls = []; this.closed = false; fixtureState.controllers.push(this);
  }
  async start() {
    fixtureState.starts++;
    if (fixtureState.startGate) { await fixtureState.startGate; }
    if (fixtureState.startError) { throw fixtureState.startError; }
    await Promise.all(this.providers.map(provider => provider.list()));
  }
  async close() { this.closed = true; }
  get homeActive() { return this.holidayActive ? false : this.householdPresence; }
  async handle(route, body) {
    this.calls.push({ route, body });
    if (route === '/presence') { this.householdPresence = body.home; }
    if (route === '/home') { this.householdPresence = body.home; if (body.home) { this.holidayActive = false; } }
    if (route === '/holiday') { this.holidayActive = body.active; }
    this.emit('change'); return {};
  }
}

function mockModule(relativePath, exports) {
  const filename = require.resolve(relativePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
mockModule('../dist/controller/Controller.js', { HeatingController: FakeController });
mockModule('../dist/tuya/TuyaIpcTransport.js', { TuyaIpcTransport: class extends FakeProvider { constructor(options) { super('tuya', options); } } });
mockModule('../dist/hive/HiveIpcTransport.js', { HiveIpcTransport: class { constructor(options) { this.options = options; fixtureState.hiveConnections.push(this); } } });
mockModule('../dist/hive/HiveProvider.js', { HiveProvider: class extends FakeProvider {
  constructor(transport, limits) { super('hive', { transport, limits }); }
} });
const { HeatingProgrammesPlatform, PLUGIN_NAME, PLATFORM_NAME } = require('../dist/platform.js');

class Characteristic {
  constructor() { this.value = undefined; this.updates = []; }
  onGet(handler) { this.get = handler; return this; }
  onSet(handler) { this.set = handler; return this; }
  updateValue(value) { this.value = value; this.updates.push(value); return this; }
}
class Service {
  constructor(type, name, subtype) { this.type = type; this.name = name; this.subtype = subtype; this.characteristics = new Map(); }
  getCharacteristic(type) {
    if (!this.characteristics.has(type)) { this.characteristics.set(type, new Characteristic()); }
    return this.characteristics.get(type);
  }
  testCharacteristic(type) { return this.characteristics.has(type); }
  addOptionalCharacteristic(type) { this.getCharacteristic(type); return this; }
  setCharacteristic(type, value) { this.getCharacteristic(type).value = value; return this; }
}
class Accessory {
  constructor(displayName, UUID) { this.displayName = displayName; this.UUID = UUID; this.services = [new Service('information', displayName)]; fixtureState.created.push(this); }
  getService(type) { return this.services.find(service => service.type === type); }
  getServiceById(type, subtype) { return this.services.find(service => service.type === type && service.subtype === subtype); }
  addService(type, name, subtype) { const service = new Service(type, name, subtype); this.services.push(service); return service; }
}
class Unavailable extends Error { constructor(status) { super(String(status)); this.status = status; } }
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(config = {}, options = {}) {
  fixtureState = { providers: [], controllers: [], hiveConnections: [], created: [], starts: 0, providerReads: 0, providerWrites: 0, ...options };
  const state = fixtureState;
  const api = new EventEmitter();
  api.user = { storagePath: () => '/not-used/homebridge', persistPath: () => '/not-used/homebridge/persist' };
  api.platformAccessory = Accessory;
  api.hap = { Service: { AccessoryInformation: 'information', Switch: 'switch' },
    Characteristic: { Manufacturer: 'manufacturer', Model: 'model', SerialNumber: 'serial', Name: 'name', ConfiguredName: 'configured-name', On: 'on' },
    HapStatusError: Unavailable, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 }, uuid: { generate: value => `uuid:${value}` } };
  const registered = [], updated = [], unregistered = [], logEntries = [], publicationOrder = [];
  api.registerPlatformAccessories = (plugin, platform, accessories) => {
    publicationOrder.push('register'); if (state.registerError) throw state.registerError;
    registered.push({ plugin, platform, accessories });
  };
  api.updatePlatformAccessories = accessories => {
    publicationOrder.push('update'); if (state.updateError) throw state.updateError; updated.push(accessories);
  };
  api.unregisterPlatformAccessories = (plugin, platform, accessories) => {
    publicationOrder.push('unregister'); if (state.unregisterError) throw state.unregisterError;
    unregistered.push({ plugin, platform, accessories });
  };
  const log = Object.fromEntries(['info', 'error', 'warn', 'debug'].map(level => [level, (...values) => logEntries.push({ level, values })]));
  const platform = new HeatingProgrammesPlatform(log, { platform: PLATFORM_NAME, hiveTargetLimits: { minC: 5, maxC: 32, stepC: 0.5 }, ...config }, api);
  const launch = async () => { api.emit('didFinishLaunching'); await flush(); };
  const shutdown = async () => { api.emit('shutdown'); await flush(); };
  const accessories = () => registered.flatMap(item => item.accessories);
  const controls = () => [...accessories(), ...updated.flat(), ...state.created].find(accessory => accessory.UUID === api.hap.uuid.generate(`${PLUGIN_NAME}:controls`));
  const on = role => controls().getServiceById('switch', role).getCharacteristic('on');
  return { api, platform, state, registered, updated, unregistered, logEntries, publicationOrder, launch, shutdown, accessories, controls, on };
}

test('shared platform publishes one Heating accessory with two independently named switches and no startup commands', async () => {
  const f = fixture(); await f.launch();
  assert.equal(f.state.starts, 1);
  assert.deepEqual(f.state.providers.map(provider => provider.id), ['tuya', 'hive']);
  assert.equal(f.state.providerReads, 2);
  assert.equal(f.state.providerWrites, 0);
  assert.deepEqual(f.state.controllers[0].calls, []);
  assert.deepEqual(f.accessories().map(accessory => accessory.displayName), ['Heating']);
  assert.ok(f.registered.every(item => item.plugin === PLUGIN_NAME && item.platform === PLATFORM_NAME));
  assert.equal(f.controls().UUID, f.api.hap.uuid.generate(`${PLUGIN_NAME}:controls`));
  const switches = f.controls().services.filter(service => service.type === 'switch');
  assert.deepEqual(switches.map(service => service.subtype), ['home', 'holiday']);
  assert.deepEqual(switches.map(service => service.getCharacteristic('name').value), ['Home', 'Holiday']);
  assert.deepEqual(switches.map(service => service.getCharacteristic('configured-name').value), ['Heating Home', 'Heating Holiday']);
  await f.shutdown();
});

test('unknown presence reports a HomeKit communication error without inventing Away', async () => {
  const f = fixture(); await f.launch();
  assert.throws(() => f.on('home').get(), error => error instanceof Unavailable && error.status === -70402);
  assert.equal(f.on('holiday').get(), false);
  assert.deepEqual(f.on('home').updates, []);
  await f.shutdown();
});

test('Home on/off dispatches explicit Home selections while Holiday dispatches its own state', async () => {
  const f = fixture(); await f.launch();
  await f.on('home').set(true);
  await f.on('home').set(false);
  await f.on('holiday').set(true);
  await f.on('holiday').set(false);
  assert.deepEqual(f.state.controllers[0].calls, [
    { route: '/home', body: { home: true } }, { route: '/home', body: { home: false } },
    { route: '/holiday', body: { active: true } }, { route: '/holiday', body: { active: false } },
  ]);
  assert.equal(f.state.providerWrites, 0);
  await f.shutdown();
});

test('Holiday hides unknown occupancy behind Home off without losing the unknown-presence error after Holiday ends', async () => {
  const f = fixture({}, { initialHoliday: true }); await f.launch();
  assert.equal(f.on('home').get(), false);
  assert.equal(f.on('holiday').get(), true);
  assert.deepEqual(f.on('home').updates, [false]);
  const controller = f.state.controllers[0];
  assert.equal(controller.householdPresence, null);
  controller.holidayActive = false; controller.emit('change');
  assert.throws(() => f.on('home').get(), error => error instanceof Unavailable && error.status === -70402);
  assert.equal(f.on('holiday').get(), false);
  assert.deepEqual(controller.calls, []);
  await f.shutdown();
});

test('the grouped Home switch ends Holiday explicitly while raw presence and Home off only remember occupancy', async () => {
  const f = fixture({}, { initialPresence: true, initialHoliday: true }); await f.launch();
  const controller = f.state.controllers[0], owner = f.controls();
  assert.equal(f.on('home').get(), false);
  await controller.handle('/presence', { home: false });
  assert.equal(f.on('home').get(), false); assert.equal(f.on('holiday').get(), true);
  await f.on('home').set(false);
  assert.equal(controller.householdPresence, false); assert.equal(f.on('holiday').get(), true);
  await f.on('home').set(true);
  assert.deepEqual(controller.calls.slice(-2), [
    { route: '/home', body: { home: false } }, { route: '/home', body: { home: true } },
  ]);
  assert.equal(f.on('home').get(), true); assert.equal(f.on('holiday').get(), false);
  assert.equal(f.controls(), owner); assert.equal(owner.services.filter(service => service.type === 'switch').length, 2);
  assert.equal(f.unregistered.length, 0);
  await f.shutdown();
});

test('editor/controller changes update both HomeKit switches and shutdown removes listeners', async () => {
  const f = fixture(); await f.launch();
  const controller = f.state.controllers[0];
  controller.householdPresence = true; controller.holidayActive = true; controller.emit('change');
  assert.equal(f.on('home').value, false);
  assert.equal(f.on('holiday').value, true);
  assert.equal(controller.listenerCount('change'), 2);
  await f.shutdown();
  assert.equal(controller.closed, true);
  assert.equal(controller.listenerCount('change'), 0);
});

test('cached combined identity and custom names survive restart without duplicate publication', async () => {
  const f = fixture({}, { initialPresence: true, initialHoliday: true });
  const cached = new Accessory('Custom Heating', f.api.hap.uuid.generate(`${PLUGIN_NAME}:controls`));
  for (const role of ['home', 'holiday']) {
    cached.addService('switch', role, role).setCharacteristic('configured-name', `My ${role}`);
  }
  f.platform.configureAccessory(cached);
  await f.launch();
  assert.equal(f.registered.length, 0);
  assert.equal(f.updated.length, 1); assert.equal(f.updated[0][0], cached);
  assert.equal(cached.displayName, 'Custom Heating');
  assert.deepEqual(['home', 'holiday'].map(role => cached.getServiceById('switch', role).getCharacteristic('configured-name').value), ['My home', 'My holiday']);
  assert.equal(cached.services.filter(service => service.type === 'switch').length, 2);
  assert.equal(f.on('home').get(), false); assert.equal(f.on('holiday').get(), true);
  assert.equal(f.unregistered.length, 0);
  assert.deepEqual(f.state.controllers[0].calls, []);
  await f.shutdown();
});

test('stale shared accessories retire only after the controller starts successfully', async () => {
  const f = fixture();
  const stale = new Accessory('Old shared accessory', 'old-shared-uuid');
  f.platform.configureAccessory(stale);
  await f.launch();
  assert.deepEqual(f.unregistered.map(item => item.accessories), [[stale]]);
  assert.equal(f.registered.length, 1);
  await f.shutdown();
});

test('failed controller/provider startup publishes no switches and exposes no error detail', async () => {
  const f = fixture({}, { startError: new Error('provider failed with private details SECRET_VALUE') });
  const cached = new Accessory('Existing shared Home', f.api.hap.uuid.generate(`${PLUGIN_NAME}:home`));
  f.platform.configureAccessory(cached);
  await f.launch();
  assert.equal(f.registered.length, 0);
  assert.equal(f.updated.length, 0);
  assert.equal(f.unregistered.length, 0);
  assert.equal(f.state.providerWrites, 0);
  assert.equal(f.logEntries.filter(item => item.level === 'error').length, 1);
  assert.equal(JSON.stringify(f.logEntries).includes('SECRET_VALUE'), false);
  await f.shutdown();
});

test('Hive cannot be connected without explicit temperature limits', async () => {
  const f = fixture({ hiveTargetLimits: undefined }); await f.launch();
  assert.equal(f.state.controllers.length, 0);
  assert.equal(f.state.hiveConnections.length, 0);
  assert.equal(f.registered.length, 0);
  assert.equal(f.logEntries.filter(item => item.level === 'error').length, 1);
  await f.shutdown();
});

test('a disabled system is not constructed or given credentials by the controller platform', async () => {
  const f = fixture({ useHive: false, hiveTargetLimits: undefined, tuyaInstanceId: '0123456789abcdef' }); await f.launch();
  assert.deepEqual(f.state.providers.map(provider => provider.id), ['tuya']);
  assert.deepEqual(f.state.providers[0].options, { storagePath: '/not-used/homebridge', instanceId: '0123456789abcdef' });
  assert.equal(f.state.hiveConnections.length, 0);
  assert.equal(f.registered.length, 1);
  await f.shutdown();
});

test('shutdown during startup closes the controller without publishing late switches', async () => {
  let release;
  const startGate = new Promise(resolve => { release = resolve; });
  const f = fixture({}, { startGate }); await f.launch();
  await f.shutdown(); release(); await flush();
  assert.equal(f.registered.length, 0);
  assert.equal(f.state.controllers[0].closed, true);
  assert.equal(f.state.providerWrites, 0);
});

test('package main is a Homebridge loader function that registers the shared platform', () => {
  const loader = require('..');
  assert.equal(typeof loader, 'function');
  const registrations = [];
  loader({ registerPlatform: (...args) => registrations.push(args) });
  assert.deepEqual(registrations, [[PLATFORM_NAME, HeatingProgrammesPlatform]]);
});

function legacy(f) {
  const previous = {};
  for (const role of ['home', 'holiday']) {
    const owner = new Accessory(`Heating ${role}`, f.api.hap.uuid.generate(`${PLUGIN_NAME}:${role}`));
    owner.addService('switch', role, role).setCharacteristic('configured-name', `Old ${role}`);
    f.platform.configureAccessory(owner); previous[role] = owner;
  }
  return previous;
}

test('legacy separate Home/Holiday accessories retire only after the complete combined accessory registers', async () => {
  const f = fixture({}, {initialPresence: true}), previous = legacy(f); await f.launch();
  assert.deepEqual(f.publicationOrder, ['register', 'unregister']);
  assert.equal(f.registered[0].accessories[0].services.filter(value => value.type === 'switch').length, 2);
  assert.deepEqual(f.unregistered[0].accessories, [previous.home, previous.holiday]);
  assert.equal(f.state.controllers[0].listenerCount('change'), 2);
  assert.deepEqual(f.state.controllers[0].calls, []); assert.equal(f.state.providerWrites, 0);
  await f.on('holiday').set(true); assert.equal(f.on('home').get(), false); assert.equal(f.on('holiday').get(), true);
  await f.shutdown(); assert.equal(f.state.controllers[0].listenerCount('change'), 0);
});

test('a cached combined owner is updated before legacy accessories retire', async () => {
  const f = fixture({}, {initialPresence: true}), previous = legacy(f);
  const combined = new Accessory('Heating', f.api.hap.uuid.generate(`${PLUGIN_NAME}:controls`));
  f.platform.configureAccessory(combined); await f.launch();
  assert.deepEqual(f.publicationOrder, ['update', 'unregister']); assert.equal(f.registered.length, 0);
  assert.equal(combined.services.filter(value => value.type === 'switch').length, 2);
  assert.deepEqual(f.unregistered[0].accessories, [previous.home, previous.holiday]);
  await f.shutdown();
});

test('failed grouped registration preserves both old accessories and binds their existing controls', async () => {
  const f = fixture({}, {initialPresence: true, registerError: Error('registration failed PRIVATE_DETAILS')}), previous = legacy(f);
  await f.launch();
  assert.equal(f.registered.length, 0); assert.equal(f.unregistered.length, 0);
  assert.deepEqual(f.publicationOrder, ['register']); assert.deepEqual(f.state.controllers[0].calls, []);
  assert.equal(f.state.controllers[0].listenerCount('change'), 2);
  await previous.holiday.getServiceById('switch', 'holiday').getCharacteristic('on').set(true);
  assert.equal(previous.home.getServiceById('switch', 'home').getCharacteristic('on').get(), false);
  assert.equal(previous.holiday.getServiceById('switch', 'holiday').getCharacteristic('on').value, true);
  assert.equal(JSON.stringify(f.logEntries).includes('PRIVATE_DETAILS'), false);
  await f.shutdown(); assert.equal(f.state.controllers[0].listenerCount('change'), 0);
});

test('failed cached grouped publication preserves old controls and keeps existing combined controls bound', async () => {
  const f = fixture({}, {initialPresence: true, updateError: Error('storage failed')}), previous = legacy(f);
  const combined = new Accessory('Heating', f.api.hap.uuid.generate(`${PLUGIN_NAME}:controls`));
  f.platform.configureAccessory(combined); await f.launch();
  assert.equal(f.registered.length, 0); assert.equal(f.unregistered.length, 0);
  assert.equal(f.state.controllers[0].listenerCount('change'), 4);
  await combined.getServiceById('switch', 'holiday').getCharacteristic('on').set(true);
  assert.equal(previous.holiday.getServiceById('switch', 'holiday').getCharacteristic('on').value, true);
  await f.shutdown(); assert.equal(f.state.controllers[0].listenerCount('change'), 0);
});

test('a failed retirement leaves working old controls alongside the published combined controls for a later retry', async () => {
  const f = fixture({}, {initialPresence: true, unregisterError: Error('retirement failed')}), previous = legacy(f);
  await f.launch(); assert.equal(f.registered.length, 1); assert.equal(f.unregistered.length, 0);
  await f.on('holiday').set(true);
  assert.equal(previous.holiday.getServiceById('switch', 'holiday').getCharacteristic('on').value, true);
  assert.equal(f.state.controllers[0].listenerCount('change'), 4);
  await f.shutdown(); assert.equal(f.state.controllers[0].listenerCount('change'), 0);
});

test('blank names on cached combined services receive distinct names without replacing custom names', async () => {
  const f = fixture(), combined = new Accessory('Heating', f.api.hap.uuid.generate(`${PLUGIN_NAME}:controls`));
  combined.addService('switch', 'Home', 'home').setCharacteristic('configured-name', ' ');
  combined.addService('switch', 'Holiday', 'holiday').setCharacteristic('configured-name', 'Our holiday');
  f.platform.configureAccessory(combined); await f.launch();
  assert.equal(combined.getServiceById('switch', 'home').getCharacteristic('configured-name').value, 'Heating Home');
  assert.equal(combined.getServiceById('switch', 'holiday').getCharacteristic('configured-name').value, 'Our holiday');
  await f.shutdown();
});

test('real HAP serialization matches Hive: one owner, two ordinary visible Switch services and distinct configured names', async () => {
  const hap = require('@homebridge/hap-nodejs'), f = fixture({}, {initialPresence: true});
  f.api.hap = hap; f.api.platformAccessory = hap.Accessory; await f.launch();
  assert.equal(f.registered.length, 1); const owner = f.registered[0].accessories[0], serialized = hap.Accessory.serialize(owner);
  assert.equal(serialized.UUID, hap.uuid.generate(`${PLUGIN_NAME}:controls`)); assert.equal(serialized.displayName, 'Heating');
  const switches = serialized.services.filter(value => value.UUID === hap.Service.Switch.UUID);
  assert.equal(switches.length, 2); assert.deepEqual(switches.map(value => value.subtype), ['home', 'holiday']);
  assert.deepEqual(switches.map(value => value.displayName), ['Home', 'Holiday']);
  assert.ok(switches.every(value => value.hiddenService === false && value.primaryService === false));
  assert.equal(serialized.services.some(value => value.UUID === hap.Service.ServiceLabel.UUID), false);
  assert.deepEqual(switches.map(value => value.characteristics.find(c => c.UUID === hap.Characteristic.ConfiguredName.UUID).value),
    ['Heating Home', 'Heating Holiday']);
  assert.ok(switches.every(value => value.characteristics.filter(c => c.UUID === hap.Characteristic.On.UUID).length === 1));
  await f.shutdown(); assert.equal(f.state.controllers[0].listenerCount('change'), 0);
});
