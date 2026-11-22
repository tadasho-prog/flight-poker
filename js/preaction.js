// 先行予約（要件 U-15）。自分の番が来る前に選んでおき、番が来たら自動で実行する。

/** 予約の選択肢。toCall はいまコールに必要な額（0 なら誰も賭けていない） */
export function preActionOptions(toCall) {
  if (toCall > 0) {
    return [
      { type: 'fold', label: 'フォールド' },
      { type: 'call', label: 'コール', amount: toCall },
    ];
  }
  return [
    { type: 'checkfold', label: 'チェック／フォールド' },
    { type: 'check', label: 'チェック' },
  ];
}

/** 予約を作る（どのハンド・どのストリートで選んだかを覚えておく） */
export function makePreAction(option, handNumber, street) {
  return { type: option.type, amount: option.amount ?? 0, handNumber, street };
}

/**
 * 予約がまだ有効か。ストリートやハンドが変わった、コール額が変わった（誰かがレイズした）、
 * チェックの予約中に誰かがベットした、のどれかなら無効（取り消す）。
 */
export function isPreActionValid(pre, { handNumber, street, toCall }) {
  if (!pre) return false;
  if (pre.handNumber !== handNumber || pre.street !== street) return false;
  if (pre.type === 'call') return toCall === pre.amount;
  if (pre.type === 'check') return toCall === 0;
  return true; // fold / checkfold はどんな状況でも実行できる
}

/** 自分の番になったとき、予約から実際のアクションを決める。実行できなければ null */
export function resolvePreAction(pre, legal) {
  if (!pre || !legal) return null;
  switch (pre.type) {
    case 'fold':
      if (legal.canFold) return { type: 'fold' };
      return legal.canCheck ? { type: 'check' } : null;
    case 'call':
      return legal.callAmount > 0 ? { type: 'call' } : null;
    case 'checkfold':
      return legal.canCheck ? { type: 'check' } : { type: 'fold' };
    case 'check':
      return legal.canCheck ? { type: 'check' } : null;
    default:
      return null;
  }
}
