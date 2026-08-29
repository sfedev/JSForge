/**
 * Puntos de interrupcion en el margen de Monaco.
 *
 * Monaco no trae puntos de interrupcion: solo ofrece un margen de simbolos
 * (`glyphMargin`) y decoraciones. Este modulo construye el resto:
 *
 *  - Un clic en el margen alterna el punto de la linea.
 *  - Las decoraciones se recalculan a partir del store, nunca al reves, de
 *    modo que cambiar de pestana o reabrir un archivo restituye los puntos
 *    sin trabajo extra.
 *  - Al editar el archivo, Monaco desplaza las decoraciones solas; se leen
 *    de vuelta para que un punto marcado en la linea 10 siga en su sitio
 *    despues de insertar cinco lineas por encima.
 *
 * El renderer es el dueno de los puntos. La sesion de depuracion solo los
 * confirma: un punto sin sesion es igual de valido, y se empuja al motor en
 * cuanto hay a quien empujarlo.
 */

import type * as MonacoNs from 'monaco-editor';

import type { BreakpointState } from '../../shared/contracts.js';
import {
  breakpointsFor,
  setBreakpointsFor,
  store,
  toggleBreakpoint,
} from '../core/store.js';

/** Clase CSS del simbolo en el margen; los estilos viven en la hoja del shell. */
const GLYPH_CLASS = 'forge-breakpoint';
const GLYPH_UNVERIFIED_CLASS = 'forge-breakpoint forge-breakpoint--unverified';
const CURRENT_LINE_CLASS = 'forge-debug-current-line';

let monaco: typeof MonacoNs;
let editor: MonacoNs.editor.IStandaloneCodeEditor | null = null;

/** Colecciones de decoraciones vivas, por ruta del documento. */
const collections = new Map<string, MonacoNs.editor.IEditorDecorationsCollection>();

/** Decoracion de la linea detenida; es una sola en todo el editor. */
let currentLine: MonacoNs.editor.IEditorDecorationsCollection | null = null;

/** Notifica al resto del IDE que el juego de puntos de un archivo cambio. */
type BreakpointSink = (path: string, points: readonly BreakpointState[]) => void;

let sink: BreakpointSink = () => undefined;

export function onBreakpointsChanged(listener: BreakpointSink): void {
  sink = listener;
}

/**
 * Propaga un cambio hecho fuera del margen (el atajo de teclado, por
 * ejemplo). El store ya esta actualizado; esto solo avisa a quien sincroniza
 * con el motor.
 */
export function notifyBreakpointToggle(path: string, points: readonly BreakpointState[]): void {
  sink(path, points);
}

/**
 * Conecta el margen al editor. Se llama una vez, tras crear Monaco.
 */
export function mountBreakpoints(
  monacoNs: typeof MonacoNs,
  instance: MonacoNs.editor.IStandaloneCodeEditor,
): void {
  monaco = monacoNs;
  editor = instance;

  editor.updateOptions({ glyphMargin: true });

  editor.onMouseDown((event) => {
    if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
      return;
    }
    const line = event.target.position?.lineNumber;
    const path = activeFilePath();
    if (line === undefined || path === null) {
      return;
    }
    // El navegador no debe empezar una seleccion al pinchar el margen.
    event.event.preventDefault();
    const points = toggleBreakpoint(path, line);
    sink(path, points);
  });

  // Al reescribir el documento, Monaco mueve las decoraciones; hay que leer
  // las posiciones de vuelta o el store se desincroniza del margen.
  editor.onDidChangeModelContent(() => syncFromDecorations());

  store.subscribe(['breakpoints', 'activeDocument'], () => render());
  render();
}

function activeFilePath(): string | null {
  const active = store.state.activeDocument;
  if (active === null) {
    return null;
  }
  // Las pestanas de diferencias y de HTTP no admiten puntos: sus modelos no
  // corresponden a un archivo que el motor pueda cargar.
  const document = store.state.documents.find((entry) => entry.path === active);
  return document?.kind === 'file' ? active : null;
}

/** Repinta el margen del documento activo desde el store. */
export function render(): void {
  const path = activeFilePath();
  if (editor === null || path === null) {
    return;
  }
  const model = editor.getModel();
  if (model === null) {
    return;
  }

  const points = breakpointsFor(path);
  const decorations: MonacoNs.editor.IModelDeltaDecoration[] = points.map((point) => ({
    range: new monaco.Range(point.line, 1, point.line, 1),
    options: {
      // `stickiness` hace que el punto siga a su linea al editar por encima.
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      glyphMarginClassName: point.verified ? GLYPH_CLASS : GLYPH_UNVERIFIED_CLASS,
      glyphMarginHoverMessage: {
        value: point.verified
          ? `Punto de interrupcion en la linea ${point.line}.`
          : `Punto sin verificar en la linea ${point.line}: no hay sesion o el motor no lo acepto.`,
      },
    },
  }));

  let collection = collections.get(path);
  if (collection === undefined) {
    collection = editor.createDecorationsCollection(decorations);
    collections.set(path, collection);
  } else {
    collection.set(decorations);
  }
}

/**
 * Relee las lineas reales de las decoraciones y actualiza el store si
 * cambiaron. Sin esto, editar el archivo desplaza el simbolo en pantalla
 * pero deja al motor apuntando a la linea antigua.
 */
function syncFromDecorations(): void {
  const path = activeFilePath();
  const collection = path === null ? undefined : collections.get(path);
  if (path === null || collection === undefined) {
    return;
  }
  const previous = breakpointsFor(path);
  if (previous.length === 0) {
    return;
  }

  const lines: number[] = [];
  for (let index = 0; index < collection.length; index += 1) {
    const range = collection.getRange(index);
    if (range !== null) {
      lines.push(range.startLineNumber);
    }
  }
  // Una linea borrada colapsa dos puntos en la misma: se deduplica.
  const unique = [...new Set(lines)].sort((a, b) => a - b);
  const unchanged =
    unique.length === previous.length && unique.every((line, index) => previous[index]?.line === line);
  if (unchanged) {
    return;
  }

  const next: BreakpointState[] = unique.map((line) => {
    const original = previous.find((point) => point.line === line);
    return {
      path,
      line,
      // Al moverse deja de estar verificado hasta que el motor lo confirme.
      verified: original?.verified ?? false,
      ...(original?.condition === undefined ? {} : { condition: original.condition }),
    };
  });
  setBreakpointsFor(path, next);
  sink(path, next);
}

/* -------------------------------------------------------------------------- */
/*  Linea detenida                                                             */
/* -------------------------------------------------------------------------- */

/** Resalta la linea donde se detuvo la ejecucion y la lleva a la vista. */
export function showStoppedLine(relativePath: string, line: number): void {
  if (editor === null) {
    return;
  }
  if (activeFilePath() !== relativePath) {
    return;
  }
  clearStoppedLine();
  currentLine = editor.createDecorationsCollection([
    {
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: CURRENT_LINE_CLASS,
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    },
  ]);
  editor.revealLineInCenterIfOutsideViewport(line);
}

export function clearStoppedLine(): void {
  currentLine?.clear();
  currentLine = null;
}

/** Libera las decoraciones de un documento cerrado. */
export function disposeBreakpointsFor(path: string): void {
  collections.get(path)?.clear();
  collections.delete(path);
}
