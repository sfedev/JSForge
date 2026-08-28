/**
 * Panel de metricas DotForge.
 *
 * Grafico ligero dibujado como SVG con los ultimos minutos de CPU y memoria
 * por proceso. La suscripcion al muestreo solo esta activa mientras la vista
 * es visible: medir el consumo no debe ser lo que mas consume.
 */

import { h, svgIcon } from '../core/dom.js';
import { ICONS } from '../core/icons.js';
import { defineCommands, runCommand } from '../core/commands.js';
import { store } from '../core/store.js';
import { registerSidebarView } from './sidebar.js';
import { registerPanelView, type PanelViewContext } from './panel.js';
import type { MetricsSnapshot } from '../../shared/contracts.js';

const hosts = new Set<HTMLElement>();
let subscribed = false;

export function registerMetricsView(): void {
  registerSidebarView('metrics', (context) => mount(context.container, context.actions));
  registerPanelView('metrics', (context: PanelViewContext) => mount(context.container, context.actions));

  defineCommands([
    {
      id: 'metrics.toggle',
      title: 'Metricas: activar o detener el muestreo',
      category: 'Metricas',
      run: () => void setSubscribed(!subscribed),
    },
  ]);
}

function mount(target: HTMLElement, actions: HTMLElement): void {
  const host = h('div', { class: 'metrics' });
  target.replaceChildren(host);
  hosts.add(host);

  const toggle = h('button', { class: 'icon-btn', type: 'button', title: 'Activar o detener el muestreo' });
  toggle.appendChild(svgIcon(ICONS.refresh, 13));
  toggle.addEventListener('click', () => void runCommand('metrics.toggle'));
  actions.appendChild(toggle);

  store.subscribe(['metrics', 'processes'], render);
  void setSubscribed(true);
  render();
}

async function setSubscribed(enabled: boolean): Promise<void> {
  subscribed = enabled;
  await window.forge.metrics.subscribe(enabled);
  if (enabled) {
    const snapshot = await window.forge.metrics.snapshot();
    if (snapshot.ok) {
      store.patch({ metrics: snapshot.value });
    }
  }
  render();
}

/* -------------------------------------------------------------------------- */
/*  Grafico                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Curva simple normalizada al maximo de la serie. Se dibuja con `polyline`
 * porque es lo mas barato que hay: nada de canvas ni de librerias.
 */
function sparkline(values: readonly number[], color: string, maximum: number): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'sparkline');
  svg.setAttribute('viewBox', '0 0 100 34');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');

  if (values.length < 2) {
    return svg;
  }
  const top = Math.max(maximum, ...values, 1);
  const step = 100 / (values.length - 1);

  const points = values
    .map((value, index) => `${(index * step).toFixed(2)},${(34 - (value / top) * 32).toFixed(2)}`)
    .join(' ');

  const area = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  area.setAttribute('points', `0,34 ${points} 100,34`);
  area.setAttribute('fill', color);
  area.setAttribute('opacity', '0.14');

  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', points);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', color);
  line.setAttribute('stroke-width', '1.5');
  line.setAttribute('vector-effect', 'non-scaling-stroke');

  svg.append(area, line);
  return svg;
}

/** Serie temporal de un proceso a partir del historial de muestras. */
function seriesFor(history: readonly MetricsSnapshot[], processId: string, field: 'cpu' | 'memoryMb'): number[] {
  return history.map((snapshot) => {
    const sample = snapshot.processes.find((entry) => entry.processId === processId);
    return sample === undefined ? 0 : sample[field];
  });
}

function render(): void {
  const state = store.state;
  const snapshot = state.metrics;

  for (const host of hosts) {
    if (!host.isConnected) {
      hosts.delete(host);
      continue;
    }
    host.replaceChildren();

    if (snapshot === null || snapshot.processes.length === 0) {
      host.appendChild(
        h(
          'div',
          { class: 'empty-note' },
          subscribed
            ? 'Sin procesos en ejecucion que medir.'
            : 'El muestreo esta detenido.',
        ),
      );
      continue;
    }

    /* --- Totales --- */
    const totals = h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:4px' });
    totals.appendChild(h('span', { class: 'chip', 'data-tone': 'accent' }, `CPU ${snapshot.totalCpu.toFixed(1)} %`));
    totals.appendChild(h('span', { class: 'chip' }, `RAM ${snapshot.totalMemoryMb.toFixed(0)} MB`));
    totals.appendChild(
      h('span', { class: 'chip' }, `${snapshot.processes.length} procesos · ${(snapshot.systemMemoryMb / 1024).toFixed(1)} GB en el sistema`),
    );
    host.appendChild(totals);

    /* --- Por proceso --- */
    for (const sample of snapshot.processes) {
      const block = h('div', {
        style: 'border:1px solid var(--border-subtle);border-radius:var(--radius-md);padding:8px',
      });

      const header = h('div', { class: 'metric-row' });
      header.appendChild(h('span', { class: 'metric-row__name' }, sample.label));
      header.appendChild(h('span', { class: 'metric-row__value' }, `${sample.cpu.toFixed(1)} %`));
      header.appendChild(h('span', { class: 'metric-row__value' }, `${sample.memoryMb.toFixed(0)} MB`));
      block.appendChild(header);

      const cpuSeries = seriesFor(state.metricsHistory, sample.processId, 'cpu');
      const memorySeries = seriesFor(state.metricsHistory, sample.processId, 'memoryMb');

      const charts = h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px' });
      const cpuBox = h('div', {});
      cpuBox.appendChild(h('div', { class: 'list-row__hint' }, 'CPU'));
      cpuBox.appendChild(sparkline(cpuSeries, 'var(--accent-400)', 100));

      const memoryBox = h('div', {});
      memoryBox.appendChild(h('div', { class: 'list-row__hint' }, 'Memoria'));
      memoryBox.appendChild(sparkline(memorySeries, 'var(--state-info)', 64));

      charts.append(cpuBox, memoryBox);
      block.appendChild(charts);
      host.appendChild(block);
    }
  }
}
