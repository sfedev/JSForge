/**
 * Pruebas de las variantes arquitectonicas.
 *
 * Lo que se verifica no es solo que aparezcan las carpetas, sino que las
 * reglas de dependencia del patron se cumplan en el codigo generado: una
 * arquitectura cuyas capas se importan al reves no es esa arquitectura.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { findBlueprint, listBlueprints } from '../src/main/services/dotforge/generator/index.js';
import type { FileMap } from '../src/main/services/dotforge/generator/types.js';

/** Construye el arbol de un blueprint con las opciones indicadas. */
function planFor(blueprintId: string, options: Record<string, string | boolean> = {}): FileMap {
  const blueprint = findBlueprint(blueprintId);
  assert.ok(blueprint !== undefined, `blueprint ${blueprintId} no encontrado`);

  const merged: Record<string, string | boolean> = {};
  for (const option of blueprint.options) {
    merged[option.id] = option.default;
  }
  Object.assign(merged, options);

  return blueprint.build({
    projectName: 'Proyecto Demo',
    packageName: 'proyecto-demo',
    packageManager: 'pnpm',
    options: merged,
    flag: (id) => merged[id] === true || merged[id] === 'true',
    choice: (id, fallback) => {
      const value = merged[id];
      return typeof value === 'string' && value !== '' ? value : fallback;
    },
  });
}

/** Rutas que empiezan por el prefijo dado. */
function under(files: FileMap, prefix: string): string[] {
  return [...files.keys()].filter((key) => key.startsWith(prefix));
}

/* -------------------------------------------------------------------------- */
/*  Catalogo                                                                   */
/* -------------------------------------------------------------------------- */

test('los blueprints con arquitectura elegible declaran la opcion', () => {
  const conArquitectura = listBlueprints().filter((blueprint) =>
    blueprint.options.some((option) => option.id === 'architecture'),
  );
  const ids = conArquitectura.map((blueprint) => blueprint.id).sort();
  assert.deepEqual(ids, ['angular-standalone', 'express', 'fastify', 'nestjs-modular', 'react-vite']);
});

/* -------------------------------------------------------------------------- */
/*  React                                                                      */
/* -------------------------------------------------------------------------- */

test('Feature-Sliced genera las siete capas', () => {
  const files = planFor('react-vite', { architecture: 'feature-sliced' });
  for (const capa of ['app', 'processes', 'pages', 'widgets', 'features', 'entities', 'shared']) {
    assert.ok(
      under(files, `src/${capa}/`).length > 0,
      `falta la capa ${capa}`,
    );
  }
});

test('en Feature-Sliced la capa shared no importa de ninguna otra', () => {
  const files = planFor('react-vite', { architecture: 'feature-sliced' });
  for (const ruta of under(files, 'src/shared/')) {
    const contenido = files.get(ruta) ?? '';
    for (const superior of ['entities', 'features', 'widgets', 'pages', 'processes', 'app']) {
      assert.equal(
        contenido.includes(`@/${superior}`),
        false,
        `${ruta} importa de la capa superior ${superior}`,
      );
    }
  }
});

test('en Feature-Sliced las entidades no importan features ni widgets', () => {
  const files = planFor('react-vite', { architecture: 'feature-sliced' });
  for (const ruta of under(files, 'src/entities/')) {
    const contenido = files.get(ruta) ?? '';
    assert.equal(contenido.includes('@/features'), false, `${ruta} importa una feature`);
    assert.equal(contenido.includes('@/widgets'), false, `${ruta} importa un widget`);
  }
});

test('Atomic Design genera los cinco niveles', () => {
  const files = planFor('react-vite', { architecture: 'atomic' });
  for (const nivel of ['atoms', 'molecules', 'organisms', 'templates', 'pages']) {
    assert.ok(
      under(files, `src/components/${nivel}/`).length > 0,
      `falta el nivel ${nivel}`,
    );
  }
});

test('en Atomic Design un atomo no compone niveles superiores', () => {
  const files = planFor('react-vite', { architecture: 'atomic' });
  for (const ruta of under(files, 'src/components/atoms/')) {
    const contenido = files.get(ruta) ?? '';
    for (const superior of ['molecules', 'organisms', 'templates', 'pages']) {
      assert.equal(
        contenido.includes(`../${superior}/`),
        false,
        `${ruta} compone ${superior}`,
      );
    }
  }
});

test('Modular DDD separa dominio, infraestructura e interfaz', () => {
  const files = planFor('react-vite', { architecture: 'modular-ddd' });
  assert.ok(under(files, 'src/modules/tareas/domain/').length > 0);
  assert.ok(under(files, 'src/modules/tareas/infrastructure/').length > 0);
  assert.ok(under(files, 'src/modules/tareas/ui/').length > 0);
  assert.ok(files.has('src/modules/tareas/index.ts'), 'falta la API publica del modulo');
});

test('en Modular DDD el dominio no conoce React ni la red', () => {
  const files = planFor('react-vite', { architecture: 'modular-ddd' });
  for (const ruta of under(files, 'src/modules/tareas/domain/')) {
    const contenido = files.get(ruta) ?? '';
    assert.equal(/from 'react'/.test(contenido), false, `${ruta} importa React`);
    assert.equal(/\bfetch\(/.test(contenido), false, `${ruta} usa fetch`);
    assert.equal(contenido.includes('../infrastructure/'), false, `${ruta} importa infraestructura`);
  }
});

test('cada arquitectura de React deja un unico punto de entrada coherente', () => {
  for (const architecture of ['standard', 'feature-sliced', 'atomic', 'modular-ddd']) {
    const files = planFor('react-vite', { architecture });
    const main = files.get('src/main.tsx');
    assert.ok(main !== undefined, `${architecture}: falta src/main.tsx`);
    assert.ok(main.includes('createRoot'), `${architecture}: main.tsx no monta la app`);
    // No deben quedar archivos del blueprint sin arquitectura.
    assert.equal(
      [...files.keys()].some((key) => key.startsWith('__blueprint')),
      false,
      `${architecture}: quedaron marcadores del blueprint`,
    );
  }
});

test('CSS Modules coloca la hoja junto al componente raiz', () => {
  const files = planFor('react-vite', { architecture: 'feature-sliced', styling: 'css-modules' });
  assert.ok(files.has('src/pages/inicio/ui/PaginaInicio.module.css'));
  assert.ok(files.get('src/pages/inicio/ui/PaginaInicio.tsx')?.includes('estilos.contenedor'));

  const sinModulos = planFor('react-vite', { architecture: 'feature-sliced', styling: 'plain' });
  assert.equal(sinModulos.has('src/pages/inicio/ui/PaginaInicio.module.css'), false);
});

/* -------------------------------------------------------------------------- */
/*  Angular                                                                    */
/* -------------------------------------------------------------------------- */

test('Angular Clean Standalone genera features, data-access y ui', () => {
  const files = planFor('angular-standalone', { architecture: 'clean-standalone' });
  assert.ok(under(files, 'src/app/features/').length > 0);
  assert.ok(under(files, 'src/app/data-access/').length > 0);
  assert.ok(under(files, 'src/app/ui/').length > 0);
});

test('en Clean Standalone los componentes de ui no inyectan servicios', () => {
  const files = planFor('angular-standalone', { architecture: 'clean-standalone' });
  for (const ruta of under(files, 'src/app/ui/')) {
    const contenido = files.get(ruta) ?? '';
    assert.equal(/\binject\(/.test(contenido), false, `${ruta} inyecta un servicio`);
  }
});

test('Angular DDD genera core, features y shared', () => {
  const files = planFor('angular-standalone', { architecture: 'ddd-monorepo' });
  assert.ok(under(files, 'src/app/core/').length > 0);
  assert.ok(under(files, 'src/app/features/').length > 0);
  assert.ok(under(files, 'src/app/shared/ui/').length > 0);
  assert.ok(under(files, 'src/app/shared/utils/').length > 0);
});

test('en Angular DDD el dominio de una feature no depende de Angular', () => {
  const files = planFor('angular-standalone', { architecture: 'ddd-monorepo' });
  const dominio = under(files, 'src/app/features/tareas/domain/');
  assert.ok(dominio.length > 0);
  for (const ruta of dominio) {
    assert.equal(
      /from '@angular\//.test(files.get(ruta) ?? ''),
      false,
      `${ruta} importa Angular`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/*  Backend                                                                    */
/* -------------------------------------------------------------------------- */

const BACKENDS = ['express', 'nestjs-modular', 'fastify'] as const;

test('la arquitectura hexagonal genera domain, application, infrastructure y adapters', () => {
  for (const blueprintId of BACKENDS) {
    const files = planFor(blueprintId, { architecture: 'hexagonal' });
    for (const capa of ['domain', 'application', 'infrastructure', 'adapters']) {
      assert.ok(
        under(files, `src/${capa}/`).length > 0,
        `${blueprintId}: falta la capa ${capa}`,
      );
    }
    assert.ok(
      under(files, 'src/domain/ports/').length > 0,
      `${blueprintId}: la hexagonal debe declarar puertos`,
    );
  }
});

test('en la hexagonal el dominio no importa de ninguna otra capa', () => {
  for (const blueprintId of BACKENDS) {
    const files = planFor(blueprintId, { architecture: 'hexagonal' });
    for (const ruta of under(files, 'src/domain/')) {
      const contenido = files.get(ruta) ?? '';
      for (const prohibido of ['../application/', '../infrastructure/', '../adapters/', '../../infrastructure/']) {
        assert.equal(
          contenido.includes(prohibido),
          false,
          `${blueprintId}/${ruta} importa ${prohibido}`,
        );
      }
      for (const framework of ['express', '@nestjs/', 'fastify']) {
        assert.equal(
          contenido.includes(`from '${framework}`),
          false,
          `${blueprintId}/${ruta} importa el framework ${framework}`,
        );
      }
    }
  }
});

test('en la hexagonal los casos de uso no conocen el framework', () => {
  for (const blueprintId of BACKENDS) {
    const files = planFor(blueprintId, { architecture: 'hexagonal' });
    for (const ruta of under(files, 'src/application/')) {
      const contenido = files.get(ruta) ?? '';
      for (const framework of ["from 'express'", "from '@nestjs/", "from 'fastify'"]) {
        assert.equal(contenido.includes(framework), false, `${blueprintId}/${ruta} usa ${framework}`);
      }
    }
  }
});

test('la arquitectura por capas genera controllers, services, repositories y entities', () => {
  for (const blueprintId of BACKENDS) {
    const files = planFor(blueprintId, { architecture: 'layered' });
    for (const capa of ['controllers', 'services', 'repositories', 'entities']) {
      assert.ok(
        under(files, `src/${capa}/`).length > 0,
        `${blueprintId}: falta la capa ${capa}`,
      );
    }
    assert.equal(
      under(files, 'src/domain/').length,
      0,
      `${blueprintId}: la variante por capas no debe dejar restos de la hexagonal`,
    );
  }
});

test('en la variante por capas el controlador no toca el repositorio', () => {
  for (const blueprintId of BACKENDS) {
    const files = planFor(blueprintId, { architecture: 'layered' });
    for (const ruta of under(files, 'src/controllers/')) {
      const contenido = files.get(ruta) ?? '';
      assert.equal(
        /repositories\//.test(contenido),
        false,
        `${blueprintId}/${ruta} salta el servicio y va al repositorio`,
      );
    }
  }
});

test('cambiar de arquitectura no deja archivos huerfanos de la otra', () => {
  const hexagonal = planFor('express', { architecture: 'hexagonal' });
  const capas = planFor('express', { architecture: 'layered' });

  assert.equal(under(capas, 'src/domain/').length, 0);
  assert.equal(under(capas, 'src/adapters/').length, 0);
  assert.equal(under(hexagonal, 'src/controllers/').length, 0);
  assert.equal(under(hexagonal, 'src/services/').length, 0);
});

test('las dos variantes de backend conservan el punto de entrada y el ORM', () => {
  for (const architecture of ['hexagonal', 'layered']) {
    const files = planFor('express', { architecture, orm: 'prisma' });
    assert.ok(files.has('src/main.ts'), `${architecture}: falta src/main.ts`);
    assert.ok(files.has('prisma/schema.prisma'), `${architecture}: falta el esquema Prisma`);
    assert.ok(
      files.has('src/infrastructure/persistence/prisma-client.ts'),
      `${architecture}: falta el cliente de Prisma`,
    );
  }
});
