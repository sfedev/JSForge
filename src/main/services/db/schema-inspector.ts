/**
 * Inspector de esquemas de base de datos.
 *
 * Analiza el esquema declarado en el codigo, sin conectarse a ninguna base
 * de datos: abrir un proyecto no debe abrir conexiones ni pedir credenciales.
 *
 * Soporta Prisma (`schema.prisma`), TypeORM (decoradores `@Entity`) y
 * Drizzle (`pgTable`, `mysqlTable`, `sqliteTable`).
 */

import type {
  DbColumn,
  DbEnum,
  DbModel,
  DbSchemaSource,
  DbSchemaView,
} from '../../../shared/contracts.js';
import { exists, readTextIfExists } from '../fs-service.js';

/* -------------------------------------------------------------------------- */
/*  Prisma                                                                     */
/* -------------------------------------------------------------------------- */

const PRISMA_CANDIDATES = ['prisma/schema.prisma', 'schema.prisma', 'src/prisma/schema.prisma'];

/** Tipos escalares de Prisma; el resto son relaciones o enumerados. */
const PRISMA_SCALARS = new Set([
  'String', 'Boolean', 'Int', 'BigInt', 'Float', 'Decimal', 'DateTime', 'Json', 'Bytes',
]);

/**
 * Extrae el argumento de un atributo `@nombre(...)` respetando los
 * parentesis anidados: `@default(autoincrement())` devuelve
 * `autoincrement()`, no `autoincrement(`.
 */
export function extractAttributeArgument(attributes: string, name: string): string | null {
  const marker = `@${name}(`;
  const start = attributes.indexOf(marker);
  if (start === -1) {
    return null;
  }
  let depth = 1;
  let index = start + marker.length;
  while (index < attributes.length && depth > 0) {
    const character = attributes[index];
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        break;
      }
    }
    index += 1;
  }
  return attributes.slice(start + marker.length, index);
}

export function parsePrismaSchema(file: string, source: string): DbSchemaView {
  const models: DbModel[] = [];
  const enums: DbEnum[] = [];
  let provider: string | undefined;

  const providerMatch = /datasource\s+\w+\s*\{[^}]*provider\s*=\s*"([^"]+)"/s.exec(source);
  if (providerMatch?.[1] !== undefined) {
    provider = providerMatch[1];
  }

  const lines = source.split(/\r?\n/);
  let index = 0;

  while (index < lines.length) {
    const line = (lines[index] ?? '').trim();

    const modelMatch = /^model\s+(\w+)\s*\{$/.exec(line);
    if (modelMatch?.[1] !== undefined) {
      const name = modelMatch[1];
      const startLine = index + 1;
      const columns: DbColumn[] = [];
      index += 1;

      while (index < lines.length && (lines[index] ?? '').trim() !== '}') {
        const field = (lines[index] ?? '').trim();
        index += 1;
        if (field === '' || field.startsWith('//') || field.startsWith('@@')) {
          continue;
        }
        const fieldMatch = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(field);
        if (fieldMatch === null) {
          continue;
        }
        const [, fieldName = '', rawType = '', list, optional, attributes = ''] = fieldMatch;
        // Todo lo que no es escalar apunta a otro modelo o a un enumerado.
        const isRelation = !PRISMA_SCALARS.has(rawType);

        const defaultValue = extractAttributeArgument(attributes, 'default');
        columns.push({
          name: fieldName,
          type: `${rawType}${list === undefined ? '' : '[]'}`,
          nullable: optional !== undefined,
          primary: attributes.includes('@id'),
          unique: attributes.includes('@unique'),
          ...(isRelation ? { relation: rawType } : {}),
          ...(defaultValue === null ? {} : { defaultValue }),
        });
      }
      index += 1;
      models.push({ name, file, line: startLine, columns });
      continue;
    }

    const enumMatch = /^enum\s+(\w+)\s*\{$/.exec(line);
    if (enumMatch?.[1] !== undefined) {
      const name = enumMatch[1];
      const values: string[] = [];
      index += 1;
      while (index < lines.length && (lines[index] ?? '').trim() !== '}') {
        const value = (lines[index] ?? '').trim();
        index += 1;
        if (value !== '' && !value.startsWith('//') && !value.startsWith('@@')) {
          values.push(value.split(/\s+/)[0] ?? value);
        }
      }
      index += 1;
      enums.push({ name, values });
      continue;
    }

    index += 1;
  }

  return { source: 'prisma', ...(provider === undefined ? {} : { provider }), models, enums };
}

/* -------------------------------------------------------------------------- */
/*  TypeORM                                                                    */
/* -------------------------------------------------------------------------- */

export function parseTypeOrmEntity(file: string, source: string): DbModel[] {
  const models: DbModel[] = [];
  const entityPattern = /@Entity\s*\([^)]*\)\s*(?:export\s+)?class\s+(\w+)/g;

  let match = entityPattern.exec(source);
  while (match !== null) {
    const name = match[1] ?? '';
    const line = source.slice(0, match.index).split('\n').length;

    // Se recorre el cuerpo de la clase buscando los decoradores de columna.
    const bodyStart = source.indexOf('{', match.index);
    const body = bodyStart === -1 ? '' : source.slice(bodyStart, bodyStart + 8000);

    const columns: DbColumn[] = [];
    const columnPattern =
      /@(PrimaryGeneratedColumn|PrimaryColumn|Column|CreateDateColumn|UpdateDateColumn|ManyToOne|OneToMany|OneToOne|ManyToMany)\s*\(([^)]*)\)\s*(?:readonly\s+)?(\w+)\s*(\?)?\s*:\s*([\w<>[\]| ]+)/g;

    let columnMatch = columnPattern.exec(body);
    while (columnMatch !== null) {
      const [, decorator = '', options = '', fieldName = '', optional, fieldType = ''] = columnMatch;
      const isRelation = decorator.includes('To');
      columns.push({
        name: fieldName,
        type: fieldType.trim(),
        nullable: optional !== undefined || /nullable\s*:\s*true/.test(options),
        primary: decorator.startsWith('Primary'),
        unique: /unique\s*:\s*true/.test(options),
        ...(isRelation ? { relation: fieldType.replace(/\[\]|\s|\|null/g, '') } : {}),
      });
      columnMatch = columnPattern.exec(body);
    }

    models.push({ name, file, line, columns });
    match = entityPattern.exec(source);
  }
  return models;
}

/* -------------------------------------------------------------------------- */
/*  Drizzle                                                                    */
/* -------------------------------------------------------------------------- */

export function parseDrizzleSchema(file: string, source: string): DbModel[] {
  const models: DbModel[] = [];
  const tablePattern =
    /(?:export\s+)?const\s+(\w+)\s*=\s*(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{/g;

  let match = tablePattern.exec(source);
  while (match !== null) {
    const tableName = match[2] ?? match[1] ?? '';
    const line = source.slice(0, match.index).split('\n').length;

    // Cuerpo del objeto de columnas, hasta la llave que lo cierra.
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    while (end < source.length && depth > 0) {
      const character = source[end];
      if (character === '{') {
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
      }
      end += 1;
    }
    const body = source.slice(start, end - 1);

    const columns: DbColumn[] = [];
    const columnPattern = /(\w+)\s*:\s*(\w+)\s*\(([^)]*)\)([^,\n]*)/g;
    let columnMatch = columnPattern.exec(body);
    while (columnMatch !== null) {
      const [, fieldName = '', type = '', , modifiers = ''] = columnMatch;
      columns.push({
        name: fieldName,
        type,
        nullable: !modifiers.includes('.notNull()'),
        primary: modifiers.includes('.primaryKey()'),
        unique: modifiers.includes('.unique()'),
        ...(modifiers.includes('.references(')
          ? { relation: /references\(\s*\(\)\s*=>\s*(\w+)/.exec(modifiers)?.[1] ?? 'referencia' }
          : {}),
      });
      columnMatch = columnPattern.exec(body);
    }

    models.push({ name: tableName, file, line, columns });
    match = tablePattern.exec(source);
  }
  return models;
}

/* -------------------------------------------------------------------------- */
/*  Deteccion                                                                  */
/* -------------------------------------------------------------------------- */

/** Rutas donde suelen vivir las entidades de TypeORM y los esquemas Drizzle. */
const CODE_CANDIDATES: readonly { path: string; source: DbSchemaSource }[] = [
  { path: 'src/db/schema.ts', source: 'drizzle' },
  { path: 'src/schema.ts', source: 'drizzle' },
  { path: 'db/schema.ts', source: 'drizzle' },
  { path: 'drizzle/schema.ts', source: 'drizzle' },
  { path: 'src/entities/index.ts', source: 'typeorm' },
];

/**
 * Devuelve el primer esquema que encuentre, o `null` si el proyecto no
 * declara ninguno.
 */
export async function inspectSchema(): Promise<DbSchemaView | null> {
  for (const candidate of PRISMA_CANDIDATES) {
    const source = await readTextIfExists(candidate);
    if (source !== null) {
      return parsePrismaSchema(candidate, source);
    }
  }

  for (const candidate of CODE_CANDIDATES) {
    if (!(await exists(candidate.path))) {
      continue;
    }
    const source = await readTextIfExists(candidate.path);
    if (source === null) {
      continue;
    }
    const models =
      candidate.source === 'drizzle'
        ? parseDrizzleSchema(candidate.path, source)
        : parseTypeOrmEntity(candidate.path, source);
    if (models.length > 0) {
      return { source: candidate.source, models, enums: [] };
    }
  }

  return null;
}
