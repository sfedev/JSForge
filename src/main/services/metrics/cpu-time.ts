/**
 * Conversion del tiempo de procesador que reporta `ps`.
 *
 * Modulo sin dependencias para poder probarlo aislado del muestreador.
 */

/**
 * Convierte `[DD-]HH:MM:SS` (formato de la columna `time` de `ps`) en
 * milisegundos. Acepta tambien las formas cortas `MM:SS` y `SS`.
 */
export function parsePosixTime(value: string): number {
  const [dayPart, rest] = value.includes('-') ? value.split('-') : [null, value];
  const parts = (rest ?? '')
    .split(':')
    .map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });

  while (parts.length < 3) {
    parts.unshift(0);
  }
  const [hours = 0, minutes = 0, seconds = 0] = parts.slice(-3);
  const days = dayPart === null ? 0 : Number.parseInt(dayPart, 10) || 0;

  return ((days * 24 + hours) * 3600 + minutes * 60 + seconds) * 1000;
}
