import { h } from '../lib/h';
import { celebrationsOn, FONT_STYLES, getCustom, getFontStyle, getPageWidth, getTheme, setCelebrations, setCustom, setFontStyle, setPageWidth, setTheme, type PageWidth, type ThemePref } from '../lib/prefs';
import { CUSTOM_ACCENTS, DENSITIES, fitAccent, themeOf, THEMES, tokensFor, type CustomTheme, type ThemeId } from '../lib/themes';
import type { AppContext, View } from '../app';

export function mountAppearance(root: HTMLElement, ctx: AppContext): View {
  // ----- theme: Match the tablet, 9 themes, Custom (0.14) -----
  const themeGroup = h('div', { class: 'theme-pick', role: 'radiogroup', 'aria-label': 'Theme' });
  const customBox = h('div', { class: 'custom-theme', id: 'custom-theme' });
  const swatch = (tok: Record<string, string>) =>
    h(
      'span',
      { class: 'th-swatch', 'aria-hidden': 'true', style: `background:${tok.bg}` },
      h('i', { style: `background:${tok.rail}` }),
      h('b', {}, h('span', { style: `background:${tok.fg}` }), h('span', { style: `background:${tok.accent}` }), h('span', { class: 'card', style: `background:${tok.surface};border-color:${tok.line}` }))
    );
  const paintThemes = () => {
    const cur = getTheme();
    const custom = getCustom();
    const tile = (id: ThemePref, name: string, sub: string, look: HTMLElement | null) => {
      const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(cur === id), class: 'th-tile', 'data-theme-opt': id }, look, h('strong', {}, name), h('span', { class: 'meta' }, sub));
      b.addEventListener('click', () => {
        setTheme(id);
        paintThemes();
      });
      return b;
    };
    themeGroup.replaceChildren(
      tile('system', 'Match the tablet', 'Study desk by day, Night by night', h('span', { class: 'th-swatch split', 'aria-hidden': 'true' }, swatch(themeOf('day').tokens), swatch(themeOf('night').tokens))),
      ...THEMES.map((t) => tile(t.id, t.name, t.hint, swatch(t.tokens))),
      tile('custom', 'Custom', 'Your accent, corners and spacing', swatch(tokensFor('custom', custom)))
    );
    paintCustom(cur === 'custom');
  };
  const paintCustom = (on: boolean) => {
    customBox.hidden = !on;
    if (!on) return customBox.replaceChildren();
    const c = getCustom();
    const save = (next: Partial<CustomTheme>) => {
      setCustom({ ...c, ...next });
      paintThemes();
    };
    const base = h('select', { id: 'custom-base', 'aria-label': 'Start from theme' }, ...THEMES.map((t) => h('option', { value: t.id }, t.name)));
    base.value = c.base;
    base.addEventListener('change', () => save({ base: base.value as ThemeId }));
    const baseTok = themeOf(c.base);
    const accents = h(
      'div',
      { class: 'swatches', role: 'radiogroup', 'aria-label': 'Accent colour', id: 'custom-accent' },
      ...[null, ...CUSTOM_ACCENTS].map((a) => {
        const shown = a ? fitAccent(a, baseTok).accent : baseTok.tokens.accent;
        const b = h('button', { type: 'button', role: 'radio', class: a ? 'sw' : 'sw sw-default', 'aria-checked': String(c.accent === a), 'aria-label': a ? `Accent ${a}` : "Theme's own accent", 'data-accent': a ?? '', style: `--c:${shown}` });
        b.addEventListener('click', () => save({ accent: a }));
        return b;
      })
    );
    const roundOut = h('output', { for: 'custom-round' }, `${c.round} px`);
    const round = h('input', { type: 'range', id: 'custom-round', min: '0', max: '24', step: '2', value: String(c.round), 'aria-label': 'Roundness' });
    round.addEventListener('input', () => (roundOut.textContent = `${round.value} px`));
    round.addEventListener('change', () => save({ round: Number(round.value) }));
    const dens = h(
      'div',
      { class: 'seg', role: 'radiogroup', 'aria-label': 'Spacing', id: 'custom-density' },
      ...DENSITIES.map((d) => {
        const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(c.density === d.id), 'data-density': d.id }, d.name);
        b.addEventListener('click', () => save({ density: d.id }));
        return b;
      })
    );
    customBox.replaceChildren(
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Start from'), base),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Accent', h('small', { class: 'hint' }, 'Made a little darker or lighter if needed, so text in it stays easy to read.')), accents),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Roundness ', roundOut), round),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Spacing'), dens)
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

  const widths: [PageWidth, string, string][] = [
    ['full', 'Full width', 'The note uses the whole screen'],
    ['comfortable', 'Comfortable', 'A reading column, about 90 characters']
  ];
  const widthGroup = h('div', { class: 'seg theme-seg', role: 'radiogroup', 'aria-label': 'Note width' });
  const paintWidths = () => {
    const cur = getPageWidth();
    widthGroup.replaceChildren(
      ...widths.map(([id, name, sub]) => {
        const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(cur === id), class: 'theme-opt', id: `pref-width-${id}` }, h('strong', {}, name), h('span', { class: 'meta' }, sub));
        b.addEventListener('click', () => {
          setPageWidth(id);
          paintWidths();
        });
        return b;
      })
    );
  };
  paintWidths();

  const celebrate = h('input', { type: 'checkbox', id: 'pref-celebrate', checked: celebrationsOn() });
  celebrate.addEventListener('change', () => {
    setCelebrations(celebrate.checked);
    ctx.toast(celebrate.checked ? 'Streak moments are on.' : 'Streak moments are off. The streak still counts.');
  });

  root.replaceChildren(
    h(
      'div',
      { class: 'settings' },
      h('h1', {}, 'Settings'),
      h('section', { class: 'card-block', id: 'theme-block' }, h('h2', {}, 'Theme'), h('p', { class: 'meta' }, 'Colours for the whole app. A note can have its own cover, headings, font and accent (note ⋯ → Note look). PDFs always print on white.'), themeGroup, customBox),
      h(
        'section',
        { class: 'card-block' },
        h('h2', {}, 'Note width'),
        h('p', { class: 'meta' }, 'How wide the writing area is. PDFs are always A4, whichever you pick.'),
        widthGroup
      ),
      h(
        'section',
        { class: 'card-block' },
        h('h2', {}, 'Note font style'),
        h('p', { class: 'meta' }, 'Used across the app. One note can use a different style, set from inside the note. PDFs keep their own print font.'),
        fontGrid
      ),
      h(
        'section',
        { class: 'card-block' },
        h('h2', {}, 'Review'),
        h('label', { class: 'check', for: 'pref-celebrate' }, celebrate, 'Streak moments at 7, 30 and 100 days'),
        h('p', { class: 'meta' }, 'A quiet line in the session summary when your streak reaches one of these. No sounds, no pop-ups.')
      )
    )
  );
  return { route() {}, async flush() {}, async destroy() {} };
}
