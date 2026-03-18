import { describe, it, expect } from 'vitest';
import { isBetHit } from '@/lib/bet-utils';

describe('isBetHit', () => {
  // ==================== 単勝 ====================
  describe('単勝', () => {
    it('selections[0] が top3[0] (1着馬) と一致すれば true', () => {
      expect(isBetHit('単勝', [3], [3, 7, 1])).toBe(true);
    });

    it('selections[0] が 1着馬と異なれば false', () => {
      expect(isBetHit('単勝', [5], [3, 7, 1])).toBe(false);
    });
  });

  // ==================== 複勝 ====================
  describe('複勝', () => {
    it('selections[0] が top3 に含まれれば true', () => {
      expect(isBetHit('複勝', [7], [3, 7, 1])).toBe(true);
    });

    it('selections[0] が top3 に含まれなければ false (4着以下)', () => {
      expect(isBetHit('複勝', [9], [3, 7, 1])).toBe(false);
    });
  });

  // ==================== 馬連 ====================
  describe('馬連', () => {
    it('selections の2頭が両方 top2 に含まれれば true (順不同)', () => {
      // top2 = [3, 7]
      expect(isBetHit('馬連', [7, 3], [3, 7, 1])).toBe(true);
    });

    it('selections の2頭が両方 top2 に含まれれば true (正順)', () => {
      expect(isBetHit('馬連', [3, 7], [3, 7, 1])).toBe(true);
    });

    it('片方が top2 外の馬番なら false', () => {
      // 1 は3着なので top2 外
      expect(isBetHit('馬連', [3, 1], [3, 7, 1])).toBe(false);
    });

    it('両方とも top2 外なら false', () => {
      expect(isBetHit('馬連', [9, 5], [3, 7, 1])).toBe(false);
    });
  });

  // ==================== ワイド ====================
  describe('ワイド', () => {
    it('selections の2頭が両方 top3 に含まれれば true', () => {
      expect(isBetHit('ワイド', [3, 1], [3, 7, 1])).toBe(true);
    });

    it('selections の2頭のうち1頭が top3 外なら false', () => {
      expect(isBetHit('ワイド', [3, 9], [3, 7, 1])).toBe(false);
    });

    it('両方 top3 内でも 3頭目は OK', () => {
      expect(isBetHit('ワイド', [7, 1], [3, 7, 1])).toBe(true);
    });
  });

  // ==================== 馬単 ====================
  describe('馬単', () => {
    it('selections[0]=1着, selections[1]=2着 で true', () => {
      expect(isBetHit('馬単', [3, 7], [3, 7, 1])).toBe(true);
    });

    it('逆順 (selections[0]=2着, selections[1]=1着) なら false', () => {
      expect(isBetHit('馬単', [7, 3], [3, 7, 1])).toBe(false);
    });

    it('selections[0] が 1着でも selections[1] が 2着でなければ false', () => {
      expect(isBetHit('馬単', [3, 1], [3, 7, 1])).toBe(false);
    });
  });

  // ==================== 三連複 ====================
  describe('三連複', () => {
    it('selections の3頭が top3 と完全一致すれば true (順不同)', () => {
      expect(isBetHit('三連複', [1, 7, 3], [3, 7, 1])).toBe(true);
    });

    it('selections の3頭が top3 と順番通りでも true', () => {
      expect(isBetHit('三連複', [3, 7, 1], [3, 7, 1])).toBe(true);
    });

    it('1頭でも top3 外なら false', () => {
      expect(isBetHit('三連複', [3, 7, 9], [3, 7, 1])).toBe(false);
    });
  });

  // ==================== 三連単 ====================
  describe('三連単', () => {
    it('selections が [1着, 2着, 3着] と完全一致すれば true', () => {
      expect(isBetHit('三連単', [3, 7, 1], [3, 7, 1])).toBe(true);
    });

    it('着順が異なれば false (1着・2着が逆)', () => {
      expect(isBetHit('三連単', [7, 3, 1], [3, 7, 1])).toBe(false);
    });

    it('3着の順番が違えば false', () => {
      expect(isBetHit('三連単', [3, 1, 7], [3, 7, 1])).toBe(false);
    });
  });

  // ==================== エッジケース ====================
  describe('エッジケース', () => {
    it('空の selections で false', () => {
      expect(isBetHit('単勝', [], [3, 7, 1])).toBe(false);
    });

    it('未知の betType で false', () => {
      expect(isBetHit('枠連', [3, 7], [3, 7, 1])).toBe(false);
    });

    it('空の top3 で false', () => {
      expect(isBetHit('単勝', [3], [])).toBe(false);
    });
  });
});
