import type { DeviceProfile, GeneratedIdentity } from '../schemas/profile.schema.js';

export const BUILTIN_DEVICE_PROFILES: DeviceProfile[] = [
  {
    id: 'pixel-8-pro',
    name: 'Google Pixel 8 Pro',
    isBuiltIn: true,
    brand: 'google',
    manufacturer: 'Google',
    model: 'Pixel 8 Pro',
    device: 'husky',
    product: 'husky',
    hardware: 'husky',
    board: 'husky',
    platform: 'zuma',
    buildType: 'user',
    buildTags: 'release-keys',
    buildId: 'AP2A.240805.005',
    buildFingerprint: 'google/husky/husky:14/AP2A.240805.005/12025142:user/release-keys',
    securityPatch: '2024-08-05',
    width: 1080,
    height: 2400,
    dpi: 420,
    macOui: '3C:28:6D',
    locale: 'id-ID',
    timezone: 'Asia/Jakarta',
    carrierName: 'Telkomsel',
    carrierMccMnc: '51010',
    countryIso: 'id',
  },
  {
    id: 'samsung-s23-ultra',
    name: 'Samsung Galaxy S23 Ultra (SM-S918B)',
    isBuiltIn: true,
    brand: 'samsung',
    manufacturer: 'samsung',
    model: 'SM-S918B',
    device: 'dm3q',
    product: 'dm3qxxx',
    hardware: 'qcom',
    board: 'kalama',
    platform: 'kalama',
    buildType: 'user',
    buildTags: 'release-keys',
    buildId: 'UP1A.231005.007',
    buildFingerprint: 'samsung/dm3qxxx/dm3q:14/UP1A.231005.007/S918BXXS6CXE9:user/release-keys',
    securityPatch: '2024-06-01',
    width: 1080,
    height: 2340,
    dpi: 450,
    macOui: '5C:3C:27',
    locale: 'id-ID',
    timezone: 'Asia/Jakarta',
    carrierName: 'Telkomsel',
    carrierMccMnc: '51010',
    countryIso: 'id',
  },
  {
    id: 'xiaomi-14',
    name: 'Xiaomi 14 (23127PN0CG)',
    isBuiltIn: true,
    brand: 'Xiaomi',
    manufacturer: 'Xiaomi',
    model: '23127PN0CG',
    device: 'houji',
    product: 'houji_global',
    hardware: 'qcom',
    board: 'pineapple',
    platform: 'pineapple',
    buildType: 'user',
    buildTags: 'release-keys',
    buildId: 'UKQ1.230804.001',
    buildFingerprint: 'Xiaomi/houji_global/houji:14/UKQ1.230804.001/V816.0.10.0.UNCMIXM:user/release-keys',
    securityPatch: '2024-07-01',
    width: 1200,
    height: 2670,
    dpi: 460,
    macOui: '64:CC:2E',
    locale: 'id-ID',
    timezone: 'Asia/Jakarta',
    carrierName: 'XL',
    carrierMccMnc: '51011',
    countryIso: 'id',
  },
  {
    id: 'oneplus-12',
    name: 'OnePlus 12 (CPH2581)',
    isBuiltIn: true,
    brand: 'OnePlus',
    manufacturer: 'OnePlus',
    model: 'CPH2581',
    device: 'OP5929L1',
    product: 'CPH2581',
    hardware: 'qcom',
    board: 'pineapple',
    platform: 'pineapple',
    buildType: 'user',
    buildTags: 'release-keys',
    buildId: 'UKQ1.230924.001',
    buildFingerprint: 'OnePlus/CPH2581/OP5929L1:14/UKQ1.230924.001/U.17a34b6_1-2:user/release-keys',
    securityPatch: '2024-07-05',
    width: 1080,
    height: 2412,
    dpi: 420,
    macOui: 'C0:EE:FB',
    locale: 'en-US',
    timezone: 'Asia/Jakarta',
    carrierName: 'Indosat',
    carrierMccMnc: '51001',
    countryIso: 'id',
  },
];

function randomHex(length: number): string {
  const chars = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function randomAlphaNumUpper(length: number): string {
  const chars = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

export function generateRealisticIdentity(macOui = '3C:28:6D'): GeneratedIdentity {
  const suffix = [randomHex(2), randomHex(2), randomHex(2)].join(':').toUpperCase();
  const normalizedOui = macOui.toUpperCase();
  const serialNo = `R5C${randomAlphaNumUpper(8)}`;
  const androidId = randomHex(16);
  const batteryLevel = Math.floor(45 + Math.random() * 44); // 45..88%

  return {
    serialNo,
    androidId,
    macAddress: `${normalizedOui}:${suffix}`,
    batteryLevel,
  };
}
