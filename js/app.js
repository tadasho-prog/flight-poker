// 画面と操作。ゲームの進行は game.js、CPU の判断は cpu.js。
import {
  createGame, startNewHand, applyAction, legalActions, toActPlayer,
  pot, net, smallBlindIndex, bigBlindIndex, isValidState, BUY_IN_OPTIONS,
} from './game.js';
import { decideCPU, estimateEquity, equityKnown, CPU_LEVELS } from './cpu.js';
import { rankSymbol, SUIT_SYMBOLS, isRed, sameCard } from './cards.js';
import { evaluate, describeHand, handLabel, madeCards } from './evaluator.js';
import { presets, defaultAmount, amountAt, positionOf, nudge, shortAmount, raiseNote } from './sizing.js';
import { preActionOptions, makePreAction, isPreActionValid, resolvePreAction } from './preaction.js';
import { seatLayout, STAGE, MY_SPOT } from './seats.js';
import { renderHelp } from './help.js';
import {
  SOLO_ID, MODES, MODE_KEYS, modeOf, isDuo, humanColor, createPlayersFor, initView, needsHandoff, confirmHandoff,
  viewerId, canSeeCards, actorId, noteAction, noteNewHand, setReveal, turnsUntil, nextHumanTurn, humanToAct,
  describeMove, movesSince,
} from './duo.js';

const APP_VERSION = 'ver.3.5（2026-11-25 結果の画面で2人の手札を表示）';
const SETUP_KEY = 'flightpoker.setup.v1';
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
let setup = { buyIn: 100000, cpuCount: 5, cpuLevel: 'normal', showEquity: false, mode: 'solo', ...(store.get(SETUP_KEY) ?? {}) };
if (!MODES[setup.mode]) setup.mode = 'solo';
let equityCache = { key: null, value: null };
let sizing = { key: '', amount: 0 };   // 自分の番で選んでいるレイズ額
let pre = null;                         // 先行予約（要件 U-15）
const badgeSeen = {};                   // アクションバッジを出した時刻（一瞬大きく見せる演出用）
let rebuyToast = { hand: 0, t: 0 };
let modal = null;           // { text, ok, okLabel, cancelLabel }
let botTimer = null;
let botSeq = -1;           // botTimer がどの手番（actionSeq）のものか
let offlineReady = null;    // null=確認中 / true / false

const fmt = (n) => n.toLocaleString('ja-JP');
const signed = (n) => (n > 0 ? '+' : '') + fmt(n);
const manYen = (n) => `${n / 10000}万`;

/** モードごとの保存（要件 M-10） */
function loadSave(mode) {
  const data = store.get(MODES[mode].saveKey);
  if (!data || !isValidState(data.state) || modeOf(data.state) !== mode) return null; // 壊れた保存は使わない
  return data;
}

function save() {
  if (!state) return;
  savedAt = Date.now();
  store.set(MODES[modeOf(state)].saveKey, { state, savedAt });
}

/** 画面に出す名前（1人用の自分は「あなた」） */
const nameOf = (id) => state.players.find((p) => p.id === id)?.name ?? '?';
/** 色分け用のクラス（要件 M-2） */
const colorCls = (id) => (humanColor(id) ? ` c-${humanColor(id)}` : '');

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
  app.className = `screen-${screen === 'table' && state && needsHandoff(state) ? 'handoff' : screen}`;
  if (screen === 'table') {
    fitStage();
    scheduleBot();
  }
}

function renderTitle() {
  const when = (t) => {
    const d = new Date(t ?? Date.now());
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  // 入口は3つ（要件 M-1）。それぞれに「新しく」と、保存があれば「続きから」
  const entries = MODE_KEYS.map((mode) => {
    const m = MODES[mode];
    const saved = loadSave(mode);
    const resume = saved
      ? `<button class="btn gold" data-act="resume" data-v="${mode}">続きから<small>#${saved.state.handNumber}・${when(saved.savedAt)}</small></button>`
      : '';
    return `<div class="mode-box m-${mode}">
        <div class="m-head"><b>${m.label}</b><span>${m.sub}</span></div>
        <div class="row">${resume}<button class="btn ${saved ? 'gray' : 'blue'}" data-act="new" data-v="${mode}">新しく始める</button></div>
      </div>`;
  }).join('');
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
        ${entries}
        <button class="btn gray help-btn" data-act="help">遊び方・役の強さ</button>
      </div>
    </div>
    <div class="title-foot">${offline}<br><span class="faint">${APP_VERSION}</span></div>`;
}

function renderSetup() {
  const seg = (items, current, act) => `<div class="seg">${items.map(([v, label]) =>
    `<button class="${v === current ? 'on' : ''}" data-act="${act}" data-v="${v}">${label}</button>`).join('')}</div>`;
  const mode = setup.mode;
  const cpuBox = mode === 'solo'
    ? `<div class="stepper"><span class="val">CPU の人数：${setup.cpuCount}人</span>
            <span class="ctl"><button data-act="cpu-minus" ${setup.cpuCount <= CPU_MIN ? 'disabled' : ''} aria-label="減らす">−</button>
            <button data-act="cpu-plus" ${setup.cpuCount >= CPU_MAX ? 'disabled' : ''} aria-label="増やす">＋</button></span></div>`
    : '<div class="stepper"><span class="val">CPU 4人</span></div>';
  const players = mode === 'solo' ? '' : `<div>
        <div class="field-label">プレイヤー</div>
        <div class="box players"><span class="c-blue">しょうご</span><span class="c-pink">なのは</span></div>
        <div class="note">1台のスマホを交代で持ちます。手番のたびに受け渡しの画面が出ます</div>
      </div>`;
  const cpuSection = mode === 'duo' ? '' : `<div>
        <div class="field-label">CPU</div>
        <div class="box" style="display:flex;flex-direction:column;gap:12px">
          ${cpuBox}
          ${seg(Object.entries(CPU_LEVELS), setup.cpuLevel, 'set-level')}
        </div>
      </div>`;
  return `<div class="page-head"><button class="link" data-act="to-title">戻る</button><h2>${MODES[mode].label}</h2><span style="min-width:56px"></span></div>
    <div class="form">
      ${players}
      <div>
        <div class="field-label">開始チップ（買い足し額も同じ）</div>
        <div class="box">${seg(BUY_IN_OPTIONS.map((v) => [v, manYen(v)]), setup.buyIn, 'set-buyin')}
          <div class="note">ブラインド SB 1,000 / BB 3,000（固定）</div></div>
      </div>
      ${cpuSection}
      <div>
        <div class="field-label">練習用</div>
        <div class="box"><div class="stepper"><span style="font-size:15px">勝率の目安を表示</span></div>
          <div style="margin-top:10px">${seg([['off', '表示しない'], ['on', '表示する']], setup.showEquity ? 'on' : 'off', 'set-equity')}</div>
          <div class="note">相手の手札をランダムと仮定した、今の自分の勝率の目安です${mode === 'solo' ? '' : '（「手札を表示」中は2人分を常に表示）'}</div></div>
      </div>
      <button class="btn blue" data-act="start" style="flex:none">ゲーム開始</button>
    </div>`;
}

// ===== テーブル画面（Claude Design「機内ポーカー テーブル画面 改善案」どおり。要件 U-8〜U-17） =====

const STREET_PILL = { preflop: 'プリフロップ', flop: 'フロップ', turn: 'ターン', river: 'リバー', showdown: 'ショーダウン' };

/** トランプ1枚（幅 w px）。card が null なら裏 */
function pcard(card, w, hl = false, dim = false) {
  const h = Math.round(w * 1.4);
  if (!card) return `<span class="pc back" style="width:${w}px;height:${h}px"></span>`;
  const red = isRed(card);
  return `<span class="pc${hl ? ' hl' : ''}${dim ? ' dim' : ''}" style="width:${w}px;height:${h}px;font-size:${Math.round(w * 0.4)}px;color:${red ? '#c8102e' : '#111'}"><span>${rankSymbol(card.r)}</span><span>${SUIT_SYMBOLS[card.s]}</span></span>`;
}

function posBadges(i) {
  let html = '';
  if (i === state.dealerIndex) html += '<span class="d-btn">D</span>';
  // ヘッズアップではディーラーが SB を兼ねるので、D だけ出す（席の幅に収めるため）
  if (i === smallBlindIndex(state) && !(state.players.length === 2 && i === state.dealerIndex)) html += '<span class="blind">SB</span>';
  else if (i === bigBlindIndex(state)) html += '<span class="blind">BB</span>';
  return html;
}

/** 新しく動いた瞬間だけバッジを大きく見せる（描き直してもアニメーションが最初に戻らないよう、経過時間を引き継ぐ） */
function popAttr(id, key, duration = 650) {
  const seen = badgeSeen[id];
  if (!seen || seen.key !== key) badgeSeen[id] = { key, t: Date.now() };
  const elapsed = Date.now() - badgeSeen[id].t;
  return elapsed < duration ? ` pop" style="animation-delay:-${elapsed}ms` : '';
}

function actionBadge(p, i) {
  const s = state;
  if (s.phase !== 'betting') return null;
  if (i === s.toActIndex) return { cls: 'think', text: '考え中' };
  const a = p.lastAction;
  if (!a || p.folded) return null;
  const map = {
    check: ['check', 'チェック'], call: ['call', 'コール'], bet: ['raise', `ベット ${fmt(a.amount)}`],
    raise: ['raise', `レイズ ${fmt(a.amount)}`], allIn: ['allin', `オールイン ${fmt(a.amount)}`],
  };
  if (!map[a.kind]) return null; // SB/BB はチップの表示だけ
  return { cls: map[a.kind][0], text: map[a.kind][1], key: `${s.handNumber}:${s.street}:${a.kind}:${a.amount}` };
}

function myToCall(me) {
  return Math.min(Math.max(0, state.currentBet - me.streetBet), me.stack);
}

/** 収支の表示（±0 / +1,000 / −1,000） */
const netLabel = (v) => (v === 0 ? '±0' : v > 0 ? `+${fmt(v)}` : `−${fmt(-v)}`);
const humanName = (id) => `<span class="${colorCls(id).trim()}">${nameOf(id)}</span>`;

/** 受け渡し画面（要件 M-4）。テーブルは見せず、公開されている情報（場のカード・ポット・直前の動き・収支）だけ出す */
function renderHandoff() {
  const s = state;
  const h = humanToAct(s);
  const toCall = myToCall(h);
  const board = Array.from({ length: 5 }, (_, k) => (k < s.board.length ? pcard(s.board[k], 34) : '<span class="slot ho-slot"></span>')).join('');
  const moves = movesSince(s, h.id).map((m) => `<div>${humanName(m.id)} ${m.text}${m.street !== s.street ? `<span class="faint">（${STREET_PILL[m.street]}）</span>` : ''}</div>`).join('');
  // ハンドの途中で賭けている分は引かず、このハンドが始まる前の収支を出す（2人とも −3,000 のように見えないように）
  const nets = s.players.filter((p) => !p.isCPU).map((p) => `${humanName(p.id)} ${netLabel(net(p) + p.totalCommitted)}`).join('　');
  return `<div class="t-head">
      <b>ハンド #${s.handNumber}</b>
      <span class="grow"></span>
      <button class="round" data-act="menu" aria-label="中断"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3l10 10M13 3L3 13"></path></svg></button>
    </div>
    <div class="handoff${colorCls(h.id)}">
      <div class="ho-name">${h.name}</div>
      <div class="ho-msg">さんの番です</div>
      <div class="ho-sub">スマホを ${h.name} さんに渡してください。<br>相手に見えないようにしてから押してください</div>
      <div class="ho-info">
        <div class="ho-board">${board}</div>
        <div class="ho-pot">${STREET_PILL[s.street]}・ポット <b>${fmt(pot(s))}</b>・${toCall > 0 ? `コールに <b>${fmt(toCall)}</b>` : 'チェックできます'}</div>
        ${moves ? `<div class="ho-moves"><div class="ho-cap">直前の動き</div>${moves}</div>` : ''}
        <div class="ho-nets">収支（このハンドの前）　${nets}</div>
      </div>
      <button class="btn-main ho-btn" data-act="handoff">${h.name} です ── 手札を見る</button>
      <button class="link ho-reveal" data-act="reveal">2人の手札を表示して続ける</button>
    </div>`;
}

function renderTable() {
  const s = state;
  if (needsHandoff(s)) return renderHandoff();
  const n = s.players.length;
  const duo = isDuo(s);
  const meId = viewerId(s);
  const meIndex = s.players.findIndex((p) => p.id === meId);
  const me = s.players[meIndex];
  const result = s.phase === 'handComplete' ? s.lastResult : null;
  const shown = new Map(result ? result.showdown.map((h) => [h.playerId, h]) : []);
  const mainWinners = result ? result.pots[0]?.winnerIds ?? [] : [];
  const myCardsUp = canSeeCards(s, meId) || shown.has(meId);

  // 強調するカード：結果では勝者の役、プレイ中は自分の役（伏せているときは出さない）
  let hl = [];
  if (result && result.showdown.length) {
    const w = result.showdown.find((h) => mainWinners.includes(h.playerId));
    if (w) hl = madeCards(w.value);
  } else if (!result && !me.folded && s.board.length >= 3 && myCardsUp) {
    hl = madeCards(evaluate([...me.holeCards, ...s.board]));
  }
  const isHl = (c) => hl.some((h) => sameCard(h, c));

  // ---- 席 ----
  const others = Array.from({ length: n - 1 }, (_, k) => (meIndex + 1 + k) % n);
  const layout = seatLayout(others.length);
  const seats = others.map((i, k) => {
    const p = s.players[i];
    const L = layout[k];
    const showHand = shown.get(p.id);
    const won = result && (result.totalPayouts[p.id] ?? 0) > 0;
    // 「手札を表示」中のもう1人（結果の画面でも、フォールドしていても表にする。要件 M-7）
    const open = !showHand && p.holeCards.length === 2 && canSeeCards(s, p.id);
    let cardsHtml;
    if (showHand) cardsHtml = `<div class="s-cards up">${showHand.holeCards.map((c) => pcard(c, 18, isHl(c))).join('')}</div>`;
    else if (open) cardsHtml = `<div class="s-cards up">${p.holeCards.map((c) => pcard(c, 18, !!result && isHl(c))).join('')}</div>`;
    else if (p.folded) cardsHtml = '<div class="s-cards fold">フォールド</div>';
    else if (p.holeCards.length) cardsHtml = `<div class="s-cards">${pcard(null, 15)}${pcard(null, 15)}</div>`;
    else cardsHtml = '<div class="s-cards"></div>';

    let badge = '';
    if (showHand) {
      badge = `<div class="s-badge ${won ? 'win' : 'hand'}">${showHand.value.name}</div>`;
    } else if (open && p.folded) {
      badge = '<div class="s-badge hand">フォールド</div>';
    } else {
      const b = actionBadge(p, i);
      if (b) badge = `<div class="s-badge ${b.cls}${b.key ? popAttr(p.id, b.key) : ''}">${b.text}</div>`;
    }

    let chip = '';
    if (!result && p.streetBet > 0) chip = `<div class="chip" style="left:${L.bx}px;top:${L.by}px"><i></i>${fmt(p.streetBet)}</div>`;
    else if (won) chip = `<div class="chip gain" style="left:${L.bx}px;top:${L.by}px"><i></i>+${fmt(result.totalPayouts[p.id])}</div>`;

    const tall = showHand || open;
    const hot = !result && i === s.toActIndex;
    return `<div class="seat${hot ? ' hot' : ''}${won ? ' win' : ''}${p.folded ? ' folded' : ''}${tall ? ' shown' : ''}${colorCls(p.id)}" style="left:${L.x - 37}px;top:${L.y - (tall ? 32 : 30)}px">
        <div class="s-name"><span>${p.name}</span>${posBadges(i)}</div>${cardsHtml}
        <div class="s-stack">${fmt(p.stack)}</div>${badge}</div>${chip}`;
  }).join('');

  // ---- 中央 ----
  const board = Array.from({ length: 5 }, (_, k) => (k < s.board.length ? pcard(s.board[k], 40, isHl(s.board[k])) : '<span class="slot"></span>')).join('');
  const meToAct = !result && s.toActIndex === meIndex && actorId(s) === meId;
  const who = duo ? me.name : 'あなた';
  let pillText = who;
  let pillCls = '';
  if (meToAct) { pillText = `${who}の番`; pillCls = ' on'; }
  else if (result && shown.get(meId)) pillText = `${who} ${shown.get(meId).value.name}`;
  else if (!result && me.folded) pillText = `${who}（フォールド）`;
  else if (!result && me.allIn) pillText = `${who}（オールイン）`;
  const myWon = result && (result.totalPayouts[meId] ?? 0) > 0;
  let myChip = '';
  if (!result && me.streetBet > 0) myChip = `<div class="chip" style="left:${MY_SPOT.chip[0]}px;top:${MY_SPOT.chip[1]}px"><i></i>${fmt(me.streetBet)}</div>`;
  else if (myWon) myChip = `<div class="chip gain" style="left:${MY_SPOT.chip[0]}px;top:${MY_SPOT.chip[1]}px"><i></i>+${fmt(result.totalPayouts[meId])}</div>`;

  // 買い足しのお知らせ（ハンドの最初に数秒だけ）
  let toast = '';
  if (s.phase === 'betting' && s.rebuyIds.length) {
    if (rebuyToast.hand !== s.handNumber) rebuyToast = { hand: s.handNumber, t: Date.now() };
    const elapsed = Date.now() - rebuyToast.t;
    if (elapsed < 3600) {
      const names = s.rebuyIds.map(nameOf).join('・');
      toast = `<div class="toast" style="animation-delay:-${elapsed}ms">${names} が買い足しました</div>`;
    }
  }

  const stage = `<div class="stage">
      <div class="felt"></div>
      <div class="pot"><span>ポット</span>${fmt(pot(s))}</div>
      <div class="board">${board}</div>
      <div class="street"><span>${STREET_PILL[s.street]}</span></div>
      ${seats}
      ${myChip}
      <div class="me-pill${pillCls}${colorCls(meId)}" style="left:${MY_SPOT.pill[0]}px;top:${MY_SPOT.pill[1]}px">${pillText}${posBadges(meIndex)}</div>
      ${toast}
    </div>`;

  const revealBtn = duo
    ? `<button class="reveal${s.view.revealAll ? ' on' : ''}" data-act="reveal">${s.view.revealAll ? '手札を隠す' : '手札を表示'}</button>`
    : '';
  return `<div class="t-head${duo ? ' duo' : ''}">
      <b>ハンド #${s.handNumber}</b>
      <span class="blinds">${duo ? '' : 'SB/BB '}${fmt(s.settings.smallBlind)} / ${fmt(s.settings.bigBlind)}</span>
      <span class="grow"></span>
      ${revealBtn}
      <button class="round" data-act="help" aria-label="遊び方・役の強さ">?</button>
      <button class="round" data-act="menu" aria-label="中断"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3l10 10M13 3L3 13"></path></svg></button>
    </div>
    <div class="table-area">${stage}</div>
    ${renderHero(me, meToAct, result, shown, isHl, myCardsUp)}
    <div class="actions">${renderActions(me, meIndex, meToAct, result, shown)}</div>`;
}

function renderHero(me, meToAct, result, shown, isHl, cardsUp) {
  const s = state;
  const cards = cardsUp
    ? me.holeCards.map((c) => pcard(c, 50, isHl(c), me.folded && !result)).join('')
    : me.holeCards.map(() => pcard(null, 50)).join('');
  const nv = net(me);
  const netText = nv === 0 ? '収支 ±0' : nv > 0 ? `収支 +${fmt(nv)}` : `収支 −${fmt(-nv)}`;
  let right = '';
  const duoEq = isDuo(s) && s.view.revealAll && !result ? revealEquities() : null;
  if (result) {
    const h = shown.get(me.id);
    if (h) right = `<div class="big">${h.value.name}</div><div class="small">${describeHand(h.value)}</div>`;
  } else if (me.folded) {
    right = '<div class="small">フォールド</div>';
  } else if (!cardsUp) {
    right = '<div class="small">手札は伏せています</div>';
  } else if (duoEq) {
    // 「手札を表示」中は2人分の勝率を並べる（要件 M-7）
    const v = s.board.length >= 3 ? evaluate([...me.holeCards, ...s.board]) : null;
    right = `${v ? `<div class="big gold">${v.name}</div>` : '<div class="small">勝率の目安</div>'}
      <div class="eq2">${duoEq.map((e) => `<span class="${colorCls(e.id).trim()}">${nameOf(e.id)} ${e.pct === null ? '—' : `約${e.pct}%`}</span>`).join('')}</div>`;
  } else if (s.board.length >= 3) {
    const v = evaluate([...me.holeCards, ...s.board]);
    const sub = s.settings.showEquity ? `勝率の目安 約${equityPercent(me)}%` : describeHand(v);
    right = `<div class="big gold">${v.name}</div><div class="small">${sub}</div>`;
  } else if (s.settings.showEquity) {
    right = `<div class="small">勝率の目安</div><div class="big gold">約${equityPercent(me)}%</div>`;
  }
  return `<div class="hero${meToAct ? ' on' : ''}${colorCls(isDuo(s) ? me.id : '')}">
      <div class="h-cards">${cards}</div>
      <div class="h-info"><div class="h-name">${isDuo(s) ? me.name : 'あなた'}</div><div class="h-stack">${fmt(me.stack)}</div>
        <div class="h-net ${nv >= 0 ? 'plus' : 'minus'}">${netText}</div></div>
      <div class="h-right">${right}</div>
    </div>`;
}

/** 勝率の目安（要件 L-2）。街・残り人数が変わったときだけ計算し直す */
function equityPercent(me) {
  const s = state;
  const opponents = s.players.filter((p) => p.id !== me.id && !p.folded).length;
  const key = `${me.id}:${s.handNumber}:${s.board.length}:${opponents}`;
  if (equityCache.key !== key) equityCache = { key, value: estimateEquity(me.holeCards, s.board, opponents, 1500) };
  return Math.round(equityCache.value * 100);
}

/** 「手札を表示」中の2人の勝率（2人の手札は分かっている前提、CPU の手札はランダム）。フォールドした人は null */
function revealEquities() {
  const s = state;
  const humans = s.players.filter((p) => !p.isCPU);
  const live = humans.filter((p) => !p.folded && p.holeCards.length === 2);
  const cpus = s.players.filter((p) => p.isCPU && !p.folded).length;
  const key = `reveal:${s.handNumber}:${s.board.length}:${live.map((p) => p.id).join(',')}:${cpus}`;
  if (equityCache.key !== key) {
    const eq = equityKnown(live.map((p) => p.holeCards), s.board, cpus, 2000);
    equityCache = { key, value: Object.fromEntries(live.map((p, k) => [p.id, eq[k]])) };
  }
  return humans.map((p) => ({ id: p.id, pct: p.id in equityCache.value ? Math.round(equityCache.value[p.id] * 100) : null }));
}

// ---- 操作エリア（高さ固定：要件 U-13） ----
function renderActions(me, meIndex, meToAct, result, shown) {
  if (result) return renderResultActions(me, result, shown);
  if (state.phase !== 'betting' || state.toActIndex === null) {
    return '<div class="grow"></div><button class="btn-main next" data-act="next">次のハンドへ</button>';
  }
  if (meToAct) return renderMyTurn(me);
  return renderWaiting(me, meIndex);
}

function currentSizing(list, legal) {
  const key = `${state.handNumber}:${state.actionSeq}`;
  if (sizing.key !== key) sizing = { key, amount: defaultAmount(state, list) };
  sizing.amount = Math.min(Math.max(sizing.amount, legal.minRaiseTo), legal.maxRaiseTo);
  return sizing.amount;
}

function raiseTexts(legal, amount) {
  const label = amount >= legal.maxRaiseTo ? 'オールイン' : legal.isBet ? 'ベット' : 'レイズ';
  const note = raiseNote(state, amount);
  return { label, sub: `${fmt(amount)}${note ? `（${note}）` : ''}` };
}

function renderMyTurn(me) {
  const legal = legalActions(state, me.id);
  const list = presets(state, me.id);
  const canRaise = !!list;
  let presetsHtml;
  let sliderHtml;
  let amount = 0;
  if (canRaise) {
    amount = currentSizing(list, legal);
    const lo = legal.minRaiseTo;
    const hi = legal.maxRaiseTo;
    const t = positionOf(amount, lo, hi);
    const pct = (t * 100).toFixed(1);
    const onIndex = list.findIndex((p) => p.amount === amount); // 同じ額が並んでも枠は1つだけ
    presetsHtml = list.map((p, k) => `<button class="preset${k === onIndex ? ' on' : ''}" data-act="preset" data-v="${p.amount}"><b>${p.label}</b><span>${fmt(p.amount)}</span></button>`).join('');
    const ticks = list.map((p) => `<i class="tick" style="left:${(positionOf(p.amount, lo, hi) * 100).toFixed(1)}%"></i>`).join('');
    const scale = [0, 0.25, 0.5, 0.75, 1].map((q) => `<span class="mark" style="left:${q * 100}%;transform:translateX(${q === 0 ? '0' : q === 1 ? '-100%' : '-50%'})">${shortAmount(amountAt(q, lo, hi))}</span>`).join('');
    sliderHtml = `<button class="nudge" data-act="nudge" data-v="-1" aria-label="少し下げる">−</button>
      <div class="slider" data-lo="${lo}" data-hi="${hi}">
        <div class="track"></div><div class="fill" style="width:${pct}%"></div>${ticks}
        <div class="thumb" style="left:calc(${pct}% - 12px)"></div>
        <input type="range" id="raise-range" min="0" max="1000" step="1" value="${Math.round(t * 1000)}" aria-label="レイズ額" ${hi > lo ? '' : 'disabled'}>
        ${scale}
      </div>
      <button class="nudge" data-act="nudge" data-v="1" aria-label="少し上げる">＋</button>`;
  } else {
    presetsHtml = ['', '', '', ''].map(() => '<button class="preset" disabled><b>—</b><span>&nbsp;</span></button>').join('');
    sliderHtml = '<div class="slider-off">これ以上レイズはできません</div>';
  }

  let buttons = '';
  if (legal.canCheck) buttons += '<button class="btn-main check" data-act="check" style="flex:1 1 0">チェック</button>';
  else {
    buttons += '<button class="btn-main fold" data-act="fold" style="flex:1 1 0">フォールド</button>';
    const allIn = legal.callAmount >= me.stack;
    buttons += `<button class="btn-main call" data-act="call" style="flex:1.1 1 0"><b>${allIn ? 'オールイン' : 'コール'}</b><span>${fmt(legal.callAmount)}</span></button>`;
  }
  if (canRaise) {
    const r = raiseTexts(legal, amount);
    buttons += `<button class="btn-main raise" data-act="do-raise" style="flex:1.4 1 0"><b id="raise-label">${r.label}</b><span id="raise-sub">${r.sub}</span></button>`;
  }
  return `<div class="presets${canRaise ? '' : ' off'}">${presetsHtml}</div>
    <div class="slider-row${canRaise ? '' : ' off'}">${sliderHtml}</div>
    <div class="main-row">${buttons}</div>`;
}

function renderWaiting(me, meIndex) {
  const s = state;
  const p = toActPlayer(s);
  if (isDuo(s)) {
    // 2人のモード：先行予約は使わず、次に番が来る人を出す（要件 M-8）
    const next = nextHumanTurn(s);
    const head = `<div class="w-head"><div><i class="dot"></i>${p.name} が考え中…</div>${next ? `<div class="w-left"><span class="${colorCls(next.player.id).trim()}">${next.player.name}</span> の番まで あと${next.left}人</div>` : ''}</div>`;
    const msg = me.folded ? `${me.name} はフォールドしました。` : me.allIn ? `${me.name} はオールインしています。` : '';
    const hint = s.view.revealAll ? '「手札を表示」中です。上のボタンで隠せます' : '手札は伏せています。番が来たら受け渡しの画面が出ます';
    return `${head}<div class="w-msg">${msg}${hint}</div>`;
  }
  const left = turnsUntil(s, meIndex);
  const head = `<div class="w-head"><div><i class="dot"></i>${p.name} が考え中…</div>${left > 0 ? `<div class="w-left">あなたの番まで あと${left}人</div>` : ''}</div>`;
  if (me.folded) return `${head}<div class="w-msg">フォールドしました。次のハンドを待っています</div>`;
  if (me.allIn) return `${head}<div class="w-msg">オールインしています。結果を待っています</div>`;

  const toCall = myToCall(me);
  const ctx = { handNumber: s.handNumber, street: s.street, toCall };
  if (pre && !isPreActionValid(pre, ctx)) pre = null; // レイズ・ベットが入ったら取り消す
  const opts = preActionOptions(toCall);
  const buttons = opts.map((o) => {
    const on = pre && pre.type === o.type;
    const label = o.type === 'call' ? `${o.label} ${fmt(o.amount)}` : o.label;
    return `<button class="pre${on ? ' on' : ''}" data-act="pre" data-v="${o.type}" aria-pressed="${on ? 'true' : 'false'}"><span class="pbox"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#1a1205" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.2l2.4 2.4 4.6-5"></path></svg></span>${label}</button>`;
  }).join('');
  const note = toCall > 0 ? '誰かがレイズしたら、コールの予約は取り消されます' : '誰かがベットしたら、チェックの予約は取り消されます';
  return `${head}<div class="w-cap">先に選んでおく（自分の番になったら自動で実行）</div>
    <div class="main-row">${buttons}</div><div class="w-note">${note}</div>`;
}

function renderResultActions(me, result, shown) {
  const s = state;
  const main = result.pots[0];
  const winners = main.winnerIds;
  const went = result.showdown.length > 0;
  const title = winners.length > 1 ? `${winners.map(nameOf).join('・')} で分け合い` : `${nameOf(winners[0])} の勝ち`;
  const wv = went ? shown.get(winners[0])?.value : null;
  const sub = went && wv ? handLabel(wv) : '全員フォールド';
  const amount = main.payouts[winners[0]] ?? main.amount; // メインポットの取り分（サイドポットは下に内訳）

  const notes = [];
  result.pots.forEach((p, i) => {
    if (i === 0) return;
    if (p.eligibleIds.length === 1) notes.push(`${nameOf(p.eligibleIds[0])} に ${fmt(p.amount)} を返却（コールされなかった分）`);
    else notes.push(`サイドポット${i}（${fmt(p.amount)}）：${p.winnerIds.map(nameOf).join('・')}（${p.winningHandName}）`);
  });
  if (isDuo(s)) notes.unshift(`収支：${s.players.filter((p) => !p.isCPU).map((p) => `${humanName(p.id)} ${netLabel(net(p))}`).join('　')}`);
  if (!isDuo(s) && me.stack === 0) notes.push(`チップがなくなったので、次のハンドで ${fmt(s.settings.buyIn)} を買い足します`);
  const bust = s.players.filter((p) => (isDuo(s) || p.isCPU) && p.stack === 0).map((p) => p.name);
  if (bust.length) notes.push(`次のハンドで ${fmt(s.settings.buyIn)} を買い足し：${bust.join('・')}`);

  return `<div class="win-box"><div><div class="w-title">${title}</div><div class="w-sub">${sub}</div></div><div class="w-amt">+${fmt(amount)}</div></div>
    <div class="r-notes">${notes.map((t) => `<div>${t}</div>`).join('')}</div>
    <button class="btn-main next" data-act="next">次のハンドへ</button>`;
}

/** テーブル領域（393×440 のデザイン）を、使える広さに合わせて拡大・縮小する */
function fitStage() {
  const area = app.querySelector('.table-area');
  const stage = app.querySelector('.stage');
  if (!area || !stage) return;
  const scale = Math.min(area.clientWidth / STAGE.w, area.clientHeight / STAGE.h, 1.3);
  const top = Math.max(0, (area.clientHeight - STAGE.h * scale) / 2);
  stage.style.transform = `translateX(-50%) scale(${scale})`;
  stage.style.top = `${top}px`;
}

// ---- 進行 ----
function startGame() {
  const players = createPlayersFor(setup.mode, setup.buyIn, setup.cpuCount);
  state = createGame({ buyIn: setup.buyIn, cpuLevel: setup.cpuLevel, showEquity: setup.showEquity, mode: setup.mode }, players, Math.floor(Math.random() * players.length));
  initView(state);
  startNewHand(state);
  noteNewHand(state);
  pre = null;
  save();
  screen = 'table';
}

function act(action) {
  const id = state && actorId(state);
  if (!id) return;
  const street = state.street;
  const text = describeMove(legalActions(state, id), action, state.players.find((p) => p.id === id).stack);
  try {
    applyAction(state, action, id);
  } catch {
    return; // 画面が古いだけなので描き直す
  }
  noteAction(state, id, text, street);
  pre = null;
  save();
}

function nextHand() {
  if (!state || state.phase === 'betting' && state.toActIndex !== null) return;
  startNewHand(state);
  noteNewHand(state);
  pre = null;
  save();
}

/** CPU の手番なら少し待ってから行動させる。自分の番で予約があれば自動で実行する */
function scheduleBot() {
  // 同じ手番のタイマーが動いているあいだは、描き直しても最初からやり直さない
  // （予約ボタンなどを押すたびに CPU の動きが遅れないように）
  if (botTimer && screen === 'table' && state && state.phase === 'betting' && botSeq === state.actionSeq) return;
  clearTimeout(botTimer);
  botTimer = null;
  if (screen !== 'table' || !state || state.phase !== 'betting') return;
  const p = toActPlayer(state);
  if (!p) return;
  const seq = state.actionSeq;
  botSeq = seq;
  if (!p.isCPU) {
    if (!pre || isDuo(state)) return;
    const me = p;
    const ctx = { handNumber: state.handNumber, street: state.street, toCall: myToCall(me) };
    if (!isPreActionValid(pre, ctx)) { pre = null; return; }
    botTimer = setTimeout(() => {
      botTimer = null;
      if (!state || state.actionSeq !== seq || screen !== 'table') return;
      const action = resolvePreAction(pre, legalActions(state, p.id));
      pre = null;
      if (action) act(action);
      safeRender();
    }, 350);
    return;
  }
  if (!p.isCPU) return;
  // バッジが読めるよう、CPU は約1.0〜1.4秒かけて動く（要件 U-9）
  const delay = 1000 + Math.random() * 400;
  botTimer = setTimeout(() => {
    botTimer = null;
    if (!state || state.actionSeq !== seq || screen !== 'table') return;
    let action = decideCPU(state, p.id, state.settings.cpuLevel);
    const legal = legalActions(state, p.id);
    const street = state.street;
    const stackBefore = p.stack;
    try {
      applyAction(state, action, p.id);
    } catch {
      // 念のため：判断が不正でも必ず合法な手で進める
      action = legal.canCheck ? { type: 'check' } : { type: 'fold' };
      applyAction(state, action, p.id);
    }
    noteAction(state, p.id, describeMove(legal, action, stackBefore), street);
    save();
    safeRender();
  }, delay);
}

// ---- 予期しないエラーのとき：真っ白で止まらず、戻る手段を出す ----
function showCrash(err) {
  clearTimeout(botTimer);
  botTimer = null;
  modal = null;
  const msg = String(err?.message ?? err).replace(/[<>&]/g, '');
  app.classList.remove('has-result');
  app.innerHTML = `<div class="title-screen">
      <h1 style="font-size:24px">問題が発生しました</h1>
      <p class="dim" style="font-size:14px;line-height:1.7">ゲームを続けられなくなりました。<br>タイトルに戻ってやり直してください。</p>
      <div class="menu">
        <button class="btn blue" data-act="crash-title">タイトルへ戻る</button>
        <button class="btn gray" data-act="crash-reset">保存データを消して最初から</button>
      </div>
      <p class="faint" style="font-size:11px">${msg}</p>
    </div>`;
}

function safeRender() {
  try { render(); } catch (err) { showCrash(err); }
}

window.addEventListener('error', (e) => showCrash(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => showCrash(e.reason));

// ---- 操作 ----
// 素早い2度押しで、次の画面の同じ位置のボタン（次の人のアクション、次のハンドの自分のフォールドなど）まで
// 押されてしまわないよう、進行するボタンを押した直後は少しのあいだ操作ボタンを受け付けない
const STEP_ACTS = new Set(['fold', 'check', 'call', 'do-raise', 'next', 'handoff']);
const GUARDED_ACTS = new Set(['fold', 'check', 'call', 'do-raise', 'next', 'preset', 'nudge', 'pre', 'reveal']);
const GUARD_MS = 450;
let lastStepAt = 0;

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const act = el.dataset.act;
  const guardMs = typeof window.__guardMs === 'number' ? window.__guardMs : GUARD_MS; // 自動テストでは 0 にできる
  if (GUARDED_ACTS.has(act) && Date.now() - lastStepAt < guardMs) return;
  if (STEP_ACTS.has(act)) lastStepAt = Date.now();
  try {
    handleClick(el.dataset.act, el.dataset.v);
  } catch (err) {
    showCrash(err);
    return;
  }
  safeRender();
});

function handleClick(action, v) {
  switch (action) {
    case 'crash-title': state = null; screen = 'title'; break;
    case 'crash-reset': for (const m of MODE_KEYS) store.remove(MODES[m].saveKey); state = null; screen = 'title'; break;
    case 'new': {
      const mode = MODES[v] ? v : 'solo';
      const go = () => { setup.mode = mode; store.set(SETUP_KEY, setup); screen = 'setup'; };
      if (loadSave(mode)) {
        modal = { text: `「${MODES[mode].label}」の保存中のゲームは消えます。<br>新しく始めますか？`, okLabel: '新しく始める', ok: go };
      } else go();
      break;
    }
    case 'resume': {
      const saved = MODES[v] ? loadSave(v) : null;
      if (saved) {
        state = saved.state; savedAt = saved.savedAt; screen = 'table'; pre = null;
        initView(state, { resumed: true }); // 再開したときは受け渡し画面から
      }
      break;
    }
    case 'handoff': if (state) { confirmHandoff(state); save(); } break;
    case 'reveal':
      if (!state || !isDuo(state)) break;
      if (state.view.revealAll) { setReveal(state, false); save(); break; }
      // 誤って押して相手の手札が見えないよう、表にするときだけ確かめる
      modal = {
        text: '2人の手札を表にしますか？<br><span class="dim" style="font-size:13px">相手の手札も見えるようになります。<br>「手札を隠す」で元に戻せます</span>',
        okLabel: '表にする', cancelLabel: 'やめる',
        ok: () => { if (state && isDuo(state)) { setReveal(state, true); save(); } },
      };
      break;
    case 'help': helpReturn = screen; screen = 'help'; break;
    case 'help-back': screen = helpReturn; break;
    case 'to-title': screen = 'title'; break;
    case 'set-buyin': setup.buyIn = Number(v); store.set(SETUP_KEY, setup); break;
    case 'set-level': setup.cpuLevel = v; store.set(SETUP_KEY, setup); break;
    case 'set-equity': setup.showEquity = v === 'on'; store.set(SETUP_KEY, setup); break;
    case 'cpu-minus': setup.cpuCount = Math.max(CPU_MIN, setup.cpuCount - 1); store.set(SETUP_KEY, setup); break;
    case 'cpu-plus': setup.cpuCount = Math.min(CPU_MAX, setup.cpuCount + 1); store.set(SETUP_KEY, setup); break;
    case 'start': startGame(); break;
    case 'menu':
      modal = { text: 'タイトルに戻りますか？<br><span class="dim" style="font-size:13px">「続きから」で再開できます</span>', okLabel: 'タイトルへ', cancelLabel: '続ける', ok: () => { clearTimeout(botTimer); botTimer = null; screen = 'title'; } };
      break;
    case 'modal-ok': { const ok = modal?.ok; modal = null; ok?.(); break; }
    case 'modal-cancel': modal = null; break;
    case 'fold': act({ type: 'fold' }); break;
    case 'check': act({ type: 'check' }); break;
    case 'call': act({ type: 'call' }); break;
    case 'preset': sizing.amount = Number(v); break;
    case 'nudge': {
      const legal = legalActions(state, actorId(state));
      if (legal) sizing.amount = nudge(sizing.amount, Number(v), legal.minRaiseTo, legal.maxRaiseTo);
      break;
    }
    case 'do-raise': {
      const legal = legalActions(state, actorId(state));
      if (legal && legal.canRaise) {
        const to = Math.min(Math.max(sizing.amount, legal.minRaiseTo), legal.maxRaiseTo);
        act({ type: 'raise', to });
      }
      break;
    }
    case 'pre': {
      // 同じ予約をもう一度押したら取り消し
      if (pre && pre.type === v) { pre = null; break; }
      const me = state.players.find((p) => p.id === SOLO_ID);
      if (!me || isDuo(state)) break;
      const option = preActionOptions(myToCall(me)).find((o) => o.type === v);
      if (option) pre = makePreAction(option, state.handNumber, state.street);
      break;
    }
    case 'next': nextHand(); break;
    default: break;
  }
}

// スライダーは描き直さずに数字だけ更新する（指の動きを止めないため）
app.addEventListener('input', (e) => {
  if (e.target.id !== 'raise-range' || !state) return;
  setSliderPosition(e.target.closest('.slider'), Number(e.target.value) / 1000);
});

// 指で触った位置にそのまま合わせる（iOS の Safari はバーをタップしても値が飛ばないため、自前で扱う）
let dragging = null;
function sliderPoint(e) {
  const rect = dragging.getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
}
app.addEventListener('pointerdown', (e) => {
  const slider = e.target.closest('.slider');
  if (!slider || !state || !legalActions(state, actorId(state))?.canRaise) return;
  dragging = slider;
  try { slider.setPointerCapture(e.pointerId); } catch { /* 合成イベントなど */ }
  setSliderPosition(slider, sliderPoint(e));
  e.preventDefault();
});
app.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  setSliderPosition(dragging, sliderPoint(e));
});
const endDrag = () => { dragging = null; };
app.addEventListener('pointerup', endDrag);
app.addEventListener('pointercancel', endDrag);

function setSliderPosition(slider, t) {
  const legal = state && legalActions(state, actorId(state));
  if (!slider || !legal || !legal.canRaise) return;
  sizing.amount = amountAt(t, legal.minRaiseTo, legal.maxRaiseTo);
  const range = slider.querySelector('input');
  if (range) range.value = String(Math.round(t * 1000));
  const pct = `${(t * 100).toFixed(1)}%`;
  slider.querySelector('.fill').style.width = pct;
  slider.querySelector('.thumb').style.left = `calc(${pct} - 12px)`;
  const r = raiseTexts(legal, sizing.amount);
  document.getElementById('raise-label').textContent = r.label;
  document.getElementById('raise-sub').textContent = r.sub;
  let marked = false;
  for (const b of app.querySelectorAll('.preset')) {
    const on = !marked && Number(b.dataset.v) === sizing.amount;
    if (on) marked = true;
    b.classList.toggle('on', on);
  }
}

window.addEventListener('resize', fitStage);

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
  // 新しい版が有効になったら読み込み直して表示を切り替える（初めて入れたときは何もしない）
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    save();
    location.reload();
  });
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
  if (screen === 'title' && !modal) safeRender();
}

safeRender();
setUpOffline();
