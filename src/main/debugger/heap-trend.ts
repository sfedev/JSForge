/**
 * Deteccion de fugas de memoria por tendencia.
 *
 * Un proceso Node sano dibuja dientes de sierra: sube hasta que el
 * recolector actua y vuelve a bajar. Una fuga se distingue porque los
 * MINIMOS suben, no porque el maximo sea alto. Por eso la heuristica mira
 * dos cosas a la vez:
 *
 *  1. La pendiente global por minimos cuadrados (MB/min).
 *  2. Si los valles del principio y del final de la ventana han subido.
 *
 * Con solo la pendiente, un pico puntual antes de una recoleccion daria un
 * falso positivo en cada arranque de un `next dev`.
 */

import type { HeapSample } from '../../shared/contracts.js';

/** Muestras minimas para que la tendencia signifique algo. */
export const MIN_SAMPLES_FOR_TREND = 8;

/** Crecimiento sostenido a partir del cual se avisa. */
const LEAK_SLOPE_MB_PER_MINUTE = 4;

/** Subida minima del valle para descartar un simple pico. */
const LEAK_VALLEY_GROWTH_MB = 6;

/**
 * Pendiente en MB/min por regresion lineal sobre (tiempo, heap usado).
 * Devuelve 0 cuando no hay muestras suficientes o todas comparten instante.
 */
export function heapSlopeMbPerMinute(samples: readonly HeapSample[]): number {
  if (samples.length < 2) {
    return 0;
  }
  const base = samples[0]?.time ?? 0;
  // El eje X va en minutos desde la primera muestra: con milisegundos
  // absolutos la varianza se dispara y la pendiente pierde precision.
  const xs = samples.map((sample) => (sample.time - base) / 60_000);
  const ys = samples.map((sample) => sample.usedHeapMb);
  const n = samples.length;

  const meanX = xs.reduce((sum, value) => sum + value, 0) / n;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / n;

  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    const dx = (xs[index] ?? 0) - meanX;
    numerator += dx * ((ys[index] ?? 0) - meanY);
    denominator += dx * dx;
  }
  if (denominator === 0) {
    return 0;
  }
  return Number((numerator / denominator).toFixed(2));
}

/** Minimo de un tramo: aproxima el heap vivo tras una recoleccion. */
function valley(samples: readonly HeapSample[]): number {
  return samples.reduce(
    (min, sample) => (sample.usedHeapMb < min ? sample.usedHeapMb : min),
    Number.POSITIVE_INFINITY,
  );
}

/**
 * Decide si la ventana sugiere una fuga.
 *
 * Se exige pendiente positiva relevante Y valles crecientes: los dos
 * criterios juntos, porque cada uno por separado se equivoca en el caso
 * comun de un servidor de desarrollo que acaba de arrancar.
 */
export function isLeakSuspected(samples: readonly HeapSample[]): boolean {
  if (samples.length < MIN_SAMPLES_FOR_TREND) {
    return false;
  }
  if (heapSlopeMbPerMinute(samples) < LEAK_SLOPE_MB_PER_MINUTE) {
    return false;
  }
  const half = Math.floor(samples.length / 2);
  const growth = valley(samples.slice(half)) - valley(samples.slice(0, half));
  return growth >= LEAK_VALLEY_GROWTH_MB;
}
