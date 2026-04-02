"""
時系列5-fold CVによる特徴量A/Bテスト

単一splitの偶然に依存しない、信頼性の高い評価を行う。
時系列順にレースをソートし、5分割のうち各foldで
train(前半80%) / test(後半20%) を構成する。

Usage:
  python3 scripts/experiment_cv.py                    # baseline only
  python3 scripts/experiment_cv.py --add feat1 feat2  # baseline + features
"""

import argparse
import json
import os
import sys

import numpy as np
from catboost import CatBoostRanker, Pool
from sklearn.metrics import ndcg_score

MODEL_DIR = os.path.join(os.path.dirname(__file__), "..", "model")
DATA_FILE = os.path.join(MODEL_DIR, "training_data.json")
FS_FILE = os.path.join(MODEL_DIR, "feature_selection_result.json")

ODDS_FEATURES = {"popularity", "oddsLogTransform", "popularityRatio", "relativeOdds", "avgPastOdds"}


def pos_to_rel(p):
    if p == 1: return 3
    if p == 2: return 2
    if p == 3: return 1
    return 0


def build_group_ids(indices, race_ids):
    gids, gid, prev = [], 0, None
    for i in indices:
        r = race_ids[i]
        if r != prev:
            if prev is not None:
                gid += 1
            prev = r
        gids.append(gid)
    return np.array(gids)


def build_groups(indices, race_ids):
    groups, prev, cnt = [], None, 0
    for i in indices:
        r = race_ids[i]
        if r != prev:
            if cnt > 0:
                groups.append(cnt)
            prev = r
            cnt = 0
        cnt += 1
    if cnt > 0:
        groups.append(cnt)
    return groups


def eval_on_split(scores, y, groups):
    offset = 0
    ndcg1s, top1, top3, total = [], 0, 0, 0
    for g in groups:
        ys = y[offset:offset + g].tolist()
        ss = scores[offset:offset + g].tolist()
        offset += g
        if len(ys) < 2:
            continue
        total += 1
        try:
            ndcg1s.append(ndcg_score([ys], [ss], k=1))
        except ValueError:
            continue
        ranked = sorted(range(g), key=lambda i: -ss[i])
        if ys[ranked[0]] == 3:
            top1 += 1
        if any(ys[ranked[i]] == 3 for i in range(min(3, g))):
            top3 += 1
    return {
        'ndcg1': np.mean(ndcg1s) if ndcg1s else 0,
        'top1': top1 / total * 100 if total else 0,
        'top3': top3 / total * 100 if total else 0,
        'n_races': total,
    }


def time_series_cv_folds(unique_races, n_folds=5):
    """Generate time-series CV folds.

    Each fold uses a progressively larger training set and tests on the next chunk.
    Fold 1: train on chunk 0, test on chunk 1
    Fold 2: train on chunks 0-1, test on chunk 2
    ...
    """
    n = len(unique_races)
    chunk_size = n // (n_folds + 1)

    folds = []
    for i in range(n_folds):
        train_end = chunk_size * (i + 1)
        test_end = min(chunk_size * (i + 2), n)
        train_races = set(unique_races[:train_end])
        test_races = set(unique_races[train_end:test_end])
        folds.append((train_races, test_races))
    return folds


def run_cv(feature_list, all_features, X_all, y, race_ids, unique_races, n_folds=5):
    cols = [all_features.index(f) for f in feature_list]
    folds = time_series_cv_folds(unique_races, n_folds)

    fold_results = []
    for fi, (train_races, test_races) in enumerate(folds):
        train_idx = [i for i, r in enumerate(race_ids) if r in train_races]
        test_idx = [i for i, r in enumerate(race_ids) if r in test_races]

        if len(train_idx) < 100 or len(test_idx) < 100:
            continue

        # Use last 15% of train as validation for early stopping
        n_train = len(train_idx)
        val_split = int(n_train * 0.85)
        actual_train = train_idx[:val_split]
        val_idx = train_idx[val_split:]

        Xtr = X_all[actual_train][:, cols]
        Xval = X_all[val_idx][:, cols]
        Xte = X_all[test_idx][:, cols]
        ytr = y[actual_train]
        yval = y[val_idx]
        yte = y[test_idx]

        tr_gids = build_group_ids(actual_train, race_ids)
        val_gids = build_group_ids(val_idx, race_ids)
        te_gids = build_group_ids(test_idx, race_ids)
        te_groups = build_groups(test_idx, race_ids)

        model = CatBoostRanker(
            loss_function='PairLogitPairwise',
            eval_metric='NDCG:top=1',
            iterations=1000, depth=6, learning_rate=0.02,
            random_seed=42, verbose=0, early_stopping_rounds=50,
            task_type='CPU',
        )
        model.fit(Pool(Xtr, ytr, group_id=tr_gids),
                  eval_set=Pool(Xval, yval, group_id=val_gids))

        scores = model.predict(Pool(Xte, yte, group_id=te_gids))
        result = eval_on_split(scores, yte, te_groups)
        result['iters'] = model.get_best_iteration()
        fold_results.append(result)

    return fold_results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--add', nargs='+', default=[], help='Features to add to baseline')
    parser.add_argument('--folds', type=int, default=5, help='Number of CV folds')
    args = parser.parse_args()

    # Load data
    print("Loading data...", flush=True)
    with open(FS_FILE) as f:
        fs = json.load(f)
    baseline_features = fs['best_features']

    with open(DATA_FILE) as f:
        data = json.load(f)
    all_features = data['feature_names']
    rows = data['rows']

    race_ids = [r['race_id'] for r in rows]
    X_all = np.array([r['features'] for r in rows], dtype=np.float32)
    y = np.array([pos_to_rel(int(r['position'])) for r in rows])
    unique_races = list(dict.fromkeys(race_ids))

    print(f"  {len(rows)} samples, {len(all_features)} features, {len(unique_races)} races", flush=True)
    print(f"  {args.folds}-fold time-series CV\n", flush=True)

    # Baseline
    print(f"=== Baseline ({len(baseline_features)} features) ===", flush=True)
    base_results = run_cv(baseline_features, all_features, X_all, y, race_ids, unique_races, args.folds)

    base_ndcg = np.mean([r['ndcg1'] for r in base_results])
    base_top1 = np.mean([r['top1'] for r in base_results])
    base_top3 = np.mean([r['top3'] for r in base_results])
    base_std = np.std([r['ndcg1'] for r in base_results])

    for i, r in enumerate(base_results):
        print(f"  Fold {i+1}: NDCG@1={r['ndcg1']:.4f}, Top-1={r['top1']:.1f}%, Top-3={r['top3']:.1f}%, races={r['n_races']}, iters={r['iters']}", flush=True)
    print(f"  Mean:  NDCG@1={base_ndcg:.4f} (±{base_std:.4f}), Top-1={base_top1:.1f}%, Top-3={base_top3:.1f}%\n", flush=True)

    # Test
    if args.add:
        missing = [f for f in args.add if f not in all_features]
        if missing:
            print(f"ERROR: Features not found in data: {missing}")
            sys.exit(1)

        test_features = baseline_features + args.add
        print(f"=== Test ({len(test_features)} features: +{args.add}) ===", flush=True)
        test_results = run_cv(test_features, all_features, X_all, y, race_ids, unique_races, args.folds)

        test_ndcg = np.mean([r['ndcg1'] for r in test_results])
        test_top1 = np.mean([r['top1'] for r in test_results])
        test_top3 = np.mean([r['top3'] for r in test_results])
        test_std = np.std([r['ndcg1'] for r in test_results])

        for i, r in enumerate(test_results):
            print(f"  Fold {i+1}: NDCG@1={r['ndcg1']:.4f}, Top-1={r['top1']:.1f}%, Top-3={r['top3']:.1f}%, races={r['n_races']}, iters={r['iters']}", flush=True)
        print(f"  Mean:  NDCG@1={test_ndcg:.4f} (±{test_std:.4f}), Top-1={test_top1:.1f}%, Top-3={test_top3:.1f}%\n", flush=True)

        delta = test_ndcg - base_ndcg
        # Check if improvement is consistent across folds
        wins = sum(1 for b, t in zip(base_results, test_results) if t['ndcg1'] > b['ndcg1'])

        print(f"=== Result ===")
        print(f"  Delta NDCG@1: {delta:+.4f}")
        print(f"  Fold wins: {wins}/{len(base_results)}")
        print(f"  Verdict: {'ADOPT' if delta > 0.001 and wins >= 3 else 'REJECT'}")
        print(f"  (ADOPT requires: delta>0.001 AND wins in ≥3/5 folds)")


if __name__ == '__main__':
    main()
