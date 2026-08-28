/**
 * Comparacion de versiones semanticas.
 *
 * Vive en su propio modulo, sin dependencias de Electron, para que se pueda
 * ejercitar en pruebas sin arrancar la aplicacion.
 */

/** Descompone `v1.2.3-beta.1` en `[1, 2, 3]`, ignorando el sufijo. */
function parseVersion(value: string): number[] {
  const core = value.replace(/^v/i, '').split(/[-+]/)[0] ?? '0';
  return core.split('.').map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

/**
 * true si `candidate` es estrictamente mayor que `current`.
 * La comparacion es por componentes: `0.10.0` es mayor que `0.9.0`, cosa que
 * una comparacion de cadenas se equivocaria en dar.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  const length = Math.max(a.length, b.length);

  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) {
      return left > right;
    }
  }
  return false;
}
