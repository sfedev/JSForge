/**
 * Variantes arquitectonicas para Angular.
 *
 * Ambas usan componentes standalone y senales; lo que cambia es como se
 * reparte el codigo y quien puede depender de quien.
 */

import type { ArchitectureTree } from './types.js';

export type AngularArchitecture = 'clean-standalone' | 'ddd-monorepo';

/** Arranque comun a las dos variantes. */
function bootstrapFiles(files: Map<string, string>, routesPath: string): void {
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
    'src/app/app.config.ts',
    [
      "import type { ApplicationConfig } from '@angular/core';",
      "import { provideZoneChangeDetection } from '@angular/core';",
      "import { provideRouter } from '@angular/router';",
      '',
      `import { routes } from '${routesPath}';`,
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
    'src/app/app.component.ts',
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
}

/* -------------------------------------------------------------------------- */
/*  Clean Standalone                                                           */
/* -------------------------------------------------------------------------- */

function cleanStandalone(projectName: string): ArchitectureTree {
  const files = new Map<string, string>();
  bootstrapFiles(files, './app.routes');

  files.set(
    'src/app/app.routes.ts',
    [
      "import type { Routes } from '@angular/router';",
      '',
      'export const routes: Routes = [',
      '  {',
      "    path: '',",
      '    loadComponent: async () =>',
      "      (await import('./features/tareas/tareas.page')).TareasPage,",
      '  },',
      '];',
      '',
    ].join('\n'),
  );

  /* --- ui: presentacion pura --- */
  files.set(
    'src/app/ui/tarea-item.component.ts',
    [
      "import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';",
      '',
      "import type { Tarea } from '../data-access/tarea.model';",
      '',
      '/**',
      ' * Componente de presentacion: recibe datos y emite eventos, no sabe de',
      ' * donde vienen ni a donde van.',
      ' */',
      '@Component({',
      "  selector: 'app-tarea-item',",
      '  standalone: true,',
      '  changeDetection: ChangeDetectionStrategy.OnPush,',
      '  template: `',
      '    <button type="button" (click)="alternar.emit()">',
      "      {{ tarea().completada ? '[x]' : '[ ]' }} {{ tarea().titulo }}",
      '    </button>',
      '  `,',
      '})',
      'export class TareaItem {',
      '  readonly tarea = input.required<Tarea>();',
      '  readonly alternar = output<void>();',
      '}',
      '',
    ].join('\n'),
  );

  /* --- data-access: estado y acceso a datos --- */
  files.set(
    'src/app/data-access/tarea.model.ts',
    [
      'export interface Tarea {',
      '  readonly id: string;',
      '  readonly titulo: string;',
      '  readonly completada: boolean;',
      '}',
      '',
    ].join('\n'),
  );
  files.set(
    'src/app/data-access/tareas.store.ts',
    [
      "import { computed, Injectable, signal } from '@angular/core';",
      '',
      "import type { Tarea } from './tarea.model';",
      '',
      '/**',
      ' * Estado con senales. `data-access` es la unica capa que conoce el',
      ' * origen de los datos; `ui` y `features` la consumen.',
      ' */',
      "@Injectable({ providedIn: 'root' })",
      'export class TareasStore {',
      '  readonly #tareas = signal<readonly Tarea[]>([',
      "    { id: '1', titulo: 'Revisar la arquitectura', completada: false },",
      "    { id: '2', titulo: 'Anadir una feature', completada: false },",
      '  ]);',
      '',
      '  readonly tareas = this.#tareas.asReadonly();',
      '  readonly pendientes = computed(() => this.#tareas().filter((tarea) => !tarea.completada).length);',
      '',
      '  alternar(id: string): void {',
      '    this.#tareas.update((actuales) =>',
      '      actuales.map((tarea) =>',
      '        tarea.id === id ? { ...tarea, completada: !tarea.completada } : tarea,',
      '      ),',
      '    );',
      '  }',
      '}',
      '',
    ].join('\n'),
  );

  /* --- features: composicion --- */
  files.set(
    'src/app/features/tareas/tareas.page.ts',
    [
      "import { ChangeDetectionStrategy, Component, inject } from '@angular/core';",
      '',
      "import { TareasStore } from '../../data-access/tareas.store';",
      "import { TareaItem } from '../../ui/tarea-item.component';",
      '',
      '@Component({',
      "  selector: 'app-tareas-page',",
      '  standalone: true,',
      '  imports: [TareaItem],',
      '  changeDetection: ChangeDetectionStrategy.OnPush,',
      '  template: `',
      '    <main class="contenedor">',
      `      <h1>${projectName}</h1>`,
      '      <p>{{ store.pendientes() }} pendientes</p>',
      '      <ul>',
      '        @for (tarea of store.tareas(); track tarea.id) {',
      '          <li>',
      '            <app-tarea-item [tarea]="tarea" (alternar)="store.alternar(tarea.id)" />',
      '          </li>',
      '        }',
      '      </ul>',
      '    </main>',
      '  `,',
      '})',
      'export class TareasPage {',
      '  protected readonly store = inject(TareasStore);',
      '}',
      '',
    ].join('\n'),
  );

  return {
    files,
    structure: [
      'src/app/',
      '  features/       una carpeta por pantalla o caso de uso',
      '  data-access/    estado con senales y acceso a datos',
      '  ui/             componentes de presentacion, sin estado',
      '  app.routes.ts   rutas con carga diferida',
    ],
    description:
      'Clean Standalone: tres capas ligeras con componentes standalone, senales y OnPush.',
    notes: [
      '`ui` no inyecta servicios: recibe por `input()` y avisa por `output()`.',
      'Las rutas cargan las features con `loadComponent`, asi cada una viaja en su propio fragmento.',
    ],
  };
}

/* -------------------------------------------------------------------------- */
/*  DDD Enterprise                                                             */
/* -------------------------------------------------------------------------- */

function dddMonorepo(projectName: string): ArchitectureTree {
  const files = new Map<string, string>();
  bootstrapFiles(files, './core/routes');

  /* --- core: transversal, se carga una vez --- */
  files.set(
    'src/app/core/routes.ts',
    [
      "import type { Routes } from '@angular/router';",
      '',
      'export const routes: Routes = [',
      '  {',
      "    path: 'tareas',",
      '    loadChildren: async () =>',
      "      (await import('../features/tareas/tareas.routes')).tareasRoutes,",
      '  },',
      "  { path: '', pathMatch: 'full', redirectTo: 'tareas' },",
      '];',
      '',
    ].join('\n'),
  );
  files.set(
    'src/app/core/http/api.service.ts',
    [
      "import { Injectable } from '@angular/core';",
      '',
      '/**',
      ' * Servicio transversal. `core` contiene lo que existe una sola vez en',
      ' * la aplicacion: autenticacion, interceptores, configuracion.',
      ' */',
      "@Injectable({ providedIn: 'root' })",
      'export class ApiService {',
      "  readonly #base = '/api';",
      '',
      '  async get<T>(ruta: string): Promise<T> {',
      '    const respuesta = await fetch(`${this.#base}${ruta}`);',
      '    if (!respuesta.ok) {',
      '      throw new Error(`La API devolvio ${respuesta.status}.`);',
      '    }',
      '    return (await respuesta.json()) as T;',
      '  }',
      '}',
      '',
    ].join('\n'),
  );

  /* --- shared/utils --- */
  files.set(
    'src/app/shared/utils/fecha.ts',
    [
      '/** Utilidades puras: sin estado y sin dependencias de Angular. */',
      'export function formatearFecha(valor: Date): string {',
      "  return new Intl.DateTimeFormat('es', { dateStyle: 'medium' }).format(valor);",
      '}',
      '',
    ].join('\n'),
  );

  /* --- shared/ui --- */
  files.set(
    'src/app/shared/ui/boton.component.ts',
    [
      "import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';",
      '',
      '/** Primitiva reutilizable por cualquier feature. */',
      '@Component({',
      "  selector: 'app-boton',",
      '  standalone: true,',
      '  changeDetection: ChangeDetectionStrategy.OnPush,',
      '  template: `',
      '    <button type="button" [disabled]="deshabilitado()" (click)="pulsado.emit()">',
      '      <ng-content />',
      '    </button>',
      '  `,',
      '})',
      'export class Boton {',
      '  readonly deshabilitado = input(false);',
      '  readonly pulsado = output<void>();',
      '}',
      '',
    ].join('\n'),
  );

  /* --- features/<dominio> --- */
  files.set(
    'src/app/features/tareas/tareas.routes.ts',
    [
      "import type { Routes } from '@angular/router';",
      '',
      'export const tareasRoutes: Routes = [',
      '  {',
      "    path: '',",
      '    loadComponent: async () =>',
      "      (await import('./pages/lista-tareas.page')).ListaTareasPage,",
      '  },',
      '];',
      '',
    ].join('\n'),
  );
  files.set(
    'src/app/features/tareas/domain/tarea.ts',
    [
      '/** Modelo del dominio de la feature, sin dependencias de Angular. */',
      'export interface Tarea {',
      '  readonly id: string;',
      '  readonly titulo: string;',
      '  readonly completada: boolean;',
      '}',
      '',
      'export function alternar(tarea: Tarea): Tarea {',
      '  return { ...tarea, completada: !tarea.completada };',
      '}',
      '',
    ].join('\n'),
  );
  files.set(
    'src/app/features/tareas/data-access/tareas.store.ts',
    [
      "import { computed, Injectable, signal } from '@angular/core';",
      '',
      "import { alternar, type Tarea } from '../domain/tarea';",
      '',
      '/** Estado propio de la feature: no se declara en `providedIn: root`. */',
      '@Injectable()',
      'export class TareasStore {',
      '  readonly #tareas = signal<readonly Tarea[]>([',
      "    { id: '1', titulo: 'Definir los limites del dominio', completada: false },",
      "    { id: '2', titulo: 'Extraer lo comun a shared/', completada: false },",
      '  ]);',
      '',
      '  readonly tareas = this.#tareas.asReadonly();',
      '  readonly pendientes = computed(() => this.#tareas().filter((tarea) => !tarea.completada).length);',
      '',
      '  cambiar(id: string): void {',
      '    this.#tareas.update((actuales) =>',
      '      actuales.map((tarea) => (tarea.id === id ? alternar(tarea) : tarea)),',
      '    );',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  files.set(
    'src/app/features/tareas/pages/lista-tareas.page.ts',
    [
      "import { ChangeDetectionStrategy, Component, inject } from '@angular/core';",
      '',
      "import { Boton } from '../../../shared/ui/boton.component';",
      "import { TareasStore } from '../data-access/tareas.store';",
      '',
      '@Component({',
      "  selector: 'app-lista-tareas',",
      '  standalone: true,',
      '  imports: [Boton],',
      '  // El store se provee en la pagina: vive y muere con la feature.',
      '  providers: [TareasStore],',
      '  changeDetection: ChangeDetectionStrategy.OnPush,',
      '  template: `',
      '    <main class="contenedor">',
      `      <h1>${projectName}</h1>`,
      '      <p>{{ store.pendientes() }} pendientes</p>',
      '      <ul>',
      '        @for (tarea of store.tareas(); track tarea.id) {',
      '          <li>',
      '            <app-boton (pulsado)="store.cambiar(tarea.id)">',
      "              {{ tarea.completada ? '[x]' : '[ ]' }} {{ tarea.titulo }}",
      '            </app-boton>',
      '          </li>',
      '        }',
      '      </ul>',
      '    </main>',
      '  `,',
      '})',
      'export class ListaTareasPage {',
      '  protected readonly store = inject(TareasStore);',
      '}',
      '',
    ].join('\n'),
  );

  return {
    files,
    structure: [
      'src/app/',
      '  core/            transversal: rutas raiz, HTTP, autenticacion',
      '  features/<dom>/  cada dominio con domain/, data-access/ y pages/',
      '  shared/ui/       primitivas de interfaz reutilizables',
      '  shared/utils/    funciones puras sin estado',
    ],
    description:
      'DDD Enterprise: nucleo transversal, una carpeta por dominio y lo comun en shared, al estilo de un monorepo Nx.',
    notes: [
      'Una feature nunca importa de otra feature: lo comun sube a `shared/`.',
      '`core/` se carga una sola vez; los servicios de feature se proveen en su propia pagina.',
      'Si el proyecto crece, cada carpeta de `features/` se convierte en una libreria de Nx sin mover codigo.',
    ],
  };
}

/* -------------------------------------------------------------------------- */

export function buildAngularArchitecture(
  architecture: AngularArchitecture,
  projectName: string,
): ArchitectureTree {
  return architecture === 'ddd-monorepo'
    ? dddMonorepo(projectName)
    : cleanStandalone(projectName);
}
