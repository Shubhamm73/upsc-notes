import { db } from './db';
import { FolderIndex } from './lib/folders';
import { h } from './lib/h';
import { openSheet } from './lib/sheet';
import { buildSession, loadDue, SECONDS, type QueueItem } from './lib/review';
import type { AppContext } from './app';

export interface SessionPlan { subject: string; seconds: number }
let pending: SessionPlan | null = null;
export function takeSessionPlan() { const plan = pending; pending = null; return plan; }
export function plannedItems(items: QueueItem[], folders: FolderIndex, plan: SessionPlan) {
  const pool = items.filter(it => !plan.subject || (it.type !== 'word' && folders.placeOf(it.note).main?.id === plan.subject));
  let seconds = 0;
  return buildSession(pool).queue.filter(it => {
    if (seconds + SECONDS[it.type] > plan.seconds) return false;
    seconds += SECONDS[it.type]; return true;
  });
}
export async function openSessionPlanner(ctx: AppContext) {
  const [{ items }, folders] = await Promise.all([loadDue(), db.folders.toArray()]);
  const index = new FolderIndex(folders);
  const subject = h('select', { id: 'plan-subject', 'aria-label': 'Review subject' }, h('option', { value: '' }, 'All subjects + words'), ...index.roots('notes').map(f => h('option', { value: f.id }, f.name)));
  const time = h('select', { id: 'plan-time', 'aria-label': 'Session time' }, ...[5, 10, 20, 30].map(n => h('option', { value: String(n * 60) }, `${n} minutes`)));
  const preview = h('div', { class: 'plan-preview', role: 'status', 'aria-live': 'polite' });
  const getPlan = () => ({ subject: subject.value, seconds: Number(time.value) });
  function paint() {
    const queue = plannedItems(items, index, getPlan());
    preview.replaceChildren(h('strong', { id: 'plan-count' }, `${queue.length} ${queue.length === 1 ? 'item' : 'items'} in your session`), h('p', { class: 'meta' }, 'Time is an estimate. Only items that fit the budget are included; everything else stays due.'),
      h('ol', {}, ...queue.map(it => h('li', {}, it.type === 'word' ? it.word.word : it.type === 'insight' ? it.card.text : it.note.title))));
    const start = document.getElementById('plan-start') as HTMLButtonElement | null;
    if (start) start.disabled = !queue.length;
  }
  subject.addEventListener('change', paint); time.addEventListener('change', paint);
  openSheet({ title: 'Make room for a little revision', id: 'session-planner', body: [h('p', { class: 'meta' }, 'Choose your scope and time. Subject sessions include notes and key lines; words belong to the all-subject session.'), h('div', { class: 'plan-fields' }, h('label', {}, 'Subject', subject), h('label', {}, 'Time available', time)), preview], actions: [{ label: 'Cancel' }, { label: 'Start planned session', id: 'plan-start', primary: true, run: () => { if (!plannedItems(items, index, getPlan()).length) return false; pending = getPlan(); ctx.go('#/review'); } }] });
  paint();
}
