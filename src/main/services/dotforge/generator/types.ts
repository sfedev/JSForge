/**
 * Tipos internos del generador de arquitecturas.
 *
 * Un blueprint no escribe en disco: devuelve un mapa de rutas a contenido.
 * Eso permite ofrecer una ejecucion en seco (`dryRun`) real, probar los
 * generadores sin sistema de archivos y evitar dejar el destino a medias
 * cuando algo falla a mitad.
 */

import type { Blueprint, GenerateRequest, PackageManagerId } from '../../../../shared/contracts.js';

/** Archivos generados: ruta relativa al destino -> contenido de texto. */
export type FileMap = Map<string, string>;

export interface BlueprintContext {
  readonly projectName: string;
  /** Nombre valido como identificador de paquete npm. */
  readonly packageName: string;
  readonly packageManager: PackageManagerId;
  readonly options: Readonly<Record<string, string | boolean>>;
  /** Atajo tipado para leer una opcion booleana. */
  flag(id: string): boolean;
  /** Atajo tipado para leer una opcion de eleccion. */
  choice(id: string, fallback: string): string;
}

export interface BlueprintDefinition extends Blueprint {
  /** Construye el arbol de archivos del proyecto. */
  build(context: BlueprintContext): FileMap;
  /** Pasos que el IDE muestra al terminar. */
  nextSteps(context: BlueprintContext): readonly string[];
}

/** Normaliza el nombre a un identificador de paquete npm valido. */
export function toPackageName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    // NFD separa las tildes del caracter base para poder eliminarlas.
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .replace(/-{2,}/g, '-');
  return normalized === '' ? 'proyecto-forge' : normalized;
}

export function createContext(request: GenerateRequest): BlueprintContext {
  const options = request.options ?? {};
  return {
    projectName: request.projectName,
    packageName: toPackageName(request.projectName),
    packageManager: request.packageManager,
    options,
    flag: (id: string): boolean => options[id] === true || options[id] === 'true',
    choice: (id: string, fallback: string): string => {
      const value = options[id];
      return typeof value === 'string' && value !== '' ? value : fallback;
    },
  };
}

/** Serializa un objeto como JSON con salto final, listo para escribir. */
export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
