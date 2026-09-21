// ============================================
// sample-data.js — 練習用のサンプル学校データ
// 実在しない学校・実在しない教員名で作った一式。
//
// 方針: 「まず完成するところを見てもらう」ためのデータなので、
// 難しい条件（支援学級の交流同期・出講日の強い制限）はあえて入れていない。
// どれも余裕を食いつぶして解けなくなる要因のため。
// それらは Step 5〜6 で自分で足して、条件が厳しくなる様子を試せる。
//
// 週の骨格と週コマ数は、新規作成時の初期値（timetable-generator.js の
// DEFAULT_HOURS）と同じ構成にそろえてある。標準授業時数に合わせるため、
// 1年の音楽・美術と3年の技術・家庭は隔週交代（音美・技家）で端数を吸収する。
// ============================================
window.TG_SAMPLE = (function () {
    'use strict';

    // --- 教員（すべて架空の名前） ---
    const T = {
        tanaka: 't-01', yamamoto: 't-02',        // 国語
        ito: 't-03', mori: 't-04',               // 社会
        sato: 't-05', watanabe: 't-06',          // 数学
        takahashi: 't-07', kato: 't-08',         // 理科
        suzuki: 't-09', nakamura: 't-10',        // 英語
        kobayashi: 't-11', tamura: 't-12',       // 保健体育
        yoshida: 't-13',                         // 音楽（非常勤）
        yamada: 't-14',                          // 美術
        matsumoto: 't-15',                       // 技術（非常勤）
        shimizu: 't-16',                         // 家庭
        inoue: 't-17'                            // 支援学級担任
    };

    // 出講できない時間を「出られる曜日」から作る（非常勤用）
    const PERIODS = { mon: 6, tue: 6, wed: 6, thu: 6, fri: 5 };
    function naExcept(okDays) {
        const na = [];
        Object.keys(PERIODS).forEach(d => {
            if (okDays.indexOf(d) >= 0) return;
            for (let p = 1; p <= PERIODS[d]; p++) na.push(d + '-' + p);
        });
        return na;
    }

    const teachers = [
        { id: T.tanaka, name: '田中', type: 'full', homeroom: '1-1', na: [], gradeGroup: '1' },
        { id: T.sato, name: '佐藤', type: 'full', homeroom: '1-2', na: [], gradeGroup: '1' },
        { id: T.suzuki, name: '鈴木', type: 'full', homeroom: '2-1', na: [], gradeGroup: '2' },
        { id: T.takahashi, name: '高橋', type: 'full', homeroom: '2-2', na: [], gradeGroup: '2' },
        { id: T.ito, name: '伊藤', type: 'full', homeroom: '3-1', na: [], gradeGroup: '3' },
        { id: T.watanabe, name: '渡辺', type: 'full', homeroom: '3-2', na: [], gradeGroup: '3' },
        { id: T.yamamoto, name: '山本', type: 'full', homeroom: '', na: [], gradeGroup: 'other' },
        { id: T.mori, name: '森', type: 'full', homeroom: '', na: [], gradeGroup: 'other' },
        { id: T.kato, name: '加藤', type: 'full', homeroom: '', na: [], gradeGroup: 'other' },
        { id: T.nakamura, name: '中村', type: 'full', homeroom: '', na: [], gradeGroup: 'other' },
        { id: T.kobayashi, name: '小林', type: 'full', homeroom: '', na: [], gradeGroup: 'other' },
        { id: T.tamura, name: '田村', type: 'full', homeroom: '', na: [], gradeGroup: 'other' },
        { id: T.inoue, name: '井上', type: 'full', homeroom: 'sc:sc-1', na: [], gradeGroup: 'other' },
        // 隔週交代（音美・技家）は2名が同じコマを分け合うため、2名とも非常勤だと
        // 出講日が重なる曜日だけに置き先が限られる。ペアの片方は常勤にして余白を残す
        { id: T.yamada, name: '山田', type: 'full', homeroom: '', na: [], gradeGroup: 'other' },
        { id: T.shimizu, name: '清水', type: 'full', homeroom: '', na: [], gradeGroup: 'other' },
        // 非常勤は「週に1日だけ来られない」程度にとどめてある
        { id: T.yoshida, name: '吉田', type: 'part', homeroom: '', na: naExcept(['mon', 'tue', 'wed', 'thu']), gradeGroup: 'other' },
        { id: T.matsumoto, name: '松本', type: 'part', homeroom: '', na: naExcept(['mon', 'tue', 'wed', 'thu']), gradeGroup: 'other' }
    ];

    // --- 担当割り（クラス軸） ---
    // 各教科を2人で分担する。担任は「自分の学級の自分の教科」を必ず持つ
    // （変動枠の「学年職員の教科」は担任の教科から充てるため）
    const P = {
        '1-1': { 国語: T.tanaka, 社会: T.ito, 数学: T.watanabe, 理科: T.takahashi, 英語: T.suzuki },
        '1-2': { 国語: T.yamamoto, 社会: T.mori, 数学: T.sato, 理科: T.kato, 英語: T.nakamura },
        '2-1': { 国語: T.tanaka, 社会: T.ito, 数学: T.sato, 理科: T.kato, 英語: T.suzuki },
        '2-2': { 国語: T.yamamoto, 社会: T.mori, 数学: T.watanabe, 理科: T.takahashi, 英語: T.nakamura },
        '3-1': { 国語: T.tanaka, 社会: T.ito, 数学: T.sato, 理科: T.takahashi, 英語: T.suzuki },
        '3-2': { 国語: T.yamamoto, 社会: T.mori, 数学: T.watanabe, 理科: T.kato, 英語: T.nakamura }
    };

    function classPlan(base, pe, grade) {
        const a = {
            国語: [base.国語], 社会: [base.社会], 数学: [base.数学],
            理科: [base.理科], 英語: [base.英語],
            保健体育: [pe],
            音楽: [T.yoshida], 美術: [T.yamada]
        };
        // 1年の音楽・美術は年45時間ずつで週1コマに収まらない。
        // はみ出した分を音美（B週の隔週交代）にまとめ、音楽・美術の2名が週交代で担当する
        if (grade === 1) a['音美'] = [T.yoshida, T.yamada];
        // 3年の技術・家庭は合計で年35時間。技家1コマにまとめ、2名が週交代で担当する
        if (grade === 3) {
            a['技家'] = [T.matsumoto, T.shimizu];
        } else {
            a['技術'] = [T.matsumoto];
            a['家庭'] = [T.shimizu];
        }
        return a;
    }

    const assignments = {
        '1-1': classPlan(P['1-1'], T.kobayashi, 1),
        '1-2': classPlan(P['1-2'], T.kobayashi, 1),
        '2-1': classPlan(P['2-1'], T.kobayashi, 2),
        '2-2': classPlan(P['2-2'], T.tamura, 2),
        '3-1': classPlan(P['3-1'], T.tamura, 3),
        '3-2': classPlan(P['3-2'], T.tamura, 3),
        'sc:sc-1': {}   // 支援学級は在籍0名で始める（Step 6 で生徒を足すと同期条件が効き始める）
    };

    return {
        step: 1,
        // 架空の学校名。年度はあえて入れない（normalizeState がその年の年度で埋めるので、
        // サンプルに焼き込むと来年には古い年度が出てしまう）
        schoolName: 'サンプル中学校',
        skeleton: {
            periods: { mon: 6, tue: 6, wed: 6, thu: 6, fri: 5 },
            // 隔週交代（音美・技家）はB週が2種類ある3週サイクルで成り立つ
            cycleWeeks: 3,
            varSlot: { day: 'tue', period: 6 }
        },
        classes: { 1: 2, 2: 2, 3: 2 },
        fixed: {
            same: true,
            items: {
                '学活': { day: 'mon', period: 1 },
                '道徳': { day: 'fri', period: 1 },
                '総合': { day: 'tue', period: 5 },
                '総合2': { day: 'tue', period: 6 }
            },
            perGrade: {}
        },
        // 変動枠（火6）: 2・3年は総合が年70時間なので毎週総合にする。
        // 1年は総合が年50時間で毎週にすると多すぎるため、A週だけ総合にし、
        // B1・B2週は「学年職員の教科」に回して端数を合わせる
        varContent: {
            'A': { 1: '総合', 2: '総合', 3: '総合' },
            'B1': { 1: '学年職員の教科', 2: '総合', 3: '総合' },
            'B2': { 1: '学年職員の教科', 2: '総合', 3: '総合' }
        },
        // 各学年とも合計29コマ（週の枠数ちょうど）。新規作成時の初期値と同じ構成。
        // 2・3年の総合2は固定の火5＋変動枠の火6。1年の総合はA週だけ2コマになる
        hours: {
            1: { '国語': 4, '社会': 3, '数学': 4, '理科': 3, '音楽': 1, '美術': 1, '音美': 1, '保健体育': 3, '技術': 1, '家庭': 1, '技家': 0, '英語': 4, '道徳': 1, '総合': 1, '学活': 1 },
            2: { '国語': 4, '社会': 3, '数学': 3, '理科': 4, '音楽': 1, '美術': 1, '音美': 0, '保健体育': 3, '技術': 1, '家庭': 1, '技家': 0, '英語': 4, '道徳': 1, '総合': 2, '学活': 1 },
            3: { '国語': 3, '社会': 4, '数学': 4, '理科': 4, '音楽': 1, '美術': 1, '音美': 0, '保健体育': 3, '技術': 0, '家庭': 0, '技家': 1, '英語': 4, '道徳': 1, '総合': 2, '学活': 1 }
        },
        pe: { separate: false, pairs: [] },
        solver: { budgetMin: 3, abMode: 'exact' },
        teachers: teachers,
        assignments: assignments,
        support: {
            classes: [{ id: 'sc-1', name: '支援1組' }],
            students: [],                            // 在籍0名（Step 6 で追加して試せる）
            jiritsu: { hours: 0, deductions: [] },
            seitan: { hours: 0 },
            hours: {}
        },
        rooms: [
            { name: '理科室', count: 2, capacity: 1, subject: '理科' },
            { name: '音楽室', count: 1, capacity: 1, subject: '音楽' },
            { name: '美術室', count: 1, capacity: 1, subject: '美術' },
            { name: '技術室', count: 1, capacity: 1, subject: '技術' },
            { name: '調理室', count: 1, capacity: 1, subject: '家庭' },
            { name: '体育館', count: 1, capacity: 2, subject: '保健体育' },
            { name: 'グラウンド', count: 1, capacity: 2, subject: '保健体育' }
        ],
        soft: {
            selected: ['pe_am', 'subject_spread'],
            hard: [],
            gapMax: 1
        }
    };
})();
