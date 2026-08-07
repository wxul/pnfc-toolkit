const media = window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme() {
  document.documentElement.classList.toggle("dark", media.matches);
}

/** Keep shadcn's `.dark` class in sync with the OS light/dark mode, updating live whenever the
 * system theme changes. */
export function initThemeSync() {
  applyTheme();
  media.addEventListener("change", applyTheme);
}
