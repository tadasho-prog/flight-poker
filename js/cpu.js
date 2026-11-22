// CPU の判断（要件 P-4, P-5）。必ず「その時点で選べるアクション」を返す。

import { fullDeck, cardKey, randInt } from './cards.js';
import { score } from './evaluator.js';
import { legalActions, indexOf, pot, raiseToPotFraction } from './game.js';

export const CPU_LEVELS = { weak: '弱い', normal: '普通', strong: '強い' };

/**
 * 勝率の目安（モンテカルロ法：残りのカードをランダムに配って何回も勝負させる）。
 * 相手の手札は分からないものとして計算する（山札の中身は見ない）。
 */
export function estimateEquity(hole, board, opponents, iterations, rand = Math.random) {
  if (opponents <= 0 || hole.length !== 2) return 1;
  const known = new Set([...hole, ...board].map(cardKey));
  const pool = fullDeck().filter((c) => !known.has(cardKey(c)));
  const boardNeed = 5 - board.length;
  const need = boardNeed + opponents * 2;
  if (need > pool.length || iterations <= 0) return 0;

  // 7枚分の入れ物を使い回す（[0],[1]=手札、[2..6]=場）
  const mine = [...hole, ...board, ...Array(boardNeed).fill(hole[0])];
  const theirs = mine.slice();
  let total = 0;
  for (let it = 0; it < iterations; it++) {
    for (let k = 0; k < need; k++) {
      const j = k + randInt(rand, pool.length - k);
      const t = pool[k]; pool[k] = pool[j]; pool[j] = t;
    }
    for (let k = 0; k < boardNeed; k++) mine[2 + board.length + k] = pool[k];
    for (let k = 2; k < 7; k++) theirs[k] = mine[k];
    const myScore = score(mine);
    let best = true;
    let ties = 1;
    for (let o = 0; o < opponents; o++) {
      theirs[0] = pool[boardNeed + o * 2];
      theirs[1] = pool[boardNeed + o * 2 + 1];
      const s = score(theirs);
      if (s > myScore) { best = false; break; }
      if (s === myScore) ties++;
    }
    if (best) total += 1 / ties;
  }
  return total / iterations;
}

/** ボタンに近い（後に行動する人が少ない）か */
function isLatePosition(state, i) {
  const n = state.players.length;
  const distance = (i - state.dealerIndex + n) % n; // 0 = ボタン
  return distance === 0 || distance === n - 1;
}

export function decideCPU(state, playerId, level, rand = Math.random) {
  const legal = legalActions(state, playerId);
  if (!legal) return { type: 'fold' };
  const i = indexOf(state, playerId);
  const me = state.players[i];
  const opponents = state.players.filter((p, j) => j !== i && !p.folded).length;

  // プリフロップは多くの人が降りるので、相手を最大2人として見積もる
  const preflop = state.street === 'preflop';
  const effectiveOpponents = preflop ? Math.min(opponents, 2) : opponents;
  const iterations = { weak: 80, normal: 200, strong: 350 }[level] ?? 200;
  let equity = estimateEquity(me.holeCards, state.board, effectiveOpponents, iterations, rand);
  if (level === 'weak') equity += (rand() * 2 - 1) * 0.12;
  if (level === 'strong' && isLatePosition(state, i)) equity += 0.04;

  const fair = 1 / (effectiveOpponents + 1);
  const strength = (equity - fair) / (1 - fair); // 0 で平均的、1 で最強
  const toCall = legal.callAmount;
  const potOdds = toCall > 0 ? toCall / (pot(state) + toCall) : 0;
  const roll = rand();
  // プリフロップは勝率の差が小さく出る（AA でも strength 0.6 前後）ので、レイズの基準を下げる
  const valueRaise = preflop ? 0.38 : 0.55;

  const callOrCheck = () => (legal.canCheck ? { type: 'check' } : { type: 'call' });
  const foldOrCheck = () => (legal.canCheck ? { type: 'check' } : { type: 'fold' });
  const raise = (fraction) => {
    const to = legal.canRaise ? raiseToPotFraction(state, playerId, fraction) : null;
    return to === null ? callOrCheck() : { type: 'raise', to };
  };

  if (level === 'weak') {
    // 弱い：コールしがちで、レイズは少ない
    if (legal.canCheck) return strength > 0.5 && roll < 0.4 ? raise(0.5) : { type: 'check' };
    if (strength > 0.6 && roll < 0.25) return raise(0.75);
    const cheap = toCall <= Math.max(Math.floor(me.stack / 4), state.settings.bigBlind * 3);
    if (equity >= potOdds * 0.7 || (cheap && roll < 0.45)) return { type: 'call' };
    return { type: 'fold' };
  }

  if (level === 'strong') {
    // 強い：ポジションを考え、強い手は大きく、ときどきブラフ
    if (legal.canCheck) {
      if (strength > 0.75 && roll < 0.15) return { type: 'check' }; // スロープレイ
      if (strength > 0.3) return raise(strength > 0.6 ? 0.75 : 0.6);
      if (opponents <= 2 && !preflop && roll < 0.18) return raise(0.6); // ブラフ
      return { type: 'check' };
    }
    if (strength > valueRaise - 0.05) return raise(strength > valueRaise + 0.2 ? 1.0 : 0.75);
    if (equity >= potOdds) return { type: 'call' };
    if (opponents === 1 && state.street !== 'river' && toCall <= pot(state) / 2 && roll < 0.07) return raise(1.0);
    return { type: 'fold' };
  }

  // 普通：手札の強さとポットオッズで判断
  if (legal.canCheck) return strength > 0.35 ? raise(roll < 0.5 ? 0.5 : 0.75) : { type: 'check' };
  if (strength > valueRaise) return raise(1.0);
  if (equity >= potOdds + 0.03) return { type: 'call' };
  return foldOrCheck();
}
