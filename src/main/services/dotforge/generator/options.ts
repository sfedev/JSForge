/** Opciones comunes que comparten los blueprints del generador. */

import type { BlueprintOption } from '../../../../shared/contracts.js';

export const LINTER_OPTION: BlueprintOption = {
  id: 'linter',
  label: 'Calidad de codigo',
  description: 'ESLint 9 con configuracion plana y Prettier, o Biome todo en uno.',
  type: 'choice',
  default: 'eslint',
  choices: [
    { id: 'eslint', label: 'ESLint (flat config) + Prettier' },
    { id: 'biome', label: 'Biome' },
    { id: 'none', label: 'Ninguna' },
  ],
};

export const TEST_RUNNER_OPTION: BlueprintOption = {
  id: 'testRunner',
  label: 'Pruebas unitarias',
  type: 'choice',
  default: 'vitest',
  choices: [
    { id: 'vitest', label: 'Vitest' },
    { id: 'jest', label: 'Jest' },
    { id: 'none', label: 'Ninguna' },
  ],
};

export const PLAYWRIGHT_OPTION: BlueprintOption = {
  id: 'playwright',
  label: 'Pruebas end-to-end con Playwright',
  type: 'boolean',
  default: false,
};

export const STYLING_OPTION: BlueprintOption = {
  id: 'styling',
  label: 'Estilos',
  type: 'choice',
  default: 'tailwind',
  choices: [
    { id: 'tailwind', label: 'TailwindCSS' },
    { id: 'css-modules', label: 'CSS Modules' },
    { id: 'plain', label: 'CSS plano' },
  ],
};

export const DOCKER_OPTION: BlueprintOption = {
  id: 'docker',
  label: 'Dockerfile y docker-compose',
  type: 'boolean',
  default: true,
};

export const DATABASE_OPTION: BlueprintOption = {
  id: 'database',
  label: 'Base de datos en docker-compose',
  type: 'choice',
  default: 'postgres',
  choices: [
    { id: 'postgres', label: 'PostgreSQL' },
    { id: 'mysql', label: 'MySQL' },
    { id: 'mongo', label: 'MongoDB' },
    { id: 'none', label: 'Ninguna' },
  ],
};

export const REDIS_OPTION: BlueprintOption = {
  id: 'redis',
  label: 'Anadir Redis',
  type: 'boolean',
  default: false,
};

export const ORM_OPTION: BlueprintOption = {
  id: 'orm',
  label: 'Acceso a datos',
  type: 'choice',
  default: 'prisma',
  choices: [
    { id: 'prisma', label: 'Prisma' },
    { id: 'typeorm', label: 'TypeORM' },
    { id: 'drizzle', label: 'Drizzle' },
    { id: 'none', label: 'Sin ORM' },
  ],
};

/** Opciones comunes a las arquitecturas de interfaz. */
export const FRONTEND_OPTIONS: readonly BlueprintOption[] = [
  STYLING_OPTION,
  LINTER_OPTION,
  TEST_RUNNER_OPTION,
  PLAYWRIGHT_OPTION,
  DOCKER_OPTION,
];

/** Opciones comunes a las arquitecturas de servidor. */
export const BACKEND_OPTIONS: readonly BlueprintOption[] = [
  ORM_OPTION,
  DATABASE_OPTION,
  REDIS_OPTION,
  LINTER_OPTION,
  TEST_RUNNER_OPTION,
  DOCKER_OPTION,
];
