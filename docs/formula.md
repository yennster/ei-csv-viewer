# Formula engine

The Edge Impulse CSV Editor includes a small **Python-syntax, numpy-like**
expression engine for non-destructive analysis. It powers two actions in the
**Formula** panel (collapsible, above the lane board):

- **Derive** — turn an expression into a **new channel**. The result is frozen
  full-resolution into a new lane and participates in lanes / drag / export like
  any other channel. The source expression is kept as metadata.
- **Filter** — turn a boolean expression into a length-N **mask**. Matching
  samples are highlighted (the non-matching ranges are shaded across every lane);
  **rows are never deleted**. When the matches form a contiguous range you can
  **Crop to matches** (in editor mode), which reuses the normal crop pipeline.

Both Derive and Filter are **non-destructive analysis**, so the panel is
available in **both `editor` and `viewer` modes**. ("Crop to matches" writes
data, so it is hidden in `viewer` mode — see [URL parameters](./url-parameters.md).)

The engine is **safe**: it is a pure, deterministic, whitelist-only evaluator
with **no `eval` / `Function` / global access**. Every entry point returns an
`{ ok } | { error }` result and never throws into the UI; an inline error shows
a caret at the offending position and a "did you mean…" suggestion.

---

## Referencing data

| Reference | Meaning |
| --- | --- |
| `accX` | A channel by name, when the name is a simple identifier. |
| `col("Acc X")` | A channel by name when it contains spaces / punctuation. |
| `index` | The 0-based sample index (`0 … N-1`). |
| `t` | The time axis (seconds) when present; falls back to `index`. |
| `pi`, `e`, `true`, `false` | Constants. |

## Operators

`+  -  *  /  %  **` (power is right-associative, e.g. `2 ** 3 ** 2 == 512`),
unary `+ - not`, comparisons `< <= > >= == !=` (produce 0/1 masks), and boolean
`and` / `or` (elementwise). Python-style `%` takes the sign of the divisor.

## Functions

- **Elementwise:** `abs sqrt exp log log10 sin cos tan floor ceil round sign
  clip where min max`
- **Reducers (→ scalar):** `mean std var sum median amin amax count`
- **Windowed:** `diff cumsum gradient rolling_mean rolling_std normalize`

Scalars broadcast against vectors, so `accX - mean(accX)` is centering and a
constant expression still derives a full-length channel.

---

## Examples

**Accelerometer magnitude** (derive a new channel):

```
sqrt(accX**2 + accY**2 + accZ**2)
```

**Unit conversion** — milli-g to g (derive):

```
accX / 1000
```

**Z-score normalize** a noisy channel (derive):

```
normalize(gyroZ)
```

**Anomaly filter** — highlight samples whose magnitude spikes past a threshold
(filter), then optionally crop to that range in editor mode:

```
sqrt(accX**2 + accY**2 + accZ**2) > 2.0
```

**Region filter** — only the tail of the recording past sample 100 while the
signal is active (filter):

```
index > 100 and abs(gyroZ) > 30
```
