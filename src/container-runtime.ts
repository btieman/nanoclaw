/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import os from 'os';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/**
 * Detect whether the `docker` binary is actually rootless podman.
 *
 * Rootless podman emulates the Docker CLI but remaps UIDs through a user
 * namespace: the container's `node` user (UID 1000) maps to a high subuid on
 * the host, not to the host's own UID. Cached after first probe.
 */
let _isRootlessPodman: boolean | undefined;
export function isRootlessPodman(): boolean {
  if (_isRootlessPodman !== undefined) return _isRootlessPodman;

  // Fast, offline detection first. `docker --version` prints "podman version X"
  // when the `docker` CLI is the podman wrapper. We deliberately avoid leading
  // with `docker info`: it can take >10s on a loaded host (e.g. during boot,
  // or while a container is crash-looping every minute), and a timed-out probe
  // used to be cached as `false` — disabling keep-id for the whole process and
  // crash-looping every container on "attempt to write a readonly database".
  // `--version` is near-instant and needs no running daemon/service.
  let isPodman = false;
  try {
    const ver = execSync(`${CONTAINER_RUNTIME_BIN} --version`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 10000,
    });
    isPodman = /podman/i.test(ver);
  } catch {
    // fall through to the authoritative `info` probe below
  }

  // Rootless podman == podman invoked by a non-root user. That is the only
  // case that needs keep-id; root podman maps UID 1:1 like real Docker. This
  // inference is reliable and avoids the slow `info` call entirely.
  if (isPodman) {
    const uid = process.getuid?.();
    if (uid !== undefined && uid !== 0) {
      _isRootlessPodman = true;
      return _isRootlessPodman;
    }
  }

  // Authoritative fallback (non-podman CLIs, root podman, odd setups). A
  // timeout/error here must NOT poison the cache with `false` — leave it unset
  // so a later spawn re-probes once the host is less loaded. Generous timeout.
  try {
    const out = execSync(`${CONTAINER_RUNTIME_BIN} info --format '{{.Host.Security.Rootless}}'`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 30000,
    });
    _isRootlessPodman = out.trim() === 'true';
    return _isRootlessPodman;
  } catch {
    // Best-effort, uncached: better to skip keep-id this once than to lock in
    // a wrong `false` for the process lifetime.
    return isPodman;
  }
}

/**
 * User-namespace args for spawning a container.
 *
 * Under rootless podman the container's `node` user (UID 1000) would map to a
 * host subuid and therefore cannot write the host-owned session DB files
 * (mode 0644) — the agent-runner dies with "attempt to write a readonly
 * database". `--userns=keep-id` maps the host user 1:1 into the container so
 * `node` (UID 1000) == host UID 1000 and the bind mounts are writable. Real
 * Docker maps UID 1000 directly, so no flag is needed (returns []).
 */
export function userNamespaceArgs(): string[] {
  return isRootlessPodman() ? ['--userns=keep-id'] : [];
}

/**
 * Non-default slirp4netns CIDR for rootless-podman containers. The default
 * (10.0.2.0/24) collides with common host NAT ranges (e.g. VirtualBox NAT),
 * which breaks host reachability. `.2` of this range is slirp's host-loopback
 * address — it forwards to the host's 127.0.0.1.
 */
const ROOTLESS_SLIRP_CIDR = '10.99.0.0/24';
const ROOTLESS_HOST_LOOPBACK = '10.99.0.2';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  if (os.platform() !== 'linux') return [];
  // Rootless podman: the container can't reach the host on the bridge gateway
  // or the host's external IP — only via slirp4netns's host-loopback mapping.
  // Point host.docker.internal at that address; host services the container
  // needs (e.g. the OneCLI gateway) must therefore bind to the host's 127.0.0.1.
  if (isRootlessPodman()) {
    return [
      `--network=slirp4netns:allow_host_loopback=true,cidr=${ROOTLESS_SLIRP_CIDR}`,
      `--add-host=host.docker.internal:${ROOTLESS_HOST_LOOPBACK}`,
    ];
  }
  // On Linux Docker, host.docker.internal isn't built-in — add it explicitly
  return ['--add-host=host.docker.internal:host-gateway'];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart NanoClaw                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Scoped by label `nanoclaw-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}
