import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { endpointIsProvenDead, probeSocketConnect } from './daemon-endpoint-probe'
import {
  getDaemonHistoryDir as getHistoryDir,
  probeDaemonSocket as probeSocket
} from './daemon-launch-paths'
import { parseDaemonPidFile, salvagePidFromCorruptDaemonRecord } from './daemon-pid-file-parse'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'
import { retireTokenlessDaemon } from './daemon-tokenless-retirement'
import { PREVIOUS_DAEMON_PROTOCOL_VERSIONS } from './types'

const LIVE_DAEMON_PROBE_RETRY_DELAYS_MS = [250, 750]

/** 'unknown' is load-bearing: EPERM, an unreadable pid file, or any other failed check proves nothing. */
type LegacyDaemonPidLiveness = 'alive' | 'gone' | 'no-record' | 'unknown'

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function readLegacyDaemonPidLiveness(
  runtimeDir: string,
  protocolVersion: number
): LegacyDaemonPidLiveness {
  let content: string
  try {
    content = readFileSync(getDaemonPidPath(runtimeDir, protocolVersion), 'utf8')
  } catch (error) {
    return hasErrorCode(error, 'ENOENT') ? 'no-record' : 'unknown'
  }
  const pid = parseDaemonPidFile(content)?.pid ?? salvagePidFromCorruptDaemonRecord(content)
  if (pid === null) {
    return 'no-record'
  }
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    // Why: only ESRCH proves absence; Windows reports EPERM for a live process it won't open.
    return hasErrorCode(error, 'ESRCH') ? 'gone' : 'unknown'
  }
}

async function probeLegacyDaemonSocket(
  socketPath: string,
  pidLiveness: () => LegacyDaemonPidLiveness
): Promise<boolean> {
  if (await probeSocket(socketPath)) {
    return true
  }
  // Why: a cold start right after an update can starve a live daemon's accept loop past one probe.
  const liveness = pidLiveness()
  if (liveness === 'gone' || liveness === 'no-record') {
    return false
  }
  for (const delayMs of LIVE_DAEMON_PROBE_RETRY_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    if (await probeSocket(socketPath)) {
      return true
    }
  }
  return false
}

// Why: a leaked token plus a recycled pid later turns an identity check into a PowerShell spawn, but
// deleting a live daemon's token strands its sessions forever (no client can authenticate, and it
// never idles out), so both the pid and the endpoint must prove the daemon is gone.
async function removeProvablyStaleLegacyArtifacts(
  runtimeDir: string,
  protocolVersion: number,
  pidLiveness: LegacyDaemonPidLiveness
): Promise<void> {
  if (pidLiveness !== 'gone' && pidLiveness !== 'no-record') {
    console.warn(
      `[daemon] Keeping v${protocolVersion} daemon token: endpoint unreachable but pid liveness is ${pidLiveness}`
    )
    return
  }
  const endpoint = await probeSocketConnect(getDaemonSocketPath(runtimeDir, protocolVersion))
  if (!endpointIsProvenDead(endpoint)) {
    console.warn(
      `[daemon] Keeping v${protocolVersion} daemon token: endpoint probe was ${endpoint}, not proof of exit`
    )
    return
  }
  const stalePaths = [
    getDaemonPidPath(runtimeDir, protocolVersion),
    getDaemonTokenPath(runtimeDir, protocolVersion)
  ]
  for (const stalePath of stalePaths) {
    try {
      unlinkSync(stalePath)
      console.warn(
        `[daemon] Removed stale v${protocolVersion} daemon file ${stalePath} (pid ${pidLiveness}, endpoint ${endpoint})`
      )
    } catch {
      // Best-effort
    }
  }
}

// Why: callers that own an isolated runtime namespace must keep discovery history out of app userData.
export async function createLegacyDaemonAdapters(
  runtimeDir: string,
  historyPath = getHistoryDir()
): Promise<DaemonPtyAdapter[]> {
  const adapters: DaemonPtyAdapter[] = []
  for (const protocolVersion of PREVIOUS_DAEMON_PROTOCOL_VERSIONS) {
    const socketPath = getDaemonSocketPath(runtimeDir, protocolVersion)
    const tokenPath = getDaemonTokenPath(runtimeDir, protocolVersion)
    const pidLiveness = (): LegacyDaemonPidLiveness =>
      readLegacyDaemonPidLiveness(runtimeDir, protocolVersion)
    if (!(await probeLegacyDaemonSocket(socketPath, pidLiveness))) {
      await removeProvablyStaleLegacyArtifacts(runtimeDir, protocolVersion, pidLiveness())
      continue
    }
    if (!existsSync(tokenPath)) {
      // Why off the startup path: termination waits seconds, and nothing here depends on it.
      void retireTokenlessDaemon(socketPath, tokenPath, protocolVersion).catch((error) => {
        console.warn(`[daemon] Tokenless v${protocolVersion} daemon retirement failed`, error)
      })
      continue
    }
    // Keep old-protocol PTYs routed to their original daemon during upgrade; legacy adapters never respawn (new code would recreate stale env semantics).
    // historyPath is still needed for cleanup — without it a later v4 session reusing the same ID could false-restore stale scrollback.bin.
    adapters.push(
      new DaemonPtyAdapter({
        socketPath,
        tokenPath,
        pidPath: getDaemonPidPath(runtimeDir, protocolVersion),
        profileScope: runtimeDir,
        runtimeDir,
        protocolVersion,
        historyPath
      })
    )
  }
  return adapters
}
