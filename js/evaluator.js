// 役判定
// evaluate(): 画面表示・勝敗判定用（役名と役を作る5枚を返す）
// score():    CPU の勝率計算用の高速版（強さを1つの整数で返す。evaluate と同じ順序になることをテストで確認）

export const CATEGORY = {
  HIGH_CARD: 0, ONE_PAIR: 1, TWO_PAIR: 2, THREE: 3, STRAIGHT: 4,
  FLUSH: 5, FULL_HOUSE: 6, FOUR: 7, STRAIGHT_FLUSH: 8,
};

const CATEGORY_NAMES = [
  'ハイカード', 'ワンペア', 'ツーペア', 'スリーカード', 'ストレート',
  'フラッシュ', 'フルハウス', 'フォーカード', 'ストレートフラッシュ',
];

export function handName(value) {
  if (value.category === CATEGORY.STRAIGHT_FLUSH && value.tiebreakers[0] === 14) return 'ロイヤルフラッシュ';
  return CATEGORY_NAMES[value.category];
}

/** 役の強さを比べる（a が強ければ正、同じなら 0、弱ければ負） */
export function compareValues(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  const n = Math.max(a.tiebreakers.length, b.tiebreakers.length);
  for (let i = 0; i < n; i++) {
    const d = (a.tiebreakers[i] ?? 0) - (b.tiebreakers[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 5〜7枚から一番強い5枚の役を返す */
export function evaluate(cards) {
  if (cards.length < 5 || cards.length > 7) throw new Error('5〜7枚で評価する');
  if (cards.length === 5) return evaluateFive(cards);
  let best = null;
  const n = cards.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++)
    for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
      const v = evaluateFive([cards[a], cards[b], cards[c], cards[d], cards[e]]);
      if (best === null || compareValues(v, best) > 0) best = v;
    }
  return best;
}

function evaluateFive(cards) {
  const sorted = cards.slice().sort((x, y) => y.r - x.r);
  const ranks = sorted.map((c) => c.r);
  const isFlush = cards.every((c) => c.s === cards[0].s);

  const unique = [...new Set(ranks)].sort((x, y) => y - x);
  let straightHigh = null;
  if (unique.length === 5) {
    if (unique[0] - unique[4] === 4) straightHigh = unique[0];
    else if (unique.join() === '14,5,4,3,2') straightHigh = 5; // A-2-3-4-5 は 5 ハイ
  }

  // 同じランクの枚数でグループ化：枚数の多い順 → ランクの高い順
  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = [...counts.entries()].sort((x, y) => y[1] - x[1] || y[0] - x[0]);
  const groupRanks = groups.map((g) => g[0]);
  const pattern = groups.map((g) => g[1]).join('');

  const ordered = (order) => order.flatMap((r) => sorted.filter((c) => c.r === r));
  const straightOrder = (high) => ordered(high === 5 ? [5, 4, 3, 2, 14] : [high, high - 1, high - 2, high - 3, high - 4]);
  const make = (category, tiebreakers, bestFive) => {
    const v = { category, tiebreakers, bestFive };
    v.name = handName(v);
    return v;
  };

  if (straightHigh !== null && isFlush) return make(CATEGORY.STRAIGHT_FLUSH, [straightHigh], straightOrder(straightHigh));
  if (pattern === '41') return make(CATEGORY.FOUR, groupRanks, ordered(groupRanks));
  if (pattern === '32') return make(CATEGORY.FULL_HOUSE, groupRanks, ordered(groupRanks));
  if (isFlush) return make(CATEGORY.FLUSH, ranks, sorted);
  if (straightHigh !== null) return make(CATEGORY.STRAIGHT, [straightHigh], straightOrder(straightHigh));
  if (pattern === '311') return make(CATEGORY.THREE, groupRanks, ordered(groupRanks));
  if (pattern === '221') return make(CATEGORY.TWO_PAIR, groupRanks, ordered(groupRanks));
  if (pattern === '2111') return make(CATEGORY.ONE_PAIR, groupRanks, ordered(groupRanks));
  return make(CATEGORY.HIGH_CARD, ranks, sorted);
}

// ---- 高速版 ----
// 値の形：category * 2^20 + 役の中身とキッカーを 4 ビットずつ（上位から）

function straightHighOf(mask) {
  let m = mask;
  if (m & (1 << 14)) m |= 1 << 1; // A を 1 としても使う
  for (let high = 14; high >= 5; high--) {
    if (((m >> (high - 4)) & 0x1f) === 0x1f) return high;
  }
  return 0;
}

/** マスクの上位 n ランクを 4 ビットずつ詰めた値（n×4 ビット） */
function topRanks(mask, n) {
  let result = 0;
  let taken = 0;
  for (let r = 14; r >= 2 && taken < n; r--) {
    if (mask & (1 << r)) { result = (result << 4) | r; taken++; }
  }
  return result << (4 * (n - taken));
}

const C = (category) => category * 1048576; // << 20（掛け算にして符号の問題を避ける）

export function score(cards) {
  const counts = new Array(15).fill(0);
  let mask = 0;
  const suitMask = [0, 0, 0, 0];
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    counts[c.r]++;
    mask |= 1 << c.r;
    suitMask[c.s] |= 1 << c.r;
  }
  let flushMask = 0;
  for (let s = 0; s < 4; s++) {
    if (popcount(suitMask[s]) >= 5) { flushMask = suitMask[s]; break; }
  }
  if (flushMask) {
    const h = straightHighOf(flushMask);
    if (h) return C(CATEGORY.STRAIGHT_FLUSH) + (h << 16);
  }

  let quad = 0, trip1 = 0, trip2 = 0, pair1 = 0, pair2 = 0;
  for (let r = 14; r >= 2; r--) {
    const n = counts[r];
    if (n === 4) quad = r;
    else if (n === 3) { if (!trip1) trip1 = r; else if (!trip2) trip2 = r; }
    else if (n === 2) { if (!pair1) pair1 = r; else if (!pair2) pair2 = r; }
  }

  if (quad) return C(CATEGORY.FOUR) + (quad << 16) + (topRanks(mask & ~(1 << quad), 1) << 12);
  if (trip1 && (trip2 || pair1)) return C(CATEGORY.FULL_HOUSE) + (trip1 << 16) + (Math.max(trip2, pair1) << 12);
  if (flushMask) return C(CATEGORY.FLUSH) + topRanks(flushMask, 5);
  const sh = straightHighOf(mask);
  if (sh) return C(CATEGORY.STRAIGHT) + (sh << 16);
  if (trip1) return C(CATEGORY.THREE) + (trip1 << 16) + (topRanks(mask & ~(1 << trip1), 2) << 8);
  if (pair1 && pair2) {
    return C(CATEGORY.TWO_PAIR) + (pair1 << 16) + (pair2 << 12) + (topRanks(mask & ~(1 << pair1) & ~(1 << pair2), 1) << 8);
  }
  if (pair1) return C(CATEGORY.ONE_PAIR) + (pair1 << 16) + (topRanks(mask & ~(1 << pair1), 3) << 4);
  return C(CATEGORY.HIGH_CARD) + topRanks(mask, 5);
}

function popcount(x) {
  let n = 0;
  while (x) { x &= x - 1; n++; }
  return n;
}

// ---- 表示用 ----
const RANK_NAME = (r) => ({ 14: 'A', 13: 'K', 12: 'Q', 11: 'J' }[r] ?? String(r));

/** 役の詳しい説明（要件 U-16）。例：「Jのペア」「Aハイ」「KとJのツーペア」 */
export function describeHand(value) {
  const [a, b] = value.tiebreakers;
  switch (value.category) {
    case CATEGORY.HIGH_CARD: return `${RANK_NAME(a)}ハイ`;
    case CATEGORY.ONE_PAIR: return `${RANK_NAME(a)}のペア`;
    case CATEGORY.TWO_PAIR: return `${RANK_NAME(a)}と${RANK_NAME(b)}のツーペア`;
    case CATEGORY.THREE: return `${RANK_NAME(a)}のスリーカード`;
    case CATEGORY.STRAIGHT: return `${RANK_NAME(a)}ハイ`;
    case CATEGORY.FLUSH: return `${RANK_NAME(a)}ハイ`;
    case CATEGORY.FULL_HOUSE: return `${RANK_NAME(a)}の3枚と${RANK_NAME(b)}の2枚`;
    case CATEGORY.FOUR: return `${RANK_NAME(a)}のフォーカード`;
    case CATEGORY.STRAIGHT_FLUSH: return a === 14 ? '' : `${RANK_NAME(a)}ハイ`;
    default: return '';
  }
}

/** 役名＋説明（例：「フラッシュ（Aハイ）」） */
export function handLabel(value) {
  const d = describeHand(value);
  return d ? `${value.name}（${d}）` : value.name;
}

/** 役を作っているカード（キッカーを除く）。強調表示に使う */
export function madeCards(value) {
  const count = {
    [CATEGORY.HIGH_CARD]: 0, [CATEGORY.ONE_PAIR]: 2, [CATEGORY.TWO_PAIR]: 4, [CATEGORY.THREE]: 3,
    [CATEGORY.STRAIGHT]: 5, [CATEGORY.FLUSH]: 5, [CATEGORY.FULL_HOUSE]: 5, [CATEGORY.FOUR]: 4, [CATEGORY.STRAIGHT_FLUSH]: 5,
  }[value.category];
  return value.bestFive.slice(0, count);
}
