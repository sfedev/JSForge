/** Manejadores IPC del visor de OpenAPI y del auditor de contratos. */

import {
  IPC,
  ok,
  type ContractAuditReport,
  type OpenApiDocumentView,
  type SpecGenerateRequest,
  type SpecGenerateResult,
} from '../../../shared/contracts.js';
import {
  auditContract,
  auditTargets,
  discoverSpecs,
  generateFromSpec,
  readSpec,
} from '../../services/spec/spec-service.js';
import { handle } from '../registry.js';

export function registerSpecHandlers(): void {
  handle<[], readonly string[]>(IPC.SPEC_DISCOVER, async () => ok(await discoverSpecs()));

  handle<[string], OpenApiDocumentView>(IPC.SPEC_PARSE, async (relativePath) =>
    ok(await readSpec(relativePath)),
  );

  handle<[SpecGenerateRequest], SpecGenerateResult>(IPC.SPEC_GENERATE, async (request) =>
    ok(await generateFromSpec(request)),
  );

  handle<[], readonly string[]>(IPC.SPEC_AUDIT_TARGETS, async () => ok(await auditTargets()));

  handle<[string, string | null], ContractAuditReport>(
    IPC.SPEC_AUDIT,
    async (relativePath, revision) =>
      ok(await auditContract(relativePath, revision ?? 'HEAD')),
  );
}
