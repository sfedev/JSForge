/** Manejadores IPC del ejecutor de pruebas y de la cobertura. */

import {
  IPC,
  ok,
  type CoverageReport,
  type TestBlock,
  type TestRunRequest,
  type TestRunSummary,
  type TestRunnerId,
} from '../../../shared/contracts.js';
import {
  availableRunners,
  blocksFromSource,
  cancelRun,
  discoverTestFiles,
  lastRunSummary,
  readCoverage,
  runTests,
  testBlocks,
} from '../../services/testing/test-service.js';
import { handle } from '../registry.js';

export function registerTestHandlers(): void {
  handle<[], readonly string[]>(IPC.TEST_DISCOVER, async () => ok(await discoverTestFiles()));

  handle<[string, string | null], readonly TestBlock[]>(
    IPC.TEST_BLOCKS,
    async (relativePath, content) =>
      // Con contenido se analiza lo que el editor tiene sin guardar; sin el,
      // lo que hay en disco.
      ok(
        content === null || content === undefined
          ? await testBlocks(relativePath)
          : blocksFromSource(relativePath, content),
      ),
  );

  handle<[], readonly TestRunnerId[]>(IPC.TEST_RUNNERS, async () => ok(await availableRunners()));

  handle<[TestRunRequest], TestRunSummary>(IPC.TEST_RUN, async (request) =>
    ok(await runTests(request)),
  );

  handle<[string], true>(IPC.TEST_CANCEL, (runId) => ok(cancelRun(runId)));

  handle<[], TestRunSummary | null>(IPC.TEST_LAST_RUN, () => ok(lastRunSummary()));

  handle<[], CoverageReport | null>(IPC.TEST_COVERAGE, async () => ok(await readCoverage()));
}
