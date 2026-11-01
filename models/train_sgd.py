from pathlib import Path
import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import SGDRegressor
from sklearn.metrics import mean_squared_error, mean_absolute_error

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
LEARNING_RATE = 0.01
EPOCHS = 200
CHECKPOINT_INTERVAL = 10
RANDOM_STATE = 42


def main():
    MODEL_DIR.mkdir(parents=True, exist_ok=True)

    train = pd.read_csv(DATA_DIR / "train.csv")
    validation = pd.read_csv(DATA_DIR / "validation.csv")

    X_train = train[FEATURES].copy()
    y_train = train[TARGET].to_numpy(dtype=float)

    X_val = validation[FEATURES].copy()
    y_val = validation[TARGET].to_numpy(dtype=float)

    # Fit preprocessing only on training data.
    imputer = SimpleImputer(strategy="median")
    scaler = StandardScaler()

    X_train = scaler.fit_transform(imputer.fit_transform(X_train))
    X_val = scaler.transform(imputer.transform(X_val))

    model = SGDRegressor(
        loss="squared_error",
        penalty=None,
        learning_rate="constant",
        eta0=LEARNING_RATE,
        shuffle=False,
        random_state=RANDOM_STATE,
    )

    rng = np.random.default_rng(RANDOM_STATE)
    losses = []
    checkpoint_epochs = []

    print("Training Stochastic Gradient Descent...")

    for epoch in range(1, EPOCHS + 1):
        # Shuffle training rows, then update weights sample by sample.
        indices = rng.permutation(len(X_train))

        for index in indices:
            model.partial_fit(
                X_train[index:index + 1],
                y_train[index:index + 1],
            )

        if epoch % CHECKPOINT_INTERVAL == 0:
            train_predictions = model.predict(X_train)
            train_mse = mean_squared_error(y_train, train_predictions)

            losses.append(train_mse)
            checkpoint_epochs.append(epoch)

    val_predictions = model.predict(X_val)

    val_rmse = np.sqrt(mean_squared_error(y_val, val_predictions))
    val_mae = mean_absolute_error(y_val, val_predictions)

    print("\nSGD validation results")
    print(f"Learning rate: {LEARNING_RATE}")
    print(f"Training epochs: {EPOCHS}")
    print(f"Training rows: {len(train):,}")
    print(f"Validation rows: {len(validation):,}")
    print(f"Final training MSE: {losses[-1]:.4f}")
    print(f"Validation RMSE: {val_rmse:.4f} µg/m³")
    print(f"Validation MAE: {val_mae:.4f} µg/m³")

    if not np.isfinite(losses).all():
        raise ValueError("SGD training produced non-finite loss values.")

    np.savez(
        MODEL_DIR / "linear_regression_sgd.npz",
        weights=model.coef_,
        bias=model.intercept_,
        imputer_statistics=imputer.statistics_,
        scaler_mean=scaler.mean_,
        scaler_scale=scaler.scale_,
        features=np.array(FEATURES),
        training_losses=np.array(losses),
        loss_checkpoint_epochs=np.array(checkpoint_epochs),
        learning_rate=LEARNING_RATE,
        training_epochs=EPOCHS,
        training_rows=len(train),
        validation_rmse=val_rmse,
        validation_mae=val_mae,
    )

    print("\nSaved SGD model to models/saved/linear_regression_sgd.npz")


if __name__ == "__main__":
    main()
