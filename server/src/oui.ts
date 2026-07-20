/**
 * Tiny vendor hint from MAC OUI prefix — deliberately small, common network
 * vendors only. Unknown prefixes return null (honest), never a guess.
 * The neighbor's own `platform` field (MNDP/LLDP) always wins when present.
 */
const OUI: Record<string, string> = {
  // MikroTik
  '4c:5e:0c': 'MikroTik', '64:d1:54': 'MikroTik', '6c:3b:6b': 'MikroTik',
  'e4:8d:8c': 'MikroTik', 'cc:2d:e0': 'MikroTik', '48:8f:5a': 'MikroTik',
  '18:fd:74': 'MikroTik', 'dc:2c:6e': 'MikroTik', 'b8:69:f4': 'MikroTik',
  '08:55:31': 'MikroTik', '78:9a:18': 'MikroTik', 'd4:01:c3': 'MikroTik',
  '2c:c8:1b': 'MikroTik', 'f4:1e:57': 'MikroTik', 'c4:ad:34': 'MikroTik',
  // Virtualization
  '00:0c:29': 'VMware', '00:50:56': 'VMware', '00:05:69': 'VMware',
  'bc:24:11': 'Proxmox', '52:54:00': 'QEMU/KVM', '00:15:5d': 'Hyper-V',
  // Common network vendors
  'f0:9f:c2': 'Ubiquiti', '74:83:c2': 'Ubiquiti', 'fc:ec:da': 'Ubiquiti',
  '00:1d:aa': 'Cisco', 'd8:07:b6': 'TP-Link', '50:c7:bf': 'TP-Link',
  '00:31:92': 'TP-Link', 'a4:2b:b0': 'TP-Link',
};

export function vendorFromMac(mac: string | null): string | null {
  if (!mac) return null;
  return OUI[mac.toLowerCase().slice(0, 8)] ?? null;
}
