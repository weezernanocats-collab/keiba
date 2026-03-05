"""
XGBoost モデル自動学習スクリプト v5.2

GitHub Actions から実行される。
Vercel API から学習データを取得し、XGBRanker (LambdaMART/NDCG) で
レース内順位モデルを学習、model/ ディレクトリに JSON ファイルを出力する。

v5.2: XGBClassifier (binary) → XGBRanker (ranking) に変更
- 勝利/複勝の2モデルをランキング1モデルに統合
- グレーデッドリレバンス: 1着=3, 2着=2, 3着=1, 4着以下=0
- NDCG@1, NDCG@3, Top-1/Top-3精度で評価

フォールバック: positionフィールドがないデータでは従来のClassifierモードで学習
"""

import json
import os
import sys

import numpy as np
import requests
import xgboost as xgb
from sklearn.metrics import roc_auc_score, ndcg_score

# ==================== 設定 ====================

VERCEL_URL = os.environ.get("VERCEL_URL", "").rstrip("/")
SYNC_KEY = os.environ.get("SYNC_KEY", "")
MIN_SAMPLES = 100  # 最低サンプル数（これ未満なら学習スキップ）
MODEL_DIR = os.path.join(os.path.dirname(__file__), "..", "model")
LOCAL_DATA_FILE = os.path.join(MODEL_DIR, "training_data.json")


def fetch_chunk(url, headers, retries=2):
    """1チャンクを取得（リトライ付き）"""
    for attempt in range(retries + 1):
        try:
            resp = requests.get(url, headers=headers, timeout=55)
            resp.raise_for_status()
            return resp.json()
        except (requests.exceptions.Timeout, requests.exceptions.HTTPError) as e:
            if attempt < retries:
                wait = 2 ** (attempt + 1)
                print(f"  リトライ ({attempt + 1}/{retries}): {wait}秒待機...")
                import time
                time.sleep(wait)
            else:
                raise


def fetch_data():
    """Vercel API から四半期単位で分割取得（タイムアウト対策）"""
    headers = {}
    if SYNC_KEY:
        headers["x-sync-key"] = SYNC_KEY

    from datetime import date

    current_year = date.today().year
    all_rows = []
    feature_names = None

    quarters = [(1, 3), (4, 6), (7, 9), (10, 12)]

    for year in range(2020, current_year + 1):
        for q_start, q_end in quarters:
            from_date = f"{year}-{q_start:02d}-01"
            # 月末日を正確に計算
            if q_end == 12:
                to_date = f"{year}-12-31"
            else:
                next_month = q_end + 1
                to_date = f"{year}-{next_month:02d}-01"
                # 1日前 = 前月末
                from datetime import timedelta
                to_dt = date(year, next_month, 1) - timedelta(days=1)
                to_date = to_dt.isoformat()

            # 未来の四半期はスキップ
            if date(year, q_start, 1) > date.today():
                break

            url = f"{VERCEL_URL}/api/ml-export?from={from_date}&to={to_date}"
            print(f"データ取得中: {url}")
            chunk = fetch_chunk(url, headers)

            if feature_names is None and chunk.get("feature_names"):
                feature_names = chunk["feature_names"]

            rows = chunk.get("rows", [])
            print(f"  {year}Q{quarters.index((q_start, q_end)) + 1}: {len(rows)}件")
            all_rows.extend(rows)

    if feature_names is None:
        print("ERROR: 特徴量名が取得できませんでした")
        sys.exit(1)

    return {"feature_names": feature_names, "rows": all_rows}


def train_classifier(X_train, y_train, X_val, y_val, label_name, max_depth):
    """XGBClassifier を学習して返す（フォールバック用）"""
    pos_rate = y_train.mean()
    scale = (1 - pos_rate) / pos_rate if pos_rate > 0 else 10

    model = xgb.XGBClassifier(
        n_estimators=300,
        max_depth=max_depth,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        scale_pos_weight=scale,
        eval_metric="auc",
        early_stopping_rounds=30,
        random_state=42,
    )

    model.fit(
        X_train, y_train,
        eval_set=[(X_val, y_val)],
        verbose=50,
    )

    probs = model.predict_proba(X_val)[:, 1]
    auc = roc_auc_score(y_val, probs)
    print(f"{label_name} AUC: {auc:.4f}")

    return model, auc


def build_race_groups(race_ids, indices):
    """race_id でソートし、各レースの馬数をgroup配列として構築"""
    # インデックスをrace_id順にソート
    sorted_idx = sorted(indices, key=lambda i: race_ids[i])

    # グループサイズを算出
    groups = []
    current_race = None
    current_count = 0
    ordered_indices = []

    for i in sorted_idx:
        rid = race_ids[i]
        if rid != current_race:
            if current_count > 0:
                groups.append(current_count)
            current_race = rid
            current_count = 0
        current_count += 1
        ordered_indices.append(i)

    if current_count > 0:
        groups.append(current_count)

    return np.array(ordered_indices), np.array(groups)


def position_to_relevance(position):
    """着順をグレーデッドリレバンスに変換"""
    if position == 1:
        return 3
    elif position == 2:
        return 2
    elif position == 3:
        return 1
    else:
        return 0


def calc_ndcg_at_k(y_true_groups, y_pred_groups, k):
    """グループごとのNDCG@kを計算"""
    ndcgs = []
    for y_true, y_pred in zip(y_true_groups, y_pred_groups):
        if len(y_true) < 2:
            continue
        # sklearn ndcg_score は 2D配列を期待
        try:
            score = ndcg_score([y_true], [y_pred], k=k)
            ndcgs.append(score)
        except ValueError:
            continue
    return np.mean(ndcgs) if ndcgs else 0.0


def calc_top_k_accuracy(y_true_groups, y_pred_groups, k):
    """グループごとのTop-k精度を計算（1着馬がTop-k予測に含まれるか）"""
    correct = 0
    total = 0
    for y_true, y_pred in zip(y_true_groups, y_pred_groups):
        if len(y_true) < 2:
            continue
        total += 1
        # y_trueで最もrelevanceが高い馬のインデックス（1着馬）
        best_idx = np.argmax(y_true)
        # y_predの上位k個のインデックス
        top_k_idx = np.argsort(y_pred)[-k:]
        if best_idx in top_k_idx:
            correct += 1
    return correct / total if total > 0 else 0.0


def split_by_groups(y, groups):
    """グループサイズ配列に従ってyをグループに分割"""
    result = []
    offset = 0
    for g in groups:
        result.append(y[offset:offset + g].tolist())
        offset += g
    return result


def train_ranker(X_train, y_train, groups_train, X_val, y_val, groups_val):
    """XGBRanker (LambdaMART) を学習して返す"""
    model = xgb.XGBRanker(
        n_estimators=400,
        max_depth=5,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        eval_metric="ndcg",
        early_stopping_rounds=30,
        random_state=42,
        objective="rank:ndcg",
    )

    model.fit(
        X_train, y_train,
        group=groups_train,
        eval_set=[(X_val, y_val)],
        eval_group=[groups_val],
        verbose=50,
    )

    # 検証セットで予測
    y_pred = model.predict(X_val)

    # グループごとに分割して評価
    y_true_groups = split_by_groups(y_val, groups_val)
    y_pred_groups = split_by_groups(y_pred, groups_val)

    ndcg_1 = calc_ndcg_at_k(y_true_groups, y_pred_groups, k=1)
    ndcg_3 = calc_ndcg_at_k(y_true_groups, y_pred_groups, k=3)
    top1_acc = calc_top_k_accuracy(y_true_groups, y_pred_groups, k=1)
    top3_acc = calc_top_k_accuracy(y_true_groups, y_pred_groups, k=3)

    print(f"NDCG@1: {ndcg_1:.4f}, NDCG@3: {ndcg_3:.4f}")
    print(f"Top-1精度: {top1_acc:.4f}, Top-3精度: {top3_acc:.4f}")

    return model, {
        "ndcg_1": round(ndcg_1, 4),
        "ndcg_3": round(ndcg_3, 4),
        "top1_accuracy": round(top1_acc, 4),
        "top3_accuracy": round(top3_acc, 4),
    }


def load_local_data():
    """ローカルの training_data.json から読み込む"""
    print(f"ローカルデータ読み込み: {LOCAL_DATA_FILE}")
    with open(LOCAL_DATA_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def main():
    # ローカルデータがあればそちらを優先
    if os.path.exists(LOCAL_DATA_FILE):
        data = load_local_data()
    elif VERCEL_URL:
        data = fetch_data()
    else:
        print("ERROR: ローカルデータ (model/training_data.json) も VERCEL_URL も見つかりません")
        sys.exit(1)
    feature_names = data["feature_names"]
    rows = data["rows"]

    print(f"総サンプル数: {len(rows)}")
    print(f"特徴量数: {len(feature_names)}")

    if len(rows) < MIN_SAMPLES:
        print(f"サンプル数が{MIN_SAMPLES}件未満のため学習をスキップします ({len(rows)}件)")
        sys.exit(0)

    # positionフィールドの有無でランキングモード判定
    has_position = all("position" in r for r in rows[:100])

    # NumPy 配列に変換
    X = np.array([r["features"] for r in rows], dtype=np.float32)
    race_ids = [r["race_id"] for r in rows]

    # 時系列分割（最新15%をバリデーション）
    sorted_indices = sorted(range(len(rows)), key=lambda i: race_ids[i])
    split_idx = int(len(sorted_indices) * 0.85)
    train_idx = sorted_indices[:split_idx]
    val_idx = sorted_indices[split_idx:]

    print(f"学習: {len(train_idx)}件, 検証: {len(val_idx)}件")

    os.makedirs(MODEL_DIR, exist_ok=True)

    if has_position:
        # ========== XGBRanker モード (v5.2) ==========
        print("\n=== XGBRanker (LambdaMART) モード ===")

        # グレーデッドリレバンス: 1着=3, 2着=2, 3着=1, 4着以下=0
        positions = np.array([r["position"] for r in rows], dtype=np.int32)
        y_relevance = np.array([position_to_relevance(p) for p in positions], dtype=np.float32)

        # レースグループを構築（race_id順にソート済み）
        train_ordered, groups_train = build_race_groups(race_ids, train_idx)
        val_ordered, groups_val = build_race_groups(race_ids, val_idx)

        X_train = X[train_ordered]
        X_val = X[val_ordered]
        y_train = y_relevance[train_ordered]
        y_val = y_relevance[val_ordered]

        model, metrics = train_ranker(X_train, y_train, groups_train, X_val, y_val, groups_val)

        # モデル保存
        model.save_model(os.path.join(MODEL_DIR, "xgb_ranker.json"))

        with open(os.path.join(MODEL_DIR, "feature_names.json"), "w", encoding="utf-8") as f:
            json.dump(feature_names, f, ensure_ascii=False, indent=2)

        meta = {
            "model_type": "ranker",
            "train_samples": len(train_idx),
            "val_samples": len(val_idx),
            "feature_count": len(feature_names),
            **metrics,
        }
        with open(os.path.join(MODEL_DIR, "meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)

        print(f"\n=== 完了 (Rankerモード) ===")
        print(f"NDCG@1: {metrics['ndcg_1']}, NDCG@3: {metrics['ndcg_3']}")
        print(f"Top-1精度: {metrics['top1_accuracy']}, Top-3精度: {metrics['top3_accuracy']}")

    else:
        # ========== XGBClassifier フォールバックモード ==========
        print("\n=== XGBClassifier フォールバックモード (positionフィールドなし) ===")

        y_win = np.array([r["label_win"] for r in rows], dtype=np.int8)
        y_place = np.array([r["label_place"] for r in rows], dtype=np.int8)

        X_train, X_val = X[train_idx], X[val_idx]
        y_win_train, y_win_val = y_win[train_idx], y_win[val_idx]
        y_place_train, y_place_val = y_place[train_idx], y_place[val_idx]

        # 勝利モデル
        print("\n=== 勝利モデル学習 ===")
        model_win, win_auc = train_classifier(
            X_train, y_win_train, X_val, y_win_val, "勝利", max_depth=4
        )

        # 複勝モデル
        print("\n=== 複勝モデル学習 ===")
        model_place, place_auc = train_classifier(
            X_train, y_place_train, X_val, y_place_val, "複勝", max_depth=5
        )

        # モデル保存
        model_win.save_model(os.path.join(MODEL_DIR, "xgb_win.json"))
        model_place.save_model(os.path.join(MODEL_DIR, "xgb_place.json"))

        with open(os.path.join(MODEL_DIR, "feature_names.json"), "w", encoding="utf-8") as f:
            json.dump(feature_names, f, ensure_ascii=False, indent=2)

        # 検証セットでの正解率を meta.json に保存
        win_acc = float(np.mean((model_win.predict_proba(X_val)[:, 1] >= 0.5) == y_win_val))
        place_acc = float(np.mean((model_place.predict_proba(X_val)[:, 1] >= 0.5) == y_place_val))
        meta = {
            "model_type": "classifier",
            "train_samples": len(train_idx),
            "val_samples": len(val_idx),
            "win_auc": round(win_auc, 4),
            "place_auc": round(place_auc, 4),
            "win_accuracy": round(win_acc, 4),
            "place_accuracy": round(place_acc, 4),
            "feature_count": len(feature_names),
        }
        with open(os.path.join(MODEL_DIR, "meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)

        print(f"\n=== 完了 (Classifierモード) ===")
        print(f"勝利 AUC: {win_auc:.4f} (Acc: {win_acc:.4f}), 複勝 AUC: {place_auc:.4f} (Acc: {place_acc:.4f})")

    print(f"モデル保存先: {MODEL_DIR}")


if __name__ == "__main__":
    main()
