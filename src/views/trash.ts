import { liveQuery } from 'dexie';
import { db } from '../db';
import { h } from '../lib/h';
import { deleteForever, emptyTrash, imageCountFor, restoreFromTrash, trashDays, type TrashKind } from '../lib/trash';
import type { AppContext, View } from '../app';

interface Row {
  kind: TrashKind;
  id: string;
  title: string;
  meta: string;
  deletedAt: number;
}

/** In-page confirmation: the button only works once the person types DELETE. */
function confirmPanel(message: string, onConfirm: () => Promise<void>, onCancel: () => void) {
  const input = h('input', { class: 'confirm-input', 'aria-label': 'Type DELETE to confirm', placeholder: 'Type DELETE', autocapitalize: 'characters', autocomplete: 'off' });
  const go = h('button', { type: 'button', class: 'danger-solid', disabled: true }, 'Delete forever');
  const cancel = h('button', { type: 'button' }, 'Cancel');
  input.addEventListener('input', () => (go.disabled = input.value.trim() !== 'DELETE'));
  go.addEventListener('click', async () => {
    go.disabled = true;
    await onConfirm();
  });
  cancel.addEventListener('click', onCancel);
  const panel = h('div', { class: 'confirm-panel', role: 'group', 'aria-label': 'Confirm permanent delete' }, h('p', {}, message), input, h('div', { class: 'actions' }, go, cancel));
  setTimeout(() => input.focus(), 0);
  return panel;
}

export function mountTrash(root: HTMLElement, ctx: AppContext): View {
  const listEl = h('ul', { class: 'trash-list', id: 'trash-list' });
  const intro = h('p', { class: 'trash-intro' });
  const emptyBtn = h('button', { type: 'button', class: 'danger-outline', id: 'empty-trash' }, 'Empty trash');
  const emptyHost = h('div');
  root.replaceChildren(
    h('div', { class: 'settings' }, h('div', { class: 'list-head' }, h('h1', {}, 'Trash'), emptyBtn), intro, emptyHost, listEl)
  );

  let days = 30;
  void trashDays().then((d) => {
    days = d;
    paintIntro();
  });
  const paintIntro = () => {
    intro.textContent =
      days > 0
        ? `Deleted notes and words wait here for ${days} days, then are removed for good. Restore anything you still need.`
        : 'Deleted notes and words stay here until you delete them for good.';
  };
  paintIntro();

  emptyBtn.addEventListener('click', () => {
    emptyHost.replaceChildren(
      confirmPanel(
        'Everything in Trash will be removed from this tablet for good, with its images. This cannot be undone.',
        async () => {
          const n = await emptyTrash();
          emptyHost.replaceChildren();
          ctx.toast(`Deleted forever: ${n} ${n === 1 ? 'item' : 'items'}.`);
        },
        () => emptyHost.replaceChildren()
      )
    );
  });

  const sub = liveQuery(async () => {
    const [notes, words] = await Promise.all([db.notes.filter((n) => !!n.deletedAt).toArray(), db.vocab.filter((w) => !!w.deletedAt).toArray()]);
    const rows: Row[] = [
      ...notes.map((n) => ({ kind: 'note' as const, id: n.id, title: n.title || 'Untitled note', meta: [n.subject, n.topic].filter(Boolean).join(' · '), deletedAt: n.deletedAt! })),
      ...words.map((w) => ({ kind: 'word' as const, id: w.id, title: w.word || 'Untitled word', meta: w.meaning, deletedAt: w.deletedAt! }))
    ];
    return rows.sort((a, b) => b.deletedAt - a.deletedAt);
  }).subscribe({ next: render, error: () => ctx.toast("Couldn't read Trash. Reload the app.") });

  function render(rows: Row[]) {
    emptyBtn.hidden = rows.length === 0;
    listEl.replaceChildren();
    if (!rows.length) {
      listEl.append(h('li', { class: 'empty-row' }, 'Trash is empty.'));
      return;
    }
    for (const r of rows) {
      const ago = Math.floor((Date.now() - r.deletedAt) / 86_400_000);
      const left = days > 0 ? Math.max(0, days - ago) : null;
      const restore = h('button', { type: 'button', class: 'primary' }, 'Restore');
      const del = h('button', { type: 'button', class: 'danger-outline' }, 'Delete forever');
      const confirmHost = h('div');
      restore.addEventListener('click', async () => {
        await restoreFromTrash(r.kind, r.id);
        ctx.toast(`Restored “${r.title}”.`);
      });
      del.addEventListener('click', async () => {
        const imgs = r.kind === 'note' ? await imageCountFor(r.id) : 0;
        confirmHost.replaceChildren(
          confirmPanel(
            `“${r.title}”${imgs ? ` and its ${imgs} ${imgs === 1 ? 'image' : 'images'}` : ''} will be removed from this tablet for good. This cannot be undone.`,
            async () => {
              await deleteForever(r.kind, r.id);
              ctx.toast(`Deleted forever: “${r.title}”.`);
            },
            () => confirmHost.replaceChildren()
          )
        );
      });
      listEl.append(
        h(
          'li',
          { class: 'trash-row' },
          h(
            'div',
            { class: 'trash-info' },
            h('span', { class: `kind kind-${r.kind}` }, r.kind === 'note' ? 'Note' : 'Word'),
            h('strong', {}, r.title),
            r.meta ? h('span', { class: 'meta' }, r.meta) : null,
            h(
              'span',
              { class: 'meta' },
              `Deleted ${ago === 0 ? 'today' : ago === 1 ? 'yesterday' : `${ago} days ago`}${left !== null ? ` · removed for good in ${left} ${left === 1 ? 'day' : 'days'}` : ''}`
            )
          ),
          h('div', { class: 'actions' }, restore, del),
          confirmHost
        )
      );
    }
  }

  return {
    route() {},
    async flush() {},
    async destroy() {
      sub.unsubscribe();
    }
  };
}
