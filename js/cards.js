// カードと乱数。カードは {r: 2〜14, s: 0〜3} のオブジェクト（JSON にそのまま保存できる）
// s: 0=♠ 1=♥ 2=♦ 3=♣ / r: 11=J 12=Q 13=K 14=A

export const SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'];
const RANK_SYMBOLS = { 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

export const rankSymbol = (r) => RANK_SYMBOLS[r] ?? String(r);
export const isRed = (card) => card.s === 1 || card.s === 2;
export const cardKey = (card) => card.r * 4 + card.s;
export const sameCard = (a, b) => a.r === b.r && a.s === b.s;
export const cardText = (card) => SUIT_SYMBOLS[card.s] + rankSymbol(card.r);

export function fullDeck() {
  const deck = [];
  for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) deck.push({ r, s });
  return deck;
}

/** テスト用："As Kd Th 9c" のような表記からカード配列を作る */
export function parseCards(text) {
  const rankMap = { T: 10, J: 11, Q: 12, K: 13, A: 14 };
  const suitMap = { s: 0, h: 1, d: 2, c: 3 };
  return text.trim().split(/\s+/).map((t) => {
    const r = rankMap[t[0].toUpperCase()] ?? Number(t[0]);
    const s = suitMap[t[1].toLowerCase()];
    if (!(r >= 2 && r <= 14) || s === undefined) throw new Error(`bad card ${t}`);
    return { r, s };
  });
}

/** 種（seed）付き乱数。テストで結果を再現するために使う（mulberry32） */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 0 以上 n 未満の整数 */
export const randInt = (rand, n) => Math.floor(rand() * n);

export function shuffle(array, rand = Math.random) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(rand, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
