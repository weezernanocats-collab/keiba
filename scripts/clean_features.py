"""
Step 1: training_data.json から死んだ特徴量を除去
Turso reads: ZERO
"""

import json
import os

MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "model")
DATA_FILE = os.path.join(MODEL_DIR, "training_data.json")
BACKUP_FILE = os.path.join(MODEL_DIR, "training_data_38feat_backup.json")

# SHAP分析で特定された除去対象
REMOVE_FEATURES = [
    # gain=0, perm=0 in ALL models (complete noise)
    'courseAptitude',
    'classPerformance',
    'jockeyTrainerCombo',
    'historicalPostBias',
    'trackType_encoded',   # always constant within category
    'weightChange',
    # Redundant: keep oddsLogTransform, drop raw odds
    'odds',
]


def main():
    print(f"Loading: {DATA_FILE}")
    with open(DATA_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    old_names = data["feature_names"]
    rows = data["rows"]
    print(f"Before: {len(old_names)} features, {len(rows)} samples")

    # Build removal indices
    remove_indices = set()
    for feat in REMOVE_FEATURES:
        if feat in old_names:
            remove_indices.add(old_names.index(feat))
            print(f"  Remove: {feat} (index {old_names.index(feat)})")
        else:
            print(f"  Skip: {feat} (not found)")

    # New feature list
    new_names = [n for i, n in enumerate(old_names) if i not in remove_indices]
    keep_indices = [i for i in range(len(old_names)) if i not in remove_indices]

    print(f"After: {len(new_names)} features")
    print(f"Removed: {len(remove_indices)} features")

    # Backup original
    print(f"Backup: {BACKUP_FILE}")
    os.rename(DATA_FILE, BACKUP_FILE)

    # Clean each row
    for row in rows:
        old_feats = row["features"]
        row["features"] = [old_feats[i] for i in keep_indices]

    data["feature_names"] = new_names

    # Save
    print(f"Saving cleaned data: {DATA_FILE}")
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)

    print(f"Done: {len(new_names)} features x {len(rows)} samples")
    print(f"New feature list: {new_names}")


if __name__ == "__main__":
    main()
