// 2人で1台を回して遊ぶモード（要件 M-1〜M-10）。画面に関係しない判断だけをここに置く（テストできるように）。
// state.view = { viewerId: 画面の下にいる人, unlockedId: 手札を表にしてよい人, revealAll: 2人の手札を同時に表示中 }

import { createPlayer, toActPlayer } from './game.js';

export const SOLO_ID = 'me';
export const HUMANS = [
  { id: 'p1', name: 'しょうご', color: 'blue' },
  { id: 'p2', name: 'なのは', color: 'pink' },
];

export const MODES = {
  solo: { label: '1人で練習', sub: 'CPU 2〜9人と対戦', saveKey: 'flightpoker.save.v1' },
  duoCpu: { label: '2人＋CPU 4人', sub: 'しょうご・なのは＋CPU 4人（6人卓）', saveKey: 'flightpoker.save.duocpu.v1', cpuCount: 4 },
  duo: { label: '2人だけ', sub: 'しょうご 対 なのは（ヘッズアップ）', saveKey: 'flightpoker.save.duo.v1', cpuCount: 0 },
};
export const MODE_KEYS = Object.keys(MODES);

export const modeOf = (state) => (MODES[state?.settings?.mode] ? state.settings.mode : 'solo');
export const isDuo = (state) => modeOf(state) !== 'solo';
export const humanColor = (id) => HUMANS.find((h) => h.id === id)?.color ?? null;

/** 席の並び。2人＋CPU 4人では2人を向かい合わせに座らせる */
export function createPlayersFor(mode, buyIn, soloCpuCount) {
  const cpu = (k) => createPlayer(`cpu-${k}`, `CPU ${k}`, true, buyIn);
  const [a, b] = HUMANS.map((h) => createPlayer(h.id, h.name, false, buyIn));
  if (mode === 'duo') return [a, b];
  if (mode === 'duoCpu') return [a, cpu(1), cpu(2), b, cpu(3), cpu(4)];
  const players = [createPlayer(SOLO_ID, 'あなた', false, buyIn)];
  for (let k = 1; k <= soloCpuCount; k++) players.push(cpu(k));
  return players;
}

/** 保存から読み込んだときも含めて、view を正しい形にする。再開したときは必ず受け渡し画面から */
export function initView(state, { resumed = false } = {}) {
  if (!isDuo(state)) return;
  const humans = state.players.filter((p) => !p.isCPU).map((p) => p.id);
  const v = state.view && typeof state.view === 'object' ? state.view : {};
  state.view = {
    viewerId: humans.includes(v.viewerId) ? v.viewerId : humans[0],
    unlockedId: !resumed && humans.includes(v.unlockedId) ? v.unlockedId : null,
    revealAll: v.revealAll === true,
    log: Array.isArray(v.log) ? v.log.filter((m) => m && typeof m.id === 'string' && typeof m.text === 'string').slice(-30) : [],
    logHand: Number.isInteger(v.logHand) ? v.logHand : state.handNumber,
  };
}

/** 手番の人（CPU なら null） */
export function humanToAct(state) {
  if (state.phase !== 'betting') return null;
  const p = toActPlayer(state);
  return p && !p.isCPU ? p : null;
}

/** 受け渡し画面を出すか（要件 M-4） */
export function needsHandoff(state) {
  if (!isDuo(state) || state.view.revealAll) return false;
  const h = humanToAct(state);
  return !!h && state.view.unlockedId !== h.id;
}

/** 受け渡し画面で「手札を見る」を押した */
export function confirmHandoff(state) {
  const h = humanToAct(state);
  if (!h) return;
  state.view.viewerId = h.id;
  state.view.unlockedId = h.id;
}

/** 画面の下に置く人（要件 M-6） */
export function viewerId(state) {
  if (!isDuo(state)) return SOLO_ID;
  const h = humanToAct(state);
  if (state.view.revealAll && h) return h.id;
  return state.view.viewerId;
}

/** その人の手札を表にしてよいか（要件 M-5, M-7）。ショーダウンで公開された手札は別に扱う */
export function canSeeCards(state, id) {
  if (!isDuo(state)) return id === SOLO_ID;
  if (state.players.find((p) => p.id === id)?.isCPU !== false) return false;
  if (state.view.revealAll) return true;
  return state.view.unlockedId === id && humanToAct(state)?.id === id;
}

/** 今ボタンを押して動ける人（受け渡しが済んでいる手番の人）。いなければ null */
export function actorId(state) {
  const h = humanToAct(state);
  if (!h) return null;
  if (!isDuo(state)) return h.id;
  return canSeeCards(state, h.id) ? h.id : null;
}

const yen = (n) => n.toLocaleString('ja-JP');

/** 動きの説明（受け渡し画面の「直前の動き」用）。legal は動く前の legalActions */
export function describeMove(legal, action, stack) {
  if (!legal || !action) return '';
  switch (action.type) {
    case 'fold': return 'フォールド';
    case 'check': return 'チェック';
    case 'call': return legal.callAmount >= stack ? 'オールイン' : `コール ${yen(legal.callAmount)}`;
    case 'raise': return action.to >= legal.maxRaiseTo ? `オールイン ${yen(action.to)}` : `${legal.isBet ? 'ベット' : 'レイズ'} ${yen(action.to)}`;
    default: return '';
  }
}

/** この人が前に動いてから今までの動き（最新の4つまで）。[{ id, text, street }] */
export function movesSince(state, id) {
  const log = state.view?.log;
  if (!Array.isArray(log) || state.view.logHand !== state.handNumber) return [];
  let start = 0;
  for (let k = log.length - 1; k >= 0; k--) if (log[k].id === id) { start = k + 1; break; }
  return log.slice(start).slice(-4);
}

/** 誰かが動いたあと：同じ人が続けて動くときだけ手札を表のままにする。text は動きの説明（記録用） */
export function noteAction(state, id, text = '', street = state.street) {
  if (!isDuo(state)) return;
  if (state.view.logHand !== state.handNumber || !Array.isArray(state.view.log)) {
    state.view.log = [];
    state.view.logHand = state.handNumber;
  }
  if (text) state.view.log.push({ id, text, street });
  const p = state.players.find((q) => q.id === id);
  if (p && !p.isCPU) state.view.viewerId = id;
  state.view.unlockedId = humanToAct(state)?.id === id && p && !p.isCPU ? id : null;
}

export function noteNewHand(state) {
  if (!isDuo(state)) return;
  state.view.unlockedId = null;
  state.view.log = [];
  state.view.logHand = state.handNumber;
}

/** 「手札を表示／隠す」（要件 M-7）。隠すときは、今の手番の人の手札だけ表のまま */
export function setReveal(state, on) {
  if (!isDuo(state)) return;
  const h = humanToAct(state);
  state.view.revealAll = on;
  if (h) {
    state.view.viewerId = h.id;
    state.view.unlockedId = h.id;
  }
}

/** index の人の番まで、あと何人か（要件 U-17, M-8）。もう動かなくてよい場合は 0 */
export function turnsUntil(state, index) {
  const s = state;
  const me = s.players[index];
  if (s.phase !== 'betting' || s.toActIndex === null || me.folded || me.allIn) return 0;
  if (me.actedThisStreet && me.streetBet >= s.currentBet) return 0;
  let n = 0;
  for (let i = s.toActIndex, guard = 0; i !== index && guard < s.players.length; i = (i + 1) % s.players.length, guard++) {
    const p = s.players[i];
    if (!p.folded && !p.allIn) n++;
  }
  return n;
}

/** 次に番が来る人（CPU が考えている間の表示用）。{ player, left } か null */
export function nextHumanTurn(state) {
  let best = null;
  state.players.forEach((p, i) => {
    if (p.isCPU) return;
    const left = turnsUntil(state, i);
    if (left > 0 && (!best || left < best.left)) best = { player: p, left };
  });
  return best;
}
