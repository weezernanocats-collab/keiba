/**
 * 馬券の的中判定ユーティリティ
 * history API と accuracy-stats API の両方で使用
 */
export function isBetHit(
  betType: string,
  selections: number[],
  top3: number[],
): boolean {
  if (selections.length === 0 || top3.length === 0) return false;
  const winner = top3[0];
  const top2 = top3.slice(0, 2);

  switch (betType) {
    case '単勝':
      return selections[0] === winner;
    case '複勝':
      return top3.includes(selections[0]);
    case '馬連':
      return selections.length >= 2 && top2.length >= 2 && selections.every(s => top2.includes(s));
    case 'ワイド':
      return selections.length >= 2 && selections.every(s => top3.includes(s));
    case '馬単':
      return selections.length >= 2 && top3.length >= 2 && selections[0] === top3[0] && selections[1] === top3[1];
    case '三連複':
      return selections.length >= 3 && top3.length >= 3 && selections.every(s => top3.includes(s));
    case '三連単':
      return selections.length >= 3 && top3.length >= 3 &&
        selections[0] === top3[0] && selections[1] === top3[1] && selections[2] === top3[2];
    default:
      return false;
  }
}
