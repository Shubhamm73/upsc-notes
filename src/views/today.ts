import { liveQuery } from 'dexie';
import { db, newId, SUBJECTS, type Note, type ReviewCard, type Vocab } from '../db';
import { buildSession, dueItems, minutesFor, type QueueItem } from '../lib/review';
import { ringValue, subjectRing } from '../lib/rings';
import { currentStreak, getLastNote } from '../lib/activity';
import { ymd } from '../lib/dates';
import { textToDoc } from '../lib/doc';
import { h } from '../lib/h';
import { icon } from '../lib/icons';
import { subjectColor } from '../lib/subjects';
import type { AppContext, View } from '../app';

function greeting(d = new Date()) {
  const hr = d.getHours();
  return hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
}

function ago(ts: number) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} ${hrs === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

export function mountToday(root: HTMLElement, ctx: AppContext): View {
  const dateEl = h('p', { class: 'eyebrow' });
  const headline = h('h1', { class: 'today-title' });
  const streakEl = h('div', { class: 'streak' });
  const dueHost = h('section', { class: 'due-card', 'aria-label': 'Due today' });
  const continueHost = h('section', { class: 'panel continue', 'aria-label': 'Continue writing' });
  const ringsHost = h('div', { class: 'rings' });

  const captureInput = h('input', { id: 'capture', placeholder: 'RBI kept the repo rate at 6.5%. Link to inflation targeting.', autocomplete: 'off' });
  const captureSubject = h('select', { id: 'capture-subject', 'aria-label': 'Subject for the draft' }, ...SUBJECTS.map((s) => h('option', { value: s }, s)));
  captureSubject.value = 'Current affairs';
  const captureBtn = h('button', { type: 'button', class: 'primary', id: 'capture-save' }, 'Save draft');

  root.replaceChildren(
    h(
      'div',
      { class: 'today' },
      h('header', { class: 'today-head' }, h('div', {}, dateEl, headline), streakEl),
      h('div', { class: 'today-grid' }, dueHost, continueHost),
      h(
        'div',
        { class: 'today-grid' },
        h(
          'section',
          { class: 'panel', 'aria-label': 'Subject strength' },
          h('div', { class: 'panel-head' }, h('h2', {}, 'Subject strength'), h('span', { class: 'meta' }, 'notes reviewed and on schedule')),
          ringsHost
        ),
        h(
          'section',
          { class: 'panel capture', 'aria-label': 'Quick capture' },
          h('h2', {}, 'Quick capture'),
          h('label', { for: 'capture', class: 'meta' }, 'An idea now, a full note later'),
          captureInput,
          h('div', { class: 'actions' }, captureSubject, captureBtn)
        )
      )
    )
  );

  const save = async () => {
    const text = captureInput.value.trim();
    if (!text) {
      captureInput.focus();
      return;
    }
    const now = Date.now();
    const firstLine = text.split('\n')[0];
    const title = firstLine.length > 80 ? firstLine.slice(0, 80).replace(/\s+\S*$/, '') + '…' : firstLine;
    const note: Note = {
      id: newId(),
      subject: captureSubject.value,
      topic: 'Quick capture',
      title,
      sections: [{ id: newId(), heading: 'Notes', doc: textToDoc(text) }],
      explain: '',
      connect: '',
      nextReview: ymd(),
      reviewCount: 0,
      lastReviewed: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null
    };
    await db.notes.put(note);
    captureInput.value = '';
    ctx.toast(`Saved to ${note.subject} as a draft. Open it from Notes to expand it.`);
  };
  captureBtn.addEventListener('click', () => void save());
  captureInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void save();
    }
  });

  const now = new Date();
  dateEl.textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

  const firstLabel = (it: QueueItem) =>
    it.type === 'insight'
      ? `a key line from ${it.note.title || 'Untitled note'}`
      : it.type === 'word'
        ? `the word “${it.word.word || 'Untitled word'}”`
        : it.note.title || 'Untitled note';

  async function paint(notes: Note[], words: Vocab[], cards: ReviewCard[]) {
    const today = ymd();
    const liveNotes = notes.filter((n) => !n.deletedAt);
    const due = dueItems(notes, words, cards, today);
    const count = (t: QueueItem['type']) => due.filter((i) => i.type === t).length;
    const [dueInsights, dueWords, dueNotes] = [count('insight'), count('word'), count('note')];
    const total = due.length;

    headline.textContent = !liveNotes.length
      ? `${greeting(now)}. Let's write your first note.`
      : total
        ? `${greeting(now)}. ${total} ${total === 1 ? 'thing is' : 'things are'} due today.`
        : `${greeting(now)}. You're all caught up.`;

    const streak = await currentStreak();
    streakEl.replaceChildren(
      icon('flame', 18),
      streak.days ? `${streak.days}-day streak` : 'Start a streak today'
    );
    streakEl.classList.toggle('lit', streak.days > 0);

    // Due card: one queue of key lines, words and notes; chips start a session of one kind.
    if (total) {
      const chip = (n: number, one: string, many: string, href: string, id: string) =>
        n ? h('a', { class: 'due-chip', href, id }, h('strong', {}, String(n)), ` ${n === 1 ? one : many}`) : null;
      const chips = h(
        'div',
        { class: 'due-chips' },
        chip(dueInsights, 'key line', 'key lines', '#/review/insights', 'due-insights'),
        chip(dueWords, 'word', 'words', '#/review/words', 'due-words'),
        chip(dueNotes, 'note', 'notes', '#/review/notes', 'due-notes')
      );
      const first = buildSession(due).queue[0];
      const start = h('a', { class: 'start-review', id: 'start-review', href: '#/review' }, 'Start review', icon('arrow', 20));
      dueHost.replaceChildren(
        h('div', { class: 'panel-head' }, h('h2', {}, 'Due today'), h('span', { id: 'due-summary' }, `${total} ${total === 1 ? 'item' : 'items'} · about ${minutesFor(due)} min`)),
        chips,
        h('p', { class: 'due-next' }, `Starts with ${firstLabel(first)}.`),
        start
      );
    } else {
      const write = h('a', { class: 'start-review', href: '#/n/new' }, 'Write a new note', icon('arrow', 20));
      dueHost.replaceChildren(
        h('div', { class: 'panel-head' }, h('h2', {}, 'Due today')),
        h('p', { class: 'due-next' }, liveNotes.length ? 'Nothing is due. A good day to write something new.' : 'Notes you write and review will be scheduled here.'),
        write
      );
    }

    // Continue writing
    const lastId = await getLastNote();
    const last = liveNotes.find((n) => n.id === lastId) ?? [...liveNotes].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (last) {
      const marks = last.insights?.items.length ?? 0;
      continueHost.replaceChildren(
        h('p', { class: 'eyebrow' }, 'Continue writing'),
        h('div', { class: 'chip-row' }, h('span', { class: 'subject-tag' }, h('span', { class: 'dot', style: `background: ${subjectColor(last.subject)}` }), last.subject), last.topic ? h('span', { class: 'meta' }, last.topic) : null),
        h('h3', { class: 'continue-title' }, last.title || 'Untitled note'),
        h(
          'p',
          { class: 'meta' },
          `Edited ${ago(last.updatedAt)} · ${last.sections.length} ${last.sections.length === 1 ? 'section' : 'sections'}`,
          marks ? h('span', { class: 'mark-pill' }, `${marks} key ${marks === 1 ? 'line' : 'lines'}`) : null
        ),
        h('div', { class: 'spacer' }),
        h('a', { class: 'button', id: 'resume', href: `#/n/${last.id}` }, 'Resume')
      );
    } else {
      continueHost.replaceChildren(
        h('p', { class: 'eyebrow' }, 'Continue writing'),
        h('h3', { class: 'continue-title' }, 'No notes yet'),
        h('p', { class: 'meta' }, 'Start with one concept you understood today.'),
        h('div', { class: 'spacer' }),
        h('a', { class: 'button primary', href: '#/n/new' }, 'New note')
      );
    }

    // Subject rings: share of a subject's notes that are reviewed and not overdue
    ringsHost.replaceChildren(...SUBJECTS.map((s) => subjectRing(s, ringValue(liveNotes, s, today), { href: `#/notes/s/${encodeURIComponent(s)}` })));
  }

  const sub = liveQuery(() => Promise.all([db.notes.toArray(), db.vocab.toArray(), db.cards.where('due').belowOrEqual(ymd()).toArray()])).subscribe({
    next: ([n, w, c]) => void paint(n, w, c),
    error: () => ctx.toast("Couldn't read your notes. Reload the app.")
  });

  return {
    route() {},
    async flush() {},
    async destroy() {
      sub.unsubscribe();
    }
  };
}
