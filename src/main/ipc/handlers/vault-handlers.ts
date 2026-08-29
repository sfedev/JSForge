/** Manejadores IPC de Forge Vault: entorno y secretos cifrados. */

import {
  IPC,
  ok,
  type VaultView,
  type VaultWriteRequest,
} from '../../../shared/contracts.js';
import {
  promoteToVault,
  readVault,
  removeSecret,
  revealValue,
  storeSecret,
  syncExample,
  vaultSecrets,
  writeVault,
} from '../../services/vault/vault-service.js';
import { handle } from '../registry.js';

export function registerVaultHandlers(): void {
  handle<[], VaultView>(IPC.VAULT_READ, async () => ok(await readVault()));

  handle<[VaultWriteRequest], VaultView>(IPC.VAULT_WRITE, async (request) =>
    ok(await writeVault(request)),
  );

  // Revela UN valor concreto: es la unica via por la que un secreto cruza
  // la frontera IPC, y siempre a peticion explicita del usuario.
  handle<[string, string], string>(IPC.VAULT_REVEAL, async (file, key) =>
    ok(await revealValue(file, key)),
  );

  handle<[], readonly string[]>(IPC.VAULT_SECRETS, () => ok(vaultSecrets()));

  handle<[string, string], true>(IPC.VAULT_SET_SECRET, (key, value) =>
    ok(storeSecret(key, value)),
  );

  handle<[string], true>(IPC.VAULT_DELETE_SECRET, (key) => ok(removeSecret(key)));

  handle<[string, string], VaultView>(IPC.VAULT_PROMOTE, async (file, key) =>
    ok(await promoteToVault(file, key)),
  );

  handle<[], VaultView>(IPC.VAULT_SYNC_EXAMPLE, async () => ok(await syncExample()));

  // Descifrar un secreto del almacen NO tiene canal: el renderer solo puede
  // saber que claves existen. Los valores los inyecta `resolveProcessEnv`
  // directamente en el entorno del proceso hijo, sin pasar por la interfaz.
}
