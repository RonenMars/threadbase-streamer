/**
 * POSIX trick: kill(pid, 0) sends no signal but throws ESRCH if no such PID,
 * EPERM if the PID exists but is owned by another user. Either way the
 * process exists; ESRCH alone means dead.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM"; // exists, just not ours
  }
}
