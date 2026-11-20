import { extractFingerprintAndroidVersion, type DeviceProfile } from '@droidforge/shared';

export interface PresetGroup {
  label: string;
  profiles: DeviceProfile[];
}

export function formatPresetOptionLabel(profile: DeviceProfile): string {
  return `${profile.name} (${profile.brand} / ${profile.model})`;
}

export function groupDeviceProfiles(profiles: DeviceProfile[]): PresetGroup[] {
  const custom: DeviceProfile[] = [];
  const android16: DeviceProfile[] = [];
  const android15: DeviceProfile[] = [];
  const android14: DeviceProfile[] = [];
  const otherBuiltIn: DeviceProfile[] = [];

  for (const profile of profiles) {
    if (!profile.isBuiltIn) {
      custom.push(profile);
      continue;
    }
    const ver = extractFingerprintAndroidVersion(profile.buildFingerprint);
    if (ver === '16') android16.push(profile);
    else if (ver === '15') android15.push(profile);
    else if (ver === '14') android14.push(profile);
    else otherBuiltIn.push(profile);
  }

  const groups: PresetGroup[] = [];
  if (custom.length > 0) {
    groups.push({ label: 'Custom Presets', profiles: custom });
  }
  if (android16.length > 0) {
    groups.push({ label: 'Built-in: Android 16 (Latest)', profiles: android16 });
  }
  if (android15.length > 0) {
    groups.push({ label: 'Built-in: Android 15', profiles: android15 });
  }
  if (android14.length > 0) {
    groups.push({ label: 'Built-in: Android 14', profiles: android14 });
  }
  if (otherBuiltIn.length > 0) {
    groups.push({ label: 'Built-in: Other', profiles: otherBuiltIn });
  }
  return groups;
}
