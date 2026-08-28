/**
 * Arranque de Monaco.
 *
 * Monaco se carga desde el propio bundle: no hay AMD loader, ni CDN, ni
 * `eval`. Los workers se compilan como entradas separadas en
 * `dist/renderer/workers/` y se instancian con `new Worker(url)` sobre el
 * mismo origen `forge://app`, que es lo que permite mantener
 * `script-src 'self'` sin excepciones.
 */

import * as monaco from 'monaco-editor';

import type { ThemeId } from '../../shared/contracts.js';

const WORKER_BY_LABEL: Readonly<Record<string, string>> = {
  typescript: 'ts.worker.js',
  javascript: 'ts.worker.js',
  json: 'json.worker.js',
  css: 'css.worker.js',
  scss: 'css.worker.js',
  less: 'css.worker.js',
  html: 'html.worker.js',
  handlebars: 'html.worker.js',
  razor: 'html.worker.js',
};

let initialized = false;

export function setupMonaco(): typeof monaco {
  if (initialized) {
    return monaco;
  }
  initialized = true;

  // `monaco.Environment` se lee del objeto global; se asigna sin `declare
  // global` para no chocar con la declaracion que ya trae monaco-editor.
  const globalScope = self as unknown as { MonacoEnvironment?: monaco.Environment };
  globalScope.MonacoEnvironment = {
    getWorker(_moduleId: string, label: string): Worker {
      const file = WORKER_BY_LABEL[label] ?? 'editor.worker.js';
      return new Worker(new URL(`./workers/${file}`, window.location.href), {
        name: label,
        type: 'classic',
      });
    },
  };

  defineThemes();
  configureLanguages();
  return monaco;
}

/* -------------------------------------------------------------------------- */
/*  Temas                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Reglas de resaltado. Los colores se eligieron para mantener >= 4.5:1 sobre
 * el fondo del editor, de modo que el codigo siga siendo legible con el tema
 * oscuro por defecto.
 */
const DARK_RULES: monaco.editor.ITokenThemeRule[] = [
  { token: '', foreground: 'c8cee2' },
  { token: 'comment', foreground: '6b7490', fontStyle: 'italic' },
  { token: 'keyword', foreground: 'c3b2ff' },
  { token: 'keyword.control', foreground: 'c3b2ff' },
  { token: 'string', foreground: '9ad4a0' },
  { token: 'string.escape', foreground: 'e5c07b' },
  { token: 'number', foreground: 'f0a868' },
  { token: 'regexp', foreground: '7fd4c1' },
  { token: 'type', foreground: '7fc9f0' },
  { token: 'type.identifier', foreground: '7fc9f0' },
  { token: 'class', foreground: '7fc9f0' },
  { token: 'interface', foreground: '7fc9f0' },
  { token: 'function', foreground: 'e0b6ff' },
  { token: 'variable', foreground: 'c8cee2' },
  { token: 'variable.parameter', foreground: 'e2b48c' },
  { token: 'constant', foreground: 'f0a868' },
  { token: 'tag', foreground: 'ff8fa3' },
  { token: 'attribute.name', foreground: 'e0b6ff' },
  { token: 'attribute.value', foreground: '9ad4a0' },
  { token: 'delimiter', foreground: '8e97b3' },
  { token: 'operator', foreground: 'c3b2ff' },
  { token: 'namespace', foreground: '7fc9f0' },
  { token: 'invalid', foreground: 'ff6b6b', fontStyle: 'underline' },
];

const LIGHT_RULES: monaco.editor.ITokenThemeRule[] = [
  { token: '', foreground: '2c3040' },
  { token: 'comment', foreground: '6a7285', fontStyle: 'italic' },
  { token: 'keyword', foreground: '6a35f0' },
  { token: 'string', foreground: '1a7f37' },
  { token: 'number', foreground: 'b35309' },
  { token: 'regexp', foreground: '0d7a70' },
  { token: 'type', foreground: '0b62d6' },
  { token: 'class', foreground: '0b62d6' },
  { token: 'function', foreground: '8250df' },
  { token: 'variable.parameter', foreground: '953800' },
  { token: 'constant', foreground: 'b35309' },
  { token: 'tag', foreground: 'cf222e' },
  { token: 'attribute.name', foreground: '8250df' },
  { token: 'attribute.value', foreground: '1a7f37' },
  { token: 'delimiter', foreground: '565d75' },
  { token: 'operator', foreground: '6a35f0' },
  { token: 'invalid', foreground: 'cf222e', fontStyle: 'underline' },
];

function defineThemes(): void {
  monaco.editor.defineTheme('forge-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: DARK_RULES,
    colors: {
      'editor.background': '#0b0d14',
      'editor.foreground': '#c8cee2',
      'editorLineNumber.foreground': '#454d68',
      'editorLineNumber.activeForeground': '#a88cff',
      'editorCursor.foreground': '#a88cff',
      'editor.selectionBackground': '#7c4dff40',
      'editor.inactiveSelectionBackground': '#7c4dff22',
      'editor.selectionHighlightBackground': '#7c4dff28',
      'editor.lineHighlightBackground': '#11141d',
      'editor.lineHighlightBorder': '#00000000',
      'editorIndentGuide.background1': '#1e2331',
      'editorIndentGuide.activeBackground1': '#3a4260',
      'editorWhitespace.foreground': '#272d3e',
      'editorBracketMatch.background': '#7c4dff26',
      'editorBracketMatch.border': '#8f6bff',
      'editorGutter.addedBackground': '#3fb950',
      'editorGutter.modifiedBackground': '#d9a441',
      'editorGutter.deletedBackground': '#ff6b6b',
      'editorError.foreground': '#ff6b6b',
      'editorWarning.foreground': '#d9a441',
      'editorInfo.foreground': '#58a6ff',
      'editorWidget.background': '#171b26',
      'editorWidget.border': '#303752',
      'editorSuggestWidget.background': '#171b26',
      'editorSuggestWidget.border': '#303752',
      'editorSuggestWidget.selectedBackground': '#272d3e',
      'editorHoverWidget.background': '#171b26',
      'editorHoverWidget.border': '#303752',
      'diffEditor.insertedTextBackground': '#3fb95022',
      'diffEditor.removedTextBackground': '#ff6b6b22',
      'scrollbarSlider.background': '#30375288',
      'scrollbarSlider.hoverBackground': '#414a6baa',
      'scrollbarSlider.activeBackground': '#414a6b',
      'minimap.background': '#0b0d14',
    },
  });

  monaco.editor.defineTheme('forge-light', {
    base: 'vs',
    inherit: true,
    rules: LIGHT_RULES,
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#2c3040',
      'editorLineNumber.foreground': '#9aa1b8',
      'editorLineNumber.activeForeground': '#6a35f0',
      'editorCursor.foreground': '#6a35f0',
      'editor.selectionBackground': '#6a35f033',
      'editor.lineHighlightBackground': '#f7f8fc',
      'editorWidget.background': '#ffffff',
      'editorWidget.border': '#ccd2e2',
    },
  });

  monaco.editor.defineTheme('forge-high-contrast', {
    base: 'hc-black',
    inherit: true,
    rules: [
      ...DARK_RULES,
      { token: '', foreground: 'ffffff' },
      { token: 'comment', foreground: 'b0b0b0', fontStyle: 'italic' },
    ],
    colors: {
      'editor.background': '#000000',
      'editor.foreground': '#ffffff',
      'editorCursor.foreground': '#ffffff',
      'editor.selectionBackground': '#b98cff55',
      'editorLineNumber.foreground': '#b0b0b0',
    },
  });
}

export function applyMonacoTheme(theme: ThemeId): void {
  monaco.editor.setTheme(theme);
}

/* -------------------------------------------------------------------------- */
/*  Lenguajes                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * El servicio de TypeScript embebido de Monaco solo ve el archivo abierto.
 * El IntelliSense real lo aporta `typescript-language-server` a traves del
 * cliente LSP, asi que aqui se apagan los diagnosticos del worker para no
 * mostrar dos veces los mismos errores (y, a menudo, contradictorios).
 */
function configureLanguages(): void {
  const typescriptDefaults = monaco.languages.typescript.typescriptDefaults;
  const javascriptDefaults = monaco.languages.typescript.javascriptDefaults;

  for (const defaults of [typescriptDefaults, javascriptDefaults]) {
    defaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: false,
      noSuggestionDiagnostics: true,
    });
    defaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ESNext,
      module: monaco.languages.typescript.ModuleKind.ESNext,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
      allowNonTsExtensions: true,
      allowJs: true,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
    });
  }

  // Manifiestos DotForge: se tratan como JSON con esquema propio.
  monaco.languages.register({ id: 'dotforge', extensions: ['.dotforge'], aliases: ['DotForge'] });
  monaco.languages.setLanguageConfiguration('dotforge', {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [
      ['{', '}'],
      ['[', ']'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
    ],
  });
  monaco.languages.setMonarchTokensProvider('dotforge', {
    tokenizer: {
      root: [
        [/"[^"]*"\s*(?=:)/, 'attribute.name'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/\b(true|false|null)\b/, 'keyword'],
        [/-?\d+(\.\d+)?([eE][-+]?\d+)?/, 'number'],
        [/[{}[\]]/, 'delimiter.bracket'],
        [/[,:]/, 'delimiter'],
        [/\/\/.*$/, 'comment'],
      ],
    },
  });

  // Archivos `.http` / `.rest` del cliente HTTP integrado.
  monaco.languages.register({ id: 'http', extensions: ['.http', '.rest'], aliases: ['HTTP'] });
  monaco.languages.setMonarchTokensProvider('http', {
    tokenizer: {
      root: [
        [/^###.*$/, 'comment.doc'],
        [/^#.*$/, 'comment'],
        [/^\/\/.*$/, 'comment'],
        [/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\b/, 'keyword'],
        [/^[A-Za-z-]+(?=:)/, 'attribute.name'],
        [/\{\{[^}]+\}\}/, 'variable'],
        [/https?:\/\/[^\s]+/, 'string.link'],
      ],
    },
  });
}

export { monaco };
