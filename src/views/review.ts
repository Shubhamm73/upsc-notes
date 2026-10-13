import type { Editor } from '@tiptap/core';
import { db, SUBJECTS, type Note } from '../db';
import { createEditor } from '../editor/editor';
import { currentStreak, milestoneText } from '../lib/activity';
import { prettyDate, ymd } from '../lib/dates';
import { h } from '../lib/h';
import { icon } from '../lib/icons';
import { celebrationsOn } from '../lib/prefs';
import { animateRingGain, ringValue, subjectRing } from '../lib/rings';
import {
  buildSession,
  filterItems,
  loadDue,
  minutesFor,
  rateItem,
  stepOfItem,
  subjectOf,
  type QueueItem,
  type RateResult,
  type SessionFilter
} from '../lib/review';
import { whenLabel, type Rating } from '../lib/schedule';
import { subjectColor } from '../lib/subjects';
import type { AppContext, View } from '../app';

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Again brings a card back this many cards later. */
const AGAIN_GAP = 3;
/** Swipes that start this close to the screen edge are Android's back gesture, not a rating. */
const EDGE = 24;
const FILTERS: SessionFilter[] = ['all', 'insights', 'words', 'notes'];
const RATINGS: { r: Rating; label: string }[] = [
  { r: 'again', label: 'Again' },
  { r: 'hard', label: 'Hard' },
  { r: 'easy', label: 'Easy' }
];
const KIND_LABEL = { insight: 'Insight card', word: 'Word', note: 'Whole note' } as const;

const times = (n: number) => (n === 0 ? 'not reviewed yet' : n === 1 ? 'reviewed once' : n === 2 ? 'reviewed twice' : `reviewed ${n} times`);

function subjectTag(subject: string) {
  return h('span', { class: 'subject-tag' }, h('span', { class: 'dot', style: `background: ${subjectColor(subject)}` }), subject);
}

/**
 * The review session (#/review, #/review/insights|words|notes): one card at a time, full screen.
 * Every rating is saved the moment it is made; the session itself is screen state only.
 */
export function mountReview(root: HTMLElement, ctx: AppContext): View {
  let filter: SessionFilter = 'all';
  let queue: QueueItem[] = [];
  let index = 0;
  let revealed = false;
  let busy = false;
  let inSummary = false;
  let startedAt = 0;
  /** Unique items rated this session. */
  const seen = new Map<string, QueueItem>();
  let ratings = 0;
  /** A rating is being written; an undo pressed meanwhile waits for it (undoAsked). */
  let saving = false;
  let undoAsked = false;
  let milestone: number | null = null;
  let ringsBefore = new Map<string, number | null>();
  /** "Key line 2 of 4" for each insight card, by card id. */
  let siblings = new Map<string, { n: number; of: number }>();
  let last: { res: RateResult; item: QueueItem; index: number; againAt: number; wasSeen: boolean } | null = null;
  let editors: Editor[] = [];
  let ghost: HTMLElement | null = null;
  let token = 0;

  document.body.classList.add('reviewing');

  // ---------- frame ----------
  const closeBtn = h('button', { type: 'button', class: 'rv-icon', id: 'rv-close', 'aria-label': 'End review session' }, icon('close', 20));
  const countEl = h('strong', { class: 'rv-count', id: 'rv-count' });
  const undoBtn = h(
    'button',
    { type: 'button', class: 'rv-undo', id: 'rv-undo', disabled: true, title: 'Undo last rating (Ctrl Z)' },
    icon('undo', 18),
    h('span', {}, 'Undo')
  );
  const leftEl = h('span', { class: 'rv-left meta', id: 'rv-left' });
  const bar = h('div', { class: 'rv-bar' });
  const progress = h('div', { class: 'rv-progress', role: 'progressbar', 'aria-label': 'Session progress', 'aria-valuemin': '0' }, bar);
  const card = h('section', { class: 'rv-card', id: 'rv-card', 'aria-label': 'Flashcard', 'aria-live': 'polite' });
  const hint = h('p', { class: 'rv-hint meta', id: 'rv-hint' });
  const foot = h('footer', { class: 'rv-foot', id: 'rv-foot', 'aria-label': 'Rate this card' });
  const stage = h('div', { class: 'rv-main' }, card, hint);
  const screen = h(
    'div',
    { class: 'review-screen', id: 'review' },
    h('header', { class: 'rv-head' }, h('div', { class: 'rv-row' }, closeBtn, countEl, undoBtn, h('div', { class: 'spacer' }), leftEl), progress),
    stage,
    foot
  );
  root.replaceChildren(screen);

  closeBtn.addEventListener('click', () => end());
  undoBtn.addEventListener('click', () => void undo());

  function destroyEditors() {
    for (const e of editors) e.destroy();
    editors = [];
  }

  // ---------- starting ----------
  async function start(f: SessionFilter) {
    const my = ++token;
    filter = f;
    destroyEditors();
    const today = ymd();
    const { items: due, notes } = await loadDue(today);
    if (my !== token) return;
    const built = buildSession(due, filter);
    queue = built.queue;
    index = 0;
    revealed = false;
    inSummary = false;
    seen.clear();
    ratings = 0;
    milestone = null;
    last = null;
    startedAt = Date.now();
    ringsBefore = new Map(SUBJECTS.map((s) => [s, ringValue(notes, s, today)]));
    // "Key line 2 of 4 in this section" needs every live card of the notes in this session.
    const noteIds = [...new Set(queue.filter((i) => i.type === 'insight').map((i) => (i.type === 'insight' ? i.note.id : '')))];
    const cards = noteIds.length ? await db.cards.where('noteId').anyOf(noteIds).toArray() : [];
    if (my !== token) return;
    siblings = new Map();
    const groups = new Map<string, typeof cards>();
    for (const c of cards) {
      if (c.retiredAt) continue;
      const k = `${c.noteId}\u0000${c.section}`;
      groups.set(k, [...(groups.get(k) ?? []), c]);
    }
    for (const g of groups.values()) g.sort((a, b) => a.pos - b.pos).forEach((c, i) => siblings.set(c.id, { n: i + 1, of: g.length }));
    if (!queue.length) return renderEmpty();
    renderCard(false);
  }

  function renderEmpty() {
    inSummary = true;
    paintHead();
    const what = filter === 'insights' ? 'No key lines are' : filter === 'words' ? 'No words are' : filter === 'notes' ? 'No notes are' : 'Nothing is';
    card.className = 'rv-card rv-done';
    card.replaceChildren(
      h('h1', { class: 'rv-title' }, `${what} due right now.`),
      h('p', { class: 'meta' }, "You're all caught up. Highlights you mark in a note become cards here after you mark the note reviewed.")
    );
    hint.textContent = '';
    const back = h('a', { class: 'button primary rv-wide', href: '#/', id: 'rv-done' }, 'Back to Today');
    foot.className = 'rv-foot one';
    foot.replaceChildren(back);
  }

  // ---------- header ----------
  function paintHead() {
    const total = queue.length;
    countEl.textContent = inSummary ? (total ? 'Done' : '') : `${Math.min(index + 1, total)} of ${total}`;
    leftEl.textContent = inSummary || !total ? '' : `about ${minutesFor(queue.slice(index))} min left`;
    const done = inSummary ? total : index;
    progress.setAttribute('aria-valuemax', String(total));
    progress.setAttribute('aria-valuenow', String(done));
    bar.style.transform = `scaleX(${total ? done / total : 0})`;
    undoBtn.disabled = !last || busy;
  }

  // ---------- card faces ----------
  function front(it: QueueItem): HTMLElement[] {
    const tagRow = h(
      'div',
      { class: 'rv-tags' },
      subjectOf(it) ? subjectTag(subjectOf(it) as string) : null,
      h('span', { class: 'meta' }, KIND_LABEL[it.type])
    );
    if (it.type === 'insight') {
      const c = it.card;
      const sib = siblings.get(c.id);
      const hasContext = !!(c.before.trim() || c.after.trim());
      return [
        tagRow,
        h(
          'div',
          {},
          h('p', { class: 'rv-sub' }, it.note.title || 'Untitled note'),
          h('h1', { class: 'rv-title' }, c.section),
          hasContext ? h('p', { class: 'rv-cloze', id: 'rv-cloze' }, c.before, h('span', { class: 'rv-blank', 'aria-label': 'blank' }, '?'), c.after) : null,
          h('p', { class: 'rv-prompt' }, hasContext ? 'What goes in the blank? It is the key line you marked.' : 'What was the key line you marked here?'),
          !hasContext && sib && sib.of > 1 ? h('p', { class: 'meta', id: 'rv-which' }, `Key line ${sib.n} of ${sib.of} in this section`) : null
        )
      ];
    }
    if (it.type === 'word') {
      return [
        tagRow,
        h(
          'div',
          {},
          h('h1', { class: 'rv-title rv-word' }, it.word.word || 'Untitled word'),
          h('p', { class: 'rv-prompt' }, 'What does it mean? Use it in a sentence.')
        )
      ];
    }
    const n = it.note;
    return [
      tagRow,
      h(
        'div',
        {},
        n.topic.trim() ? h('p', { class: 'rv-sub' }, n.topic) : null,
        h('h1', { class: 'rv-title' }, n.title || 'Untitled note'),
        h('p', { class: 'rv-prompt' }, 'Explain it in your own words before you look.')
      )
    ];
  }

  function back(it: QueueItem): HTMLElement {
    if (it.type === 'insight') {
      const c = it.card;
      return h(
        'div',
        { class: 'rv-answer', id: 'rv-answer' },
        h('p', { class: 'rv-line' }, h('mark', {}, c.text)),
        h('p', { class: 'meta' }, `Marked on ${prettyDate(ymd(new Date(c.createdAt)))} · ${times(c.reps)} · `, h('a', { href: `#/n/${c.noteId}` }, 'Open note'))
      );
    }
    if (it.type === 'word') {
      const w = it.word;
      const chips = (label: string, list: string[]) =>
        list.length ? h('div', { class: 'rv-chips' }, h('span', { class: 'meta' }, label), ...list.map((x) => h('span', { class: 'chip rv-chip' }, x))) : null;
      return h(
        'div',
        { class: 'rv-answer', id: 'rv-answer' },
        h('p', { class: 'rv-meaning' }, w.meaning || 'No meaning written yet.'),
        w.uses.filter((u) => u.sentence.trim()).length
          ? h(
              'ul',
              { class: 'rv-uses' },
              ...w.uses.filter((u) => u.sentence.trim()).map((u) => h('li', {}, u.sentence, ' ', h('span', { class: 'kind' }, u.context)))
            )
          : null,
        chips('Synonyms', w.synonyms),
        chips('Antonyms', w.antonyms),
        h('p', { class: 'meta' }, `${times(w.reviewCount)} · `, h('a', { href: `#/v/${w.id}` }, 'Open word'))
      );
    }
    const n = it.note;
    const body = h('div', { class: 'rv-note' });
    for (const s of n.sections) {
      const el = h('div', { class: 'rv-section-body' });
      body.append(h('section', { class: 'rv-section' }, s.heading.trim() ? h('h2', { class: 'rv-section-head' }, s.heading) : null, el));
      // Read-only, and its changes go nowhere: the review never writes the note's text.
      editors.push(createEditor({ element: el, content: s.doc, editable: false, onChange: () => undefined, onFocus: () => undefined, placeholder: '' }));
    }
    return h(
      'div',
      { class: 'rv-answer', id: 'rv-answer' },
      h(
        'div',
        { class: 'rv-own' },
        h('span', { class: 'eyebrow' }, 'Your own words'),
        h('p', {}, n.explain.trim() || 'Not written yet. Add them from the note’s Reflect section.')
      ),
      body,
      h('p', { class: 'meta' }, `${times(n.reviewCount)} · `, h('a', { href: `#/n/${n.id}` }, 'Open note'))
    );
  }

  function paintCard() {
    const it = queue[index];
    destroyEditors();
    card.className = `rv-card is-${it.type}${revealed ? ' revealed' : ''}`;
    card.style.transform = '';
    card.replaceChildren(...front(it), ...(revealed ? [back(it)] : []));
    if (revealed) {
      const step = stepOfItem(it);
      foot.className = 'rv-foot';
      foot.replaceChildren(
        ...RATINGS.map(({ r, label }) => {
          const b = h(
            'button',
            { type: 'button', class: `rate rate-${r}`, id: `rate-${r}`, 'data-rating': r },
            h('strong', {}, label),
            h('span', {}, whenLabel(step, r))
          );
          b.addEventListener('click', () => void rate(r));
          return b;
        })
      );
      hint.textContent = 'Swipe left for Again, right for Easy';
    } else {
      const show = h('button', { type: 'button', class: 'primary rv-show rv-wide', id: 'rv-show' }, 'Show answer');
      show.addEventListener('click', () => void reveal());
      foot.className = 'rv-foot one';
      foot.replaceChildren(show);
      hint.textContent = window.matchMedia('(pointer: fine)').matches
        ? 'Space shows the answer · 1 Again · 2 Hard · 3 Easy'
        : 'Tap the card or swipe up to see the answer';
    }
    paintHead();
  }

  function renderCard(settle: boolean) {
    stopMotion();
    paintCard();
    window.scrollTo(0, 0);
    if (settle && !reducedMotion()) {
      card.animate(
        [
          { opacity: 0, transform: 'translateY(12px)' },
          { opacity: 1, transform: 'none' }
        ],
        { duration: 200, easing: 'ease-out' }
      );
    }
  }

  // ---------- reveal: a 240 ms flip ----------
  async function reveal() {
    if (busy || revealed || inSummary || !queue.length) return;
    revealed = true;
    if (reducedMotion()) return paintCard();
    busy = true;
    try {
      await card.animate([{ transform: 'perspective(1400px) rotateY(0deg)' }, { transform: 'perspective(1400px) rotateY(90deg)' }], {
        duration: 120,
        easing: 'ease-in'
      }).finished;
    } catch {
      /* cancelled: show the answer anyway */
    }
    busy = false;
    paintCard();
    // The second half is only a look: the rating buttons work from the moment they appear
    // (a rating cancels it, see stopMotion).
    card.animate([{ transform: 'perspective(1400px) rotateY(-90deg)' }, { transform: 'perspective(1400px) rotateY(0deg)' }], {
      duration: 120,
      easing: 'ease-out'
    });
  }

  /** Ends the card's flip or settle-in at once, so the next frame starts clean. */
  function stopMotion() {
    for (const a of card.getAnimations()) a.cancel();
  }

  // ---------- rating ----------
  /** The rated card slides out (200 ms) as a copy, while the next card settles in under it. */
  function slideOut(r: Rating, fromX = 0) {
    if (reducedMotion()) return;
    const rect = card.getBoundingClientRect();
    ghost?.remove();
    const g = card.cloneNode(true) as HTMLElement;
    g.removeAttribute('id');
    g.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    g.classList.add('rv-ghost');
    g.setAttribute('aria-hidden', 'true');
    Object.assign(g.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      transform: card.style.transform
    });
    document.body.append(g);
    ghost = g;
    const dir = r === 'again' ? -1 : 1;
    const startT = fromX ? `translateX(${fromX}px) rotate(${fromX / 25}deg)` : 'none';
    const endT = r === 'hard' ? 'translateY(40px)' : `translateX(${dir * (window.innerWidth * 0.9)}px) rotate(${dir * 8}deg)`;
    g.animate(
      [
        { transform: startT, opacity: 1 },
        { transform: endT, opacity: 0 }
      ],
      { duration: 200, easing: 'ease-in' }
    ).finished.finally(() => {
      g.remove();
      if (ghost === g) ghost = null;
    });
  }

  async function rate(r: Rating, fromX = 0) {
    if (busy || !revealed || inSummary) return;
    busy = saving = true;
    const it = queue[index];
    const wasSeen = seen.has(it.id);
    let res: RateResult;
    try {
      res = await rateItem(it, r);
    } catch {
      busy = saving = undoAsked = false;
      card.style.transform = '';
      ctx.toast("Couldn't save that rating. Try again.");
      return;
    }
    saving = false;
    stopMotion();
    slideOut(r, fromX);
    ratings++;
    seen.set(it.id, it);
    let againAt = -1;
    if (r === 'again') {
      againAt = Math.min(index + 1 + AGAIN_GAP, queue.length);
      queue.splice(againAt, 0, it);
    }
    if (res.milestone) milestone = res.milestone;
    last = { res, item: it, index, againAt, wasSeen };
    index++;
    revealed = false;
    busy = false;
    if (undoAsked) {
      // Undo was pressed while this rating was still being saved: take it back now.
      undoAsked = false;
      return void undo();
    }
    if (index >= queue.length) void showSummary();
    else renderCard(true);
  }

  async function undo() {
    if (saving) {
      undoAsked = true;
      return;
    }
    if (!last || busy) return;
    busy = true;
    token++; // a summary still loading (undo right after the last card) must not paint over the card
    const u = last;
    last = null;
    try {
      await u.res.undo();
    } catch {
      busy = false;
      ctx.toast("Couldn't undo that rating.");
      return;
    }
    if (u.againAt >= 0) queue.splice(u.againAt, 1);
    if (!u.wasSeen) seen.delete(u.item.id);
    if (u.res.milestone && milestone === u.res.milestone) milestone = null;
    ratings--;
    index = u.index;
    revealed = false;
    inSummary = false;
    busy = false;
    renderCard(true);
    ctx.toast('Rating undone. The card is back.');
  }

  function end() {
    if (inSummary || !ratings) ctx.go('#/');
    else void showSummary();
  }

  // ---------- summary ----------
  async function showSummary() {
    const my = ++token;
    inSummary = true;
    destroyEditors();
    const today = ymd();
    const [{ items: due, notes }, streak] = await Promise.all([loadDue(today), currentStreak()]);
    if (my !== token) return;
    const more = filterItems(due, filter).length;
    paintHead();
    const mins = Math.round((Date.now() - startedAt) / 60000);
    const items = [...seen.values()];
    const subjects = SUBJECTS.filter((s) => items.some((i) => subjectOf(i) === s));
    const counts = (s: string) => items.filter((i) => subjectOf(i) === s).length;
    const ringsEl = h(
      'div',
      { class: 'rv-rings', id: 'rv-rings' },
      ...subjects.map((s) => {
        const after = ringValue(notes as Note[], s, today);
        const el = subjectRing(s, after, { from: ringsBefore.get(s) ?? null });
        el.append(h('span', { class: 'meta' }, `${counts(s)} ${counts(s) === 1 ? 'card' : 'cards'}`));
        return el;
      })
    );
    const wordsDone = items.filter((i) => i.type === 'word').length;
    const streakNum = h('span', { class: 'rv-streak-num', id: 'rv-streak' }, String(streak.days));
    card.className = 'rv-card rv-summary';
    card.style.transform = '';
    card.replaceChildren(
      ...(
        [
          h('div', { class: 'rv-tags' }, h('span', { class: 'meta' }, 'Session summary')),
          h('h1', { class: 'rv-title' }, index >= queue.length ? 'Session done' : 'Good stopping point'),
          h(
            'dl',
            { class: 'rv-stats' },
            h('div', {}, h('dt', {}, 'Cards'), h('dd', { id: 'rv-sum-cards' }, String(items.length))),
            h('div', {}, h('dt', {}, 'Time'), h('dd', { id: 'rv-sum-time' }, mins < 1 ? 'under a minute' : `${mins} min`)),
            h(
              'div',
              {},
              h('dt', {}, 'Streak'),
              h('dd', { class: 'rv-streak' }, icon('flame', 20), h('span', { class: 'rv-roll' }, streakNum), streak.days === 1 ? ' day' : ' days')
            )
          ),
          milestone && celebrationsOn() ? h('p', { class: 'rv-milestone', id: 'rv-milestone' }, icon('flame', 18), milestoneText(milestone)) : null,
          subjects.length ? h('div', {}, h('p', { class: 'eyebrow' }, 'Subjects you reviewed'), ringsEl) : null,
          wordsDone ? h('p', { class: 'meta' }, `${wordsDone} ${wordsDone === 1 ? 'word' : 'words'} reviewed.`) : null
        ] as (HTMLElement | null)[]
      ).filter((x): x is HTMLElement => x !== null)
    );
    hint.textContent = '';
    const done = h('a', { class: 'button rv-wide', href: '#/', id: 'rv-done' }, 'Done');
    const again = more ? h('button', { type: 'button', class: 'primary rv-wide', id: 'rv-more' }, `Keep going (${more} more)`) : null;
    again?.addEventListener('click', () => void start(filter));
    foot.className = more ? 'rv-foot two' : 'rv-foot one';
    foot.replaceChildren(done, ...(again ? [again] : []));
    if (!reducedMotion()) {
      animateRingGain(ringsEl);
      streakNum.animate(
        [
          { transform: 'translateY(70%)', opacity: 0 },
          { transform: 'none', opacity: 1 }
        ],
        { duration: 300, easing: 'ease-out' }
      );
    }
  }

  // ---------- swipe ----------
  let drag: { x: number; y: number; t: number; id: number; axis: '' | 'x' | 'y'; dx: number; dy: number } | null = null;
  let suppressClick = false;
  card.addEventListener('pointerdown', (e) => {
    if (busy || inSummary || e.button > 0 || !queue.length) return;
    if (e.clientX < EDGE || e.clientX > window.innerWidth - EDGE) return;
    const t = e.target as HTMLElement;
    if (t.closest('a, button')) return;
    // Sideways drags that scroll something (a wide table) are not swipes, nor a pen stroke on a sketch
    // (it would rate the note by accident); with a mouse, a drag over the note's text selects it.
    if (t.closest('.tableWrapper, .chart-block, .sketch-block') || (e.pointerType === 'mouse' && t.closest('.rv-note'))) return;
    drag = { x: e.clientX, y: e.clientY, t: e.timeStamp, id: e.pointerId, axis: '', dx: 0, dy: 0 };
  });
  card.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.dx = e.clientX - drag.x;
    drag.dy = e.clientY - drag.y;
    if (!drag.axis) {
      if (revealed && Math.abs(drag.dx) > 12 && Math.abs(drag.dx) > Math.abs(drag.dy) * 1.2) drag.axis = 'x';
      else if (!revealed && drag.dy < -12 && Math.abs(drag.dy) > Math.abs(drag.dx)) drag.axis = 'y';
      else return;
      card.setPointerCapture(e.pointerId);
      card.classList.add('dragging');
    }
    if (drag.axis === 'x') {
      card.style.transform = `translateX(${drag.dx}px) rotate(${drag.dx / 25}deg)`;
      const lean = Math.abs(drag.dx) > card.offsetWidth * 0.3 ? (drag.dx < 0 ? 'again' : 'easy') : '';
      if (lean) card.dataset.lean = lean;
      else delete card.dataset.lean;
    } else {
      card.style.transform = `translateY(${Math.max(drag.dy, -80) * 0.5}px)`;
    }
  });
  const springBack = () => {
    const from = card.style.transform;
    card.style.transform = '';
    if (from && !reducedMotion()) card.animate([{ transform: from }, { transform: 'none' }], { duration: 200, easing: 'ease-out' });
  };
  const finishDrag = (e: PointerEvent, cancelled: boolean) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    card.classList.remove('dragging');
    delete card.dataset.lean;
    if (!d.axis) {
      // A tap shows the answer here, not on 'click': Chrome drops the click of a tap that lands
      // while the last swipe's fling is still settling (a quick tap on the next card). The click
      // handler below stays for keyboards and screen readers; reveal() runs once either way.
      if (!cancelled && Math.abs(d.dx) < 10 && Math.abs(d.dy) < 10) void reveal();
      return;
    }
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
    const speed = Math.abs(d.dx) / Math.max(1, e.timeStamp - d.t);
    if (!cancelled && d.axis === 'x' && (Math.abs(d.dx) > card.offsetWidth * 0.3 || (Math.abs(d.dx) > 40 && speed > 0.6))) {
      void rate(d.dx < 0 ? 'again' : 'easy', d.dx);
    } else if (!cancelled && d.axis === 'y' && d.dy < -60) {
      card.style.transform = '';
      void reveal();
    } else springBack();
  };
  card.addEventListener('pointerup', (e) => finishDrag(e, false));
  card.addEventListener('pointercancel', (e) => finishDrag(e, true));
  card.addEventListener('click', (e) => {
    if (suppressClick || revealed || inSummary) return;
    if ((e.target as HTMLElement).closest('a, button')) return;
    void reveal();
  });

  // ---------- keys ----------
  const onKey = (e: KeyboardEvent) => {
    // Keys typed into a field (Ctrl+K search, the search's Esc) belong to that field.
    const target = e.target as HTMLElement | null;
    if (e.defaultPrevented || target?.closest?.('input, textarea, select, [contenteditable="true"]') || document.querySelector('.search-overlay')) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      void undo();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const onControl = target?.closest?.('a, button');
    if (e.key === 'Escape') {
      e.preventDefault();
      end();
    } else if ((e.key === ' ' || e.key === 'Enter') && !onControl && !revealed && !inSummary) {
      e.preventDefault();
      void reveal();
    } else if (revealed && !inSummary) {
      const r: Rating | null =
        e.key === '1' || e.key === 'ArrowLeft' ? 'again' : e.key === '2' ? 'hard' : e.key === '3' || e.key === 'ArrowRight' ? 'easy' : null;
      if (r) {
        e.preventDefault();
        void rate(r);
      }
    }
  };
  document.addEventListener('keydown', onKey);

  return {
    route(parts) {
      const f = (parts[1] ?? 'all') as SessionFilter;
      void start(FILTERS.includes(f) ? f : 'all');
    },
    async flush() {},
    async destroy() {
      token++;
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('reviewing');
      destroyEditors();
      ghost?.remove();
    }
  };
}
