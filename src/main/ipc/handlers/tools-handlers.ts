/** Manejadores IPC de HTTP, Docker, esquemas, metricas y actualizaciones. */

import {
  IPC,
  ok,
  type ComposeFileView,
  type ContainerInfo,
  type DbSchemaView,
  type HttpEndpointLens,
  type HttpRequestSpec,
  type HttpResponseView,
  type MetricsSnapshot,
  type UpdateChannel,
  type UpdaterState,
} from '../../../shared/contracts.js';
import { inspectSchema } from '../../services/db/schema-inspector.js';
import { readCompose } from '../../services/docker/compose-parser.js';
import {
  composeDown,
  composeUp,
  isDockerAvailable,
  listContainers,
} from '../../services/docker/docker-service.js';
import { cancelRequest, sendRequest } from '../../services/http/http-client.js';
import { detectEndpoints, parseHttpFile } from '../../services/http/http-file-parser.js';
import { setSubscription, takeSnapshot } from '../../services/metrics/metrics-service.js';
import {
  checkForUpdates,
  currentState,
  downloadUpdate,
  installUpdate,
  setChannel,
} from '../../services/updater/updater-service.js';
import { handle } from '../registry.js';

export function registerToolsHandlers(): void {
  /* ---------------------------------------------------------------------- */
  /*  Cliente HTTP                                                          */
  /* ---------------------------------------------------------------------- */

  handle<[HttpRequestSpec], HttpResponseView>(IPC.HTTP_SEND, async (request) =>
    ok(await sendRequest(request)),
  );

  handle<[string], true>(IPC.HTTP_CANCEL, (id) => ok(cancelRequest(id)));

  handle<[string], readonly HttpRequestSpec[]>(IPC.HTTP_PARSE, (content) =>
    ok(parseHttpFile(content)),
  );

  handle<[string, string], readonly HttpEndpointLens[]>(
    IPC.HTTP_ENDPOINTS,
    (relativePath, content) => ok(detectEndpoints(relativePath, content)),
  );

  /* ---------------------------------------------------------------------- */
  /*  Docker                                                                */
  /* ---------------------------------------------------------------------- */

  handle<[], boolean>(IPC.DOCKER_AVAILABLE, async () => ok(await isDockerAvailable()));

  handle<[string], ComposeFileView>(IPC.DOCKER_COMPOSE_PARSE, async (relativePath) =>
    ok(await readCompose(relativePath)),
  );

  handle<[string, readonly string[]], true>(IPC.DOCKER_COMPOSE_UP, async (file, services) =>
    ok(await composeUp(file, services)),
  );

  handle<[string, readonly string[]], true>(IPC.DOCKER_COMPOSE_DOWN, async (file, services) =>
    ok(await composeDown(file, services)),
  );

  handle<[], readonly ContainerInfo[]>(IPC.DOCKER_PS, async () => ok(await listContainers()));

  /* ---------------------------------------------------------------------- */
  /*  Esquema de datos                                                      */
  /* ---------------------------------------------------------------------- */

  handle<[], DbSchemaView | null>(IPC.DB_SCHEMA, async () => ok(await inspectSchema()));

  /* ---------------------------------------------------------------------- */
  /*  Metricas                                                              */
  /* ---------------------------------------------------------------------- */

  handle<[], MetricsSnapshot>(IPC.METRICS_SNAPSHOT, async () => ok(await takeSnapshot()));

  handle<[boolean], true>(IPC.METRICS_SUBSCRIBE, (enabled) => ok(setSubscription(enabled === true)));

  /* ---------------------------------------------------------------------- */
  /*  Actualizaciones                                                       */
  /* ---------------------------------------------------------------------- */

  handle<[], UpdaterState>(IPC.UPDATER_STATE, () => ok(currentState()));

  handle<[], UpdaterState>(IPC.UPDATER_CHECK, async () => ok(await checkForUpdates()));

  handle<[], true>(IPC.UPDATER_DOWNLOAD, async () => ok(await downloadUpdate()));

  handle<[boolean], true>(IPC.UPDATER_INSTALL, (restartNow) => ok(installUpdate(restartNow === true)));

  handle<[UpdateChannel], UpdaterState>(IPC.UPDATER_SET_CHANNEL, (channel) => ok(setChannel(channel)));
}
