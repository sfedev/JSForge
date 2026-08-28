/**
 * Metricas de los procesos lanzados desde el IDE.
 *
 * Sin dependencias nativas: se consulta el sistema con la herramienta que
 * ya trae cada plataforma (`wmic`/PowerShell en Windows, `ps` en POSIX). El
 * muestreo solo corre mientras el panel esta visible, para no gastar CPU
 * midiendo CPU.
 *
 * El porcentaje de CPU en Windows se calcula por diferencia de tiempo de
 * procesador entre dos muestras: el valor bruto que devuelve el sistema es
 * acumulado desde el arranque del proceso y no sirve tal cual.
 */

import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

import type { MetricsSnapshot, ProcessMetricSample } from '../../../shared/contracts.js';
import { emit } from '../../ipc/event-bus.js';
import { livePids } from '../process/process-manager.js';
import { parsePosixTime } from './cpu-time.js';

const run = promisify(execFile);

const SAMPLE_INTERVAL_MS = 2000;
const PROBE_TIMEOUT_MS = 4000;

interface RawSample {
  readonly memoryBytes: number;
  /** Tiempo de procesador acumulado, en milisegundos. */
  readonly cpuTimeMs: number;
}

/** Ultima muestra por pid, para calcular el porcentaje por diferencia. */
const previous = new Map<number, { cpuTimeMs: number; at: number }>();

let timer: NodeJS.Timeout | null = null;

/* -------------------------------------------------------------------------- */
/*  Lectura por plataforma                                                     */
/* -------------------------------------------------------------------------- */

async function samplePosix(pids: readonly number[]): Promise<Map<number, RawSample>> {
  const out = new Map<number, RawSample>();
  if (pids.length === 0) {
    return out;
  }
  try {
    // `rss` en KiB y `time` como [DD-]HH:MM:SS.
    const { stdout } = await run('ps', ['-o', 'pid=,rss=,time=', '-p', pids.join(',')], {
      timeout: PROBE_TIMEOUT_MS,
      encoding: 'utf8',
    });
    for (const line of String(stdout).split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) {
        continue;
      }
      const pid = Number.parseInt(parts[0] ?? '', 10);
      const rss = Number.parseInt(parts[1] ?? '', 10);
      const cpuTimeMs = parsePosixTime(parts[2] ?? '');
      if (Number.isFinite(pid) && Number.isFinite(rss)) {
        out.set(pid, { memoryBytes: rss * 1024, cpuTimeMs });
      }
    }
  } catch {
    // `ps` puede no existir en un contenedor minimo.
  }
  return out;
}

async function sampleWindows(pids: readonly number[]): Promise<Map<number, RawSample>> {
  const out = new Map<number, RawSample>();
  if (pids.length === 0) {
    return out;
  }
  try {
    // PowerShell devuelve el conjunto de trabajo y el tiempo de procesador.
    const script = [
      `$ids = @(${pids.join(',')})`,
      'Get-Process -Id $ids -ErrorAction SilentlyContinue |',
      'ForEach-Object { "{0} {1} {2}" -f $_.Id, $_.WorkingSet64, [int]($_.TotalProcessorTime.TotalMilliseconds) }',
    ].join('; ');

    const { stdout } = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8', windowsHide: true },
    );

    for (const line of String(stdout).split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) {
        continue;
      }
      const pid = Number.parseInt(parts[0] ?? '', 10);
      const memoryBytes = Number.parseInt(parts[1] ?? '', 10);
      const cpuTimeMs = Number.parseInt(parts[2] ?? '', 10);
      if (Number.isFinite(pid) && Number.isFinite(memoryBytes)) {
        out.set(pid, { memoryBytes, cpuTimeMs: Number.isFinite(cpuTimeMs) ? cpuTimeMs : 0 });
      }
    }
  } catch {
    // PowerShell restringido por politica: se devuelve vacio.
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Muestreo                                                                   */
/* -------------------------------------------------------------------------- */

export async function takeSnapshot(): Promise<MetricsSnapshot> {
  const live = livePids();
  const pids = live.map((entry) => entry.pid);
  const raw = process.platform === 'win32' ? await sampleWindows(pids) : await samplePosix(pids);

  const now = Date.now();
  const cores = Math.max(1, os.cpus().length);
  const processes: ProcessMetricSample[] = [];

  for (const entry of live) {
    const sample = raw.get(entry.pid);
    if (sample === undefined) {
      continue;
    }
    const before = previous.get(entry.pid);
    previous.set(entry.pid, { cpuTimeMs: sample.cpuTimeMs, at: now });

    let cpu = 0;
    if (before !== undefined) {
      const elapsed = now - before.at;
      if (elapsed > 0) {
        // Porcentaje sobre el total de la maquina, no sobre un solo nucleo.
        cpu = ((sample.cpuTimeMs - before.cpuTimeMs) / (elapsed * cores)) * 100;
      }
    }

    processes.push({
      processId: entry.id,
      label: entry.label,
      pid: entry.pid,
      cpu: Math.max(0, Math.min(100, Number(cpu.toFixed(1)))),
      memoryMb: Number((sample.memoryBytes / (1024 * 1024)).toFixed(1)),
    });
  }

  // Se olvidan los procesos que ya no existen.
  for (const pid of [...previous.keys()]) {
    if (!pids.includes(pid)) {
      previous.delete(pid);
    }
  }

  const totalCpu = Number(processes.reduce((sum, entry) => sum + entry.cpu, 0).toFixed(1));
  const totalMemoryMb = Number(processes.reduce((sum, entry) => sum + entry.memoryMb, 0).toFixed(1));

  return {
    time: now,
    totalCpu,
    totalMemoryMb,
    systemMemoryMb: Number((os.totalmem() / (1024 * 1024)).toFixed(0)),
    processes,
  };
}

/** Activa o detiene el muestreo periodico. */
export function setSubscription(enabled: boolean): true {
  if (!enabled) {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    previous.clear();
    return true;
  }
  if (timer !== null) {
    return true;
  }
  timer = setInterval(() => {
    void takeSnapshot()
      .then((snapshot) => emit({ type: 'metrics/sample', payload: snapshot }))
      .catch(() => undefined);
  }, SAMPLE_INTERVAL_MS);
  timer.unref();
  return true;
}

export function disposeMetrics(): void {
  setSubscription(false);
}
