/**
 * Contrato de las variantes arquitectonicas.
 *
 * Una variante posee el arbol de `src/`; el blueprint sigue siendo dueno de
 * la configuracion (package.json, tsconfig, vite.config…). Esa division es
 * lo que permite combinar cualquier arquitectura con cualquier framework sin
 * duplicar plantillas.
 */

import type { BlueprintOption } from '../../../../../shared/contracts.js';

export interface ArchitectureTree {
  /** Archivos del arbol de fuentes: ruta relativa -> contenido. */
  readonly files: Map<string, string>;
  /** Lineas del bloque «Estructura» del README. */
  readonly structure: readonly string[];
  /** Una frase que explica el patron. */
  readonly description: string;
  /** Reglas que conviene no romper, para el README. */
  readonly notes: readonly string[];
}

/** Opcion de arquitectura para los blueprints de React y Next.js. */
export const REACT_ARCHITECTURE_OPTION: BlueprintOption = {
  id: 'architecture',
  label: 'Patron de arquitectura',
  description: 'Determina como se organiza `src/` y que reglas de dependencia se aplican.',
  type: 'choice',
  default: 'standard',
  choices: [
    { id: 'standard', label: 'Estandar (componentes planos)' },
    { id: 'feature-sliced', label: 'Feature-Sliced Design (FSD)' },
    { id: 'atomic', label: 'Atomic Design' },
    { id: 'modular-ddd', label: 'Modular / Domain-Driven' },
  ],
};

/** Opcion de arquitectura para Angular. */
export const ANGULAR_ARCHITECTURE_OPTION: BlueprintOption = {
  id: 'architecture',
  label: 'Patron de arquitectura',
  description: 'Determina como se organiza `src/app/`.',
  type: 'choice',
  default: 'clean-standalone',
  choices: [
    { id: 'clean-standalone', label: 'Clean Standalone (features / data-access / ui)' },
    { id: 'ddd-monorepo', label: 'DDD Enterprise (core / features / shared)' },
  ],
};

/** Opcion de arquitectura para los blueprints de servidor. */
export const BACKEND_ARCHITECTURE_OPTION: BlueprintOption = {
  id: 'architecture',
  label: 'Patron de arquitectura',
  description: 'Determina la separacion de capas y la direccion de las dependencias.',
  type: 'choice',
  default: 'hexagonal',
  choices: [
    { id: 'hexagonal', label: 'Hexagonal (puertos y adaptadores)' },
    { id: 'layered', label: 'Clean por capas (controllers / services / repositories)' },
  ],
};
