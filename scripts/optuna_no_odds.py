"""
Optuna HPO for No-Odds CatBoost Ranker

20特徴量のno-oddsモデルに対してハイパーパラメータを最適化する。
過学習（270/1500で早期停止）を解消し、汎化性能を向上させる。

Usage: source .venv/bin/activate && python3 scripts/optuna_no_odds.py
"""

import json
import numpy as np
import optuna
from catboost import CatBoostRanker, Pool
from sklearn.metrics import ndcg_score
from sklearn.isotonic import IsotonicRegression

MODEL_DIR = "model"

ODDS_FEATURES = {
    "popularity", "oddsLogTransform", "popularityRatio",
    "relativeOdds", "avgPastOdds",
}


def load_data():
    with open(f'{MODEL_DIR}/training_data.json') as f:
        data = json.load(f)
    with open(f'{MODEL_DIR}/feature_names.json') as f:
        prod_features = json.load(f)

    train_features = data['feature_names']
    rows = data['rows']

    # v13.0: 全no-odds特徴量を使用（KEEP_FEATURES固定ではなくfeature_names.jsonベース）
    no_odds = [fn for fn in prod_features if fn not in ODDS_FEATURES]
    col_indices = [train_features.index(fn) for fn in no_odds if fn in train_features]
    actual = [fn for fn in no_odds if fn in train_features]

    X = np.array([r['features'] for r in rows], dtype=np.float32)[:, col_indices]
    race_ids = [r['race_id'] for r in rows]
    positions = np.array([r['position'] for r in rows], dtype=np.int32)
    odds_data = np.array([r.get('odds') or 0 for r in rows], dtype=np.float32)
    recency = np.array([r.get('recency_weight', 1.0) for r in rows], dtype=np.float32)

    return X, race_ids, positions, odds_data, recency, actual


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
    return h / t


def softmax(arr):
    arr = np.array(arr, dtype=np.float64)
    arr -= np.max(arr)
    e = np.exp(arr)
    s = e.sum()
    return (e / s) if s > 0 else np.ones_like(arr) / len(arr)


def main():
    print("=== Optuna HPO for No-Odds CatBoost ===\n")
    X, race_ids, positions, odds_data, recency, actual_features = load_data()
    print(f"Features: {len(actual_features)}, Samples: {len(X)}")

    y = np.array([rel(p) for p in positions], dtype=np.float32)

    sorted_idx = sorted(range(len(race_ids)), key=lambda i: race_ids[i])
    s1 = int(len(sorted_idx) * 0.70)
    s2 = int(len(sorted_idx) * 0.85)
    train_idx, val_idx, test_idx = sorted_idx[:s1], sorted_idx[s1:s2], sorted_idx[s2:]

    tr_o, tr_g = build_groups(race_ids, train_idx)
    va_o, va_g = build_groups(race_ids, val_idx)
    te_o, te_g = build_groups(race_ids, test_idx)

    tw = compute_weights(positions, odds_data, tr_o, tr_g, recency)
    sw = expand_weights(tr_g, tw)

    tr_pool = Pool(data=X[tr_o], label=y[tr_o], group_id=make_qids(tr_g), weight=sw)
    va_pool = Pool(data=X[va_o], label=y[va_o], group_id=make_qids(va_g))

    best_params = None
    best_ndcg = 0

    def objective(trial):
        nonlocal best_params, best_ndcg

        loss = trial.suggest_categorical('loss_function', ['PairLogitPairwise', 'YetiRank'])
        params = {
            'iterations': 2000,
            'depth': trial.suggest_int('depth', 4, 8),
            'learning_rate': trial.suggest_float('learning_rate', 0.005, 0.1, log=True),
            'l2_leaf_reg': trial.suggest_float('l2_leaf_reg', 1.0, 30.0),
            'bagging_temperature': trial.suggest_float('bagging_temperature', 0.0, 2.0),
            'random_strength': trial.suggest_float('random_strength', 0.0, 3.0),
            'border_count': trial.suggest_int('border_count', 32, 255),
            'min_data_in_leaf': trial.suggest_int('min_data_in_leaf', 1, 50),
            'loss_function': loss,
            'eval_metric': 'NDCG:top=1',
            'random_seed': 42,
            'verbose': 0,
            'early_stopping_rounds': 100,
        }

        model = CatBoostRanker(**params)
        model.fit(tr_pool, eval_set=va_pool)

        pred = model.predict(va_pool)
        yg = split_groups(y[va_o], va_g)
        pg = split_groups(pred, va_g)
        score = ndcg1(yg, pg)

        iters_used = model.get_best_iteration()

        if score > best_ndcg:
            best_ndcg = score
            best_params = params.copy()
            best_params['best_iteration'] = iters_used
            print(f"  ★ New best: NDCG@1={score:.4f} (iter={iters_used}, depth={params['depth']}, "
                  f"lr={params['learning_rate']:.4f}, l2={params['l2_leaf_reg']:.1f})")

        return score

    study = optuna.create_study(direction='maximize', sampler=optuna.samplers.TPESampler(seed=42))
    study.optimize(objective, n_trials=150, show_progress_bar=False)

    print(f"\n=== Best Trial ===")
    print(f"NDCG@1 (Val): {study.best_value:.4f}")
    print(f"Params: {study.best_params}")
    if best_params and 'best_iteration' in best_params:
        print(f"Iterations used: {best_params['best_iteration']}")

    # Retrain best model and evaluate on test
    print("\n=== Retraining best model ===")
    bp = study.best_params
    final_model = CatBoostRanker(
        iterations=2000,
        depth=bp['depth'],
        learning_rate=bp['learning_rate'],
        l2_leaf_reg=bp['l2_leaf_reg'],
        bagging_temperature=bp['bagging_temperature'],
        random_strength=bp['random_strength'],
        border_count=bp['border_count'],
        min_data_in_leaf=bp['min_data_in_leaf'],
        loss_function=bp['loss_function'],
        eval_metric='NDCG:top=1',
        random_seed=42,
        verbose=100,
        early_stopping_rounds=100,
    )
    final_model.fit(tr_pool, eval_set=va_pool)

    print(f"\nFinal iterations: {final_model.get_best_iteration()}")

    for label, idx_o, gs in [('Val', va_o, va_g), ('Test', te_o, te_g)]:
        pool = Pool(data=X[idx_o], group_id=make_qids(gs))
        pred = final_model.predict(pool)
        yg = split_groups(y[idx_o], gs)
        pg = split_groups(pred, gs)
        n1 = ndcg1(yg, pg)
        t1 = topk(yg, pg, 1)
        t3 = topk(yg, pg, 3)
        print(f"  [{label}] NDCG@1={n1:.4f} Top-1={t1:.4f} Top-3={t3:.4f}")

    # Calibration on val set
    print("\n=== Calibration ===")
    cal_pred = final_model.predict(Pool(data=X[va_o], group_id=make_qids(va_g)))
    cal_probs, cal_wins = [], []
    offset = 0
    for g in va_g:
        g = int(g)
        probs = softmax(cal_pred[offset:offset + g])
        pos_g = positions[va_o[offset:offset + g]]
        for i in range(g):
            cal_probs.append(float(probs[i]))
            cal_wins.append(1 if int(pos_g[i]) == 1 else 0)
        offset += g
    cal_probs = np.array(cal_probs)
    cal_wins = np.array(cal_wins)
    ir = IsotonicRegression(out_of_bounds='clip')
    ir.fit(cal_probs, cal_wins)
    brier_before = float(np.mean((cal_probs - cal_wins) ** 2))
    brier_after = float(np.mean((ir.predict(cal_probs) - cal_wins) ** 2))
    print(f"  Brier: {brier_before:.6f} -> {brier_after:.6f} ({(1-brier_after/brier_before)*100:+.1f}%)")

    print("\n=== Comparison ===")
    print("  Before (48feat, hand-tuned): [Test] NDCG@1=0.4041 Top-1=0.2343 Top-3=0.5209")
    print("  Before (20feat, hand-tuned): [Test] NDCG@1=0.4060 Top-1=0.2301 Top-3=0.5178")

    # Save best params
    with open(f'{MODEL_DIR}/optuna_no_odds_best.json', 'w') as f:
        json.dump({
            'best_params': study.best_params,
            'best_ndcg1_val': study.best_value,
            'iterations_used': final_model.get_best_iteration(),
            'features': actual_features,
            'n_features': len(actual_features),
            'n_trials': len(study.trials),
        }, f, indent=2)
    print(f"\nBest params saved: {MODEL_DIR}/optuna_no_odds_best.json")


if __name__ == '__main__':
    main()
