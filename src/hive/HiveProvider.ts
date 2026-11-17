import {copyProgramme, TargetLimits, WeeklyProgramme} from '../programmes';
import {HeatingZone, ProgrammeProvider, ProviderApplyResult, ProviderPrepareOptions, ProviderPreview} from '../controller/Provider';
import {HiveProgrammeAdapter, HiveZoneSnapshot} from './HiveProgrammeAdapter';
import {HiveIpcTransport} from './HiveIpcTransport';

/** A profile called Holiday is a saved week, not Hive's native holiday override. */
export class HiveProvider implements ProgrammeProvider {
  readonly id = 'hive';
  readonly title = 'Hive';
  private adapter: HiveProgrammeAdapter;
  constructor(private transport: HiveIpcTransport, private limits: TargetLimits) {
    this.adapter = new HiveProgrammeAdapter(transport, {targetLimits: limits});
  }
  private async zone(snapshot: HiveZoneSnapshot): Promise<HeatingZone> {
    const capabilities = await this.transport.getCapabilities();
    return {id: snapshot.id, name: snapshot.name, online: snapshot.online, measuredC: snapshot.measuredC,
      targetC: snapshot.targetC, mode: snapshot.mode, scheduled: snapshot.mode === 'SCHEDULE' && !snapshot.nativeHolidayActive,
      readAt: snapshot.readAt, programme: snapshot.programme, fingerprint: snapshot.fingerprint,
      writeEnabled: capabilities.write && capabilities.enrolledZoneIds.includes(snapshot.id), limits: this.limits,
      periods: {min: 1, max: 6}};
  }
  async list(): Promise<HeatingZone[]> { return Promise.all((await this.adapter.readZones()).map(zone => this.zone(zone))); }
  async read(deviceId: string): Promise<HeatingZone> {
    const snapshot = (await this.adapter.readZones()).find(zone => zone.id === deviceId);
    if (!snapshot) throw new Error('Hive thermostat was not found.');
    return this.zone(snapshot);
  }
  async prepare(deviceId: string, programme: WeeklyProgramme, expectedFingerprint?: string,
    _options: ProviderPrepareOptions = {}): Promise<ProviderPreview> {
    const capabilities = await this.transport.getCapabilities();
    if (!capabilities.write || !capabilities.enrolledZoneIds.includes(deviceId)) throw new Error('Hive programme uploads are disabled for this thermostat.');
    // Adapter preparation already obtains a fresh, complete Scheduled baseline.
    const preview = await this.adapter.prepare(deviceId, copyProgramme(programme, 6, this.limits));
    if (expectedFingerprint && preview.baselineFingerprint !== expectedFingerprint) throw new Error('The Hive programme changed during preview.');
    return {token: preview.token, deviceId, programme: preview.programme,
      expiresAt: preview.expiresAt, changesRequired: preview.changesRequired};
  }
  async apply(token: string): Promise<ProviderApplyResult> {
    const result = await this.adapter.apply(token);
    return {status: result.status, reason: result.reason, writeAttempted: result.writeAttempted,
      ...(result.readback ? {readback: await this.zone(result.readback)} : {})};
  }
}
