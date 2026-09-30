import { existsSync } from 'node:fs'
import { getStrictProcessTableSnapshot } from '../../shared/process-table-snapshot-reader'
import { readWindowsProcessTableFresh } from '../windows/windows-process-table'
import { commandLineMatchesDaemon, inspectDaemonProcessIdentity } from './daemon-pid-identity'
import { terminateIdentifiedDaemon } from './daemon-stale-kill'

type DaemonProcessCandidate = { pid: number; startedAtMs: number | null }

async function findDaemonProcesses(
  socketPath: string,
  tokenPath: string
): Promise<DaemonProcessCandidate[]> {
  const rows =
    process.platform === 'win32'
      ? (await readWindowsProcessTableFresh()).map((row) => ({
          pid: row.pid,
          command: row.command,
          startedAtMs: row.creationTimeMs ?? null
        }))
      : (await getStrictProcessTableSnapshot()).map((row) => ({
          pid: row.pid,
          command: row.command,
          startedAtMs: null
        }))
  return rows
    .filter(
      (row) =>
        row.pid !== process.pid && commandLineMatchesDaemon(row.command, socketPath, tokenPath)
    )
    .map(({ pid, startedAtMs }) => ({ pid, startedAtMs }))
}

/**
 * A daemon that still serves its endpoint after its token file is gone can never be
 * authenticated to again, so it can't be adopted, listed, or shut down over RPC, and it never
 * idles out while its shells live. Terminating it (its job object/scope takes the shells) is
 * the only way to end sessions no client can reach. Returns true when it was confirmed gone.
 */
export async function retireTokenlessDaemon(
  socketPath: string,
  tokenPath: string,
  protocolVersion: number
): Promise<boolean> {
  const label = `v${protocolVersion}`
  let candidates: DaemonProcessCandidate[]
  try {
    candidates = await findDaemonProcesses(socketPath, tokenPath)
  } catch (error) {
    console.warn(
      `[daemon] Cannot retire tokenless ${label} daemon: process table unreadable`,
      error
    )
    return false
  }
  if (candidates.length !== 1) {
    // Why: zero means we can't name the server; several means we can't tell which one serves.
    console.warn(
      `[daemon] Cannot retire tokenless ${label} daemon: ${candidates.length} matching processes`
    )
    return false
  }
  const [{ pid, startedAtMs }] = candidates
  // Why re-check: a token published since discovery means the daemon is reachable again.
  if (existsSync(tokenPath)) {
    return false
  }
  if ((await inspectDaemonProcessIdentity(pid, socketPath, tokenPath, startedAtMs)) !== 'match') {
    console.warn(`[daemon] Cannot retire tokenless ${label} daemon ${pid}: identity not proven`)
    return false
  }
  console.warn(`[daemon] Retiring tokenless ${label} daemon ${pid}: its sessions are unreachable`)
  const outcome = await terminateIdentifiedDaemon(pid, startedAtMs, socketPath, tokenPath)
  if (!outcome.exited) {
    console.warn(`[daemon] Tokenless ${label} daemon ${pid} survived retirement`)
  }
  return outcome.exited
}
