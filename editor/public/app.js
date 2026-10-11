/* Local content editor — vanilla JS, no deps.
 * Schema-driven tables + cards. API contract: GET /api/state,
 * POST /api/save {file, data}, POST /api/upload {name, base64}. */
'use strict';

let schema = null;      // FILES array from server
let data = null;        // { key: parsed JSON }
let config = null;      // { repo, branch, dryRun, hasToken }
let active = null;      // current file key
let dirty = false;
let dirtyFile = null;

/* ---------- tiny DOM helper ---------- */

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  attrs = attrs || {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

/* ---------- state ---------- */

function markDirty() {
  if (!dirty || dirtyFile !== active) {
    dirty = true;
    dirtyFile = active;
    document.getElementById('dirty-flag').hidden = false;
    document.getElementById('save-btn').classList.add('is-dirty');
    const btn = document.querySelector('#file-list button[data-key="' + active + '"]');
    if (btn) btn.classList.add('has-unsaved');
  }
}

function clearDirty() {
  dirty = false;
  dirtyFile = null;
  document.getElementById('dirty-flag').hidden = true;
  document.getElementById('save-btn').classList.remove('is-dirty');
  document.querySelectorAll('#file-list button.has-unsaved').forEach((b) => b.classList.remove('has-unsaved'));
}

function setStatus(msg, kind) {
  const s = document.getElementById('status');
  s.textContent = msg || '';
  s.className = 'status' + (kind ? ' status-' + kind : '');
  const issues = document.getElementById('issues');
  issues.innerHTML = '';
  issues.hidden = true;
}

function setIssues(list) {
  const issues = document.getElementById('issues');
  issues.innerHTML = '';
  const s = document.getElementById('status');
  if (!list || !list.length) {
    issues.hidden = true;
    return;
  }
  issues.hidden = false;
  s.textContent = 'Validation failed — ' + list.length + ' issue' + (list.length > 1 ? 's' : '') + ':';
  s.className = 'status status-err';
  for (const i of list) {
    issues.append(el('li', {}, el('code', {}, i.path), i.message));
  }
}

/* ---------- undo toast (light delete friction) ---------- */

const toastWrap = () => document.getElementById('toast-wrap');

function toast(msg, actionLabel, onAction, ms) {
  const wrap = toastWrap();
  const t = el('div', { class: 'toast', role: 'status' }, el('span', {}, msg));
  const kill = () => { if (t.parentNode) t.parentNode.removeChild(t); };
  if (actionLabel && onAction) {
    t.append(el('button', { type: 'button', onclick: () => { onAction(); kill(); } }, actionLabel));
  }
  wrap.append(t);
  setTimeout(kill, ms || 8000);
}

function deletable(arr, index, label, redraw) {
  const removed = arr.splice(index, 1)[0];
  markDirty();
  redraw();
  toast('Removed ' + label, 'Undo', () => {
    arr.splice(Math.min(index, arr.length), 0, removed);
    markDirty();
    redraw();
  });
}

/* ---------- schema helpers ---------- */

function emptyValue(f) {
  switch (f.type) {
    case 'string': return '';
    case 'text': return '';
    case 'number': return 0;
    case 'boolean': return false;
    case 'select': return f.options[0];
    case 'image': return '';
    case 'object': {
      const o = {};
      for (const sub of f.fields) o[sub.name] = emptyValue(sub);
      return o;
    }
    case 'list': return [];
    default: return '';
  }
}

function blankListItem(f) {
  if (f.itemType === 'string') return '';
  const o = {};
  for (const sub of (f.itemFields || [])) o[sub.name] = emptyValue(sub);
  return o;
}

function isLineList(f) {
  if (f.type !== 'list' || f.itemType === 'string' || !f.itemFields) return false;
  const names = f.itemFields.map((x) => x.name);
  return names.length === 3 && names[0] === 'text' && names[1] === 'style' && names[2] === 'indent';
}

function isStringList(f) {
  return f.type === 'list' && f.itemType === 'string';
}

function subLists(f) {
  return (f.itemFields || []).filter((s) => s.type === 'list');
}

function scalarSubs(f) {
  return (f.itemFields || []).filter((s) => s.type !== 'list' && s.type !== 'object');
}

function hasTextCol(f) {
  return (f.itemFields || []).some((s) => s.type === 'text');
}

function hasImageCol(f) {
  return (f.itemFields || []).some((s) => s.type === 'image');
}

function shortCol(sf) {
  if (sf.type === 'number') return '84px';
  if (sf.type === 'boolean') return '64px';
  if (sf.type === 'select') return '128px';
  if (sf.type === 'image') return 'minmax(170px,1.2fr)';
  if (sf.type === 'text') return 'minmax(170px,1.5fr)';
  if (/^(number|year|id|letter|index|indent|arrow|size)$/i.test(sf.name)) return '104px';
  if (/^(label|category|role|href|link|display)$/i.test(sf.name)) return 'minmax(130px,1fr)';
  return 'minmax(150px,1fr)';
}

function labelOf(f) {
  return f.label + (f.required === false ? '' : '');
}

/* ---------- leaf controls ---------- */

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.max(ta.scrollHeight, 64) + 'px';
}

function bindAutosize(ta) {
  const fit = () => autosize(ta);
  ta.addEventListener('input', fit);
  requestAnimationFrame(fit);
}

const LONG_HINT = /description|meta|lead|intro|support|outcome|text/i;

function makeTextControl(f, obj) {
  const ta = el('textarea', {
    rows: '3',
    placeholder: f.label + '…  (plain text — no HTML)',
    oninput: (e) => { obj[f.name] = e.target.value; markDirty(); syncCount(); },
  });
  ta.value = obj[f.name] == null ? '' : obj[f.name];
  const count = el('div', { class: 'char-count' });
  const syncCount = () => {
    const n = (ta.value || '').length;
    count.textContent = n + ' char' + (n === 1 ? '' : 's');
  };
  syncCount();
  bindAutosize(ta);
  const wrap = el('div', { class: 'field-control' }, ta, count);
  if (LONG_HINT.test(f.name + ' ' + f.label)) {
    wrap.append(el('div', { class: 'field-hint' }, 'Shown exactly as typed on the live site.'));
  }
  return wrap;
}

function makeStringInput(f, obj, extra) {
  const inp = el('input', Object.assign({
    type: 'text',
    value: obj[f.name] == null ? '' : obj[f.name],
    placeholder: f.label + '…',
    oninput: (e) => { obj[f.name] = e.target.value; markDirty(); },
  }, extra || {}));
  return inp;
}

function makeNumberInput(f, obj) {
  return el('input', {
    type: 'number', value: String(obj[f.name] == null ? 0 : obj[f.name]),
    oninput: (e) => { obj[f.name] = e.target.value === '' ? 0 : Number(e.target.value); markDirty(); },
  });
}

function makeSelectControl(f, obj) {
  // Friendly segmented control for the site's two closed vocabularies.
  if ((f.name === 'style' && f.options.join() === 'default,italic') ||
      (f.name === 'size' && f.options.join() === 'half,third')) {
    const seg = el('div', { class: 'seg', role: 'group', 'aria-label': f.label });
    const paint = () => {
      seg.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('on', b.dataset.v === obj[f.name]);
      });
    };
    for (const opt of f.options) {
      const label = f.name === 'style' ? (opt === 'italic' ? 'italic' : 'Aa') : opt;
      seg.append(el('button', {
        type: 'button',
        'data-v': opt,
        title: f.name === 'style' ? (opt === 'italic' ? 'Italic emphasis on the site' : 'Regular text') : opt,
        onclick: (e) => { obj[f.name] = opt; markDirty(); paint(); },
        class: 'seg-btn' + (opt === 'italic' ? ' seg-italic' : ''),
      }, label));
    }
    paint();
    const wrap = el('div', { class: 'field-control' }, seg);
    if (f.name === 'style') wrap.append(el('div', { class: 'field-hint' }, 'This is the site’s emphasis switch.'));
    return wrap;
  }
  const sel = el('select', {
    onchange: (e) => { obj[f.name] = e.target.value; markDirty(); },
  });
  for (const opt of f.options) sel.append(el('option', { value: opt }, opt));
  sel.value = obj[f.name] == null ? f.options[0] : obj[f.name];
  if (!f.options.includes(sel.value)) sel.value = f.options[0];
  return sel;
}

function makeBoolControl(f, obj) {
  const cb = el('input', {
    type: 'checkbox',
    'aria-label': f.label,
    onchange: (e) => { obj[f.name] = e.target.checked; markDirty(); },
  });
  cb.checked = Boolean(obj[f.name]);
  return el('label', { class: 'switch' }, cb, el('span', { class: 'track' }),
    el('span', {}, obj[f.name] ? 'On' : 'Off'));
}

function chunkedB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

async function uploadImage(file, onUrl) {
  setStatus('Uploading ' + file.name + '…');
  try {
    const buf = await file.arrayBuffer();
    const b64 = chunkedB64(buf);
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, base64: b64 }),
    });
    const out = await res.json().catch(() => ({}));
    if (res.ok && out.ok) {
      onUrl(out.url);
      markDirty();
      setStatus(out.dryRun ? 'Upload dry-run — would be ' + out.url : 'Uploaded → ' + out.url, 'ok');
    } else {
      setStatus('Upload failed: ' + (out.error || ('HTTP ' + res.status)), 'err');
    }
  } catch (e) {
    setStatus('Upload failed: ' + e.message, 'err');
  }
}

function isPreviewable(v) {
  return typeof v === 'string' && (v.startsWith('/img/') || v.startsWith('/static/') ||
    v.startsWith('http://') || v.startsWith('https://') || v.startsWith('data:image'));
}

function makeImageControl(f, obj) {
  const cell = el('div', { class: 'img-cell' });
  const top = el('div', { class: 'img-top' });
  const text = el('input', {
    type: 'text', value: obj[f.name] == null ? '' : obj[f.name],
    placeholder: '/img/… or https://…',
    oninput: (e) => { obj[f.name] = e.target.value; markDirty(); paintThumb(); },
  });
  const paintThumb = () => {
    cell.querySelectorAll('img.thumb').forEach((n) => n.remove());
    if (isPreviewable(text.value)) {
      const img = el('img', { class: 'thumb', alt: '' });
      img.src = text.value;
      img.onerror = () => img.remove();
      top.prepend(img);
    }
  };
  const pick = el('input', { type: 'file', accept: 'image/*', hidden: true });
  pick.addEventListener('change', async () => {
    const chosen = pick.files[0];
    pick.value = '';
    if (!chosen) return;
    await uploadImage(chosen, (url) => { obj[f.name] = url; text.value = url; paintThumb(); });
  });
  const btn = el('button', { type: 'button', class: 'upload-btn', onclick: () => pick.click() }, 'Browse…');
  top.append(text, btn);
  cell.append(top, pick);
  paintThumb();
  cell.append(el('div', { class: 'field-hint' }, 'Path fills in automatically after upload.'));
  return cell;
}

function leafControl(f, obj) {
  switch (f.type) {
    case 'string': return makeStringInput(f, obj);
    case 'text': return makeTextControl(f, obj);
    case 'number': return makeNumberInput(f, obj);
    case 'select': return makeSelectControl(f, obj);
    case 'boolean': return makeBoolControl(f, obj);
    case 'image': return makeImageControl(f, obj);
    default: return el('span', {}, '');
  }
}

function rowActions(arr, i, redraw, label) {
  const box = el('div', { class: 'row-actions' });
  const up = el('button', {
    type: 'button', class: 'mini-btn', title: 'Move up',
    'aria-label': 'Move row ' + (i + 1) + ' up',
    onclick: () => {
      if (i <= 0) return;
      const t = arr[i - 1]; arr[i - 1] = arr[i]; arr[i] = t;
      markDirty(); redraw();
    },
  }, '↑');
  const down = el('button', {
    type: 'button', class: 'mini-btn', title: 'Move down',
    'aria-label': 'Move row ' + (i + 1) + ' down',
    onclick: () => {
      if (i >= arr.length - 1) return;
      const t = arr[i + 1]; arr[i + 1] = arr[i]; arr[i] = t;
      markDirty(); redraw();
    },
  }, '↓');
  up.disabled = i === 0;
  down.disabled = i === arr.length - 1;
  const del = el('button', {
    type: 'button', class: 'mini-btn danger', title: 'Remove row (undo available)',
    'aria-label': 'Remove row ' + (i + 1),
    onclick: () => deletable(arr, i, label || ('row ' + (i + 1)), redraw),
  }, '✕');
  box.append(up, down, del);
  return box;
}

/* ---------- form rendering ---------- */

function renderField(parent, f, obj) {
  if (f.type === 'boolean') {
    const card = el('section', { class: 'field-card' });
    const row = el('div', { class: 'field-row' },
      el('span', { class: 'field-label' }, labelOf(f)),
      leafControl(f, obj));
    card.append(row);
    parent.append(card);
    return;
  }
  if (f.type === 'string' || f.type === 'text' || f.type === 'number' ||
      f.type === 'select' || f.type === 'image') {
    const card = el('section', { class: 'field-card' });
    card.append(el('div', { class: 'field-row' },
      el('span', { class: 'field-label' }, labelOf(f),
        f.required === false ? el('span', { class: 'opt' }, 'optional') : null),
      el('div', { class: 'field-control' }, leafControl(f, obj))));
    parent.append(card);
    return;
  }
  if (f.type === 'object') {
    parent.append(renderObjectSection(f, obj));
    return;
  }
  if (f.type === 'list') {
    parent.append(renderListSection(f, obj));
    return;
  }
}

function renderObjectSection(f, obj) {
  const det = el('details', { class: 'section', open: true });
  const val = (obj && obj[f.name] && typeof obj[f.name] === 'object') ? obj[f.name] : (obj[f.name] = {});
  det.append(el('summary', {}, f.label, el('span', { class: 'sec-count' }, String(f.fields.length) + ' fields')));
  const body = el('div', { class: 'section-body' });
  for (const sub of f.fields) {
    if (sub.type === 'object') {
      body.append(renderObjectSection(sub, val));
    } else if (sub.type === 'list') {
      body.append(renderListSection(sub, val));
    } else if (sub.type === 'boolean') {
      body.append(el('div', { class: 'field-row' },
        el('span', { class: 'field-label' }, labelOf(sub)), leafControl(sub, val)));
    } else {
      body.append(el('div', { class: 'field-row' },
        el('span', { class: 'field-label' }, labelOf(sub),
          sub.required === false ? el('span', { class: 'opt' }, 'optional') : null),
        el('div', { class: 'field-control' }, leafControl(sub, val))));
    }
  }
  det.append(body);
  return det;
}

/* ----- lists ----- */

function listShell(f, arr, addLabel) {
  const sec = el('section', { class: 'list-section' });
  const head = el('div', { class: 'list-head' },
    el('span', { class: 'list-title' }, f.label),
    el('span', { class: 'count-pill' }, String(arr.length)),
    el('span', { class: 'spacer' }));
  const add = el('button', {
    type: 'button', class: 'btn btn-add',
    onclick: () => { arr.push(blankListItem(f)); markDirty(); redraw(); },
  }, '+ ' + (addLabel || 'Add row'));
  head.append(add);
  sec.append(head);
  const body = el('div');
  sec.append(body);
  const foot = el('div', { class: 'add-row' });
  const add2 = el('button', {
    type: 'button', class: 'btn btn-add',
    onclick: () => { arr.push(blankListItem(f)); markDirty(); redraw(); },
  }, '+ ' + (addLabel || 'Add row'));
  foot.append(add2);
  sec.append(foot);
  function redraw() {
    paint();
    head.querySelector('.count-pill').textContent = String(arr.length);
    updateRowCount();
  }
  let paint = () => {};
  sec._redraw = redraw;
  sec._setPaint = (fn) => { paint = fn; redraw(); };
  sec._body = body;
  sec._foot = foot;
  return sec;
}

function renderListSection(f, obj) {
  if (!Array.isArray(obj[f.name])) obj[f.name] = [];
  const arr = obj[f.name];
  if (isLineList(f)) return renderLineList(f, arr);
  if (isStringList(f)) return renderStringList(f, arr);
  const nested = subLists(f);
  if (nested.length) return renderNestedList(f, arr, nested);
  if (hasTextCol(f)) return renderRichList(f, arr);
  return renderTableList(f, arr);
}

/* headline lines: text + style pills + indent stepper on one line */
function renderLineList(f, arr) {
  const sec = listShell(f, arr, 'Add line');
  sec._setPaint(() => {
    const body = sec._body;
    body.innerHTML = '';
    const list = el('div', { class: 'line-list' });
    if (!arr.length) list.append(el('div', { class: 'empty-note' }, 'No lines yet — add the first headline line.'));
    arr.forEach((item, i) => {
      const row = el('div', { class: 'line-row' });
      row.append(el('span', { class: 'row-num' }, String(i + 1)));
      const text = el('input', {
        type: 'text', value: item.text == null ? '' : item.text,
        placeholder: 'Headline text…',
        'aria-label': 'Line ' + (i + 1) + ' text',
        oninput: (e) => { item.text = e.target.value; markDirty(); paintPreview(); },
      });
      // style segmented
      const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Line ' + (i + 1) + ' style' });
      const paintSeg = () => seg.querySelectorAll('button').forEach((b) =>
        b.classList.toggle('on', b.dataset.v === item.style));
      for (const opt of ['default', 'italic']) {
        seg.append(el('button', {
          type: 'button', 'data-v': opt,
          title: opt === 'italic' ? 'Italic emphasis on the site' : 'Regular text',
          class: opt === 'italic' ? 'seg-italic' : '',
          onclick: () => { item.style = opt; markDirty(); paintSeg(); paintPreview(); },
        }, opt === 'italic' ? 'italic' : 'Aa'));
      }
      paintSeg();
      // indent stepper
      const num = el('input', {
        type: 'number', value: String(item.indent == null ? 0 : item.indent),
        'aria-label': 'Line ' + (i + 1) + ' indent percent', min: '0', max: '60',
        oninput: (e) => {
          item.indent = e.target.value === '' ? 0 : Number(e.target.value);
          markDirty(); rng.value = String(item.indent); paintPreview();
        },
      });
      const rng = el('input', {
        type: 'range', value: String(item.indent == null ? 0 : item.indent),
        min: '0', max: '40', 'aria-label': 'Line ' + (i + 1) + ' indent slider',
        oninput: (e) => { item.indent = Number(e.target.value); num.value = e.target.value; markDirty(); paintPreview(); },
      });
      const indent = el('div', { class: 'indent-group' }, num, rng, el('span', { class: 'indent-suffix' }, '%'));
      row.append(text, seg, indent, rowActions(arr, i, sec._redraw, 'line ' + (i + 1)));
      const preview = el('div', { class: 'line-preview' });
      const paintPreview = () => {
        preview.textContent = (item.style === 'italic' ? '“' : '') + (item.text || '—') +
          (item.style === 'italic' ? '” (italic)' : '') + ' · indent ' + (item.indent || 0) + '%';
        preview.style.fontStyle = item.style === 'italic' ? 'italic' : 'normal';
        preview.style.paddingLeft = Math.min(Number(item.indent) || 0, 40) + '%';
      };
      paintPreview();
      row.append(preview);
      list.append(row);
    });
    body.innerHTML = '';
    body.append(list);
  });
  return sec;
}

/* plain string lists: tags / points / marquee / aside lines */
function renderStringList(f, arr) {
  const sec = listShell(f, arr, 'Add item');
  sec._setPaint(() => {
    const body = sec._body;
    body.innerHTML = '';
    const list = el('div', { class: 'str-list' });
    if (!arr.length) list.append(el('div', { class: 'empty-note' }, 'No items yet.'));
    arr.forEach((item, i) => {
      const row = el('div', { class: 'str-row' });
      row.append(el('span', { class: 'row-num' }, String(i + 1)));
      row.append(el('input', {
        type: 'text', value: item == null ? '' : item,
        placeholder: f.label.replace(/s$/, '') + '…',
        'aria-label': f.label + ' ' + (i + 1),
        oninput: (e) => { arr[i] = e.target.value; markDirty(); },
      }));
      row.append(rowActions(arr, i, sec._redraw, f.label + ' ' + (i + 1)));
      list.append(row);
    });
    body.append(list);
  });
  return sec;
}

/* pure tables: nav, cta, facts, contact links, covers, posters… */
function renderTableList(f, arr) {
  const cols = scalarSubs(f);
  const sec = listShell(f, arr, 'Add row');
  const tpl = '34px ' + cols.map(shortCol).join(' ') + ' 96px';
  sec._setPaint(() => {
    const body = sec._body;
    body.innerHTML = '';
    const sc = el('div', { class: 'tbl-scroll' });
    const head = el('div', { class: 'tbl-head' });
    head.style.gridTemplateColumns = tpl;
    head.append(el('span', {}, '#'));
    for (const c of cols) head.append(el('span', {}, c.label));
    head.append(el('span', { style: 'text-align:right' }, 'Actions'));
    sc.append(head);
    if (!arr.length) sc.append(el('div', { class: 'empty-note' }, 'No rows yet — add the first one.'));
    arr.forEach((item, i) => {
      const row = el('div', { class: 'tbl-row' });
      row.style.gridTemplateColumns = tpl;
      row.append(el('span', { class: 'row-num' }, String(i + 1)));
      for (const c of cols) {
        const cell = el('div', { class: 'cell' });
        if (c.type === 'text') {
          const ta = el('textarea', {
            rows: '2', placeholder: c.label + '…',
            'aria-label': c.label + ' row ' + (i + 1),
            oninput: (e) => { item[c.name] = e.target.value; markDirty(); },
          });
          ta.value = item[c.name] == null ? '' : item[c.name];
          bindAutosize(ta);
          cell.append(ta);
        } else {
          const ctl = leafControl(c, item);
          if (ctl.tagName === 'INPUT' || ctl.tagName === 'SELECT') {
            ctl.setAttribute('aria-label', c.label + ' row ' + (i + 1));
          }
          cell.append(ctl);
        }
        row.append(cell);
      }
      row.append(rowActions(arr, i, sec._redraw, f.label + ' row ' + (i + 1)));
      sc.append(row);
    });
    body.append(sc);
  });
  return sec;
}

/* rich rows: short fields in a grid + auto-growing textarea full width */
function renderRichList(f, arr) {
  const cols = scalarSubs(f).filter((c) => c.type !== 'text');
  const texts = scalarSubs(f).filter((c) => c.type === 'text');
  const sec = listShell(f, arr, 'Add row');
  const tpl = cols.length ? ('34px ' + cols.map(shortCol).join(' ') + ' 96px') : '34px 96px';
  sec._setPaint(() => {
    const body = sec._body;
    body.innerHTML = '';
    const list = el('div', { class: 'rich-list' });
    if (!arr.length) list.append(el('div', { class: 'empty-note' }, 'No rows yet — add the first one.'));
    arr.forEach((item, i) => {
      const card = el('div', { class: 'rich-card' });
      const top = el('div', { class: 'rich-top' });
      top.style.gridTemplateColumns = tpl;
      top.append(el('span', { class: 'row-num' }, String(i + 1)));
      for (const c of cols) {
        const cell = el('div', { class: 'cell' });
        const ctl = leafControl(c, item);
        if (ctl.tagName === 'INPUT' || ctl.tagName === 'SELECT') {
          ctl.setAttribute('aria-label', c.label + ' row ' + (i + 1));
        }
        cell.append(ctl);
        top.append(cell);
      }
      top.append(rowActions(arr, i, sec._redraw, (item.title || item.label || 'row ' + (i + 1))));
      card.append(top);
      for (const t of texts) {
        card.append(el('div', { class: 'field-label' }, t.label + ' — row ' + (i + 1)));
        const ta = el('textarea', {
          rows: '2', placeholder: t.label + '…  (plain text — no HTML)',
          'aria-label': t.label + ' row ' + (i + 1),
          oninput: (e) => { item[t.name] = e.target.value; markDirty(); sync(); },
        });
        ta.value = item[t.name] == null ? '' : item[t.name];
        const count = el('div', { class: 'char-count' });
        const sync = () => {
          const n = (ta.value || '').length;
          count.textContent = n + ' chars';
        };
        sync();
        bindAutosize(ta);
        card.append(ta, count);
      }
      list.append(card);
    });
    body.append(list);
  });
  return sec;
}

/* nested lists: parent cards (stack groups, toolkit columns) with sub-tables */
function renderNestedList(f, arr, nested) {
  const headCols = scalarSubs(f);
  const sec = listShell(f, arr, 'Add ' + f.label.replace(/s$/, ''));
  sec._setPaint(() => {
    const body = sec._body;
    body.innerHTML = '';
    const list = el('div', { class: 'group-list' });
    if (!arr.length) list.append(el('div', { class: 'empty-note' }, 'Nothing here yet.'));
    arr.forEach((item, i) => {
      // ensure nested arrays exist (lossless round-trip)
      for (const n of nested) if (!Array.isArray(item[n.name])) item[n.name] = [];
      const card = el('div', { class: 'group-card' });
      const head = el('div', { class: 'group-head' });
      head.append(el('span', { class: 'group-badge' }, String(i + 1)));
      const fields = el('div', { class: 'group-head-fields' });
      fields.style.gridTemplateColumns = 'repeat(' + Math.max(headCols.length, 1) + ', minmax(120px, 1fr))';
      if (!headCols.length) fields.append(el('span', { class: 'field-hint' }, 'Group ' + (i + 1)));
      for (const c of headCols) {
        const ctl = leafControl(c, item);
        if (ctl.tagName === 'INPUT' || ctl.tagName === 'SELECT') {
          ctl.setAttribute('aria-label', c.label + ' group ' + (i + 1));
          if (ctl.tagName === 'INPUT' && ctl.type === 'text' && !ctl.placeholder) ctl.placeholder = c.label + '…';
        }
        fields.append(ctl);
      }
      head.append(fields, rowActions(arr, i, sec._redraw, f.label + ' ' + (i + 1)));
      card.append(head);
      const gb = el('div', { class: 'group-body' });
      for (const n of nested) {
        gb.append(el('div', { class: 'sub-label' }, n.label + ' · ' + item[n.name].length));
        gb.append(renderSubList(n, item));
      }
      card.append(gb);
      list.append(card);
    });
    body.append(list);
  });
  return sec;
}

/* sub-list inside a group card (no outer shell of its own) */
function renderSubList(n, parentObj) {
  const arr = parentObj[n.name];
  const box = el('div');
  const paint = () => {
    box.innerHTML = '';
    if (isStringList(n)) {
      const list = el('div', { class: 'str-list', style: 'padding:0 0 6px' });
      if (!arr.length) list.append(el('div', { class: 'empty-note' }, 'No items.'));
      arr.forEach((item, i) => {
        const row = el('div', { class: 'str-row' });
        row.append(el('span', { class: 'row-num' }, String(i + 1)));
        row.append(el('input', {
          type: 'text', value: item == null ? '' : item,
          placeholder: n.label.replace(/s$/, '') + '…',
          'aria-label': n.label + ' ' + (i + 1),
          oninput: (e) => { arr[i] = e.target.value; markDirty(); },
        }));
        row.append(rowActions(arr, i, () => { paint(); markDirtyRefresh(); }, n.label + ' ' + (i + 1)));
        list.append(row);
      });
      box.append(list);
    } else if (!hasTextCol(n) && !subLists(n).length) {
      const cols = scalarSubs(n);
      const tpl = '34px ' + cols.map(shortCol).join(' ') + ' 96px';
      const sc = el('div', { class: 'tbl-scroll', style: 'padding:0 0 6px' });
      const head = el('div', { class: 'tbl-head' });
      head.style.gridTemplateColumns = tpl;
      head.append(el('span', {}, '#'));
      for (const c of cols) head.append(el('span', {}, c.label));
      head.append(el('span', { style: 'text-align:right' }, ''));
      sc.append(head);
      if (!arr.length) sc.append(el('div', { class: 'empty-note' }, 'No rows.'));
      arr.forEach((item, i) => {
        const row = el('div', { class: 'tbl-row' });
        row.style.gridTemplateColumns = tpl;
        row.append(el('span', { class: 'row-num' }, String(i + 1)));
        for (const c of cols) {
          const cell = el('div', { class: 'cell' });
          const ctl = leafControl(c, item);
          if (ctl.tagName === 'INPUT' || ctl.tagName === 'SELECT') {
            ctl.setAttribute('aria-label', c.label + ' ' + (i + 1));
          }
          cell.append(ctl);
          row.append(cell);
        }
        row.append(rowActions(arr, i, () => { paint(); markDirtyRefresh(); }, n.label + ' ' + (i + 1)));
        sc.append(row);
      });
      box.append(sc);
    } else {
      // rich sub-list (should not occur in current schema, kept lossless)
      const wrap = el('div', { class: 'rich-list', style: 'padding:0 0 6px' });
      arr.forEach((item, i) => {
        const card = el('div', { class: 'rich-card' });
        const top = el('div', { class: 'rich-top' });
        top.style.gridTemplateColumns = '34px 96px';
        top.append(el('span', { class: 'row-num' }, String(i + 1)));
        top.append(rowActions(arr, i, () => { paint(); markDirtyRefresh(); }, n.label + ' ' + (i + 1)));
        card.append(top);
        const inner = el('div');
        renderFieldsInto(inner, n.itemFields, item);
        card.append(inner);
        wrap.append(card);
      });
      box.append(wrap);
    }
    const add = el('button', {
      type: 'button', class: 'btn btn-add',
      onclick: () => { arr.push(blankListItem(n)); markDirty(); paint(); markDirtyRefresh(); },
    }, '+ Add ' + n.label.replace(/s$/, '').toLowerCase());
    box.append(add);
  };
  const markDirtyRefresh = () => { updateRowCount(); };
  paint();
  return box;
}

function renderFieldsInto(parent, fields, obj) {
  for (const f of fields) {
    if (f.type === 'object') parent.append(renderObjectSection(f, obj));
    else if (f.type === 'list') parent.append(renderListSection(f, obj));
    else if (f.type === 'boolean') {
      parent.append(el('div', { class: 'field-row' },
        el('span', { class: 'field-label' }, labelOf(f)), leafControl(f, obj)));
    } else {
      parent.append(el('div', { class: 'field-row' },
        el('span', { class: 'field-label' }, labelOf(f),
          f.required === false ? el('span', { class: 'opt' }, 'optional') : null),
        el('div', { class: 'field-control' }, leafControl(f, obj))));
    }
  }
}

/* ---------- row counting ---------- */

function countRows(entry) {
  let n = 0;
  const walk = (fields, obj) => {
    if (!obj) return;
    for (const f of fields) {
      if (f.type === 'list' && Array.isArray(obj[f.name])) {
        n += obj[f.name].length;
        if (f.itemFields) {
          for (const it of obj[f.name]) {
            if (it && typeof it === 'object') walk(f.itemFields, it);
          }
        }
      } else if (f.type === 'object' && obj[f.name]) {
        walk(f.fields, obj[f.name]);
      }
    }
  };
  walk(entry.fields, data[entry.key]);
  return n;
}

function updateRowCount() {
  if (!active) return;
  const entry = schema.find((f) => f.key === active);
  if (!entry) return;
  document.getElementById('row-count').textContent = countRows(entry) + ' rows';
}

/* ---------- file switching ---------- */

function switchTo(key) {
  if (key === active) return;
  if (dirty && !window.confirm('Unsaved changes in "' + active + '" will be lost. Switch anyway?')) {
    return;
  }
  active = key;
  clearDirty();
  setStatus('');

  const entry = schema.find((f) => f.key === key);
  document.getElementById('file-title').textContent = entry.label;
  const meta = document.getElementById('file-meta');
  meta.innerHTML = '';
  meta.append(el('code', {}, entry.path));
  meta.append(el('span', {}, (config.repo || '(no repo)') + ' @ ' + config.branch));
  if (config.dryRun) meta.append(el('span', { class: 'badge badge-dry' }, 'DRY-RUN'));
  if (!config.hasToken) meta.append(el('span', { class: 'badge badge-warn' }, 'no token — dry-run'));
  document.querySelectorAll('#file-list button').forEach((b) =>
    b.classList.toggle('active', b.dataset.key === key));

  const form = document.getElementById('form');
  form.innerHTML = '';
  renderFieldsInto(form, entry.fields, data[key]);
  updateRowCount();
  window.scrollTo(0, 0);
}

/* ---------- save ---------- */

async function save() {
  if (!active) return;
  setStatus('Saving…');
  try {
    const res = await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: active, data: data[active] }),
    });
    const out = await res.json().catch(() => ({}));
    if (res.ok && out.ok) {
      clearDirty();
      setStatus(
        out.dryRun
          ? '✔ Validated (dry-run — not committed). ' + (out.note || '')
          : '✔ Committed to ' + config.branch + (out.commit ? ' @ ' + out.commit : ''),
        'ok',
      );
    } else if (Array.isArray(out.issues)) {
      setIssues(out.issues);
    } else {
      setStatus('Error: ' + (out.error || ('HTTP ' + res.status)), 'err');
    }
  } catch (e) {
    setStatus('Error: ' + e.message, 'err');
  }
}

/* ---------- boot ---------- */

function fileItemCount(entry) {
  let n = 0;
  const d = data[entry.key];
  if (!d) return 0;
  for (const f of entry.fields) {
    if (f.type === 'list' && Array.isArray(d[f.name])) n += d[f.name].length;
  }
  return n;
}

async function init() {
  try {
    const res = await fetch('/api/state');
    const st = await res.json();
    schema = st.schema;
    data = st.data;
    config = st.config;
  } catch (e) {
    setStatus('Failed to load /api/state — is the server running? (' + e.message + ')', 'err');
    return;
  }

  const list = document.getElementById('file-list');
  for (const f of schema) {
    list.append(el('button', {
      type: 'button', class: 'file-btn', 'data-key': f.key,
      onclick: () => switchTo(f.key),
    }, el('span', {}, f.label), el('span', { class: 'file-count' }, String(fileItemCount(f)))));
  }

  const cfg = document.getElementById('config-line');
  cfg.append(el('div', {}, (config.repo || '(no repo)') + ' @ ' + config.branch));
  if (config.dryRun) cfg.append(el('span', { class: 'badge badge-dry' }, 'DRY-RUN'));
  if (!config.hasToken) {
    cfg.append(el('span', { class: 'badge badge-warn' }, 'no token — saves are dry-run; set GITHUB_TOKEN in editor/.env'));
  }

  const form = document.getElementById('form');
  // Enter in text inputs must never submit/refresh.
  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' && e.target.type === 'text') {
      e.preventDefault();
    }
  });

  switchTo(schema[0].key);
}

document.getElementById('save-btn').addEventListener('click', save);
window.addEventListener('beforeunload', (e) => { if (dirty) e.preventDefault(); });

init();
