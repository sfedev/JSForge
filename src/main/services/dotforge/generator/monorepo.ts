/**
 * Blueprints de monorepo: Turborepo y Nx.
 *
 * Ambos generan dos paquetes reales (una interfaz y una API) con un paquete
 * compartido de tipos, para que el pipeline "Dev completo" de DotForge tenga
 * algo de verdad que orquestar desde el primer minuto.
 */

import {
  addQualityTooling,
  dockerCompose,
  dotforgeConfig,
  editorconfig,
  envExample,
  gitignore,
  qualityDependencies,
  qualityScripts,
  readme,
  tsconfig,
} from './common.js';
import { DATABASE_OPTION, LINTER_OPTION, REDIS_OPTION, TEST_RUNNER_OPTION } from './options.js';
import { json, type BlueprintContext, type BlueprintDefinition, type FileMap } from './types.js';

type FrontChoice = 'react' | 'vue';
type BackChoice = 'express' | 'nestjs';

const STACK_OPTION = {
  id: 'stack',
  label: 'Combinacion',
  type: 'choice' as const,
  default: 'react-express',
  choices: [
    { id: 'react-express', label: 'React + Express' },
    { id: 'vue-nestjs', label: 'Vue + NestJS' },
  ],
};

function stackOf(context: BlueprintContext): { front: FrontChoice; back: BackChoice } {
  return context.choice('stack', 'react-express') === 'vue-nestjs'
    ? { front: 'vue', back: 'nestjs' }
    : { front: 'react', back: 'express' };
}

/* -------------------------------------------------------------------------- */
/*  Paquetes compartidos                                                       */
/* -------------------------------------------------------------------------- */

function sharedPackage(files: FileMap, scope: string): void {
  files.set(
    'packages/shared/package.json',
    json({
      name: `@${scope}/shared`,
      version: '0.1.0',
      private: true,
      type: 'module',
      main: './src/index.ts',
      types: './src/index.ts',
      exports: { '.': './src/index.ts' },
      scripts: { typecheck: 'tsc --noEmit' },
      devDependencies: { typescript: '^5.7.2' },
    }),
  );

  files.set(
    'packages/shared/tsconfig.json',
    tsconfig({ include: ['src'], paths: {} }),
  );

  files.set(
    'packages/shared/src/index.ts',
    [
      '/**',
      ' * Contrato compartido entre la interfaz y la API.',
      ' * Que viva en un paquete propio es lo que impide que se desincronicen.',
      ' */',
      'export interface Item {',
      '  readonly id: string;',
      '  readonly nombre: string;',
      '  readonly cantidad: number;',
      '}',
      '',
      'export interface RespuestaItems {',
      '  readonly items: readonly Item[];',
      '}',
      '',
      'export const RUTA_ITEMS = \'/api/items\';',
      '',
    ].join('\n'),
  );
}

function webPackage(files: FileMap, front: FrontChoice, scope: string): void {
  if (front === 'react') {
    files.set(
      'apps/web/package.json',
      json({
        name: `@${scope}/web`,
        version: '0.1.0',
        private: true,
        type: 'module',
        scripts: { dev: 'vite --port 5173', build: 'tsc --noEmit && vite build', preview: 'vite preview' },
        dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1', [`@${scope}/shared`]: 'workspace:*' },
        devDependencies: {
          '@types/react': '^18.3.17',
          '@types/react-dom': '^18.3.5',
          '@vitejs/plugin-react': '^4.3.4',
          typescript: '^5.7.2',
          vite: '^6.0.5',
        },
      }),
    );
    files.set(
      'apps/web/vite.config.ts',
      [
        "import react from '@vitejs/plugin-react';",
        "import { defineConfig } from 'vite';",
        '',
        'export default defineConfig({',
        '  plugins: [react()],',
        '  server: {',
        '    port: 5173,',
        '    // El proxy evita CORS en desarrollo apuntando a la API del monorepo.',
        "    proxy: { '/api': 'http://localhost:3000' },",
        '  },',
        '});',
        '',
      ].join('\n'),
    );
    files.set(
      'apps/web/index.html',
      '<!doctype html>\n<html lang="es">\n  <head>\n    <meta charset="UTF-8" />\n    <title>Web</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n',
    );
    files.set(
      'apps/web/src/main.tsx',
      [
        "import { StrictMode, useEffect, useState } from 'react';",
        "import { createRoot } from 'react-dom/client';",
        '',
        `import { RUTA_ITEMS, type RespuestaItems } from '@${scope}/shared';`,
        '',
        'function App(): JSX.Element {',
        '  const [items, setItems] = useState<RespuestaItems[\'items\']>([]);',
        '',
        '  useEffect(() => {',
        '    const control = new AbortController();',
        '    fetch(RUTA_ITEMS, { signal: control.signal })',
        '      .then((respuesta) => respuesta.json() as Promise<RespuestaItems>)',
        '      .then((datos) => setItems(datos.items))',
        '      .catch(() => undefined);',
        '    // Abortar en la limpieza evita actualizar un componente desmontado.',
        '    return () => control.abort();',
        '  }, []);',
        '',
        '  return (',
        '    <main>',
        '      <h1>Monorepo ForgeJS</h1>',
        '      <ul>',
        '        {items.map((item) => (',
        '          <li key={item.id}>{item.nombre}</li>',
        '        ))}',
        '      </ul>',
        '    </main>',
        '  );',
        '}',
        '',
        "const contenedor = document.getElementById('root');",
        'if (contenedor === null) {',
        "  throw new Error('No se encontro #root.');",
        '}',
        'createRoot(contenedor).render(',
        '  <StrictMode>',
        '    <App />',
        '  </StrictMode>,',
        ');',
        '',
      ].join('\n'),
    );
    files.set(
      'apps/web/tsconfig.json',
      tsconfig({ lib: ['ES2022', 'DOM', 'DOM.Iterable'], jsx: 'react-jsx', types: ['vite/client'], paths: {} }),
    );
    return;
  }

  /* --- Vue --- */
  files.set(
    'apps/web/package.json',
    json({
      name: `@${scope}/web`,
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: { dev: 'vite --port 5173', build: 'vue-tsc --noEmit && vite build' },
      dependencies: { vue: '^3.5.13', [`@${scope}/shared`]: 'workspace:*' },
      devDependencies: {
        '@vitejs/plugin-vue': '^5.2.1',
        typescript: '^5.7.2',
        'vue-tsc': '^2.2.0',
        vite: '^6.0.5',
      },
    }),
  );
  files.set(
    'apps/web/vite.config.ts',
    [
      "import vue from '@vitejs/plugin-vue';",
      "import { defineConfig } from 'vite';",
      '',
      'export default defineConfig({',
      '  plugins: [vue()],',
      "  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },",
      '});',
      '',
    ].join('\n'),
  );
  files.set(
    'apps/web/index.html',
    '<!doctype html>\n<html lang="es">\n  <head>\n    <meta charset="UTF-8" />\n    <title>Web</title>\n  </head>\n  <body>\n    <div id="app"></div>\n    <script type="module" src="/src/main.ts"></script>\n  </body>\n</html>\n',
  );
  files.set(
    'apps/web/src/main.ts',
    ["import { createApp } from 'vue';", '', "import App from './App.vue';", '', "createApp(App).mount('#app');", ''].join('\n'),
  );
  files.set(
    'apps/web/src/App.vue',
    [
      '<script setup lang="ts">',
      "import { onMounted, ref } from 'vue';",
      '',
      `import { RUTA_ITEMS, type RespuestaItems } from '@${scope}/shared';`,
      '',
      "const items = ref<RespuestaItems['items']>([]);",
      '',
      'onMounted(async () => {',
      '  const respuesta = await fetch(RUTA_ITEMS);',
      '  const datos = (await respuesta.json()) as RespuestaItems;',
      '  items.value = datos.items;',
      '});',
      '</script>',
      '',
      '<template>',
      '  <main>',
      '    <h1>Monorepo ForgeJS</h1>',
      '    <ul>',
      '      <li v-for="item in items" :key="item.id">{{ item.nombre }}</li>',
      '    </ul>',
      '  </main>',
      '</template>',
      '',
    ].join('\n'),
  );
  files.set(
    'apps/web/tsconfig.json',
    tsconfig({ lib: ['ES2022', 'DOM', 'DOM.Iterable'], types: ['vite/client'], include: ['src/**/*.ts', 'src/**/*.vue'], paths: {} }),
  );
}

function apiPackage(files: FileMap, back: BackChoice, scope: string): void {
  if (back === 'express') {
    files.set(
      'apps/api/package.json',
      json({
        name: `@${scope}/api`,
        version: '0.1.0',
        private: true,
        type: 'module',
        main: 'dist/main.js',
        scripts: { dev: 'tsx watch src/main.ts', build: 'tsc -p tsconfig.json', start: 'node dist/main.js' },
        dependencies: { express: '^4.21.2', helmet: '^8.0.0', cors: '^2.8.5', [`@${scope}/shared`]: 'workspace:*' },
        devDependencies: {
          '@types/cors': '^2.8.17',
          '@types/express': '^5.0.0',
          '@types/node': '^22.10.2',
          tsx: '^4.19.2',
          typescript: '^5.7.2',
        },
      }),
    );
    files.set(
      'apps/api/src/main.ts',
      [
        "import cors from 'cors';",
        "import express from 'express';",
        "import helmet from 'helmet';",
        '',
        `import { RUTA_ITEMS, type Item, type RespuestaItems } from '@${scope}/shared';`,
        '',
        'const app = express();',
        'app.use(helmet());',
        'app.use(cors());',
        'app.use(express.json());',
        '',
        'const items: Item[] = [',
        "  { id: '1', nombre: 'Tornillo', cantidad: 10 },",
        "  { id: '2', nombre: 'Tuerca', cantidad: 24 },",
        '];',
        '',
        "app.get('/health', (_peticion, respuesta) => {",
        "  respuesta.json({ estado: 'ok' });",
        '});',
        '',
        'app.get(RUTA_ITEMS, (_peticion, respuesta) => {',
        '  const cuerpo: RespuestaItems = { items };',
        '  respuesta.json(cuerpo);',
        '});',
        '',
        "const puerto = Number.parseInt(process.env.PORT ?? '3000', 10);",
        'app.listen(puerto, () => {',
        '  console.log(`Server listening on port ${puerto}`);',
        '});',
        '',
      ].join('\n'),
    );
    files.set(
      'apps/api/tsconfig.json',
      tsconfig({ module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: false, types: ['node'], paths: {} }),
    );
    return;
  }

  /* --- NestJS --- */
  files.set(
    'apps/api/package.json',
    json({
      name: `@${scope}/api`,
      version: '0.1.0',
      private: true,
      scripts: { dev: 'nest start --watch', build: 'nest build', start: 'node dist/main.js' },
      dependencies: {
        '@nestjs/common': '^10.4.15',
        '@nestjs/core': '^10.4.15',
        '@nestjs/platform-express': '^10.4.15',
        'reflect-metadata': '^0.2.2',
        rxjs: '^7.8.1',
        [`@${scope}/shared`]: 'workspace:*',
      },
      devDependencies: {
        '@nestjs/cli': '^10.4.9',
        '@types/node': '^22.10.2',
        typescript: '^5.7.2',
      },
    }),
  );
  files.set('apps/api/nest-cli.json', json({ sourceRoot: 'src', compilerOptions: { deleteOutDir: true } }));
  files.set(
    'apps/api/src/main.ts',
    [
      "import 'reflect-metadata';",
      '',
      "import { NestFactory } from '@nestjs/core';",
      '',
      "import { AppModule } from './app.module.js';",
      '',
      'async function arrancar(): Promise<void> {',
      '  const app = await NestFactory.create(AppModule);',
      '  app.enableCors();',
      "  await app.listen(Number.parseInt(process.env.PORT ?? '3000', 10));",
      '}',
      '',
      'void arrancar();',
      '',
    ].join('\n'),
  );
  files.set(
    'apps/api/src/app.module.ts',
    [
      "import { Controller, Get, Module } from '@nestjs/common';",
      '',
      `import type { RespuestaItems } from '@${scope}/shared';`,
      '',
      '@Controller()',
      'class ItemsController {',
      "  @Get('health')",
      '  salud(): { estado: string } {',
      "    return { estado: 'ok' };",
      '  }',
      '',
      "  @Get('api/items')",
      '  listar(): RespuestaItems {',
      '    return {',
      '      items: [',
      "        { id: '1', nombre: 'Tornillo', cantidad: 10 },",
      "        { id: '2', nombre: 'Tuerca', cantidad: 24 },",
      '      ],',
      '    };',
      '  }',
      '}',
      '',
      '@Module({ controllers: [ItemsController] })',
      'export class AppModule {}',
      '',
    ].join('\n'),
  );
  files.set(
    'apps/api/tsconfig.json',
    tsconfig({
      module: 'CommonJS',
      moduleResolution: 'Node',
      noEmit: false,
      types: ['node'],
      paths: {},
      extra: {
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        strictPropertyInitialization: false,
        useDefineForClassFields: false,
      },
    }),
  );
}

/* -------------------------------------------------------------------------- */
/*  Turborepo                                                                  */
/* -------------------------------------------------------------------------- */

const TURBOREPO: BlueprintDefinition = {
  id: 'turborepo',
  label: 'Monorepo Turborepo',
  category: 'monorepo',
  description:
    'Monorepo con Turborepo: apps/web, apps/api y packages/shared, con cache de tareas y pipeline DotForge de arranque conjunto.',
  tags: ['turborepo', 'monorepo', 'workspaces'],
  options: [STACK_OPTION, DATABASE_OPTION, REDIS_OPTION, LINTER_OPTION, TEST_RUNNER_OPTION],

  build(context) {
    const files: FileMap = new Map();
    const scope = context.packageName;
    const { front, back } = stackOf(context);

    files.set(
      'package.json',
      json({
        name: scope,
        private: true,
        version: '0.1.0',
        packageManager: context.packageManager === 'pnpm' ? 'pnpm@9.15.2' : undefined,
        workspaces: context.packageManager === 'pnpm' ? undefined : ['apps/*', 'packages/*'],
        scripts: {
          dev: 'turbo run dev',
          build: 'turbo run build',
          typecheck: 'turbo run typecheck',
          ...qualityScripts(context),
        },
        devDependencies: {
          turbo: '^2.3.3',
          typescript: '^5.7.2',
          ...qualityDependencies(context, front === 'react'),
        },
      }),
    );

    if (context.packageManager === 'pnpm') {
      files.set('pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n  - 'packages/*'\n");
    }

    files.set(
      'turbo.json',
      json({
        $schema: 'https://turbo.build/schema.json',
        tasks: {
          build: { dependsOn: ['^build'], outputs: ['dist/**', '.next/**', '!.next/cache/**'] },
          // `dev` es persistente: Turbo no debe esperar a que termine.
          dev: { cache: false, persistent: true },
          typecheck: { dependsOn: ['^build'] },
          lint: {},
          test: { dependsOn: ['^build'] },
        },
      }),
    );

    sharedPackage(files, scope);
    webPackage(files, front, scope);
    apiPackage(files, back, scope);

    addQualityTooling(files, context, { react: front === 'react' });
    files.set('.gitignore', gitignore(['.turbo/']));
    files.set('.editorconfig', editorconfig());
    files.set('.env.example', envExample({ PORT: '3000', NODE_ENV: 'development' }));

    const database = context.choice('database', 'postgres');
    if (database !== 'none' || context.flag('redis')) {
      files.set(
        'docker-compose.yml',
        dockerCompose(database as 'postgres', context.flag('redis'), scope),
      );
    }

    files.set(
      'dotforge.config.json',
      dotforgeConfig({
        name: scope,
        version: '0.1.0',
        preset: 'turborepo',
        packageManager: context.packageManager,
        workspaces: ['apps/*', 'packages/*'],
        tasks: {
          web: {
            label: 'Interfaz',
            command: `${context.packageManager} --filter @${scope}/web dev`,
            port: 5173,
            readyPattern: 'ready in|Local:',
            watch: true,
          },
          api: {
            label: 'API',
            command: `${context.packageManager} --filter @${scope}/api dev`,
            port: 3000,
            readyPattern: back === 'nestjs' ? 'Nest application successfully started' : 'Server listening on',
            watch: true,
          },
          build: { label: 'Compilar todo', script: 'build' },
          typecheck: { label: 'Comprobar tipos', script: 'typecheck' },
        },
        pipelines: {
          dev: {
            label: 'Dev completo',
            description: 'Levanta la interfaz y la API a la vez.',
            tasks: ['web', 'api'],
            parallel: true,
            environment: 'local',
          },
          ci: { label: 'Verificacion', tasks: ['typecheck', 'build'], parallel: false, stopOnError: true },
        },
        environments: { local: { label: 'Local', envFiles: ['.env'], secrets: ['DATABASE_URL'] } },
        ...(database === 'none'
          ? {}
          : {
              services: [
                { name: 'db', kind: database as 'postgres', composeFile: 'docker-compose.yml', composeService: 'db' },
              ],
            }),
      }),
    );

    files.set(
      'README.md',
      readme({
        title: context.projectName,
        description: `Monorepo Turborepo con ${front === 'react' ? 'React' : 'Vue'} y ${back === 'nestjs' ? 'NestJS' : 'Express'}.`,
        packageManager: context.packageManager,
        commands: [
          { command: 'dev', description: 'Levanta todas las aplicaciones.' },
          { command: 'build', description: 'Compila respetando el grafo de dependencias.' },
          { command: 'typecheck', description: 'Comprueba los tipos de todo el monorepo.' },
        ],
        structure: [
          'apps/',
          '  web/       interfaz',
          '  api/       servidor',
          'packages/',
          '  shared/    contrato compartido',
          'turbo.json',
        ],
        notes: [
          'El pipeline "Dev completo" de DotForge levanta web y api a la vez, cada una con su canal de salida.',
        ],
      }),
    );
    return files;
  },

  nextSteps(context) {
    return [
      `${context.packageManager} install`,
      ...(context.choice('database', 'postgres') === 'none' ? [] : ['docker compose up -d']),
      `${context.packageManager} run dev`,
      'Interfaz en http://localhost:5173 · API en http://localhost:3000',
    ];
  },
};

/* -------------------------------------------------------------------------- */
/*  Nx                                                                         */
/* -------------------------------------------------------------------------- */

const NX: BlueprintDefinition = {
  id: 'nx',
  label: 'Monorepo Nx',
  category: 'monorepo',
  description:
    'Monorepo con Nx: grafo de dependencias, cache de tareas y las mismas aplicaciones web y api con paquete compartido.',
  tags: ['nx', 'monorepo', 'workspaces'],
  options: [STACK_OPTION, DATABASE_OPTION, REDIS_OPTION, LINTER_OPTION, TEST_RUNNER_OPTION],

  build(context) {
    const files: FileMap = new Map();
    const scope = context.packageName;
    const { front, back } = stackOf(context);

    files.set(
      'package.json',
      json({
        name: scope,
        private: true,
        version: '0.1.0',
        workspaces: ['apps/*', 'packages/*'],
        scripts: {
          dev: 'nx run-many --target=dev --all --parallel=4',
          build: 'nx run-many --target=build --all',
          typecheck: 'nx run-many --target=typecheck --all',
          graph: 'nx graph',
          ...qualityScripts(context),
        },
        devDependencies: {
          nx: '^20.3.0',
          typescript: '^5.7.2',
          ...qualityDependencies(context, front === 'react'),
        },
      }),
    );

    files.set(
      'nx.json',
      json({
        $schema: './node_modules/nx/schemas/nx-schema.json',
        namedInputs: {
          default: ['{projectRoot}/**/*'],
          production: ['default', '!{projectRoot}/**/*.spec.ts'],
        },
        targetDefaults: {
          build: { dependsOn: ['^build'], inputs: ['production', '^production'], cache: true },
          typecheck: { dependsOn: ['^build'], cache: true },
          dev: { cache: false },
        },
      }),
    );

    sharedPackage(files, scope);
    webPackage(files, front, scope);
    apiPackage(files, back, scope);

    // Nx necesita un `project.json` por paquete para conocer sus objetivos.
    for (const [name, root] of [
      ['web', 'apps/web'],
      ['api', 'apps/api'],
      ['shared', 'packages/shared'],
    ] as const) {
      files.set(
        `${root}/project.json`,
        json({
          name,
          $schema: '../../node_modules/nx/schemas/project-schema.json',
          sourceRoot: `${root}/src`,
          projectType: root.startsWith('apps') ? 'application' : 'library',
          targets: {
            dev: { executor: 'nx:run-commands', options: { command: 'npm run dev', cwd: root } },
            build: { executor: 'nx:run-commands', options: { command: 'npm run build', cwd: root } },
            typecheck: { executor: 'nx:run-commands', options: { command: 'npm run typecheck', cwd: root } },
          },
        }),
      );
    }

    addQualityTooling(files, context, { react: front === 'react' });
    files.set('.gitignore', gitignore(['.nx/']));
    files.set('.editorconfig', editorconfig());
    files.set('.env.example', envExample({ PORT: '3000', NODE_ENV: 'development' }));

    const database = context.choice('database', 'postgres');
    if (database !== 'none' || context.flag('redis')) {
      files.set('docker-compose.yml', dockerCompose(database as 'postgres', context.flag('redis'), scope));
    }

    files.set(
      'dotforge.config.json',
      dotforgeConfig({
        name: scope,
        version: '0.1.0',
        preset: 'nx',
        packageManager: context.packageManager,
        workspaces: ['apps/*', 'packages/*'],
        tasks: {
          web: { label: 'Interfaz', command: 'npx nx run web:dev', port: 5173, readyPattern: 'ready in|Local:', watch: true },
          api: {
            label: 'API',
            command: 'npx nx run api:dev',
            port: 3000,
            readyPattern: back === 'nestjs' ? 'Nest application successfully started' : 'Server listening on',
            watch: true,
          },
          build: { label: 'Compilar todo', script: 'build' },
          typecheck: { label: 'Comprobar tipos', script: 'typecheck' },
          graph: { label: 'Grafo de dependencias', script: 'graph' },
        },
        pipelines: {
          dev: { label: 'Dev completo', tasks: ['web', 'api'], parallel: true, environment: 'local' },
          ci: { label: 'Verificacion', tasks: ['typecheck', 'build'], parallel: false, stopOnError: true },
        },
        environments: { local: { label: 'Local', envFiles: ['.env'], secrets: ['DATABASE_URL'] } },
      }),
    );

    files.set(
      'README.md',
      readme({
        title: context.projectName,
        description: `Monorepo Nx con ${front === 'react' ? 'React' : 'Vue'} y ${back === 'nestjs' ? 'NestJS' : 'Express'}.`,
        packageManager: context.packageManager,
        commands: [
          { command: 'dev', description: 'Levanta todos los objetivos `dev`.' },
          { command: 'build', description: 'Compila respetando el grafo.' },
          { command: 'graph', description: 'Abre el grafo de dependencias.' },
        ],
        structure: ['apps/web/', 'apps/api/', 'packages/shared/', 'nx.json'],
      }),
    );
    return files;
  },

  nextSteps(context) {
    return [
      `${context.packageManager} install`,
      ...(context.choice('database', 'postgres') === 'none' ? [] : ['docker compose up -d']),
      `${context.packageManager} run dev`,
      'Interfaz en http://localhost:5173 · API en http://localhost:3000',
    ];
  },
};

export const MONOREPO_BLUEPRINTS: readonly BlueprintDefinition[] = [TURBOREPO, NX];
