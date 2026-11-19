# ATシミュレーター

[index.html](index.html) をブラウザで開くと、液晶風の画面でATを進められます。ビルドや依存パッケージは不要です。GitHub Pages で配信する場合は、`index.html`、`sim.js`、`img/` があるブランチのルートを配信元にします。

## 操作

- **1G進む**で、CZ・特化・引き戻し待ちを含めて1ゲームずつ消化します。成立役と払い出しを液晶の下に表示します。
- **10G進む**で最大10ゲームを消化します。**次のCZまで進む**は、次のCZ突入が決まったゲームかAT終了で止まります。停止時点でCZの1G目はまだ消化していません。
- シード欄に整数を入力して **新しいATを開始** を押すと、0Gから始まります。同じシードで同じ抽選を再現できます。初期シードは `20261118` です。
- 液晶には残りATゲーム数、ATの獲得差枚、カウンタと加算方式、Vストックの弱・強の内訳を表示します。フリーズは発生ゲームに表示されます。まとめて進めた場合も直近のイベントをログで確認できます。

演出背景は `img/` 内の6枚のJPEGを使用します。引き戻し待ちではセット消化の背景を使い、画面内の状態名で区別します。

## エンジン

初回は純増3枚モードの100G、以後は50G単位で強いストックから優先して消化します。テーブルには各セット消化ゲームのプラス差枚だけを加算します。エンディングは区間差枚が+2,200枚を超えると始まり、+2,400枚以上まで最終ゲームの超過分を含めて払い出します。フリーズ、32Gの引き戻し、区間切断、加速の抽選順序は `reference/at.py` に準拠します。

```js
const { createSession, simulate } = require("./sim.js");
const seed = 20261118;
const session = createSession(seed);

while (!session.state.done) session.step();
console.log(session.result); // simulate({ seed, trials: 1 })[0] と同じ全項目
```

ブラウザでは `ATSimulator.createSession(seed, options)` を使えます。セッションは同じシードから始まるバッチの先頭試行に対応します。オプションはバッチAPIと共通で、`startNet`、`maxSets`、`parameters` を指定できます。ブラウザUIでは既定の条件を使用します。

- `session.step()` は `{ game, role, payout, net, mode, events }` を返します。`mode` はそのゲームを消化したモード、`net` はそのゲームの差枚です。終了後は `null` を返します。
- `session.state` は最新の状態を返します。`mode` は表示中のモード、`nextMode` は次のゲームを消化するモードで、フリーズ演出中に区別できます。残りG数（`remaining`）、純増（`rate`）、カウンタと閾値（`counter`、`threshold`）、弱・強ストック（`stocks`）、プール数（`pool`）、AT差枚と区間差枚（`net`、`zoneNet`）、テーブル名（`table`）、加速状態（`acceleration`）を含みます。
- `session.result` は終了時にバッチと同じ形式で全結果を返します。消化中は `null` です。

## 検証

```sh
node sim.js
```

ステップ実行で1回につき1G進むことと、対応するバッチ試行の最終結果が全項目で一致することを132試行で確認します。改修前のバッチ結果から保存したハッシュを使い、既定条件10,000試行と、加速・報酬設定・固定開始差枚・セット上限などを含む追加768試行についても全項目の一致を確認します。

Python版を再実行して、既定条件10,000試行のAT差枚を試行ごとに比較できます。

```sh
python3 -B -c 'import json; from reference.at import simulate; print(json.dumps({"net": [r.net for r in simulate()]}))' > /tmp/at-python.json
node sim.js /tmp/at-python.json
```

| 指標 | Python・JavaScript共通 |
| --- | ---: |
| 平均差枚 | +2,572.9073枚 |
| 中央値 | 768.5枚 |
| エンディング到達率 | 23.64% |
| 平均セット数 | 12.3082 |
