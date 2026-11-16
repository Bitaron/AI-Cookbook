// Git branch and worktree for the folder Claude works in, shown in the top bar like the Claude Code footer.
import { basename } from "node:path";

export interface GitInfo { branch?: string; worktree?: string; root?: string; dirty?: number }

export async function gitInfo(cwd: string | null): Promise<GitInfo | null> {
  if (!cwd) return null;
  const run = async (...args: string[]) => {
    const r = await Bun.$`git -C ${cwd} ${args}`.quiet().nothrow();
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  };
  const top = await run("rev-parse", "--show-toplevel");
  if (!top) return null;
  const [branch, gitDir, common, status] = await Promise.all([
    run("rev-parse", "--abbrev-ref", "HEAD"),
    run("rev-parse", "--absolute-git-dir"),
    run("rev-parse", "--path-format=absolute", "--git-common-dir"),
    run("status", "--porcelain", "--untracked-files=no"),
  ]);
  const short = branch === "HEAD" ? (await run("rev-parse", "--short", "HEAD")) ?? "detached" : branch ?? undefined;
  // A linked worktree has its own git dir under the main repo's common dir.
  const linked = !!gitDir && !!common && gitDir !== common;
  return {
    branch: short,
    worktree: linked ? basename(top) : undefined,
    root: top,
    dirty: status ? status.split("\n").filter(Boolean).length : 0,
  };
}
