/**
 * Canonical Tailscale / hardware mesh inventory for Fleet OS.
 * Cloud VMs are not on the tailnet — probe from a Mac Mini with Tailscale up.
 * Do not invent online status from this static map; advertise heartbeats prove liveness.
 */

export type FleetMeshHost = {
  machineId: 'oakland-mini' | 'sf-mini' | 'backup-mini' | 'destrys-hp' | 'macbook-pro' | 'macbook-neo'
  displayName: string
  role: 'coordination-hub' | 'browser-sessions' | 'failover' | 'coding' | 'personal'
  tailscaleHostname: string
  tailscaleAliases?: string[]
  tailscaleIp: string
  /** Probe hint only. Never fills tailscaleIp or mesh liveness by itself. */
  lastKnownTailscaleIp?: string
  tailnet: string
  sshUser: string
  expectedFleetPort: number
  identities: string[]
  notes: string
}

/** Known Byteport / Alex fleet from Memory Mesh + Claude memory (as of 2026-08). */
export const FLEET_MESH_HOSTS: FleetMeshHost[] = [
  {
    machineId: 'oakland-mini',
    displayName: 'Oakland Mac Mini (alex-mac-mini-1)',
    role: 'coordination-hub',
    tailscaleHostname: 'alex-mac-mini-1',
    tailscaleAliases: ['alexs-mac-mini'],
    tailscaleIp: '100.118.142.13',
    tailnet: 'tail1b1137.ts.net',
    sshUser: 'destrynewiger',
    expectedFleetPort: 8787,
    identities: ['alex-byteport', 'alex-gmail', 'alex-calendar'],
    notes: 'Intended Fleet OS control-plane hub + local Ollama + Hermes/Codex. Also hosts Luey GTM outbound.',
  },
  {
    machineId: 'sf-mini',
    displayName: 'Byteport SF Mac Mini (alex-agent-mini)',
    role: 'browser-sessions',
    tailscaleHostname: 'alex-agent-mini',
    tailscaleIp: '100.106.243.19',
    tailnet: 'tail1b1137.ts.net',
    sshUser: 'destrynewiger',
    expectedFleetPort: 8787,
    identities: ['alex-byteport', 'katherine-byteport'],
    notes: 'Authenticated browser / LinkedIn session host for Katherine + Alex Byteport.',
  },
  {
    machineId: 'backup-mini',
    displayName: 'Backup Byteport Mac Mini',
    role: 'failover',
    tailscaleHostname: 'backup-byteport-mini',
    tailscaleAliases: ['backup-mini', 'byteport-backup', 'alex-backup-mini'],
    tailscaleIp: '',
    lastKnownTailscaleIp: '100.90.155.111',
    tailnet: 'tail1b1137.ts.net',
    sshUser: 'destrynewiger',
    expectedFleetPort: 8787,
    identities: ['alex-byteport', 'katherine-byteport'],
    notes: 'Failover research / GrokBot + Katherine LinkedIn. Last-known Tailscale IP 100.90.155.111 is a probe target only; live IP comes from Oakland netmap or ping.',
  },
  {
    machineId: 'destrys-hp',
    displayName: 'DestrysHP',
    role: 'coding',
    tailscaleHostname: 'destrys-hp',
    tailscaleIp: '',
    tailnet: 'tail1b1137.ts.net',
    sshUser: 'destrynewiger',
    expectedFleetPort: 8787,
    identities: [],
    notes: 'Coding overflow. Offline unless heartbeating.',
  },
  {
    machineId: 'macbook-pro',
    displayName: 'Alex MacBook Pro',
    role: 'personal',
    tailscaleHostname: 'alexs-macbook-pro',
    tailscaleIp: '100.73.203.75',
    tailnet: 'tail1b1137.ts.net',
    sshUser: 'destrynewiger',
    expectedFleetPort: 8787,
    identities: [],
    notes: 'Personal laptop on the same tailnet; not a required Fleet OS worker.',
  },
  {
    machineId: 'macbook-neo',
    displayName: 'Alex MacBook Neo',
    role: 'personal',
    tailscaleHostname: 'alexs-macbook-neo',
    tailscaleIp: '100.70.8.90',
    tailnet: 'tail1b1137.ts.net',
    sshUser: 'destrynewiger',
    expectedFleetPort: 8787,
    identities: [],
    notes: 'Memory-mesh coordinator historically; Remote Login often off.',
  },
]

export type MeshProbeResult = {
  machineId: string
  host: string
  tcp22: 'open' | 'closed' | 'unknown'
  fleetHttp: 'ok' | 'error' | 'unreachable' | 'skipped'
  detail: string
}

export function requiredMeshHosts(hosts: FleetMeshHost[] = FLEET_MESH_HOSTS): FleetMeshHost[] {
  return hosts.filter((host) =>
    host.machineId === 'oakland-mini'
    || host.machineId === 'sf-mini'
    || host.machineId === 'backup-mini',
  )
}

export function meshHostByMachineId(machineId: string, hosts: FleetMeshHost[] = FLEET_MESH_HOSTS): FleetMeshHost | undefined {
  return hosts.find((host) => host.machineId === machineId)
}

/** Build MagicDNS / IP targets for a host (skips empty live IP). lastKnown is a probe hint only. */
export function meshProbeTargets(host: FleetMeshHost): string[] {
  const targets: string[] = []
  if (host.tailscaleIp) targets.push(host.tailscaleIp)
  if (host.tailscaleHostname && host.tailnet) {
    targets.push(`${host.tailscaleHostname}.${host.tailnet}`)
  }
  for (const alias of host.tailscaleAliases ?? []) {
    if (alias && host.tailnet) targets.push(`${alias}.${host.tailnet}`)
  }
  if (host.lastKnownTailscaleIp && !targets.includes(host.lastKnownTailscaleIp)) {
    targets.push(host.lastKnownTailscaleIp)
  }
  return targets
}

export function summarizeMeshInventory(hosts: FleetMeshHost[] = FLEET_MESH_HOSTS): {
  total: number
  required: number
  withKnownIp: number
  missingIp: string[]
} {
  const required = requiredMeshHosts(hosts)
  return {
    total: hosts.length,
    required: required.length,
    withKnownIp: hosts.filter((host) => Boolean(host.tailscaleIp)).length,
    missingIp: hosts.filter((host) => !host.tailscaleIp).map((host) => host.machineId),
  }
}

type TailscalePeer = {
  HostName?: string
  DNSName?: string
  TailscaleIPs?: string[]
  AllowedIPs?: string[]
  Tags?: string[]
}

type TailscaleStatus = {
  Self?: TailscalePeer
  Peer?: Record<string, TailscalePeer>
}

function peerNames(peer: TailscalePeer = {}): string[] {
  return [peer.HostName, peer.DNSName, ...(peer.Tags ?? [])]
    .filter(Boolean)
    .map((name) => String(name).toLowerCase().replace(/\.$/, '').split('.')[0])
}

function peerIp(peer: TailscalePeer = {}): string {
  const ips = peer.TailscaleIPs || peer.AllowedIPs || []
  const v4 = ips.find((ip) => String(ip).startsWith('100.'))
  return v4 ? String(v4).split('/')[0] : ''
}

function matchHostToPeer(host: FleetMeshHost, peer: TailscalePeer): boolean {
  const candidates = new Set(
    [host.tailscaleHostname, ...(host.tailscaleAliases ?? [])]
      .filter(Boolean)
      .map((name) => String(name).toLowerCase()),
  )
  return peerNames(peer).some(
    (name) => candidates.has(name) || [...candidates].some((c) => name.includes(c) || c.includes(name)),
  )
}

/** Fill missing Tailscale IPs from live `tailscale status --json` (Oakland cutover). */
export function enrichMeshFromTailscaleStatus(
  status: TailscaleStatus,
  hosts: FleetMeshHost[] = FLEET_MESH_HOSTS,
): {
  hosts: FleetMeshHost[]
  discovered: Array<{ machineId: string; tailscaleIp: string }>
  selfIsOakland: boolean
} {
  const peers = Object.values(status.Peer || {})
  const self = status.Self
  const discovered: Array<{ machineId: string; tailscaleIp: string }> = []
  const enriched = hosts.map((host) => {
    if (host.tailscaleIp) return { ...host }
    const peer = peers.find((item) => matchHostToPeer(host, item))
      || (self && matchHostToPeer(host, self) ? self : undefined)
    const ip = peer ? peerIp(peer) : ''
    if (!ip) return { ...host }
    discovered.push({ machineId: host.machineId, tailscaleIp: ip })
    return { ...host, tailscaleIp: ip }
  })
  const selfNames = peerNames(self || {})
  const selfIsOakland = selfNames.some((name) =>
    name === 'alex-mac-mini-1' || name === 'alexs-mac-mini' || name.includes('alex-mac-mini'),
  ) || peerIp(self || {}) === '100.118.142.13'
  return { hosts: enriched, discovered, selfIsOakland }
}
