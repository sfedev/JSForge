/**
 * Blueprints de interfaz: React (Vite), Next.js App Router, Vue 3 + Pinia,
 * Angular con componentes standalone y SvelteKit.
 */

import {
  addDocker,
  addQualityTooling,
  addTesting,
  dotforgeConfig,
  editorconfig,
  gitignore,
  postcssConfig,
  qualityDependencies,
  qualityScripts,
  readme,
  tailwindConfig,
  tailwindEntryCss,
  tsconfig,
} from './common.js';
import {
  DOCKER_OPTION,
  FRONTEND_OPTIONS,
  LINTER_OPTION,
  PLAYWRIGHT_OPTION,
  TEST_RUNNER_OPTION,
} from './options.js';
import { buildAngularArchitecture, type AngularArchitecture } from './architectures/angular-arch.js';
import { buildReactArchitecture, type ReactArchitecture } from './architectures/react-arch.js';
import {
  ANGULAR_ARCHITECTURE_OPTION,
  REACT_ARCHITECTURE_OPTION,
  type ArchitectureTree,
} from './architectures/types.js';
import { json, type BlueprintContext, type BlueprintDefinition, type FileMap } from './types.js';

/**
 * Vuelca el arbol de la arquitectura sobre los archivos del blueprint.
 *
 * La arquitectura es dueña de `src/`, asi que antes se retiran los archivos
 * de ejemplo del blueprint: si no, quedarian huerfanos apuntando a modulos
 * que ya no existen.
 */
function applyArchitecture(
  files: FileMap,
  tree: ArchitectureTree,
  owned: readonly string[],
): ArchitectureTree {
  for (const key of owned) {
    files.delete(key);
  }
  for (const [path, content] of tree.files) {
    files.set(path, content);
  }
  return tree;
}

/* -------------------------------------------------------------------------- */
/*  React + Vite                                                               */
/* -------------------------------------------------------------------------- */

function reactViteFiles(context: BlueprintContext): FileMap {
  const files: FileMap = new Map();
  const tailwind = context.choice('styling', 'tailwind') === 'tailwind';
  const modules = context.choice('styling', 'tailwind') === 'css-modules';

  files.set(
    'package.json',
    json({
      name: context.packageName,
      private: true,
      version: '0.1.0',
      type: 'module',
      scripts: {
        dev: 'vite',
        build: 'tsc --noEmit && vite build',
        preview: 'vite preview',
        typecheck: 'tsc --noEmit',
        ...qualityScripts(context),
      },
      dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
      devDependencies: {
        '@types/react': '^18.3.17',
        '@types/react-dom': '^18.3.5',
        '@vitejs/plugin-react': '^4.3.4',
        typescript: '^5.7.2',
        vite: '^6.0.5',
        ...(tailwind ? { tailwindcss: '^3.4.17', autoprefixer: '^10.4.20', postcss: '^8.4.49' } : {}),
        ...qualityDependencies(context, true),
      },
    }),
  );

  files.set(
    'tsconfig.json',
    tsconfig({ lib: ['ES2022', 'DOM', 'DOM.Iterable'], jsx: 'react-jsx', types: ['vite/client'] }),
  );

  files.set(
    'vite.config.ts',
    [
      "import react from '@vitejs/plugin-react';",
      "import path from 'node:path';",
      "import { defineConfig } from 'vite';",
      '',
      'export default defineConfig({',
      '  plugins: [react()],',
      "  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },",
      '  server: { port: 5173, strictPort: true },',
      "  build: { outDir: 'dist', sourcemap: true },",
      '});',
      '',
    ].join('\n'),
  );

  files.set(
    'index.html',
    [
      '<!doctype html>',
      '<html lang="es">',
      '  <head>',
      '    <meta charset="UTF-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      `    <title>${context.projectName}</title>`,
      '  </head>',
      '  <body>',
      '    <div id="root"></div>',
      '    <script type="module" src="/src/main.tsx"></script>',
      '  </body>',
      '</html>',
      '',
    ].join('\n'),
  );

  files.set(
    '__blueprint_main__',
    [
      "import { StrictMode } from 'react';",
      "import { createRoot } from 'react-dom/client';",
      '',
      "import { App } from './App';",
      "import './styles/index.css';",
      '',
      "const container = document.getElementById('root');",
      'if (container === null) {',
      "  throw new Error('No se encontro el contenedor #root.');",
      '}',
      '',
      'createRoot(container).render(',
      '  <StrictMode>',
      '    <App />',
      '  </StrictMode>,',
      ');',
      '',
    ].join('\n'),
  );

  files.set(
    '__blueprint_app__',
    [
      "import { useCallback, useState } from 'react';",
      '',
      modules ? "import styles from './App.module.css';" : '',
      '',
      'export function App(): JSX.Element {',
      '  const [contador, setContador] = useState(0);',
      '',
      '  // `useCallback` evita recrear el manejador en cada render.',
      '  const incrementar = useCallback((): void => {',
      '    setContador((valor) => valor + 1);',
      '  }, []);',
      '',
      '  return (',
      modules
        ? '    <main className={styles.contenedor}>'
        : tailwind
          ? '    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-4">'
          : '    <main className="contenedor">',
      tailwind && !modules
        ? '      <h1 className="text-3xl font-semibold text-forge-500">' + context.projectName + '</h1>'
        : `      <h1>${context.projectName}</h1>`,
      '      <p>Generado con ForgeJS IDE.</p>',
      tailwind && !modules
        ? '      <button type="button" onClick={incrementar} className="rounded-md bg-forge-500 px-4 py-2 text-white">'
        : '      <button type="button" onClick={incrementar}>',
      '        Pulsado {contador} veces',
      '      </button>',
      '    </main>',
      '  );',
      '}',
      '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  );

  files.set(
    '__blueprint_app_test__',
    [
      "import { describe, expect, it } from 'vitest';",
      '',
      "import { App } from './App';",
      '',
      "describe('App', () => {",
      "  it('se puede instanciar', () => {",
      '    expect(App).toBeTypeOf(\'function\');',
      '  });',
      '});',
      '',
    ].join('\n'),
  );

  if (tailwind) {
    files.set('tailwind.config.js', tailwindConfig(['./index.html', './src/**/*.{ts,tsx}']));
    files.set('postcss.config.js', postcssConfig());
    files.set('src/styles/index.css', tailwindEntryCss());
  } else if (modules) {
    files.set(
      'src/App.module.css',
      [
        '.contenedor {',
        '  display: flex;',
        '  min-height: 100vh;',
        '  flex-direction: column;',
        '  align-items: center;',
        '  justify-content: center;',
        '  gap: 1rem;',
        '}',
        '',
      ].join('\n'),
    );
    files.set('src/styles/index.css', ':root { color-scheme: light dark; }\nbody { margin: 0; }\n');
  } else {
    files.set(
      'src/styles/index.css',
      [
        ':root { color-scheme: light dark; font-family: system-ui, sans-serif; }',
        'body { margin: 0; }',
        '.contenedor { display: flex; min-height: 100vh; flex-direction: column;',
        '  align-items: center; justify-content: center; gap: 1rem; }',
        '',
      ].join('\n'),
    );
  }

  return files;
}

const REACT_VITE: BlueprintDefinition = {
  id: 'react-vite',
  label: 'React + Vite',
  category: 'frontend',
  description:
    'Aplicacion React 18 con Vite 6, TypeScript estricto, alias @/ y estilos configurables.',
  tags: ['react', 'vite', 'spa'],
  options: [REACT_ARCHITECTURE_OPTION, ...FRONTEND_OPTIONS],

  build(context) {
    const files = reactViteFiles(context);
    const arquitectura = applyArchitecture(
      files,
      buildReactArchitecture(context.choice('architecture', 'standard') as ReactArchitecture, {
        projectName: context.projectName,
        cssModules: context.choice('styling', 'tailwind') === 'css-modules',
      }),
      ['__blueprint_main__', '__blueprint_app__', '__blueprint_app_test__', 'src/App.module.css'],
    );
    addQualityTooling(files, context, { react: true });
    addTesting(files, context, {
      environment: 'jsdom',
      baseUrl: 'http://localhost:5173',
      devCommand: `${context.packageManager} run dev`,
    });
    addDocker(files, context, { startCommand: '["npx", "vite", "preview", "--host"]', port: 4173 });
    files.set('.gitignore', gitignore(['.vite/']));
    files.set('.editorconfig', editorconfig());
    files.set(
      'dotforge.config.json',
      dotforgeConfig({
        name: context.packageName,
        version: '0.1.0',
        preset: 'react-vite',
        packageManager: context.packageManager,
        tasks: {
          dev: { label: 'Servidor de desarrollo', script: 'dev', port: 5173, readyPattern: 'ready in|Local:', watch: true },
          build: { label: 'Compilar', script: 'build' },
          test: { label: 'Pruebas', script: 'test' },
          lint: { label: 'Analisis estatico', script: 'lint' },
        },
        pipelines: {
          dev: { label: 'Dev completo', tasks: ['dev'], parallel: true },
          ci: { label: 'Verificacion', tasks: ['lint', 'test', 'build'], parallel: false, stopOnError: true },
        },
        environments: { local: { label: 'Local', envFiles: ['.env', '.env.local'] } },
      }),
    );
    files.set(
      'README.md',
      readme({
        title: context.projectName,
        description: `Aplicacion React con Vite y TypeScript estricto. ${arquitectura.description}`,
        packageManager: context.packageManager,
        commands: [
          { command: 'dev', description: 'Servidor de desarrollo en el puerto 5173.' },
          { command: 'build', description: 'Comprueba los tipos y compila a `dist/`.' },
          { command: 'test', description: 'Pruebas unitarias.' },
          { command: 'lint', description: 'Analisis estatico.' },
        ],
        structure: [...arquitectura.structure, 'index.html', 'vite.config.ts'],
        notes: [arquitectura.description, ...arquitectura.notes],
      }),
    );
    return files;
  },

  nextSteps(context) {
    return [
      `${context.packageManager} install`,
      `${context.packageManager} run dev`,
      'Abre http://localhost:5173',
    ];
  },
};

/* -------------------------------------------------------------------------- */
/*  Next.js App Router                                                         */
/* -------------------------------------------------------------------------- */

function nextFiles(context: BlueprintContext, fullstack: boolean): FileMap {
  const files: FileMap = new Map();
  const tailwind = context.choice('styling', 'tailwind') === 'tailwind';

  files.set(
    'package.json',
    json({
      name: context.packageName,
      private: true,
      version: '0.1.0',
      scripts: {
        dev: 'next dev',
        build: 'next build',
        start: 'next start',
        typecheck: 'tsc --noEmit',
        ...qualityScripts(context),
      },
      dependencies: {
        next: '^15.1.3',
        react: '^19.0.0',
        'react-dom': '^19.0.0',
        ...(fullstack && context.choice('orm', 'prisma') === 'prisma'
          ? { '@prisma/client': '^6.1.0' }
          : {}),
        ...(fullstack ? { zod: '^3.24.1' } : {}),
      },
      devDependencies: {
        '@types/node': '^22.10.2',
        '@types/react': '^19.0.2',
        '@types/react-dom': '^19.0.2',
        typescript: '^5.7.2',
        ...(tailwind ? { tailwindcss: '^3.4.17', autoprefixer: '^10.4.20', postcss: '^8.4.49' } : {}),
        ...(fullstack && context.choice('orm', 'prisma') === 'prisma' ? { prisma: '^6.1.0' } : {}),
        ...qualityDependencies(context, true),
      },
    }),
  );

  files.set(
    'tsconfig.json',
    tsconfig({
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      jsx: 'preserve',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
      extra: {
        allowJs: true,
        incremental: true,
        plugins: [{ name: 'next' }],
      },
    }),
  );

  files.set(
    'next.config.ts',
    [
      "import type { NextConfig } from 'next';",
      '',
      'const config: NextConfig = {',
      '  reactStrictMode: true,',
      '  // El modo estricto de compilacion evita desplegar con errores de tipo.',
      '  typescript: { ignoreBuildErrors: false },',
      '  eslint: { ignoreDuringBuilds: false },',
      '};',
      '',
      'export default config;',
      '',
    ].join('\n'),
  );

  files.set('next-env.d.ts', '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n');

  files.set(
    'src/app/layout.tsx',
    [
      "import type { Metadata } from 'next';",
      '',
      "import './globals.css';",
      '',
      'export const metadata: Metadata = {',
      `  title: '${context.projectName}',`,
      "  description: 'Generado con ForgeJS IDE.',",
      '};',
      '',
      'export default function RootLayout({',
      '  children,',
      '}: Readonly<{ children: React.ReactNode }>) {',
      '  return (',
      '    <html lang="es">',
      '      <body>{children}</body>',
      '    </html>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );

  files.set(
    'src/app/page.tsx',
    [
      'export default function Home() {',
      '  return (',
      tailwind
        ? '    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-4">'
        : '    <main>',
      tailwind
        ? `      <h1 className="text-3xl font-semibold text-forge-500">${context.projectName}</h1>`
        : `      <h1>${context.projectName}</h1>`,
      '      <p>Aplicacion Next.js con App Router.</p>',
      '    </main>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );

  if (fullstack) {
    files.set(
      'src/app/api/salud/route.ts',
      [
        "import { NextResponse } from 'next/server';",
        '',
        '/** Comprobacion de salud del despliegue. */',
        'export async function GET(): Promise<NextResponse> {',
        '  return NextResponse.json({ estado: \'ok\', hora: new Date().toISOString() });',
        '}',
        '',
      ].join('\n'),
    );

    files.set(
      'src/app/api/items/route.ts',
      [
        "import { NextResponse } from 'next/server';",
        "import { z } from 'zod';",
        '',
        'const EsquemaItem = z.object({',
        '  nombre: z.string().min(1, \'El nombre es obligatorio.\'),',
        '  cantidad: z.number().int().positive().default(1),',
        '});',
        '',
        'export async function GET(): Promise<NextResponse> {',
        '  return NextResponse.json({ items: [] });',
        '}',
        '',
        'export async function POST(request: Request): Promise<NextResponse> {',
        '  // La validacion ocurre en el limite: nunca se confia en el cuerpo.',
        '  const resultado = EsquemaItem.safeParse(await request.json());',
        '  if (!resultado.success) {',
        '    return NextResponse.json(',
        '      { error: resultado.error.flatten() },',
        '      { status: 422 },',
        '    );',
        '  }',
        '  return NextResponse.json({ item: resultado.data }, { status: 201 });',
        '}',
        '',
      ].join('\n'),
    );
  }

  if (tailwind) {
    files.set('tailwind.config.js', tailwindConfig(['./src/**/*.{ts,tsx}']));
    files.set('postcss.config.js', postcssConfig());
    files.set('src/app/globals.css', tailwindEntryCss());
  } else {
    files.set(
      'src/app/globals.css',
      ':root { color-scheme: light dark; font-family: system-ui, sans-serif; }\nbody { margin: 0; }\n',
    );
  }

  return files;
}

function nextBlueprint(id: string, label: string, fullstack: boolean): BlueprintDefinition {
  return {
    id,
    label,
    category: fullstack ? 'fullstack' : 'frontend',
    description: fullstack
      ? 'Next.js 15 con App Router, rutas de API validadas con Zod y Prisma opcional.'
      : 'Next.js 15 con App Router, React 19 y TypeScript estricto.',
    tags: fullstack ? ['next', 'fullstack', 'api'] : ['next', 'react', 'ssr'],
    options: fullstack
      ? [...FRONTEND_OPTIONS, { id: 'orm', label: 'Acceso a datos', type: 'choice', default: 'prisma', choices: [{ id: 'prisma', label: 'Prisma' }, { id: 'none', label: 'Sin ORM' }] }]
      : FRONTEND_OPTIONS,

    build(context) {
      const files = nextFiles(context, fullstack);
      addQualityTooling(files, context, { react: true });
      addTesting(files, context, {
        environment: 'jsdom',
        baseUrl: 'http://localhost:3000',
        devCommand: `${context.packageManager} run dev`,
      });
      addDocker(files, context, { startCommand: '["npm", "run", "start"]', port: 3000 });
      files.set('.gitignore', gitignore(['.next/', 'next-env.d.ts']));
      files.set('.editorconfig', editorconfig());

      if (fullstack && context.choice('orm', 'prisma') === 'prisma') {
        files.set('prisma/schema.prisma', prismaSchema(context.choice('database', 'postgres')));
        files.set(
          'src/lib/prisma.ts',
          [
            "import { PrismaClient } from '@prisma/client';",
            '',
            '// En desarrollo, el recargado en caliente crearia un cliente por',
            '// recarga y agotaria el pool de conexiones; por eso se reutiliza.',
            'const global_ = globalThis as unknown as { prisma?: PrismaClient };',
            '',
            'export const prisma = global_.prisma ?? new PrismaClient();',
            '',
            "if (process.env.NODE_ENV !== 'production') {",
            '  global_.prisma = prisma;',
            '}',
            '',
          ].join('\n'),
        );
      }

      files.set(
        'dotforge.config.json',
        dotforgeConfig({
          name: context.packageName,
          version: '0.1.0',
          preset: id,
          packageManager: context.packageManager,
          tasks: {
            dev: { label: 'Next dev', script: 'dev', port: 3000, readyPattern: 'Ready in|Local:', watch: true },
            build: { label: 'Compilar', script: 'build' },
            start: { label: 'Servidor de produccion', script: 'start', port: 3000 },
            lint: { label: 'Analisis estatico', script: 'lint' },
            ...(fullstack ? { migrate: { label: 'Migraciones Prisma', command: 'npx prisma migrate dev' } } : {}),
          },
          pipelines: {
            dev: { label: 'Dev completo', tasks: ['dev'], parallel: true },
            ci: { label: 'Verificacion', tasks: ['lint', 'build'], parallel: false, stopOnError: true },
          },
          environments: { local: { label: 'Local', envFiles: ['.env', '.env.local'], secrets: ['DATABASE_URL'] } },
          ...(fullstack && context.choice('database', 'postgres') !== 'none'
            ? {
                services: [
                  { name: 'db', kind: context.choice('database', 'postgres') as 'postgres', composeFile: 'docker-compose.yml', composeService: 'db' },
                ],
              }
            : {}),
        }),
      );

      files.set(
        'README.md',
        readme({
          title: context.projectName,
          description: fullstack
            ? 'Aplicacion fullstack Next.js con rutas de API validadas.'
            : 'Aplicacion Next.js con App Router.',
          packageManager: context.packageManager,
          commands: [
            { command: 'dev', description: 'Servidor de desarrollo en el puerto 3000.' },
            { command: 'build', description: 'Compilacion de produccion.' },
            { command: 'start', description: 'Sirve la compilacion.' },
            { command: 'lint', description: 'Analisis estatico.' },
          ],
          structure: [
            'src/app/',
            '  layout.tsx      layout raiz',
            '  page.tsx        pagina de inicio',
            ...(fullstack ? ['  api/            rutas de API'] : []),
            ...(fullstack ? ['src/lib/          clientes compartidos'] : []),
          ],
          ...(fullstack
            ? { notes: ['Ejecuta `npx prisma migrate dev` tras levantar la base de datos.'] }
            : {}),
        }),
      );
      return files;
    },

    nextSteps(context) {
      return [
        `${context.packageManager} install`,
        ...(fullstack ? ['docker compose up -d', 'npx prisma migrate dev --name inicial'] : []),
        `${context.packageManager} run dev`,
        'Abre http://localhost:3000',
      ];
    },
  };
}

/** Esquema Prisma inicial acorde a la base de datos elegida. */
export function prismaSchema(database: string): string {
  const provider = database === 'mysql' ? 'mysql' : database === 'mongo' ? 'mongodb' : 'postgresql';
  return [
    'generator client {',
    '  provider = "prisma-client-js"',
    '}',
    '',
    'datasource db {',
    `  provider = "${provider}"`,
    '  url      = env("DATABASE_URL")',
    '}',
    '',
    'model Item {',
    provider === 'mongodb'
      ? '  id       String @id @default(auto()) @map("_id") @db.ObjectId'
      : '  id       Int      @id @default(autoincrement())',
    '  nombre   String',
    '  cantidad Int      @default(1)',
    '  creadoEn DateTime @default(now())',
    '}',
    '',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/*  Vue 3 + Vite + Pinia                                                       */
/* -------------------------------------------------------------------------- */

const VUE_VITE: BlueprintDefinition = {
  id: 'vue-vite',
  label: 'Vue 3 + Vite + Pinia',
  category: 'frontend',
  description: 'Vue 3 con Composition API, Pinia, Vue Router y TypeScript estricto.',
  tags: ['vue', 'vite', 'pinia'],
  options: FRONTEND_OPTIONS,

  build(context) {
    const files: FileMap = new Map();
    const tailwind = context.choice('styling', 'tailwind') === 'tailwind';

    files.set(
      'package.json',
      json({
        name: context.packageName,
        private: true,
        version: '0.1.0',
        type: 'module',
        scripts: {
          dev: 'vite',
          build: 'vue-tsc --noEmit && vite build',
          preview: 'vite preview',
          typecheck: 'vue-tsc --noEmit',
          ...qualityScripts(context),
        },
        dependencies: { vue: '^3.5.13', 'vue-router': '^4.5.0', pinia: '^2.3.0' },
        devDependencies: {
          '@vitejs/plugin-vue': '^5.2.1',
          typescript: '^5.7.2',
          'vue-tsc': '^2.2.0',
          vite: '^6.0.5',
          ...(tailwind ? { tailwindcss: '^3.4.17', autoprefixer: '^10.4.20', postcss: '^8.4.49' } : {}),
          ...qualityDependencies(context, false),
        },
      }),
    );

    files.set(
      'tsconfig.json',
      tsconfig({
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        types: ['vite/client'],
        include: ['src/**/*.ts', 'src/**/*.vue'],
      }),
    );

    files.set(
      'vite.config.ts',
      [
        "import vue from '@vitejs/plugin-vue';",
        "import path from 'node:path';",
        "import { defineConfig } from 'vite';",
        '',
        'export default defineConfig({',
        '  plugins: [vue()],',
        "  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },",
        '  server: { port: 5173, strictPort: true },',
        '});',
        '',
      ].join('\n'),
    );

    files.set(
      'index.html',
      [
        '<!doctype html>',
        '<html lang="es">',
        '  <head>',
        '    <meta charset="UTF-8" />',
        '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
        `    <title>${context.projectName}</title>`,
        '  </head>',
        '  <body>',
        '    <div id="app"></div>',
        '    <script type="module" src="/src/main.ts"></script>',
        '  </body>',
        '</html>',
        '',
      ].join('\n'),
    );

    files.set(
      '__ng_src_main_ts__',
      [
        "import { createPinia } from 'pinia';",
        "import { createApp } from 'vue';",
        '',
        "import App from './App.vue';",
        "import { router } from './router';",
        "import './styles/index.css';",
        '',
        'createApp(App).use(createPinia()).use(router).mount(\'#app\');',
        '',
      ].join('\n'),
    );

    files.set(
      'src/App.vue',
      [
        '<script setup lang="ts">',
        "import { RouterView } from 'vue-router';",
        '</script>',
        '',
        '<template>',
        '  <RouterView />',
        '</template>',
        '',
      ].join('\n'),
    );

    files.set(
      'src/router.ts',
      [
        "import { createRouter, createWebHistory } from 'vue-router';",
        '',
        "import Inicio from './views/Inicio.vue';",
        '',
        'export const router = createRouter({',
        '  history: createWebHistory(),',
        '  routes: [',
        "    { path: '/', name: 'inicio', component: Inicio },",
        '    {',
        "      path: '/:ruta(.*)*',",
        "      name: 'no-encontrado',",
        "      component: () => import('./views/NoEncontrado.vue'),",
        '    },',
        '  ],',
        '});',
        '',
      ].join('\n'),
    );

    files.set(
      'src/stores/contador.ts',
      [
        "import { defineStore } from 'pinia';",
        "import { computed, ref } from 'vue';",
        '',
        "export const useContador = defineStore('contador', () => {",
        '  const valor = ref(0);',
        '  const doble = computed(() => valor.value * 2);',
        '',
        '  function incrementar(): void {',
        '    valor.value += 1;',
        '  }',
        '',
        '  return { valor, doble, incrementar };',
        '});',
        '',
      ].join('\n'),
    );

    files.set(
      'src/views/Inicio.vue',
      [
        '<script setup lang="ts">',
        "import { useContador } from '../stores/contador';",
        '',
        'const contador = useContador();',
        '</script>',
        '',
        '<template>',
        tailwind
          ? '  <main class="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-4">'
          : '  <main class="contenedor">',
        `    <h1>${context.projectName}</h1>`,
        '    <p>Vue 3 con Pinia y Vue Router.</p>',
        '    <button type="button" @click="contador.incrementar()">',
        '      Pulsado {{ contador.valor }} veces (doble: {{ contador.doble }})',
        '    </button>',
        '  </main>',
        '</template>',
        '',
      ].join('\n'),
    );

    files.set(
      'src/views/NoEncontrado.vue',
      ['<template>', '  <main>', '    <h1>404</h1>', '    <p>Esta ruta no existe.</p>', '  </main>', '</template>', ''].join('\n'),
    );

    if (tailwind) {
      files.set('tailwind.config.js', tailwindConfig(['./index.html', './src/**/*.{ts,vue}']));
      files.set('postcss.config.js', postcssConfig());
      files.set('src/styles/index.css', tailwindEntryCss());
    } else {
      files.set(
        'src/styles/index.css',
        ':root { color-scheme: light dark; font-family: system-ui, sans-serif; }\nbody { margin: 0; }\n.contenedor { display:flex; min-height:100vh; flex-direction:column; align-items:center; justify-content:center; gap:1rem; }\n',
      );
    }

    addQualityTooling(files, context);
    addTesting(files, context, {
      environment: 'jsdom',
      baseUrl: 'http://localhost:5173',
      devCommand: `${context.packageManager} run dev`,
    });
    addDocker(files, context, { startCommand: '["npx", "vite", "preview", "--host"]', port: 4173 });
    files.set('.gitignore', gitignore(['.vite/']));
    files.set('.editorconfig', editorconfig());
    files.set(
      'dotforge.config.json',
      dotforgeConfig({
        name: context.packageName,
        version: '0.1.0',
        preset: 'vue-vite',
        packageManager: context.packageManager,
        tasks: {
          dev: { label: 'Servidor de desarrollo', script: 'dev', port: 5173, readyPattern: 'ready in|Local:', watch: true },
          build: { label: 'Compilar', script: 'build' },
          lint: { label: 'Analisis estatico', script: 'lint' },
        },
        pipelines: { dev: { label: 'Dev completo', tasks: ['dev'] } },
      }),
    );
    files.set(
      'README.md',
      readme({
        title: context.projectName,
        description: 'Aplicacion Vue 3 con Vite, Pinia y Vue Router.',
        packageManager: context.packageManager,
        commands: [
          { command: 'dev', description: 'Servidor de desarrollo.' },
          { command: 'build', description: 'Comprueba los tipos y compila.' },
          { command: 'lint', description: 'Analisis estatico.' },
        ],
        structure: ['src/', '  views/     paginas', '  stores/    estado con Pinia', '  router.ts  rutas'],
      }),
    );
    return files;
  },

  nextSteps(context) {
    return [`${context.packageManager} install`, `${context.packageManager} run dev`, 'Abre http://localhost:5173'];
  },
};

/* -------------------------------------------------------------------------- */
/*  Angular standalone                                                         */
/* -------------------------------------------------------------------------- */

const ANGULAR: BlueprintDefinition = {
  id: 'angular-standalone',
  label: 'Angular (componentes standalone)',
  category: 'frontend',
  description: 'Angular 19 con componentes standalone, senales y enrutado sin NgModules.',
  tags: ['angular', 'standalone', 'signals'],
  // Angular trae su propio manejo de estilos por componente, asi que la
  // opcion de estilos global no aplica.
  options: [
    ANGULAR_ARCHITECTURE_OPTION,
    LINTER_OPTION,
    TEST_RUNNER_OPTION,
    PLAYWRIGHT_OPTION,
    DOCKER_OPTION,
  ],

  build(context) {
    const files: FileMap = new Map();

    files.set(
      'package.json',
      json({
        name: context.packageName,
        private: true,
        version: '0.1.0',
        scripts: {
          dev: 'ng serve',
          build: 'ng build',
          watch: 'ng build --watch --configuration development',
          test: 'ng test',
          ...qualityScripts(context),
        },
        dependencies: {
          '@angular/common': '^19.0.5',
          '@angular/compiler': '^19.0.5',
          '@angular/core': '^19.0.5',
          '@angular/forms': '^19.0.5',
          '@angular/platform-browser': '^19.0.5',
          '@angular/router': '^19.0.5',
          rxjs: '^7.8.1',
          tslib: '^2.8.1',
          'zone.js': '^0.15.0',
        },
        devDependencies: {
          '@angular-devkit/build-angular': '^19.0.6',
          '@angular/cli': '^19.0.6',
          '@angular/compiler-cli': '^19.0.5',
          typescript: '^5.6.3',
          ...qualityDependencies(context, false),
        },
      }),
    );

    files.set(
      'angular.json',
      json({
        $schema: './node_modules/@angular/cli/lib/config/schema.json',
        version: 1,
        newProjectRoot: 'projects',
        projects: {
          [context.packageName]: {
            projectType: 'application',
            root: '',
            sourceRoot: 'src',
            prefix: 'app',
            architect: {
              build: {
                builder: '@angular-devkit/build-angular:application',
                options: {
                  outputPath: 'dist',
                  index: 'src/index.html',
                  browser: 'src/main.ts',
                  tsConfig: 'tsconfig.json',
                  styles: ['src/styles.css'],
                },
                configurations: {
                  production: { optimization: true, outputHashing: 'all' },
                  development: { optimization: false, sourceMap: true },
                },
                defaultConfiguration: 'production',
              },
              serve: {
                builder: '@angular-devkit/build-angular:dev-server',
                options: { port: 4200 },
                configurations: { development: { buildTarget: `${context.packageName}:build:development` } },
                defaultConfiguration: 'development',
              },
            },
          },
        },
      }),
    );

    files.set(
      'tsconfig.json',
      tsconfig({
        lib: ['ES2022', 'DOM'],
        module: 'ES2022',
        moduleResolution: 'bundler',
        noEmit: false,
        outDir: './dist/out-tsc',
        include: ['src'],
        extra: {
          experimentalDecorators: true,
          useDefineForClassFields: false,
          angularCompilerOptions: { strictTemplates: true, strictInjectionParameters: true },
        },
      }),
    );

    files.set(
      'src/index.html',
      [
        '<!doctype html>',
        '<html lang="es">',
        '  <head>',
        '    <meta charset="utf-8" />',
        `    <title>${context.projectName}</title>`,
        '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
        '  </head>',
        '  <body>',
        '    <app-root></app-root>',
        '  </body>',
        '</html>',
        '',
      ].join('\n'),
    );

    files.set(
      'src/main.ts',
      [
        "import { bootstrapApplication } from '@angular/platform-browser';",
        '',
        "import { App } from './app/app.component';",
        "import { appConfig } from './app/app.config';",
        '',
        'void bootstrapApplication(App, appConfig);',
        '',
      ].join('\n'),
    );

    files.set(
      '__ng_src_app_app_config_ts__',
      [
        "import type { ApplicationConfig } from '@angular/core';",
        "import { provideZoneChangeDetection } from '@angular/core';",
        "import { provideRouter } from '@angular/router';",
        '',
        "import { routes } from './app.routes';",
        '',
        'export const appConfig: ApplicationConfig = {',
        '  providers: [',
        '    provideZoneChangeDetection({ eventCoalescing: true }),',
        '    provideRouter(routes),',
        '  ],',
        '};',
        '',
      ].join('\n'),
    );

    files.set(
      '__ng_src_app_app_routes_ts__',
      [
        "import type { Routes } from '@angular/router';",
        '',
        'export const routes: Routes = [',
        '  {',
        "    path: '',",
        "    loadComponent: async () => (await import('./inicio/inicio.component')).Inicio,",
        '  },',
        '];',
        '',
      ].join('\n'),
    );

    files.set(
      '__ng_src_app_app_component_ts__',
      [
        "import { Component } from '@angular/core';",
        "import { RouterOutlet } from '@angular/router';",
        '',
        '@Component({',
        "  selector: 'app-root',",
        '  standalone: true,',
        '  imports: [RouterOutlet],',
        "  template: '<router-outlet />',",
        '})',
        'export class App {}',
        '',
      ].join('\n'),
    );

    files.set(
      '__ng_src_app_inicio_inicio_component_ts__',
      [
        "import { Component, signal } from '@angular/core';",
        '',
        '@Component({',
        "  selector: 'app-inicio',",
        '  standalone: true,',
        '  template: `',
        '    <main class="contenedor">',
        `      <h1>${context.projectName}</h1>`,
        '      <p>Angular con componentes standalone y senales.</p>',
        '      <button type="button" (click)="incrementar()">',
        '        Pulsado {{ contador() }} veces',
        '      </button>',
        '    </main>',
        '  `,',
        '  styles: [',
        '    `',
        '      .contenedor {',
        '        display: flex;',
        '        min-height: 100vh;',
        '        flex-direction: column;',
        '        align-items: center;',
        '        justify-content: center;',
        '        gap: 1rem;',
        '      }',
        '    `,',
        '  ],',
        '})',
        'export class Inicio {',
        '  // Las senales sustituyen a los observables para el estado local.',
        '  protected readonly contador = signal(0);',
        '',
        '  protected incrementar(): void {',
        '    this.contador.update((valor) => valor + 1);',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    files.set('src/styles.css', ':root { color-scheme: light dark; font-family: system-ui, sans-serif; }\nbody { margin: 0; }\n');

    const arquitectura = applyArchitecture(
      files,
      buildAngularArchitecture(
        context.choice('architecture', 'clean-standalone') as AngularArchitecture,
        context.projectName,
      ),
      [
        '__ng_src_main_ts__',
        '__ng_src_app_app_config_ts__',
        '__ng_src_app_app_routes_ts__',
        '__ng_src_app_app_component_ts__',
        '__ng_src_app_inicio_inicio_component_ts__',
      ],
    );

    addQualityTooling(files, context);
    addDocker(files, context, { startCommand: '["npx", "http-server", "dist/browser", "-p", "4200"]', port: 4200 });
    files.set('.gitignore', gitignore(['.angular/']));
    files.set('.editorconfig', editorconfig());
    files.set(
      'dotforge.config.json',
      dotforgeConfig({
        name: context.packageName,
        version: '0.1.0',
        preset: 'angular-standalone',
        packageManager: context.packageManager,
        tasks: {
          dev: {
            label: 'ng serve',
            script: 'dev',
            port: 4200,
            readyPattern: 'Application bundle generation complete|Compiled successfully',
            watch: true,
          },
          build: { label: 'Compilar', script: 'build' },
          test: { label: 'Pruebas', script: 'test' },
        },
        pipelines: { dev: { label: 'Dev completo', tasks: ['dev'] } },
      }),
    );
    files.set(
      'README.md',
      readme({
        title: context.projectName,
        description: `Aplicacion Angular con componentes standalone y senales. ${arquitectura.description}`,
        packageManager: context.packageManager,
        commands: [
          { command: 'dev', description: 'Servidor de desarrollo en el puerto 4200.' },
          { command: 'build', description: 'Compilacion de produccion.' },
          { command: 'test', description: 'Pruebas unitarias.' },
        ],
        structure: arquitectura.structure,
        notes: [arquitectura.description, ...arquitectura.notes],
      }),
    );
    return files;
  },

  nextSteps(context) {
    return [`${context.packageManager} install`, `${context.packageManager} run dev`, 'Abre http://localhost:4200'];
  },
};

/* -------------------------------------------------------------------------- */
/*  SvelteKit                                                                  */
/* -------------------------------------------------------------------------- */

const SVELTEKIT: BlueprintDefinition = {
  id: 'sveltekit',
  label: 'SvelteKit',
  category: 'frontend',
  description: 'SvelteKit 2 con Svelte 5, adaptador automatico y TypeScript estricto.',
  tags: ['svelte', 'sveltekit', 'ssr'],
  options: FRONTEND_OPTIONS,

  build(context) {
    const files: FileMap = new Map();
    const tailwind = context.choice('styling', 'tailwind') === 'tailwind';

    files.set(
      'package.json',
      json({
        name: context.packageName,
        private: true,
        version: '0.1.0',
        type: 'module',
        scripts: {
          dev: 'vite dev',
          build: 'vite build',
          preview: 'vite preview',
          typecheck: 'svelte-check --tsconfig ./tsconfig.json',
          ...qualityScripts(context),
        },
        devDependencies: {
          '@sveltejs/adapter-auto': '^3.3.1',
          '@sveltejs/kit': '^2.15.1',
          '@sveltejs/vite-plugin-svelte': '^5.0.3',
          svelte: '^5.16.0',
          'svelte-check': '^4.1.1',
          typescript: '^5.7.2',
          vite: '^6.0.5',
          ...(tailwind ? { tailwindcss: '^3.4.17', autoprefixer: '^10.4.20', postcss: '^8.4.49' } : {}),
          ...qualityDependencies(context, false),
        },
      }),
    );

    files.set(
      'svelte.config.js',
      [
        "import adapter from '@sveltejs/adapter-auto';",
        '',
        "/** @type {import('@sveltejs/kit').Config} */",
        'export default {',
        '  kit: { adapter: adapter() },',
        '};',
        '',
      ].join('\n'),
    );

    files.set(
      'vite.config.ts',
      [
        "import { sveltekit } from '@sveltejs/kit/vite';",
        "import { defineConfig } from 'vite';",
        '',
        'export default defineConfig({',
        '  plugins: [sveltekit()],',
        '  server: { port: 5173, strictPort: true },',
        '});',
        '',
      ].join('\n'),
    );

    files.set(
      'tsconfig.json',
      json({
        extends: './.svelte-kit/tsconfig.json',
        compilerOptions: {
          allowJs: true,
          checkJs: true,
          esModuleInterop: true,
          forceConsistentCasingInFileNames: true,
          resolveJsonModule: true,
          skipLibCheck: true,
          sourceMap: true,
          strict: true,
          noUncheckedIndexedAccess: true,
          moduleResolution: 'bundler',
        },
      }),
    );

    files.set(
      'src/app.html',
      [
        '<!doctype html>',
        '<html lang="es">',
        '  <head>',
        '    <meta charset="utf-8" />',
        '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
        '    %sveltekit.head%',
        '  </head>',
        '  <body data-sveltekit-preload-data="hover">',
        '    <div style="display: contents">%sveltekit.body%</div>',
        '  </body>',
        '</html>',
        '',
      ].join('\n'),
    );

    files.set(
      'src/routes/+layout.svelte',
      [
        '<script lang="ts">',
        "  import '../app.css';",
        '',
        '  let { children } = $props();',
        '</script>',
        '',
        '{@render children()}',
        '',
      ].join('\n'),
    );

    files.set(
      'src/routes/+page.svelte',
      [
        '<script lang="ts">',
        '  // Runas de Svelte 5: el estado se declara con $state.',
        '  let contador = $state(0);',
        '</script>',
        '',
        tailwind
          ? '<main class="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-4">'
          : '<main class="contenedor">',
        `  <h1>${context.projectName}</h1>`,
        '  <p>Aplicacion SvelteKit.</p>',
        '  <button type="button" onclick={() => contador++}>',
        '    Pulsado {contador} veces',
        '  </button>',
        '</main>',
        '',
        ...(tailwind
          ? []
          : [
              '<style>',
              '  .contenedor {',
              '    display: flex;',
              '    min-height: 100vh;',
              '    flex-direction: column;',
              '    align-items: center;',
              '    justify-content: center;',
              '    gap: 1rem;',
              '  }',
              '</style>',
              '',
            ]),
      ].join('\n'),
    );

    if (tailwind) {
      files.set('tailwind.config.js', tailwindConfig(['./src/**/*.{html,svelte,ts}']));
      files.set('postcss.config.js', postcssConfig());
      files.set('src/app.css', tailwindEntryCss());
    } else {
      files.set('src/app.css', ':root { color-scheme: light dark; font-family: system-ui, sans-serif; }\nbody { margin: 0; }\n');
    }

    addQualityTooling(files, context);
    addTesting(files, context, {
      environment: 'jsdom',
      baseUrl: 'http://localhost:5173',
      devCommand: `${context.packageManager} run dev`,
    });
    addDocker(files, context, { startCommand: '["node", "build"]', port: 3000 });
    files.set('.gitignore', gitignore(['.svelte-kit/', 'build/']));
    files.set('.editorconfig', editorconfig());
    files.set(
      'dotforge.config.json',
      dotforgeConfig({
        name: context.packageName,
        version: '0.1.0',
        preset: 'sveltekit',
        packageManager: context.packageManager,
        tasks: {
          dev: { label: 'Servidor de desarrollo', script: 'dev', port: 5173, readyPattern: 'ready in|Local:', watch: true },
          build: { label: 'Compilar', script: 'build' },
        },
        pipelines: { dev: { label: 'Dev completo', tasks: ['dev'] } },
      }),
    );
    files.set(
      'README.md',
      readme({
        title: context.projectName,
        description: 'Aplicacion SvelteKit con Svelte 5.',
        packageManager: context.packageManager,
        commands: [
          { command: 'dev', description: 'Servidor de desarrollo.' },
          { command: 'build', description: 'Compilacion de produccion.' },
        ],
        structure: ['src/routes/', '  +layout.svelte', '  +page.svelte', 'src/app.html'],
      }),
    );
    return files;
  },

  nextSteps(context) {
    return [`${context.packageManager} install`, `${context.packageManager} run dev`, 'Abre http://localhost:5173'];
  },
};

export const FRONTEND_BLUEPRINTS: readonly BlueprintDefinition[] = [
  REACT_VITE,
  nextBlueprint('next-app', 'Next.js (App Router)', false),
  VUE_VITE,
  ANGULAR,
  SVELTEKIT,
];

export const FULLSTACK_NEXT = nextBlueprint('next-fullstack', 'Next.js Fullstack', true);
