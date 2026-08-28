/**
 * Variantes arquitectonicas para React y Next.js.
 *
 * Cada variante genera un arbol REAL, no carpetas vacias: hay al menos un
 * archivo por capa y las importaciones cruzan las capas en la direccion que
 * el patron exige. Asi el proyecto arranca ya respetando la arquitectura, y
 * el ejemplo sirve de plantilla para lo siguiente que se anada.
 */

import type { ArchitectureTree } from './types.js';

export interface ReactArchOptions {
  readonly projectName: string;
  /** true cuando la opcion de estilos es CSS Modules. */
  readonly cssModules: boolean;
}

/**
 * Devuelve el import y la clase del componente raiz segun la opcion de
 * estilos. Con CSS Modules la hoja se coloca junto al componente, que es la
 * convencion que espera Vite.
 */
function rootStyles(cssModules: boolean, moduleFile: string): {
  /** Lista para poder insertarla con spread: vacia no deja hueco. */
  importLines: readonly string[];
  className: string;
  extraFile?: [string, string];
} {
  if (!cssModules) {
    return { importLines: [], className: '"contenedor"' };
  }
  return {
    importLines: [`import estilos from './${moduleFile}';`],
    className: '{estilos.contenedor}',
    extraFile: [
      moduleFile,
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
    ],
  };
}

export type ReactArchitecture = 'standard' | 'feature-sliced' | 'atomic' | 'modular-ddd';

/** Entrada compartida: todas las variantes montan `<App />` igual. */
function mainTsx(appImport: string): string {
  return [
    "import { StrictMode } from 'react';",
    "import { createRoot } from 'react-dom/client';",
    '',
    `import { App } from '${appImport}';`,
    "import './styles/index.css';",
    '',
    "const contenedor = document.getElementById('root');",
    'if (contenedor === null) {',
    "  throw new Error('No se encontro el contenedor #root.');",
    '}',
    '',
    'createRoot(contenedor).render(',
    '  <StrictMode>',
    '    <App />',
    '  </StrictMode>,',
    ');',
    '',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/*  Estandar                                                                   */
/* -------------------------------------------------------------------------- */

function standard({ projectName, cssModules }: ReactArchOptions): ArchitectureTree {
  const files = new Map<string, string>();
  const estilos = rootStyles(cssModules, 'App.module.css');
  if (estilos.extraFile !== undefined) {
    files.set(`src/${estilos.extraFile[0]}`, estilos.extraFile[1]);
  }

  files.set('src/main.tsx', mainTsx('./App'));
  files.set(
    'src/App.tsx',
    [
      "import { Contador } from './components/Contador';",
      ...estilos.importLines,
      '',
      'export function App(): JSX.Element {',
      '  return (',
      `    <main className=${estilos.className}>`,
      `      <h1>${projectName}</h1>`,
      '      <Contador />',
      '    </main>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );
  files.set(
    'src/components/Contador.tsx',
    [
      "import { useCallback, useState } from 'react';",
      '',
      'export function Contador(): JSX.Element {',
      '  const [valor, setValor] = useState(0);',
      '  const incrementar = useCallback((): void => {',
      '    setValor((actual) => actual + 1);',
      '  }, []);',
      '',
      '  return (',
      '    <button type="button" onClick={incrementar}>',
      '      Pulsado {valor} veces',
      '    </button>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );

  return {
    files,
    structure: ['src/', '  components/   componentes reutilizables', '  App.tsx', '  main.tsx'],
    description: 'Estructura plana: componentes en una sola carpeta.',
    notes: [],
  };
}

/* -------------------------------------------------------------------------- */
/*  Feature-Sliced Design                                                      */
/* -------------------------------------------------------------------------- */

/**
 * FSD ordena el codigo en capas con una regla de dependencia estricta:
 * una capa solo puede importar de las que tiene por debajo.
 *
 *   app → processes → pages → widgets → features → entities → shared
 */
function featureSliced({ projectName, cssModules }: ReactArchOptions): ArchitectureTree {
  const files = new Map<string, string>();
  const estilos = rootStyles(cssModules, 'PaginaInicio.module.css');
  if (estilos.extraFile !== undefined) {
    files.set(`src/pages/inicio/ui/${estilos.extraFile[0]}`, estilos.extraFile[1]);
  }

  /* --- shared: sin dependencias de dominio --- */
  files.set(
    'src/shared/lib/http.ts',
    [
      '/**',
      ' * Cliente HTTP compartido. `shared` es la capa mas baja: no puede',
      ' * importar de ninguna otra.',
      ' */',
      'export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {',
      '  const respuesta = await fetch(url, { signal });',
      '  if (!respuesta.ok) {',
      '    throw new Error(`La peticion a ${url} devolvio ${respuesta.status}.`);',
      '  }',
      '  return (await respuesta.json()) as T;',
      '}',
      '',
    ].join('\n'),
  );
  files.set(
    'src/shared/ui/Boton.tsx',
    [
      "import type { ButtonHTMLAttributes, ReactNode } from 'react';",
      '',
      'interface BotonProps extends ButtonHTMLAttributes<HTMLButtonElement> {',
      '  readonly children: ReactNode;',
      '}',
      '',
      '/** Primitiva de interfaz sin ninguna regla de negocio. */',
      'export function Boton({ children, ...resto }: BotonProps): JSX.Element {',
      '  return (',
      '    <button type="button" {...resto}>',
      '      {children}',
      '    </button>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );
  files.set('src/shared/config/index.ts', "export const API_BASE = '/api';\n");

  /* --- entities: modelo de negocio --- */
  files.set(
    'src/entities/tarea/model/tipos.ts',
    [
      '/** Entidad del dominio: solo datos y reglas, sin interfaz. */',
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
    'src/entities/tarea/ui/TareaItem.tsx',
    [
      "import type { Tarea } from '../model/tipos';",
      '',
      'interface TareaItemProps {',
      '  readonly tarea: Tarea;',
      '}',
      '',
      '/** Representacion visual de la entidad, sin logica de caso de uso. */',
      'export function TareaItem({ tarea }: TareaItemProps): JSX.Element {',
      '  return (',
      "    <span style={{ textDecoration: tarea.completada ? 'line-through' : 'none' }}>",
      '      {tarea.titulo}',
      '    </span>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );
  files.set(
    'src/entities/tarea/index.ts',
    ["export { TareaItem } from './ui/TareaItem';", "export * from './model/tipos';", ''].join('\n'),
  );

  /* --- features: una accion del usuario --- */
  files.set(
    'src/features/alternar-tarea/ui/AlternarTarea.tsx',
    [
      "import { alternar, TareaItem, type Tarea } from '@/entities/tarea';",
      "import { Boton } from '@/shared/ui/Boton';",
      '',
      'interface AlternarTareaProps {',
      '  readonly tarea: Tarea;',
      '  readonly onCambio: (tarea: Tarea) => void;',
      '}',
      '',
      '/**',
      ' * Una feature es UNA accion del usuario. Puede usar entities y shared,',
      ' * nunca widgets ni pages.',
      ' */',
      'export function AlternarTarea({ tarea, onCambio }: AlternarTareaProps): JSX.Element {',
      '  return (',
      '    <Boton onClick={() => onCambio(alternar(tarea))}>',
      '      <TareaItem tarea={tarea} />',
      '    </Boton>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );
  files.set(
    'src/features/alternar-tarea/index.ts',
    "export { AlternarTarea } from './ui/AlternarTarea';\n",
  );

  /* --- widgets: composicion de features --- */
  files.set(
    'src/widgets/lista-tareas/ui/ListaTareas.tsx',
    [
      "import { useState } from 'react';",
      '',
      "import { AlternarTarea } from '@/features/alternar-tarea';",
      "import type { Tarea } from '@/entities/tarea';",
      '',
      'const INICIALES: readonly Tarea[] = [',
      "  { id: '1', titulo: 'Leer la arquitectura FSD', completada: false },",
      "  { id: '2', titulo: 'Anadir una feature nueva', completada: false },",
      '];',
      '',
      '/** Un widget compone features en un bloque reutilizable de interfaz. */',
      'export function ListaTareas(): JSX.Element {',
      '  const [tareas, setTareas] = useState<readonly Tarea[]>(INICIALES);',
      '',
      '  const actualizar = (cambiada: Tarea): void => {',
      '    setTareas((actuales) =>',
      '      actuales.map((tarea) => (tarea.id === cambiada.id ? cambiada : tarea)),',
      '    );',
      '  };',
      '',
      '  return (',
      '    <ul>',
      '      {tareas.map((tarea) => (',
      '        <li key={tarea.id}>',
      '          <AlternarTarea tarea={tarea} onCambio={actualizar} />',
      '        </li>',
      '      ))}',
      '    </ul>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );
  files.set('src/widgets/lista-tareas/index.ts', "export { ListaTareas } from './ui/ListaTareas';\n");

  /* --- pages --- */
  files.set(
    'src/pages/inicio/ui/PaginaInicio.tsx',
    [
      "import { ListaTareas } from '@/widgets/lista-tareas';",
      ...estilos.importLines,
      '',
      'export function PaginaInicio(): JSX.Element {',
      '  return (',
      `    <main className=${estilos.className}>`,
      `      <h1>${projectName}</h1>`,
      '      <ListaTareas />',
      '    </main>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );
  files.set('src/pages/inicio/index.ts', "export { PaginaInicio } from './ui/PaginaInicio';\n");

  /* --- processes: flujos que cruzan varias paginas --- */
  files.set(
    'src/processes/README.md',
    [
      '# processes',
      '',
      'Flujos que atraviesan varias paginas: registro en varios pasos, compra,',
      'onboarding. Si un flujo vive en una sola pagina, no pertenece aqui.',
      '',
      'Esta capa suele empezar vacia; se anade cuando aparece el primer flujo',
      'multipagina real.',
      '',
    ].join('\n'),
  );

  /* --- app: composicion raiz --- */
  files.set(
    'src/app/providers/index.tsx',
    [
      "import type { ReactNode } from 'react';",
      '',
      '/**',
      ' * Aqui se envuelven los proveedores globales (router, estado, tema).',
      ' * Es el unico sitio donde viven, para que ninguna capa inferior los',
      ' * de por supuestos.',
      ' */',
      'export function Providers({ children }: { readonly children: ReactNode }): JSX.Element {',
      '  return <>{children}</>;',
      '}',
      '',
    ].join('\n'),
  );
  files.set(
    'src/app/index.tsx',
    [
      "import { PaginaInicio } from '@/pages/inicio';",
      '',
      "import { Providers } from './providers';",
      '',
      '/** `app` es la capa superior: puede importar de todas las demas. */',
      'export function App(): JSX.Element {',
      '  return (',
      '    <Providers>',
      '      <PaginaInicio />',
      '    </Providers>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );

  files.set('src/main.tsx', mainTsx('@/app'));

  return {
    files,
    structure: [
      'src/',
      '  app/          composicion raiz y proveedores',
      '  processes/    flujos multipagina',
      '  pages/        una carpeta por pantalla',
      '  widgets/      bloques que componen features',
      '  features/     una accion del usuario cada una',
      '  entities/     modelo de negocio y su representacion',
      '  shared/       primitivas sin dominio (ui, lib, config)',
    ],
    description:
      'Feature-Sliced Design: siete capas con dependencia unidireccional, de `app` hacia `shared`.',
    notes: [
      'Regla de oro de FSD: una capa solo importa de las que tiene por debajo. `shared` no importa de nadie.',
      'Cada slice expone su API publica en su `index.ts`; no importes por rutas internas.',
    ],
  };
}

/* -------------------------------------------------------------------------- */
/*  Atomic Design                                                              */
/* -------------------------------------------------------------------------- */

function atomic({ projectName, cssModules }: ReactArchOptions): ArchitectureTree {
  const files = new Map<string, string>();
  const estilos = rootStyles(cssModules, 'LayoutPrincipal.module.css');
  if (estilos.extraFile !== undefined) {
    files.set(`src/components/templates/${estilos.extraFile[0]}`, estilos.extraFile[1]);
  }

  files.set(
    'src/components/atoms/Boton.tsx',
    [
      "import type { ButtonHTMLAttributes, ReactNode } from 'react';",
      '',
      '/** Atomo: el elemento mas pequeno con sentido propio. */',
      'export function Boton({',
      '  children,',
      '  ...resto',
      '}: ButtonHTMLAttributes<HTMLButtonElement> & { readonly children: ReactNode }): JSX.Element {',
      '  return (',
      '    <button type="button" {...resto}>',
      '      {children}',
      '    </button>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );
  files.set(
    'src/components/atoms/Etiqueta.tsx',
    [
      "import type { ReactNode } from 'react';",
      '',
      'export function Etiqueta({ children }: { readonly children: ReactNode }): JSX.Element {',
      '  return <span className="etiqueta">{children}</span>;',
      '}',
      '',
    ].join('\n'),
  );

  files.set(
    'src/components/molecules/CampoBusqueda.tsx',
    [
      "import { useState } from 'react';",
      '',
      "import { Boton } from '../atoms/Boton';",
      '',
      'interface CampoBusquedaProps {',
      '  readonly onBuscar: (texto: string) => void;',
      '}',
      '',
      '/** Molecula: varios atomos que juntos hacen una sola cosa. */',
      'export function CampoBusqueda({ onBuscar }: CampoBusquedaProps): JSX.Element {',
      "  const [texto, setTexto] = useState('');",
      '',
      '  return (',
      '    <div className="campo-busqueda">',
      '      <input',
      '        type="search"',
      '        value={texto}',
      '        onChange={(evento) => setTexto(evento.target.value)}',
      '        aria-label="Buscar"',
      '      />',
      '      <Boton onClick={() => onBuscar(texto)}>Buscar</Boton>',
      '    </div>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );

  files.set(
    'src/components/organisms/Cabecera.tsx',
    [
      "import { CampoBusqueda } from '../molecules/CampoBusqueda';",
      '',
      'interface CabeceraProps {',
      '  readonly titulo: string;',
      '  readonly onBuscar: (texto: string) => void;',
      '}',
      '',
      '/** Organismo: seccion completa y autonoma de la interfaz. */',
      'export function Cabecera({ titulo, onBuscar }: CabeceraProps): JSX.Element {',
      '  return (',
      '    <header className="cabecera">',
      '      <h1>{titulo}</h1>',
      '      <CampoBusqueda onBuscar={onBuscar} />',
      '    </header>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );

  files.set(
    'src/components/templates/LayoutPrincipal.tsx',
    [
      "import type { ReactNode } from 'react';",
      ...estilos.importLines,
      '',
      'interface LayoutPrincipalProps {',
      '  readonly cabecera: ReactNode;',
      '  readonly children: ReactNode;',
      '}',
      '',
      '/**',
      ' * Plantilla: define la disposicion y recibe el contenido por props.',
      ' * No conoce los datos, solo el hueco donde van.',
      ' */',
      'export function LayoutPrincipal({ cabecera, children }: LayoutPrincipalProps): JSX.Element {',
      '  return (',
      `    <div className=${estilos.className}>`,
      '      {cabecera}',
      '      <main>{children}</main>',
      '    </div>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );

  files.set(
    'src/components/pages/PaginaInicio.tsx',
    [
      "import { useState } from 'react';",
      '',
      "import { Etiqueta } from '../atoms/Etiqueta';",
      "import { Cabecera } from '../organisms/Cabecera';",
      "import { LayoutPrincipal } from '../templates/LayoutPrincipal';",
      '',
      '/** Pagina: la plantilla con datos reales dentro. */',
      'export function PaginaInicio(): JSX.Element {',
      "  const [consulta, setConsulta] = useState('');",
      '',
      '  return (',
      '    <LayoutPrincipal',
      `      cabecera={<Cabecera titulo="${projectName}" onBuscar={setConsulta} />}`,
      '    >',
      "      <Etiqueta>{consulta === '' ? 'Escribe algo para buscar' : `Buscando: ${consulta}`}</Etiqueta>",
      '    </LayoutPrincipal>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );

  files.set(
    'src/App.tsx',
    [
      "import { PaginaInicio } from './components/pages/PaginaInicio';",
      '',
      'export function App(): JSX.Element {',
      '  return <PaginaInicio />;',
      '}',
      '',
    ].join('\n'),
  );
  files.set('src/main.tsx', mainTsx('./App'));

  return {
    files,
    structure: [
      'src/components/',
      '  atoms/        elementos indivisibles',
      '  molecules/    grupos de atomos con una funcion',
      '  organisms/    secciones completas',
      '  templates/    disposicion sin datos',
      '  pages/        plantillas con datos reales',
    ],
    description:
      'Atomic Design: cinco niveles, de atomos a paginas, cada uno compuesto solo por los anteriores.',
    notes: [
      'Un nivel solo puede componer los inferiores: un atomo nunca importa una molecula.',
      'Las plantillas no conocen los datos; ese es el trabajo de las paginas.',
    ],
  };
}

/* -------------------------------------------------------------------------- */
/*  Modular / Domain-Driven                                                    */
/* -------------------------------------------------------------------------- */

function modularDdd({ projectName, cssModules }: ReactArchOptions): ArchitectureTree {
  const files = new Map<string, string>();
  const estilos = rootStyles(cssModules, 'App.module.css');
  if (estilos.extraFile !== undefined) {
    files.set(`src/${estilos.extraFile[0]}`, estilos.extraFile[1]);
  }

  /* --- dominio: reglas puras --- */
  files.set(
    'src/modules/tareas/domain/tarea.ts',
    [
      '/**',
      ' * Modelo del dominio. No importa React, ni fetch, ni nada de',
      ' * infraestructura: se puede probar sin navegador.',
      ' */',
      'export interface Tarea {',
      '  readonly id: string;',
      '  readonly titulo: string;',
      '  readonly completada: boolean;',
      '}',
      '',
      'export class TituloVacioError extends Error {',
      '  public constructor() {',
      "    super('El titulo de la tarea no puede estar vacio.');",
      "    this.name = 'TituloVacioError';",
      '  }',
      '}',
      '',
      'export function crearTarea(id: string, titulo: string): Tarea {',
      "  if (titulo.trim() === '') {",
      '    throw new TituloVacioError();',
      '  }',
      '  return { id, titulo: titulo.trim(), completada: false };',
      '}',
      '',
      'export function alternar(tarea: Tarea): Tarea {',
      '  return { ...tarea, completada: !tarea.completada };',
      '}',
      '',
    ].join('\n'),
  );
  files.set(
    'src/modules/tareas/domain/repositorio.ts',
    [
      "import type { Tarea } from './tarea';",
      '',
      '/** Puerto: el dominio declara lo que necesita, no como se cumple. */',
      'export interface RepositorioTareas {',
      '  listar(): Promise<readonly Tarea[]>;',
      '  guardar(tarea: Tarea): Promise<void>;',
      '}',
      '',
    ].join('\n'),
  );

  /* --- infraestructura: implementa los puertos --- */
  files.set(
    'src/modules/tareas/infrastructure/repositorio-http.ts',
    [
      "import type { RepositorioTareas } from '../domain/repositorio';",
      "import type { Tarea } from '../domain/tarea';",
      '',
      '/** Adaptador HTTP del puerto. Es lo unico que conoce la red. */',
      'export class RepositorioHttp implements RepositorioTareas {',
      '  readonly #base: string;',
      '',
      "  public constructor(base = '/api/tareas') {",
      '    this.#base = base;',
      '  }',
      '',
      '  public async listar(): Promise<readonly Tarea[]> {',
      '    const respuesta = await fetch(this.#base);',
      '    if (!respuesta.ok) {',
      '      throw new Error(`El servidor devolvio ${respuesta.status}.`);',
      '    }',
      '    return (await respuesta.json()) as readonly Tarea[];',
      '  }',
      '',
      '  public async guardar(tarea: Tarea): Promise<void> {',
      '    await fetch(this.#base, {',
      "      method: 'POST',",
      "      headers: { 'content-type': 'application/json' },",
      '      body: JSON.stringify(tarea),',
      '    });',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  files.set(
    'src/modules/tareas/infrastructure/repositorio-memoria.ts',
    [
      "import type { RepositorioTareas } from '../domain/repositorio';",
      "import type { Tarea } from '../domain/tarea';",
      '',
      '/** Adaptador en memoria: permite arrancar y probar sin servidor. */',
      'export class RepositorioMemoria implements RepositorioTareas {',
      '  readonly #tareas = new Map<string, Tarea>();',
      '',
      '  public async listar(): Promise<readonly Tarea[]> {',
      '    return [...this.#tareas.values()];',
      '  }',
      '',
      '  public async guardar(tarea: Tarea): Promise<void> {',
      '    this.#tareas.set(tarea.id, tarea);',
      '  }',
      '}',
      '',
    ].join('\n'),
  );

  /* --- ui: React, y solo aqui --- */
  files.set(
    'src/modules/tareas/ui/useTareas.ts',
    [
      "import { useCallback, useEffect, useState } from 'react';",
      '',
      "import type { RepositorioTareas } from '../domain/repositorio';",
      "import { alternar, type Tarea } from '../domain/tarea';",
      '',
      '/**',
      ' * El hook recibe el repositorio por parametro: cambiar de adaptador no',
      ' * obliga a tocar el componente.',
      ' */',
      'export function useTareas(repositorio: RepositorioTareas) {',
      '  const [tareas, setTareas] = useState<readonly Tarea[]>([]);',
      '',
      '  useEffect(() => {',
      '    let vigente = true;',
      '    void repositorio.listar().then((cargadas) => {',
      '      if (vigente) {',
      '        setTareas(cargadas);',
      '      }',
      '    });',
      '    // Evita actualizar el estado de un componente ya desmontado.',
      '    return () => {',
      '      vigente = false;',
      '    };',
      '  }, [repositorio]);',
      '',
      '  const cambiar = useCallback(',
      '    async (tarea: Tarea): Promise<void> => {',
      '      const actualizada = alternar(tarea);',
      '      await repositorio.guardar(actualizada);',
      '      setTareas((actuales) =>',
      '        actuales.map((item) => (item.id === actualizada.id ? actualizada : item)),',
      '      );',
      '    },',
      '    [repositorio],',
      '  );',
      '',
      '  return { tareas, cambiar };',
      '}',
      '',
    ].join('\n'),
  );
  files.set(
    'src/modules/tareas/ui/ListaTareas.tsx',
    [
      "import type { RepositorioTareas } from '../domain/repositorio';",
      "import { useTareas } from './useTareas';",
      '',
      'interface ListaTareasProps {',
      '  readonly repositorio: RepositorioTareas;',
      '}',
      '',
      'export function ListaTareas({ repositorio }: ListaTareasProps): JSX.Element {',
      '  const { tareas, cambiar } = useTareas(repositorio);',
      '',
      '  return (',
      '    <ul>',
      '      {tareas.map((tarea) => (',
      '        <li key={tarea.id}>',
      '          <button type="button" onClick={() => void cambiar(tarea)}>',
      '            {tarea.completada ? "[x] " : "[ ] "}',
      '            {tarea.titulo}',
      '          </button>',
      '        </li>',
      '      ))}',
      '    </ul>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );
  files.set(
    'src/modules/tareas/index.ts',
    [
      '/** API publica del modulo: lo unico que el resto puede importar. */',
      "export { ListaTareas } from './ui/ListaTareas';",
      "export { RepositorioHttp } from './infrastructure/repositorio-http';",
      "export { RepositorioMemoria } from './infrastructure/repositorio-memoria';",
      "export type { RepositorioTareas } from './domain/repositorio';",
      "export type { Tarea } from './domain/tarea';",
      '',
    ].join('\n'),
  );

  files.set(
    'src/modules/tareas/domain/tarea.test.ts',
    [
      "import { describe, expect, it } from 'vitest';",
      '',
      "import { crearTarea, alternar, TituloVacioError } from './tarea';",
      '',
      "describe('dominio de tareas', () => {",
      "  it('rechaza un titulo vacio', () => {",
      "    expect(() => crearTarea('1', '   ')).toThrow(TituloVacioError);",
      '  });',
      '',
      "  it('alternar no muta la tarea original', () => {",
      "    const tarea = crearTarea('1', 'Escribir pruebas');",
      '    const cambiada = alternar(tarea);',
      '',
      '    expect(tarea.completada).toBe(false);',
      '    expect(cambiada.completada).toBe(true);',
      '  });',
      '});',
      '',
    ].join('\n'),
  );

  files.set(
    'src/App.tsx',
    [
      "import { useMemo } from 'react';",
      '',
      "import { ListaTareas, RepositorioMemoria } from '@/modules/tareas';",
      ...estilos.importLines,
      '',
      'export function App(): JSX.Element {',
      '  // La composicion decide el adaptador; el modulo no se entera.',
      '  const repositorio = useMemo(() => new RepositorioMemoria(), []);',
      '',
      '  return (',
      `    <main className=${estilos.className}>`,
      `      <h1>${projectName}</h1>`,
      '      <ListaTareas repositorio={repositorio} />',
      '    </main>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );
  files.set('src/main.tsx', mainTsx('./App'));

  return {
    files,
    structure: [
      'src/modules/<dominio>/',
      '  domain/           entidades, reglas y puertos (sin React)',
      '  infrastructure/   adaptadores: HTTP, memoria, almacenamiento',
      '  ui/               componentes y hooks de ese dominio',
      '  index.ts          API publica del modulo',
    ],
    description:
      'Modular DDD: un modulo por dominio, con dominio, infraestructura e interfaz separados.',
    notes: [
      'El dominio no importa React ni fetch: por eso sus pruebas corren sin navegador.',
      'Los modulos se hablan solo a traves de su `index.ts`, nunca por rutas internas.',
    ],
  };
}

/* -------------------------------------------------------------------------- */

export function buildReactArchitecture(
  architecture: ReactArchitecture,
  options: ReactArchOptions,
): ArchitectureTree {
  switch (architecture) {
    case 'feature-sliced':
      return featureSliced(options);
    case 'atomic':
      return atomic(options);
    case 'modular-ddd':
      return modularDdd(options);
    case 'standard':
    default:
      return standard(options);
  }
}
