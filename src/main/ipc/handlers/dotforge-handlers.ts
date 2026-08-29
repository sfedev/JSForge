/** Manejadores IPC del motor DotForge, el toolchain y el gestor de procesos. */

import {
  IPC,
  ok,
  type DotForgeConfig,
  type Blueprint,
  type DotForgeManifest,
  type EnvFileView,
  type GenerateRequest,
  type GenerateResult,
  type ProcessInfo,
  type ProjectManifest,
  type ScriptEntry,
  type StartProcessRequest,
  type ToolchainInfo,
} from '../../../shared/contracts.js';
import {
  readManifest,
  syncManifest,
  writeManifest,
} from '../../services/dotforge/config-service.js';
import { generate, listBlueprints } from '../../services/dotforge/generator/index.js';
import { DOTFORGE_JSON_SCHEMA } from '../../services/dotforge/schema.js';
import {
  clearProcess,
  listProcesses,
  restartProcess,
  runPipeline,
  startProcess,
  stopProcess,
} from '../../services/process/process-manager.js';
import { readEnvironmentView, revealVariable } from '../../services/process/env-service.js';
import { detectToolchain } from '../../services/toolchain/package-manager.js';
import {
  readProjectManifest,
  readScripts,
} from '../../services/toolchain/project-parsers.js';
import { runScaffoldHooks } from '../../services/plugins/plugin-service.js';
import { handle } from '../registry.js';

export function registerDotForgeHandlers(): void {
  /* ---------------------------------------------------------------------- */
  /*  DotForge                                                              */
  /* ---------------------------------------------------------------------- */

  handle<[], DotForgeManifest>(IPC.DOTFORGE_READ_CONFIG, async () => ok(await readManifest(true)));

  handle<[DotForgeConfig], DotForgeManifest>(IPC.DOTFORGE_WRITE_CONFIG, async (config) =>
    ok(await writeManifest(config)),
  );

  handle<[], DotForgeManifest>(IPC.DOTFORGE_SYNC, async () => ok(await syncManifest()));

  handle<[], unknown>(IPC.DOTFORGE_SCHEMA, () => ok(DOTFORGE_JSON_SCHEMA));

  handle<[], readonly Blueprint[]>(IPC.DOTFORGE_BLUEPRINTS, () => ok(listBlueprints()));

  handle<[GenerateRequest], GenerateResult>(IPC.DOTFORGE_GENERATE, async (request) => {
    const result = await generate(request);
    // Los ganchos corren despues de escribir, y solo si se escribio: un
    // ensayo en seco no debe lanzar procesos.
    if (!result.dryRun) {
      await runScaffoldHooks(request.blueprintId);
    }
    return ok(result);
  });

  handle<[string], readonly ProcessInfo[]>(IPC.DOTFORGE_PIPELINE_RUN, async (pipelineId) =>
    ok(await runPipeline(pipelineId)),
  );

  /* ---------------------------------------------------------------------- */
  /*  Toolchain                                                             */
  /* ---------------------------------------------------------------------- */

  handle<[], ToolchainInfo>(IPC.TOOLCHAIN_DETECT, async () => {
    const manifest = await readManifest();
    return ok(await detectToolchain(manifest.config.packageManager));
  });

  handle<[], ProjectManifest>(IPC.TOOLCHAIN_MANIFEST, async () => ok(await readProjectManifest()));

  handle<[], readonly ScriptEntry[]>(IPC.TOOLCHAIN_SCRIPTS, async () => ok(await readScripts()));

  /* ---------------------------------------------------------------------- */
  /*  Procesos                                                              */
  /* ---------------------------------------------------------------------- */

  handle<[StartProcessRequest], ProcessInfo>(IPC.PROCESS_START, async (request) =>
    ok(await startProcess(request)),
  );

  handle<[string], true>(IPC.PROCESS_STOP, async (id) => ok(await stopProcess(id)));

  handle<[string], ProcessInfo>(IPC.PROCESS_RESTART, async (id) => ok(await restartProcess(id)));

  handle<[], readonly ProcessInfo[]>(IPC.PROCESS_LIST, () => ok(listProcesses()));

  handle<[string], true>(IPC.PROCESS_CLEAR, (id) => ok(clearProcess(id)));

  handle<[string | null], readonly EnvFileView[]>(IPC.PROCESS_ENV_READ, async (environment) =>
    ok(await readEnvironmentView(environment)),
  );

  handle<[string, string], string>(IPC.PROCESS_ENV_REVEAL, async (file, key) =>
    ok(await revealVariable(file, key)),
  );
}
