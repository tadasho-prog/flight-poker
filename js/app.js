// 画面と操作。ゲームの進行は game.js、CPU の判断は cpu.js。
import {
  createGame, createPlayer, startNewHand, applyAction, legalActions, toActPlayer, raiseToPotFraction,
  pot, net, smallBlindIndex, bigBlindIndex, BUY_IN_OPTIONS, STREET_NAMES, ACTION_NAMES,
} from './game.js';
import { decideCPU, CPU_LEVELS } from './cpu.js';
import { rankSymbol, SUIT_SYMBOLS, isRed, sameCard } from './cards.js';
import { evaluate } from './evaluator.js';
import { renderHelp } from './help.js';

const SAVE_KEY = 'flightpoker.save.v1';
const SETUP_KEY = 'flightpoker.setup.v1';
const ME = 'me';
const CPU_MIN = 2;
const CPU_MAX = 9;

const app = document.getElementById('app');

// ---- 保存（localStorage が使えない環境でも落ちないようにする） ----
const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 保存できなくても遊べる */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* 無視 */ } },
};

// ---- 画面の状態 ----
let state = null;           // ゲームの状態（game.js）
let savedAt = null;
let screen = 'title';       // title | setup | table | help
let helpReturn = 'title';
let setup = { buyIn: 100000, cpuCount: 5, cpuLevel: 'normal', ...(store.get(SETUP_KEY) ?? {}) };
let raisePanel = { open: false, value: 0, seq: -1 };
let modal = null;           // { text, ok, okLabel, cancelLabel }
let botTimer = null;
let offlineReady = null;    // null=確認中 / true / false

const fmt = (n) => n.toLocaleString('ja-JP');
const signed = (n) => (n > 0 ? '+' : '') + fmt(n);
const manYen = (n) => `${n / 10000}万`;

function loadSave() {
  const data = store.get(SAVE_KEY);
  if (!data || !data.state || !Array.isArray(data.state.players)) return null;
  return data;
}

function save() {
  if (!state) return;
  savedAt = Date.now();
  store.set(SAVE_KEY, { state, savedAt });
}

// ---- 部品 ----
function cardHTML(card, cls = '', highlight = false) {
  if (!card) return `<span class="card back ${cls}"></span>`;
  return `<span class="card ${isRed(card) ? 'red' : ''} ${cls} ${highlight ? 'hl' : ''}"><b>${rankSymbol(card.r)}</b><i>${SUIT_SYMBOLS[card.s]}</i></span>`;
}

function badges(i) {
  let html = '';
  if (i === state.dealerIndex) html += ' <span class="badge d">D</span>';
  if (state.phase !== 'notStarted' && i === smallBlindIndex(state)) html += ' <span class="badge">SB</span>';
  if (state.phase !== 'notStarted' && i === bigBlindIndex(state)) html += ' <span class="badge">BB</span>';
  return html;
}

function actionText(a) {
  if (!a) return '';
  if (a.kind === 'fold' || a.kind === 'check') return ACTION_NAMES[a.kind];
  return `${ACTION_NAMES[a.kind]} ${fmt(a.amount)}`;
}

/** 勝者（メインポット）の役を作っている5枚 */
function winningCards() {
  const r = state.lastResult;
  if (state.phase !== 'handComplete' || !r || !r.pots.length) return [];
  const hand = r.showdown.find((h) => r.pots[0].winnerIds.includes(h.playerId));
  return hand ? hand.value.bestFive : [];
}
const inList = (list, card) => list.some((c) => sameCard(c, card));

// ---- 画面 ----
function render() {
  let html = '';
  if (screen === 'title') html = renderTitle();
  else if (screen === 'setup') html = renderSetup();
  else if (screen === 'help') html = renderHelp();
  else if (screen === 'table' && state) html = renderTable();
  if (modal) {
    html += `<div class="modal-bg"><div class="modal"><p>${modal.text}</p><div class="row">
      <button class="btn gray" data-act="modal-cancel">${modal.cancelLabel ?? 'やめる'}</button>
      <button class="btn orange" data-act="modal-ok">${modal.okLabel}</button></div></div></div>`;
  }
  app.innerHTML = html;
  app.classList.toggle('has-result', screen === 'table' && state?.phase === 'handComplete');
  if (screen === 'table') scheduleBot();
}

function renderTitle() {
  const saved = loadSave();
  let resume = '';
  if (saved) {
    const d = new Date(saved.savedAt ?? Date.now());
    const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    resume = `<button class="btn gold" data-act="resume">続きから<small>ハンド #${saved.state.handNumber}・CPU ${saved.state.players.length - 1}人・${when} 保存</small></button>`;
  }
  const offline = offlineReady === true
    ? '<span class="plus">✓ オフラインで遊べる準備ができています</span>'
    : offlineReady === false
      ? '<span class="minus">オフラインの準備ができていません（ネットにつないで開き直してください）</span>'
      : '<span class="faint">オフラインの準備を確認しています…</span>';
  return `<div class="title-screen">
      <div class="suits">♠♥♦♣</div>
      <h1>機内ポーカー</h1>
      <div class="dim" style="font-size:13px">テキサスホールデム・キャッシュゲーム</div>
      <div class="menu">
        ${resume}
        <button class="btn blue" data-act="new">新しく始める<small>CPU と対戦</small></button>
        <button class="btn gray" data-act="help">遊び方・役の強さ</button>
      </div>
    </div>
    <div class="title-foot">${offline}</div>`;
}

function renderSetup() {
  const seg = (items, current, act) => `<div class="seg">${items.map(([v, label]) =>
    `<button class="${v === current ? 'on' : ''}" data-act="${act}" data-v="${v}">${label}</button>`).join('')}</div>`;
  return `<div class="page-head"><button class="link" data-act="to-title">戻る</button><h2>新しく始める</h2><span style="min-width:56px"></span></div>
    <div class="form">
      <div>
        <div class="field-label">開始チップ（買い足し額も同じ）</div>
        <div class="box">${seg(BUY_IN_OPTIONS.map((v) => [v, manYen(v)]), setup.buyIn, 'set-buyin')}
          <div class="note">ブラインド SB 1,000 / BB 3,000（固定）</div></div>
      </div>
      <div>
        <div class="field-label">CPU</div>
        <div class="box" style="display:flex;flex-direction:column;gap:12px">
          <div class="stepper"><span class="val">CPU の人数：${setup.cpuCount}人</span>
            <span class="ctl"><button data-act="cpu-minus" ${setup.cpuCount <= CPU_MIN ? 'disabled' : ''} aria-label="減らす">−</button>
            <button data-act="cpu-plus" ${setup.cpuCount >= CPU_MAX ? 'disabled' : ''} aria-label="増やす">＋</button></span></div>
          ${seg(Object.entries(CPU_LEVELS), setup.cpuLevel, 'set-level')}
        </div>
      </div>
      <button class="btn blue" data-act="start" style="flex:none">ゲーム開始</button>
    </div>`;
}

function renderTable() {
  const s = state;
  const meIndex = s.players.findIndex((p) => p.id === ME);
  const me = s.players[meIndex];
  const hl = winningCards();
  const revealed = new Set((s.phase === 'handComplete' && s.lastResult) ? s.lastResult.showdown.map((h) => h.playerId) : []);

  // 相手：自分の次の席から時計回り
  const n = s.players.length;
  const others = Array.from({ length: n - 1 }, (_, k) => (meIndex + 1 + k) % n);
  const compact = others.length > 6;
  const seats = others.map((i) => {
    const p = s.players[i];
    const toAct = i === s.toActIndex;
    let cards = '';
    if (revealed.has(p.id)) cards = p.holeCards.map((c) => cardHTML(c, 'w-sm', inList(hl, c))).join('');
    else if (p.holeCards.length && !p.folded) cards = cardHTML(null, compact ? 'w-xs' : 'w-sm') + cardHTML(null, compact ? 'w-xs' : 'w-sm');
    const act = toAct ? '<div class="act thinking">考え中…</div>' : `<div class="act">${actionText(p.lastAction)}</div>`;
    return `<div class="seat ${toAct ? 'to-act' : ''} ${p.folded && s.phase === 'betting' ? 'folded' : ''}">
      <div class="nm">${p.name}${badges(i)}</div><div class="cards">${cards}</div>
      <div class="stk num">${fmt(p.stack)}</div>${act}</div>`;
  }).join('');

  const board = Array.from({ length: 5 }, (_, k) =>
    k < s.board.length ? cardHTML(s.board[k], 'w-lg', inList(hl, s.board[k])) : '<span class="slot w-lg"></span>').join('');

  let banner = '';
  if (s.phase === 'betting' && s.rebuyIds.length) {
    const names = s.rebuyIds.map((id) => s.players.find((p) => p.id === id)?.name).join('、');
    banner = `<div class="banner">${names} が ${fmt(s.settings.buyIn)} を買い足しました</div>`;
  }

  let myHand = '';
  if (me.folded) myHand = '<span class="faint">フォールド</span>';
  else if (s.board.length >= 3) myHand = `<span class="gold"><b>${evaluate([...me.holeCards, ...s.board]).name}</b></span>`;

  const meToAct = s.toActIndex === meIndex;
  return `<div class="table-head">
      <span class="hand">ハンド #${s.handNumber}</span>
      <span class="blinds num">SB/BB ${fmt(s.settings.smallBlind)}/${fmt(s.settings.bigBlind)}</span>
      <button class="icon-btn" data-act="help" aria-label="遊び方">?</button>
      <button class="icon-btn" data-act="menu" aria-label="中断">✕</button>
    </div>
    ${banner}
    <div class="seats ${compact ? 'compact' : ''}">${seats}</div>
    <div class="center">
      <div class="board">${board}</div>
      <div class="pot-line"><span class="street">${STREET_NAMES[s.street]}</span><span class="pot num">ポット ${fmt(pot(s))}</span></div>
    </div>
    <div class="me ${meToAct ? 'to-act' : ''}">
      <div class="my-cards">${me.holeCards.map((c) => cardHTML(c, `w-xl ${me.folded ? 'dimmed' : ''}`, inList(hl, c))).join('')}</div>
      <div class="info">
        <div class="nm">${me.name}${badges(meIndex)}</div>
        <div class="stk num">${fmt(me.stack)}</div>
        <div class="sub num ${net(me) >= 0 ? 'plus' : 'minus'}">収支 ${signed(net(me))}</div>
        <div class="sub">${myHand}</div>
      </div>
      ${me.streetBet > 0 && s.phase === 'betting' ? `<div class="bet num"><small>ベット</small>${fmt(me.streetBet)}</div>` : ''}
    </div>
    ${renderBottom(meToAct)}`;
}

function renderBottom(meToAct) {
  const s = state;
  if (s.phase === 'handComplete' && s.lastResult) return renderResult();
  if (s.phase !== 'betting' || s.toActIndex === null) {
    // 念のため：進行が止まって見える状態にしない
    return '<button class="btn gold" data-act="next" style="flex:none">次のハンドへ</button>';
  }
  if (!meToAct) return `<div class="waiting">${toActPlayer(s).name} の番です</div>`;

  const legal = legalActions(s, ME);
  if (raisePanel.open && raisePanel.seq === s.actionSeq && legal.canRaise) return renderRaisePanel(legal);

  const me = s.players.find((p) => p.id === ME);
  let buttons = '';
  if (legal.canFold) buttons += '<button class="btn gray" data-act="fold">フォールド</button>';
  if (legal.canCheck) buttons += '<button class="btn blue" data-act="check">チェック</button>';
  else if (legal.callAmount > 0) {
    const allIn = legal.callAmount >= me.stack;
    buttons += `<button class="btn blue" data-act="call">${allIn ? 'オールイン' : 'コール'}<small class="num">${fmt(legal.callAmount)}</small></button>`;
  }
  if (legal.canRaise) buttons += `<button class="btn orange" data-act="open-raise">${legal.isBet ? 'ベット' : 'レイズ'}</button>`;
  return `<div class="row">${buttons}</div>`;
}

function clampRaise(value, legal) {
  if (value >= legal.maxRaiseTo - 999) return legal.maxRaiseTo; // 右端はオールイン
  return Math.min(Math.max(Math.round(value), legal.minRaiseTo), legal.maxRaiseTo);
}

function renderRaisePanel(legal) {
  const amount = clampRaise(raisePanel.value, legal);
  const half = raiseToPotFraction(state, ME, 0.5);
  const full = raiseToPotFraction(state, ME, 1);
  const label = legal.isBet ? 'ベット' : 'レイズ';
  const amountText = amount === legal.maxRaiseTo ? `${fmt(amount)}（オールイン）` : fmt(amount);
  const slider = legal.maxRaiseTo > legal.minRaiseTo
    ? `<input type="range" id="raise-range" min="${legal.minRaiseTo}" max="${legal.maxRaiseTo}" step="1000" value="${amount}" aria-label="${label}額">`
    : '';
  return `<div class="raise-panel">
      <div class="amount-row"><span class="dim" style="font-size:12px">${legal.isBet ? 'ベット額' : 'レイズ後の額'}</span>
        <span class="amount num" id="raise-amount">${amountText}</span></div>
      ${slider}
      <div class="chips-row">
        <button data-act="raise-preset" data-v="${legal.minRaiseTo}">最小</button>
        ${half !== null ? `<button data-act="raise-preset" data-v="${half}">1/2ポット</button>` : ''}
        ${full !== null ? `<button data-act="raise-preset" data-v="${full}">ポット</button>` : ''}
        <button data-act="raise-preset" data-v="${legal.maxRaiseTo}">オールイン</button>
      </div>
      <div class="row">
        <button class="btn gray" data-act="close-raise">戻る</button>
        <button class="btn orange" data-act="do-raise">${label}<small class="num" id="raise-confirm">${fmt(amount)}</small></button>
      </div>
    </div>`;
}

function renderResult() {
  const s = state;
  const r = s.lastResult;
  const nameOf = (id) => s.players.find((p) => p.id === id)?.name ?? '?';
  const went = r.showdown.length > 0;
  const pots = r.pots.map((p, i) => {
    const label = r.pots.length === 1 ? 'ポット' : i === 0 ? 'メインポット' : `サイドポット${i}`;
    if (!went) return `<div class="pot-res"><div class="win">全員フォールド → ${nameOf(p.winnerIds[0])} の勝ち（+${fmt(p.amount)}）</div></div>`;
    if (p.eligibleIds.length === 1) return `<div class="pot-res"><div class="ret">${label}：${nameOf(p.eligibleIds[0])} に ${fmt(p.amount)} を返却（コールされなかった分）</div></div>`;
    const winners = p.winnerIds.map(nameOf).join('・');
    return `<div class="pot-res"><div class="label num">${label} ${fmt(p.amount)}</div>
      <div class="win">${winners} ${p.winnerIds.length > 1 ? 'で分け合い' : 'の勝ち'}（${p.winningHandName}）</div></div>`;
  }).join('');
  const rows = went ? '<hr class="sep">' + r.showdown.map((h) => {
    const won = r.totalPayouts[h.playerId] ?? 0;
    return `<div class="sd-row ${won > 0 ? 'won' : ''}">
      <div class="who"><b>${nameOf(h.playerId)}</b><span class="${won > 0 ? 'gold' : 'dim'}">${h.value.name}</span>${won > 0 ? `<br><span class="plus num">+${fmt(won)}</span>` : ''}</div>
      <div class="hole">${h.holeCards.map((c) => cardHTML(c, 'w-md', inList(h.value.bestFive, c))).join('')}</div>
      <span class="arrow">→</span>
      <div class="five">${h.value.bestFive.map((c) => cardHTML(c, 'w-sm')).join('')}</div></div>`;
  }).join('') : '';
  return `<div class="result"><div class="scroll">${pots}${rows}</div>
    <button class="btn gold" data-act="next" style="flex:none">次のハンドへ</button></div>`;
}

// ---- 進行 ----
function startGame() {
  const players = [createPlayer(ME, 'あなた', false, setup.buyIn)];
  for (let k = 1; k <= setup.cpuCount; k++) players.push(createPlayer(`cpu-${k}`, `CPU ${k}`, true, setup.buyIn));
  state = createGame({ buyIn: setup.buyIn, cpuLevel: setup.cpuLevel }, players, Math.floor(Math.random() * players.length));
  startNewHand(state);
  save();
  screen = 'table';
}

function act(action) {
  if (!state || toActPlayer(state)?.id !== ME) return;
  try {
    applyAction(state, action, ME);
  } catch {
    return; // 画面が古いだけなので描き直す
  } finally {
    raisePanel.open = false;
  }
  save();
}

function nextHand() {
  if (!state || state.phase === 'betting' && state.toActIndex !== null) return;
  startNewHand(state);
  raisePanel.open = false;
  save();
}

/** CPU の手番なら少し待ってから行動させる */
function scheduleBot() {
  clearTimeout(botTimer);
  botTimer = null;
  if (screen !== 'table' || !state || state.phase !== 'betting') return;
  const p = toActPlayer(state);
  if (!p || !p.isCPU) return;
  const seq = state.actionSeq;
  const delay = 550 + Math.random() * 550;
  botTimer = setTimeout(() => {
    if (!state || state.actionSeq !== seq || screen !== 'table') return;
    let action = decideCPU(state, p.id, state.settings.cpuLevel);
    try {
      applyAction(state, action, p.id);
    } catch {
      // 念のため：判断が不正でも必ず合法な手で進める
      const legal = legalActions(state, p.id);
      action = legal.canCheck ? { type: 'check' } : { type: 'fold' };
      applyAction(state, action, p.id);
    }
    save();
    render();
  }, delay);
}

// ---- 操作 ----
app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const v = el.dataset.v;
  switch (el.dataset.act) {
    case 'new':
      if (loadSave()) {
        modal = { text: '保存中のゲームは消えます。<br>新しく始めますか？', okLabel: '新しく始める', ok: () => { screen = 'setup'; } };
      } else screen = 'setup';
      break;
    case 'resume': {
      const saved = loadSave();
      if (saved) { state = saved.state; savedAt = saved.savedAt; screen = 'table'; }
      break;
    }
    case 'help': helpReturn = screen; screen = 'help'; break;
    case 'help-back': screen = helpReturn; break;
    case 'to-title': screen = 'title'; break;
    case 'set-buyin': setup.buyIn = Number(v); store.set(SETUP_KEY, setup); break;
    case 'set-level': setup.cpuLevel = v; store.set(SETUP_KEY, setup); break;
    case 'cpu-minus': setup.cpuCount = Math.max(CPU_MIN, setup.cpuCount - 1); store.set(SETUP_KEY, setup); break;
    case 'cpu-plus': setup.cpuCount = Math.min(CPU_MAX, setup.cpuCount + 1); store.set(SETUP_KEY, setup); break;
    case 'start': startGame(); break;
    case 'menu':
      modal = { text: 'タイトルに戻りますか？<br><span class="dim" style="font-size:13px">「続きから」で再開できます</span>', okLabel: 'タイトルへ', cancelLabel: '続ける', ok: () => { clearTimeout(botTimer); screen = 'title'; } };
      break;
    case 'modal-ok': { const ok = modal?.ok; modal = null; ok?.(); break; }
    case 'modal-cancel': modal = null; break;
    case 'fold': act({ type: 'fold' }); break;
    case 'check': act({ type: 'check' }); break;
    case 'call': act({ type: 'call' }); break;
    case 'open-raise': {
      const legal = legalActions(state, ME);
      raisePanel = { open: true, value: raiseToPotFraction(state, ME, 0.5) ?? legal.minRaiseTo, seq: state.actionSeq };
      break;
    }
    case 'close-raise': raisePanel.open = false; break;
    case 'raise-preset': raisePanel.value = Number(v); break;
    case 'do-raise': {
      const legal = legalActions(state, ME);
      if (legal) act({ type: 'raise', to: clampRaise(raisePanel.value, legal) });
      break;
    }
    case 'next': nextHand(); break;
    default: return;
  }
  render();
});

// スライダーは描き直さずに数字だけ更新する（指の動きを止めないため）
app.addEventListener('input', (e) => {
  if (e.target.id !== 'raise-range' || !state) return;
  const legal = legalActions(state, ME);
  if (!legal) return;
  raisePanel.value = Number(e.target.value);
  const amount = clampRaise(raisePanel.value, legal);
  document.getElementById('raise-amount').textContent = amount === legal.maxRaiseTo ? `${fmt(amount)}（オールイン）` : fmt(amount);
  document.getElementById('raise-confirm').textContent = fmt(amount);
});

// ---- オフライン対応（Service Worker） ----
async function isCached() {
  for (const key of (await caches.keys()).filter((k) => k.startsWith('flightpoker-'))) {
    const cache = await caches.open(key);
    if (await cache.match('index.html') && await cache.match('js/app.js') && await cache.match('style.css')) return true;
  }
  return false;
}

async function setUpOffline() {
  if (!('serviceWorker' in navigator)) { offlineReady = false; return; }
  try {
    await navigator.serviceWorker.register('sw.js');
    const reg = await navigator.serviceWorker.ready;
    offlineReady = await isCached();
    if (!offlineReady && navigator.onLine && reg.active) {
      // 保存が消えていたら保存し直してもらう
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 8000);
        navigator.serviceWorker.addEventListener('message', (e) => {
          if (e.data === 'recached') { clearTimeout(timer); resolve(); }
        });
        reg.active.postMessage('recache');
      });
      offlineReady = await isCached();
    }
  } catch {
    offlineReady = false;
  }
  if (screen === 'title' && !modal) render();
}

render();
setUpOffline();
