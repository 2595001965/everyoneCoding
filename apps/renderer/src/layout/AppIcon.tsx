const paths = {
  workspace: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  designer: 'M3 4h18v16H3z M3 9h18 M9 9v11',
  memory: 'M8 3h8l4 5v13H4V8z M8 12h8 M8 16h5 M8 3v5h8V3',
  pipeline: 'M4 4h6v6H4z M14 14h6v6h-6z M14 4h6v6h-6z M7 10v7h7 M10 7h4',
  git: 'M6 7v10 M18 7v3a5 5 0 0 1-5 5H6 M9 4a3 3 0 1 1-6 0a3 3 0 1 1 6 0 M21 4a3 3 0 1 1-6 0a3 3 0 1 1 6 0 M9 20a3 3 0 1 1-6 0a3 3 0 1 1 6 0',
  preview: 'M4 4h16v12H4z M8 21h8 M12 16v5 M10 8l5 2-5 3z',
  rename: 'M4 7h16l-4-4 M20 17H4l4 4 M20 7v3 M4 17v-3',
  docs: 'M5 3h10l4 4v14H5z M14 3v5h5 M9 12h6 M9 16h6',
  code: 'M9 7l-5 5 5 5 M15 7l5 5-5 5 M13 5l-2 14',
  account: 'M16 7a4 4 0 1 1-8 0a4 4 0 1 1 8 0 M4 21v-2a8 8 0 0 1 16 0v2',
  usage: 'M4 20V10 M10 20V4 M16 20v-7 M22 20H2',
  settings:
    'M12 3v3 M12 18v3 M3 12h3 M18 12h3 M6 6l2 2 M16 16l2 2 M18 6l-2 2 M8 16l-2 2 M17 12a5 5 0 1 1-10 0a5 5 0 1 1 10 0',
  search: 'M17 10a7 7 0 1 1-14 0a7 7 0 1 1 14 0 M15 15l6 6',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  plus: 'M12 5v14 M5 12h14',
  panel: 'M3 4h18v16H3z M15 4v16',
  moon: 'M20 14A9 9 0 0 1 10 4a9 9 0 1 0 10 10z',
  sun: 'M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5L19 19 M5 19l1.5-1.5 M17.5 6.5L19 5 M17 12a5 5 0 1 1-10 0a5 5 0 1 1 10 0',
  check: 'M5 12l4 4L19 6',
} as const;

export type AppIconName = keyof typeof paths;

/** Consistent line icons with no font or network dependency. */
export function AppIcon({ name, size = 18 }: { name: AppIconName; size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
