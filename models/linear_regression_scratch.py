
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data" / "processed"
MODEL_DIR = PROJECT_ROOT / "models" / "saved"

FEATURES = [
    "PM2.5 (µg/m³)",
    "temperature_c",
    "relative_humidity_pct",
    "precipitation_mm",
    "wind_speed_ms",
    "hour",
    "day_of_week",
    "month",
]
TARGET = "target_pm25_next_hour"


def mean_squared_error(y_true, y_pred):
    return np.mean((y_true - y_pred) ** 2)


def train_gradient_descent(X, y, learning_rate=0.01, epochs=2000):
    """Fit linear regression by minimizing MSE with gradient descent."""
    n_samples, n_features = X.shape
    weights = np.zeros(n_features)
    bias = 0.0
    losses = []

    for epoch in range(epochs):
        predictions = X @ weights + bias
        errors = predictions - y

        # Derivatives of mean squared error with respect to weights and bias.
        dw = (2 / n_samples) * (X.T @ errors)
        db = 2 * np.mean(errors)

        weights -= learning_rate * dw
        bias -= learning_rate * db

        if epoch % 100 == 0:
            losses.append(mean_squared_error(y, X @ weights + bias))

    return weights, bias, losses


def main():
    MODEL_DIR.mkdir(parents=True, exist_ok=True)

    train = pd.read_csv(DATA_DIR / "train.csv")
    validation = pd.read_csv(DATA_DIR / "validation.csv")

    X_train = train[FEATURES].copy()
    y_train = train[TARGET].to_numpy(dtype=float)
    X_val = validation[FEATURES].copy()
    y_val = validation[TARGET].to_numpy(dtype=float)

    # Fit preprocessing only on training data to avoid leakage.
    imputer = SimpleImputer(strategy="median")
    scaler = StandardScaler()

    X_train_imputed = imputer.fit_transform(X_train)
    X_val_imputed = imputer.transform(X_val)

    X_train_scaled = scaler.fit_transform(X_train_imputed)
    X_val_scaled = scaler.transform(X_val_imputed)

    weights, bias, losses = train_gradient_descent(
        X_train_scaled,
        y_train,
        learning_rate=0.01,
        epochs=2000,
    )

    val_predictions = X_val_scaled @ weights + bias
    val_rmse = np.sqrt(mean_squared_error(y_val, val_predictions))
    val_mae = np.mean(np.abs(y_val - val_predictions))

    print("Linear regression from scratch — validation results")
    print(f"Features: {len(FEATURES)}")
    print(f"Training rows: {len(train):,}")
    print(f"Validation rows: {len(validation):,}")
    print(f"Final recorded training MSE: {losses[-1]:.4f}")
    print(f"Validation RMSE: {val_rmse:.4f} µg/m³")
    print(f"Validation MAE: {val_mae:.4f} µg/m³")
    print(f"Learned bias: {bias:.4f}")
    print("\nLearned weights:")
    for name, weight in zip(FEATURES, weights):
        print(f"{name}: {weight:.4f}")

    # Save the learned parameters and preprocessing for later reuse.
    np.savez(
        MODEL_DIR / "linear_regression_scratch.npz",
        weights=weights,
        bias=bias,
        imputer_statistics=imputer.statistics_,
        scaler_mean=scaler.mean_,
        scaler_scale=scaler.scale_,
        features=np.array(FEATURES),
        training_losses=np.array(losses),
        loss_checkpoint_epochs=np.arange(len(losses)) * 100,
    )


if __name__ == "__main__":
    main()
