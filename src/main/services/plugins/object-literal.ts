/**
 * Lector de literales de objeto de JavaScript, restringido a datos.
 *
 * Existe para poder leer `.forge/plugin.ts` SIN ejecutarlo. Es la misma
 * regla que este IDE aplica a `vite.config.ts` y a `next.config.js`: el
 * archivo es contenido del proyecto y jamas se evalua.
 *
 * Frente a `JSON.parse`, admite lo que un desarrollador escribe de verdad en
 * un archivo TypeScript: claves sin comillas, comillas simples, cadenas de
 * plantilla sin interpolacion, comas finales y comentarios.
 *
 * Lo que NO admite, a proposito: funciones, llamadas, referencias a
 * variables, operadores y plantillas con `${}`. Nada de eso son datos, y
 * aceptarlos obligaria a evaluar. Cuando aparece uno, se falla con la
 * posicion exacta en lugar de adivinar.
 */

export type LiteralValue =
  | string
  | number
  | boolean
  | null
  | LiteralValue[]
  | { [key: string]: LiteralValue };

export class LiteralParseError extends Error {
  public readonly index: number;
  public readonly line: number;

  public constructor(message: string, source: string, index: number) {
    const line = source.slice(0, index).split('\n').length;
    super(`${message} (linea ${line})`);
    this.name = 'LiteralParseError';
    this.index = index;
    this.line = line;
  }
}

/** Analizador descendente sobre el texto; sin estado global. */
class Reader {
  readonly #source: string;
  #index: number;

  public constructor(source: string, start = 0) {
    this.#source = source;
    this.#index = start;
  }

  public get index(): number {
    return this.#index;
  }

  #fail(message: string): never {
    throw new LiteralParseError(message, this.#source, this.#index);
  }

  /** Salta espacios y comentarios de linea y de bloque. */
  public skipTrivia(): void {
    for (;;) {
      while (this.#index < this.#source.length && /\s/.test(this.#source[this.#index] ?? '')) {
        this.#index += 1;
      }
      const pair = this.#source.slice(this.#index, this.#index + 2);
      if (pair === '//') {
        const end = this.#source.indexOf('\n', this.#index);
        this.#index = end === -1 ? this.#source.length : end;
        continue;
      }
      if (pair === '/*') {
        const end = this.#source.indexOf('*/', this.#index + 2);
        this.#index = end === -1 ? this.#source.length : end + 2;
        continue;
      }
      return;
    }
  }

  #peek(): string {
    return this.#source[this.#index] ?? '';
  }

  #expect(character: string): void {
    if (this.#peek() !== character) {
      this.#fail(`Se esperaba "${character}" y se encontro "${this.#peek() || 'fin de archivo'}"`);
    }
    this.#index += 1;
  }

  public parseValue(): LiteralValue {
    this.skipTrivia();
    const char = this.#peek();

    if (char === '{') {
      return this.#parseObject();
    }
    if (char === '[') {
      return this.#parseArray();
    }
    if (char === '"' || char === "'" || char === '`') {
      return this.#parseString();
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      return this.#parseNumber();
    }

    const word = /^[A-Za-z_$][\w$]*/.exec(this.#source.slice(this.#index))?.[0];
    if (word === 'true' || word === 'false') {
      this.#index += word.length;
      return word === 'true';
    }
    if (word === 'null' || word === 'undefined') {
      this.#index += word.length;
      return null;
    }
    if (word !== undefined) {
      // Una referencia a variable, una llamada o un import: todo eso exige
      // ejecutar, que es justo lo que este lector no hace.
      this.#fail(
        `Solo se admiten datos literales; "${word}" exigiria evaluar el archivo`,
      );
    }
    this.#fail('Valor no reconocido');
  }

  #parseObject(): { [key: string]: LiteralValue } {
    this.#expect('{');
    const out: { [key: string]: LiteralValue } = {};

    for (;;) {
      this.skipTrivia();
      if (this.#peek() === '}') {
        this.#index += 1;
        return out;
      }

      const key = this.#parseKey();
      this.skipTrivia();
      this.#expect(':');
      out[key] = this.parseValue();

      this.skipTrivia();
      if (this.#peek() === ',') {
        this.#index += 1;
        continue;
      }
      if (this.#peek() === '}') {
        this.#index += 1;
        return out;
      }
      this.#fail('Se esperaba "," o "}"');
    }
  }

  #parseKey(): string {
    const char = this.#peek();
    if (char === '"' || char === "'" || char === '`') {
      return this.#parseString();
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(this.#source.slice(this.#index))?.[0];
    if (word === undefined) {
      this.#fail('Se esperaba el nombre de una propiedad');
    }
    this.#index += word.length;
    return word;
  }

  #parseArray(): LiteralValue[] {
    this.#expect('[');
    const out: LiteralValue[] = [];

    for (;;) {
      this.skipTrivia();
      if (this.#peek() === ']') {
        this.#index += 1;
        return out;
      }
      out.push(this.parseValue());
      this.skipTrivia();
      if (this.#peek() === ',') {
        this.#index += 1;
        continue;
      }
      if (this.#peek() === ']') {
        this.#index += 1;
        return out;
      }
      this.#fail('Se esperaba "," o "]"');
    }
  }

  #parseString(): string {
    const quote = this.#peek();
    this.#index += 1;
    let out = '';

    while (this.#index < this.#source.length) {
      const char = this.#source[this.#index] ?? '';

      if (char === '\\') {
        const escaped = this.#source[this.#index + 1] ?? '';
        const map: Readonly<Record<string, string>> = {
          n: '\n',
          t: '\t',
          r: '\r',
          b: '\b',
          f: '\f',
          '0': '\0',
        };
        out += map[escaped] ?? escaped;
        this.#index += 2;
        continue;
      }
      if (char === quote) {
        this.#index += 1;
        return out;
      }
      if (quote === '`' && char === '$' && this.#source[this.#index + 1] === '{') {
        // Una interpolacion depende del entorno de ejecucion.
        this.#fail('Las plantillas con ${} exigirian evaluar el archivo');
      }
      if (char === '\n' && quote !== '`') {
        this.#fail('Cadena sin cerrar');
      }
      out += char;
      this.#index += 1;
    }
    this.#fail('Cadena sin cerrar');
  }

  #parseNumber(): number {
    const match = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.#source.slice(this.#index));
    if (match === null) {
      this.#fail('Numero mal formado');
    }
    this.#index += match[0].length;
    return Number(match[0]);
  }
}

/**
 * Analiza el literal que empieza en `start`.
 * `start` debe apuntar al `{` o `[` inicial (los espacios se saltan solos).
 */
export function parseObjectLiteral(source: string, start = 0): LiteralValue {
  const reader = new Reader(source, start);
  return reader.parseValue();
}

/**
 * Localiza la llamada `fn(` y devuelve el indice de su primer argumento.
 * Devuelve -1 si la llamada no aparece.
 */
export function findCallArgument(source: string, fn: string): number {
  const pattern = new RegExp(`\\b${fn}\\s*(?:<[^>]*>)?\\s*\\(`, 'g');
  const match = pattern.exec(source);
  return match === null ? -1 : match.index + match[0].length;
}
