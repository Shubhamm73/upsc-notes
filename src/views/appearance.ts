import { h } from '../lib/h';
import { FONT_STYLES, getFontStyle, getTheme, setFontStyle, setTheme, type ThemePref } from '../lib/prefs';
import type { AppContext, View } from '../app';

export function mountAppearance(root: HTMLElement, ctx: AppContext): View {
  const themes: [ThemePref, string, string][] = [
    ['system', 'Match the tablet', 'Day or night follows the tablet setting'],
    ['day', 'Day', 'Paper and ink'],
    ['night', 'Night', 'Slate, for late study']
  ];
  const themeGroup = h('div', { class: 'seg theme-seg', role: 'radiogroup', 'aria-label': 'Theme' });
  const paintThemes = () => {
    const cur = getTheme();
    themeGroup.replaceChildren(
      ...themes.map(([id, name, sub]) => {
        const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(cur === id), class: 'theme-opt', 'data-theme-opt': id }, h('strong', {}, name), h('span', { class: 'meta' }, sub));
        b.addEventListener('click', () => {
          setTheme(id);
          paintThemes();
        });
        return b;
      })
    );
  };
  paintThemes();

  const fontGrid = h('div', { class: 'font-grid', role: 'radiogroup', 'aria-label': 'Note font style' });
  const paintFonts = () => {
    const cur = getFontStyle();
    fontGrid.replaceChildren(
      ...FONT_STYLES.map((f) => {
        const b = h(
          'button',
          { type: 'button', role: 'radio', 'aria-checked': String(cur === f.id), class: `font-card font-${f.id}`, 'data-font-opt': f.id },
          h('span', { class: 'font-sample-head' }, 'Separation of powers'),
          h('span', { class: 'font-sample-body' }, 'Article 50 asks the State to separate the judiciary from the executive.'),
          h('span', { class: 'font-meta' }, h('strong', {}, f.name), f.creative ? h('span', { class: 'kind' }, 'Creative') : null),
          h('span', { class: 'meta' }, `${f.head} + ${f.body} · ${f.bestFor}`)
        );
        b.addEventListener('click', () => {
          setFontStyle(f.id);
          paintFonts();
          ctx.toast(`Notes now use ${f.name}. You can still pick a different style for one note from its menu.`);
        });
        return b;
      })
    );
  };
  paintFonts();

  root.replaceChildren(
    h(
      'div',
      { class: 'settings' },
      h('h1', {}, 'Settings'),
      h('section', { class: 'card-block' }, h('h2', {}, 'Theme'), themeGroup),
      h(
        'section',
        { class: 'card-block' },
        h('h2', {}, 'Note font style'),
        h('p', { class: 'meta' }, 'Used across the app. One note can use a different style, set from inside the note. PDFs keep their own print font.'),
        fontGrid
      )
    )
  );
  return { route() {}, async flush() {}, async destroy() {} };
}
