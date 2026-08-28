/**
 * Piezas compartidas por todos los blueprints.
 *
 * Cada funcion devuelve el contenido de un archivo. Se mantienen aqui para
 * que un cambio en la configuracion de ESLint o en el Dockerfile se aplique
 * a todas las arquitecturas a la vez.
 */

import { DOTFORGE_SCHEMA_VERSION, type DotForgeConfig } from '../../../../shared/contracts.js';
import { json, type BlueprintContext, type FileMap } from './types.js';

/* -------------------------------------------------------------------------- */
/*  Archivos de repositorio                                                    */
/* -------------------------------------------------------------------------- */

export function gitignore(extra: readonly string[] = []): string {
  return [
    '# Dependencias',
    'node_modules/',
    '.pnp/',
    '.yarn/*',
    '!.yarn/patches',
    '',
    '# Compilacion',
    'dist/',
    'build/',
    'out/',
    'coverage/',
    '*.tsbuildinfo',
    '',
    '# Entorno y secretos',
    '.env',
    '.env.*',
    '!.env.example',
    '',
    '# Cachés',
    '.cache/',
    '.turbo/',
    '.nx/',
    '.vite/',
    '',
    '# Editores y sistema',
    '.DS_Store',
    'Thumbs.db',
    '.idea/',
    '',
    '# Pruebas',
    'playwright-report/',
    'test-results/',
    ...(extra.length === 0 ? [] : ['', '# Especificos del proyecto', ...extra]),
    '',
  ].join('\n');
}

export function editorconfig(): string {
  return [
    'root = true',
    '',
    '[*]',
    'charset = utf-8',
    'end_of_line = lf',
    'indent_style = space',
    'indent_size = 2',
    'insert_final_newline = true',
    'trim_trailing_whitespace = true',
    '',
    '[*.md]',
    'trim_trailing_whitespace = false',
    '',
  ].join('\n');
}

export function envExample(variables: Readonly<Record<string, string>>): string {
  const lines = ['# Copia este archivo a .env y rellena los valores reales.', ''];
  for (const [key, value] of Object.entries(variables)) {
    lines.push(`${key}=${value}`);
  }
  lines.push('');
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/*  TypeScript                                                                 */
/* -------------------------------------------------------------------------- */

export interface TsConfigOptions {
  readonly target?: string;
  readonly lib?: readonly string[];
  readonly jsx?: string;
  readonly module?: string;
  readonly moduleResolution?: string;
  readonly outDir?: string;
  readonly rootDir?: string;
  readonly noEmit?: boolean;
  readonly types?: readonly string[];
  readonly paths?: Readonly<Record<string, readonly string[]>>;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** tsconfig estricto de verdad: sin `any` implicito y con indices marcados. */
export function tsconfig(options: TsConfigOptions = {}): string {
  return json({
    compilerOptions: {
      target: options.target ?? 'ES2022',
      lib: options.lib ?? ['ES2022'],
      module: options.module ?? 'ESNext',
      moduleResolution: options.moduleResolution ?? 'Bundler',
      moduleDetection: 'force',
      ...(options.jsx === undefined ? {} : { jsx: options.jsx }),
      ...(options.types === undefined ? {} : { types: options.types }),

      strict: true,
      noImplicitAny: true,
      strictNullChecks: true,
      strictFunctionTypes: true,
      strictBindCallApply: true,
      strictPropertyInitialization: true,
      noImplicitThis: true,
      useUnknownInCatchVariables: true,
      alwaysStrict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      exactOptionalPropertyTypes: false,
      noImplicitReturns: true,
      noFallthroughCasesInSwitch: true,
      noUncheckedIndexedAccess: true,
      noImplicitOverride: true,
      allowUnreachableCode: false,

      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      forceConsistentCasingInFileNames: true,
      resolveJsonModule: true,
      isolatedModules: true,
      skipLibCheck: true,

      ...(options.noEmit === false
        ? { outDir: options.outDir ?? 'dist', rootDir: options.rootDir ?? 'src', sourceMap: true, declaration: true }
        : { noEmit: true }),

      baseUrl: '.',
      paths: options.paths ?? { '@/*': ['./src/*'] },
      ...(options.extra ?? {}),
    },
    include: options.include ?? ['src'],
    exclude: options.exclude ?? ['node_modules', 'dist', 'build'],
  });
}

/* -------------------------------------------------------------------------- */
/*  Calidad de codigo                                                          */
/* -------------------------------------------------------------------------- */

/** ESLint 9 con configuracion plana. */
export function eslintFlatConfig(options: { react?: boolean; vue?: boolean } = {}): string {
  const lines = [
    "import js from '@eslint/js';",
    "import globals from 'globals';",
    "import tseslint from 'typescript-eslint';",
  ];
  if (options.react === true) {
    lines.push("import reactHooks from 'eslint-plugin-react-hooks';");
    lines.push("import reactRefresh from 'eslint-plugin-react-refresh';");
  }

  lines.push(
    '',
    'export default tseslint.config(',
    "  { ignores: ['dist', 'build', 'coverage', 'node_modules'] },",
    '  js.configs.recommended,',
    '  ...tseslint.configs.strictTypeChecked,',
    '  ...tseslint.configs.stylisticTypeChecked,',
    '  {',
    "    files: ['**/*.{ts,tsx,mts,cts}'],",
    '    languageOptions: {',
    '      ecmaVersion: 2023,',
    '      globals: { ...globals.browser, ...globals.node },',
    '      parserOptions: {',
    "        project: ['./tsconfig.json'],",
    '        tsconfigRootDir: import.meta.dirname,',
    '      },',
    '    },',
  );

  if (options.react === true) {
    lines.push(
      "    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },",
      '    rules: {',
      '      ...reactHooks.configs.recommended.rules,',
      "      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],",
    );
  } else {
    lines.push('    rules: {');
  }

  lines.push(
    "      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],",
    "      '@typescript-eslint/consistent-type-imports': 'error',",
    "      '@typescript-eslint/no-floating-promises': 'error',",
    "      '@typescript-eslint/explicit-function-return-type': ['warn', { allowExpressions: true }],",
    '    },',
    '  },',
    ');',
    '',
  );
  return lines.join('\n');
}

export function prettierConfig(): string {
  return json({
    semi: true,
    singleQuote: true,
    trailingComma: 'all',
    printWidth: 100,
    tabWidth: 2,
    arrowParens: 'always',
    endOfLine: 'lf',
  });
}

export function prettierIgnore(): string {
  return ['dist', 'build', 'coverage', 'node_modules', 'pnpm-lock.yaml', '*.min.*', ''].join('\n');
}

export function biomeConfig(): string {
  return json({
    $schema: 'https://biomejs.dev/schemas/1.9.4/schema.json',
    files: { ignore: ['dist', 'build', 'coverage', 'node_modules'] },
    organizeImports: { enabled: true },
    formatter: { enabled: true, indentStyle: 'space', indentWidth: 2, lineWidth: 100 },
    javascript: { formatter: { quoteStyle: 'single', trailingCommas: 'all', semicolons: 'always' } },
    linter: {
      enabled: true,
      rules: {
        recommended: true,
        correctness: { noUnusedVariables: 'error' },
        suspicious: { noExplicitAny: 'error' },
        style: { useConst: 'error', useTemplate: 'warn' },
      },
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Pruebas                                                                    */
/* -------------------------------------------------------------------------- */

export function vitestConfig(environment: 'node' | 'jsdom'): string {
  return [
    "import { defineConfig } from 'vitest/config';",
    '',
    'export default defineConfig({',
    '  test: {',
    `    environment: '${environment}',`,
    '    globals: true,',
    "    include: ['src/**/*.{test,spec}.{ts,tsx}'],",
    '    coverage: {',
    "      provider: 'v8',",
    "      reporter: ['text', 'lcov'],",
    "      exclude: ['**/*.config.*', '**/*.d.ts', 'src/**/*.{test,spec}.*'],",
    '    },',
    '  },',
    '});',
    '',
  ].join('\n');
}

export function jestConfig(): string {
  return json({
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/src'],
    testMatch: ['**/*.(test|spec).ts'],
    collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
    moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  });
}

export function playwrightConfig(baseUrl: string, devCommand: string): string {
  return [
    "import { defineConfig, devices } from '@playwright/test';",
    '',
    'export default defineConfig({',
    "  testDir: './e2e',",
    '  fullyParallel: true,',
    '  forbidOnly: Boolean(process.env.CI),',
    '  retries: process.env.CI ? 2 : 0,',
    "  reporter: process.env.CI ? 'github' : 'list',",
    '  use: {',
    `    baseURL: process.env.E2E_BASE_URL ?? '${baseUrl}',`,
    "    trace: 'on-first-retry',",
    '  },',
    "  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],",
    '  webServer: {',
    `    command: '${devCommand}',`,
    `    url: process.env.E2E_BASE_URL ?? '${baseUrl}',`,
    '    reuseExistingServer: !process.env.CI,',
    '    timeout: 120_000,',
    '  },',
    '});',
    '',
  ].join('\n');
}

export function playwrightExample(): string {
  return [
    "import { expect, test } from '@playwright/test';",
    '',
    "test('la pagina principal responde', async ({ page }) => {",
    "  const response = await page.goto('/');",
    '  expect(response?.status()).toBeLessThan(400);',
    '});',
    '',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/*  Estilos                                                                    */
/* -------------------------------------------------------------------------- */

export function tailwindConfig(content: readonly string[]): string {
  return [
    "/** @type {import('tailwindcss').Config} */",
    'export default {',
    `  content: [${content.map((entry) => `'${entry}'`).join(', ')}],`,
    '  theme: {',
    '    extend: {',
    '      colors: {',
    "        forge: { 500: '#7c4dff', 600: '#6a35f0', 700: '#5626c9' },",
    '      },',
    '    },',
    '  },',
    '  plugins: [],',
    '};',
    '',
  ].join('\n');
}

export function postcssConfig(): string {
  return ['export default {', '  plugins: {', '    tailwindcss: {},', '    autoprefixer: {},', '  },', '};', ''].join('\n');
}

export function tailwindEntryCss(): string {
  return ['@tailwind base;', '@tailwind components;', '@tailwind utilities;', ''].join('\n');
}

/* -------------------------------------------------------------------------- */
/*  Contenedores                                                               */
/* -------------------------------------------------------------------------- */

export function dockerfileNode(startCommand: string, port: number): string {
  return [
    '# syntax=docker/dockerfile:1',
    '',
    '# --- Dependencias -----------------------------------------------------',
    'FROM node:22-alpine AS deps',
    'WORKDIR /app',
    '# Se copian solo los manifiestos para aprovechar la cache de capas.',
    'COPY package.json package-lock.json* pnpm-lock.yaml* yarn.lock* ./',
    'RUN corepack enable && \\',
    '    if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; \\',
    '    elif [ -f yarn.lock ]; then yarn install --immutable; \\',
    '    else npm ci; fi',
    '',
    '# --- Compilacion ------------------------------------------------------',
    'FROM node:22-alpine AS build',
    'WORKDIR /app',
    'COPY --from=deps /app/node_modules ./node_modules',
    'COPY . .',
    'RUN npm run build',
    '',
    '# --- Ejecucion --------------------------------------------------------',
    'FROM node:22-alpine AS runtime',
    'WORKDIR /app',
    'ENV NODE_ENV=production',
    '# Usuario sin privilegios: la imagen no debe ejecutar como root.',
    'RUN addgroup -S app && adduser -S app -G app',
    'COPY --from=build --chown=app:app /app/dist ./dist',
    'COPY --from=build --chown=app:app /app/node_modules ./node_modules',
    'COPY --from=build --chown=app:app /app/package.json ./package.json',
    'USER app',
    `EXPOSE ${port}`,
    `CMD ${startCommand}`,
    '',
  ].join('\n');
}

export function dockerignore(): string {
  return [
    'node_modules',
    'dist',
    'build',
    'coverage',
    '.git',
    '.env',
    '.env.*',
    '!.env.example',
    'Dockerfile',
    'docker-compose.yml',
    '*.md',
    '',
  ].join('\n');
}

export type DatabaseChoice = 'none' | 'postgres' | 'mongo' | 'mysql';

/** docker-compose con la base de datos elegida y Redis opcional. */
export function dockerCompose(database: DatabaseChoice, redis: boolean, appName: string): string {
  const lines = ['services:'];

  if (database === 'postgres') {
    lines.push(
      '  db:',
      '    image: postgres:16-alpine',
      `    container_name: ${appName}-db`,
      '    restart: unless-stopped',
      '    environment:',
      '      POSTGRES_USER: ${POSTGRES_USER:-app}',
      '      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-app}',
      '      POSTGRES_DB: ${POSTGRES_DB:-app}',
      '    ports:',
      "      - '5432:5432'",
      '    volumes:',
      '      - db-data:/var/lib/postgresql/data',
      '    healthcheck:',
      "      test: ['CMD-SHELL', 'pg_isready -U ${POSTGRES_USER:-app}']",
      '      interval: 10s',
      '      timeout: 5s',
      '      retries: 5',
    );
  } else if (database === 'mysql') {
    lines.push(
      '  db:',
      '    image: mysql:8',
      `    container_name: ${appName}-db`,
      '    restart: unless-stopped',
      '    environment:',
      '      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD:-root}',
      '      MYSQL_DATABASE: ${MYSQL_DATABASE:-app}',
      '    ports:',
      "      - '3306:3306'",
      '    volumes:',
      '      - db-data:/var/lib/mysql',
    );
  } else if (database === 'mongo') {
    lines.push(
      '  db:',
      '    image: mongo:7',
      `    container_name: ${appName}-db`,
      '    restart: unless-stopped',
      '    environment:',
      '      MONGO_INITDB_ROOT_USERNAME: ${MONGO_USER:-app}',
      '      MONGO_INITDB_ROOT_PASSWORD: ${MONGO_PASSWORD:-app}',
      '    ports:',
      "      - '27017:27017'",
      '    volumes:',
      '      - db-data:/data/db',
    );
  }

  if (redis) {
    lines.push(
      '  cache:',
      '    image: redis:7-alpine',
      `    container_name: ${appName}-cache`,
      '    restart: unless-stopped',
      '    ports:',
      "      - '6379:6379'",
      '    command: redis-server --save 60 1 --loglevel warning',
    );
  }

  if (database !== 'none') {
    lines.push('', 'volumes:', '  db-data:');
  }
  lines.push('');
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/*  Manifiesto DotForge                                                        */
/* -------------------------------------------------------------------------- */

export function dotforgeConfig(config: Omit<DotForgeConfig, '$schemaVersion'>): string {
  return json({
    $schema: 'https://dotforge.dev/schema/dotforge.config.json',
    $schemaVersion: DOTFORGE_SCHEMA_VERSION,
    ...config,
  });
}

/* -------------------------------------------------------------------------- */
/*  Documentacion                                                              */
/* -------------------------------------------------------------------------- */

export interface ReadmeOptions {
  readonly title: string;
  readonly description: string;
  readonly packageManager: string;
  readonly commands: readonly { readonly command: string; readonly description: string }[];
  readonly structure: readonly string[];
  readonly notes?: readonly string[];
}

export function readme(options: ReadmeOptions): string {
  const lines = [
    `# ${options.title}`,
    '',
    options.description,
    '',
    'Generado con **ForgeJS IDE** y el motor DotForge.',
    '',
    '## Puesta en marcha',
    '',
    '```bash',
    `${options.packageManager} install`,
    ...options.commands.map((entry) => `${options.packageManager} run ${entry.command}`),
    '```',
    '',
    '## Comandos',
    '',
    '| Comando | Que hace |',
    '| --- | --- |',
    ...options.commands.map((entry) => `| \`${entry.command}\` | ${entry.description} |`),
    '',
    '## Estructura',
    '',
    '```',
    ...options.structure,
    '```',
    '',
    '## DotForge',
    '',
    'Las tareas y los pipelines viven en `dotforge.config.json`. Desde ForgeJS IDE',
    'se lanzan con un clic desde el panel de pipelines; desde la terminal, con la',
    'CLI de DotForge o con los scripts equivalentes de `package.json`.',
    '',
  ];

  if (options.notes !== undefined && options.notes.length > 0) {
    lines.push('## Notas', '', ...options.notes.map((note) => `- ${note}`), '');
  }
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/*  Composicion                                                                */
/* -------------------------------------------------------------------------- */

/** Anade a `files` la calidad de codigo elegida en las opciones. */
export function addQualityTooling(
  files: FileMap,
  context: BlueprintContext,
  options: { react?: boolean } = {},
): void {
  const linter = context.choice('linter', 'eslint');
  if (linter === 'biome') {
    files.set('biome.json', biomeConfig());
  } else {
    files.set(
      'eslint.config.js',
      eslintFlatConfig(options.react === true ? { react: true } : {}),
    );
    files.set('.prettierrc.json', prettierConfig());
    files.set('.prettierignore', prettierIgnore());
  }
}

/** Anade el arnes de pruebas elegido. */
export function addTesting(
  files: FileMap,
  context: BlueprintContext,
  options: { environment: 'node' | 'jsdom'; baseUrl: string; devCommand: string },
): void {
  const runner = context.choice('testRunner', 'vitest');
  if (runner === 'jest') {
    files.set('jest.config.json', jestConfig());
  } else if (runner !== 'none') {
    files.set('vitest.config.ts', vitestConfig(options.environment));
  }
  if (context.flag('playwright')) {
    files.set('playwright.config.ts', playwrightConfig(options.baseUrl, options.devCommand));
    files.set('e2e/inicio.spec.ts', playwrightExample());
  }
}

/** Anade Docker y docker-compose si la opcion esta activa. */
export function addDocker(
  files: FileMap,
  context: BlueprintContext,
  options: { startCommand: string; port: number },
): void {
  if (!context.flag('docker')) {
    return;
  }
  files.set('Dockerfile', dockerfileNode(options.startCommand, options.port));
  files.set('.dockerignore', dockerignore());

  const database = context.choice('database', 'none') as DatabaseChoice;
  const redis = context.flag('redis');
  if (database !== 'none' || redis) {
    files.set('docker-compose.yml', dockerCompose(database, redis, context.packageName));
  }
}

/** Dependencias de las herramientas de calidad y pruebas elegidas. */
export function qualityDependencies(context: BlueprintContext, react: boolean): Record<string, string> {
  const linter = context.choice('linter', 'eslint');
  const runner = context.choice('testRunner', 'vitest');
  const dependencies: Record<string, string> = {};

  if (linter === 'biome') {
    dependencies['@biomejs/biome'] = '^1.9.4';
  } else {
    dependencies['eslint'] = '^9.17.0';
    dependencies['@eslint/js'] = '^9.17.0';
    dependencies['typescript-eslint'] = '^8.18.0';
    dependencies['globals'] = '^15.14.0';
    dependencies['prettier'] = '^3.4.2';
    if (react) {
      dependencies['eslint-plugin-react-hooks'] = '^5.1.0';
      dependencies['eslint-plugin-react-refresh'] = '^0.4.16';
    }
  }

  if (runner === 'vitest') {
    dependencies['vitest'] = '^2.1.8';
    dependencies['@vitest/coverage-v8'] = '^2.1.8';
  } else if (runner === 'jest') {
    dependencies['jest'] = '^29.7.0';
    dependencies['ts-jest'] = '^29.2.5';
    dependencies['@types/jest'] = '^29.5.14';
  }

  if (context.flag('playwright')) {
    dependencies['@playwright/test'] = '^1.49.1';
  }
  return dependencies;
}

/** Scripts de calidad y pruebas coherentes con las opciones elegidas. */
export function qualityScripts(context: BlueprintContext): Record<string, string> {
  const linter = context.choice('linter', 'eslint');
  const runner = context.choice('testRunner', 'vitest');
  const scripts: Record<string, string> = {};

  if (linter === 'biome') {
    scripts['lint'] = 'biome check .';
    scripts['format'] = 'biome format --write .';
  } else {
    scripts['lint'] = 'eslint .';
    scripts['format'] = 'prettier --write .';
  }

  if (runner === 'vitest') {
    scripts['test'] = 'vitest run';
    scripts['test:watch'] = 'vitest';
    scripts['test:coverage'] = 'vitest run --coverage';
  } else if (runner === 'jest') {
    scripts['test'] = 'jest --config jest.config.json';
  }

  if (context.flag('playwright')) {
    scripts['e2e'] = 'playwright test';
  }
  return scripts;
}
