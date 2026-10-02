// One consistent 24px stroke icon set (1.75px strokes, round caps and joins).

const P: Record<string, string> = {
  // tools & categories
  inspect: 'M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13z M15.3 15.3L20 20',
  rail: 'M8.2 3L5 21 M15.8 3L19 21 M7.4 7h9.2 M6.8 11h10.4 M6.1 15.2h11.8 M5.4 19.4h13.2',
  road: 'M8 3L4 21 M16 3l4 18 M12 3.5v2.5 M12 10v3 M12 17v3.5',
  station: 'M3 10l9-6 9 6 M5 9.2V20 M19 9.2V20 M2.5 20h19 M9 20v-5h6v5 M9 11.5h6',
  busstop: 'M12 21V11.5 M12 3a4.2 4.2 0 1 1 0 8.4A4.2 4.2 0 0 1 12 3z M9 21h6 M10.4 7.2h3.2',
  depot: 'M3 21V9.5L12 4l9 5.5V21 M7 21v-8h10v8 M10.3 13v8 M13.7 13v8',
  garage: 'M3 21V9.5L12 4l9 5.5V21 M7 21v-9h10v9 M7 15h10 M7 18h10',
  signal: 'M9 3h6a1 1 0 0 1 1 1v8.5a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M12 13.5V21 M9 21h6 M12 6.3h.01 M12 10.2h.01',
  bulldoze: 'M5.5 14h7a2.5 2.5 0 0 1 0 5h-7a2.5 2.5 0 0 1 0-5z M5 14v-4h4.5l2.2 4 M13 12.5l4-3 M17 6v8.5l3.5 2',
  terraform: 'M2.5 20l6-9 4 5.5 2.5-3.5 6.5 7z M17 3v6 M14.5 5.5L17 3l2.5 2.5',
  raise: 'M3 20c2.5-4.5 5.5-7 9-7s6.5 2.5 9 7 M12 3v6.5 M9 6l3-3 3 3',
  lower: 'M3 20c2.5-4.5 5.5-7 9-7s6.5 2.5 9 7 M12 3v6.5 M9 7l3 3 3-3',
  level: 'M3 14h18 M7 4v6 M4.5 7.5L7 10l2.5-2.5 M17 20.5v-6.5 M14.5 16.5L17 14l2.5 2.5',
  lines: 'M6 4a2 2 0 1 0 0 4a2 2 0 1 0 0-4z M18 16a2 2 0 1 0 0 4a2 2 0 1 0 0-4z M8 6h3.5a4.5 4.5 0 0 1 4.5 4.5V16',
  train: 'M7 3h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z M4 10.5h16 M8.5 21l1.8-4 M15.5 21l-1.8-4 M8.5 14h.01 M15.5 14h.01',
  bus: 'M6 3.5h12a2 2 0 0 1 2 2V17a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5.5a2 2 0 0 1 2-2z M4 11h16 M7 18v2.5 M17 18v2.5 M7.5 14.5h.01 M16.5 14.5h.01 M9 6.5h6',
  vehicles: 'M7 3h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z M4 10.5h16 M8.5 21l1.8-4 M15.5 21l-1.8-4 M8.5 14h.01 M15.5 14h.01',
  towns: 'M2.5 21h19 M4 21V10.5l5-3V21 M9 21V4l6.5 3.5V21 M15.5 21v-9l5 2.5V21',
  money: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M15 9.3c-.5-1-1.6-1.6-3-1.6-1.7 0-3 .9-3 2.1 0 2.9 6 1.5 6 4.3 0 1.3-1.3 2.2-3 2.2-1.4 0-2.6-.6-3.1-1.6 M12 6v12',
  company: 'M3 20.5h18 M4.5 20.5v-6h4v6 M10 20.5V8h4v12.5 M15.5 20.5v-9h4v9',
  menu: 'M4 7h16 M4 12h16 M4 17h16',
  pause: 'M8.5 5v14 M15.5 5v14',
  play: 'M7.5 4.8v14.4L19 12z',
  ff: 'M3.5 6.2v11.6L11 12z M12.5 6.2v11.6L20 12z',
  bell: 'M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15z M10 21a2.2 2.2 0 0 0 4 0',
  help: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .9-1 1.6v.6 M12 17h.01',
  close: 'M6.5 6.5l11 11 M17.5 6.5l-11 11',
  settings: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z M12 2.5v3 M12 18.5v3 M2.5 12h3 M18.5 12h3 M5.3 5.3l2.1 2.1 M16.6 16.6l2.1 2.1 M5.3 18.7l2.1-2.1 M16.6 7.4l2.1-2.1',
  save: 'M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M7.5 3v5h8V3 M7 21v-7h10v7',
  load: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M12 10.5v5 M9.5 13l2.5 2.5 2.5-2.5',
  export: 'M12 15V3 M8 7l4-4 4 4 M4 13v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6',
  import: 'M12 3v12 M8 11l4 4 4-4 M4 13v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6',
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
  dice: 'M5.5 3h13A2.5 2.5 0 0 1 21 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 18.5v-13A2.5 2.5 0 0 1 5.5 3z M8 8h.01 M16 16h.01 M12 12h.01 M16 8h.01 M8 16h.01',
  rotl: 'M4 4v5h5 M4.8 9A8 8 0 1 1 6 17.2',
  rotr: 'M20 4v5h-5 M19.2 9A8 8 0 1 0 18 17.2',
  chevd: 'M6 9l6 6 6-6',
  chevr: 'M9 6l6 6-6 6',
  layers: 'M12 3l9 5-9 5-9-5z M3 13l9 5 9-5',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z',
  target: 'M12 2.5v4 M12 17.5v4 M2.5 12h4 M17.5 12h4 M12 7a5 5 0 1 0 0 10a5 5 0 1 0 0-10z',
  tag: 'M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z M7.5 7.5h.01',
  up: 'M12 19V5 M6 11l6-6 6 6',
  down: 'M12 5v14 M6 13l6 6 6-6',
  bridge: 'M2 8h20 M5 8v12 M19 8v12 M5 20c0-4.5 3-7.5 7-7.5s7 3 7 7.5',
  tunnel: 'M3 20.5V12a9 9 0 0 1 18 0v8.5 M7.5 20.5v-6a4.5 4.5 0 0 1 9 0v6',
  grade: 'M3 19L21 8 M3 19h18 M16 19v-3.1',
  radius: 'M4 20A16 16 0 0 1 20 4 M4 20h.01 M4 13v7h7',
  speed: 'M12 13.5l4.5-4.5 M4.6 18a9 9 0 1 1 14.8 0',
  length: 'M3.5 16.5L16.5 3.5l4 4-13 13z M7.5 12.5l2 2 M10.5 9.5l2 2 M13.5 6.5l2 2',
  warning: 'M12 3.5l9.5 16.5h-19z M12 10v4.5 M12 17.3h.01',
  people: 'M9 11a3.5 3.5 0 1 0 0-7a3.5 3.5 0 0 0 0 7z M2.5 20.5a6.5 6.5 0 0 1 13 0 M16 4.3a3.5 3.5 0 0 1 0 6.4 M18.5 14a6.2 6.2 0 0 1 3 6.5',
  clock: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 7v5l3.2 2',
  star: 'M12 3.5l2.7 5.5 6 .9-4.4 4.2 1 6-5.3-2.8-5.3 2.8 1-6-4.4-4.2 6-.9z',
  chart: 'M3.5 3.5V20.5h17 M7.5 15l4-4.5 3 3 5-6',
  edit: 'M4 20h4.2L19.5 8.7l-4.2-4.2L4 15.8z M13.8 6l4.2 4.2',
  trash: 'M4 7h16 M9.5 7V4h5v3 M6 7l1 13.5h10L18 7 M10 11v6 M14 11v6',
  check: 'M5 12.5l4.5 4.5L19 7',
  info: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 11v6 M12 7.5h.01',
  crossing: 'M5 5l14 14 M19 5L5 19',
  catchment: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 8.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7z',
  coin: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M9 12h6 M12 9v6',
  height: 'M12 3v18 M8.5 6.5L12 3l3.5 3.5 M8.5 17.5L12 21l3.5-3.5 M4 12h3 M17 12h3',
  parallel: 'M8 3L5 21 M13 3l-3 18 M19 3l-3 18',
  copy: 'M8 8h11v11H8z M5 16V5h11',
  wagon: 'M3 6.5h18v9.5H3z M6 10h3 M10.5 10h3 M15 10h3 M7 19.5a1.5 1.5 0 1 0 0-.01z M17 19.5a1.5 1.5 0 1 0 0-.01z',
  loco: 'M3 16.5V9h10l4.5 3H21v4.5z M6 9V6h4.5v3 M7 19.5a1.5 1.5 0 1 0 0-.01z M17 19.5a1.5 1.5 0 1 0 0-.01z',
  dot: 'M12 11.9v.2',
  volume: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4z M15.5 9a4.2 4.2 0 0 1 0 6 M18.2 6.3a8 8 0 0 1 0 11.4',
  mute: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4z M16 9.5l5 5 M21 9.5l-5 5',
  checklist: 'M4 6.5l1.5 1.5 3-3 M4 12.5l1.5 1.5 3-3 M4 18.5l1.5 1.5 3-3 M11.5 6.5h8.5 M11.5 12.5h8.5 M11.5 18.5h8.5',
  circle: 'M12 4.5a7.5 7.5 0 1 0 0 15a7.5 7.5 0 1 0 0-15z',
  flag: 'M5 21V4 M5 4.5h11l-2.2 4 2.2 4H5',
  tram: 'M12 2.5v2.3 M9.5 2.5h5 M7.5 4.8h9A2.5 2.5 0 0 1 19 7.3V16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7.3a2.5 2.5 0 0 1 2.5-2.5z M5 11h14 M8.2 21l1.4-3 M15.8 21l-1.4-3 M8.5 14.5h.01 M15.5 14.5h.01',
  tramstop: 'M12 21v-9.5 M9 21h6 M7.5 3h9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M9.8 5.6h4.4 M12 5.6v3.5',
  tramdepot: 'M3 21V9.5L12 4l9 5.5V21 M7 21v-8h10v8 M10.3 13v8 M13.7 13v8 M6.5 10.5h11',
  tramtrack: 'M8 3L4 21 M16 3l4 18 M10.6 3l-1.1 18 M13.4 3l1.1 18 M9.9 8h4.2 M9.6 14h4.8',
  demand: 'M6 14.5a3 3 0 1 0 0 6a3 3 0 1 0 0-6z M18.5 4a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z M8 15C10 9.5 13 7 16.2 6.8',
  map: 'M3 6.5l6-3 6 3 6-3v14l-6 3-6-3-6 3z M9 3.5v14 M15 6.5v14',
  key: 'M14.5 3.5a5 5 0 1 1-4.4 7.4L3 18v3h3v-2h2v-2h2l1.6-1.6A5 5 0 0 1 14.5 3.5z M16.5 7.5h.01',
  loop: 'M20 12a8 8 0 1 1-2.3-5.6 M20 4v4.5h-4.5',
  walk: 'M13 4.5a1.8 1.8 0 1 0 0-.01 M10 21l2.2-6.5 2.8 2.5V21 M7 12.5l2.5-3.5 3.5-1 2.5 3 2.5 1 M12.2 14.5l-.7-4.5',
  entrance: 'M4 21V10l8-6l8 6v11 M9 21v-6h6v6 M12 4v3',
  move: 'M12 3v18 M3 12h18 M12 3l-3 3 M12 3l3 3 M12 21l-3-3 M12 21l3-3 M3 12l3-3 M3 12l3 3 M21 12l-3-3 M21 12l-3 3',
  upgrade: 'M12 20V5 M6 11l6-6l6 6 M5 21h14',
  buyout: 'M4 8h16v11H4z M9 8V5h6v3 M4 13h16 M12 12v2',
  palette: 'M12 3a9 9 0 1 0 0 18c1.4 0 2-.9 2-1.9 0-1.4-1.1-1.9-.3-2.9.9-1 2-.6 3.1-.6C19.9 15.6 21 13.6 21 11c0-4.4-4-8-9-8z M7.5 11h.01 M10 7h.01 M14.5 7h.01 M17 10.5h.01',
  robot: 'M7 8h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z M12 4v4 M10 4h4 M9.5 13h.01 M14.5 13h.01 M9.5 16.5h5 M3 12v3 M21 12v3',
  news: 'M4 4.5h12.5v15H6.5a2.5 2.5 0 0 1-2.5-2.5z M16.5 8.5h3.5v9a2 2 0 0 1-2 2h-1.5 M7.5 8.5h6 M7.5 12h6 M7.5 15.5h4',
};

export const ICON_NAMES = Object.keys(P);

/** SVG markup string (for innerHTML templates such as tooltips). */
export function svg(name: string, size = 16, cls = 'ic'): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${P[name] ?? P.dot}"/></svg>`;
}

/** SVG element for DOM construction. */
export function icon(name: string, size = 22): SVGSVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', String(size));
  s.setAttribute('height', String(size));
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.75');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('class', 'ic');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<path d="${P[name] ?? P.dot}"/>`;
  return s;
}
