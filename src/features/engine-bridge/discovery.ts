// Keep in sync with common/browser/extension_bridge_discovery.go in Yak.
const PORT_WINDOW = 16;
const PORT_BASES = [64333, 14333, 24333, 34333];

export function bridgeDiscoveryEndpoints(endpoint: string): string[] {
  const configured = new URL(endpoint);
  const preferred = Number(configured.port) || (configured.protocol === 'wss:' ? 443 : 80);
  const ports = new Set<number>();
  for (const first of [preferred, ...PORT_BASES]) {
    for (let port = first; port < first + PORT_WINDOW && port <= 65_535; port++) ports.add(port);
  }
  // Yak binds IPv4 loopback; WSL mirrored mode does not forward ::1 to it.
  const hosts = [...new Set([configured.hostname, '127.0.0.1'])];
  return hosts.flatMap((host) => [...ports].map((port) => {
    const url = new URL(configured);
    url.hostname = host;
    url.port = String(port);
    url.pathname = '/discovery';
    url.search = '';
    url.hash = '';
    return url.toString();
  }));
}
