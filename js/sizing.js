// ベット・レイズ額のプリセットと、指数的なスライダー（要件 U-11, U-12）
import { legalActions, raiseToPotFraction, pot } from './game.js';

const round1000 = (v) => Math.round(v / 1000) * 1000;

/**
 * プリセット4つ。誰かが賭けていれば「2倍・3倍・ポット・オールイン」、
 * 誰も賭けていなければ「1/2ポット・2/3ポット・ポット・オールイン」。
 * どの額も「最小レイズ〜オールイン」の範囲に収める。レイズできなければ null。
 */
export function presets(state, playerId) {
  const legal = legalActions(state, playerId);
  if (!legal || !legal.canRaise) return null;
  const clamp = (v) => Math.min(Math.max(v, legal.minRaiseTo), legal.maxRaiseTo);
  const potAt = (f) => raiseToPotFraction(state, playerId, f);
  const list = state.currentBet > 0
    ? [['2倍', clamp(round1000(state.currentBet * 2))], ['3倍', clamp(round1000(state.currentBet * 3))], ['ポット', potAt(1)], ['オールイン', legal.maxRaiseTo]]
    : [['1/2ポット', potAt(0.5)], ['2/3ポット', potAt(2 / 3)], ['ポット', potAt(1)], ['オールイン', legal.maxRaiseTo]];
  return list.map(([label, amount]) => ({ label, amount }));
}

/** 自分の番になったときに最初に選ばれている額（プリフロップは 3倍、それ以外は1つ目） */
export function defaultAmount(state, list) {
  if (!list) return 0;
  return state.street === 'preflop' ? list[1].amount : list[0].amount;
}

/** スライダーの位置 t（0〜1）→ 額。左は細かく、右ほど大きく増える。右端はオールイン */
export function amountAt(t, min, max) {
  if (max <= min) return max;
  if (t >= 0.995) return max;
  const v = round1000(min * Math.pow(max / min, Math.max(0, t)));
  return Math.min(max, Math.max(min, v));
}

/** 額 → スライダーの位置（amountAt の逆） */
export function positionOf(amount, min, max) {
  if (max <= min || amount >= max) return 1;
  if (amount <= min) return 0;
  return Math.log(amount / min) / Math.log(max / min);
}

/** −／＋ボタンで動かす幅 */
export function stepFor(amount) {
  if (amount < 20000) return 1000;
  if (amount < 50000) return 2000;
  return 5000;
}

export function nudge(amount, dir, min, max) {
  const v = amount + dir * stepFor(dir > 0 ? amount : amount - 1);
  return Math.min(max, Math.max(min, v));
}

/** 目盛り用の短い表記（6000 → 6千、12000 → 1.2万、100000 → 10万） */
export function shortAmount(v) {
  if (v >= 10000) return `${Math.round(v / 1000) / 10}万`;
  return `${Math.round(v / 100) / 10}千`;
}

/** レイズボタンの補足（プリフロップは BB 換算、それ以降はポットに対する割合） */
export function raiseNote(state, amount) {
  if (state.street === 'preflop') return `${Math.round((amount / state.settings.bigBlind) * 10) / 10}BB`;
  const p = pot(state);
  return p > 0 ? `ポットの${Math.round((amount / p) * 100)}%` : '';
}
