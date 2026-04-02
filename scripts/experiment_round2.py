"""
Round 2: Deep-dive on promising approaches from Round 1.

Round 1 findings:
- PairLogitPairwise: Best NDCG@1=0.4123, Top-1=0.2437
- 48feat YetiRank: NDCG@1=0.4118, Top-1=0.2395
- Baseline (20feat YetiRank): NDCG@1=0.4060, Top-1=0.2301

Round 2 experiments:
A. 48feat + PairLogitPairwise (combine two best)
B. Different relevance labels (more granular: top5 gets points)
C. 48feat + PairLogitPairwise + Optuna mini (30 trials)
D. Top-1 focused: YetiRank with custom NDCG weights
E. Ensemble: average of YetiRank + PairLogitPairwise predictions

Usage: source .venv/bin/activate && python3 scripts/experiment_round2.py
"""

import json
import numpy as np
from catboost import CatBoostRanker, Pool
from sklearn.metrics import ndcg_score
import optuna
import time

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


def eval_predictions(y_ordered, pred, gs):
    yg = split_groups(y_ordered, gs)
    pg = split_groups(pred, gs)
    return {
        'ndcg1': ndcg1(yg, pg),
        'top1': topk(yg, pg, 1),
        'top3': topk(yg, pg, 3),
    }


def main():
    print("=" * 60)
    print("Round 2: Deep-dive on Promising Approaches")
    print("=" * 60)

    feature_names, rows = load_data()
    X_all = np.array([r['features'] for r in rows], dtype=np.float32)
    race_ids = [r['race_id'] for r in rows]
    positions = np.array([r['position'] for r in rows], dtype=np.int32)
    odds_data = np.array([r.get('odds') or 0 for r in rows], dtype=np.float32)
    recency = np.array([r.get('recency_weight', 1.0) for r in rows], dtype=np.float32)

    # Labels
    def rel3(p): return 3 if p == 1 else 2 if p == 2 else 1 if p == 3 else 0
    def rel5(p): return 5 if p == 1 else 4 if p == 2 else 3 if p == 3 else 2 if p == 4 else 1 if p == 5 else 0
    def rel_binary(p): return 1 if p == 1 else 0
    def rel_exp(p): return 2**(max(0, 4-p)) if p <= 4 else 0  # 8,4,2,1,0...

    y3 = np.array([rel3(p) for p in positions], dtype=np.float32)
    y5 = np.array([rel5(p) for p in positions], dtype=np.float32)
    y_bin = np.array([rel_binary(p) for p in positions], dtype=np.float32)
    y_exp = np.array([rel_exp(p) for p in positions], dtype=np.float32)

    # Splits
    sorted_idx = sorted(range(len(race_ids)), key=lambda i: race_ids[i])
    s1 = int(len(sorted_idx) * 0.70)
    s2 = int(len(sorted_idx) * 0.85)
    train_idx, val_idx, test_idx = sorted_idx[:s1], sorted_idx[s1:s2], sorted_idx[s2:]

    noOdds_indices = [i for i, fn in enumerate(feature_names) if fn not in ODDS_FEATURES]
    X48 = X_all[:, noOdds_indices]

    tr_o, tr_g = build_groups(race_ids, train_idx)
    va_o, va_g = build_groups(race_ids, val_idx)
    te_o, te_g = build_groups(race_ids, test_idx)

    tw = compute_weights(positions, odds_data, tr_o, tr_g, recency)
    sw = expand_weights(tr_g, tw)

    results = []

    def run_experiment(name, X, y, loss, sw_use, params_extra=None):
        t0 = time.time()
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
        if params_extra:
            params.update(params_extra)

        tr_pool = Pool(data=X[tr_o], label=y[tr_o], group_id=make_qids(tr_g), weight=sw_use)
        va_pool = Pool(data=X[va_o], label=y[va_o], group_id=make_qids(va_g))

        model = CatBoostRanker(**params)
        model.fit(tr_pool, eval_set=va_pool)
        iters = model.get_best_iteration()

        # Evaluate
        va_pred = model.predict(va_pool)
        te_pool = Pool(data=X[te_o], group_id=make_qids(te_g))
        te_pred = model.predict(te_pool)

        va_m = eval_predictions(y3[va_o], va_pred, va_g)  # Always eval with y3 for consistency
        te_m = eval_predictions(y3[te_o], te_pred, te_g)

        elapsed = time.time() - t0
        results.append((name, te_m, va_m, elapsed, iters))
        print(f"  Val NDCG@1={va_m['ndcg1']:.4f}  Test NDCG@1={te_m['ndcg1']:.4f}  "
              f"Top-1={te_m['top1']:.4f}  Top-3={te_m['top3']:.4f}  iters={iters} ({elapsed:.0f}s)")
        return model, te_pred, va_pred

    sw_uniform = np.ones_like(sw)

    # A. 48feat + PairLogitPairwise
    print("\n[A] 48feat + PairLogitPairwise")
    model_plp48, te_pred_plp48, va_pred_plp48 = run_experiment(
        '48feat + PairLogitPairwise', X48, y3, 'PairLogitPairwise', sw_uniform)

    # B. Different relevance labels with YetiRank
    print("\n[B1] 48feat + YetiRank + 5-level labels")
    run_experiment('48feat + YetiRank + rel5', X48, y5, 'YetiRank', sw)

    print("\n[B2] 48feat + YetiRank + binary labels")
    run_experiment('48feat + YetiRank + binary', X48, y_bin, 'YetiRank', sw)

    print("\n[B3] 48feat + YetiRank + exponential labels")
    run_experiment('48feat + YetiRank + exp_labels', X48, y_exp, 'YetiRank', sw)

    # C. Baseline 48feat + YetiRank for comparison
    print("\n[C] 48feat + YetiRank (baseline)")
    model_yr48, te_pred_yr48, va_pred_yr48 = run_experiment(
        '48feat + YetiRank', X48, y3, 'YetiRank', sw)

    # D. 20feat + PairLogitPairwise for comparison
    keep20_indices = [feature_names.index(fn) for fn in KEEP_20 if fn in feature_names]
    X20 = X_all[:, keep20_indices]
    print("\n[D] 20feat + PairLogitPairwise")
    model_plp20, te_pred_plp20, va_pred_plp20 = run_experiment(
        '20feat + PairLogitPairwise', X20, y3, 'PairLogitPairwise', sw_uniform)

    # E. Ensemble: YetiRank + PairLogitPairwise (48feat)
    print("\n[E] Ensemble: YetiRank + PairLogitPairwise (48feat)")
    t0 = time.time()
    best_alpha = 0.5
    best_val_ndcg = 0
    for alpha in np.arange(0.0, 1.05, 0.1):
        blended_va = alpha * va_pred_yr48 + (1 - alpha) * va_pred_plp48
        va_m = eval_predictions(y3[va_o], blended_va, va_g)
        if va_m['ndcg1'] > best_val_ndcg:
            best_val_ndcg = va_m['ndcg1']
            best_alpha = alpha

    blended_te = best_alpha * te_pred_yr48 + (1 - best_alpha) * te_pred_plp48
    te_m = eval_predictions(y3[te_o], blended_te, te_g)
    elapsed = time.time() - t0
    results.append((f'Ensemble (α={best_alpha:.1f})', te_m, {'ndcg1': best_val_ndcg}, elapsed, 0))
    print(f"  Best α={best_alpha:.1f}  Val NDCG@1={best_val_ndcg:.4f}  "
          f"Test NDCG@1={te_m['ndcg1']:.4f}  Top-1={te_m['top1']:.4f}  Top-3={te_m['top3']:.4f}")

    # F. Optuna mini on 48feat + PairLogitPairwise (30 trials)
    print("\n[F] Optuna mini: 48feat + PairLogitPairwise (30 trials)")
    t0 = time.time()

    best_optuna = {'ndcg1': 0, 'params': None}

    def objective(trial):
        params = {
            'iterations': 2000,
            'depth': trial.suggest_int('depth', 4, 8),
            'learning_rate': trial.suggest_float('learning_rate', 0.005, 0.1, log=True),
            'l2_leaf_reg': trial.suggest_float('l2_leaf_reg', 1.0, 30.0),
            'bagging_temperature': trial.suggest_float('bagging_temperature', 0.0, 2.0),
            'random_strength': trial.suggest_float('random_strength', 0.0, 3.0),
            'border_count': trial.suggest_int('border_count', 32, 255),
            'min_data_in_leaf': trial.suggest_int('min_data_in_leaf', 1, 50),
            'loss_function': 'PairLogitPairwise',
            'eval_metric': 'NDCG:top=1',
            'random_seed': 42,
            'verbose': 0,
            'early_stopping_rounds': 100,
        }

        tr_pool = Pool(data=X48[tr_o], label=y3[tr_o], group_id=make_qids(tr_g))
        va_pool = Pool(data=X48[va_o], label=y3[va_o], group_id=make_qids(va_g))

        model = CatBoostRanker(**params)
        model.fit(tr_pool, eval_set=va_pool)

        pred = model.predict(va_pool)
        yg = split_groups(y3[va_o], va_g)
        pg = split_groups(pred, va_g)
        score = ndcg1(yg, pg)

        if score > best_optuna['ndcg1']:
            best_optuna['ndcg1'] = score
            best_optuna['params'] = params.copy()
            best_optuna['params']['best_iteration'] = model.get_best_iteration()

        return score

    study = optuna.create_study(direction='maximize', sampler=optuna.samplers.TPESampler(seed=42))
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    study.optimize(objective, n_trials=30)

    # Retrain best and eval on test
    bp = study.best_params
    final_params = {
        'iterations': 2000,
        'depth': bp['depth'],
        'learning_rate': bp['learning_rate'],
        'l2_leaf_reg': bp['l2_leaf_reg'],
        'bagging_temperature': bp['bagging_temperature'],
        'random_strength': bp['random_strength'],
        'border_count': bp['border_count'],
        'min_data_in_leaf': bp['min_data_in_leaf'],
        'loss_function': 'PairLogitPairwise',
        'eval_metric': 'NDCG:top=1',
        'random_seed': 42,
        'verbose': 0,
        'early_stopping_rounds': 100,
    }
    tr_pool = Pool(data=X48[tr_o], label=y3[tr_o], group_id=make_qids(tr_g))
    va_pool = Pool(data=X48[va_o], label=y3[va_o], group_id=make_qids(va_g))
    final_model = CatBoostRanker(**final_params)
    final_model.fit(tr_pool, eval_set=va_pool)

    te_pool = Pool(data=X48[te_o], group_id=make_qids(te_g))
    te_pred_optuna = final_model.predict(te_pool)
    te_m_optuna = eval_predictions(y3[te_o], te_pred_optuna, te_g)
    va_pred_optuna = final_model.predict(va_pool)
    va_m_optuna = eval_predictions(y3[va_o], va_pred_optuna, va_g)

    elapsed = time.time() - t0
    results.append(('Optuna PairLogitPw 48f', te_m_optuna, va_m_optuna, elapsed, final_model.get_best_iteration()))
    print(f"  Best params: depth={bp['depth']}, lr={bp['learning_rate']:.4f}, l2={bp['l2_leaf_reg']:.1f}")
    print(f"  Val NDCG@1={va_m_optuna['ndcg1']:.4f}  Test NDCG@1={te_m_optuna['ndcg1']:.4f}  "
          f"Top-1={te_m_optuna['top1']:.4f}  Top-3={te_m_optuna['top3']:.4f}  "
          f"iters={final_model.get_best_iteration()} ({elapsed:.0f}s)")

    # G. Ensemble: Optuna PairLogitPw + YetiRank
    print("\n[G] Ensemble: Optuna PairLogitPw + YetiRank (48feat)")
    best_alpha2 = 0.5
    best_val_ndcg2 = 0
    for alpha in np.arange(0.0, 1.05, 0.1):
        blended_va = alpha * va_pred_yr48 + (1 - alpha) * va_pred_optuna
        va_m2 = eval_predictions(y3[va_o], blended_va, va_g)
        if va_m2['ndcg1'] > best_val_ndcg2:
            best_val_ndcg2 = va_m2['ndcg1']
            best_alpha2 = alpha

    blended_te2 = best_alpha2 * te_pred_yr48 + (1 - best_alpha2) * te_pred_optuna
    te_m2 = eval_predictions(y3[te_o], blended_te2, te_g)
    results.append((f'Ensemble Optuna+YR (α={best_alpha2:.1f})', te_m2, {'ndcg1': best_val_ndcg2}, 0, 0))
    print(f"  Best α={best_alpha2:.1f}  Val NDCG@1={best_val_ndcg2:.4f}  "
          f"Test NDCG@1={te_m2['ndcg1']:.4f}  Top-1={te_m2['top1']:.4f}  Top-3={te_m2['top3']:.4f}")

    # Summary
    print("\n" + "=" * 60)
    print("ROUND 2 RESULTS SUMMARY")
    print("=" * 60)
    print(f"{'Approach':<38} {'Test NDCG@1':>11} {'Test Top-1':>10} {'Test Top-3':>10} {'Time':>6}")
    print("-" * 78)
    for name, te_m, va_m, elapsed, iters in results:
        print(f"{name:<38} {te_m['ndcg1']:>11.4f} {te_m['top1']:>10.4f} {te_m['top3']:>10.4f} {elapsed:>5.0f}s")

    print(f"\nBaseline reference: Test NDCG@1=0.4060, Top-1=0.2301, Top-3=0.5178")
    best = max(results, key=lambda x: x[1]['ndcg1'])
    delta = best[1]['ndcg1'] - 0.4060
    delta_top1 = best[1]['top1'] - 0.2301
    print(f"\n★ Best: {best[0]}")
    print(f"  NDCG@1: 0.4060 → {best[1]['ndcg1']:.4f} ({delta:+.4f}, {delta/0.4060*100:+.1f}%)")
    print(f"  Top-1:  0.2301 → {best[1]['top1']:.4f} ({delta_top1:+.4f}, {delta_top1/0.2301*100:+.1f}%)")


if __name__ == '__main__':
    main()
