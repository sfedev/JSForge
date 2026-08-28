/** Manejadores IPC del control de fuentes. */

import {
  IPC,
  ok,
  type GitBranch,
  type GitCommitRequest,
  type GitDiffPair,
  type GitDiffRequest,
  type GitLogEntry,
  type GitStatus,
} from '../../../shared/contracts.js';
import {
  applyPatch,
  branches,
  checkout,
  commit,
  createBranch,
  diff,
  discard,
  log,
  stage,
  status,
  unstage,
} from '../../services/git/git-service.js';
import { handle } from '../registry.js';

export function registerGitHandlers(): void {
  handle<[], GitStatus>(IPC.GIT_STATUS, async () => ok(await status()));

  handle<[], readonly GitBranch[]>(IPC.GIT_BRANCHES, async () => ok(await branches()));

  handle<[string], true>(IPC.GIT_CHECKOUT, async (branch) => ok(await checkout(branch)));

  handle<[string, string | null], true>(IPC.GIT_CREATE_BRANCH, async (name, from) =>
    ok(await createBranch(name, from)),
  );

  handle<[readonly string[]], true>(IPC.GIT_STAGE, async (paths) => ok(await stage(paths)));

  handle<[readonly string[]], true>(IPC.GIT_UNSTAGE, async (paths) => ok(await unstage(paths)));

  handle<[readonly string[]], true>(IPC.GIT_DISCARD, async (paths) => ok(await discard(paths)));

  handle<[string, boolean], true>(IPC.GIT_APPLY_PATCH, async (patch, reverse) =>
    ok(await applyPatch(patch, reverse === true)),
  );

  handle<[GitCommitRequest], GitLogEntry>(IPC.GIT_COMMIT, async (request) =>
    ok(await commit(request)),
  );

  handle<[number], readonly GitLogEntry[]>(IPC.GIT_LOG, async (limit) => ok(await log(limit)));

  handle<[GitDiffRequest], GitDiffPair>(IPC.GIT_DIFF, async (request) => ok(await diff(request)));
}
