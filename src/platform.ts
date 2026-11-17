import type {API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig} from 'homebridge';
import {HeatingController} from './controller/Controller';
import {ProgrammeProvider} from './controller/Provider';
import {HiveProvider} from './hive/HiveProvider';
import {HiveIpcTransport} from './hive/HiveIpcTransport';
import {TuyaIpcTransport} from './tuya/TuyaIpcTransport';

export const PLUGIN_NAME = '@jdipper/homebridge-heating-programmes';
export const PLATFORM_NAME = 'HeatingProgrammes';

/** Household controls live here. No account credentials belong in this platform. */
export class HeatingProgrammesPlatform implements DynamicPlatformPlugin {
  private controller?: HeatingController;
  private cached: PlatformAccessory[] = [];
  private disposed: (() => void)[] = [];
  private stopping = false;
  constructor(private log: Logger, private config: PlatformConfig, private api: API) {
    api.on('didFinishLaunching', () => {void this.start().catch(() => {
      this.log.error('The shared heating controller could not start. Check the provider plugins and saved settings.');
    });});
    api.on('shutdown', () => {
      this.stopping = true;
      this.disposed.forEach(dispose => dispose()); this.disposed = [];
      void this.controller?.close().catch(() => this.log.warn('Heating controller shutdown needs attention.'));
    });
  }
  configureAccessory(accessory: PlatformAccessory): void {this.cached.push(accessory);}
  private async start(): Promise<void> {
    const providers: ProgrammeProvider[] = [];
    if (this.config.useTuya !== false) providers.push(new TuyaIpcTransport({storagePath: this.api.user.storagePath(),
      ...(typeof this.config.tuyaInstanceId === 'string' && this.config.tuyaInstanceId ? {instanceId: this.config.tuyaInstanceId} : {})}));
    if (this.config.useHive !== false) {
      const limits = this.config.hiveTargetLimits as {minC?: unknown; maxC?: unknown; stepC?: unknown} | undefined;
      // These are explicit validation limits, never model guesses or live device settings.
      if (!limits || typeof limits.minC !== 'number' || typeof limits.maxC !== 'number' || typeof limits.stepC !== 'number') {
        throw new Error('Configure Hive target limits before connecting its programme editor.');
      }
      providers.push(new HiveProvider(new HiveIpcTransport({storagePath: this.api.user.storagePath()}), {
        minC: limits.minC, maxC: limits.maxC, stepC: limits.stepC,
      }));
    }
    const controller = new HeatingController(this.api.user.persistPath(), providers, this.log);
    await controller.start();
    if (this.stopping) {await controller.close(); return;}
    this.controller = controller;
    const {Service, Characteristic, HapStatusError, HAPStatus} = this.api.hap;
    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:controls`);
    const cached = this.cached.find(accessory => accessory.UUID === uuid);
    const accessory = cached ?? new this.api.platformAccessory('Heating', uuid);
    const bind = (service: ReturnType<PlatformAccessory['addService']>, role: 'home' | 'holiday') => {
      const on = service.getCharacteristic(Characteristic.On);
      on.onGet(() => {
        if (role === 'home' && controller.homeActive === null) throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        return role === 'home' ? controller.homeActive! : controller.holidayActive;
      });
      on.onSet(async value => {await controller.handle(role === 'home' ? '/home' : '/holiday',
        role === 'home' ? {home: Boolean(value)} : {active: Boolean(value)});});
      const update = () => {
        if (role === 'holiday' || controller.homeActive !== null) on.updateValue(
          role === 'home' ? controller.homeActive! : controller.holidayActive);
      };
      controller.on('change', update);
      const dispose = () => controller.off('change', update);
      this.disposed.push(dispose);
      try {update();} catch (error) {
        dispose(); this.disposed = this.disposed.filter(value => value !== dispose); throw error;
      }
      return dispose;
    };
    // Cached characteristics lose their handlers on restart. Keep the old controls
    // usable until the new combined accessory has been successfully published.
    const legacyBindings: (() => void)[] = [];
    for (const role of ['home', 'holiday'] as const) {
      const legacy = this.cached.find(item => item.UUID === this.api.hap.uuid.generate(`${PLUGIN_NAME}:${role}`));
      const service = legacy?.getServiceById(Service.Switch, role);
      if (service) legacyBindings.push(bind(service, role));
    }
    const groupedBindings: (() => void)[] = [];
    const disposeBindings = (bindings: (() => void)[]) => {
      bindings.forEach(dispose => dispose()); this.disposed = this.disposed.filter(dispose => !bindings.includes(dispose));
    };
    try {
      const info = accessory.getService(Service.AccessoryInformation)!;
      info.setCharacteristic(Characteristic.Manufacturer, 'jdipper')
        .setCharacteristic(Characteristic.Model, 'Shared heating programmes')
        .setCharacteristic(Characteristic.SerialNumber, 'heating-programmes-controls');
      for (const role of ['home', 'holiday'] as const) {
        const name = role === 'home' ? 'Home' : 'Holiday';
        const service = accessory.getServiceById(Service.Switch, role) ?? accessory.addService(Service.Switch, name, role);
        service.displayName = name; service.setCharacteristic(Characteristic.Name, name);
        if (!service.testCharacteristic(Characteristic.ConfiguredName)) service.addOptionalCharacteristic(Characteristic.ConfiguredName);
        const configuredName = service.getCharacteristic(Characteristic.ConfiguredName).value;
        if (typeof configuredName !== 'string' || !configuredName.trim()) {
          service.setCharacteristic(Characteristic.ConfiguredName, `Heating ${name}`);
        }
        groupedBindings.push(bind(service, role));
      }
      if (cached) this.api.updatePlatformAccessories([accessory]);
      else this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    } catch (error) {
      // Existing combined controls remain bound if their storage update failed.
      // A new unpublished accessory needs no controller change listeners.
      if (!cached) disposeBindings(groupedBindings);
      throw error;
    }
    const stale = this.cached.filter(item => item.UUID !== uuid);
    if (stale.length) {
      try {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
        disposeBindings(legacyBindings);
      } catch {
        this.log.warn('Grouped heating controls are ready. Older controls could not be retired; restart Homebridge to retry.');
      }
    }
    this.log.info('Shared heating programme controls are ready. Startup sent no programme changes.');
  }
}
