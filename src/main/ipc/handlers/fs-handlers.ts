/** Manejadores IPC del sistema de archivos. Todos pasan por el guardian. */

import {
  IPC,
  ok,
  type DirEntry,
  type FileStat,
  type ReadFileResult,
  type SearchRequest,
  type SearchResult,
  type WriteFileRequest,
} from '../../../shared/contracts.js';
import {
  createDirectory,
  createFile,
  findFilesByName,
  readDirectory,
  readFile,
  removePath,
  renamePath,
  search,
  statPath,
  writeFile,
} from '../../services/fs-service.js';
import { handle } from '../registry.js';

export function registerFsHandlers(): void {
  handle<[string], readonly DirEntry[]>(IPC.FS_READ_DIR, async (relativePath) =>
    ok(await readDirectory(relativePath)),
  );

  handle<[string], ReadFileResult>(IPC.FS_READ_FILE, async (relativePath) =>
    ok(await readFile(relativePath)),
  );

  handle<[WriteFileRequest], FileStat>(IPC.FS_WRITE_FILE, async (request) =>
    ok(await writeFile(request)),
  );

  handle<[string, string], FileStat>(IPC.FS_CREATE_FILE, async (relativePath, content) =>
    ok(await createFile(relativePath, content ?? '')),
  );

  handle<[string], FileStat>(IPC.FS_CREATE_DIR, async (relativePath) =>
    ok(await createDirectory(relativePath)),
  );

  handle<[string, string], FileStat>(IPC.FS_RENAME, async (from, to) =>
    ok(await renamePath(from, to)),
  );

  handle<[string], true>(IPC.FS_DELETE, async (relativePath) => ok(await removePath(relativePath)));

  handle<[string], FileStat>(IPC.FS_STAT, async (relativePath) => ok(await statPath(relativePath)));

  handle<[SearchRequest], SearchResult>(IPC.FS_SEARCH, async (request) => ok(await search(request)));

  handle<[string, number], readonly string[]>(IPC.FS_FIND_FILES, async (query, limit) =>
    ok(await findFilesByName(query, limit)),
  );
}
