/**
 * Set de iconos propio (trazo de 1.7 sobre una rejilla de 24).
 *
 * Se declaran como `path` sueltos para que el bundle no arrastre ninguna
 * fuente de iconos ni SVG remoto: la CSP prohibe cargar recursos externos.
 */

export const ICONS = {
  files: 'M4 4h6l2 2h8v12H4z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4.2-4.2',
  git: 'M6 3v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9v3a4 4 0 0 1-4 4H9',
  run: 'M7 4v16l13-8z',
  pipeline: 'M4 7h5m6 0h5M4 17h5m6 0h5M9 4v6M15 14v6M9 7h6M9 17h6',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  http: 'M4 12h16M12 4a13 13 0 0 1 0 16M12 4a13 13 0 0 0 0 16M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z',
  metrics: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  ai: 'M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9zM18 16l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.5 19l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7.5l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9.3A1.6 1.6 0 0 0 10.4 3.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.4 1h.1a2 2 0 1 1 0 4H21a1.6 1.6 0 0 0-1.6 1z',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  refresh: 'M20 11a8 8 0 1 0-2.3 6M20 5v6h-6',
  stop: 'M6 6h12v12H6z',
  check: 'M4 12l5 5L20 6',
  folder: 'M4 6h6l2 2h8v10H4z',
  folderOpen: 'M4 8h5l2-2h9v3M3 20l2.5-9h17L20 20z',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  terminal: 'M5 7l5 5-5 5M13 17h6',
  split: 'M12 4v16M4 4h16v16H4z',
  save: 'M5 4h11l3 3v13H5zM8 4v6h7V4M8 20v-6h8v6',
  diff: 'M8 3v10M3 8h10M15 17h6M18 3v3M18 20v-3M15 11h6',
  branch: 'M6 4v9a4 4 0 0 0 4 4h4M6 4a2 2 0 1 0 0-.001M18 13a2 2 0 1 0 0 .001M18 15v2a2 2 0 1 1 0 .001',
  warning: 'M12 4l9 16H3zM12 10v4M12 17.5v.5',
  error: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM9 9l6 6M15 9l-6 6',
  info: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 11v5M12 8v.5',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  sparkle: 'M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z',
  eye: 'M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M4 4l16 16M10 6.2A9.8 9.8 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.2 3.7M6.5 8.3C3.9 9.9 2 12 2 12s3.6 6 10 6c1.2 0 2.3-.2 3.3-.5',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  container: 'M4 9h16v9H4zM4 9l3-4h10l3 4M9 13h6',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  debug: 'M9 6a3 3 0 0 1 6 0v1H9zM7 10h10v4a5 5 0 0 1-10 0zM4 11h3M17 11h3M4.5 16.5l2.6-1.3M19.5 16.5l-2.6-1.3M5.5 7l2 1M18.5 7l-2 1',
  contract: 'M7 3h7l4 4v14H7zM14 3v4h4M10 12h6M10 16h4M10 8h2',
  power: 'M12 4v8M7.5 7a7 7 0 1 0 9 0',
} as const;

export type IconName = keyof typeof ICONS;
