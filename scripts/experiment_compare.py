"""
No-Odds Model Improvement: Multi-Approach Comparison

5つのアプローチをTest NDCGで比較し、最も有効な改善策を特定する。
Usage: source .venv/bin/activate && python3 scripts/experiment_compare.py
"""

import json
import numpy as np
from catboost import CatBoostRanker, Pool
from sklearn.metrics import ndcg_score
import time

MODEL_DIR = "model"

# Current 20 no-odds features
KEEP_20 = [
    'sireTrackWinRate', 'jockeyTrainerWinRate', 'age', 'grade_encoded',
    'relativePosition', 'lastRacePosition', 'distanceAptitude', 'jockeyXdistance',
    'handicapAdvantage', 'avgMarginWhenLosing', 'careerWinRate', 'standardTimeDev',
    'recentForm', 'upsetRate', 'rotation', 'last3PlaceRate', 'last3WinRate',
    'trackConditionAptitude', 'runningStyle', 'sex_encoded',
]

# All non-odds features (48)
ODDS_FEATURES = {'oddsLogTransform', 'popularity', 'popularityRatio', 'relativeOdds', 'avgPastOdds'}


def load_data():
    with open(f'{MODEL_DIR}/training_data.json') as f:
        data = json.load(f)
    feature_names = data['feature_names']
    rows = data['rows']
    return feature_names, rows


def rel(p):
    return 3 if p == 1 else 2 if p == 2 else 1 if p == 3 else 0


def build_groups(race_ids, indices):
    si = sorted(indices, key=lambda i: race_ids[i])
    gs, ordered, prev, c = [], [], None, 0
    for i in si:
        if race_ids[i] != prev:
            if c > 0:
                gs.append(c)
            prev = race_ids[i]
            c = 0
        ordered.append(i)
        c += 1
    if c > 0:
        gs.append(c)
    return ordered, gs


def make_qids(gs):
    q = []
    for i, g in enumerate(gs):
        q.extend([i] * int(g))
    return q


def compute_weights(positions, odds, ordered, groups, recency):
    weights = []
    offset = 0
    for g in groups:
        g = int(g)
        g_odds = odds[ordered[offset:offset + g]]
        g_pos = positions[ordered[offset:offset + g]]
        g_rec = recency[ordered[offset:offset + g]]
        if np.any(g_odds > 0):
            winner_idx = np.where(g_pos == 1)[0]
            if len(winner_idx) > 0 and g_odds[winner_idx[0]] > 0:
                w = min(np.log1p(g_odds[winner_idx[0]]), 5.0) / 2.0
            else:
                w = 1.0
        else:
            w = 1.0
        w *= float(np.mean(g_rec))
        weights.append(w)
        offset += g
    return np.array(weights, dtype=np.float32)


def expand_weights(groups, group_weights):
    sw = []
    for i, g in enumerate(groups):
        sw.extend([group_weights[i]] * int(g))
    return np.array(sw, dtype=np.float32)


def split_groups(arr, gs):
    r, o = [], 0
    for g in gs:
        g = int(g)
        r.append(arr[o:o + g].tolist())
        o += g
    return r


def ndcg1(yt_g, yp_g):
    return np.mean([ndcg_score([yt], [yp], k=1) for yt, yp in zip(yt_g, yp_g) if len(yt) >= 2])


def topk(yt_g, yp_g, k=1):
    h, t = 0, 0
    for yt, yp in zip(yt_g, yp_g):
        if len(yt) < 2:
            continue
        t += 1
        top_pred = sorted(range(len(yp)), key=lambda i: yp[i], reverse=True)[:k]
        if np.argmax(yt) in top_pred:
            h += 1
    return h / t if t > 0 else 0


def train_and_eval(X_tr, y_tr, tr_groups, sw, X_va, y_va, va_groups,
                   X_te, y_te, te_groups, loss='YetiRank', params_override=None):
    """Train a model and return val/test metrics."""
    params = {
        'iterations': 1500,
        'depth': 6,
        'learning_rate': 0.02,
        'l2_leaf_reg': 3.0,
        'bagging_temperature': 0.8,
        'random_strength': 0.5,
        'border_count': 128,
        'min_data_in_leaf': 1,
        'loss_function': loss,
        'eval_metric': 'NDCG:top=1',
        'random_seed': 42,
        'verbose': 0,
        'early_stopping_rounds': 75,
    }
    if params_override:
        params.update(params_override)

    tr_pool = Pool(data=X_tr, label=y_tr, group_id=make_qids(tr_groups), weight=sw)
    va_pool = Pool(data=X_va, label=y_va, group_id=make_qids(va_groups))

    model = CatBoostRanker(**params)
    model.fit(tr_pool, eval_set=va_pool)

    iters = model.get_best_iteration()
    results = {'iters': iters}

    for label, X_eval, y_eval, gs in [('val', X_va, y_va, va_groups), ('test', X_te, y_te, te_groups)]:
        pool = Pool(data=X_eval, group_id=make_qids(gs))
        pred = model.predict(pool)
        yg = split_groups(y_eval, gs)
        pg = split_groups(pred, gs)
        results[f'{label}_ndcg1'] = ndcg1(yg, pg)
        results[f'{label}_top1'] = topk(yg, pg, 1)
        results[f'{label}_top3'] = topk(yg, pg, 3)

    return results, model


def extract_race_id_features(race_ids):
    """Extract month, venue, race_number from race_id (YYYYMMDDVVRR)."""
    months = []
    venues = []
    race_nums = []
    for rid in race_ids:
        s = str(rid)
        months.append(int(s[4:6]))
        venues.append(int(s[8:10]))
        race_nums.append(int(s[10:12]))
    return np.array(months, dtype=np.float32), np.array(venues, dtype=np.float32), np.array(race_nums, dtype=np.float32)


def main():
    print("=" * 60)
    print("No-Odds Model: Multi-Approach Comparison")
    print("=" * 60)

    feature_names, rows = load_data()
    print(f"Total samples: {len(rows)}, Features: {len(feature_names)}")

    # Prepare data
    X_all = np.array([r['features'] for r in rows], dtype=np.float32)
    race_ids = [r['race_id'] for r in rows]
    positions = np.array([r['position'] for r in rows], dtype=np.int32)
    odds_data = np.array([r.get('odds') or 0 for r in rows], dtype=np.float32)
    recency = np.array([r.get('recency_weight', 1.0) for r in rows], dtype=np.float32)
    track_types = np.array([r.get('track_type_encoded', 0) for r in rows], dtype=np.int32)
    distances = np.array([r.get('distance_val', 0) for r in rows], dtype=np.float32)
    y = np.array([rel(p) for p in positions], dtype=np.float32)

    # Time-series split
    sorted_idx = sorted(range(len(race_ids)), key=lambda i: race_ids[i])
    s1 = int(len(sorted_idx) * 0.70)
    s2 = int(len(sorted_idx) * 0.85)
    train_idx, val_idx, test_idx = sorted_idx[:s1], sorted_idx[s1:s2], sorted_idx[s2:]

    # Feature subsets
    keep20_indices = [feature_names.index(fn) for fn in KEEP_20 if fn in feature_names]
    noOdds_indices = [i for i, fn in enumerate(feature_names) if fn not in ODDS_FEATURES]

    # Race ID features
    months, venues, race_nums = extract_race_id_features(race_ids)

    results_table = []

    # ============================================================
    # Experiment 1: Baseline (20 features, YetiRank)
    # ============================================================
    print("\n[1/7] Baseline: 20 features + YetiRank")
    t0 = time.time()
    X20 = X_all[:, keep20_indices]
    tr_o, tr_g = build_groups(race_ids, train_idx)
    va_o, va_g = build_groups(race_ids, val_idx)
    te_o, te_g = build_groups(race_ids, test_idx)
    tw = compute_weights(positions, odds_data, tr_o, tr_g, recency)
    sw = expand_weights(tr_g, tw)

    res, _ = train_and_eval(
        X20[tr_o], y[tr_o], tr_g, sw,
        X20[va_o], y[va_o], va_g,
        X20[te_o], y[te_o], te_g,
        loss='YetiRank'
    )
    elapsed = time.time() - t0
    results_table.append(('Baseline (20feat, YetiRank)', res, elapsed))
    print(f"  Val NDCG@1={res['val_ndcg1']:.4f}  Test NDCG@1={res['test_ndcg1']:.4f}  "
          f"Top-1={res['test_top1']:.4f}  iters={res['iters']}  ({elapsed:.0f}s)")

    # ============================================================
    # Experiment 2: Loss function alternatives
    # ============================================================
    for loss_name in ['YetiRankPairwise', 'PairLogit', 'PairLogitPairwise']:
        print(f"\n[2] Loss: {loss_name}")
        t0 = time.time()
        # Pairwise losses don't support object weights - use uniform weights
        sw_uniform = np.ones_like(sw)
        try:
            res, _ = train_and_eval(
                X20[tr_o], y[tr_o], tr_g, sw_uniform if 'Pair' in loss_name else sw,
                X20[va_o], y[va_o], va_g,
                X20[te_o], y[te_o], te_g,
                loss=loss_name
            )
        except Exception as e:
            print(f"  SKIPPED: {e}")
            continue
        elapsed = time.time() - t0
        results_table.append((f'20feat + {loss_name}', res, elapsed))
        print(f"  Val NDCG@1={res['val_ndcg1']:.4f}  Test NDCG@1={res['test_ndcg1']:.4f}  "
              f"Top-1={res['test_top1']:.4f}  iters={res['iters']}  ({elapsed:.0f}s)")

    # ============================================================
    # Experiment 3: All 48 non-odds features
    # ============================================================
    print("\n[3] All 48 non-odds features + YetiRank")
    t0 = time.time()
    X48 = X_all[:, noOdds_indices]
    res, _ = train_and_eval(
        X48[tr_o], y[tr_o], tr_g, sw,
        X48[va_o], y[va_o], va_g,
        X48[te_o], y[te_o], te_g,
        loss='YetiRank'
    )
    elapsed = time.time() - t0
    results_table.append(('48feat + YetiRank', res, elapsed))
    print(f"  Val NDCG@1={res['val_ndcg1']:.4f}  Test NDCG@1={res['test_ndcg1']:.4f}  "
          f"Top-1={res['test_top1']:.4f}  iters={res['iters']}  ({elapsed:.0f}s)")

    # ============================================================
    # Experiment 4: 20 features + race_id features (month, venue, race_num)
    # ============================================================
    print("\n[4] 20feat + race_id features (month, venue, race_num)")
    t0 = time.time()
    X20_extra = np.column_stack([X20, months.reshape(-1, 1), venues.reshape(-1, 1), race_nums.reshape(-1, 1)])
    res, _ = train_and_eval(
        X20_extra[tr_o], y[tr_o], tr_g, sw,
        X20_extra[va_o], y[va_o], va_g,
        X20_extra[te_o], y[te_o], te_g,
        loss='YetiRank'
    )
    elapsed = time.time() - t0
    results_table.append(('20feat + time/venue', res, elapsed))
    print(f"  Val NDCG@1={res['val_ndcg1']:.4f}  Test NDCG@1={res['test_ndcg1']:.4f}  "
          f"Top-1={res['test_top1']:.4f}  iters={res['iters']}  ({elapsed:.0f}s)")

    # ============================================================
    # Experiment 5: 48feat + race_id features
    # ============================================================
    print("\n[5] 48feat + race_id features")
    t0 = time.time()
    X48_extra = np.column_stack([X48, months.reshape(-1, 1), venues.reshape(-1, 1), race_nums.reshape(-1, 1)])
    res, _ = train_and_eval(
        X48_extra[tr_o], y[tr_o], tr_g, sw,
        X48_extra[va_o], y[va_o], va_g,
        X48_extra[te_o], y[te_o], te_g,
        loss='YetiRank'
    )
    elapsed = time.time() - t0
    results_table.append(('48feat + time/venue', res, elapsed))
    print(f"  Val NDCG@1={res['val_ndcg1']:.4f}  Test NDCG@1={res['test_ndcg1']:.4f}  "
          f"Top-1={res['test_top1']:.4f}  iters={res['iters']}  ({elapsed:.0f}s)")

    # ============================================================
    # Experiment 6: Category-specific models (20 features)
    # ============================================================
    print("\n[6] Category-specific models (20feat, YetiRank)")
    t0 = time.time()
    categories = {
        'turf_sprint': (0, 0, 1400),
        'turf_mile': (0, 1401, 1800),
        'turf_long': (0, 1801, 99999),
        'dirt_short': (1, 0, 1600),
        'dirt_long': (1, 1601, 99999),
    }

    # Assign category to each sample
    cat_labels = []
    for i in range(len(rows)):
        tt = track_types[i]
        d = distances[i]
        assigned = 'other'
        for cat_name, (ct, dmin, dmax) in categories.items():
            if tt == ct and dmin <= d <= dmax:
                assigned = cat_name
                break
        cat_labels.append(assigned)
    cat_labels = np.array(cat_labels)

    # For each category, train separate model and collect test predictions
    cat_test_ndcg1 = {}
    cat_test_top1 = {}
    all_test_yg = []
    all_test_pg = []

    for cat_name in categories:
        cat_mask = cat_labels == cat_name
        cat_indices = np.where(cat_mask)[0]

        cat_train = [i for i in cat_indices if i in set(train_idx)]
        cat_val = [i for i in cat_indices if i in set(val_idx)]
        cat_test = [i for i in cat_indices if i in set(test_idx)]

        if len(cat_train) < 500 or len(cat_val) < 100 or len(cat_test) < 100:
            print(f"  {cat_name}: skipped (insufficient data: tr={len(cat_train)}, va={len(cat_val)}, te={len(cat_test)})")
            continue

        c_tr_o, c_tr_g = build_groups(race_ids, cat_train)
        c_va_o, c_va_g = build_groups(race_ids, cat_val)
        c_te_o, c_te_g = build_groups(race_ids, cat_test)

        c_tw = compute_weights(positions, odds_data, c_tr_o, c_tr_g, recency)
        c_sw = expand_weights(c_tr_g, c_tw)

        c_res, c_model = train_and_eval(
            X20[c_tr_o], y[c_tr_o], c_tr_g, c_sw,
            X20[c_va_o], y[c_va_o], c_va_g,
            X20[c_te_o], y[c_te_o], c_te_g,
            loss='YetiRank'
        )
        cat_test_ndcg1[cat_name] = c_res['test_ndcg1']
        cat_test_top1[cat_name] = c_res['test_top1']

        # Collect for weighted average
        te_pool = Pool(data=X20[c_te_o], group_id=make_qids(c_te_g))
        pred = c_model.predict(te_pool)
        yg = split_groups(y[c_te_o], c_te_g)
        pg = split_groups(pred, c_te_g)
        all_test_yg.extend(yg)
        all_test_pg.extend(pg)

        print(f"  {cat_name}: Test NDCG@1={c_res['test_ndcg1']:.4f} Top-1={c_res['test_top1']:.4f} "
              f"(tr={len(cat_train)}, iters={c_res['iters']})")

    # Weighted average across categories
    if all_test_yg:
        combined_ndcg1 = ndcg1(all_test_yg, all_test_pg)
        combined_top1 = topk(all_test_yg, all_test_pg, 1)
        combined_top3 = topk(all_test_yg, all_test_pg, 3)
        elapsed = time.time() - t0
        cat_res = {
            'val_ndcg1': 0, 'test_ndcg1': combined_ndcg1,
            'test_top1': combined_top1, 'test_top3': combined_top3, 'iters': 0,
        }
        results_table.append(('Category-specific (20feat)', cat_res, elapsed))
        print(f"  Combined: Test NDCG@1={combined_ndcg1:.4f} Top-1={combined_top1:.4f} Top-3={combined_top3:.4f} ({elapsed:.0f}s)")

    # ============================================================
    # Experiment 7: Category-specific + best loss function
    # ============================================================
    # Find best loss from experiments 1-2
    best_loss = 'YetiRank'
    best_loss_ndcg = 0
    for name, res, _ in results_table[:3]:
        if res['test_ndcg1'] > best_loss_ndcg:
            best_loss_ndcg = res['test_ndcg1']
            best_loss = name.split('+ ')[-1] if '+ ' in name else 'YetiRank'

    print(f"\n[7] Category-specific + 48feat + race_id features")
    t0 = time.time()
    all_test_yg2 = []
    all_test_pg2 = []

    for cat_name in categories:
        cat_mask = cat_labels == cat_name
        cat_indices = np.where(cat_mask)[0]

        cat_train = [i for i in cat_indices if i in set(train_idx)]
        cat_val = [i for i in cat_indices if i in set(val_idx)]
        cat_test = [i for i in cat_indices if i in set(test_idx)]

        if len(cat_train) < 500 or len(cat_val) < 100 or len(cat_test) < 100:
            continue

        c_tr_o, c_tr_g = build_groups(race_ids, cat_train)
        c_va_o, c_va_g = build_groups(race_ids, cat_val)
        c_te_o, c_te_g = build_groups(race_ids, cat_test)

        c_tw = compute_weights(positions, odds_data, c_tr_o, c_tr_g, recency)
        c_sw = expand_weights(c_tr_g, c_tw)

        c_res, c_model = train_and_eval(
            X48_extra[c_tr_o], y[c_tr_o], c_tr_g, c_sw,
            X48_extra[c_va_o], y[c_va_o], c_va_g,
            X48_extra[c_te_o], y[c_te_o], c_te_g,
            loss='YetiRank'
        )

        te_pool = Pool(data=X48_extra[c_te_o], group_id=make_qids(c_te_g))
        pred = c_model.predict(te_pool)
        yg = split_groups(y[c_te_o], c_te_g)
        pg = split_groups(pred, c_te_g)
        all_test_yg2.extend(yg)
        all_test_pg2.extend(pg)

        print(f"  {cat_name}: Test NDCG@1={c_res['test_ndcg1']:.4f} Top-1={c_res['test_top1']:.4f}")

    if all_test_yg2:
        combined_ndcg1_2 = ndcg1(all_test_yg2, all_test_pg2)
        combined_top1_2 = topk(all_test_yg2, all_test_pg2, 1)
        combined_top3_2 = topk(all_test_yg2, all_test_pg2, 3)
        elapsed = time.time() - t0
        cat_res2 = {
            'val_ndcg1': 0, 'test_ndcg1': combined_ndcg1_2,
            'test_top1': combined_top1_2, 'test_top3': combined_top3_2, 'iters': 0,
        }
        results_table.append(('Cat-specific + 48feat + time/venue', cat_res2, elapsed))
        print(f"  Combined: Test NDCG@1={combined_ndcg1_2:.4f} Top-1={combined_top1_2:.4f} Top-3={combined_top3_2:.4f} ({elapsed:.0f}s)")

    # ============================================================
    # Summary
    # ============================================================
    print("\n" + "=" * 60)
    print("RESULTS SUMMARY")
    print("=" * 60)
    print(f"{'Approach':<40} {'Test NDCG@1':>11} {'Test Top-1':>10} {'Test Top-3':>10} {'Time':>6}")
    print("-" * 80)
    for name, res, elapsed in results_table:
        print(f"{name:<40} {res['test_ndcg1']:>11.4f} {res['test_top1']:>10.4f} {res['test_top3']:>10.4f} {elapsed:>5.0f}s")

    # Best approach
    best = max(results_table, key=lambda x: x[1]['test_ndcg1'])
    print(f"\n★ Best: {best[0]} (Test NDCG@1={best[1]['test_ndcg1']:.4f})")

    baseline_ndcg = results_table[0][1]['test_ndcg1']
    delta = best[1]['test_ndcg1'] - baseline_ndcg
    print(f"  Improvement over baseline: {delta:+.4f} ({delta/baseline_ndcg*100:+.1f}%)")


if __name__ == '__main__':
    main()
