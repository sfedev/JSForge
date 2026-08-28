/** Deteccion del lenguaje de un archivo por nombre y extension. */

const BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  html: 'html',
  htm: 'html',
  vue: 'html',
  svelte: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  md: 'markdown',
  mdx: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  xml: 'xml',
  svg: 'xml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  sql: 'sql',
  prisma: 'graphql',
  graphql: 'graphql',
  gql: 'graphql',
  dockerfile: 'dockerfile',
  toml: 'ini',
  ini: 'ini',
  env: 'ini',
  http: 'http',
  rest: 'http',
  dotforge: 'dotforge',
  txt: 'plaintext',
  log: 'plaintext',
};

const BY_FILENAME: Readonly<Record<string, string>> = {
  dockerfile: 'dockerfile',
  'docker-compose.yml': 'yaml',
  'docker-compose.yaml': 'yaml',
  '.env': 'ini',
  '.gitignore': 'plaintext',
  '.npmrc': 'ini',
  '.editorconfig': 'ini',
  'dotforge.config.json': 'dotforge',
  'dotforge.json': 'dotforge',
  '.dotforge': 'dotforge',
};

export function languageForPath(relativePath: string): string {
  const name = relativePath.split('/').pop() ?? relativePath;
  const lower = name.toLowerCase();

  const byName = BY_FILENAME[lower];
  if (byName !== undefined) {
    return byName;
  }
  if (lower.startsWith('.env')) {
    return 'ini';
  }
  const dot = lower.lastIndexOf('.');
  if (dot === -1) {
    return 'plaintext';
  }
  return BY_EXTENSION[lower.slice(dot + 1)] ?? 'plaintext';
}

/** Extensiones que el IDE trata como binarias y no abre en el editor. */
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tiff',
  'pdf', 'zip', 'gz', 'tar', 'rar', '7z', 'bz2', 'xz',
  'mp3', 'mp4', 'wav', 'ogg', 'webm', 'mov', 'avi', 'mkv',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'exe', 'dll', 'so', 'dylib', 'node', 'wasm', 'class', 'jar',
  'db', 'sqlite', 'sqlite3', 'bin', 'dat', 'pack', 'idx',
]);

export function isBinaryPath(relativePath: string): boolean {
  const name = relativePath.split('/').pop() ?? relativePath;
  const dot = name.lastIndexOf('.');
  return dot !== -1 && BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
