// ============================================
// solver-worker.js — 生成エンジンをワーカースレッドで動かす入り口
//
// 時間割の探索は数十秒かかることがあり、メインスレッドで回すと
// その間ページが固まる瞬間ができる（スクロールも中止ボタンも利かない）。
// ここに載せ替えることで、探索中も画面は応答し続ける。
//
// やり取り（メイン → ワーカー）:
//   { type: 'run', method: 'solve'|'solveEscalating'|'analyzeRelaxations', state, opts }
//   { type: 'cancel' }  … 実行中の探索へ中断を伝える（solver の shouldCancel が拾う）
// （ワーカー → メイン）:
//   { type: 'progress', data }  … solver の onProgress をそのまま中継
//   { type: 'done', result }
//   { type: 'error', message }
// ============================================
'use strict';

// メインページと同じバージョンクエリで solver を読み込む（?v= はワーカー自身のURLから継承）
importScripts('solver.js' + (self.location.search || ''));

let cancelRequested = false;

self.onmessage = async event => {
    const msg = event.data || {};
    if (msg.type === 'cancel') {
        cancelRequested = true;
        return;
    }
    if (msg.type !== 'run') return;

    cancelRequested = false;
    // 進捗は1試行ごとに来る（毎秒数十回）。全部送るとメッセージのコピーと
    // 受信処理だけでメインスレッドが塞がり、ワーカーに載せた意味がなくなる。
    let lastProgressAt = 0;
    try {
        const result = await self.TimetableSolver[msg.method](msg.state, Object.assign({}, msg.opts, {
            onProgress: data => {
                const now = Date.now();
                if (now - lastProgressAt < 100) return;
                lastProgressAt = now;
                self.postMessage({ type: 'progress', data });
            },
            shouldCancel: () => cancelRequested
        }));
        self.postMessage({ type: 'done', result });
    } catch (error) {
        self.postMessage({ type: 'error', message: String((error && error.message) || error) });
    }
};
