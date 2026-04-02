"""
Round 2 (Fast): PairLogitPairwise is slow, so skip Optuna.
Test: 48feat+PairLogitPairwise, label variants, ensemble.

Usage: source .venv/bin/activate && python3 scripts/experiment_round2_fast.py
"""
import sys
import json
import numpy as np
from catboost import CatBoostRanker, Pool
from sklearn.metrics import ndcg_score
import time

# Force unbuffered output
sys.stdout.reconfigure(line_buffering=True)

MODEL_DIR = "model"
ODDS_FEATURES = {'oddsLogTransform', 'popularity', 'popularityRatio', 'relativeOdds', 'avgPastOdds'}
KEEP_20 = [
    'sireTrackWinRate', 'jockeyTrainerWinRate', 'age', 'grade_encoded',
    'relativePosition', 'lastRacePosition', 'distanceAptitude', 'jockeyXdistance',
    'handicapAdvantage', 'avgMarginWhenLosing', 'careerWinRate', 'standardTimeDev',
    'recentForm', 'upsetRate', 'rotation', 'last3PlaceRate', 'last3WinRate',
    'trackConditionAptitude', 'runningStyle', 'sex_encoded',
]

def load_data():
    with open(f'{MODEL_DIR}/training_data.json') as f:
        data = json.load(f)
    return data['feature_names'], data['rows']

def build_groups(race_ids, indices):
    si = sorted(indices, key=lambda i: race_ids[i])
    gs, ordered, prev, c = [], [], None, 0
    for i in si:
        if race_ids[i] != prev:
            if c > 0: gs.append(c)
            prev = race_ids[i]; c = 0
        ordered.append(i); c += 1
    if c > 0: gs.append(c)
    return ordered, gs

def make_qids(gs):
    q = []
    for i, g in enumerate(gs): q.extend([i] * int(g))
    return q

def compute_weights(positions, odds, ordered, groups, recency):
    weights = []
    offset = 0
    for g in groups:
        g = int(g)
        g_odds = odds[ordered[offset:offset+g]]
        g_pos = positions[ordered[offset:offset+g]]
        g_rec = recency[ordered[offset:offset+g]]
        if np.any(g_odds > 0):
            wi = np.where(g_pos == 1)[0]
            w = min(np.log1p(g_odds[wi[0]]), 5.0)/2.0 if len(wi) > 0 and g_odds[wi[0]] > 0 else 1.0
        else: w = 1.0
        w *= float(np.mean(g_rec))
        weights.append(w); offset += g
    return np.array(weights, dtype=np.float32)

def expand_weights(groups, gw):
    sw = []
    for i, g in enumerate(groups): sw.extend([gw[i]] * int(g))
    return np.array(sw, dtype=np.float32)

def split_groups(arr, gs):
    r, o = [], 0
    for g in gs: g = int(g); r.append(arr[o:o+g].tolist()); o += g
    return r

def ndcg1(yt_g, yp_g):
    return np.mean([ndcg_score([yt], [yp], k=1) for yt, yp in zip(yt_g, yp_g) if len(yt) >= 2])

def topk(yt_g, yp_g, k=1):
    h, t = 0, 0
    for yt, yp in zip(yt_g, yp_g):
        if len(yt) < 2: continue
        t += 1
        top = sorted(range(len(yp)), key=lambda i: yp[i], reverse=True)[:k]
        if np.argmax(yt) in top: h += 1
    return h / t if t > 0 else 0

def eval_preds(y_o, pred, gs):
    yg = split_groups(y_o, gs); pg = split_groups(pred, gs)
    return {'ndcg1': ndcg1(yg, pg), 'top1': topk(yg, pg, 1), 'top3': topk(yg, pg, 3)}

def train_model(X_tr, y_tr, tr_g, sw, X_va, y_va, va_g, loss='YetiRank'):
    params = {
        'iterations': 1500, 'depth': 6, 'learning_rate': 0.02,
        'l2_leaf_reg': 3.0, 'bagging_temperature': 0.8, 'random_strength': 0.5,
        'border_count': 128, 'min_data_in_leaf': 1,
        'loss_function': loss, 'eval_metric': 'NDCG:top=1',
        'random_seed': 42, 'verbose': 0, 'early_stopping_rounds': 75,
    }
    tr_pool = Pool(data=X_tr, label=y_tr, group_id=make_qids(tr_g), weight=sw)
    va_pool = Pool(data=X_va, label=y_va, group_id=make_qids(va_g))
    model = CatBoostRanker(**params)
    model.fit(tr_pool, eval_set=va_pool)
    return model

def main():
    print("=" * 60)
    print("Round 2 (Fast): Key combinations + Ensemble")
    print("=" * 60)

    feature_names, rows = load_data()
    X_all = np.array([r['features'] for r in rows], dtype=np.float32)
    race_ids = [r['race_id'] for r in rows]
    positions = np.array([r['position'] for r in rows], dtype=np.int32)
    odds_data = np.array([r.get('odds') or 0 for r in rows], dtype=np.float32)
    recency = np.array([r.get('recency_weight', 1.0) for r in rows], dtype=np.float32)

    rel3 = lambda p: 3 if p==1 else 2 if p==2 else 1 if p==3 else 0
    rel5 = lambda p: 5 if p==1 else 4 if p==2 else 3 if p==3 else 2 if p==4 else 1 if p==5 else 0
    rel_exp = lambda p: 2**(max(0,4-p)) if p<=4 else 0

    y3 = np.array([rel3(p) for p in positions], dtype=np.float32)
    y5 = np.array([rel5(p) for p in positions], dtype=np.float32)
    y_exp = np.array([rel_exp(p) for p in positions], dtype=np.float32)

    sorted_idx = sorted(range(len(race_ids)), key=lambda i: race_ids[i])
    s1, s2 = int(len(sorted_idx)*0.70), int(len(sorted_idx)*0.85)
    train_idx, val_idx, test_idx = sorted_idx[:s1], sorted_idx[s1:s2], sorted_idx[s2:]

    noOdds_idx = [i for i, fn in enumerate(feature_names) if fn not in ODDS_FEATURES]
    keep20_idx = [feature_names.index(fn) for fn in KEEP_20 if fn in feature_names]
    X48 = X_all[:, noOdds_idx]
    X20 = X_all[:, keep20_idx]

    tr_o, tr_g = build_groups(race_ids, train_idx)
    va_o, va_g = build_groups(race_ids, val_idx)
    te_o, te_g = build_groups(race_ids, test_idx)

    tw = compute_weights(positions, odds_data, tr_o, tr_g, recency)
    sw = expand_weights(tr_g, tw)
    sw1 = np.ones_like(sw)

    results = []

    # [A] 48feat + YetiRank (baseline comparison)
    print("\n[A] 48feat + YetiRank")
    t0 = time.time()
    m_yr48 = train_model(X48[tr_o], y3[tr_o], tr_g, sw, X48[va_o], y3[va_o], va_g, 'YetiRank')
    va_pred_yr48 = m_yr48.predict(Pool(data=X48[va_o], group_id=make_qids(va_g)))
    te_pred_yr48 = m_yr48.predict(Pool(data=X48[te_o], group_id=make_qids(te_g)))
    te_m = eval_preds(y3[te_o], te_pred_yr48, te_g)
    elapsed = time.time()-t0
    results.append(('48feat YetiRank', te_m, elapsed))
    print(f"  NDCG@1={te_m['ndcg1']:.4f} Top-1={te_m['top1']:.4f} Top-3={te_m['top3']:.4f} ({elapsed:.0f}s)")

    # [B] 48feat + PairLogitPairwise
    print("\n[B] 48feat + PairLogitPairwise")
    t0 = time.time()
    m_plp48 = train_model(X48[tr_o], y3[tr_o], tr_g, sw1, X48[va_o], y3[va_o], va_g, 'PairLogitPairwise')
    va_pred_plp48 = m_plp48.predict(Pool(data=X48[va_o], group_id=make_qids(va_g)))
    te_pred_plp48 = m_plp48.predict(Pool(data=X48[te_o], group_id=make_qids(te_g)))
    te_m = eval_preds(y3[te_o], te_pred_plp48, te_g)
    elapsed = time.time()-t0
    results.append(('48feat PairLogitPw', te_m, elapsed))
    print(f"  NDCG@1={te_m['ndcg1']:.4f} Top-1={te_m['top1']:.4f} Top-3={te_m['top3']:.4f} ({elapsed:.0f}s)")

    # [C] 48feat + YetiRank + 5-level labels
    print("\n[C] 48feat YetiRank + 5-level labels")
    t0 = time.time()
    m_yr5 = train_model(X48[tr_o], y5[tr_o], tr_g, sw, X48[va_o], y5[va_o], va_g, 'YetiRank')
    te_pred_yr5 = m_yr5.predict(Pool(data=X48[te_o], group_id=make_qids(te_g)))
    te_m = eval_preds(y3[te_o], te_pred_yr5, te_g)
    elapsed = time.time()-t0
    results.append(('48feat YetiRank rel5', te_m, elapsed))
    print(f"  NDCG@1={te_m['ndcg1']:.4f} Top-1={te_m['top1']:.4f} Top-3={te_m['top3']:.4f} ({elapsed:.0f}s)")

    # [D] 48feat + YetiRank + exponential labels
    print("\n[D] 48feat YetiRank + exp labels")
    t0 = time.time()
    m_yre = train_model(X48[tr_o], y_exp[tr_o], tr_g, sw, X48[va_o], y_exp[va_o], va_g, 'YetiRank')
    va_pred_yre = m_yre.predict(Pool(data=X48[va_o], group_id=make_qids(va_g)))
    te_pred_yre = m_yre.predict(Pool(data=X48[te_o], group_id=make_qids(te_g)))
    te_m = eval_preds(y3[te_o], te_pred_yre, te_g)
    elapsed = time.time()-t0
    results.append(('48feat YetiRank exp', te_m, elapsed))
    print(f"  NDCG@1={te_m['ndcg1']:.4f} Top-1={te_m['top1']:.4f} Top-3={te_m['top3']:.4f} ({elapsed:.0f}s)")

    # [E] Ensemble: YetiRank + PairLogitPairwise (48feat)
    print("\n[E] Ensemble: YetiRank + PairLogitPw (48feat)")
    best_alpha, best_vn = 0.5, 0
    for alpha in np.arange(0.0, 1.05, 0.05):
        bl = alpha * va_pred_yr48 + (1-alpha) * va_pred_plp48
        vm = eval_preds(y3[va_o], bl, va_g)
        if vm['ndcg1'] > best_vn: best_vn = vm['ndcg1']; best_alpha = alpha

    bl_te = best_alpha * te_pred_yr48 + (1-best_alpha) * te_pred_plp48
    te_m = eval_preds(y3[te_o], bl_te, te_g)
    results.append((f'Ensemble YR+PLP α={best_alpha:.2f}', te_m, 0))
    print(f"  α={best_alpha:.2f} NDCG@1={te_m['ndcg1']:.4f} Top-1={te_m['top1']:.4f} Top-3={te_m['top3']:.4f}")

    # [F] 3-model ensemble: YetiRank + PairLogitPw + YetiRank(exp)
    print("\n[F] 3-model ensemble: YR + PLP + YR(exp)")
    best_w, best_vn3 = (0.33, 0.33, 0.34), 0
    for a in np.arange(0, 1.05, 0.1):
        for b in np.arange(0, 1.05-a, 0.1):
            c = 1.0 - a - b
            if c < 0: continue
            bl = a * va_pred_yr48 + b * va_pred_plp48 + c * va_pred_yre
            vm = eval_preds(y3[va_o], bl, va_g)
            if vm['ndcg1'] > best_vn3: best_vn3 = vm['ndcg1']; best_w = (a, b, c)

    a, b, c = best_w
    bl_te3 = a * te_pred_yr48 + b * te_pred_plp48 + c * te_pred_yre
    te_m = eval_preds(y3[te_o], bl_te3, te_g)
    results.append((f'3-Ensemble ({a:.1f}/{b:.1f}/{c:.1f})', te_m, 0))
    print(f"  w=({a:.1f},{b:.1f},{c:.1f}) NDCG@1={te_m['ndcg1']:.4f} Top-1={te_m['top1']:.4f} Top-3={te_m['top3']:.4f}")

    # [G] 20feat + PairLogitPairwise (Round 1 winner, for reference)
    print("\n[G] 20feat + PairLogitPairwise")
    t0 = time.time()
    m_plp20 = train_model(X20[tr_o], y3[tr_o], tr_g, sw1, X20[va_o], y3[va_o], va_g, 'PairLogitPairwise')
    te_pred_plp20 = m_plp20.predict(Pool(data=X20[te_o], group_id=make_qids(te_g)))
    te_m = eval_preds(y3[te_o], te_pred_plp20, te_g)
    elapsed = time.time()-t0
    results.append(('20feat PairLogitPw', te_m, elapsed))
    print(f"  NDCG@1={te_m['ndcg1']:.4f} Top-1={te_m['top1']:.4f} Top-3={te_m['top3']:.4f} ({elapsed:.0f}s)")

    # [H] Ensemble: 20feat PLP + 48feat YR
    print("\n[H] Ensemble: 20feat PLP + 48feat YR")
    best_alpha2, best_vn2 = 0.5, 0
    for alpha in np.arange(0.0, 1.05, 0.05):
        bl = alpha * va_pred_yr48 + (1-alpha) * m_plp20.predict(Pool(data=X20[va_o], group_id=make_qids(va_g)))
        vm = eval_preds(y3[va_o], bl, va_g)
        if vm['ndcg1'] > best_vn2: best_vn2 = vm['ndcg1']; best_alpha2 = alpha

    va_pred_plp20 = m_plp20.predict(Pool(data=X20[va_o], group_id=make_qids(va_g)))
    bl_te2 = best_alpha2 * te_pred_yr48 + (1-best_alpha2) * te_pred_plp20
    te_m = eval_preds(y3[te_o], bl_te2, te_g)
    results.append((f'Ens 48YR+20PLP α={best_alpha2:.2f}', te_m, 0))
    print(f"  α={best_alpha2:.2f} NDCG@1={te_m['ndcg1']:.4f} Top-1={te_m['top1']:.4f} Top-3={te_m['top3']:.4f}")

    # Summary
    print("\n" + "=" * 70)
    print("RESULTS SUMMARY")
    print("=" * 70)
    print(f"{'Approach':<35} {'NDCG@1':>7} {'Top-1':>7} {'Top-3':>7} {'Time':>6}")
    print("-" * 65)
    print(f"{'Baseline (20feat YetiRank)':<35} {'0.4060':>7} {'0.2301':>7} {'0.5178':>7} {'3s':>6}")
    for name, m, t in results:
        print(f"{name:<35} {m['ndcg1']:>7.4f} {m['top1']:>7.4f} {m['top3']:>7.4f} {f'{t:.0f}s' if t > 0 else '-':>6}")

    best = max(results, key=lambda x: x[1]['ndcg1'])
    d_ndcg = best[1]['ndcg1'] - 0.4060
    d_top1 = best[1]['top1'] - 0.2301
    print(f"\n★ Best: {best[0]}")
    print(f"  NDCG@1: 0.4060 → {best[1]['ndcg1']:.4f} ({d_ndcg:+.4f}, {d_ndcg/0.4060*100:+.1f}%)")
    print(f"  Top-1:  0.2301 → {best[1]['top1']:.4f} ({d_top1:+.4f}, {d_top1/0.2301*100:+.1f}%)")

if __name__ == '__main__':
    main()
