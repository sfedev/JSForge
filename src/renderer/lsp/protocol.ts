/**
 * Conversiones entre el protocolo LSP y los tipos de Monaco.
 *
 * Dos detalles que suelen salir mal y aqui se tratan explicitamente:
 *  - LSP usa posiciones de base 0 y Monaco de base 1.
 *  - El editor identifica los documentos con `forge://workspace/<ruta>`,
 *    pero el servidor de lenguaje espera `file:///<ruta absoluta>`. La
 *    traduccion vive solo en este modulo.
 */

import type * as MonacoNs from 'monaco-editor';

import { store } from '../core/store.js';

/* -------------------------------------------------------------------------- */
/*  URI                                                                        */
/* -------------------------------------------------------------------------- */

/** Convierte una ruta relativa del workspace en URI `file://` absoluta. */
export function toFileUri(relativePath: string): string {
  const root = store.state.workspace?.root ?? '';
  const separator = root.includes('\\') ? '\\' : '/';
  const absolute = root === '' ? relativePath : `${root}${separator}${relativePath.split('/').join(separator)}`;

  // Normaliza a la forma que espera `file://`: barras hacia delante y, en
  // Windows, una barra extra antes de la letra de unidad.
  const normalized = absolute.split('\\').join('/');
  const withLeadingSlash = /^[a-zA-Z]:/.test(normalized) ? `/${normalized}` : normalized;
  return `file://${withLeadingSlash
    .split('/')
    .map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment)))
    .join('/')}`;
}

/** Convierte una URI `file://` del servidor en ruta relativa al workspace. */
export function fromFileUri(uri: string): string | null {
  if (!uri.startsWith('file://')) {
    return null;
  }
  let decoded = decodeURIComponent(uri.slice('file://'.length));
  if (/^\/[a-zA-Z]:/.test(decoded)) {
    decoded = decoded.slice(1);
  }
  const root = store.state.workspace?.root ?? '';
  if (root === '') {
    return decoded;
  }
  const normalizedRoot = root.split('\\').join('/');
  const normalized = decoded.split('\\').join('/');

  // Comparacion insensible a mayusculas en Windows, sensible en el resto.
  const sameCase =
    navigator.platform.toLowerCase().includes('win')
      ? normalized.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)
      : normalized.startsWith(`${normalizedRoot}/`);

  return sameCase ? normalized.slice(normalizedRoot.length + 1) : null;
}

/* -------------------------------------------------------------------------- */
/*  Posiciones y rangos                                                        */
/* -------------------------------------------------------------------------- */

export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

export function toLspPosition(position: MonacoNs.IPosition): LspPosition {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

export function toMonacoRange(range: LspRange): MonacoNs.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

export function toLspRange(range: MonacoNs.IRange): LspRange {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  };
}

/* -------------------------------------------------------------------------- */
/*  Diagnosticos                                                               */
/* -------------------------------------------------------------------------- */

export interface LspDiagnostic {
  readonly range: LspRange;
  readonly severity?: 1 | 2 | 3 | 4;
  readonly code?: string | number;
  readonly source?: string;
  readonly message: string;
  readonly tags?: readonly number[];
}

/** LSP: 1 error, 2 aviso, 3 informacion, 4 sugerencia. */
export function toMonacoSeverity(
  monaco: typeof MonacoNs,
  severity: number | undefined,
): MonacoNs.MarkerSeverity {
  switch (severity) {
    case 1:
      return monaco.MarkerSeverity.Error;
    case 2:
      return monaco.MarkerSeverity.Warning;
    case 3:
      return monaco.MarkerSeverity.Info;
    case 4:
      return monaco.MarkerSeverity.Hint;
    default:
      return monaco.MarkerSeverity.Error;
  }
}

export function toMarker(
  monaco: typeof MonacoNs,
  diagnostic: LspDiagnostic,
): MonacoNs.editor.IMarkerData {
  const range = toMonacoRange(diagnostic.range);
  return {
    ...range,
    severity: toMonacoSeverity(monaco, diagnostic.severity),
    message: diagnostic.message,
    ...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
    ...(diagnostic.code === undefined ? {} : { code: String(diagnostic.code) }),
    // 1 = innecesario, 2 = obsoleto.
    ...(diagnostic.tags?.includes(1) === true
      ? { tags: [monaco.MarkerTag.Unnecessary] }
      : diagnostic.tags?.includes(2) === true
        ? { tags: [monaco.MarkerTag.Deprecated] }
        : {}),
  };
}

/* -------------------------------------------------------------------------- */
/*  Autocompletado                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Los tipos de LSP (1..25) y los de Monaco no coinciden en orden, asi que la
 * tabla es explicita en lugar de una resta de indices.
 */
export function toCompletionKind(
  monaco: typeof MonacoNs,
  kind: number | undefined,
): MonacoNs.languages.CompletionItemKind {
  const k = monaco.languages.CompletionItemKind;
  const table: Record<number, MonacoNs.languages.CompletionItemKind> = {
    1: k.Text,
    2: k.Method,
    3: k.Function,
    4: k.Constructor,
    5: k.Field,
    6: k.Variable,
    7: k.Class,
    8: k.Interface,
    9: k.Module,
    10: k.Property,
    11: k.Unit,
    12: k.Value,
    13: k.Enum,
    14: k.Keyword,
    15: k.Snippet,
    16: k.Color,
    17: k.File,
    18: k.Reference,
    19: k.Folder,
    20: k.EnumMember,
    21: k.Constant,
    22: k.Struct,
    23: k.Event,
    24: k.Operator,
    25: k.TypeParameter,
  };
  return kind === undefined ? k.Text : (table[kind] ?? k.Text);
}

export function toSymbolKind(
  monaco: typeof MonacoNs,
  kind: number | undefined,
): MonacoNs.languages.SymbolKind {
  const k = monaco.languages.SymbolKind;
  const table: Record<number, MonacoNs.languages.SymbolKind> = {
    1: k.File,
    2: k.Module,
    3: k.Namespace,
    4: k.Package,
    5: k.Class,
    6: k.Method,
    7: k.Property,
    8: k.Field,
    9: k.Constructor,
    10: k.Enum,
    11: k.Interface,
    12: k.Function,
    13: k.Variable,
    14: k.Constant,
    15: k.String,
    16: k.Number,
    17: k.Boolean,
    18: k.Array,
    19: k.Object,
    20: k.Key,
    21: k.Null,
    22: k.EnumMember,
    23: k.Struct,
    24: k.Event,
    25: k.Operator,
    26: k.TypeParameter,
  };
  return kind === undefined ? k.Variable : (table[kind] ?? k.Variable);
}

/** Normaliza el contenido de un hover o de una documentacion. */
export function toMarkdown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toMarkdown(entry)).filter((entry) => entry !== '').join('\n\n');
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as { value?: unknown; language?: unknown; kind?: unknown };
    if (typeof record.value === 'string') {
      // `MarkedString` con lenguaje: se envuelve en un bloque de codigo.
      return typeof record.language === 'string' && record.language !== ''
        ? `\`\`\`${record.language}\n${record.value}\n\`\`\``
        : record.value;
    }
  }
  return '';
}
