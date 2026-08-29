/**
 * Code lens de pruebas y resaltado de cobertura en Monaco.
 *
 * Dos cosas distintas que comparten origen:
 *
 *  - Sobre cada `describe`/`it` aparece un lens con el resultado de la
 *    ultima ejecucion y las acciones «Ejecutar» y «Depurar».
 *  - El margen del editor pinta que lineas cubrio la ultima suite.
 *
 * El proveedor se registra una sola vez para todos los lenguajes de prueba.
 * Monaco lo consulta cuando le conviene, asi que el analisis del archivo se
 * memoriza por version del modelo: sin eso, cada pulsacion de tecla
 * dispararia un viaje al proceso principal.
 */

import type * as MonacoNs from 'monaco-editor';

import type {
  CoverageReport,
  TestBlock,
  TestCaseResult,
  TestRunSummary,
} from '../../shared/contracts.js';
import { store } from '../core/store.js';
import { runCommand } from '../core/commands.js';

const COVERED_CLASS = 'forge-covered';
const UNCOVERED_CLASS = 'forge-uncovered';

/** Lenguajes donde tiene sentido buscar pruebas. */
const LANGUAGES = ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'];

let monaco: typeof MonacoNs;
let editor: MonacoNs.editor.IStandaloneCodeEditor | null = null;

/** Analisis memorizado por URI, con la version del modelo que lo produjo. */
const cache = new Map<string, { version: number; blocks: readonly TestBlock[] }>();

/** Resultado de la ultima ejecucion, indexado por nombre completo. */
let resultsByName = new Map<string, TestCaseResult>();

let coverageDecorations: MonacoNs.editor.IEditorDecorationsCollection | null = null;

/** Monaco pide refrescar los lens cuando esto emite. */
let refreshLenses: (() => void) | null = null;

/* -------------------------------------------------------------------------- */
/*  Estado                                                                     */
/* -------------------------------------------------------------------------- */

/** Reindexa los resultados y pide a Monaco que repinte los lens. */
export function applyTestResults(summary: TestRunSummary): void {
  const index = new Map<string, TestCaseResult>();
  for (const file of summary.files) {
    for (const testCase of file.cases) {
      // Se indexa por ruta y por nombre completo: dos archivos pueden tener
      // pruebas con el mismo nombre.
      index.set(`${file.path}::${testCase.fullName}`, testCase);
      // Los runners no siempre componen el nombre igual que el analizador
      // (uno usa " > " y otro un espacio), asi que se guarda tambien el
      // nombre a secas como respaldo.
      index.set(`${file.path}::${testCase.name}`, testCase);
    }
  }
  resultsByName = index;
  refreshLenses?.();
}

export function clearTestResults(): void {
  resultsByName = new Map();
  refreshLenses?.();
}

/* -------------------------------------------------------------------------- */
/*  Cobertura                                                                  */
/* -------------------------------------------------------------------------- */

/** Repinta el margen de cobertura del documento activo. */
export function renderCoverage(): void {
  if (editor === null) {
    return;
  }
  coverageDecorations?.clear();
  coverageDecorations = null;

  const state = store.state;
  const active = state.activeDocument;
  const report = state.coverage;
  if (!state.coverageVisible || active === null || report === null) {
    return;
  }

  const file = report.files.find((entry) => entry.path === active);
  if (file === undefined) {
    return;
  }

  const decorations: MonacoNs.editor.IModelDeltaDecoration[] = [];
  for (const line of file.coveredLines) {
    decorations.push(lineDecoration(line, COVERED_CLASS, 'Linea cubierta por las pruebas.'));
  }
  for (const line of file.uncoveredLines) {
    decorations.push(
      lineDecoration(line, UNCOVERED_CLASS, 'Linea que ninguna prueba ejecuto.'),
    );
  }
  coverageDecorations = editor.createDecorationsCollection(decorations);
}

function lineDecoration(
  line: number,
  className: string,
  hover: string,
): MonacoNs.editor.IModelDeltaDecoration {
  return {
    range: new monaco.Range(line, 1, line, 1),
    options: {
      isWholeLine: true,
      // Va en el margen del numero de linea, no sobre el codigo: teñir la
      // linea entera compite con el resaltado de sintaxis.
      linesDecorationsClassName: className,
      hoverMessage: { value: hover },
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  };
}

export function applyCoverage(report: CoverageReport): void {
  store.patch({ coverage: report, coverageVisible: true });
  renderCoverage();
}

/* -------------------------------------------------------------------------- */
/*  Proveedor de code lens                                                     */
/* -------------------------------------------------------------------------- */

/** Etiqueta del lens segun el resultado conocido de esa prueba. */
export function lensLabel(block: TestBlock, result: TestCaseResult | undefined): string {
  if (result === undefined) {
    return block.kind === 'suite' ? '▷ Ejecutar la suite' : '▷ Ejecutar';
  }
  switch (result.status) {
    case 'passed':
      return `✓ ${Math.round(result.durationMs)} ms`;
    case 'failed':
      return '✗ Fallo';
    case 'skipped':
      return '⊘ Omitida';
    default:
      return '▷ Ejecutar';
  }
}

function resultFor(block: TestBlock): TestCaseResult | undefined {
  return (
    resultsByName.get(`${block.path}::${block.fullName}`) ??
    resultsByName.get(`${block.path}::${block.name}`)
  );
}

/** Ruta relativa del documento a partir de la URI del modelo de Monaco. */
function pathOfModel(model: MonacoNs.editor.ITextModel): string | null {
  const uri = model.uri;
  // Los modelos de archivo son `forge://workspace/<ruta>`; el resto (diff,
  // http) no corresponde a un archivo que un runner pueda ejecutar.
  if (uri.scheme !== 'forge' || uri.authority !== 'workspace') {
    return null;
  }
  return uri.path.replace(/^\//, '');
}

export function mountTestLens(
  monacoNs: typeof MonacoNs,
  instance: MonacoNs.editor.IStandaloneCodeEditor,
): void {
  monaco = monacoNs;
  editor = instance;

  // `onDidChange` de un proveedor de code lens emite el propio proveedor,
  // no `void`: es asi como Monaco sabe a quien volver a preguntar.
  const emitter = new monaco.Emitter<MonacoNs.languages.CodeLensProvider>();

  const provider: MonacoNs.languages.CodeLensProvider = {
    onDidChange: emitter.event,

    provideCodeLenses: async (model) => {
      const path = pathOfModel(model);
      if (path === null || !/\.(test|spec)\.[cm]?[jt]sx?$/i.test(path)) {
        return { lenses: [], dispose: () => undefined };
      }

      const blocks = await blocksOf(model, path);
      const lenses: MonacoNs.languages.CodeLens[] = [];

      for (const block of flatten(blocks)) {
        const range = new monaco.Range(block.line, 1, block.line, 1);
        const result = resultFor(block);

        lenses.push({
          range,
          command: {
            id: 'forge.runTestBlock',
            title: lensLabel(block, result),
            arguments: [block],
          },
        });

        if (block.kind === 'case') {
          lenses.push({
            range,
            command: {
              id: 'forge.debugTestBlock',
              title: 'Depurar',
              arguments: [block],
            },
          });
        }
        // El mensaje de fallo se ofrece como tercer lens, para no obligar a
        // abrir el panel solo por ver que revento.
        if (result?.status === 'failed') {
          lenses.push({
            range,
            command: {
              id: 'forge.showTestFailure',
              title: 'Ver el fallo',
              arguments: [result],
            },
          });
        }
      }

      return { lenses, dispose: () => undefined };
    },
  };

  refreshLenses = () => emitter.fire(provider);

  for (const language of LANGUAGES) {
    monaco.languages.registerCodeLensProvider(language, provider);
  }

  // Los comandos que invocan los lens. Monaco los ejecuta por id, asi que
  // se registran en su propio registro y se delegan en el del IDE.
  monaco.editor.registerCommand('forge.runTestBlock', (_accessor, block: TestBlock) => {
    void runCommand('testing.runBlock', block);
  });
  monaco.editor.registerCommand('forge.debugTestBlock', (_accessor, block: TestBlock) => {
    void runCommand('testing.debugBlock', block);
  });
  monaco.editor.registerCommand('forge.showTestFailure', (_accessor, result: TestCaseResult) => {
    void runCommand('testing.showFailure', result);
  });

  store.subscribe(['coverage', 'coverageVisible', 'activeDocument'], renderCoverage);
}

/** Bloques del modelo, reanalizando solo si el texto cambio. */
async function blocksOf(
  model: MonacoNs.editor.ITextModel,
  path: string,
): Promise<readonly TestBlock[]> {
  const key = model.uri.toString();
  const version = model.getVersionId();
  const cached = cache.get(key);
  if (cached !== undefined && cached.version === version) {
    return cached.blocks;
  }

  // Se manda el contenido del editor, no la ruta: el archivo puede tener
  // cambios sin guardar y los lens deben seguirlos.
  const result = await window.forge.testing.blocks(path, model.getValue());
  const blocks = result.ok ? result.value : [];
  cache.set(key, { version, blocks });

  store.mutate(['testBlocks'], (state) => {
    state.testBlocks.set(path, [...blocks]);
  });
  return blocks;
}

function flatten(blocks: readonly TestBlock[]): readonly TestBlock[] {
  const out: TestBlock[] = [];
  const visit = (block: TestBlock): void => {
    out.push(block);
    for (const child of block.children) {
      visit(child);
    }
  };
  for (const block of blocks) {
    visit(block);
  }
  return out;
}

/** Olvida el analisis de un documento cerrado. */
export function disposeTestLensFor(uri: string): void {
  cache.delete(uri);
}
