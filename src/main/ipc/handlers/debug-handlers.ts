/** Manejadores IPC de la depuracion CDP y el perfilado de memoria. */

import {
  IPC,
  ok,
  type BreakpointState,
  type DebugAttachRequest,
  type DebugEvaluateRequest,
  type DebugEvaluateResult,
  type DebugScopeView,
  type DebugSessionInfo,
  type DebugStepKind,
  type DebugTarget,
  type DebugVariableView,
  type HeapTrend,
  type SourceBreakpoint,
} from '../../../shared/contracts.js';
import {
  attach,
  collectGarbage,
  detach,
  discover,
  evaluate,
  heapTrend,
  listSessions,
  pause,
  properties,
  resume,
  scopes,
  setBreakpoints,
  setHeapSubscription,
  step,
} from '../../debugger/debug-session.js';
import { handle } from '../registry.js';

export function registerDebugHandlers(): void {
  handle<[DebugAttachRequest], DebugSessionInfo>(IPC.DEBUG_ATTACH, async (request) =>
    ok(await attach(request)),
  );

  handle<[string], true>(IPC.DEBUG_DETACH, async (sessionId) => ok(await detach(sessionId)));

  handle<[], readonly DebugSessionInfo[]>(IPC.DEBUG_SESSIONS, () => ok(listSessions()));

  handle<[string, number], readonly DebugTarget[]>(
    IPC.DEBUG_DISCOVER,
    async (host, port) => ok(await discover(host, port)),
  );

  handle<[string, string, readonly SourceBreakpoint[]], readonly BreakpointState[]>(
    IPC.DEBUG_SET_BREAKPOINTS,
    async (sessionId, relativePath, points) =>
      ok(await setBreakpoints(sessionId, relativePath, points ?? [])),
  );

  handle<[string], true>(IPC.DEBUG_RESUME, async (sessionId) => ok(await resume(sessionId)));

  handle<[string], true>(IPC.DEBUG_PAUSE, async (sessionId) => ok(await pause(sessionId)));

  handle<[string, DebugStepKind], true>(IPC.DEBUG_STEP, async (sessionId, kind) =>
    ok(await step(sessionId, kind)),
  );

  handle<[DebugEvaluateRequest], DebugEvaluateResult>(IPC.DEBUG_EVALUATE, async (request) =>
    ok(await evaluate(request.sessionId, request.expression, request.callFrameId)),
  );

  handle<[string, string], readonly DebugScopeView[]>(
    IPC.DEBUG_SCOPES,
    async (sessionId, frameId) => ok(await scopes(sessionId, frameId)),
  );

  handle<[string, string], readonly DebugVariableView[]>(
    IPC.DEBUG_PROPERTIES,
    async (sessionId, objectId) => ok(await properties(sessionId, objectId)),
  );

  handle<[string, boolean], true>(IPC.DEBUG_HEAP_SUBSCRIBE, (sessionId, enabled) =>
    ok(setHeapSubscription(sessionId, enabled === true)),
  );

  handle<[string], HeapTrend>(IPC.DEBUG_HEAP_TREND, (sessionId) => ok(heapTrend(sessionId)));

  handle<[string], true>(IPC.DEBUG_COLLECT_GARBAGE, async (sessionId) =>
    ok(await collectGarbage(sessionId)),
  );
}
