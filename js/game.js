// テーブル全体の状態と進行。state はただのオブジェクトなので、そのまま JSON にして保存できる（要件 S-1）。
// 関数はすべて state を書き換える（apply は不正なアクションなら例外を投げ、state は変えない）。

import { fullDeck, shuffle } from './cards.js';
import { evaluate, compareValues } from './evaluator.js';

export const SETTINGS_DEFAULT = { smallBlind: 1000, bigBlind: 3000, buyIn: 100000, cpuLevel: 'normal' };
export const BUY_IN_OPTIONS = [100000, 200000, 300000, 400000, 500000];
export const MAX_SEATS = 10;
export const STREET_NAMES = { preflop: 'プリフロップ', flop: 'フロップ', turn: 'ターン', river: 'リバー', showdown: 'ショーダウン' };
export const ACTION_NAMES = {
  smallBlind: 'SB', bigBlind: 'BB', fold: 'フォールド', check: 'チェック', call: 'コール',
  bet: 'ベット', raise: 'レイズ', allIn: 'オールイン',
};

export class GameError extends Error {}

export function createPlayer(id, name, isCPU, stack) {
  return {
    id, name, isCPU, stack, totalBuyIn: stack,
    holeCards: [], streetBet: 0, totalCommitted: 0, folded: false, allIn: false,
    actedThisStreet: false, fullRaiseLevelWhenActed: 0, lastAction: null,
  };
}

export function createGame(settings, players, dealerIndex = 0) {
  if (players.length < 2 || players.length > MAX_SEATS) throw new Error('2〜10人');
  return {
    settings: { ...SETTINGS_DEFAULT, ...settings },
    players, dealerIndex,
    handNumber: 0, street: 'preflop', board: [], deck: [],
    currentBet: 0, minRaiseIncrement: 0, fullRaiseLevel: 0,
    toActIndex: null, phase: 'notStarted', lastResult: null, actionSeq: 0, rebuyIds: [],
  };
}

// ---- 便利関数 ----

export const pot = (state) => state.players.reduce((sum, p) => sum + p.totalCommitted, 0);
export const toActPlayer = (state) => (state.toActIndex === null ? null : state.players[state.toActIndex]);
export const net = (player) => player.stack - player.totalBuyIn; // 収支（要件 L-5）
export const indexOf = (state, id) => state.players.findIndex((p) => p.id === id);

export function smallBlindIndex(state) {
  const n = state.players.length;
  return n === 2 ? state.dealerIndex : (state.dealerIndex + 1) % n;
}
export function bigBlindIndex(state) {
  const n = state.players.length;
  return n === 2 ? (state.dealerIndex + 1) % 2 : (state.dealerIndex + 2) % n;
}

const activeIndices = (state) => state.players.map((_, i) => i).filter((i) => !state.players[i].folded);

function needsToAct(state, i) {
  const p = state.players[i];
  return !p.folded && !p.allIn && (!p.actedThisStreet || p.streetBet < state.currentBet);
}

function nextToAct(state, start) {
  const n = state.players.length;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (needsToAct(state, i)) return i;
  }
  return null;
}

function commit(state, i, amount) {
  const p = state.players[i];
  p.stack -= amount;
  p.streetBet += amount;
  p.totalCommitted += amount;
  if (p.stack === 0) p.allIn = true;
}

// ---- ハンドの開始 ----

/** deck を渡すとその順番で配る（テスト用）。省略時はシャッフルする */
export function startNewHand(state, { rand = Math.random, deck = null } = {}) {
  // チップが 0 の人は開始チップと同じ額を買い足す（要件 R-11, R-12）
  state.rebuyIds = [];
  for (const p of state.players) {
    if (p.stack <= 0) {
      p.stack += state.settings.buyIn;
      p.totalBuyIn += state.settings.buyIn;
      state.rebuyIds.push(p.id);
    }
  }
  for (const p of state.players) {
    Object.assign(p, {
      holeCards: [], streetBet: 0, totalCommitted: 0, folded: false, allIn: false,
      actedThisStreet: false, fullRaiseLevelWhenActed: 0, lastAction: null,
    });
  }
  const n = state.players.length;
  if (state.handNumber > 0) state.dealerIndex = (state.dealerIndex + 1) % n;
  state.handNumber += 1;
  state.board = [];
  state.street = 'preflop';
  state.lastResult = null;
  state.deck = deck ? deck.slice() : shuffle(fullDeck(), rand);

  post(state, smallBlindIndex(state), state.settings.smallBlind, 'smallBlind');
  post(state, bigBlindIndex(state), state.settings.bigBlind, 'bigBlind');
  state.currentBet = Math.max(...state.players.map((p) => p.streetBet));
  state.minRaiseIncrement = state.settings.bigBlind;
  state.fullRaiseLevel = state.currentBet;

  // ディーラーの左から1枚ずつ2周配る
  for (let round = 0; round < 2; round++) {
    for (let k = 1; k <= n; k++) state.players[(state.dealerIndex + k) % n].holeCards.push(state.deck.shift());
  }

  state.phase = 'betting';
  const first = n === 2 ? state.dealerIndex : (bigBlindIndex(state) + 1) % n;
  state.toActIndex = nextToAct(state, first);
  if (state.toActIndex === null) finishStreetAndAdvance(state);
  state.actionSeq += 1;
}

function post(state, i, amount, kind) {
  const p = state.players[i];
  commit(state, i, Math.min(amount, p.stack));
  p.lastAction = { kind: p.allIn ? 'allIn' : kind, amount: p.streetBet };
}

// ---- 選べるアクション ----

export function legalActions(state, playerId) {
  if (state.phase !== 'betting' || state.toActIndex === null) return null;
  if (state.players[state.toActIndex].id !== playerId) return null;
  return legalActionsAt(state, state.toActIndex);
}

function legalActionsAt(state, i) {
  const p = state.players[i];
  const toCall = Math.max(0, state.currentBet - p.streetBet);
  const maxTo = p.streetBet + p.stack;
  const raiseRightOpen = !p.actedThisStreet || state.fullRaiseLevel > p.fullRaiseLevelWhenActed;
  const othersCanAct = activeIndices(state).some((j) => j !== i && !state.players[j].allIn);
  const canRaise = raiseRightOpen && maxTo > state.currentBet && othersCanAct;
  const minTo = state.currentBet === 0 ? state.settings.bigBlind : state.currentBet + state.minRaiseIncrement;
  return {
    canFold: toCall > 0,
    canCheck: toCall === 0,
    callAmount: Math.min(toCall, p.stack),
    canRaise,
    isBet: state.currentBet === 0,
    minRaiseTo: Math.min(minTo, maxTo),
    maxRaiseTo: maxTo,
  };
}

/** ポットに対する割合でのベット・レイズ額（ショートカットボタン用）。1,000 単位に丸める */
export function raiseToPotFraction(state, playerId, fraction) {
  const legal = legalActions(state, playerId);
  if (!legal || !legal.canRaise) return null;
  const p = state.players[indexOf(state, playerId)];
  const toCall = Math.max(0, state.currentBet - p.streetBet);
  const raw = state.currentBet + Math.floor((pot(state) + toCall) * fraction);
  const rounded = Math.floor((raw + 500) / 1000) * 1000;
  return Math.min(Math.max(rounded, legal.minRaiseTo), legal.maxRaiseTo);
}

// ---- アクションの適用 ----
// action: {type: 'fold'|'check'|'call'} または {type: 'raise', to: 合計額}

export function applyAction(state, action, playerId) {
  if (state.phase !== 'betting') throw new GameError('notBetting');
  const i = state.toActIndex;
  if (i === null || state.players[i].id !== playerId) throw new GameError('notYourTurn');
  const legal = legalActionsAt(state, i);
  const p = state.players[i];

  switch (action.type) {
    case 'fold':
      if (!legal.canFold) throw new GameError('illegalAction');
      p.folded = true;
      p.lastAction = { kind: 'fold', amount: 0 };
      break;
    case 'check':
      if (!legal.canCheck) throw new GameError('illegalAction');
      p.lastAction = { kind: 'check', amount: p.streetBet };
      break;
    case 'call':
      if (!(legal.callAmount > 0)) throw new GameError('illegalAction');
      commit(state, i, legal.callAmount);
      p.lastAction = { kind: p.allIn ? 'allIn' : 'call', amount: p.streetBet };
      break;
    case 'raise': {
      const to = action.to;
      if (!legal.canRaise || !Number.isInteger(to) || to < legal.minRaiseTo || to > legal.maxRaiseTo || to <= state.currentBet) {
        throw new GameError('illegalAction');
      }
      const wasBet = state.currentBet === 0;
      const increment = to - state.currentBet;
      commit(state, i, to - p.streetBet);
      if (increment >= state.minRaiseIncrement) {
        // フルレイズ：他の人に再レイズの権利が戻る（少額オールインでは戻らない）
        state.minRaiseIncrement = Math.max(increment, state.settings.bigBlind);
        state.fullRaiseLevel = to;
      }
      state.currentBet = to;
      p.lastAction = { kind: p.allIn ? 'allIn' : wasBet ? 'bet' : 'raise', amount: to };
      break;
    }
    default:
      throw new GameError('illegalAction');
  }

  p.actedThisStreet = true;
  p.fullRaiseLevelWhenActed = state.fullRaiseLevel;
  state.actionSeq += 1;
  advance(state, i);
}

// ---- 進行 ----

function advance(state, i) {
  const active = activeIndices(state);
  if (active.length === 1) {
    finishWithoutShowdown(state, active[0]);
    return;
  }
  const next = nextToAct(state, (i + 1) % state.players.length);
  if (next !== null) {
    state.toActIndex = next;
    return;
  }
  finishStreetAndAdvance(state);
}

/** その街のベットが終わったら次の街へ。アクションできる人が1人以下なら最後まで開いてショーダウン */
function finishStreetAndAdvance(state) {
  for (;;) {
    if (state.street === 'river') {
      showdown(state);
      return;
    }
    for (const p of state.players) {
      p.streetBet = 0;
      p.actedThisStreet = false;
      p.fullRaiseLevelWhenActed = 0;
      if (!p.folded && !p.allIn) p.lastAction = null;
    }
    state.currentBet = 0;
    state.fullRaiseLevel = 0;
    state.minRaiseIncrement = state.settings.bigBlind;
    dealNextStreet(state);

    const canAct = activeIndices(state).filter((j) => !state.players[j].allIn);
    if (canAct.length >= 2) {
      const next = nextToAct(state, (state.dealerIndex + 1) % state.players.length);
      if (next !== null) {
        state.toActIndex = next;
        return;
      }
    }
  }
}

function dealNextStreet(state) {
  state.deck.shift(); // バーンカード
  if (state.street === 'preflop') {
    state.board.push(...state.deck.splice(0, 3));
    state.street = 'flop';
  } else if (state.street === 'flop') {
    state.board.push(state.deck.shift());
    state.street = 'turn';
  } else if (state.street === 'turn') {
    state.board.push(state.deck.shift());
    state.street = 'river';
  }
}

function finishWithoutShowdown(state, w) {
  const amount = pot(state);
  const winner = state.players[w];
  winner.stack += amount;
  state.lastResult = {
    handNumber: state.handNumber, board: state.board.slice(),
    pots: [{ amount, eligibleIds: [winner.id], winnerIds: [winner.id], payouts: { [winner.id]: amount }, winningHandName: null }],
    showdown: [], totalPayouts: { [winner.id]: amount },
  };
  endHand(state);
}

function showdown(state) {
  state.street = 'showdown';
  const values = {};
  for (const i of activeIndices(state)) {
    const p = state.players[i];
    values[p.id] = evaluate([...p.holeCards, ...state.board]);
  }
  const pots = computePots(state.players.map((p) => ({ id: p.id, committed: p.totalCommitted, folded: p.folded })));
  // 端数はディーラーの左に近い人から配る
  const n = state.players.length;
  const seatOrder = Array.from({ length: n }, (_, k) => state.players[(state.dealerIndex + 1 + k) % n].id);

  const results = [];
  const total = {};
  for (const potInfo of pots) {
    const contenders = potInfo.eligibleIds.filter((id) => values[id]);
    let best = values[contenders[0]];
    for (const id of contenders) if (compareValues(values[id], best) > 0) best = values[id];
    const winners = seatOrder.filter((id) => potInfo.eligibleIds.includes(id) && values[id] && compareValues(values[id], best) === 0);
    const share = Math.floor(potInfo.amount / winners.length);
    let remainder = potInfo.amount % winners.length;
    const payouts = {};
    for (const w of winners) {
      let amt = share;
      if (remainder > 0) { amt += 1; remainder -= 1; }
      payouts[w] = amt;
      total[w] = (total[w] ?? 0) + amt;
    }
    results.push({
      amount: potInfo.amount, eligibleIds: potInfo.eligibleIds, winnerIds: winners, payouts,
      winningHandName: potInfo.eligibleIds.length > 1 ? best.name : null,
    });
  }
  for (const [id, amt] of Object.entries(total)) state.players[indexOf(state, id)].stack += amt;

  const shown = seatOrder.filter((id) => values[id]).map((id) => ({
    playerId: id, holeCards: state.players[indexOf(state, id)].holeCards.slice(), value: values[id],
  }));
  state.lastResult = { handNumber: state.handNumber, board: state.board.slice(), pots: results, showdown: shown, totalPayouts: total };
  endHand(state);
}

function endHand(state) {
  state.phase = 'handComplete';
  state.toActIndex = null;
}

/**
 * 各プレイヤーの拠出額からメインポットとサイドポットを作る。
 * フォールドした人のチップはポットに入るが、受け取る権利はない。
 */
export function computePots(contributions) {
  const contenders = contributions.filter((c) => !c.folded);
  const levels = [...new Set(contenders.map((c) => c.committed).filter((x) => x > 0))].sort((a, b) => a - b);
  if (levels.length === 0) {
    const total = contributions.reduce((s, c) => s + c.committed, 0);
    return total > 0 ? [{ amount: total, eligibleIds: contenders.map((c) => c.id) }] : [];
  }
  const pots = [];
  let prev = 0;
  levels.forEach((level, k) => {
    // 最後の段は上限なし（フォールドした人が多く出していた分も含める）
    const cap = k === levels.length - 1 ? Infinity : level;
    const amount = contributions.reduce((s, c) => s + Math.min(c.committed, cap) - Math.min(c.committed, prev), 0);
    const eligibleIds = contenders.filter((c) => c.committed >= level).map((c) => c.id);
    if (amount > 0) pots.push({ amount, eligibleIds });
    prev = level;
  });
  return pots;
}

/**
 * 保存データとして読み込んだ state が壊れていないか（要件 S-1・安定性）。
 * 壊れていたら「続きから」は出さずに新しく始めてもらう。
 */
export function isValidState(s) {
  const isCard = (c) => c && Number.isInteger(c.r) && c.r >= 2 && c.r <= 14 && Number.isInteger(c.s) && c.s >= 0 && c.s <= 3;
  try {
    if (!s || typeof s !== 'object' || !Array.isArray(s.players)) return false;
    const n = s.players.length;
    if (n < 2 || n > MAX_SEATS) return false;
    if (!['notStarted', 'betting', 'handComplete'].includes(s.phase)) return false;
    if (!Number.isInteger(s.dealerIndex) || s.dealerIndex < 0 || s.dealerIndex >= n) return false;
    if (!Array.isArray(s.board) || !s.board.every(isCard) || !Array.isArray(s.deck) || !s.deck.every(isCard)) return false;
    if (!s.settings || !Number.isInteger(s.settings.buyIn) || !Number.isInteger(s.settings.bigBlind)) return false;
    for (const p of s.players) {
      if (typeof p.id !== 'string' || !Number.isInteger(p.stack) || p.stack < 0) return false;
      if (!Array.isArray(p.holeCards) || !p.holeCards.every(isCard)) return false;
    }
    if (s.phase === 'betting') {
      if (!Number.isInteger(s.toActIndex) || s.toActIndex < 0 || s.toActIndex >= n) return false;
      if (s.players[s.toActIndex].folded || s.players[s.toActIndex].allIn) return false;
    }
    if (s.phase === 'handComplete' && (!s.lastResult || !Array.isArray(s.lastResult.pots))) return false;
    return true;
  } catch {
    return false;
  }
}
