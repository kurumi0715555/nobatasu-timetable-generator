// ============================================
// timetable-generator.js（NOBATASU tools 版）
// 入力ウィザード9ステップ + 検証表示 + JSON書き出し
// 生成エンジンは js/solver.js。結果は board.html（手動編集ボード）用JSONに書き出せる
// ============================================
(function () {
    'use strict';

    const STORAGE_KEY = 'timetable-generator/v3/state';

    const SUBJECTS = ['国語', '社会', '数学', '理科', '音楽', '美術', '音美', '保健体育', '技術', '家庭', '技家', '英語', '道徳', '総合', '学活'];
    // 隔週交代教科: 2名の担当を登録し、週で交代する（コマとしては1枠）
    const BIWEEKLY_PAIRS = { '技家': ['技術', '家庭'], '音美': ['音楽', '美術'] };
    const DAYS = [['mon', '月'], ['tue', '火'], ['wed', '水'], ['thu', '木'], ['fri', '金']];
    const GRADES = [1, 2, 3];

    // 週コマ数プリセット【B週（ベース週）・変動枠込みで入力する】
    // 総合: 2・3年=週2（固定1＋変動枠の毎週総合）、1年=週1（A週は変動枠で+1され総合2になる）
    // 隔週交代枠（音美・技家）は3週サイクル向けの機能（B1週とB2週で構成教科を交代する）。
    // 標準授業時数は1年の音楽・美術が45時間ずつ、3年の技術・家庭が合計35時間で、
    // どちらも週1コマの固定枠だけでは年間時数がきっちり合わない（1年は35時間分足りず、
    // 3年は技術か家庭のどちらかに寄せると片方がゼロになる）。既定を3週サイクルにして
    // 音美・技家へ振り分けることで、この端数をB1/B2の交代で正しく吸収する
    // （2週以下は「B1とB2で交代」が成り立たないため、Step 4 で入力を止めている）
    // 全学年 合計29コマ（=週の枠数）ちょうどが正しい入力
    const DEFAULT_HOURS = {
        1: { '国語': 4, '社会': 3, '数学': 4, '理科': 3, '音楽': 1, '美術': 1, '音美': 1, '保健体育': 3, '技術': 1, '家庭': 1, '技家': 0, '英語': 4, '道徳': 1, '総合': 1, '学活': 1 },
        2: { '国語': 4, '社会': 3, '数学': 3, '理科': 4, '音楽': 1, '美術': 1, '音美': 0, '保健体育': 3, '技術': 1, '家庭': 1, '技家': 0, '英語': 4, '道徳': 1, '総合': 2, '学活': 1 },
        3: { '国語': 3, '社会': 4, '数学': 4, '理科': 4, '音楽': 1, '美術': 1, '音美': 0, '保健体育': 3, '技術': 0, '家庭': 0, '技家': 1, '英語': 4, '道徳': 1, '総合': 2, '学活': 1 }
    };

    const HOMEROOM_SUBJECTS = ['学活', '道徳', '総合'];

    const SOFT_PRESETS = [
        { id: 'part_time_gap', label: '非常勤の1日の空きコマを制限する（飛び石配置を避ける）' },  // gapMax で許容数を設定
        { id: 'part_time_days', label: '非常勤の出講日数をできるだけ少なくまとめる' },
        { id: 'grade_block', label: '教科担当の1日の授業は同じ学年をなるべく連続させる（1年→3年→1年のような行き来を避ける）' },
        { id: 'pe_am', label: '体育はできるだけ午前に入れる' },
        { id: 'pe_overlap', label: '体育を同じ時間に重ねない（体育館・グラウンドの取り合いを避ける）' },
        { id: 'subject_spread', label: '同じ教科を毎回同じ時限に置かない（縦並びを避ける）※同じ日に2コマは常に禁止' },
        { id: 'subject_pm', label: '同じ教科が午後（5・6限）に偏らないようにする（午前≧午後ならOK。午前0・午後3以上は強い違反）' },
        { id: 'teacher_gap', label: '教員の空きコマを曜日間で平準化する（常勤のみ。非常勤は5dの個別条件で管理）' },
        { id: 'no_gap_zero_day', label: '空きコマゼロの日を作らない（常勤のみ。非常勤は5dの個別条件で管理）' },
        { id: 'jiritsu_sync', label: '複数の支援学級の自立活動を同じ時間に揃える' },
        { id: 'no_special_seq', label: '移動教室（特別教室）の授業を3連続させない（2連続は許容）' },
        { id: 'am_pm_balance', label: 'クラスごとに主要教科の午前・午後の偏りをなくす' },
        { id: 'no_hard_monday1', label: '月曜1限に負荷の高い教科を置かない' },
        { id: 'week1_safe', label: '週1コマの教科は行事で潰れやすい曜日・時限を避ける' }
    ];

    // 優先順位リスト等に出す表示名（パラメータ付き条件はここで値を埋め込む）
    // ソフト条件の「違反数の数え方」（結果画面の達成状況表に表示）
    const SOFT_DESC = {
        pe_am: '午後（5限以降）に置かれた保健体育のコマ数',
        pe_overlap: '同じ時間に保健体育が2件以上重なっている数（施設の容量内でも数える）',
        no_hard_monday1: '月曜1限に置かれた主要教科のコマ数',
        week1_safe: '月曜または最終限に置かれた週1コマ教科の数',
        subject_spread: '同じ学級で同じ教科が同じ時限に縦並びした数',
        subject_pm: '学級×教科ごとの「午後のコマ数が午前より多い超過分」（午前2・午後1はOK。超過3以上=例: 午前0午後3は【要修正】として重み増）',
        no_special_seq: '移動教室（特別教室）の授業が3連続している箇所の数（2連続は数えない）',
        am_pm_balance: '主要教科の午後コマ数が目安の割合から外れた分の合計',
        grade_block: '教科担当の1日の中で学年が行き来した回数（例: 1年→2年→1年 = 1）。Step 8 の先生ごとの重み（不要=数えない／特に重視=3倍）を掛けます',
        teacher_gap: '常勤教員ごとの「1日の空きコマ数の最大と最小の差」の合計（非常勤は対象外・5dの個別条件で管理）。Step 8 の先生ごとの重みを掛けます',
        no_gap_zero_day: '空きコマゼロの日の数（常勤×日。非常勤は対象外）。Step 8 の先生ごとの重みを掛けます',
        part_time_gap: '非常勤の1日の空きコマが上限を超えた分の合計',
        part_time_days: '非常勤の出講日数の合計（少ないほど良い）',
        jiritsu_sync: '複数の支援学級の自立活動が同じ時刻に揃っていないコマ数'
    };

    function softLabel(id) {
        if (id && id.indexOf('part:') === 0 && window.TimetableSolver && window.TimetableSolver.partItemLabel) {
            return window.TimetableSolver.partItemLabel(state, id);
        }
        if (id === 'part_time_gap') {
            return '非常勤の1日の空きコマは' + (state.soft.gapMax != null ? state.soft.gapMax : 1) +
                'コマ以内（例: 1・3・5限のような飛び石配置を避ける）';
        }
        const p = SOFT_PRESETS.find(x => x.id === id);
        return p ? p.label : id;
    }

    // ---------- state ----------

    // 年度の既定値。時間割は年明け（1〜3月）に「次の年度」の分を作ることが多いので、
    // 年度の一般的な数え方（1〜3月は前年度）ではなく西暦の今年をそのまま既定にする。
    // 2027年2月に開けば 2027年度＝いま作ろうとしている年度になる。
    function defaultSchoolYear() {
        return new Date().getFullYear();
    }

    // 年度の選択肢。手入力だと「8」（令和8年）と書かれて西暦とずれる事故が起きるので選択式にする。
    // 読み込んだ設定ファイルが範囲外の年度でも、その年度が選択肢から消えないように足しておく
    function schoolYearOptions() {
        const now = defaultSchoolYear();
        const years = [];
        for (let y = now - 1; y <= now + 3; y += 1) years.push(y);
        const saved = Number(state.schoolYear);
        if (saved && !years.includes(saved)) years.push(saved);
        return years.sort((a, b) => a - b);
    }

    function defaultState() {
        return {
            step: 1,
            // 配付物（印刷・Excel）の見出しに入れる。学校名は任意入力で、
            // 未入力でも生成・出力できる（教員の手間を増やさないため必須にしない）
            schoolName: '',
            schoolYear: defaultSchoolYear(),
            // 初期プリセット: 金曜のみ5限・他は6限（週29コマ）・3週サイクル（A/B1/B2）
            // 変動枠は火6限。固定総合（火5）と合わせて「火5・6の総合ブロック」になる
            // （2・3年=毎週総合で週2コマ、1年=A週のみ総合・B週は学年職員の教科）。
            // 3週にしているのは、DEFAULT_HOURS の音美・技家（1年の音楽美術・3年の技術家庭）が
            // B1/B2の交代を前提にしているため（2週以下では隔週交代が使えない）
            skeleton: {
                periods: { mon: 6, tue: 6, wed: 6, thu: 6, fri: 5 },
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
                    '総合2': { day: 'tue', period: 6 }  // 総合の2コマ目（週2コマの学年=2・3年のみ使用）
                },
                perGrade: {}
            },
            varContent: {},   // weekLabel -> grade -> subject
            hours: JSON.parse(JSON.stringify(DEFAULT_HOURS)),
            pe: { separate: false, pairs: [] },  // 体育: false=男女一緒（1クラス単位）/ true=男女別（2クラス合同・教員別）。pairs=[[cidA,cidB],...]
            // budgetMin: 探索時間の上限（分・システム上限10分） / abMode: A週とB週のズレ許容（exact/repair/free）
            solver: { budgetMin: 3, abMode: 'exact' },
            teachers: [],       // {id, name, type, homeroom, na:['mon-3',...]}（Step 5 で登録）
            assignments: {},    // classId -> subject -> [teacherId, teacherId2]（Step 5 で登録）
            support: {
                // 初期プリセット: 特別支援学級を1学級登録
                classes: [{ id: 'sc-1', name: '支援1組' }],  // {id, name}（担任は Step 5 の担任設定から導出）
                students: [], // {id, label, supportClassId, exchangeClass, subjects:{subj:'support'|'exchange'}}
                jiritsu: { hours: 1, deductions: [] },   // 初期値: 自立は週1・充当なし（時数はそのまま入力）
                seitan: { hours: 1 },                     // 生活単元学習: 週1・担任担当・全生徒同時
                hours: { 'sc-1': { '国語': 3, '数学': 3, '英語': 3 } }
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
            soft: { selected: [], gapMax: 1 }  // gapMax: 非常勤の1日の空きコマ許容数
        };
    }

    // ---------- 数値入力のガード ----------

    // 画面の <input type="number"> に書いた min / max は、キーボード入力とペーストを止めてくれない。
    // 「99クラス」「時限数に 1e9」がそのまま state に入ると、描画のループや配列確保でブラウザごと固まる。
    // 数値は必ずこの表の範囲へ丸めてから state に入れること（値は HTML の min / max と必ず揃える）。
    const NUM_RANGE = {
        periods:      { min: 0, max: 8,  fallback: 0 },   // 曜日ごとの時限数（Step 1）
        classes:      { min: 0, max: 12, fallback: 0 },   // 1学年のクラス数（Step 1）
        // 週サイクル（Step 1・選択式）。上限は3。
        // 4週は「選べるのに成果物には出ない」状態だった（一覧表・印刷・Excel のいずれも
        // A週・B週（B1・B2）の3枠しか作れず、B3週がまるごと消える）ため選択肢から外した。
        cycleWeeks:   { min: 1, max: 3,  fallback: 1 },
        hours:        { min: 0, max: 8,  fallback: 0 },   // 通常学級の週コマ数（Step 4）
        supportHours: { min: 0, max: 8,  fallback: 0 },   // 支援学級の週コマ数（Step 5c）
        partPrep:     { min: 0, max: 20, fallback: 0 },   // 非常勤の準備の時間（Step 5d・空欄=制限なし）
        partDay:      { min: 0, max: 9,  fallback: 0 },   // 非常勤の1日のコマ数（Step 5d・0=制限なし）
        jiritsu:      { min: 0, max: 6,  fallback: 0 },   // 自立活動・生活単元の週コマ数（Step 6）
        roomCount:    { min: 0, max: 9,  fallback: 0 },   // 教室・施設の数（Step 7）
        roomCap:      { min: 1, max: 9,  fallback: 1 },   // 1室あたり同時クラス数（Step 7）
        gapMax:       { min: 0, max: 2,  fallback: 1 },   // 非常勤の1日の空きコマ許容数（Step 8）
        // 探索時間の上限（分）。max は SOLVER_MAX_MIN と同じ値にすること
        // （SOLVER_MAX_MIN は宣言がずっと下なので、読み込み時に走るこの表からは参照できない）
        budgetMin:    { min: 1, max: 5,  fallback: 3 },
        schoolYear:   { min: 2000, max: 2100, fallback: 0 }  // 年度（Step 1・fallback はその年で埋める）
    };

    // ---------- 名前欄の文字数の上限 ----------

    // 画面の maxlength と、読み込み時に切り詰める sanitizeState の長さは必ず同じ値にすること。
    // 揃っていないと「入力したときは全部表示されていたのに、ブラウザを閉じて開き直したら
    // 名前が黙って短くなっていた」（配付物の見出しが変わる）という壊れ方をする。
    // 画面側は下の TEXT_MAX を maxlength に埋め、sanitizeState 側も同じ表を見ている。
    const TEXT_MAX = {
        schoolName: 60,   // 学校名（Step 1）
        name: 40          // 先生・支援学級・生徒・教室の名前（Step 1・5・6・7）
    };

    // 数値をひとつ、必ず整数の範囲内に丸める。
    // 空欄・未設定・NaN・Infinity は fallback、小数は切り捨て、範囲外は min / max に寄せる。
    // Number('1e9') のような指数表記や '0x10'、JSON から来た配列・真偽値もここで潰れる。
    // 空欄を Number() に渡すと 0 になってしまうので、数値に直す前にはじいておく。
    function clampInt(raw, min, max, fallback) {
        const v = typeof raw === 'number' ? raw : String(raw == null ? '' : raw).trim();
        if (v === '') return fallback;
        const n = Number(v);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, Math.trunc(n)));
    }

    // 数値入力欄を state につなぐ共通処理。
    // 入力中（input）は state だけ丸め、確定（change）で表示も丸めた値に揃える。
    // 打っている途中に表示を書き換えると打ち直せなくなるため、表示の補正は確定時だけにしている。
    function bindNumField(inp, range, apply) {
        if (!inp) return;
        const read = () => clampInt(inp.value, range.min, range.max, range.fallback);
        inp.addEventListener('input', () => apply(read()));
        inp.addEventListener('change', () => {
            const v = read();
            // 画面の数字と保存された数字を食い違わせない（丸めたことはここで教員に見える）
            if (String(v) !== String(inp.value).trim()) inp.value = v;
            apply(v);
        });
    }

    // 受け取った設定を「型」と「値の範囲」の面から洗い直す入口ガード（多層防御の1枚目）。
    // 設定JSONは同僚に配って読み戻す前提で、localStorage も書き換えられうる。
    // 「中身は壊れている・細工されているかもしれない」前提で、
    // ID・名前は文字列に、コマ数などは画面と同じ上下限の整数に必ず落としてから先へ渡す。
    // ここを通した後でも表示側の esc()／toNum() は外さない（片方に頼らない）。

    // sanitizeState が「教員に黙って変えてはいけない値」を丸めたときの記録（直近1回分）。
    // 丸めたこと自体は正しくても、何も言わずに設定が変わっていると現場が混乱するので、
    // その設定を実際に採用した側（読み込み・読み戻し）がここを見て画面に知らせる。
    let lastSanitizeReport = { cycleWeeksTrimmed: false };

    // 4週サイクルで保存されていたデータを3週として読み込んだときに立てるフラグと、その案内文。
    // Step 1 のサイクル欄のそばに出し、教員が自分でサイクルを選び直したら消す。
    // 宣言をここに置いているのは、読み込み時（loadState）が先に走るため
    // （下の方に置くと、まだ用意できていない変数に触って読み込みごと失敗する）。
    let cycleWeeksTrimmedNotice = false;
    const CYCLE_TRIMMED_MSG =
        '保存されていた「4週サイクル」は選べなくなったため、「3週サイクル」として読み込みました。' +
        '（一覧表・印刷・Excel のどれも A週・B週（B1・B2）までしか作れず、4週目が出せないためです）' +
        '下の「サイクル」で必要な設定を選び直してください。';

    function sanitizeState(s) {
        lastSanitizeReport = { cycleWeeksTrimmed: false };
        const DAY_KEYS = DAYS.map(([k]) => k);
        // 文字列: 制御文字は画面にもExcelにも出す意味がないので落とし、長さも常識的な範囲で切る
        const str = (v, max) => String(v == null ? '' : v)
            .replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max || 120);
        const num = (v, range) => clampInt(v, range.min, range.max, range.fallback);
        const pick = (v, allowed, fallback) => (allowed.indexOf(v) >= 0 ? v : fallback);
        const obj = v => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
        const arr = v => Array.isArray(v) ? v : [];

        // 配付物の見出し（Step 1）。
        // 年度は「令和8年のつもりで 8」のような値も来うるので、西暦として無理のある数はその年で埋める
        s.schoolName = str(s.schoolName, TEXT_MAX.schoolName);   // 画面の maxlength と同じ値
        const yr = clampInt(s.schoolYear, 0, 9999, 0);
        s.schoolYear = (yr >= NUM_RANGE.schoolYear.min && yr <= NUM_RANGE.schoolYear.max) ? yr : defaultSchoolYear();

        // 週の骨格（Step 1）
        const sk = s.skeleton = obj(s.skeleton);
        const per = obj(sk.periods);
        sk.periods = {};
        DAY_KEYS.forEach(k => { sk.periods[k] = clampInt(per[k], NUM_RANGE.periods.min, NUM_RANGE.periods.max, 6); });
        // 4週サイクルで保存された古いデータは3週として読み替える。
        // 「読み替えました」と伝えないと、教員は4週のつもりのまま作業を続けてしまう
        if (clampInt(sk.cycleWeeks, 1, 99, 1) > NUM_RANGE.cycleWeeks.max) lastSanitizeReport.cycleWeeksTrimmed = true;
        sk.cycleWeeks = num(sk.cycleWeeks, NUM_RANGE.cycleWeeks);
        const vs0 = obj(sk.varSlot);
        sk.varSlot = { day: pick(vs0.day, DAY_KEYS, 'wed'), period: clampInt(vs0.period, 1, NUM_RANGE.periods.max, 6) };

        // 通常学級のクラス数（Step 1）
        const cl0 = obj(s.classes);
        s.classes = {};
        GRADES.forEach(g => { s.classes[g] = num(cl0[g], NUM_RANGE.classes); });

        // 固定コマ（Step 2）
        const fx = s.fixed = obj(s.fixed);
        fx.same = fx.same !== false;
        const slot = o => ({ day: pick(obj(o).day, DAY_KEYS, 'mon'), period: clampInt(obj(o).period, 1, NUM_RANGE.periods.max, 1) });
        fx.items = obj(fx.items);
        Object.keys(fx.items).forEach(k => { fx.items[k] = slot(fx.items[k]); });
        fx.perGrade = obj(fx.perGrade);
        Object.keys(fx.perGrade).forEach(k => {
            const m = obj(fx.perGrade[k]);
            const out = {};
            GRADES.forEach(g => { if (m[g]) out[g] = slot(m[g]); });
            fx.perGrade[k] = out;
        });

        // 変動枠の中身（Step 3。週 → 学年 → 教科名）
        const vc = obj(s.varContent);
        s.varContent = {};
        Object.keys(vc).forEach(w => {
            const row = obj(vc[w]);
            const out = {};
            Object.keys(row).forEach(g => { out[g] = str(row[g], 40); });
            s.varContent[str(w, 8)] = out;
        });

        // 週コマ数（Step 4）
        const hr0 = obj(s.hours);
        s.hours = {};
        GRADES.forEach(g => {
            const row = obj(hr0[g]);
            s.hours[g] = {};
            SUBJECTS.forEach(sub => { s.hours[g][sub] = num(row[sub], NUM_RANGE.hours); });
        });

        // 体育の合同ペア（Step 4）
        const pe = s.pe = obj(s.pe);
        pe.separate = !!pe.separate;
        pe.pairs = arr(pe.pairs).filter(Array.isArray).map(p => [str(p[0], 16), str(p[1], 16)]);

        // 教員（Step 5a・5d）
        s.teachers = arr(s.teachers).map(t => {
            const o = obj(t);
            // 所属学年が未設定のデータは、あとで normalizeState が担任クラスから導出する。
            // ここで 'other' に固定すると、その導出が効かなくなってしまう
            const gg = (o.gradeGroup == null || o.gradeGroup === '')
                ? '' : pick(str(o.gradeGroup, 8), ['1', '2', '3', 'other'], 'other');
            const out = Object.assign({}, o, {
                id: str(o.id, 64),
                name: str(o.name, TEXT_MAX.name),   // 画面の maxlength と同じ値
                type: pick(o.type, ['full', 'part'], 'full'),
                homeroom: str(o.homeroom, 64),
                gradeGroup: gg,
                na: arr(o.na).map(x => str(x, 16))
            });
            // 非常勤の条件は持っている先生だけ整える（無い先生に空の設定を足さない）
            if (o.part && typeof o.part === 'object') {
                const p = o.part;
                out.part = Object.assign({}, p, {
                    lunch: pick(p.lunch, ['any', 'am_only'], 'any'),
                    // 空欄（''）＝制限なしの意味なので、空欄はそのまま残す
                    prepWeek: (p.prepWeek === '' || p.prepWeek == null) ? '' : num(p.prepWeek, NUM_RANGE.partPrep),
                    dayMin: num(p.dayMin, NUM_RANGE.partDay),
                    dayMax: num(p.dayMax, NUM_RANGE.partDay)
                });
            }
            return out;
        }).filter(t => t.id);   // IDのない教員は担当割りと結びつかないので捨てる

        // 担当割り（Step 5b・5c。クラス → 教科 → 教員ID）
        const as0 = obj(s.assignments);
        s.assignments = {};
        Object.keys(as0).forEach(cid => {
            const row = obj(as0[cid]);
            const out = {};
            Object.keys(row).forEach(sub => { out[str(sub, 40)] = arr(row[sub]).map(x => str(x, 64)); });
            s.assignments[str(cid, 64)] = out;
        });

        // 支援学級（Step 1・6）
        const sp = s.support = obj(s.support);
        sp.classes = arr(sp.classes)
            // name の長さは画面の maxlength と同じ値
            .map(sc => Object.assign({}, obj(sc), { id: str(obj(sc).id, 64), name: str(obj(sc).name, TEXT_MAX.name) }))
            .filter(sc => sc.id);
        sp.students = arr(sp.students).map(st => {
            const o = obj(st);
            const sj = obj(o.subjects);
            const out = {};
            SUBJECTS.forEach(sub => { out[sub] = sj[sub] === 'support' ? 'support' : 'exchange'; });
            return Object.assign({}, o, {
                id: str(o.id, 64), label: str(o.label, TEXT_MAX.name),   // label は画面の maxlength と同じ値
                supportClassId: str(o.supportClassId, 64),
                exchangeClass: str(o.exchangeClass, 64), subjects: out
            });
        }).filter(st => st.id);
        const jr = sp.jiritsu = obj(sp.jiritsu);
        jr.hours = clampInt(jr.hours, NUM_RANGE.jiritsu.min, NUM_RANGE.jiritsu.max, 1);
        jr.deductions = arr(jr.deductions).map(d => str(d, 40));
        sp.seitan = Object.assign({}, obj(sp.seitan), {
            hours: clampInt(obj(sp.seitan).hours, NUM_RANGE.jiritsu.min, NUM_RANGE.jiritsu.max, 1)
        });
        const sh0 = obj(sp.hours);
        sp.hours = {};
        Object.keys(sh0).forEach(scId => {
            const row = obj(sh0[scId]);
            const out = {};
            Object.keys(row).forEach(sub => {
                // 未入力（null）のまま残す。0 を書き込むと Step 5c の初期値の自動提案が効かなくなる
                if (row[sub] == null) return;
                out[str(sub, 40)] = num(row[sub], NUM_RANGE.supportHours);
            });
            sp.hours[str(scId, 64)] = out;
        });

        // 特別教室（Step 7）
        s.rooms = arr(s.rooms).map(r => {
            const o = obj(r);
            return Object.assign({}, o, {
                name: str(o.name, TEXT_MAX.name), subject: str(o.subject, 40),   // name は画面の maxlength と同じ値
                count: num(o.count, NUM_RANGE.roomCount), capacity: num(o.capacity, NUM_RANGE.roomCap)
            });
        });

        // 条件の優先順位・先生ごとの重み（Step 8）
        const sf = s.soft = obj(s.soft);
        sf.gapMax = num(sf.gapMax, NUM_RANGE.gapMax);
        sf.selected = arr(sf.selected).map(x => str(x, 64));
        sf.hard = arr(sf.hard).map(x => str(x, 64));
        if (s.priorities) {
            s.priorities = {
                order: arr(obj(s.priorities).order).map(x => str(x, 64)),
                hard: arr(obj(s.priorities).hard).map(x => str(x, 64))
            };
        }
        // 無い場合は足さない（空の入れ物を増やすと生成結果の再利用判定＝署名がずれる）
        if (s.teacherCondWeights) {
            const cw0 = obj(s.teacherCondWeights);
            s.teacherCondWeights = {};
            Object.keys(cw0).forEach(cond => {
                const row = obj(cw0[cond]);
                const out = {};
                Object.keys(row).forEach(tid => {
                    out[str(tid, 64)] = pick(row[tid], ['off', 'normal', 'strong', 'hard'], 'normal');
                });
                s.teacherCondWeights[str(cond, 64)] = out;
            });
        }

        // 探索の設定（Step 9）
        const sv = s.solver = obj(s.solver);
        sv.budgetMin = num(sv.budgetMin, NUM_RANGE.budgetMin);
        sv.abMode = pick(sv.abMode, ['exact', 'repair', 'free'], 'exact');
        s.step = clampInt(s.step, 1, 10, 1);
        return s;
    }

    // 保存や書き出しから読み戻した設定を、いまのバージョンの形に整える。
    // 古い保存データにも、他の学校から渡された設定ファイルにも同じように効く。
    function normalizeState(s) {
        if (!s || typeof s !== 'object') return null;
        sanitizeState(s);   // 型と値の範囲の洗い直し（配布JSON・localStorage の両方が必ずここを通る）
        {
            s.pe = s.pe || { separate: false, pairs: [] };
            s.pe.pairs = s.pe.pairs || [];
            s.fixed = s.fixed || { same: true, items: {}, perGrade: {} };
            s.fixed.items['総合2'] = s.fixed.items['総合2'] || { day: 'tue', period: 6 };
            s.soft = s.soft || { selected: [] };
            if (s.soft.gapMax == null) s.soft.gapMax = 1;
            s.soft.hard = s.soft.hard || [];  // 「絶対」に格上げした条件
            s.support = s.support || { classes: [], students: [], jiritsu: { hours: 1, deductions: [] } };
            s.support.hours = s.support.hours || {};
            s.support.seitan = s.support.seitan || { hours: 1 };  // 生活単元学習（初期値: 週1）
            // 教員の所属学年（未設定は担任クラスから導出、なければ「その他」）
            (s.teachers || []).forEach(t => {
                if (!t.gradeGroup) t.gradeGroup = (t.homeroom && /^[123]-/.test(t.homeroom)) ? t.homeroom[0] : 'other';
            });
            // 旧名「担任の教科」→「学年職員の教科」への移行
            Object.keys(s.varContent || {}).forEach(w => {
                Object.keys(s.varContent[w] || {}).forEach(g => {
                    if (s.varContent[w][g] === '担任の教科') s.varContent[w][g] = '学年職員の教科';
                });
            });
            s.hours = s.hours || {};
            GRADES.forEach(g => {
                s.hours[g] = s.hours[g] || {};
                SUBJECTS.forEach(sub => { if (s.hours[g][sub] == null) s.hours[g][sub] = 0; });
            });
            return s;
        }
    }

    // 読み込んだJSONが「このツールで書き出した設定ファイル」らしいかを確かめる。
    // 判定は必ず normalizeState / sanitizeState に通す **前** の生データで行うこと。
    // sanitizeState は足りない項目を既定値で作って埋めるので、通したあとでは
    // 無関係なJSON（{"a":1} のようなもの）まで「正しい設定ファイル」に見えてしまう。
    // それを取り込んでしまうと、確認画面で「はい」を押した教員の入力が丸ごと消える。
    // 一方で厳しすぎると昔書き出した正しいファイルまで断ってしまうため、
    // 書き出し側（設定をJSONで書き出す＝state をそのまま保存）が必ず持っている
    // 「週の骨格（skeleton.periods）」と「学級数（classes）」だけを確認する。
    function looksLikeSettingsFile(raw) {
        const isPlainObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
        const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
        if (!isPlainObj(raw)) return false;                                   // 配列・null・数値・文字列は対象外
        if (!own(raw, 'skeleton') || !own(raw, 'classes')) return false;      // 継承した同名プロパティは数えない
        if (!isPlainObj(raw.skeleton) || !isPlainObj(raw.classes)) return false;
        if (!own(raw.skeleton, 'periods') || !isPlainObj(raw.skeleton.periods)) return false;
        // 曜日ごとの時限数が1曜日分も無いファイルは、このツールが書き出したものではない
        return DAYS.some(([k]) => own(raw.skeleton.periods, k));
    }

    // ---------- 自動保存の健康状態 ----------
    // プライベートモード・サイトデータのブロック・容量超過などで localStorage が使えないことがある。
    // このツールは各所で「自動保存されます」と案内しているので、保存できていないのを黙って握ると
    // 教員が安心してタブを閉じ、半日かけた入力と時間割をまるごと失う。失敗している間だけ画面に出す。
    let storageOk = true;
    function noteStorageError(e) {
        const wasOk = storageOk;
        if (wasOk) console.error('[timetable-generator] 自動保存に失敗しました', e);   // 技術的詳細はコンソールへ
        storageOk = false;
        renderStorageWarn();
        // 保存できなくなるのは Step 9 で時間割ができた直後や Step 10 の手直しの最中で、
        // そのとき教員は画面のずっと下（結果表・編集盤）を見ている。上端の警告は視界に入らない。
        // そこで「できていた保存ができなくなった瞬間」の1回だけ、警告まで画面を送る。
        // 毎回送ると手直しのたびに見ていた場所を奪われて邪魔になるので、切り替わった時だけにする。
        if (wasOk) {
            const bar = document.getElementById('tgStorageWarn');
            if (bar) bar.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }
    function noteStorageOk() {
        if (!storageOk) { storageOk = true; renderStorageWarn(); }   // 空きが戻れば警告を消す
    }
    function renderStorageWarn() {
        const bar = document.getElementById('tgStorageWarn');
        if (!bar) return;
        bar.hidden = storageOk;
        if (storageOk) { bar.innerHTML = ''; syncStorageWarnOffset(); return; }
        // 案内するのは「あとで本当に元に戻せる手段」だけにする。
        // 時間割の「JSONで保存」はこのツールに読み込み口が無く、戻す手立てにならないのでここには書かない。
        bar.innerHTML = '<strong>自動保存ができていません。</strong>' +
            'ブラウザの設定（プライベートモードや、サイトデータの保存をブロックする設定）か、保存容量の上限が原因です。' +
            'このままページを閉じたり再読み込みしたりすると、入力内容と作成した時間割は残りません。<br>' +
            '作業を残すには、Step 9 の「設定をJSONで書き出す」（入力した条件。次回「設定をJSONから読み込む」で続きから作業できます）と、' +
            'Step 9・10 の「Excelで書き出す」（できあがった時間割そのもの）の2つを、ファイルに保存してください。';
        syncStorageWarnOffset();
    }
    // 貼り付いた警告の高さぶんだけ、下のステッパーと手直しの操作バーの貼り付き位置をずらす。
    // 同じ位置に貼ると重なって、どちらも読めなくなる。文章量と画面幅で高さが変わるので実測する。
    function syncStorageWarnOffset() {
        const bar = document.getElementById('tgStorageWarn');
        const h = (bar && !bar.hidden) ? Math.round(bar.getBoundingClientRect().height) + 8 : 0;   // +8 は下の余白
        document.documentElement.style.setProperty('--tg-warn-h', h + 'px');
    }
    // 画面幅が変わると警告の行数（＝高さ）も変わるので、出ている間だけ測り直す
    window.addEventListener('resize', () => { if (!storageOk) syncStorageWarnOffset(); });
    // 「自動保存されます」という案内文。保存できていないときは逆の案内に差し替える
    // （保存できていないのに「閉じても大丈夫」と書くのが一番まずい）。
    // ふだんの案内は薄い文字のヒント、保存できていないときは △ の付いた警告と、
    // 見た目そのものを変える。同じ体裁のまま中身だけ正反対にすると読み飛ばされる。
    // 戻り値は「そのまま画面に足せる HTML」。呼び出し側は <p class="hint"> の中に入れず、
    // 段落と並べて置くこと（警告は段落の外に出す必要がある）。
    function autoSaveNote(what) {
        const w = what || '結果';
        if (storageOk) return '<p class="hint">' + w + 'は自動保存されるので、ブラウザを閉じても続きから作業できます。</p>';
        return '<div class="tg-warn"><strong>いまこのブラウザでは自動保存ができません。</strong>' +
            'ページを閉じると' + w + 'は残りません。' +
            'Step 9 の「設定をJSONで書き出す」（入力した条件。次回「設定をJSONから読み込む」で続きから作業できます）と、' +
            '「Excelで書き出す」（できあがった時間割そのもの）で、ファイルに残してください。</div>';
    }

    function loadState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            const loaded = raw ? normalizeState(JSON.parse(raw)) : null;
            // 4週サイクルのまま保存されていた場合は3週に読み替えている。Step 1 でその旨を出す
            if (loaded && lastSanitizeReport.cycleWeeksTrimmed) cycleWeeksTrimmedNotice = true;
            return loaded;
        } catch (e) {
            // 保存データが壊れているだけ（SyntaxError）なら読み飛ばせばよい。
            // それ以外は localStorage 自体が使えない＝この先の保存も必ず失敗するので警告を出す
            if (!(e instanceof SyntaxError)) noteStorageError(e);
            return null;
        }
    }

    function save() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
            noteStorageOk();
        } catch (e) {
            noteStorageError(e);   // 容量超過等。黙って握ると「入力は自動保存されます」が嘘になる
        }
        staffPlanCache = null;  // 学年職員の教科の計画を再計算させる
        // 条件が変わったら古い生成結果は信用できないので破棄する
        invalidateSolverResult();
    }

    let state = loadState() || defaultState();
    let lastResult = null;      // 直近の生成結果（条件変更で無効化）
    const RESULT_KEY = 'timetable-generator/v3/result';

    // 生成結果の自動保存。リロード・翌日でも Step 9/10 の続きから手直しできる。
    // 条件（Step 1〜8）が変わっていたら古い結果は復元しない。案2・案3は容量節約のため保存しない。
    function saveResultToStorage() {
        try {
            if (!lastResult) { localStorage.removeItem(RESULT_KEY); return; }
            localStorage.setItem(RESULT_KEY, JSON.stringify({
                sig: solverStateSig,
                result: { ...lastResult, alternatives: [] }
            }));
            noteStorageOk();
        } catch (e) {
            noteStorageError(e);   // ここが失敗するのは「手直しの成果が消える」ということ。必ず知らせる
        }
    }
    function restoreResultFromStorage() {
        try {
            const raw = localStorage.getItem(RESULT_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (!parsed || !parsed.result || parsed.sig !== stateSignature()) return;  // 条件が変わっていたら破棄
            // 保存データが壊れている（または細工されている）場合に描画側で落ちないよう、
            // 結果画面が前提にしている形だけは確かめてから採用する
            const rr = parsed.result;
            if (!rr.cells || typeof rr.cells !== 'object' ||
                !Array.isArray(rr.errors) || !Array.isArray(rr.warnings) ||
                !Array.isArray(rr.unplaced) || !Array.isArray(rr.varSlotIssues)) return;
            lastResult = parsed.result;
            solverStateSig = parsed.sig;
        } catch (e) {
            if (!(e instanceof SyntaxError)) noteStorageError(e);   // 壊れた保存データは無視。読めない環境だけ警告
        }
    }

    // 手直しモード（📌ここに入れたい／🔒これは確定／あとは詰将棋）の状態
    const freshEditUi = () => ({
        on: false, mode: 'pin',
        sel: null,              // 選択中のコマ {lid, cid, d, p, subject}
        locks: new Set(),       // 🔒された lessonId（一度📌したコマも以後ここに入る）
        changed: new Set(),     // 直近の編集で動いたセルのキー（B週・色付け用）
        changedA: new Set(),    // 同（A週）
        prev: null,             // 直前の編集前の結果（1手戻す用）
        ignored: new Set(),     // 「無視する」にした違反（表示上の整理。次の生成でリセット）
        awPins: [],             // A週専用コマ（充当）のA週内での移動先（編集のたびに再適用して保持）
        softDelta: null,        // 直近の手直しでの「できれば」違反の増減と新規項目
        manual: null,           // 手動連鎖モード { active, grid, floating[], history[] }
        teachersOpen: true,     // 手直しページの教員別一覧（最初から表示・現場要望）
        busy: false, msg: ''
    });
    let editUi = freshEditUi();
    const EDIT_FIXED_SUBJECTS = new Set(['学活', '道徳', '総合']);
    let solverRunning = false;
    let activeAlt = 0;          // 表示中の案（0=最良案、1〜2=別案）

    // 表示中の案のセル（案タブで切り替え）
    function activeCells() {
        if (activeAlt > 0 && lastResult && lastResult.alternatives && lastResult.alternatives[activeAlt - 1]) {
            return lastResult.alternatives[activeAlt - 1].cells;
        }
        return lastResult ? lastResult.cells : {};
    }
    // 表示中の案のA週グリッド（ソルバが構築・修復したもの。null なら従来の差し替え表示）
    function activeAWeek() {
        if (activeAlt > 0 && lastResult && lastResult.alternatives && lastResult.alternatives[activeAlt - 1]) {
            return lastResult.alternatives[activeAlt - 1].aWeek;
        }
        return lastResult ? lastResult.aWeek : null;
    }
    // 週別の表示セル: A週はソルバ構築のA週グリッドを優先（resolved=true なら差し替え解決済み）
    function weekCellsFor(week) {
        const aw = activeAWeek();
        if (editUi.manual && editUi.manual.active && week === 'B') {
            return { cells: editUi.manual.grid, resolved: false };   // 手動連鎖の作業盤
        }
        if (week === 'A' && aw) return { cells: aw.cells, resolved: true };
        return { cells: activeCells(), resolved: false };
    }

    // ---------- utils ----------

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    // 画面に出す数値の正規化。
    // このツールは設定JSONを同僚に配って読み戻す運用で、localStorage からも復元する。
    // 数値のつもりの欄に文字列が入っていることは普通に起こるので、
    // HTMLに埋める前に必ず数値へ落とす（esc() では「数値欄に文字列が残る」事故は防げない）。
    function toNum(v, fallback) {
        const n = Number(v);
        return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
    }

    function dayLabel(key) {
        const d = DAYS.find(x => x[0] === key);
        // 未知のキー（壊れた設定ファイル等）をそのまま画面へ出さない。
        // 呼び出し側はどこも esc() を通していないため、ここで無害化しておく（HTML用と割り切る）
        return d ? d[1] : esc(String(key == null ? '' : key));
    }

    // 配付物（印刷・Excel）の見出し。学校名は任意入力なので、未入力なら年度と
    // 「時間割」だけにする。学校名の入るはずの場所が空いたままの見出しを配る相手に見せないため
    function docTitle() {
        const parts = [];
        if (Number(state.schoolYear)) parts.push(state.schoolYear + '年度');
        const name = (state.schoolName || '').trim();
        if (name) parts.push(name);
        parts.push('時間割');
        return parts.join(' ');
    }

    function weekLabels() {
        const n = state.skeleton.cycleWeeks;
        if (n <= 1) return ['毎週'];
        if (n === 2) return ['A', 'B'];
        return ['A'].concat(Array.from({ length: n - 1 }, (_, i) => 'B' + (i + 1)));
    }

    function hasVarSlot() {
        return state.skeleton.cycleWeeks > 1;
    }

    // ---------- 生成エンジンの呼び出し（ワーカースレッド優先） ----------
    // 探索をワーカーに載せ、実行中もページが固まらないようにする。
    // file:// で直接開いた場合などワーカーを作れない環境では、従来どおり
    // このスレッドで直接実行する（結果は同じで、探索中の操作感だけ劣る）。
    //
    // opts はワーカーへそのまま送るため「データだけ」にすること。
    // onProgress / shouldCancel のような関数は hooks で受け取り、メッセージに変換して中継する。

    function assetVersionQuery() {
        const el = document.querySelector('script[src*="timetable-generator.js"]');
        const m = el && el.src.match(/\?v=[^&]+/);
        return m ? m[0] : '';
    }

    let solverWorkerBroken = false;   // 一度でも起動に失敗したら、このセッションでは直接実行に切り替える

    function callSolverDirect(method, stateCopy, opts, hooks) {
        return window.TimetableSolver[method](stateCopy, Object.assign({}, opts, {
            onProgress: hooks && hooks.onProgress,
            shouldCancel: hooks && hooks.shouldCancel
        }));
    }

    function callSolver(method, stateCopy, opts, hooks) {
        if (solverWorkerBroken || typeof Worker === 'undefined') {
            return callSolverDirect(method, stateCopy, opts, hooks);
        }
        return new Promise((resolve, reject) => {
            let worker;
            try {
                worker = new Worker('js/solver-worker.js' + assetVersionQuery());
            } catch (e) {
                solverWorkerBroken = true;
                resolve(callSolverDirect(method, stateCopy, opts, hooks));
                return;
            }
            const onProgress = hooks && hooks.onProgress;
            const shouldCancel = hooks && hooks.shouldCancel;
            // 中止ボタンはフラグを立てるだけなので、こちらで定期的に見てワーカーへ伝える
            const cancelTimer = shouldCancel ? setInterval(() => {
                if (shouldCancel()) worker.postMessage({ type: 'cancel' });
            }, 200) : null;
            let settled = false;
            const finish = fn => value => {
                if (settled) return;
                settled = true;
                if (cancelTimer) clearInterval(cancelTimer);
                worker.terminate();
                fn(value);
            };
            const done = finish(resolve);
            const fail = finish(reject);
            // 進捗の描画も間引く（最新値だけ残して150msに1回）。進捗表示は
            // 「動いていることが分かる」のが目的で、全試行分を描く必要はない
            let pendingProgress = null;
            let progressScheduled = false;
            const flushProgress = () => {
                progressScheduled = false;
                if (pendingProgress !== null && onProgress && !settled) {
                    const data = pendingProgress;
                    pendingProgress = null;
                    onProgress(data);
                }
            };
            worker.onmessage = event => {
                const msg = event.data || {};
                if (msg.type === 'progress') {
                    pendingProgress = msg.data;
                    if (!progressScheduled) {
                        progressScheduled = true;
                        setTimeout(flushProgress, 150);
                    }
                    return;
                }
                if (msg.type === 'done') done(msg.result);
                else if (msg.type === 'error') fail(new Error(msg.message));
            };
            worker.onerror = () => {
                // 起動や読み込みの失敗。このスレッドでの直接実行に切り替えて続行する
                if (settled) return;
                settled = true;
                if (cancelTimer) clearInterval(cancelTimer);
                worker.terminate();
                solverWorkerBroken = true;
                // 直接実行まで失敗した場合も Promise を必ず決着させる（生成オーバーレイが閉じなくなるため）
                try {
                    resolve(callSolverDirect(method, stateCopy, opts, hooks));
                } catch (error) {
                    reject(error);
                }
            };
            worker.postMessage({ type: 'run', method, state: stateCopy, opts });
        });
    }

    // 「A以外の週」の画面表示名。内部キーはまとめて 'B' だが、見出しは週数に合わせる。
    // 1週=毎週 / 2週=B週 / 3週=B週（B1・B2）
    function bWeekDisplay() {
        const n = Number(state.skeleton.cycleWeeks) || 1;
        if (n <= 1) return '毎週';
        if (n === 2) return 'B週';
        return 'B週（' + Array.from({ length: n - 1 }, (_, i) => 'B' + (i + 1)).join('・') + '）';
    }

    // 書き出し（Excel・JSON）が対応できない骨格かどうか。対応外なら教員向けの説明文、問題なければ '' を返す。
    // Step 1・Step 9・結果画面の3か所で同じ文言を出し、「全部入力し終えてから断られる」のを防ぐ。
    //   ・時限数: Excel は Step 1 の時限数どおりに列を組むので 7〜8限でも書き出せる（旧「6限まで」制限は撤廃）
    //   ・週サイクル: 画面の一覧表・印刷・Excel のどれも A週・B週（B1・B2）の3枠しか作れないので3週が上限。
    //     4週は Step 1 の選択肢から外したのでここには来ないはずだが、古い保存データや
    //     読み込んだ設定ファイルから入ってくる場合の保険として判定を残している。
    // where に 'step1' を渡すと、Step 1 の「サイクル」の真下に出す用の文面になる。
    // その場所で「Step 1 の「サイクル」を…」と書くと、今見ている欄を遠回しに指す妙な案内になるため
    function exportLimitNote(where) {
        if (Number(state.skeleton.cycleWeeks) > 3) {
            return '4週サイクルには対応していません（作れるのは A週・B週（B1・B2）までです）。' +
                (where === 'step1' ? '上の「サイクル」' : 'Step 1 の「サイクル」') + 'を3週以下に変えてください。';
        }
        // 隔週交代（音美・技家）はB週が2種類ある3週サイクル専用。2週以下のまま生成・書き出しすると
        // 「画面はB1/B2で交代・Excelは片方の教科固定」という矛盾した配付物になるため、ここで必ず止める。
        // 通常はサイクル変更時に自動で振り替える（tgCycle の change）ので、ここに来るのは
        // 古い保存データや読み込んだ設定ファイル経由の場合だけ
        const biweeklyGrades = biweeklyGradesUnderThreeWeeks();
        if (biweeklyGrades.length) {
            // 2週以下では Step 4・5c の音美・技家がロックされ「振り分け直し」は実行できないので、
            // 実行できる手順（3週にする／3週を経由して自動振替に任せる）だけを案内する
            return '隔週交代の教科（音美・技家）は3週サイクルでのみ使えます: ' + biweeklyGrades.join('・') + '（Step 4・Step 5c）。' +
                (where === 'step1' ? '上の「サイクル」' : 'Step 1 の「サイクル」') + 'を3週にすると、そのまま使えます。' +
                '2週以下で使う場合は、3週へ変えたあと元のサイクルに戻すと、残ったコマ数を自動で音楽・技術へ振り替えます。';
        }
        return '';
    }

    // 2週以下なのに隔週交代（音美・技家）のコマ数が残っている対象（学年・支援学級）の表示名。空配列なら問題なし
    function biweeklyGradesUnderThreeWeeks() {
        if (Number(state.skeleton.cycleWeeks) >= 3) return [];
        const hasBiweekly = h => Object.keys(BIWEEKLY_PAIRS).some(s => (Number((h || {})[s]) || 0) > 0);
        const names = GRADES.filter(g => hasBiweekly(state.hours[g])).map(g => g + '年');
        ((state.support && state.support.classes) || []).forEach(sc => {
            if (hasBiweekly((state.support.hours || {})[sc.id])) names.push(sc.name || '(無名)');
        });
        return names;
    }

    function classIds() {
        const ids = [];
        GRADES.forEach(g => {
            const n = Number(state.classes[g]) || 0;
            for (let i = 1; i <= n; i++) ids.push(g + '-' + i);
        });
        return ids;
    }

    function gradeOfClass(cid) {
        return Number(cid.split('-')[0]);
    }

    function weeklyCapacity() {
        return DAYS.reduce((sum, [k]) => sum + (Number(state.skeleton.periods[k]) || 0), 0);
    }

    function totalSlots() {
        return weeklyCapacity();
    }

    function teacherById(id) {
        return state.teachers.find(t => t.id === id) || null;
    }

    function supportClassById(id) {
        return state.support.classes.find(x => x.id === id) || null;
    }

    function supportHomeroomTeacher(scId) {
        return state.teachers.find(t => t.homeroom === 'sc:' + scId) || null;
    }

    function daySelect(cls, selected) {
        return '<select class="' + cls + '">' + DAYS.map(([k, l]) =>
            '<option value="' + k + '"' + (k === selected ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>';
    }

    function periodSelect(cls, dayKey, selected) {
        const max = Number(state.skeleton.periods[dayKey]) || 6;
        let html = '<select class="' + cls + '">';
        for (let p = 1; p <= max; p++) {
            html += '<option value="' + p + '"' + (p === Number(selected) ? ' selected' : '') + '>' + p + '限</option>';
        }
        return html + '</select>';
    }

    function subjectSelect(cls, selected, extra) {
        const opts = (extra || []).concat(SUBJECTS);
        return '<select class="' + cls + '">' + opts.map(s =>
            '<option value="' + esc(s) + '"' + (s === selected ? ' selected' : '') + '>' + esc(s) + '</option>').join('') + '</select>';
    }

    // ---------- stepper / navigation ----------

    const STEP_TITLES = ['週の骨格', '固定コマ', '変動枠', '週コマ数', '教員と担当', '支援学級', '特別教室', '条件の優先度', '生成する', '手直し'];

    function renderStepper() {
        const nav = document.getElementById('tgStepper');
        nav.innerHTML = STEP_TITLES.map((t, i) => {
            const n = i + 1;
            // 現在より前は「済み（✓）」、現在は強調。進み具合が一目で分かるように
            const cls = state.step === n ? 'active' : (n < state.step ? 'done' : '');
            const num = n < state.step ? '✓' : n;
            return '<button type="button" data-goto="' + n + '" class="' + cls + '" title="Step ' + n + ': ' + t + '">' +
                '<span class="tg-step-num">' + num + '</span>' + t + '</button>';
        }).join('');
        nav.querySelectorAll('button').forEach(b => {
            b.addEventListener('click', () => showStep(Number(b.dataset.goto)));
        });
        // 現在のステップが見切れていたら、ステッパー内だけを横スクロールして見せる
        const act = nav.querySelector('button.active');
        if (act) nav.scrollLeft = Math.max(0, act.offsetLeft - (nav.clientWidth - act.offsetWidth) / 2);
    }

    function showStep(n) {
        state.step = clampInt(n, 1, 10, 1);   // 壊れた保存データ（NaN 等）でも必ず Step 1 に戻せるように
        save();
        document.querySelectorAll('.tg-step').forEach(sec => {
            sec.classList.toggle('active', Number(sec.dataset.step) === state.step);
        });
        if (state.step !== 10) { editUi.on = false; editUi.sel = null; document.body.classList.remove('tg-editing'); }
        renderStepper();
        RENDERERS[state.step]();
        document.getElementById('prevBtn').style.visibility = state.step === 1 ? 'hidden' : 'visible';
        document.getElementById('nextBtn').style.visibility = state.step === 10 ? 'hidden' : 'visible';
        window.scrollTo({ top: 0 });
    }

    // ---------- Step 1 ----------

    // ---------- サンプルデータ（練習用） ----------

    // まだ何も入力していない人に「動くところを先に見せる」ための入り口。
    // 教員を登録した時点で用済みなので消える（自分のデータの上に出し続けない）。
    function sampleCardHtml() {
        if (!window.TG_SAMPLE) return '';
        if ((state.teachers || []).length > 0) return '';
        return '<div class="tg-sample-card">' +
            '<div class="tg-sample-body">' +
            '<h3>はじめての方へ — 練習用のデータで試せます</h3>' +
            '<p>架空の学校の条件が一式入ります。入力を飛ばして「時間割を組む」まで一通り体験できます。</p>' +
            '<ul>' +
            '<li>各学年2学級（計6学級）＋特別支援学級1（在籍0名）</li>' +
            '<li>教員17名・担当も全教科ぶん入っています</li>' +
            '<li>まず完成させて見てもらうため、難しい条件は入れていません</li>' +
            '<li>支援学級の生徒（Step 6）や隔週交代の教科（Step 4・5）は、あとから足して試せます</li>' +
            '</ul>' +
            '</div>' +
            '<div class="tg-sample-actions">' +
            '<button type="button" class="btn btn-primary btn-large" id="tgLoadSample">サンプルを読み込む</button>' +
            '<span class="hint">あとから「入力を全てリセット」で消せます</span>' +
            '</div></div>';
    }

    // サンプルを state に流し込む。いま入力中の内容がある場合だけ確認を挟む。
    function applySampleData() {
        if (!window.TG_SAMPLE) { alert('サンプルデータが読み込まれていません。'); return; }
        const hasInput = (state.teachers || []).length > 0;
        if (hasInput && !confirm('いまの入力内容を、練習用のサンプルに置き換えます。\n\nいまの入力は失われます。よろしいですか？')) return;
        const data = normalizeState(JSON.parse(JSON.stringify(window.TG_SAMPLE)));
        if (!data) { alert('サンプルデータを読み込めませんでした。'); return; }
        state = data;
        lastResult = null;
        solverStateSig = null;
        activeAlt = 0;
        editUi = freshEditUi();
        staffPlanCache = null;
        // サンプルは整合しているはずだが、ルールを変えたときに追随し忘れる余地がある
        // （実際に一度、変動枠の釣り合いが崩れたまま出荷しかけた）。ここでも通しておく
        const fix = normalizeVarRotation();
        save();
        saveResultToStorage();
        showStep(1);
        alert('サンプルを読み込みました。\nStep 1 から順に中身を見て、Step 9 の「時間割を組む」を押すと生成が始まります。'
            + (varRotationChanged(fix) ? '\n\n' + varRotationNotice(fix) : ''));
    }

    function bindSampleCard() {
        const btn = document.getElementById('tgLoadSample');
        if (!btn) return;
        btn.addEventListener('click', applySampleData);
    }

    function renderStep1() {
        const el = document.getElementById('step1Body');
        const p = state.skeleton.periods;
        el.innerHTML =
            sampleCardHtml() +
            '<div class="tg-block"><h3>学校名と年度</h3>' +
            '<div class="tg-inline-fields">' +
            '<label class="tg-field">学校名 <input type="text" id="tgSchoolName" maxlength="' + TEXT_MAX.schoolName + '" placeholder="例：〇〇中学校" value="' +
            esc(state.schoolName || '') + '" style="padding:6px 8px;width:200px"></label>' +
            '<label class="tg-field">年度 <select id="tgSchoolYear">' +
            schoolYearOptions().map(y =>
                '<option value="' + y + '"' + (Number(state.schoolYear) === y ? ' selected' : '') + '>' + y + '年度</option>'
            ).join('') +
            '</select></label>' +
            '</div>' +
            '<p class="hint">印刷とExcelの見出し・ファイル名に入ります。学校名は空欄のままでもかまいません（そのときの見出しは「年度＋時間割」だけになります）。</p></div>' +

            '<div class="tg-block"><h3>曜日ごとの時限数</h3>' +
            '<div class="tg-inline-fields">' +
            DAYS.map(([k, l]) =>
                '<label class="tg-field">' + l + '曜 <input type="number" min="0" max="8" data-day="' + k + '" value="' + toNum(p[k], 6) + '"> 限</label>'
            ).join('') +
            '</div><p class="hint" style="margin-top:8px">週合計 <strong id="tgWeekCap"></strong> コマ（標準授業時数の目安は週29コマ）。1日は8限までです。</p></div>' +

            '<div class="tg-block"><h3>通常学級のクラス数</h3>' +
            '<div class="tg-inline-fields">' +
            GRADES.map(g =>
                '<label class="tg-field">' + g + '年 <input type="number" min="0" max="12" data-grade="' + g + '" value="' + toNum(state.classes[g], 0) + '"> クラス</label>'
            ).join('') +
            '</div><p class="hint" style="margin-top:8px">1学年あたり12クラスまで。それより大きい数を入れると12に直ります。</p></div>' +

            '<div class="tg-block"><h3>特別支援学級</h3>' +
            '<div id="tgScList">' +
            state.support.classes.map(sc =>
                '<div class="tg-inline-fields" style="margin-bottom:6px" data-scid="' + esc(sc.id) + '">' +
                '<input type="text" class="tg-sc-name" maxlength="' + TEXT_MAX.name + '" placeholder="例：支援1組" value="' + esc(sc.name) + '" style="padding:6px 8px;width:160px">' +
                '<button type="button" class="btn btn-danger btn-small tg-sc-del">削除</button>' +
                '</div>'
            ).join('') +
            '</div>' +
            '<div class="tg-add-bar"><button type="button" class="btn btn-primary btn-small" id="tgAddSC">支援学級を追加</button></div>' +
            '<p class="hint">担任は Step 5（教員マスタ）で、在籍生徒と自立活動は Step 6 で設定します。</p></div>' +

            '<div class="tg-block"><h3>ローテーション（週パターン）</h3>' +
            '<div class="tg-inline-fields">' +
            '<label class="tg-field">サイクル <select id="tgCycle">' +
            // 4週は一覧表・印刷・Excel のどれも作れない（4週目がまるごと消える）ので選択肢に出さない
            [1, 2, 3].map(n => '<option value="' + n + '"' + (state.skeleton.cycleWeeks === n ? ' selected' : '') + '>' + (n === 1 ? '毎週同じ' : n + '週サイクル') + '</option>').join('') +
            '</select></label>' +
            '<span class="tg-field">週の呼び名: <strong id="tgWeekNames"></strong></span>' +
            '</div>' +
            '<div class="tg-inline-fields" style="margin-top:10px" id="tgVarSlotRow">' +
            '<span class="tg-field">変動枠の位置:</span>' +
            '<span class="tg-field">' + daySelect('tg-var-day', state.skeleton.varSlot.day) + '</span>' +
            '<span class="tg-field" id="tgVarPeriodWrap">' + periodSelect('tg-var-period', state.skeleton.varSlot.day, state.skeleton.varSlot.period) + '</span>' +
            '</div>' +
            '<p class="hint" style="margin-top:8px" id="tgVarSlotHint">変動枠 = 週によって中身が入れ替わるコマ。中身は Step 3 で設定します。</p></div>' +

            '<div id="tgExportLimit"></div>';

        function refreshCap() {
            document.getElementById('tgWeekCap').textContent = weeklyCapacity();
            document.getElementById('tgWeekNames').textContent = weekLabels().join('・');
            const varDisplay = hasVarSlot() ? '' : 'none';
            document.getElementById('tgVarSlotRow').style.display = varDisplay;
            document.getElementById('tgVarSlotHint').style.display = varDisplay;
            // 書き出せない構成はこの場で知らせる（Step 9 まで入力し終えてから断られるのを防ぐ）。
            // 4週サイクルを3週として読み込んだ場合の案内も、設定を変えた本人が見る場所なのでここに出す
            const notes = [];
            if (cycleWeeksTrimmedNotice) notes.push(['tg-warn', CYCLE_TRIMMED_MSG]);
            const limitNote = exportLimitNote('step1');   // すぐ上の「サイクル」を指す言い方にする
            // 隔週交代の残存は生成も書き出しも止まる完全なブロッカーなので、Step 9 と同じ赤で出す（深刻度を場所で変えない）
            if (limitNote) notes.push([biweeklyGradesUnderThreeWeeks().length ? 'tg-error' : 'tg-warn', limitNote]);
            // exportLimitNote() は支援学級名（自由入力）を含むため、innerHTML に入れる直前で必ずエスケープする。
            // alert() で出す側（生成・書き出しのガード）は素の文字列のままでよい
            document.getElementById('tgExportLimit').innerHTML =
                notes.map(([cls, n]) => '<div class="' + cls + '">' + esc(n) + '</div>').join('');
        }
        refreshCap();
        bindSampleCard();

        const schoolNameInput = document.getElementById('tgSchoolName');
        schoolNameInput.addEventListener('input', () => {
            state.schoolName = schoolNameInput.value;
            save();
        });
        document.getElementById('tgSchoolYear').addEventListener('change', e => {
            state.schoolYear = Number(e.target.value) || defaultSchoolYear();
            save();
        });

        // 時限数は periodSelect / buildAvailGrid のループ回数そのものなので、必ず 0〜8 に丸める
        el.querySelectorAll('input[data-day]').forEach(inp => {
            bindNumField(inp, NUM_RANGE.periods, v => {
                state.skeleton.periods[inp.dataset.day] = v;
                save(); refreshCap();
            });
        });
        // クラス数は classIds() を通して以降の全ステップの表の大きさを決める。上限超えは必ず丸める
        el.querySelectorAll('input[data-grade]').forEach(inp => {
            bindNumField(inp, NUM_RANGE.classes, v => {
                state.classes[inp.dataset.grade] = v;
                save();
            });
        });
        document.getElementById('tgAddSC').addEventListener('click', () => {
            state.support.classes.push({ id: 'sc' + Date.now(), name: '' });
            save(); renderStep1();
        });
        el.querySelectorAll('#tgScList > div').forEach(row => {
            const sc = supportClassById(row.dataset.scid);
            if (!sc) return;
            row.querySelector('.tg-sc-name').addEventListener('input', e => { sc.name = e.target.value; save(); });
            row.querySelector('.tg-sc-del').addEventListener('click', () => {
                if (!confirm((sc.name || 'この支援学級') + ' を削除しますか？')) return;
                state.support.classes = state.support.classes.filter(x => x.id !== sc.id);
                state.support.students.forEach(st => { if (st.supportClassId === sc.id) st.supportClassId = ''; });
                state.teachers.forEach(t => { if (t.homeroom === 'sc:' + sc.id) t.homeroom = ''; });
                delete state.assignments['sc:' + sc.id];
                delete state.support.hours[sc.id];
                save(); renderStep1();
            });
        });
        document.getElementById('tgCycle').addEventListener('change', e => {
            // weekLabels() が Array.from({ length: n - 1 }) を作るため、選択式でも受け取り側で丸める
            state.skeleton.cycleWeeks = clampInt(e.target.value, NUM_RANGE.cycleWeeks.min, NUM_RANGE.cycleWeeks.max, NUM_RANGE.cycleWeeks.fallback);
            cycleWeeksTrimmedNotice = false;   // 本人が選び直したので「読み替えました」の案内は役目を終える
            // 3週未満へ変えた時点で、隔週交代（音美・技家）のコマ数を構成教科へ自動で振り替える。
            // 2週以下では Step 4・5c の音美・技家がロックされ本人には直せないため、「直せない赤エラー」の
            // 状態を作らない（例: 音美1 → 音楽へ+1。片割れの美術には足さず、合計コマ数を変えない）。
            // 学年（Step 4）だけでなく支援学級（Step 5c）の週コマ数にも同じ振り替えを掛ける
            const moved = [];
            if (Number(state.skeleton.cycleWeeks) < 3) {
                // 振替先が入力欄の上限（週8コマ）を超える場合は上限で止める。超えた分を残すと
                // 「保存値と入力欄の制約が矛盾したまま直せない」状態になるため（合計の不足は Step 4 の合計チェックが拾う）
                const transfer = (hoursObj, label) => {
                    Object.keys(BIWEEKLY_PAIRS).forEach(s => {
                        const n = Number(hoursObj[s]) || 0;
                        if (!n) return;
                        const firstPair = BIWEEKLY_PAIRS[s][0];
                        const want = (Number(hoursObj[firstPair]) || 0) + n;
                        const capped = Math.min(8, want);
                        hoursObj[s] = 0;
                        hoursObj[firstPair] = capped;
                        moved.push(label + 'の' + s + n + 'コマ→' + firstPair +
                            (capped < want ? '（上限の週8コマで止めました。合計コマ数を確認してください）' : ''));
                    });
                };
                GRADES.forEach(g => { if (state.hours[g]) transfer(state.hours[g], g + '年'); });
                ((state.support && state.support.classes) || []).forEach(sc => {
                    const h = (state.support.hours || {})[sc.id];
                    if (h) transfer(h, sc.name || '(無名)');
                });
            }
            // サイクルが変わると変動枠と音美の釣り合いも変わる（週数が分母のため）。
            // 崩れた学年はここで組み直す
            const fix = normalizeVarRotation();
            const notices = [];
            if (moved.length) {
                notices.push('隔週交代の教科（音美・技家）は3週サイクル専用のため、コマ数を振り替えました:\n' + moved.join('\n'));
            }
            if (varRotationChanged(fix)) notices.push(varRotationNotice(fix));
            // 振替はコマ数だけを移すので、移した先の教科は担当が未設定のまま残る
            if (moved.length) notices.push('Step 4・Step 5c で内訳（音楽・美術／技術・家庭の配分）を、Step 5b で担当を確認してください。');
            if (notices.length) alert(notices.join('\n\n'));
            save(); refreshCap();
        });
        el.querySelector('.tg-var-day').addEventListener('change', e => {
            state.skeleton.varSlot.day = e.target.value;
            save();
            document.getElementById('tgVarPeriodWrap').innerHTML = periodSelect('tg-var-period', e.target.value, 1);
            bindVarPeriod();
        });
        function bindVarPeriod() {
            el.querySelector('.tg-var-period').addEventListener('change', e => {
                state.skeleton.varSlot.period = Number(e.target.value);
                save();
            });
        }
        bindVarPeriod();
    }

    // ---------- Step 2 ----------

    const FIXED_SUBJECTS = ['学活', '道徳', '総合'];
    const SOGO2_KEY = '総合2';

    // 総合の「固定コマ」が週2以上の学年（変動枠でまかなう分は除く）
    function sogo2Grades() {
        return GRADES.filter(g => fixedHoursOf(g, '総合') >= 2);
    }

    // Step 2 に表示する固定コマの行（総合2コマ目は該当学年がある時だけ）
    function fixedRows() {
        const rows = FIXED_SUBJECTS.map(sub => ({ key: sub, label: sub, grades: GRADES }));
        const s2g = sogo2Grades();
        if (s2g.length) rows.push({ key: SOGO2_KEY, label: '総合（2コマ目）', grades: s2g });
        return rows;
    }

    function fixedSlotOf(key, grade) {
        const f = state.fixed;
        if (!f.same && f.perGrade[key] && f.perGrade[key][grade]) return f.perGrade[key][grade];
        return f.items[key] || { day: 'mon', period: 1 };
    }

    function renderStep2() {
        const el = document.getElementById('step2Body');
        const f = state.fixed;
        f.items[SOGO2_KEY] = f.items[SOGO2_KEY] || { day: 'tue', period: 6 };
        const rows = fixedRows();
        const s2g = sogo2Grades();

        let html = '<div class="tg-block"><label class="tg-field" style="font-weight:600">' +
            '<input type="checkbox" id="tgFixedSame"' + (f.same ? ' checked' : '') + '> 全学年同じ時間にする（推奨）</label></div>';

        html += '<div class="tg-table-wrap"><table class="tg-table"><thead><tr><th>コマ</th>' +
            (f.same ? '<th>全学年</th>' : GRADES.map(g => '<th>' + g + '年</th>').join('')) +
            '</tr></thead><tbody>';

        rows.forEach(row => {
            html += '<tr><td class="tg-left"><strong>' + row.label + '</strong></td>';
            if (f.same) {
                const v = f.items[row.key] || { day: 'mon', period: 1 };
                html += '<td data-key="' + row.key + '">' + daySelect('tg-fx-day', v.day) + ' ' + periodSelect('tg-fx-period', v.day, v.period) +
                    (row.key === SOGO2_KEY && row.grades.length < GRADES.length
                        ? ' <span class="hint-inline">※' + row.grades.join('・') + '年のみ（Step 4 の総合の週コマ数から判定）</span>' : '') +
                    '</td>';
            } else {
                GRADES.forEach(g => {
                    if (!row.grades.includes(g)) { html += '<td class="tg-na">—</td>'; return; }
                    const pg = (f.perGrade[row.key] && f.perGrade[row.key][g]) || f.items[row.key] || { day: 'mon', period: 1 };
                    html += '<td data-sub="' + row.key + '" data-grade="' + g + '">' +
                        daySelect('tg-fxg-day', pg.day) + ' ' + periodSelect('tg-fxg-period', pg.day, pg.period) + '</td>';
                });
            }
            html += '</tr>';
        });
        html += '</tbody></table></div>';

        // 変動枠との重なりチェック
        const vs = state.skeleton.varSlot;
        if (hasVarSlot()) {
            const clashes = [];
            rows.forEach(row => {
                row.grades.forEach(g => {
                    const slot = fixedSlotOf(row.key, g);
                    if (slot.day === vs.day && Number(slot.period) === Number(vs.period)) {
                        clashes.push(row.label + (f.same ? '' : '（' + g + '年）'));
                    }
                });
            });
            if (clashes.length) {
                html += '<div class="tg-warn">変動枠（' + dayLabel(vs.day) + toNum(vs.period, 1) + '限・Step 1）と重なっています: ' +
                    esc([...new Set(clashes)].join('、')) + '。どちらかの位置をずらしてください。</div>';
            }
        }

        const sogoSlot = f.items['総合'];
        const vsNow = state.skeleton.varSlot;
        const adjacent = sogoSlot && hasVarSlot() && sogoSlot.day === vsNow.day &&
            Math.abs(Number(sogoSlot.period) - Number(vsNow.period)) === 1;
        html += '<p class="hint"><strong>総合の2コマ目は変動枠（' + (hasVarSlot() ? dayLabel(vsNow.day) + toNum(vsNow.period, 1) + '限・位置は Step 1' : 'Step 1 で設定') + '）に入ります。</strong>' +
            (sogoSlot ? '固定の総合（この表: ' + dayLabel(sogoSlot.day) + toNum(sogoSlot.period, 1) + '限）と' + (adjacent ? '連続になり、' : '合わせて、') : '') +
            '2・3年は毎週総合＝週2コマ（年70時間）、1年はA週のみ総合（年46.7時間≒50時間）になります。</p>' +
            '<p class="hint">学活・道徳・総合の担当は、担任が自動で割り当てられます（Step 5 で担任を設定してください）。</p>';
        el.innerHTML = html;

        document.getElementById('tgFixedSame').addEventListener('change', e => {
            f.same = e.target.checked;
            if (!f.same) {
                FIXED_SUBJECTS.concat(SOGO2_KEY).forEach(sub => {
                    f.perGrade[sub] = f.perGrade[sub] || {};
                    GRADES.forEach(g => {
                        f.perGrade[sub][g] = f.perGrade[sub][g] || Object.assign({}, f.items[sub]);
                    });
                });
            }
            save(); renderStep2();
        });

        if (f.same) {
            el.querySelectorAll('td[data-key]').forEach(td => {
                const sub = td.dataset.key;
                td.querySelector('.tg-fx-day').addEventListener('change', e => {
                    f.items[sub].day = e.target.value;
                    f.items[sub].period = 1;
                    save(); renderStep2();
                });
                td.querySelector('.tg-fx-period').addEventListener('change', e => {
                    f.items[sub].period = Number(e.target.value);
                    save(); renderStep2();
                });
            });
        } else {
            el.querySelectorAll('td[data-sub]').forEach(td => {
                const sub = td.dataset.sub, g = td.dataset.grade;
                td.querySelector('.tg-fxg-day').addEventListener('change', e => {
                    f.perGrade[sub][g].day = e.target.value;
                    f.perGrade[sub][g].period = 1;
                    save(); renderStep2();
                });
                td.querySelector('.tg-fxg-period').addEventListener('change', e => {
                    f.perGrade[sub][g].period = Number(e.target.value);
                    save(); renderStep2();
                });
            });
        }
    }

    // ---------- Step 3 ----------

    const VAR_UNUSED = '（使わない）';

    // その学年が変動枠を使うか（全週「（使わない）」なら不使用 = 変動枠の時間も通常コマ）
    function gradeUsesVar(g) {
        if (!hasVarSlot()) return false;
        return weekLabels().some(w => (((state.varContent || {})[w] || {})[g] || '学年職員の教科') !== VAR_UNUSED);
    }

    // 教員の所属学年（'1'|'2'|'3'|'other'）。未設定なら担任クラスから導出
    function gradeGroupOf(t) {
        if (t.gradeGroup) return t.gradeGroup;
        if (t.homeroom && /^[123]-/.test(t.homeroom)) return t.homeroom[0];
        return 'other';
    }

    // 表示用の教員並び: その他 → 1年 → 2年 → 3年、各グループ内は常勤→非常勤、同着は登録順
    // （登録順は Step 5a の ▲▼ で変えられる）
    function sortedTeachers() {
        const groupRank = { other: 0, '1': 1, '2': 2, '3': 3 };
        return state.teachers
            .map((t, i) => ({ t, i }))
            .sort((a, b) => {
                const ga = groupRank[gradeGroupOf(a.t)] ?? 0;
                const gb = groupRank[gradeGroupOf(b.t)] ?? 0;
                if (ga !== gb) return ga - gb;
                const ta = a.t.type === 'part' ? 1 : 0;
                const tb = b.t.type === 'part' ? 1 : 0;
                if (ta !== tb) return ta - tb;
                return a.i - b.i;
            })
            .map(x => x.t);
    }

    // 「学年職員の教科」の割り当て計画（solver.js の gradeStaffPlan を使用。
    // 同学年で教員が重複しない・交流生徒の支援教科を避ける・担任優先）。
    // state 変更のたびに save() でキャッシュを破棄する
    let staffPlanCache = null;
    function staffPlan() {
        if (!staffPlanCache) {
            staffPlanCache = (window.TimetableSolver && window.TimetableSolver.gradeStaffPlan)
                ? window.TimetableSolver.gradeStaffPlan(state) : {};
        }
        return staffPlanCache;
    }

    function gradeStaffSubjectOf(cid) {
        const p = staffPlan()[cid];
        return p ? p.subject : null;
    }
    // 互換エイリアス（旧名）
    const homeroomSubjectOf = gradeStaffSubjectOf;

    // 学年職員の教科を実際に教える教員
    function gradeStaffTeacherOf(cid, subject) {
        const p = staffPlan()[cid];
        if (p && (!subject || p.subject === subject)) return p.teacherId;
        if (!subject) return null;
        const asg = (((state.assignments || {})[cid] || {})[subject] || []).filter(Boolean);
        return asg[0] || null;
    }

    // 学年の「学年職員の授業」回転コマ数（週平均）= 音美のA週分 + 変動枠の「学年職員の教科」の週数（按分）
    function homeroomRotationPerWeek(g) {
        const labels = weekLabels();
        if (labels.length <= 1) return 0;
        let perCycle = Number(state.hours[g] && state.hours[g]['音美']) || 0;
        if (gradeUsesVar(g)) {
            labels.forEach(w => {
                if ((((state.varContent || {})[w] || {})[g] || '学年職員の教科') === '学年職員の教科') perCycle++;
            });
        }
        return perCycle / labels.length;
    }

    // 学年職員の教科の充当コマ数（週あたり整数分）。ベース週の入力からこの分が自動で差し引かれる
    function absorbOf(g) {
        return Math.floor(homeroomRotationPerWeek(g) + 1e-9);
    }

    // 変動枠に「毎週同じ実教科」が入る学年は、その教科名を返す（例: 2・3年の総合）
    // Step 4 の入力は変動枠込みなので、内部の固定分はこの教科を1コマ差し引いて求める
    function constantVarSubjectOf(g) {
        if (!hasVarSlot() || !gradeUsesVar(g)) return null;
        const subs = weekLabels().map(w => ((state.varContent[w] || {})[g]) || '学年職員の教科');
        const first = subs[0];
        if (first === '学年職員の教科' || first === VAR_UNUSED) return null;
        return subs.every(s => s === first) ? first : null;
    }

    // 内部処理用の「固定分」週コマ数（入力＝B週・変動枠込み、から変換）
    function fixedHoursOf(g, s) {
        const raw = Number(state.hours[g] && state.hours[g][s]) || 0;
        return constantVarSubjectOf(g) === s ? Math.max(0, raw - 1) : raw;
    }

    function ensureVarContent() {
        // 変動枠のデフォルト補完（想定運用: B週ベースのセオリー）
        // 変動枠は総合の2コマ目。2・3年=毎週総合（年70時間）、
        // 1年=A週のみ総合（年46.7時間≒50時間）・B週は学年職員の教科
        //
        // 「学年職員の教科」の週数は、音美のA週分と足して週ちょうど1コマ
        // （＝回転が整数）になる必要がある。音美のない学年で一部の週だけ
        // 学年職員の教科にすると回転が半端（例: 2週で0.5）になり、
        // 差し引きが噛み合わずA週だけ1コマ超過する。
        // そのため学年職員の教科を混ぜるのは、音美がある学年に限る
        weekLabels().forEach((w, wi) => {
            state.varContent[w] = state.varContent[w] || {};
            GRADES.forEach(g => {
                if (!state.varContent[w][g] || state.varContent[w][g] === VAR_UNUSED) {
                    const hasOnbi = (Number((state.hours[g] || {})['音美']) || 0) > 0;
                    state.varContent[w][g] = (hasOnbi && wi > 0) ? '学年職員の教科' : '総合';
                }
            });
        });
    }

    // 変動枠と音美の釣り合いを保つ。
    //
    // 「学年職員の教科」の週数は、音美のA週分と足して週ちょうど1コマ
    // （= homeroomRotationPerWeek が整数）になる組み合わせでしか成り立たない。
    //   音美なし: 全週が学年職員の教科、または1週もない
    //   音美あり: A週以外のすべてが学年職員の教科
    // 音美のコマ数（Step 4）や週サイクル（Step 1）を変えるとこの釣り合いが崩れ、
    // A週だけコマ数が合わない（超過・空き）状態になる。しかも数字が出るのは Step 4、
    // 直す場所は Step 3 なので、気づいても本人には直しようがない。
    // そこで崩れた学年の設定だけ捨て、ensureVarContent の既定で組み直す。
    // 釣り合っている学年は本人の設定を尊重して触らない。
    // 組み直した学年の配列を返す（呼び出し側で本人に知らせるため）
    // 教科ごとの週コマ数の上限。音美だけは週1コマまで。
    // 音美はA週にコマ数分の穴を空け、それを変動枠の1コマで埋めて釣り合う仕組みなので、
    // 週2コマ以上にすると変動枠をどう置いてもA週だけコマ数が足りなくなる
    function subjectHoursMax(sub) {
        return sub === '音美' ? 1 : NUM_RANGE.hours.max;
    }

    function normalizeVarRotation() {
        if (!hasVarSlot()) return { rebuilt: [], unresolved: [] };
        ensureVarContent();   // 未設定の週を既定で埋めてから釣り合いを見る
        const labels = weekLabels();
        const isBalanced = g => {
            const onbi = Number((state.hours[g] || {})['音美']) || 0;
            const staffWeeks = labels.filter(w => ((state.varContent[w] || {})[g]) === '学年職員の教科').length;
            const rot = (onbi + staffWeeks) / labels.length;
            return Math.abs(rot - Math.round(rot)) < 1e-9;
        };
        const rebuilt = [], unresolved = [];
        GRADES.forEach(g => {
            if (isBalanced(g)) return;
            labels.forEach(w => { if (state.varContent[w]) delete state.varContent[w][g]; });
            ensureVarContent();
            // 音美が週2コマ以上ある学年は、変動枠をどう置いても釣り合わない。
            // A週で減るのは音美のコマ数分だが、変動枠で戻せるのは1コマだけのため。
            // 組み直しでは直らないので「直した」とは言わず、本人に直してもらう
            (isBalanced(g) ? rebuilt : unresolved).push(g);
        });
        return { rebuilt, unresolved };
    }

    function varRotationChanged(fix) {
        return fix.rebuilt.length > 0 || fix.unresolved.length > 0;
    }

    // 起動時の自動修復の案内。ブラウザ標準のダイアログを使わないのは、
    // 授業直前に開いてそのまま投影する使い方があるため（docs/design-system.md §12-A A-6）。
    // 本人の操作に対する応答（Step 1・Step 4・設定の読み込み）は従来どおり alert でよい
    function showVarFixNotice(text) {
        const bar = document.getElementById('tgVarFixNotice');
        if (!bar) { alert(text); return; }   // 要素が無い環境でも案内は落とさない
        bar.hidden = false;
        bar.innerHTML = '<strong>保存されていた設定の辻褄を直しました。</strong>' +
            text.split('\n\n').map(p => '<p style="margin:6px 0">' + esc(p) + '</p>').join('') +
            '<button type="button" class="btn btn-secondary btn-small" id="tgVarFixClose">閉じる</button>';
        document.getElementById('tgVarFixClose').addEventListener('click', () => {
            bar.hidden = true;
            bar.innerHTML = '';
        });
    }

    function varRotationNotice(fix) {
        const parts = [];
        if (fix.rebuilt.length) {
            parts.push(fix.rebuilt.map(g => g + '年').join('・') + ' の変動枠（Step 3）を既定で組み直しました。' +
                '変動枠の「学年職員の教科」は、音美のA週分と合わせて週ちょうど1コマになる必要があるためです。');
        }
        if (fix.unresolved.length) {
            parts.push(fix.unresolved.map(g => g + '年').join('・') + ' は音美が週2コマ以上あるため、週のコマ数が揃いません。' +
                'A週で減るのは音美のコマ数分ですが、変動枠で戻せるのは1コマだけです。' +
                'Step 4 で音美を週1コマ以下にしてください。');
        }
        return parts.join('\n\n');
    }

    // 変動枠を含めた年間時数の換算表（35週想定・サイクル数で按分）
    function buildVarConversionTable() {
        const labels = weekLabels();
        const n = state.skeleton.cycleWeeks;
        const perWeek = 35 / n;
        let html = '<div class="tg-block"><h3>年間時数の換算（自動計算・35週想定）</h3>' +
            '<div class="tg-table-wrap"><table class="tg-table"><thead><tr><th>学年</th><th>変動枠の内訳</th><th>年間換算（固定分＋変動枠）</th></tr></thead><tbody>';
        GRADES.forEach(g => {
            const counts = {};
            labels.forEach(w => {
                const s = (state.varContent[w] && state.varContent[w][g]) || '—';
                counts[s] = (counts[s] || 0) + 1;
            });
            const breakdown = Object.entries(counts).map(([s, c]) => esc(s) + '×' + c + '週').join('、');
            // 総合は変動枠に入っていなくても常に表示（固定のみで70時間の学年もあるため）
            const convSubjects = [...new Set(
                Object.keys(counts).filter(s => s !== '学年職員の教科' && s !== VAR_UNUSED && s !== '—').concat('総合')
            )];
            const conv = convSubjects.map(s => {
                const fixedH = (Number(state.hours[g] && state.hours[g][s]) || 0) * 35;
                const varH = (counts[s] || 0) * perWeek;
                const detail = varH > 0 ? '固定' + fixedH + '＋変動' + varH.toFixed(1) : '固定のみ';
                return esc(s) + ' <strong>' + (fixedH + varH).toFixed(1) + '</strong>時間（' + detail + '）';
            }).join('<br>') || '—';
            html += '<tr><td><strong>' + g + '年</strong></td><td>' + breakdown + '</td><td class="tg-left">' + conv + '</td></tr>';
        });
        html += '</tbody></table></div>' +
            '<p class="hint">変動枠はサイクル按分（' + n + '週サイクル → 1週あたり年' + perWeek.toFixed(1) + 'コマ相当）のため、年間時数はきれいな整数になりません。' +
            '端数は行事・学期の切れ目などで吸収します。</p></div>';
        return html;
    }

    function renderStep3() {
        const el = document.getElementById('step3Body');
        const labels = weekLabels();
        const vs = state.skeleton.varSlot;
        ensureVarContent();

        let html = '<div class="tg-block">' +
            '<p>変動枠: <strong>' + dayLabel(vs.day) + '曜' + toNum(vs.period, 1) + '限</strong>（位置は Step 1 で変更）</p>' +
            '<p class="hint"><strong>この枠が「総合の2コマ目」です。</strong>固定の総合と連続にして、' +
            '2・3年は毎週総合（週2コマ＝年70時間）、1年はA週のみ総合（年46.7時間≒50時間）・B週は学年職員の教科が既定です。' +
            'A週の作成は「B週をベースに、音美コマ→学年職員の授業、変動枠→総合に差し替えるだけ」になります（B週ベースのセオリー）。</p>' +
            '<p class="hint">音美コマ（1年）のA週は自動で「学年職員の授業」に置き換わります。ここでの設定は不要です。</p></div>';

        if (labels.length === 1) {
            html += '<p class="hint">ローテーションが「毎週同じ」のため、このステップの設定は不要です。</p>';
            el.innerHTML = html;
            return;
        }

        html += '<div class="tg-table-wrap"><table class="tg-table"><thead><tr><th>週</th>' +
            GRADES.map(g => '<th>' + g + '年</th>').join('') + '</tr></thead><tbody>';
        labels.forEach(w => {
            html += '<tr><td><strong>' + esc(w) + '週</strong></td>';
            GRADES.forEach(g => {
                html += '<td data-week="' + esc(w) + '" data-grade="' + g + '">' +
                    subjectSelect('tg-vc', state.varContent[w][g], ['学年職員の教科']) + '</td>';
            });
            html += '</tr>';
        });
        html += '</tbody></table></div>' +
            '<p class="hint"><strong>推奨</strong>: 総合が入らない週は「学年職員の教科」を置くと、週パターンの切り替えで教員の予定が動きません（総合の担当も担任のため）。</p>' +
            buildVarConversionTable();
        el.innerHTML = html;

        el.querySelectorAll('td[data-week] select').forEach(sel => {
            sel.addEventListener('change', e => {
                const td = e.target.closest('td');
                state.varContent[td.dataset.week][td.dataset.grade] = e.target.value;
                save(); renderStep3();
            });
        });
    }

    // ---------- Step 4 ----------

    function ensurePePairs() {
        // ペア未設定なら学年内の隣接クラスでデフォルト生成（1-1&1-2, 1-3&1-4 …）
        if (state.pe.pairs.length > 0) return;
        GRADES.forEach(g => {
            const n = Number(state.classes[g]) || 0;
            for (let i = 1; i + 1 <= n; i += 2) {
                state.pe.pairs.push([g + '-' + i, g + '-' + (i + 1)]);
            }
        });
    }

    function pePartner(cid) {
        if (!state.pe.separate) return null;
        const pair = state.pe.pairs.find(p => p[0] === cid || p[1] === cid);
        if (!pair) return null;
        return pair[0] === cid ? pair[1] : pair[0];
    }

    function buildPePairConfig() {
        ensurePePairs();
        const cids = classIds();
        const used = {};
        state.pe.pairs.forEach(p => { used[p[0]] = true; used[p[1]] = true; });
        const unpaired = cids.filter(c => !used[c]);

        function classSel(cls, selected) {
            return '<select class="' + cls + '"><option value="">—</option>' +
                cids.map(c => '<option value="' + c + '"' + (c === selected ? ' selected' : '') + '>' + c + '</option>').join('') + '</select>';
        }

        let html = '<div style="margin-top:10px"><h3 style="font-size:0.95em;color:var(--primary-color)">合同にするクラスペア</h3>';
        state.pe.pairs.forEach((p, i) => {
            html += '<div class="tg-inline-fields" style="margin-bottom:6px" data-pairidx="' + i + '">' +
                classSel('tg-pair-a', p[0]) + ' <span>&</span> ' + classSel('tg-pair-b', p[1]) +
                ' <button type="button" class="btn btn-danger btn-small tg-pair-del">削除</button></div>';
        });
        html += '<div class="tg-add-bar"><button type="button" class="btn btn-primary btn-small" id="tgAddPair">ペアを追加</button></div>';
        if (unpaired.length) {
            html += '<div class="tg-warn">ペア未設定のクラス: ' + unpaired.join('、') + '（単独実施＝男女一緒の扱いになります）</div>';
        }
        const dup = cids.filter(c => state.pe.pairs.filter(p => p.includes(c)).length > 1);
        if (dup.length) {
            html += '<div class="tg-error">複数のペアに入っているクラス: ' + dup.join('、') + '</div>';
        }
        html += '<p class="hint">ペアの体育は同じ時間に置かれ、男子担当・女子担当が2クラス分の生徒を分担します。担当はペアのどちらかに入力すれば、もう片方にも自動で反映されます。</p></div>';
        return html;
    }

    function renderStep4() {
        const el = document.getElementById('step4Body');
        const cap = weeklyCapacity();
        const withVar = hasVarSlot();
        if (withVar) ensureVarContent();

        let html = '<div class="tg-block"><h3>体育の実施形態</h3>' +
            '<div class="tg-inline-fields">' +
            '<label class="tg-field"><input type="radio" name="tgPeMode" value="together"' + (!state.pe.separate ? ' checked' : '') + '> 男女一緒（1クラス単位）</label>' +
            '<label class="tg-field"><input type="radio" name="tgPeMode" value="separate"' + (state.pe.separate ? ' checked' : '') + '> 男女別（2クラス合同・男女で教員別）</label>' +
            '</div>' +
            (state.pe.separate ? buildPePairConfig() : '') +
            '</div>';

        // 学年×週（A週/B週）の行列で入力する。表示値＝その週の実際の週コマ数（変動枠込み）。
        // 回転枠から自動導出されるセル（音美のA週・変動枠の教科）はグレーの読み取り専用
        GRADES.forEach(g => { state.hours[g] = state.hours[g] || {}; });
        const dispVec = (g, w) => {
            const v = {};
            SUBJECTS.forEach(s => { v[s] = fixedHoursOf(g, s); });
            if (withVar && gradeUsesVar(g)) {
                let varSub = ((state.varContent[w] || {})[g]) || '学年職員の教科';
                if (varSub === VAR_UNUSED) varSub = '学年職員の教科';
                if (varSub !== '学年職員の教科') v[varSub] = (v[varSub] || 0) + 1;
            }
            if (w === 'A') v['音美'] = 0;  // 音美はB週のみ実施
            return v;
        };
        const labels = withVar ? weekLabels() : ['毎週'];
        const matrixRows = [];
        GRADES.forEach(g => {
            const groups = [];
            labels.forEach(w => {
                const vec = dispVec(g, w);
                const key = JSON.stringify(vec);
                const ex = groups.find(x => x.key === key);
                if (ex) ex.weeks.push(w); else groups.push({ key, weeks: [w], vec });
            });
            groups.forEach(gr => matrixRows.push({ g, weeks: gr.weeks, vec: gr.vec }));
        });

        html += '<div class="tg-table-wrap"><table class="tg-table"><thead><tr><th>学年</th><th>週</th>' +
            SUBJECTS.map(s => '<th>' + esc(s) + '</th>').join('') + '<th>週合計 / 目標</th></tr></thead><tbody>';
        matrixRows.forEach(row => {
            const wl2 = row.weeks.length === labels.length ? '毎週' : row.weeks.join('・') + '週';
            const total = SUBJECTS.reduce((a, s) => a + (row.vec[s] || 0), 0);
            const cls = total > cap ? 'tg-sum-ng' : (total === cap ? 'tg-sum-ok' : 'tg-sum-warn');
            const note = total > cap ? '（超過' + (total - cap) + '）' : (total < cap ? '（空き' + (cap - total) + '）' : '');
            html += '<tr><td><strong>' + row.g + '年</strong></td><td>' + esc(wl2) + '</td>';
            SUBJECTS.forEach(s => {
                const disp = row.vec[s] || 0;
                const auto = disp !== (Number(state.hours[row.g][s]) || 0);
                // 隔週交代（音美・技家）はB週が2種類ある3週サイクル専用。2週以下では入力させない
                const biweeklyLocked = BIWEEKLY_PAIRS[s] && Number(state.skeleton.cycleWeeks) < 3;
                if (auto) {
                    html += '<td class="tg-auto" title="回転枠（音美・変動枠）から自動計算">' + disp + '</td>';
                } else if (biweeklyLocked) {
                    html += '<td class="tg-auto" title="隔週交代（' + esc(s) + '）は3週サイクルで使えます（Step 1）">' + disp + '</td>';
                } else {
                    html += '<td><input type="number" min="0" max="' + subjectHoursMax(s) + '" data-grade="' + row.g + '" data-sub="' + esc(s) + '" value="' + disp + '"></td>';
                }
            });
            html += '<td class="tg-sum ' + cls + '">' + total + ' / ' + cap + note + '</td></tr>';
        });
        html += '</tbody></table></div>' +
            '<p class="hint">各週の<strong>実際の週コマ数（変動枠込み）</strong>を入力します。合計が週' + cap + 'コマちょうどで緑になります。' +
            '<span class="tg-auto" style="padding:0 6px">グレーのセル</span>は回転枠（音美のA週・変動枠の教科）から自動計算されます。' +
            '同じ学年のA週・B週で共通の教科は、どちらの行で編集しても同期します。</p>' +
            (Number(state.skeleton.cycleWeeks) >= 3
                ? '<p class="hint">隔週交代の教科は「技家」（技術/家庭）「音美」（音楽/美術）として1コマにまとめて入力し、Step 5b で2名の担当を登録してください（週交代で担当します）。' +
                  '「学年職員の授業」（音美のA週・変動枠のB週）は、各学級の学年職員（担任優先）が担当する教科の1コマ分として自動で充当されます（標準時数のまま入力）。</p>'
                : '<p class="hint">隔週交代の教科（音美＝音楽/美術・技家＝技術/家庭）は、Step 1 でサイクルを3週にすると使えます。' +
                  '2週以下では、音楽・美術（技術・家庭）をそれぞれの教科として入力してください。</p>');

        // 充当先の表示（学年職員の教科の解決結果）
        const absorbNotes = [];
        GRADES.forEach(g => {
            if (!withVar || !absorbOf(g)) return;
            const parts = classIds().filter(c => gradeOfClass(c) === g)
                .map(c => c + '=' + (gradeStaffSubjectOf(c) || '未判定'));
            if (parts.length) absorbNotes.push(g + '年: ' + parts.join('、'));
        });
        if (absorbNotes.length) {
            html += '<p class="hint"><strong>学年職員の教科の充当:</strong> ' + esc(absorbNotes.join(' ／ ')) +
                '（「未判定」は Step 5a の所属学年・担任と Step 5b の担当を設定してください）</p>';
        }

        el.innerHTML = html;

        el.querySelectorAll('input[name="tgPeMode"]').forEach(r => {
            r.addEventListener('change', () => {
                state.pe.separate = r.value === 'separate';
                save(); renderStep4();
            });
        });
        const addPairBtn = document.getElementById('tgAddPair');
        if (addPairBtn) addPairBtn.addEventListener('click', () => {
            state.pe.pairs.push(['', '']);
            save(); renderStep4();
        });
        el.querySelectorAll('div[data-pairidx]').forEach(row => {
            const i = Number(row.dataset.pairidx);
            row.querySelector('.tg-pair-a').addEventListener('change', e => {
                state.pe.pairs[i][0] = e.target.value; save(); renderStep4();
            });
            row.querySelector('.tg-pair-b').addEventListener('change', e => {
                state.pe.pairs[i][1] = e.target.value; save(); renderStep4();
            });
            row.querySelector('.tg-pair-del').addEventListener('click', () => {
                state.pe.pairs.splice(i, 1); save(); renderStep4();
            });
        });
        // 行列の入力（同一学年のA/B行は同じ値に同期するため、確定時に再描画する）
        el.querySelectorAll('input[data-grade][data-sub]').forEach(inp => {
            inp.addEventListener('change', () => {
                // 確定後すぐ描き直すので、丸めた値はそのまま画面に反映される
                state.hours[inp.dataset.grade][inp.dataset.sub] =
                    clampInt(inp.value, NUM_RANGE.hours.min, subjectHoursMax(inp.dataset.sub), NUM_RANGE.hours.fallback);
                // 音美を増減すると変動枠との釣り合いが崩れる（例: 3週で音美を0にすると
                // 学年職員の教科が2週分だけ残り、回転が 0.67 になってA週が超過する）。
                // 崩れたら組み直して知らせる（Step 3 を書き換えるため黙って直さない）
                if (inp.dataset.sub === '音美') {
                    const fix = normalizeVarRotation();
                    if (varRotationChanged(fix)) alert(varRotationNotice(fix));
                }
                save(); renderStep4();
            });
        });
    }

    // ---------- Step 5 ----------

    function applyHomeroomDefaults() {
        // 学活・道徳・総合は担任をデフォルト割当（未割当の場合のみ）
        classIds().forEach(cid => {
            state.assignments[cid] = state.assignments[cid] || {};
            const hr = state.teachers.find(t => t.homeroom === cid);
            if (!hr) return;
            HOMEROOM_SUBJECTS.forEach(s => {
                const asg = state.assignments[cid][s] || [];
                if (asg.filter(Boolean).length === 0) {
                    state.assignments[cid][s] = [hr.id];
                }
            });
        });
        // 支援学級: 自立活動・生活単元は担任をデフォルト割当
        state.support.classes.forEach(sc => {
            const key = 'sc:' + sc.id;
            state.assignments[key] = state.assignments[key] || {};
            const hr = supportHomeroomTeacher(sc.id);
            if (!hr) return;
            ['自立活動', '生活単元'].forEach(s => {
                if ((state.assignments[key][s] || []).filter(Boolean).length === 0) {
                    state.assignments[key][s] = [hr.id];
                }
            });
        });
    }

    // 非常勤の個別条件の要約と入力UI（Step 5a。すべて絶対条件として生成に反映）
    function partConfSummary(t) {
        const p = t.part || {};
        const parts = [];
        if (p.lunch === 'am_only') parts.push('午前のみ');
        if (p.prepWeek !== '' && p.prepWeek != null && !isNaN(Number(p.prepWeek))) parts.push('準備' + p.prepWeek);
        if (Number(p.dayMin) > 0) parts.push('1日' + p.dayMin + 'コマ以上');
        if (Number(p.dayMax) > 0) parts.push('1日' + p.dayMax + 'コマまで');
        return parts.length ? parts.join('・') : '未設定';
    }
    function renderStep5() {
        applyHomeroomDefaults();
        save();

        const el = document.getElementById('step5Body');
        const cids = classIds();
        const maxPeriod = Math.max(...DAYS.map(([k]) => Number(state.skeleton.periods[k]) || 0));

        // --- 5a 教員マスタ ---
        let html = '<div class="tg-block"><h3>5a. 教員マスタ</h3>';
        if (state.teachers.length === 0) {
            html += '<p class="hint">まだ教員が登録されていません。「＋教員を追加」から登録してください。</p>';
        }
        sortedTeachers().forEach(t => {
            html += '<div class="tg-teacher-card" data-tid="' + esc(t.id) + '">' +
                '<div class="tg-teacher-head">' +
                '<span class="tg-move-btns">' +
                '<button type="button" class="tg-t-up" title="上へ（同じ所属・勤務区分の中で移動）">▲</button>' +
                '<button type="button" class="tg-t-down" title="下へ">▼</button></span>' +
                '<input type="text" class="tg-t-name" maxlength="' + TEXT_MAX.name + '" placeholder="例：山田" value="' + esc(t.name) + '">' +
                '<select class="tg-t-type">' +
                '<option value="full"' + (t.type === 'full' ? ' selected' : '') + '>常勤</option>' +
                '<option value="part"' + (t.type === 'part' ? ' selected' : '') + '>非常勤</option>' +
                '</select>' +
                '<select class="tg-t-homeroom"><option value="">担任なし</option>' +
                cids.map(c => '<option value="' + c + '"' + (t.homeroom === c ? ' selected' : '') + '>' + c + '担任</option>').join('') +
                state.support.classes.map(sc =>
                    '<option value="sc:' + esc(sc.id) + '"' + (t.homeroom === 'sc:' + sc.id ? ' selected' : '') + '>' + esc(sc.name || '支援学級') + '担任</option>'
                ).join('') +
                '</select>' +
                '<select class="tg-t-grade" title="所属学年（変動枠の時間はこの学年の活動に参加する前提になります）">' +
                [['1', '1年所属'], ['2', '2年所属'], ['3', '3年所属'], ['other', 'その他']].map(([v, l]) =>
                    '<option value="' + v + '"' + (gradeGroupOf(t) === v ? ' selected' : '') + '>' + l + '</option>').join('') +
                '</select>' +
                '<button type="button" class="btn btn-danger btn-small tg-t-del">削除</button>' +
                '</div>' +
                '<details' + (t.na.length ? ' open' : '') + '><summary>出講できない時間（' + t.na.length + 'コマ）— マスをクリックで○×、曜日名クリックで1日まとめて切替</summary>' +
                buildAvailGrid(t, maxPeriod) +
                '</details>' +
                (t.type === 'part' ? '<p class="hint" style="margin:4px 0 0">非常勤の細かい条件（給食・準備時間・1日のコマ数）は下の「5d. 非常勤の条件」で設定します' +
                    (partConfSummary(t) !== '未設定' ? '（現在: ' + esc(partConfSummary(t)) + '）' : '') + '</p>' : '') +
                '</div>';
        });
        html += '<div class="tg-add-bar"><button type="button" class="btn btn-primary btn-small" id="tgAddTeacher">教員を追加</button></div></div>';

        // --- 5b 担当割り（クラス軸） ---
        html += '<div class="tg-block"><h3>5b. 担当割り（クラスごとに教科 → 担当者）</h3>' +
            '<p class="hint">学活・道徳・総合は担任が自動で入ります。' +
            (state.pe.separate ? '体育は男女別のため「男子担当」「女子担当」の2枠です。' : '2列目はTT（同時に入る2人目）用です。') + '</p>';
        if (cids.length === 0) {
            html += '<p class="hint">Step 1 でクラス数を設定してください。</p>';
        } else if (state.teachers.length === 0) {
            html += '<p class="hint">先に 5a で教員を登録してください。</p>';
        } else {
            html += '<div class="tg-class-grid">';
            cids.forEach(cid => {
                state.assignments[cid] = state.assignments[cid] || {};
                const g = gradeOfClass(cid);
                const partner = pePartner(cid);
                const gradeMates = cids.filter(c => c !== cid && gradeOfClass(c) === g);
                html += '<div class="tg-class-card" data-cid="' + cid + '"><h4>' + cid +
                    (partner ? ' <span class="badge badge-info">体育: ' + esc(partner) + 'と合同</span>' : '') +
                    (gradeMates.length ? '<button type="button" class="btn btn-secondary btn-small tg-copy-grade" title="このクラスの担当を同学年の全クラスにコピー">学年に反映</button>' : '') +
                    '</h4><table><tbody>';
                SUBJECTS.forEach(s => {
                    if ((Number(state.hours[g] && state.hours[g][s]) || 0) === 0) return; // 週0コマの教科は表示しない
                    const asg = state.assignments[cid][s] || [];
                    const unassigned = asg.filter(Boolean).length === 0;
                    const peSep = state.pe.separate && s === '保健体育';
                    const pair = BIWEEKLY_PAIRS[s];
                    html += '<tr data-sub="' + esc(s) + '"><td' + (unassigned ? ' class="tg-unassigned"' : '') + '>' + esc(s) + '</td><td>' +
                        teacherPick('tg-asg-main', asg[0], peSep ? '男子:未定' : (pair ? pair[0] + ':未定' : '未定')) + '</td><td>' +
                        teacherPick('tg-asg-sub', asg[1], peSep ? '女子:未定' : (pair ? pair[1] + ':未定' : 'TTなし')) + '</td></tr>';
                });
                html += '</tbody></table></div>';
            });
            html += '</div>';
        }
        html += '</div>';

        // --- 5c 支援学級の担当 ---
        if (state.support.classes.length) {
            html += '<div class="tg-block"><h3>5c. 支援学級の担当（教科 → 週コマ数と担当者）</h3>' +
                '<p class="hint">支援学級で行う授業の<strong>週コマ数と担当者</strong>をここで設定します（週コマ数 0 の教科は薄く表示され、時間割に入りません）。' +
                'Step 6 で生徒が「支援で受ける」設定にした教科には人数バッジが付き、週コマ数の初期値が自動で入ります。' +
                '学活・道徳・総合と自立活動・生活単元は担任が自動担当です（TTの2人目だけ追加可）。</p>' +
                '<p class="hint">自立活動の充当（Step 6 の「時数を削る教科」）は、時間割の生成時に自動で差し引かれます。' +
                'ここには<strong>控除前の週コマ数</strong>を入力してください（例: 国語4と入力・充当−1 → 生成では週3コマ）。</p>';
            if (state.teachers.length === 0) {
                html += '<p class="hint">先に 5a で教員を登録してください。</p>';
            } else {
                html += '<div class="tg-class-grid">';
                state.support.classes.forEach(sc => {
                    const key = 'sc:' + sc.id;
                    state.assignments[key] = state.assignments[key] || {};
                    state.support.hours[sc.id] = state.support.hours[sc.id] || {};
                    const hr = supportHomeroomTeacher(sc.id);
                    html += '<div class="tg-class-card" data-cid="' + esc(key) + '"><h4>' + esc(sc.name || '(無名)') +
                        ' <span class="badge badge-info">支援学級</span>' +
                        (hr ? ' <span class="hint-inline">担任: ' + esc(hr.name || '(無名)') + '</span>'
                            : ' <span class="hint-inline tg-sum-ng">担任未設定（5a）</span>') +
                        '</h4><table><tbody>';
                    // 自立活動・生活単元（時数は Step 6 の設定を表示）
                    [['自立活動', Number(state.support.jiritsu.hours) || 0],
                     ['生活単元', Number((state.support.seitan || {}).hours) || 0]].forEach(([sub, h]) => {
                        const sAsg = state.assignments[key][sub] || [];
                        html += '<tr data-sub="' + sub + '"' + (h === 0 ? ' class="tg-dim"' : '') + '><td>' + sub + '</td>' +
                            '<td class="tg-sc-hours-cell">週' + h + '</td><td>' +
                            teacherPick('tg-asg-main', sAsg[0], '担任:未定') + '</td><td>' +
                            teacherPick('tg-asg-sub', sAsg[1], 'TTなし') + '</td></tr>';
                    });
                    SUBJECTS.forEach(s => {
                        if (HOMEROOM_SUBJECTS.includes(s)) return; // 担任自動のため非表示
                        const cnt = state.support.students.filter(st => st.supportClassId === sc.id && st.subjects[s] === 'support').length;
                        let hoursVal = state.support.hours[sc.id][s];
                        if (hoursVal == null) {
                            if (cnt > 0) {
                                // 支援で受ける生徒がいる教科は学年最大の時数を初期値として保存
                                hoursVal = Math.max(...GRADES.map(g => Number(state.hours[g] && state.hours[g][s]) || 0));
                                state.support.hours[sc.id][s] = hoursVal;
                            } else {
                                // 生徒がいない教科は 0 表示のみ（保存しない = 後から生徒を追加したら自動提案が効く）
                                hoursVal = 0;
                            }
                        }
                        const asg = state.assignments[key][s] || [];
                        const unassigned = hoursVal > 0 && asg.filter(Boolean).length === 0;
                        const pair = BIWEEKLY_PAIRS[s];
                        // 隔週交代（音美・技家）は3週サイクル専用。Step 4 と同じく2週以下では入力させない
                        // （ここだけ入力できると、学年側のガードを素通りして2週の時間割に隔週交代が載ってしまう）
                        const biweeklyLocked = pair && Number(state.skeleton.cycleWeeks) < 3;
                        html += '<tr data-sub="' + esc(s) + '"' + (hoursVal === 0 ? ' class="tg-dim"' : '') + '>' +
                            '<td' + (unassigned ? ' class="tg-unassigned"' : '') + '>' + esc(s) +
                            (cnt ? ' <span class="badge badge-info">' + cnt + '名</span>' : '') + '</td>' +
                            (biweeklyLocked
                                ? '<td class="tg-sc-hours-cell tg-auto" title="隔週交代（' + esc(s) + '）は3週サイクルで使えます（Step 1）">' + toNum(hoursVal, 0) + '</td>'
                                : '<td class="tg-sc-hours-cell"><input type="number" class="tg-sc-hours" min="0" max="8" value="' + toNum(hoursVal, 0) + '"></td>') + '<td>' +
                            teacherPick('tg-asg-main', asg[0], pair ? pair[0] + ':未定' : '未定') + '</td><td>' +
                            teacherPick('tg-asg-sub', asg[1], pair ? pair[1] + ':未定' : 'TTなし') + '</td></tr>';
                    });
                    html += '</tbody></table></div>';
                });
                html += '</div>';
            }
            html += '</div>';
        }

        // --- 5d 非常勤の条件（専用セクション・すべて絶対条件） ---
        const partTeachers = sortedTeachers().filter(t => t.type === 'part');
        if (partTeachers.length) {
            html += '<div class="tg-block"><h3>5d. 非常勤の条件（すべて絶対条件として守ります）</h3>' +
                '<div class="tg-table-wrap"><table class="tg-table tg-part-table"><thead><tr>' +
                '<th>教員</th><th>午後の授業</th><th>準備の時間<br><span class="tg-soft-desc">週の空きコマ上限</span></th>' +
                '<th>1日の最低コマ</th><th>1日の最高コマ</th><th>現在の設定</th></tr></thead><tbody>';
            partTeachers.forEach(t => {
                const p = t.part || {};
                const prep = (p.prepWeek !== '' && p.prepWeek != null && !isNaN(Number(p.prepWeek))) ? Number(p.prepWeek) : '';
                html += '<tr data-tid="' + esc(t.id) + '">' +
                    '<th class="tg-ov-name">' + esc(t.name || '(無名)') + '</th>' +
                    '<td><select class="tg-p-lunch">' +
                    '<option value="any"' + (p.lunch !== 'am_only' ? ' selected' : '') + '>午後もあり（給食あり）</option>' +
                    '<option value="am_only"' + (p.lunch === 'am_only' ? ' selected' : '') + '>午前のみ（給食なしで退勤）</option>' +
                    '</select></td>' +
                    '<td><input type="number" class="tg-p-prep" min="0" max="20" value="' + prep + '" placeholder="制限なし"></td>' +
                    '<td><input type="number" class="tg-p-daymin" min="0" max="9" value="' + (Number(p.dayMin) || '') + '" placeholder="制限なし"></td>' +
                    '<td><input type="number" class="tg-p-daymax" min="0" max="9" value="' + (Number(p.dayMax) || '') + '" placeholder="制限なし"></td>' +
                    '<td class="tg-part-sum">' + esc(partConfSummary(t)) + '</td></tr>';
            });
            html += '</tbody></table></div>' +
                '<p class="hint">・給食（4限と5限の間）は空きコマに数えません（4限→5限は連続扱い、3限→5限は「4限の空き」1コマ）。<br>' +
                '・「準備の時間」= 授業時数に応じて給与が出る準備時間の分だけ、授業と授業の間の空きコマを週合計で許容します（例: 2 なら週2コマまで）。<br>' +
                '・「1日の最低コマ数」は、1〜2コマのためだけの出勤（交通費の問題）を避ける設定です。<br>' +
                '・守れない場合は、生成結果に「◯◯先生のこの条件を外せば組めます」という提案が出ます。</p></div>';
        }

        // --- 派生ビュー: 持ちコマ数 ---
        html += '<div class="tg-block"><h3>教員別 持ちコマ数（自動計算）</h3>' + buildLoadTable() + '</div>';

        el.innerHTML = html;
        bindStep5(el);
    }

    function teacherPick(cls, selected, emptyLabel) {
        return '<select class="' + cls + '"><option value="">' + esc(emptyLabel || '未定') + '</option>' +
            state.teachers.map(t =>
                '<option value="' + esc(t.id) + '"' + (t.id === selected ? ' selected' : '') + '>' + esc(t.name || '(無名)') + '</option>'
            ).join('') + '</select>';
    }

    function buildAvailGrid(t, maxPeriod) {
        let g = '<div class="tg-table-wrap"><table class="tg-table tg-avail-grid"><thead><tr><th></th>' +
            DAYS.map(([k, l]) => '<th class="tg-day-toggle" data-daycol="' + k + '" title="' + l + '曜をまとめて切替">' + l + '</th>').join('') + '</tr></thead><tbody>';
        for (let p = 1; p <= maxPeriod; p++) {
            g += '<tr><th>' + p + '限</th>';
            DAYS.forEach(([k]) => {
                const max = Number(state.skeleton.periods[k]) || 0;
                if (p > max) {
                    g += '<td class="na">—</td>';
                } else {
                    const key = k + '-' + p;
                    const ng = t.na.includes(key);
                    g += '<td class="' + (ng ? 'ng' : 'ok') + '" data-slot="' + key + '">' + (ng ? '×' : '○') + '</td>';
                }
            });
            g += '</tr>';
        }
        return g + '</tbody></table></div>';
    }

    // 支援学級の実効週コマ数（自立活動の充当を控除。solver.js の buildLessons と同じ規則）
    function effectiveSupportHours(scId, subject) {
        const raw = Number(state.support.hours[scId] && state.support.hours[scId][subject]) || 0;
        const jh = Number(state.support.jiritsu.hours) || 0;
        if (!raw || jh <= 0) return raw;
        const ded = (state.support.jiritsu.deductions || []).filter(d => d === subject).length;
        return Math.max(0, raw - ded);
    }

    function computeLoads() {
        const loads = {};
        state.teachers.forEach(t => { loads[t.id] = 0; });
        Object.keys(state.assignments).forEach(cid => {
            // 支援学級（'sc:<id>' キー）は support.hours（充当控除後）/ 自立活動の時数で計上
            if (cid.startsWith('sc:')) {
                const scId = cid.slice(3);
                if (!supportClassById(scId)) return;
                Object.keys(state.assignments[cid]).forEach(s => {
                    const hours = s === '自立活動'
                        ? (Number(state.support.jiritsu.hours) || 0)
                        : s === '生活単元'
                            ? (Number((state.support.seitan || {}).hours) || 0)
                            : effectiveSupportHours(scId, s);
                    const per = BIWEEKLY_PAIRS[s] ? hours * 0.5 : hours;
                    (state.assignments[cid][s] || []).forEach(tid => {
                        if (tid && loads[tid] != null) loads[tid] += per;
                    });
                });
                return;
            }
            const g = gradeOfClass(cid);
            if (!GRADES.includes(g)) return;
            Object.keys(state.assignments[cid]).forEach(s => {
                const hours = Number(state.hours[g] && state.hours[g][s]) || 0;
                // 隔週交代教科（技家・音美）は2人の担当が週交代のため半分ずつ計上
                const per = BIWEEKLY_PAIRS[s] ? hours * 0.5 : hours;
                (state.assignments[cid][s] || []).forEach(tid => {
                    if (tid && loads[tid] != null) loads[tid] += per;
                });
            });
        });
        return loads;
    }

    // 音美の位相の予測（ソルバと同じ規則）: 学年ごとに学級番号順で 0,1,0,... と交互。
    // 位相0 = B1週に音楽（担当1人目）、位相1 = B1週に美術。
    // ソルバは配置前にこの規則で位相を確定するため、生成前でも正確に予測できる。
    // 例: 1年3クラスなら B1週は 1組・3組が音楽で2組が美術 → 音楽担当は B1に2コマ・B2に1コマ。
    function onbiPhaseOf(cid) {
        const g = gradeOfClass(cid);
        const sameGrade = classIds()
            .filter(c => gradeOfClass(c) === g &&
                ((state.assignments[c] || {})['音美'] || []).filter(Boolean).length)
            .sort((a, b) => (Number(a.split('-')[1]) || 0) - (Number(b.split('-')[1]) || 0));
        const i = sameGrade.indexOf(cid);
        return i >= 0 ? i % 2 : 0;
    }

    // 教員1名の週別持ちコマ数 { A: n, B1: n, ... }
    // 音美は学級ごとの位相（学級番号順で交互）に従って B1/B2 に振り分ける。
    // 技家は週交代のため各週 0.5 で計上。変動枠の担当（週別）も加える
    function teacherWeekLoads(tid) {
        const labels = weekLabels();
        const perWeek = {};
        labels.forEach(w => { perWeek[w] = 0; });
        const addAll = n => labels.forEach(w => { perWeek[w] += n; });

        Object.keys(state.assignments).forEach(cid => {
            const asgMap = state.assignments[cid];
            const isSc = cid.startsWith('sc:');
            const scId = isSc ? cid.slice(3) : null;
            if (isSc && !supportClassById(scId)) return;
            Object.keys(asgMap).forEach(s => {
                const asg = (asgMap[s] || []).filter(Boolean);
                const idx = asg.indexOf(tid);
                if (idx < 0) return;
                let hours;
                if (isSc) {
                    hours = s === '自立活動' ? (Number(state.support.jiritsu.hours) || 0)
                        : s === '生活単元' ? (Number((state.support.seitan || {}).hours) || 0)
                        : effectiveSupportHours(scId, s);
                } else {
                    hours = fixedHoursOf(gradeOfClass(cid), s);
                }
                if (!hours) return;
                if (s === '音美' && labels.length >= 3) {
                    // 音美: 学級ごとの位相どおりに B1/B2 へ。
                    // 位相0の学級 → B1に音楽担当(idx0)・B2に美術担当(idx1)
                    // 位相1の学級 → B1に美術担当(idx1)・B2に音楽担当(idx0)
                    const ph = onbiPhaseOf(cid);
                    const wk = (idx === ph) ? labels[1] : labels[2];
                    if (wk != null) perWeek[wk] += hours;
                } else if (BIWEEKLY_PAIRS[s]) {
                    addAll(hours * 0.5);  // 技家: 週交代（±0.5）
                } else {
                    addAll(hours);
                }
            });
        });
        // 変動枠の担当（週別）
        varSlotDutiesOf(tid).forEach(d => {
            const w = d.split(':')[0];
            if (perWeek[w] != null) perWeek[w] += 1;
        });
        return perWeek;
    }

    function buildLoadTable() {
        if (state.teachers.length === 0) return '<p class="hint">教員を登録すると、担当割りから週の持ちコマ数を自動計算して表示します。</p>';
        const labels = weekLabels();
        const total = totalSlots();
        let html = '<div class="tg-table-wrap"><table class="tg-table"><thead><tr><th>教員</th>' +
            labels.map(w => '<th>' + esc(w) + '週</th>').join('') +
            '<th>出講可能</th><th>判定</th></tr></thead><tbody>';
        sortedTeachers().forEach(t => {
            const avail = total - t.na.length;
            const perWeek = teacherWeekLoads(t.id);
            const maxLoad = Math.max(...labels.map(w => perWeek[w]));
            const over = maxLoad > avail;
            html += '<tr><td class="tg-left">' + esc(t.name || '(無名)') + (t.type === 'part' ? ' <span class="badge badge-secondary">非常勤</span>' : '') + '</td>' +
                labels.map(w => '<td>' + (perWeek[w] % 1 === 0 ? perWeek[w] : perWeek[w].toFixed(1)) + '</td>').join('') +
                '<td>' + avail + '</td>' +
                '<td class="' + (over ? 'tg-sum-ng' : 'tg-sum-ok') + '">' + (over ? '超過（解なし確定）' : 'OK') + '</td></tr>';
        });
        html += '</tbody></table></div>' +
            '<p class="hint">音美は学級ごとの週交代（学級番号順で交互。例: 1組・3組が音楽の週は2組が美術）どおりに、それぞれの実施週へ振り分けて計上します（A週分は学年職員の教科の担当に入ります）。' +
            '技家は週交代のため各週 0.5 コマで計上しています（実際はどちらかの週に1コマ）。変動枠の担当も週別に含みます。</p>';
        if (state.pe.separate) {
            html += '<p class="hint">男女別体育の合同ペア分の持ちコマ調整（2クラス1枠）は生成時に計算します。ここでは単純合算で表示しています。</p>';
        }
        return html;
    }

    function bindStep5(el) {
        const addBtn = document.getElementById('tgAddTeacher');
        if (addBtn) addBtn.addEventListener('click', () => {
            state.teachers.push({
                id: 't' + Date.now() + Math.floor(Math.random() * 1000),
                name: '', type: 'full', homeroom: '', na: []
            });
            save(); renderStep5();
        });

        el.querySelectorAll('.tg-teacher-card').forEach(card => {
            const t = teacherById(card.dataset.tid);
            if (!t) return;
            card.querySelector('.tg-t-name').addEventListener('input', e => { t.name = e.target.value; save(); });
            card.querySelector('.tg-t-name').addEventListener('blur', () => renderStep5());
            // 表示順の移動（その他→1年→2年→3年、常勤→非常勤 の並びの中で入れ替え）
            const moveTeacher = dir => {
                const list = sortedTeachers();
                const idx = list.findIndex(x => x.id === t.id);
                const other = list[idx + dir];
                if (!other) return;
                const i1 = state.teachers.findIndex(x => x.id === t.id);
                const i2 = state.teachers.findIndex(x => x.id === other.id);
                [state.teachers[i1], state.teachers[i2]] = [state.teachers[i2], state.teachers[i1]];
                save(); renderStep5();
            };
            card.querySelector('.tg-t-up').addEventListener('click', () => moveTeacher(-1));
            card.querySelector('.tg-t-down').addEventListener('click', () => moveTeacher(1));
            card.querySelector('.tg-t-type').addEventListener('change', e => { t.type = e.target.value; save(); renderStep5(); });
            card.querySelector('.tg-t-homeroom').addEventListener('change', e => {
                t.homeroom = e.target.value;
                // 担任になったら所属学年も自動で合わせる（手動変更可）
                if (/^[123]-/.test(t.homeroom)) t.gradeGroup = t.homeroom[0];
                save(); renderStep5();
            });
            card.querySelector('.tg-t-grade').addEventListener('change', e => { t.gradeGroup = e.target.value; save(); renderStep5(); });
            card.querySelector('.tg-t-del').addEventListener('click', () => {
                if (!confirm((t.name || 'この教員') + ' を削除します。担当割りからも外れます。よろしいですか？')) return;
                state.teachers = state.teachers.filter(x => x.id !== t.id);
                Object.keys(state.assignments).forEach(cid => {
                    Object.keys(state.assignments[cid]).forEach(s => {
                        state.assignments[cid][s] = (state.assignments[cid][s] || []).map(id => id === t.id ? '' : id);
                    });
                });
                save(); renderStep5();
            });
            card.querySelectorAll('td[data-slot]').forEach(td => {
                td.addEventListener('click', () => {
                    const key = td.dataset.slot;
                    const i = t.na.indexOf(key);
                    if (i >= 0) t.na.splice(i, 1); else t.na.push(key);
                    save(); renderStep5();
                });
            });
            // 曜日ヘッダークリックで1日まとめて切替
            card.querySelectorAll('th.tg-day-toggle').forEach(th => {
                th.addEventListener('click', () => {
                    const k = th.dataset.daycol;
                    const max = Number(state.skeleton.periods[k]) || 0;
                    const keys = [];
                    for (let p = 1; p <= max; p++) keys.push(k + '-' + p);
                    const allNg = keys.every(key => t.na.includes(key));
                    if (allNg) {
                        t.na = t.na.filter(key => !keys.includes(key));
                    } else {
                        keys.forEach(key => { if (!t.na.includes(key)) t.na.push(key); });
                    }
                    save(); renderStep5();
                });
            });
        });

        // 5d 非常勤の条件（保存のみ。再描画せず「現在の設定」セルだけ更新して連続入力を邪魔しない）
        el.querySelectorAll('.tg-part-table tbody tr').forEach(tr => {
            const t = state.teachers.find(x => x.id === tr.dataset.tid);
            if (!t) return;
            // この表は再描画しない（連続入力を邪魔しないため）ので、丸めた値は欄自身にも書き戻す
            const readNum = (sel, range) => {
                const inp = tr.querySelector(sel);
                const raw = String(inp.value).trim();
                const v = clampInt(raw, range.min, range.max, range.fallback);
                if (raw !== '' && String(v) !== raw) inp.value = v;
                return v;
            };
            const saveConf = () => {
                t.part = t.part || {};
                t.part.lunch = tr.querySelector('.tg-p-lunch').value;
                // 準備の時間は空欄＝制限なし。空欄のときは '' のまま保存する
                const prepV = String(tr.querySelector('.tg-p-prep').value).trim();
                t.part.prepWeek = prepV === '' ? '' : readNum('.tg-p-prep', NUM_RANGE.partPrep);
                t.part.dayMin = readNum('.tg-p-daymin', NUM_RANGE.partDay);
                t.part.dayMax = readNum('.tg-p-daymax', NUM_RANGE.partDay);
                tr.querySelector('.tg-part-sum').textContent = partConfSummary(t);
                save();
            };
            ['.tg-p-lunch', '.tg-p-prep', '.tg-p-daymin', '.tg-p-daymax'].forEach(sel => {
                tr.querySelector(sel).addEventListener('change', saveConf);
            });
        });

        el.querySelectorAll('.tg-class-card').forEach(card => {
            const cid = card.dataset.cid;
            // 支援学級カード: 週コマ数入力
            card.querySelectorAll('.tg-sc-hours').forEach(inp => {
                inp.addEventListener('change', () => {
                    const scId = cid.slice(3);
                    const sub = inp.closest('tr').dataset.sub;
                    state.support.hours[scId] = state.support.hours[scId] || {};
                    state.support.hours[scId][sub] =
                        clampInt(inp.value, NUM_RANGE.supportHours.min, NUM_RANGE.supportHours.max, NUM_RANGE.supportHours.fallback);
                    save(); renderStep5();
                });
            });
            const copyBtn = card.querySelector('.tg-copy-grade');
            if (copyBtn) copyBtn.addEventListener('click', () => {
                const g = gradeOfClass(cid);
                const targets = classIds().filter(c => c !== cid && gradeOfClass(c) === g);
                if (!targets.length) return;
                if (!confirm(cid + ' の担当を同学年の ' + targets.join('、') + ' にコピーします。\n' +
                    '・学活・道徳・総合は担任担当のためコピーしません\n' +
                    '・' + cid + ' で「未定」の教科は上書きしません\nよろしいですか？')) return;
                targets.forEach(t => {
                    state.assignments[t] = state.assignments[t] || {};
                    SUBJECTS.forEach(s => {
                        if (HOMEROOM_SUBJECTS.includes(s)) return;
                        const src = (state.assignments[cid][s] || []).filter(Boolean).length
                            ? state.assignments[cid][s].slice() : null;
                        if (src) state.assignments[t][s] = src;
                    });
                });
                save(); renderStep5();
            });
            card.querySelectorAll('tbody tr').forEach(tr => {
                const s = tr.dataset.sub;
                const main = tr.querySelector('.tg-asg-main');
                const sub = tr.querySelector('.tg-asg-sub');
                function update() {
                    const value = [main.value, sub.value].filter((v, idx) => idx === 0 || v);
                    state.assignments[cid][s] = value;
                    // 男女別体育は合同ペアのもう片方にも同じ担当を反映
                    if (s === '保健体育') {
                        const partner = pePartner(cid);
                        if (partner) {
                            state.assignments[partner] = state.assignments[partner] || {};
                            state.assignments[partner][s] = value.slice();
                        }
                    }
                    save(); renderStep5();
                }
                main.addEventListener('change', update);
                sub.addEventListener('change', update);
            });
        });
    }

    // ---------- Step 6 ----------

    function renderStep6() {
        const el = document.getElementById('step6Body');
        const sp = state.support;
        const cids = classIds();

        let html = '<div class="tg-block"><h3>支援学級（Step 1 で登録・担任は Step 5 で設定）</h3>';
        if (sp.classes.length === 0) {
            html += '<p class="hint">Step 1 で支援学級を登録してください。</p>';
        } else {
            html += '<div class="tg-table-wrap"><table class="tg-table"><thead><tr><th>支援学級</th><th>担任</th><th>在籍</th></tr></thead><tbody>' +
                sp.classes.map(sc => {
                    const hr = supportHomeroomTeacher(sc.id);
                    const count = sp.students.filter(st => st.supportClassId === sc.id).length;
                    return '<tr><td>' + esc(sc.name || '(無名)') + '</td>' +
                        '<td>' + (hr ? esc(hr.name || '(無名)') : '<span class="tg-sum-ng">未設定（Step 5 の担任欄で設定）</span>') + '</td>' +
                        '<td>' + count + '名</td></tr>';
                }).join('') +
                '</tbody></table></div>';
        }
        html += '</div>';

        // 自立活動・生活単元
        sp.seitan = sp.seitan || { hours: 1 };
        html += '<div class="tg-block"><h3>自立活動・生活単元学習（全生徒同時・担任担当）</h3>' +
            '<div class="tg-inline-fields">' +
            '<label class="tg-field">自立活動 週 <input type="number" id="tgJiritsuHours" min="0" max="6" value="' + toNum(sp.jiritsu.hours, 0) + '"> コマ</label>' +
            '<label class="tg-field">生活単元 週 <input type="number" id="tgSeitanHours" min="0" max="6" value="' + (Number(sp.seitan.hours) || 0) + '"> コマ</label>' +
            '</div>' +
            '<div class="tg-inline-fields" style="margin-top:8px">' +
            '<span class="tg-field">自立活動の充当（支援の時数から各−1コマ）: ' +
            (sp.jiritsu.deductions.length
                ? sp.jiritsu.deductions.map((d, i) =>
                    subjectSelect('tg-jr-ded" data-idx="' + i, d) +
                    '<button type="button" class="btn btn-danger btn-small tg-jr-ded-del" data-idx="' + i + '">✕</button>').join(' ')
                : '<span class="hint-inline">なし（Step 5c の時数をそのまま使う）</span>') +
            ' <button type="button" class="btn btn-secondary btn-small" id="tgJrDedAdd">＋充当を追加</button></span>' +
            '</div>' +
            '<div id="tgJiritsuWarn"></div></div>';

        // 生徒
        html += '<div class="tg-block"><h3>在籍生徒（教科ごとに 支援学級/交流学級 を切替）</h3>' +
            '<p class="hint">教科名をクリックすると「<strong>塗り = 支援学級で受ける</strong> / 白 = 交流学級で受ける」が切り替わります。</p>';
        sp.students.forEach(st => {
            html += '<div class="tg-teacher-card" data-stid="' + esc(st.id) + '"><div class="tg-teacher-head">' +
                '<input type="text" class="tg-st-label" maxlength="' + TEXT_MAX.name + '" placeholder="例：Aさん" value="' + esc(st.label) + '">' +
                '<span class="tg-field">所属: <select class="tg-st-sc"><option value="">未定</option>' +
                sp.classes.map(sc => '<option value="' + esc(sc.id) + '"' + (st.supportClassId === sc.id ? ' selected' : '') + '>' + esc(sc.name || '(無名)') + '</option>').join('') +
                '</select></span>' +
                '<span class="tg-field">交流学級: <select class="tg-st-ex"><option value="">未定</option>' +
                cids.map(c => '<option value="' + c + '"' + (st.exchangeClass === c ? ' selected' : '') + '>' + c + '</option>').join('') +
                '</select></span>' +
                '<button type="button" class="btn btn-danger btn-small tg-st-del">削除</button>' +
                '</div><div style="margin-top:8px">' +
                SUBJECTS.map(s =>
                    '<span class="tg-subj-toggle ' + (st.subjects[s] === 'support' ? 'support' : '') + '" data-sub="' + esc(s) + '">' + esc(s) + '</span>'
                ).join('') +
                '</div></div>';
        });
        html += '<div class="tg-add-bar"><button type="button" class="btn btn-primary btn-small" id="tgAddStudent">生徒を追加</button></div></div>';

        el.innerHTML = html;
        refreshJiritsuWarn();
        bindStep6(el);
    }

    function refreshJiritsuWarn() {
        const box = document.getElementById('tgJiritsuWarn');
        if (!box) return;
        const bad = [];
        state.support.jiritsu.deductions.forEach(d => {
            state.support.students.forEach(st => {
                if (st.subjects[d] !== 'support') bad.push((st.label || '生徒') + '（' + d + 'を交流学級で受講）');
            });
        });
        box.innerHTML = bad.length
            ? '<div class="tg-warn">交流学級で受ける教科から時数を削ると、その教科の進度が生徒間でズレます: ' + esc(bad.join('、')) + '</div>'
            : '';
    }

    function bindStep6(el) {
        const sp = state.support;
        document.getElementById('tgAddStudent').addEventListener('click', () => {
            const subjects = {};
            SUBJECTS.forEach(s => { subjects[s] = 'exchange'; });
            ['国語', '数学', '英語'].forEach(s => { subjects[s] = 'support'; });
            sp.students.push({ id: 'st' + Date.now(), label: '', supportClassId: sp.classes[0] ? sp.classes[0].id : '', exchangeClass: '', subjects });
            save(); renderStep6();
        });
        bindNumField(document.getElementById('tgJiritsuHours'), NUM_RANGE.jiritsu, v => {
            sp.jiritsu.hours = v; save();
        });
        bindNumField(document.getElementById('tgSeitanHours'), NUM_RANGE.jiritsu, v => {
            sp.seitan.hours = v; save();
        });
        el.querySelectorAll('select.tg-jr-ded').forEach(sel => {
            sel.addEventListener('change', e => {
                sp.jiritsu.deductions[Number(sel.dataset.idx)] = e.target.value;
                save(); refreshJiritsuWarn();
            });
        });
        el.querySelectorAll('.tg-jr-ded-del').forEach(btn => {
            btn.addEventListener('click', () => {
                sp.jiritsu.deductions.splice(Number(btn.dataset.idx), 1);
                save(); renderStep6();
            });
        });
        document.getElementById('tgJrDedAdd').addEventListener('click', () => {
            sp.jiritsu.deductions.push('国語');
            save(); renderStep6();
        });
        el.querySelectorAll('.tg-teacher-card[data-stid]').forEach(card => {
            const st = sp.students.find(x => x.id === card.dataset.stid);
            if (!st) return;
            card.querySelector('.tg-st-label').addEventListener('input', e => { st.label = e.target.value; save(); });
            card.querySelector('.tg-st-sc').addEventListener('change', e => { st.supportClassId = e.target.value; save(); renderStep6(); });
            card.querySelector('.tg-st-ex').addEventListener('change', e => { st.exchangeClass = e.target.value; save(); });
            card.querySelector('.tg-st-del').addEventListener('click', () => {
                if (!confirm((st.label || 'この生徒') + ' を削除しますか？')) return;
                sp.students = sp.students.filter(x => x.id !== st.id);
                save(); renderStep6();
            });
            card.querySelectorAll('.tg-subj-toggle').forEach(tg => {
                tg.addEventListener('click', () => {
                    const s = tg.dataset.sub;
                    st.subjects[s] = st.subjects[s] === 'support' ? 'exchange' : 'support';
                    tg.classList.toggle('support', st.subjects[s] === 'support');
                    save(); refreshJiritsuWarn();
                });
            });
        });
    }

    // ---------- Step 7 ----------

    function renderStep7() {
        const el = document.getElementById('step7Body');
        let html = '<div class="tg-table-wrap"><table class="tg-table"><thead><tr>' +
            '<th>教室・施設</th><th>使う教科</th><th>数</th><th>1室あたり同時クラス数</th><th></th></tr></thead><tbody>';
        state.rooms.forEach((r, i) => {
            html += '<tr data-idx="' + i + '">' +
                '<td><input type="text" class="tg-room-name" maxlength="' + TEXT_MAX.name + '" style="width:120px" value="' + esc(r.name) + '"></td>' +
                '<td><select class="tg-room-subject"><option value="">（紐づけなし）</option>' +
                SUBJECTS.map(s => '<option value="' + esc(s) + '"' + (r.subject === s ? ' selected' : '') + '>' + esc(s) + '</option>').join('') +
                '</select></td>' +
                '<td><input type="number" class="tg-room-count" min="0" max="9" value="' + toNum(r.count, 0) + '"></td>' +
                '<td><input type="number" class="tg-room-cap" min="1" max="9" value="' + toNum(r.capacity, 1) + '"></td>' +
                '<td><button type="button" class="btn btn-danger btn-small tg-room-del">削除</button></td></tr>';
        });
        html += '</tbody></table></div>' +
            '<div class="tg-add-bar"><button type="button" class="btn btn-primary btn-small" id="tgAddRoom">教室を追加</button></div>' +
            '<p class="hint">「使う教科」で紐づけた教科は、その教室の空きがある時間にしか配置されません。同じ教科に複数の教室（体育館とグラウンド等）を紐づけると、どちらかが空いていれば配置できます。</p>';
        el.innerHTML = html;

        document.getElementById('tgAddRoom').addEventListener('click', () => {
            state.rooms.push({ name: '', count: 1, capacity: 1, subject: '' });
            save(); renderStep7();
        });
        el.querySelectorAll('tbody tr').forEach(tr => {
            const r = state.rooms[Number(tr.dataset.idx)];
            tr.querySelector('.tg-room-name').addEventListener('input', e => { r.name = e.target.value; save(); });
            tr.querySelector('.tg-room-subject').addEventListener('change', e => { r.subject = e.target.value; save(); });
            bindNumField(tr.querySelector('.tg-room-count'), NUM_RANGE.roomCount, v => { r.count = v; save(); });
            // 同時クラス数は 0 を許さない（0 だとその教室を使う教科が永久に置けなくなる）
            bindNumField(tr.querySelector('.tg-room-cap'), NUM_RANGE.roomCap, v => { r.capacity = v; save(); });
            tr.querySelector('.tg-room-del').addEventListener('click', () => {
                state.rooms.splice(Number(tr.dataset.idx), 1);
                save(); renderStep7();
            });
        });
    }

    // ---------- Step 8 ----------

    // 「絶対」に格上げできる条件（配置時にハード制約として強制できるもの）
    const HARDENABLE = ['pe_am', 'pe_overlap', 'subject_spread', 'subject_pm', 'no_hard_monday1', 'week1_safe',
                        'no_special_seq', 'part_time_gap', 'grade_block', 'no_gap_zero_day', 'jiritsu_sync'];

    function renderStep8() {
        const el = document.getElementById('step8Body');
        state.soft = state.soft || { selected: [], gapMax: 1, hard: [] };
        state.soft.selected = state.soft.selected || [];
        state.soft.hard = state.soft.hard || [];

        // 5d の非常勤条件も含め、表示のたびにソルバ側の正規化結果を使う
        const priorities = window.TimetableSolver.prioritiesOf(state);
        const order = priorities.order.slice();
        const hard = new Set(priorities.hard);
        const isPart = id => id.indexOf('part:') === 0;
        const canBeHard = id => isPart(id) || HARDENABLE.includes(id);

        // 新形式を正本として保存しつつ、旧形式も同期して後方互換を保つ
        const commitPriorities = () => {
            const hardOrder = order.filter(id => hard.has(id) && canBeHard(id));
            state.priorities = { order: order.slice(), hard: hardOrder };
            state.soft.selected = order.filter(id => !isPart(id));
            state.soft.hard = hardOrder.filter(id => !isPart(id));
            save();
        };

        let html = '<div class="tg-phys-block">' +
            '<h3>物理制約（常に絶対・順位の対象外）</h3>' +
            '<ul class="tg-phys-list">' +
            '<li><span class="tg-phys-fixed">固定</span>教員の重なり</li>' +
            '<li><span class="tg-phys-fixed">固定</span>出講できない時間</li>' +
            '<li><span class="tg-phys-fixed">固定</span>特別教室の数</li>' +
            '<li><span class="tg-phys-fixed">固定</span>同じ教科の同日重複禁止</li>' +
            '<li><span class="tg-phys-fixed">固定</span>支援学級と交流学級の同期</li>' +
            '<li><span class="tg-phys-fixed">固定</span>体育の合同ペア・隔週交代ペアの整合</li>' +
            '</ul>' +
            '<p class="hint">これらは時間割として成立するための土台で、順位を付ける対象ではありません。</p>' +
            '</div>' +
            '<h3 class="tg-prio-title">条件の優先順位（絶対／できれば）</h3>' +
            '<p class="hint">上にある条件ほど優先されます。「絶対」は必ず守る条件（守れない場合は生成結果に提案が出ます）。<br>' +
            'できれば条件は上位の違反を1件減らすことが下位の違反何件よりも優先されます（辞書順）。</p>' +
            '<ul class="tg-prio-list">';

        order.forEach((id, i) => {
            const part = isPart(id);
            const hardEnabled = canBeHard(id);
            const isHard = hardEnabled && hard.has(id);
            html += '<li data-prio-id="' + esc(id) + '">' +
                '<span class="tg-prio-rank">' + (i + 1) + '</span>' +
                '<select class="tg-prio-level ' + (isHard ? 'is-hard' : 'is-soft') + '" data-prio-level="' + esc(id) + '"' +
                (hardEnabled ? ' title="条件の扱いを選択"' : ' disabled title="この条件は「できれば」固定です"') + '>' +
                '<option value="hard"' + (isHard ? ' selected' : '') + '>絶対</option>' +
                '<option value="soft"' + (isHard ? '' : ' selected') + '>できれば</option>' +
                '</select>';

            if (id === 'part_time_gap') {
                html += '<span class="tg-prio-label">非常勤の1日の空きコマは ' +
                    '<select id="softGapMax" aria-label="許容する空きコマ数">' +
                    [0, 1, 2].map(n => '<option value="' + n + '"' + (Number(state.soft.gapMax) === n ? ' selected' : '') + '>' + n + '</option>').join('') +
                    '</select> コマ以内にする（例: 1・3・5限や1・4・5限のような飛び石配置を避ける）</span>';
            } else {
                html += '<span class="tg-prio-label">' + esc(softLabel(id));
                if (part) {
                    html += ' <span class="tg-prio-5d">5dで設定</span>' +
                        '<span class="tg-prio-part-hint">5dで値を消すと自動で消えます</span>';
                }
                html += '</span>';
            }

            html += '<span class="tg-prio-move">' +
                '<button type="button" class="tg-prio-up" title="上へ"' + (i === 0 ? ' disabled' : '') + '>▲</button>' +
                '<button type="button" class="tg-prio-down" title="下へ"' + (i === order.length - 1 ? ' disabled' : '') + '>▼</button>' +
                '</span>' +
                (part ? '' : '<button type="button" class="tg-prio-remove" title="この条件を外す">外す</button>') +
                '</li>';
        });
        html += '</ul>';

        if (order.length === 0) {
            html += '<p class="hint">方針条件はまだありません。下のメニューから追加できます。</p>';
        }

        const addable = SOFT_PRESETS.filter(p => !order.includes(p.id));
        html += '<div class="tg-prio-add"><select id="tgPrioAdd" aria-label="条件を追加"' + (addable.length ? '' : ' disabled') + '>' +
            '<option value="">＋条件を追加</option>' +
            addable.map(p => '<option value="' + esc(p.id) + '">' + esc(p.label) + '</option>').join('') +
            '</select></div>';

        // 先生ごとの条件の濃淡（現場要望 2026-07-28）。
        // 教員に紐づく3条件は、先生によって必要度が違う:
        //   学年の連続  … 数学は行き来OK・技術/美術は準備が大変
        //   空きゼロの日 … 校務のある先生は毎日どこかに空きが必要・気にしない先生もいる
        //   空きの平準化 … 同上
        {
            state.teacherCondWeights = state.teacherCondWeights || {};
            // 旧形式（grade_block 専用）からの引き継ぎ
            if (state.gradeBlockByTeacher && Object.keys(state.gradeBlockByTeacher).length &&
                !state.teacherCondWeights.grade_block) {
                state.teacherCondWeights.grade_block = { ...state.gradeBlockByTeacher };
            }
            const CW_CONDS = [
                ['grade_block', '同じ学年を連続に'],
                ['no_gap_zero_day', '空きゼロの日を作らない'],
                ['teacher_gap', '空きコマの平準化']
            ].filter(([id]) => order.includes(id));
            if (CW_CONDS.length) {
                const cwOf = (cond, tid) => (state.teacherCondWeights[cond] || {})[tid] || 'normal';
                const sel = (cond, tid) => {
                    const cur = cwOf(cond, tid);
                    return '<select data-cw-cond="' + cond + '" data-cw-tid="' + esc(tid) + '" class="tg-cw-sel tg-cw-' + esc(cur) + '">' +
                        '<option value="off"' + (cur === 'off' ? ' selected' : '') + '>不要</option>' +
                        '<option value="normal"' + (cur === 'normal' ? ' selected' : '') + '>ふつう</option>' +
                        '<option value="strong"' + (cur === 'strong' ? ' selected' : '') + '>特に重視</option>' +
                        // 「絶対に」は行き来の判定を配置段階で強制できる条件のみ（いまは学年の連続だけ）
                        (cond === 'grade_block'
                            ? '<option value="hard"' + (cur === 'hard' ? ' selected' : '') + '>絶対に</option>'
                            : '') +
                        '</select>';
                };
                html += '<div class="tg-block" style="margin-top:14px"><h3>先生ごとの重み（条件の濃淡）</h3>' +
                    '<p class="hint" style="margin:0 0 8px">先生によって必要度が違う条件は、ここで濃淡をつけられます。' +
                    '<b>不要</b>=その先生では数えない／<b>ふつう</b>=既定／<b>特に重視</b>=違反を3倍重く数え、配置でも優先します。<br>' +
                    '「同じ学年を連続に」だけは<b>絶対に</b>も選べます: その先生の学年の行き来（例: 1年→2年→1年）を最初から禁止して組みます。' +
                    '空きコマを挟んだり（1年→空き→2年）、行き来しない切り替わり（1年→1年→2年）は「絶対に」でも許されます。<br>' +
                    '例: 「同じ学年を連続に」は<b>数学</b>なら不要でも、<b>技術・美術</b>は準備が大変なので特に重視や絶対に。' +
                    '「空きゼロの日」は校務の多い先生ほど重要。<br>' +
                    '※条件そのものを「絶対」にしている場合は<b>「不要」だけが効きます</b>（その先生を対象から外す）。「特に重視」は「できれば」のときの重みです。</p>' +
                    '<div class="tg-table-wrap"><table class="tg-table tg-gb-table"><thead><tr>' +
                    '<th class="tg-left">先生</th>' +
                    CW_CONDS.map(([, label]) => '<th>' + label + '</th>').join('') +
                    '</tr></thead><tbody>' +
                    sortedTeachers().map(t =>
                        '<tr><td class="tg-left">' + esc(t.name || '(無名)') + '</td>' +
                        CW_CONDS.map(([id]) => '<td>' + sel(id, t.id) + '</td>').join('') +
                        '</tr>').join('') +
                    '</tbody></table></div></div>';
            }
        }
        el.innerHTML = html;

        el.querySelectorAll('select[data-cw-cond]').forEach(sl => sl.addEventListener('change', e => {
            const cond = e.target.dataset.cwCond, tid = e.target.dataset.cwTid, v = e.target.value;
            state.teacherCondWeights = state.teacherCondWeights || {};
            const m = state.teacherCondWeights[cond] = state.teacherCondWeights[cond] || {};
            if (v === 'normal') delete m[tid]; else m[tid] = v;
            if (cond === 'grade_block' && state.gradeBlockByTeacher) {
                // 旧形式は新形式に一本化（二重管理を避ける）
                delete state.gradeBlockByTeacher;
            }
            e.target.className = 'tg-cw-sel tg-cw-' + v;
            save();
        }));

        el.querySelectorAll('select[data-prio-level]').forEach(sel => {
            sel.addEventListener('change', () => {
                const id = sel.dataset.prioLevel;
                if (sel.value === 'hard') hard.add(id);
                else hard.delete(id);
                commitPriorities();
                renderStep8();
            });
        });

        el.querySelectorAll('.tg-prio-list > li').forEach(li => {
            const id = li.dataset.prioId;
            const up = li.querySelector('.tg-prio-up');
            const down = li.querySelector('.tg-prio-down');
            const remove = li.querySelector('.tg-prio-remove');

            up.addEventListener('click', () => {
                const i = order.indexOf(id);
                if (i <= 0) return;
                [order[i - 1], order[i]] = [order[i], order[i - 1]];
                commitPriorities();
                renderStep8();
            });
            down.addEventListener('click', () => {
                const i = order.indexOf(id);
                if (i < 0 || i >= order.length - 1) return;
                [order[i + 1], order[i]] = [order[i], order[i + 1]];
                commitPriorities();
                renderStep8();
            });
            if (remove) {
                remove.addEventListener('click', () => {
                    const i = order.indexOf(id);
                    if (i < 0) return;
                    order.splice(i, 1);
                    hard.delete(id);
                    commitPriorities();
                    renderStep8();
                });
            }
        });

        const addSel = document.getElementById('tgPrioAdd');
        addSel.addEventListener('change', () => {
            const id = addSel.value;
            if (!id || order.includes(id)) return;
            order.push(id);
            hard.delete(id);
            commitPriorities();
            renderStep8();
        });

        const gapSel = document.getElementById('softGapMax');
        if (gapSel) {
            gapSel.addEventListener('change', e => {
                state.soft.gapMax = clampInt(e.target.value, NUM_RANGE.gapMax.min, NUM_RANGE.gapMax.max, NUM_RANGE.gapMax.fallback);
                commitPriorities();
                renderStep8();
            });
        }
    }

    // ---------- Step 9 ----------

    function renderStep9() {
        applyHomeroomDefaults();

        const el = document.getElementById('step9Body');
        const cids = classIds();
        const loads = computeLoads();
        const total = totalSlots();
        const withVar = hasVarSlot();
        const overTeachers = state.teachers.filter(t => (loads[t.id] || 0) > total - t.na.length);
        const unassigned = [];
        cids.forEach(cid => {
            SUBJECTS.forEach(s => {
                if (Number(state.hours[gradeOfClass(cid)] && state.hours[gradeOfClass(cid)][s]) === 0) return;
                const asg = (state.assignments[cid] && state.assignments[cid][s]) || [];
                if (asg.filter(Boolean).length === 0) unassigned.push(cid + ' ' + s);
            });
        });
        // 支援学級: 週コマ数（充当控除後）を設定した教科の担当未定もチェック
        state.support.classes.forEach(sc => {
            const key = 'sc:' + sc.id;
            SUBJECTS.forEach(s => {
                if (HOMEROOM_SUBJECTS.includes(s)) return;
                const hours = effectiveSupportHours(sc.id, s);
                if (!hours) return;
                const asg = (state.assignments[key] && state.assignments[key][s]) || [];
                if (asg.filter(Boolean).length === 0) unassigned.push((sc.name || '支援学級') + ' ' + s);
            });
        });
        // 入力は「B週・変動枠込み」なので目標は全学年とも週の枠数ちょうど
        const gradeSums = GRADES.map(g => ({
            g,
            sum: SUBJECTS.reduce((a, s) => a + (Number(state.hours[g][s]) || 0), 0),
            target: weeklyCapacity()
        }));
        const overSum = gradeSums.filter(x => x.sum > x.target);
        const underSum = gradeSums.filter(x => x.sum < x.target);
        const noHomeroomSc = state.support.classes.filter(sc => !supportHomeroomTeacher(sc.id));

        let html = '<div class="tg-summary-block"><h3>絶対条件（すべて守られます）</h3><ul>' +
            '<li>週の骨格: ' + DAYS.map(([k, l]) => l + esc(String(state.skeleton.periods[k]))).join('・') + '（週' + weeklyCapacity() + 'コマ）／' +
            (state.skeleton.cycleWeeks === 1 ? '毎週同じ' : toNum(state.skeleton.cycleWeeks, 3) + '週サイクル（' + weekLabels().join('・') + '）') + '</li>' +
            '<li>クラス: ' + GRADES.map(g => g + '年' + toNum(state.classes[g], 0) + 'クラス').join('・') + '（計' + cids.length + 'クラス）＋ 支援学級' + state.support.classes.length + '学級</li>' +
            '<li>固定コマ: ' + fixedRows().map(row => {
                const v = state.fixed.items[row.key] || {};
                const scope = row.grades.length < GRADES.length ? row.grades.join('・') + '年' : '全学年';
                return esc(row.label) + '=' + (state.fixed.same ? dayLabel(v.day) + toNum(v.period, 1) + '限（' + scope + '）' : '学年別');
            }).join('、') + '（担当は担任）</li>' +
            '<li>体育: ' + (state.pe.separate
                ? '男女別（2クラス合同・教員別）。ペア: ' + (state.pe.pairs.filter(p => p[0] && p[1]).map(p => esc(p[0]) + '&' + esc(p[1])).join('、') || '未設定')
                : '男女一緒（1クラス単位）') + '</li>' +
            // 隔週交代は「実際に使っている対象」だけを実データから列挙する（3週サイクル以外・未使用なら行ごと出さない）。
            // 「すべて守られます」の見出しの下に、入力と無関係な固定文を置かないため
            (function () {
                if (Number(state.skeleton.cycleWeeks) < 3) return '';
                const parts = [];
                Object.keys(BIWEEKLY_PAIRS).forEach(s => {
                    const users = GRADES.filter(g => (Number((state.hours[g] || {})[s]) || 0) > 0).map(g => g + '年');
                    ((state.support && state.support.classes) || []).forEach(sc => {
                        if ((Number(((state.support.hours || {})[sc.id] || {})[s]) || 0) > 0) users.push(esc(sc.name || '(無名)'));
                    });
                    if (users.length) parts.push(esc(s) + '=' + esc(BIWEEKLY_PAIRS[s][0]) + '/' + esc(BIWEEKLY_PAIRS[s][1]) + '（' + users.join('・') + '）');
                });
                return parts.length ? '<li>隔週交代教科: ' + parts.join('、') + '。2名の担当が週で交代します</li>' : '';
            })() +
            '<li>教員: ' + state.teachers.length + '名（非常勤' + state.teachers.filter(t => t.type === 'part').length + '名）。出講不可コマは配置しません</li>' +
            '<li>支援学級在籍: ' + state.support.students.length + '名。交流学級の同期制約を適用します</li>' +
            '<li>自立活動: 週' + toNum(state.support.jiritsu.hours, 0) + 'コマ・生活単元: 週' + (Number((state.support.seitan || {}).hours) || 0) + 'コマ（全生徒同時・担任担当' +
            (state.support.jiritsu.deductions.length ? '・自立の充当元: ' + state.support.jiritsu.deductions.map(esc).join('/') : '') + '）</li>' +
            '<li>特別教室: ' + state.rooms.filter(r => r.name).map(r => esc(r.name) + '×' + toNum(r.count, 0) + (r.subject ? '（' + esc(r.subject) + '）' : '')).join('、') + '</li>' +
            '</ul></div>';

        // 事前チェック
        let checks = '';
        if (overSum.length) checks += '<div class="tg-error">週コマ数の固定分が枠を超えています: ' + overSum.map(x => x.g + '年（' + (x.sum - x.target) + '超過）').join('・') + '（Step 4）</div>';
        if (underSum.length) checks += '<div class="tg-warn">空きコマがあります: ' + underSum.map(x => x.g + '年（空き' + (x.target - x.sum) + '）').join('・') + '。意図した空きなら問題ありません。</div>';
        if (overTeachers.length) checks += '<div class="tg-error">持ちコマが出講可能コマを超えています（解なし確定）: ' + overTeachers.map(t => esc(t.name || '(無名)')).join('、') + '（Step 5）</div>';
        if (noHomeroomSc.length) checks += '<div class="tg-warn">担任が未設定の支援学級: ' + noHomeroomSc.map(sc => esc(sc.name || '(無名)')).join('、') + '（Step 5 の担任欄）</div>';
        if (unassigned.length) checks += '<div class="tg-warn">担当者が未定のコマが ' + unassigned.length + ' 件あります（例: ' + esc(unassigned.slice(0, 5).join('、')) + (unassigned.length > 5 ? ' ほか' : '') + '）（Step 5b）</div>';
        // 書き出せない・組めない構成は、生成ボタンを押す前にここで知らせる。
        // 隔週交代の残存（2週以下）は生成と書き出しの両方を止める構成なので赤で出す
        const exportLimit = exportLimitNote();
        // 支援学級名（自由入力）を含む文字列なので、innerHTML に入れる直前でエスケープする
        if (exportLimit) checks += '<div class="' + (biweeklyGradesUnderThreeWeeks().length ? 'tg-error' : 'tg-warn') + '">' + esc(exportLimit) + '</div>';
        if (!checks) checks = '<div class="alert alert-success">入力の事前チェックはすべて通過しました。</div>';
        html += checks;

        // 統一優先順位リストの読み取り専用サマリ
        const prioritySummary = window.TimetableSolver.prioritiesOf(state);
        html += '<div class="tg-summary-block"><h3>方針条件の優先順位（上ほど優先）</h3>';
        if (prioritySummary.order.length === 0) {
            html += '<p class="hint">Step 8 で方針条件が設定されていません。物理制約のみで生成します。</p>';
        } else {
            html += '<ul class="tg-prio-list tg-prio-summary">';
            prioritySummary.order.forEach((id, i) => {
                const hardMark = prioritySummary.hard.has(id)
                    ? '<span class="badge badge-info">絶対</span>' : '';
                const ignMark = ignoredIdList().includes(id)
                    ? '<span class="badge tg-badge-ignored">無視中</span>' : '';
                html += '<li' + (ignMark ? ' class="tg-prio-ignored"' : '') + '><span class="tg-prio-rank">' + (i + 1) + '</span>' +
                    hardMark + ignMark + '<span class="tg-prio-label">' + esc(softLabel(id)) + '</span></li>';
            });
            html += '</ul><p class="hint">優先順位や条件の扱いを変える場合は Step 8 に戻ってください。</p>';
        }
        html += '</div>';

        // 無視して組む条件（結果画面の「この条件を無視してもう一度組む」で追加。×で解除）
        {
            const ign = ignoredConds();
            if (ign.length) {
                html += '<div class="tg-summary-block tg-ignored-block"><h3>🚫 無視して組む条件（' + ign.length + '）</h3>' +
                    '<div class="tg-ignored-chips">' +
                    ign.map(x => '<span class="tg-ignored-chip">' + esc(x.label || softLabel(x.id)) +
                        '<button type="button" class="tg-ignored-del" data-id="' + esc(x.id) + '" title="無視をやめて次回から守る">×</button></span>').join('') +
                    '</div><p class="hint">「絶対」の条件は「できれば」扱いに格下げして組みます（完全に忘れるのではなく、守れるなら守ります）。' +
                    '×を押すと次の生成から元どおり守ります。設定そのもの（Step 5d・8）は変わっていません。</p></div>';
            }
        }

        const budgetMin = solverBudgetMin();
        const abm = solverAbMode();
        html += '<div class="tg-generate-bar">' +
            '<button type="button" class="btn btn-primary btn-large" id="tgGenerate">時間割を組む</button>' +
            '<label class="tg-budget-label">探索時間の上限 ' +
            '<select id="tgBudgetMin">' +
            SOLVER_BUDGET_CHOICES.map(m => '<option value="' + m + '"' + (m === budgetMin ? ' selected' : '') + '>' + m + '分</option>').join('') +
            '</select></label>' +
            // 「毎週同じ」（1週）にはA週もB週も存在しないので、この設定ごと出さない。
            // 2週では音美（3週専用）の話が出ないよう「完全に同じ」のラベルから括弧書きを外す
            (hasVarSlot()
                ? '<label class="tg-budget-label">A週とB週のズレ ' +
                  '<select id="tgAbMode">' +
                  AB_MODE_CHOICES.map(([v, l]) => {
                      const label = (v === 'exact' && Number(state.skeleton.cycleWeeks) < 3) ? '完全に同じ' : l;
                      return '<option value="' + v + '"' + (v === abm ? ' selected' : '') + '>' + label + '</option>';
                  }).join('') +
                  '</select></label>'
                : '') +
            (function () {
                const sug = suggestedBudgetMin();
                const isNow = sug.min === budgetMin;
                return '<span class="hint" id="tgBudgetSuggest" style="align-self:center">' +
                    'この規模（学級' + sug.classCount +
                    (sug.supportCount ? '・支援' + sug.supportCount : '') +
                    '・週約' + sug.approxLessons + 'コマ）のおすすめは <b>' + sug.min + '分</b>' +
                    (isNow ? '（選択中）' : ' <a href="#" id="tgBudgetApply">おすすめにする</a>') +
                    '</span>';
            })() +
            '<p class="hint" style="width:100%;margin:6px 0 0">全コマ配置できた時点で自動終了します（多くの場合は数秒〜1分・途中で止めて最良案の表示も可）。' +
            (hasVarSlot()
                ? '「A週とB週のズレ」: 完全に同じ＝' +
                  (Number(state.skeleton.cycleWeeks) >= 3
                      ? 'B週の形を保ったままA週は音美コマだけ差し替え。'
                      : 'A週とB週を同じ形にします。') +
                  'うまく組めないときは「少しずらしてもよい」にすると、' +
                  'A週だけ数コマ入れ替えて調整します（ズレたコマは結果のA週一覧に色付きで表示）。'
                : '') + '</p>' +
            '</div>' +
            '<div class="action-bar no-print" style="justify-content:center">' +
            '<button type="button" class="btn btn-secondary" id="tgExport">設定をJSONで書き出す</button>' +
            '<button type="button" class="btn btn-secondary" id="tgImport">設定をJSONから読み込む</button>' +
            (window.TG_SAMPLE ? '<button type="button" class="btn btn-secondary" id="tgLoadSample9">練習用のサンプルを読み込む</button>' : '') +
            '<button type="button" class="btn btn-danger" id="tgReset">入力を全てリセット</button>' +
            '</div>';

        el.innerHTML = html;

        // 優先順位の変更は Step 8 で行う（Step 9 は読み取り専用）。

        document.getElementById('tgGenerate').addEventListener('click', runSolver);

        el.querySelectorAll('.tg-ignored-del').forEach(b => b.addEventListener('click', () => {
            removeIgnored(b.dataset.id);
            renderStep9();
        }));

        document.getElementById('tgBudgetMin').addEventListener('change', e => {
            state.solver = state.solver || {};
            state.solver.budgetMin = Math.min(SOLVER_MAX_MIN, Math.max(1, Number(e.target.value) || 3));
            save();
            render();   // おすすめ表示の「（選択中）」を更新
        });
        const applyLink = document.getElementById('tgBudgetApply');
        if (applyLink) applyLink.addEventListener('click', e => {
            e.preventDefault();
            state.solver = state.solver || {};
            state.solver.budgetMin = suggestedBudgetMin().min;
            save();
            render();
        });

        const abModeSel = document.getElementById('tgAbMode');   // 「毎週同じ」（1週）では出していない
        if (abModeSel) abModeSel.addEventListener('change', e => {
            state.solver = state.solver || {};
            state.solver.abMode = ['exact', 'repair', 'free'].includes(e.target.value) ? e.target.value : 'exact';
            save();  // 配置に影響する条件なので、前回の結果は自動で破棄される
        });

        const sampleBtn9 = document.getElementById('tgLoadSample9');
        if (sampleBtn9) sampleBtn9.addEventListener('click', applySampleData);

        document.getElementById('tgExport').addEventListener('click', () => {
            const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = '時間割条件.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        });

        // 書き出しておいた設定ファイルを読み戻す（毎年の条件や、検証用のデータ一式を使い回すため）
        document.getElementById('tgImport').addEventListener('click', () => {
            const picker = document.createElement('input');
            picker.type = 'file';
            picker.accept = 'application/json,.json';
            picker.id = 'tgImportFile';
            picker.hidden = true;
            document.body.appendChild(picker);   // 一部ブラウザは DOM 外の input を無視する
            picker.addEventListener('change', () => {
                const file = picker.files && picker.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                    let raw;
                    try {
                        raw = JSON.parse(String(reader.result));
                    } catch (e) {
                        alert('JSONとして読み取れませんでした。書き出したファイルをそのまま選んでください。');
                        return;
                    }
                    // 形式の確認は中身を整える前の生データで行う（looksLikeSettingsFile のコメント参照）。
                    // 整えたあとだと何を読んでも「正しい設定」に見えてしまい、入力が消える
                    if (!looksLikeSettingsFile(raw)) {
                        alert('このツールで書き出した設定ファイルではないようです。\n\n'
                            + 'Step 9 の「設定をJSONで書き出す」で保存したファイル（時間割条件.json）を選んでください。');
                        return;
                    }
                    const data = normalizeState(raw);
                    const cycleTrimmed = lastSanitizeReport.cycleWeeksTrimmed;   // 取り込みを決める前に控えておく
                    const teacherCount = (data.teachers || []).length;
                    if (!confirm('いまの入力内容を「' + file.name + '」の内容に置き換えます。\n'
                        + '（教員 ' + teacherCount + ' 名・' + GRADES.map(g => g + '年' + ((data.classes || {})[g] || 0) + '学級').join('・') + '）\n\n'
                        + 'いまの入力は失われます。よろしいですか？')) return;
                    state = data;
                    cycleWeeksTrimmedNotice = cycleTrimmed;   // 4週→3週の読み替えは Step 1 にも残して知らせる
                    lastResult = null;          // 前の時間割は新しい条件と対応しないので捨てる
                    solverStateSig = null;
                    activeAlt = 0;
                    editUi = freshEditUi();
                    staffPlanCache = null;
                    // 古い版で書き出した設定は、変動枠と音美の釣り合いが取れていないことがある
                    const fix = normalizeVarRotation();
                    save();
                    saveResultToStorage();
                    showStep(1);
                    alert('読み込みました。Step 1 から内容を確認してください。'
                        + (cycleTrimmed ? '\n\n' + CYCLE_TRIMMED_MSG : '')
                        + (varRotationChanged(fix) ? '\n\n' + varRotationNotice(fix) : ''));
                };
                reader.readAsText(file);
            });
            picker.click();
        });
        // 開きっぱなしのファイル入力が残らないよう、ステップを描き直すたびに掃除する
        document.querySelectorAll('#tgImportFile').forEach(x => x.remove());

        document.getElementById('tgReset').addEventListener('click', () => {
            if (!confirm('入力内容をすべて消去して最初からやり直します。よろしいですか？（この操作は元に戻せません）')) return;
            state = defaultState();
            // 初期値どうしが噛み合っていれば何も起きない。DEFAULT_HOURS だけを直して
            // 変動枠の既定と食い違わせた場合の保険として、ここも同じ検査に通す
            const fix = normalizeVarRotation();
            save();
            showStep(1);
            if (varRotationChanged(fix)) showVarFixNotice(varRotationNotice(fix));
        });

        // 復元・再訪時も生成結果を表示する（#solverResult はステップ本体と別枠のため明示的に再描画）
        renderSolverResult();
    }

    // ---------- 生成結果（solver.js） ----------

    // 生成時点の条件のシグネチャ（step はステップ移動だけで変わるため除外）
    let solverStateSig = null;
    function stateSignature() {
        // step（表示中のステップ）と探索時間の上限は時間割の条件ではないため署名から除外。
        // A週とB週のズレ許容（abMode）は配置に影響する条件なので署名に含める
        const snapshot = Object.assign({}, state, { step: 0, solver: { abMode: solverAbMode(), ignored: ignoredIdList() } });
        // 学校名・年度は配付物の見出しの文字であって、コマの置き方には関係しない。
        // 署名に入れると、時間割を組んだあとに学校名を打っただけで結果が消えてしまう。
        // 値を固定せずキーごと消すのは、この項目が無かった頃に自動保存した結果とも
        // 署名を一致させて、更新後も続きから手直しできるようにするため
        delete snapshot.schoolName;
        delete snapshot.schoolYear;
        return JSON.stringify(snapshot);
    }

    // 生成後に条件が「実質的に」変更されたら、古い結果を破棄して案内を出す
    function invalidateSolverResult() {
        if (!lastResult || solverRunning || relaxRunning) return;   // 調査中の時間割を足元から消さない
        if (solverStateSig !== null && solverStateSig === stateSignature()) return;  // ステップ移動等は無視
        lastResult = null;
        solverStateSig = null;
        const el = document.getElementById('solverResult');
        if (el && el.innerHTML) {
            el.innerHTML = '<p class="hint">条件が変更されたため、前回の生成結果をクリアしました。Step 9 の「時間割を組む」で組み直してください。</p>';
        }
    }

    let solverCancelFlag = false;
    // 「条件を1つ緩めた場合の効果」の調査が失敗したときの説明（次の調査開始でクリア）
    let relaxErrorMsg = '';
    // 「条件を1つ緩めた場合の効果」を調査中かどうか。
    // 時間割の生成（solverRunning）は画面全体を覆う待ち画面が出るので他の操作を受け付けないが、
    // この調査は待ち画面を出さないまま数分走る。その間に「時間割を組む」や手直しが動くと、
    // 調査が終わったときに新しい結果へ古い調査結果を書き込んでしまう。
    let relaxRunning = false;
    let relaxCancelFlag = false;   // 「条件を1つ緩めた場合の効果」調査の中断フラグ（ボタン再クリックで立つ）

    // 手直し（Step 10）を「中断する」が押されたかどうか。時間割を組むときの中断（solverCancelFlag）とは別。
    let editCancelFlag = false;
    // 手直しは、うまく入らなかったときに条件を変えて自分自身を何度も呼び直す
    // （支援学級の授業も一緒に動かす再挑戦など）。進み具合の表示と中断の受付は
    // 一番外側の呼び出しだけで面倒を見たいので、呼び出しの入れ子の深さを数えておく。
    let editSolveDepth = 0;

    // 生成中オーバーレイ（スピナー＋試行回数＋キャンセル）
    function showSolverOverlay() {
        let ov = document.getElementById('tgSolverOverlay');
        if (!ov) {
            ov = document.createElement('div');
            ov.id = 'tgSolverOverlay';
            ov.innerHTML =
                '<div class="tg-solver-box">' +
                '<div class="tg-spinner"></div>' +
                '<div class="tg-solver-title">時間割を作成中…</div>' +
                '<div class="tg-solver-status" id="tgSolverStatus">準備中</div>' +
                '<div class="tg-solver-hint" style="font-size:11px;color:#888;margin:2px 0 6px">' +
                '探索は3段階で進みます: ①条件どおり → ②入らない場合だけ条件を1つずつ外して再探索 → ③外した条件を可能な限り戻す。' +
                '選んだ上限時間を3段階で分け合うため、「この段階」の持ち時間は全体より短くなります。</div>' +
                '<div id="tgSolverPreview" class="tg-live-wrap"></div>' +
                '<button type="button" class="btn btn-secondary" id="tgSolverCancel">中断して現在の最良案を表示</button>' +
                '</div>';
            document.body.appendChild(ov);
            document.getElementById('tgSolverCancel').addEventListener('click', () => { solverCancelFlag = true; });
        }
        ov.style.display = 'flex';
        document.getElementById('tgSolverStatus').textContent = '準備中';
    }
    // 経過時間の表示: 60秒以上は「X分Y秒」
    function fmtDuration(ms) {
        const sec = Math.floor(ms / 1000);
        if (sec < 60) return sec + '秒';
        return Math.floor(sec / 60) + '分' + (sec % 60 ? (sec % 60) + '秒' : '');
    }

    // 生成中プレビューの描画間引き（300msに1回。毎バッチ描くと無駄に重い）
    let livePreviewAt = 0;

    function renderLivePreview(p) {
        const box = document.getElementById('tgSolverPreview');
        if (!box || !p.preview) return;
        const now = Date.now();
        if (now - livePreviewAt < 300) return;
        livePreviewAt = now;

        const cids = classIds().concat(state.support.classes.map(sc => 'sc:' + sc.id));
        const shortName = cid => cid.startsWith('sc:')
            ? ((state.support.classes.find(x => 'sc:' + x.id === cid) || {}).name || '支援').slice(0, 2)
            : cid;
        const varSlot = state.skeleton.varSlot || {};
        const renderWeek = (title, preview) => {
            let html = title ? '<section class="tg-live-week"><div class="tg-live-week-title">' + title + '</div>' : '';
            html += '<table class="tg-live-table"><thead><tr><th></th>' +
                SOLVER_DAY_KEYS.map(d => '<th colspan="' + (Number(state.skeleton.periods[d]) || 0) + '">' + SOLVER_DAY_JP[d] + '</th>').join('') +
                '</tr></thead><tbody>';
            cids.forEach(cid => {
                html += '<tr><th>' + esc(shortName(cid)) + '</th>';
                SOLVER_DAY_KEYS.forEach(d => {
                    const max = Number(state.skeleton.periods[d]) || 0;
                    for (let per = 1; per <= max; per++) {
                        const s = preview[cid + '|' + d + '-' + per];
                        const isVar = !!s && d === varSlot.day && per === Number(varSlot.period);
                        const cls = (s ? 'f' : '') + (isVar ? ' tg-live-var' : '');
                        html += s ? '<td class="' + cls.trim() + '">' + esc(ovShort(s).slice(0, 1)) + '</td>' : '<td></td>';
                    }
                });
                html += '</tr>';
            });
            html += '</tbody></table>';
            return title ? html + '</section>' : html;
        };

        // 新形式 { B: {...}, A: {...} } は2週を表示。旧形式のフラットMapも従来どおり表示する。
        const twoWeeks = p.preview.B && p.preview.A;
        let html = twoWeeks
            ? renderWeek('B週', p.preview.B) + renderWeek('A週', p.preview.A)
            : renderWeek('', p.preview);
        html += '<div class="tg-live-note">いま試している案: 未配置 ' + (p.previewKey ? p.previewKey[0] : '?') +
            '・重なり ' + (p.previewKey ? p.previewKey[1] : '?') + '（試行のたびに置き直しています）</div>';
        box.innerHTML = html;
    }

    function updateSolverOverlay(p) {
        renderLivePreview(p);
        const el = document.getElementById('tgSolverStatus');
        if (!el) return;
        let bestText = '';
        if (p.bestKey) {
            const softSum = p.bestKey.slice(2).reduce((a, b) => a + b, 0);
            bestText = p.bestKey[0] === 0 && p.bestKey[1] === 0
                ? '全コマ配置済み・できれば条件を最適化中（違反 ' + softSum + '）'
                : '現在の最良: 未配置 ' + p.bestKey[0] + '・重なり等 ' + p.bestKey[1];
        }
        const hardComplete = p.bestKey && p.bestKey[0] === 0 && p.bestKey[1] === 0;
        const roundText = p.round > 1 ? '／ラウンド ' + p.round : '';
        const stagnantText = !hardComplete && p.stagnantAttempts > p.stagnationLimit / 2
            ? '／この案で ' + p.stagnantAttempts.toLocaleString() + ' 回改善なし'
            : '';
        // 終盤の詰将棋（残ったコマを深く読んで押し込む処理）は1コマに数秒かかる。
        // ここに何も出ないと画面が止まって見え、リロードされて生成結果を失うため進み具合を出す。
        // 画面には「詰将棋」とは書かない（コード内だけの言い回しで、教員には通じない）
        const endgameText = p.endgame
            ? '／入りきらなかったコマを調整中 ' + p.endgame.done + '/' + p.endgame.total + ' コマ'
            : '';
        // 探索は3段階（①条件どおり→②条件を1つずつ外す→③外した条件を戻す）で時間を分け合う。
        // 以前は「いまの段階の持ち時間」を丸めて上限として出しており、3分を選んでも
        // 「上限1分」「上限0分」と表示されて紛らわしかった（実運用レビュー 2026-07-28）。
        // 段階名と「この段階/全体」の両方を明示する。
        // p.relaxation はソルバ側で完成した文（「◯◯」を外して探索中、など）なのでそのまま使う
        let phaseText = '';
        if (p.phase) {
            phaseText = '【段階' + p.phase + '/3・' + (p.relaxation || '条件を調整中') + '】';
        }
        const stageLim = p.budgetMs ? 'この段階 ' + fmtDuration(p.elapsedMs) + '/' + fmtDuration(p.budgetMs) : fmtDuration(p.elapsedMs);
        const totalLim = p.totalBudgetMs ? '・全体 ' + fmtDuration(p.totalElapsedMs || 0) + '/' + fmtDuration(p.totalBudgetMs) : '';
        el.textContent = phaseText + '試行 ' + (p.attempts || 0).toLocaleString() + ' 回（' + stageLim + totalLim + roundText + stagnantText + endgameText + '）' + (bestText ? ' ／ ' + bestText : '');
    }
    function hideSolverOverlay() {
        const ov = document.getElementById('tgSolverOverlay');
        if (ov) ov.style.display = 'none';
    }

    // ---------- 手直し（Step 10）の進み具合と中断 ----------
    // 手直しの計算は最大1分ほどかかる。時間割を組むときのような全画面の待ち画面にすると
    // 直している盤面が隠れて「どこを直していたか」を見失うので、画面のすみに小さく出す。
    // ここに何も出ないと固まったように見え、リロードされて手直しの成果ごと失われる。
    // 「中断する」だけは調整中でも押せる（他のボタンは押せないようにしてある）。
    // このかたまりを step10Body の外（body 直下）に置いているのは、
    // 盤面を描き直すたびに消えてしまわないようにするため。
    function showEditProgress(note) {
        let box = document.getElementById('tgEditProgress');
        if (!box) {
            box = document.createElement('div');
            box.id = 'tgEditProgress';
            box.className = 'no-print';
            box.setAttribute('role', 'status');
            box.innerHTML =
                '<div class="tg-editprog-head"><span class="tg-editprog-spin"></span>' +
                '<span class="tg-editprog-title">時間割を調整中…</span></div>' +
                '<div class="tg-editprog-note" id="tgEditProgNote"></div>' +
                // 試行回数は1秒に何度も変わる。読み上げソフトが延々としゃべり続けないよう、
                // この行だけは読み上げの対象から外す（進み具合は目で見れば足りる）
                '<div class="tg-editprog-status" id="tgEditProgStatus" aria-live="off">準備中</div>' +
                '<button type="button" class="btn btn-secondary" id="tgEditProgCancel">中断する（元のままにする）</button>';
            document.body.appendChild(box);
            document.getElementById('tgEditProgCancel').addEventListener('click', () => {
                editCancelFlag = true;
                const b = document.getElementById('tgEditProgCancel');
                if (b) { b.disabled = true; b.textContent = '中断しています…'; }
                const s = document.getElementById('tgEditProgStatus');
                if (s) s.textContent = '中断しています。時間割は元のままに戻します。';
            });
        }
        const btn = document.getElementById('tgEditProgCancel');
        if (btn) { btn.disabled = false; btn.textContent = '中断する（元のままにする）'; }
        setEditProgressNote(note || '');
        const st = document.getElementById('tgEditProgStatus');
        if (st) st.textContent = '準備中';
        box.style.display = 'block';
    }
    function setEditProgressNote(text) {
        const el = document.getElementById('tgEditProgNote');
        if (!el) return;
        el.textContent = text || '';
        el.style.display = text ? 'block' : 'none';
    }
    // 再挑戦の途中経過は、手直しバーの中（tgEditMsg）とすみの表示の両方に出す。
    // バーは画面の上のほうにあり、盤面の下を見ているときは目に入らないため。
    function editRetryNote(text) {
        const m = document.getElementById('tgEditMsg');
        if (m) m.textContent = text;
        setEditProgressNote(text);
    }
    function updateEditProgress(p) {
        const el = document.getElementById('tgEditProgStatus');
        if (!el || editCancelFlag) return;   // 中断中の案内を試行回数で上書きしない
        let best = '';
        if (p.bestKey) {
            best = (p.bestKey[0] === 0 && p.bestKey[1] === 0)
                ? ' ／ いまの案: 全部入っています'
                : ' ／ いまの案: 入っていない ' + p.bestKey[0] + '・重なり等 ' + p.bestKey[1];
        }
        const endgame = p.endgame
            ? '／入りきらなかったコマを調整中 ' + p.endgame.done + '/' + p.endgame.total + ' コマ'
            : '';
        const time = p.budgetMs
            ? fmtDuration(p.elapsedMs || 0) + '/' + fmtDuration(p.budgetMs)
            : fmtDuration(p.elapsedMs || 0);
        el.textContent = '試行 ' + (p.attempts || 0).toLocaleString() + ' 回（' + time + '）' + endgame + best;
    }
    function hideEditProgress() {
        const box = document.getElementById('tgEditProgress');
        if (box) box.style.display = 'none';
    }

    // 探索時間の上限（分）: ユーザー選択可。
    // 2026-07-28 に 1・3・5分の3択へ縮小（運用判断）。詰将棋・dayMin修復の完成後は
    // 実データでも4〜14秒で完全解に到達しており、10分・20分の出番が実測上なくなったため。
    const SOLVER_MAX_MIN = 5;
    const SOLVER_BUDGET_CHOICES = [1, 3, 5];

    // 学校の規模から探索時間のおすすめを計算する（現場要望 2026-07-28）。
    // 根拠は実測: 実データ（通常9学級＋支援1・週約270コマ）は3分で
    // 完全解に3/4で到達（詰将棋オン）。規模が大きいほど1試行が重く多スタートも
    // 多く要るため、コマ数の概算に応じて段階的に長くする。
    function suggestedBudgetMin() {
        const classCount = Object.values(state.classes || {})
            .reduce((a, b) => a + (Number(b) || 0), 0);
        const supportCount = ((state.support || {}).classes || []).length;
        // 週29コマ×学級数＋支援学級ぶんの概算（支援は国数英＋自立・生単で15コマ程度）
        const approxLessons = classCount * 29 + supportCount * 15;
        let min;
        if (approxLessons <= 200) min = 1;
        else if (approxLessons <= 300) min = 3;
        else min = 5;
        // 選択肢の中で一番近いものに合わせる
        const pick = SOLVER_BUDGET_CHOICES.reduce((best, c) =>
            Math.abs(c - min) < Math.abs(best - min) ? c : best, SOLVER_BUDGET_CHOICES[0]);
        return { min: pick, classCount, supportCount, approxLessons };
    }
    function solverBudgetMin() {
        const m = Number(state.solver && state.solver.budgetMin) || 3;
        return Math.min(SOLVER_MAX_MIN, Math.max(1, m));
    }
    // A週とB週のズレ許容モード
    const AB_MODE_CHOICES = [
        ['exact', '完全に同じ（音美コマの差し替えのみ）'],
        ['repair', '少しずらしてもよい（必要な分だけ入れ替え）'],
        ['free', 'バラバラでもよい（ズレの量を抑えない）']
    ];
    function solverAbMode() {
        const m = state.solver && state.solver.abMode;
        return (m === 'repair' || m === 'free') ? m : 'exact';
    }

    // 「無視して組む条件」: 結果画面の「この条件を無視してもう一度組む」で追加され、
    // Step 9 のチップ（×）で解除する。設定そのもの（Step 5d・8）は書き換えない一時オーバーライド
    function ignoredConds() { return (state.solver && state.solver.ignored) || []; }   // [{id, label}]
    function ignoredIdList() { return ignoredConds().map(x => x.id); }
    function addIgnored(id, label) {
        state.solver = state.solver || {};
        const list = state.solver.ignored = state.solver.ignored || [];
        if (!list.some(x => x.id === id)) list.push({ id, label });
        save();
    }
    function removeIgnored(id) {
        if (!state.solver || !state.solver.ignored) return;
        state.solver.ignored = state.solver.ignored.filter(x => x.id !== id);
        save();
    }

    async function runSolver() {
        if (!window.TimetableSolver) {
            alert('生成エンジン（js/solver.js）が読み込まれていません。');
            return;
        }
        // 「条件を1つ緩めた場合の効果」の調査中に組み直すと、調査が終わったときに
        // 新しい時間割へ古い調査結果が付いてしまうので、終わるまで待ってもらう
        if (solverRunning || relaxRunning) return;
        // 隔週交代（音美・技家）が2週以下に残ったまま生成すると、画面とExcelが食い違う
        // 矛盾した結果になるため、組む前に止める（通常はサイクル変更時に自動振替されるので、
        // ここに来るのは古い保存データや読み込んだ設定ファイル経由の場合だけ）
        if (biweeklyGradesUnderThreeWeeks().length) {
            alert(exportLimitNote());
            return;
        }
        solverRunning = true;
        solverCancelFlag = false;
        showSolverOverlay();
        try {
            applyHomeroomDefaults();
            if (hasVarSlot()) ensureVarContent();  // Step 3 未訪問でも変動枠の既定値を補完
            save();
            const budgetMin = solverBudgetMin();
            // 前回の実行で詰まった授業（未配置・同日重複）を最初から最優先で置く（再実行の学習）
            const prevStuck = (lastResult && solverStateSig === stateSignature() && lastResult.carryBoostIds) || [];
            lastResult = await callSolver('solveEscalating', JSON.parse(JSON.stringify(state)), {
                timeBudgetMs: budgetMin * 60000,
                maxAttempts: budgetMin * 40000,
                initialBoostIds: prevStuck,
                ignoredIds: ignoredIdList()
            }, {
                onProgress: updateSolverOverlay,
                shouldCancel: () => solverCancelFlag
            });
            // 表示状態のリセットは「生成が成功してから」。途中でエラーになったときに、
            // 前回の結果と🔒（確定したコマ）まで巻き添えで失わせないため
            activeAlt = 0;  // 案の選択を最良案に戻す
            editUi = freshEditUi();  // 手直しモードの選択・🔒は新しい生成でリセット
            solverStateSig = stateSignature();  // この条件に対する結果として記録
            saveResultToStorage();
        } catch (err) {
            // 例外で止まると、教員から見れば「ボタンを押したのに何も起きない」状態になる。
            // 何が起きたのか・次に何をすればよいのかを必ず画面に残す
            console.error('[timetable-generator] 時間割の生成でエラーが発生しました', err);
            const box = document.getElementById('solverResult');
            const detail = esc((err && err.message) ? err.message : String(err));
            if (box) {
                box.innerHTML = '<div class="tg-error"><strong>時間割の生成が途中で止まりました。</strong>' +
                    '入力した条件と、前に作った時間割があればそのまま残っています。<br>' +
                    'まずはもう一度「時間割を組む」を押してやり直してください。何度やっても止まる場合は、' +
                    // 事前チェックは「！」（赤）と「△」（黄）の2種類ある。色だけで指すと
                    // 黄色い警告が指示から漏れるうえ、色が見分けにくい人にも伝わらない
                    '①探索時間の上限を短くする ②このページの上に出ている「！」「△」の付いた行（事前チェック）を直す ' +
                    '③ページを再読み込みする、の順にお試しください。' +
                    '<br><span class="hint">技術的な内容: ' + detail + '</span></div>';
                box.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } else {
                alert('時間割の生成が途中で止まりました。もう一度「時間割を組む」を押してやり直してください。');
            }
            return;   // 中途半端な状態で結果画面を描き直さない（finally は必ず実行される）
        } finally {
            solverRunning = false;
            hideSolverOverlay();   // 成功・失敗・中断のいずれでもオーバーレイは必ず閉じる
        }
        renderSolverResult();
        const el = document.getElementById('solverResult');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // A週の充当コマを時刻Tに入れたいが、その時刻に同じ先生の基底授業（両週）が居る場合:
    // その基底授業の「移しやすい退避先」候補を静的に絞る（先生が空いていて、同日同教科にならないスロット）
    function relocationPlan(awTeacherIds, day, period) {
        const cells = activeCells();
        let conf = null, confKey = null;
        for (const [k, c] of Object.entries(cells)) {
            const [, d2, p2] = k.split('|');
            if (d2 === day && Number(p2) === Number(period) &&
                (c.teacherIds || []).some(t => awTeacherIds.includes(t))) { conf = c; confKey = k; break; }
        }
        if (!conf) return null;
        const ccid = confKey.split('|')[0];
        const busy = new Set();
        Object.entries(cells).forEach(([k, c]) => {
            if ((c.teacherIds || []).some(t => (conf.teacherIds || []).includes(t))) {
                const seg = k.split('|');
                busy.add(seg[1] + '-' + seg[2]);
            }
        });
        const dayHasSub = {};
        Object.entries(cells).forEach(([k, c]) => {
            const seg = k.split('|');
            if (seg[0] === ccid && c.subject === conf.subject) dayHasSub[seg[1]] = true;
        });
        // 先生の出講不可（na）も除外（金曜が出講不可の先生なら、金曜は候補にならない）
        const naSet = new Set();
        (conf.teacherIds || []).forEach(tid => {
            const t = state.teachers.find(x => x.id === tid);
            ((t && t.na) || []).forEach(x => naSet.add(typeof x === 'string' ? x : (x.day + '-' + x.period)));
        });
        const cands = [];
        SOLVER_DAY_KEYS.forEach(d2 => {
            const maxP = Number(state.skeleton.periods[d2]) || 0;
            for (let p2 = 1; p2 <= maxP; p2++) {
                if (d2 === day && p2 === Number(period)) continue;
                if (busy.has(d2 + '-' + p2)) continue;      // 先生が既に授業中
                if (naSet.has(d2 + '-' + p2)) continue;      // 先生が出講できない時間
                if (dayHasSub[d2]) continue;                 // 同日同教科になる
                cands.push({ day: d2, period: p2 });
            }
        });
        return { conf, cands: cands.slice(0, 6) };
    }

    // 手動連鎖モードのライブ違反チェック（B週の作業盤に対する静的検査）。
    // 教員の重なり／同日同教科（隔週の構成教科込み）／出講不可／非常勤の午後／支援同期を見る。
    const MANUAL_DAY_CONFLICT = { '音美': ['音楽', '美術'], '技家': ['技術', '家庭'],
                                  '音楽': ['音美'], '美術': ['音美'], '技術': ['技家'], '家庭': ['技家'] };
    function checkManualViolations(grid) {
        const out = [];
        const tById = {}; state.teachers.forEach(t => { tById[t.id] = t; });
        // 教員の重なり（同じペアの逆位相は除く）
        const bySlot = {};
        Object.entries(grid).forEach(([k, c]) => {
            const seg = k.split('|');
            (c.teacherIds || []).forEach(tid => {
                const key = tid + '|' + seg[1] + '|' + seg[2];
                (bySlot[key] = bySlot[key] || []).push(c);
            });
        });
        Object.entries(bySlot).forEach(([key, arr]) => {
            const uniq = [...new Set(arr.map(c => c.lessonId))];
            if (uniq.length < 2) return;
            const pk = arr[0].pairKey;
            if (pk && arr.every(c => c.pairKey === pk)) return;   // 逆位相ペアの同時刻はOK
            const seg = key.split('|');
            out.push(((tById[seg[0]] || {}).name || '教員') + ': ' + (SOLVER_DAY_JP[seg[1]] || seg[1]) + seg[2] +
                '限に ' + arr.map(c => (c.classIds || [])[0] + c.subject).join(' と ') + ' が重なっています');
        });
        // 同日同教科（構成教科込み）・出講不可・非常勤の午後
        const byClassDay = {};
        Object.entries(grid).forEach(([k, c]) => {
            const seg = k.split('|');
            const cid = seg[0], d = seg[1], per = Number(seg[2]);
            (byClassDay[cid + '|' + d] = byClassDay[cid + '|' + d] || []).push(c.subject);
            (c.teacherIds || []).forEach(tid => {
                const t = tById[tid];
                if (!t) return;
                const na = (t.na || []).map(x => typeof x === 'string' ? x : (x.day + '-' + x.period));
                if (na.includes(d + '-' + per)) out.push((t.name || '教員') + ': ' + (SOLVER_DAY_JP[d] || d) + per + '限（' + cid + c.subject + '）は出講できない時間です');
                if (t.part && t.part.lunch === 'am_only' && per >= 5) out.push((t.name || '教員') + ': 午前のみの設定ですが ' + (SOLVER_DAY_JP[d] || d) + per + '限（' + cid + c.subject + '）が午後です');
            });
        });
        Object.entries(byClassDay).forEach(([key, subs]) => {
            const seg = key.split('|');
            const seen = {};
            subs.forEach(sub => { seen[sub] = (seen[sub] || 0) + 1; });
            Object.entries(seen).forEach(([sub, n]) => {
                if (n > 1 && !EDIT_FIXED_SUBJECTS.has(sub)) out.push(seg[0] + ': ' + (SOLVER_DAY_JP[seg[1]] || seg[1]) + '曜に ' + sub + ' が ' + n + ' コマあります（同日重複）');
                (MANUAL_DAY_CONFLICT[sub] || []).forEach(other => {
                    if (seen[other] && sub < other) out.push(seg[0] + ': ' + (SOLVER_DAY_JP[seg[1]] || seg[1]) + '曜に ' + sub + ' と ' + other + ' が同居しています（隔週の構成教科は同日不可）');
                });
            });
        });
        // 支援同期: 交流学級の支援対象教科の時刻に、支援学級の授業（生徒の行き場）があるか
        (state.support.students || []).forEach(st => {
            const E = st.exchangeClass, scKey = 'sc:' + st.supportClassId;
            if (!E || !st.supportClassId) return;
            const supSubs = new Set(Object.keys(st.subjects || {}).filter(x => st.subjects[x] === 'support'));
            Object.entries(grid).forEach(([k, c]) => {
                const seg = k.split('|');
                if (seg[0] !== E || !supSubs.has(c.subject)) return;
                const scCell = grid[scKey + '|' + seg[1] + '|' + seg[2]];
                const attends = scCell && (scCell.subject === '自立活動' || scCell.subject === '生活単元' || supSubs.has(scCell.subject));
                if (!attends) out.push((st.label || '生徒') + ': ' + (SOLVER_DAY_JP[seg[1]] || seg[1]) + seg[2] + '限の ' + E + c.subject + ' の時間に支援学級の行き場がありません（支援同期）');
            });
        });
        return out;
    }

    // ペア（技家・音美の逆位相）の相手コマを探す
    function pairPartnerOf(lid) {
        let me = null;
        for (const c of Object.values(activeCells())) { if (c.lessonId === lid) { me = c; break; } }
        if (!me || !me.pairKey) return null;
        for (const c of Object.values(activeCells())) {
            if (c.pairKey === me.pairKey && c.lessonId !== lid) {
                return { lessonId: c.lessonId, subject: c.subject, cid: (c.classIds || [])[0] };
            }
        }
        return null;
    }

    // ピンが「支援生徒が支援学級にいない時刻」で失敗したとき、
    // その学級の生徒が在籍する支援学級の動かせる授業を列挙する（同じ時刻へ連れてくる候補）
    function candidateSupportPins(pin) {
        // ピンした授業の学級を特定
        let cid = null;
        for (const c of Object.values(activeCells())) {
            if (c.lessonId === pin.lessonId) { cid = (c.classIds || [])[0]; break; }
        }
        if (!cid && lastResult) {
            const spec = (lastResult.lessonSpecs || []).find(sp => sp.id === pin.lessonId);
            if (spec) cid = (spec.classIds || [])[0];
        }
        if (!cid) return [];
        // この学級を交流学級とする生徒の支援学級
        const scIds = new Set();
        (state.support.students || []).forEach(st => {
            if (st.exchangeClass === cid && st.supportClassId) scIds.add('sc:' + st.supportClassId);
        });
        if (!scIds.size) return [];
        // 支援学級の動かせる授業（固定コマ以外）。行き先に既に居る授業は除く
        const out = [];
        const seen = new Set();
        Object.entries(activeCells()).forEach(([k, c]) => {
            const [ccid, d, per] = k.split('|');
            if (!scIds.has(ccid) || seen.has(c.lessonId)) return;
            seen.add(c.lessonId);
            if (EDIT_FIXED_SUBJECTS.has(c.subject)) return;
            if (d === pin.day && Number(per) === Number(pin.period)) return;  // 既にその時刻に居る
            out.push({ lessonId: c.lessonId, day: pin.day, period: pin.period, subject: c.subject });
        });
        return out;
    }

    // 調整中（editUi.busy）に押せてしまうと困る操作の一覧。
    // 調整には最大1分ほどかかる。その間に押せると、調整が終わったときに古い盤面で
    // 上書きされて「1手戻したのに戻らない」「手動連鎖を確定したら手直しが巻き戻る」
    // 「🔒したのに探索には効いていない」といった、表示と中身の食い違いが起きる。
    const EDIT_BUSY_LOCK_SEL = [
        'input[name="tgEditMode"]',                                                          // クリック時の動作（モード切替）
        '#tgEditUndo',                                                                       // ↩1手戻す
        '#tgEditTeacherSel', '#tgEditLockTeacher', '#tgEditUnlockTeacher', '#tgEditClear',   // 先生単位のまとめ操作
        'button[data-unplaced]', 'button[data-floating]',                                    // 未配置・浮いているコマのチップ
        '#tgManualUndo', '#tgManualCommit', '#tgManualDiscard',                              // 手動連鎖の作業パネル
        'button[data-ignore]', 'button[data-unignore]'                                       // 違反の無視・無視の取り消し
    ].join(',');

    // 調整中は「見た目でも押せない」状態にする。
    // 押せそうに見えるのに効かないより、押せないと分かるほうが混乱が少ない。
    // busy でないときに何もしないのは、描画時に条件付きで disabled を付けているボタン
    // （浮いているコマが残っている間の「この形で確定する」など）を勝手に有効化しないため。
    function applyEditBusyUi() {
        if (!editUi.busy) return;
        document.querySelectorAll(EDIT_BUSY_LOCK_SEL).forEach(x => { x.disabled = true; });
    }

    // 手直し画面（Step 10）と結果画面のどちらに居ても正しい方を再描画する
    function rerenderEditSurface() {
        if (state.step === 10) renderStep10(); else renderSolverResult();
        applyEditBusyUi();   // 調整の開始・終了はここを通るので、見た目への反映もここでまとめて行う
    }

    // 手直しの入口。中の runEditSolveCore は、うまく入らなかったときに条件を変えて
    // 自分自身を何度も呼び直す。そのため「進み具合の表示を出す・中断を受け付ける・後片付けをする」は
    // 一番外側の1回だけが行う。入れ子の呼び出しは、中断が押されていたらそこで打ち切る。
    async function runEditSolve(op) {
        if (editSolveDepth > 0) {
            if (editCancelFlag) return false;   // 中断済み。これ以上は試さない
            editSolveDepth++;
            try {
                return await runEditSolveCore(op);
            } finally {
                editSolveDepth--;
            }
        }
        // ここから一番外側。弾く条件は runEditSolveCore の入口と同じ
        if (solverRunning || relaxRunning || editUi.busy || !lastResult) return false;
        editCancelFlag = false;
        editSolveDepth = 1;
        // すぐ終わる調整（1秒かからないことも多い）で表示がちらつかないよう、
        // 0.4秒たっても終わらないときだけ進み具合を出す
        const showTimer = setTimeout(showEditProgress, 400);
        try {
            return await runEditSolveCore(op);
        } finally {
            editSolveDepth = 0;
            clearTimeout(showTimer);
            hideEditProgress();
            if (editCancelFlag) editUi.msg = '中断しました。時間割は元のままです。';
            // 途中で予期せず止まっても「調整中」のまま操作できなくなるのを防ぐ（最後の砦）
            if (editUi.busy || editCancelFlag) {
                editUi.busy = false;
                rerenderEditSurface();
            }
        }
    }

    // 手直しモードの実行: 現在の盤面を種に、📌/A週内の移動＋これまでの🔒を渡して再成立させる。
    // op = { pin: {lessonId,day,period} } … 両週共通の移動（従来）
    //      { awPin: {lessonId,day,period} } … A週専用コマ（充当）のA週内での移動
    async function runEditSolveCore(op) {
        // awSmart: 充当コマ（A週専用）の移動。設計方針「まず両週を一緒に動かし、
        // どうしてもダメならA週だけ」——①元の音美コマをB週でピン（A週の充当は自動で追従）
        // ②それが無理なら awPin（A週内だけの入れ替え）に自動フォールバック
        // pairSmart: 技家・音美ペアの移動。まず相手のクラスのコマも同じ時刻へまとめて動かし、
        // 無理なら片方だけ動かして（隔週交代が別時刻に分かれる）その旨を明示する
        if (op && op.pairSmart) {
            const ps = op.pairSmart;
            const ok = await runEditSolve({ pin: ps.pin, extra: [ps.partner], _quietFail: true, _pairJoint: true });
            if (ok) return true;
            return runEditSolve({ pin: ps.pin, _pairSplit: true });
        }
        if (op && op.awSmart) {
            const a = op.awSmart;
            // ①音美コマごと両週を動かす
            if (a.onbiLessonId) {
                const ok = await runEditSolve({ pin: { lessonId: a.onbiLessonId, day: a.day, period: a.period },
                                               _quietFail: true, _viaOnbi: a });
                if (ok) return true;
            }
            // ②A週内の入れ替え・押しのけ
            {
                const ok = await runEditSolve({ awPin: { lessonId: a.awLessonId, day: a.day, period: a.period }, _quietFail: true });
                if (ok) return true;
            }
            // ③その時刻に同じ先生の授業（両週）が居るなら、それを深い詰将棋で別の時刻へ
            //   動かして席を空け、あらためて充当を入れる（設計方針「大掛かりでもトライ」）
            const awCell = Object.values((lastResult.aWeek || {}).cells || {}).find(c => c.lessonId === a.awLessonId);
            const plan = awCell ? relocationPlan(awCell.teacherIds || [], a.day, a.period) : null;
            if (plan) {
                // ③a 明示的な退避先の候補があれば、そこへ動かして席を空ける
                for (let i = 0; i < plan.cands.length; i++) {
                    const cd = plan.cands[i];
                    editRetryNote('同じ時刻にある「' + plan.conf.subject + '」（両週）を ' +
                        SOLVER_DAY_JP[cd.day] + cd.period + '限へ動かして席を空ける再挑戦中…（' +
                        (i + 1) + '/' + plan.cands.length + '）');
                    editUi.busy = false;
                    const ok = await runEditSolve({
                        pin: { lessonId: plan.conf.lessonId, day: cd.day, period: cd.period },
                        awPin: { lessonId: a.awLessonId, day: a.day, period: a.period },
                        _quietFail: true, _fast: true,
                        _viaRelocate: { subject: plan.conf.subject }
                    });
                    if (ok) return true;
                }
                // ③b 明示候補が無い（その先生の持ちコマが飽和している）場合: 席だけ外して行き先は
                //     深い詰将棋に任せる（乱数を変えて3回）。玉突きの連鎖ごと組み替える最終手段
                for (let i = 0; i < 3; i++) {
                    editRetryNote('「' + plan.conf.subject + '」の席を外し、行き先をおまかせで組み替える再挑戦中…（' +
                        (i + 1) + '/3）');
                    editUi.busy = false;
                    const ok = await runEditSolve({
                        banTeacherSlots: (awCell.teacherIds || []).map(tid => ({ tid, day: a.day, period: a.period })),
                        awPin: { lessonId: a.awLessonId, day: a.day, period: a.period },
                        _quietFail: true, _fast: true, _seedShift: i * 104729,
                        _viaRelocate: { subject: plan.conf.subject }
                    });
                    if (ok) return true;
                }
            }
            // すべて不発 → 通常のA週内移動をもう一度実行して、具体的な理由を表示させる
            const last = await runEditSolve({ awPin: { lessonId: a.awLessonId, day: a.day, period: a.period }, _fallback: true });
            if (!last && plan && editUi.msg.startsWith('⚠')) {
                editUi.msg += ' さらに、同じ時刻の「' + plan.conf.subject + '」を両週ごと退避させる再挑戦' +
                    '（退避先の指定 ' + plan.cands.length + ' 通り＋行き先おまかせ 3 回）もすべて試しましたが、' +
                    'この先生の時間割に受け入れる余地がありませんでした。';
                const m = document.getElementById('tgEditMsg');
                if (m) m.textContent = editUi.msg;
            }
            return last;
        }
        const pin = op && op.pin ? op.pin : (op && op.lessonId ? op : null);   // 後方互換
        const awPin = op && op.awPin ? op.awPin : null;
        const extraPins = (op && op.extra) || [];   // 同伴ピン（支援学級の授業を同じ時刻へ等）
        const unseat = (op && op.unseat) || [];     // 席だけ外して行き先はソルバ任せ
        const banTeacherSlots = (op && op.banTeacherSlots) || [];   // この先生をこの時刻で空ける
        const quietFail = !!(op && op._quietFail);
        const viaOnbi = op && op._viaOnbi;
        const isFallback = !!(op && op._fallback);
        const fast = !!(op && op._fast);            // 再挑戦ループ用の短い予算
        if (solverRunning || relaxRunning || editUi.busy || !lastResult) return false;
        editUi.busy = true;
        rerenderEditSurface();
        const baseCells = activeCells();
        const baseACells = (lastResult.aWeek && lastResult.aWeek.cells) || {};
        const basePlaced = lastResult.placedCount || Object.keys(baseCells).length;
        const prevAwPins = editUi.awPins.slice();
        // これまでのA週内移動を再適用しつつ、今回の分を加える（同じコマの指定は上書き）
        const awPins = editUi.awPins.filter(x => !awPin || x.lessonId !== awPin.lessonId)
            .concat(awPin ? [awPin] : []);
        try {
            // 押し出されたコマの解決は順序に左右されるので、乱数を変えて最大8回試し最良を採る
            const seedCells = (op && op.placementsOverride) || baseCells;   // 手動連鎖の確定はその盤を種に
            const res = await callSolver('solve', JSON.parse(JSON.stringify(state)), {
                timeBudgetMs: fast ? 25000 : 90000, maxAttempts: fast ? 4 : 8,
                ignoredIds: ignoredIdList(),
                seed: ((lastResult && lastResult.seed) || 1) + 7919 + ((op && op._seedShift) || 0),
                editSeed: { placements: seedCells,
                            pins: (pin ? [pin] : []).concat(extraPins.map(x => ({ lessonId: x.lessonId, day: x.day, period: x.period }))),
                            lockedIds: [...editUi.locks], awPins, unseat, banTeacherSlots }
            }, {
                // 進み具合を画面のすみに出し、いつでも中断できるようにする
                // （何も出ないと固まったように見え、リロードされて手直しの成果ごと失われる）
                onProgress: updateEditProgress,
                shouldCancel: () => editCancelFlag
            });
            // 中断が押されたときは、途中まで探した案は採用しない。
            // 「中断する（元のままにする）」と書いてある以上、盤面は触らずに戻すのが約束
            if (editCancelFlag) { editUi.busy = false; return false; }
            const pinFailed = res && res.stats && res.stats.editPinFailed;
            const awFail = (res && res.aWeek && res.aWeek.awPinFailed) || [];
            if (!res || pinFailed || res.placedCount < basePlaced || (awPin && awFail.length)) {
                if (quietFail) { editUi.busy = false; return false; }   // 静かに失敗（フォールバック前提）
                // 支援同期が原因の失敗なら、支援学級の授業を同じ時刻へ連れてくる再挑戦（設計方針:
                // 「特別支援学級の授業から動かしたらいい。大掛かりでもトライして、不可能なら仕方ない」）
                let syncNote = '';
                if (pin && !op._syncRetry) {
                    const syncHit = ((res && res.unplaced) || []).some(u =>
                        u.lessonId === pin.lessonId && (u.reason || '').indexOf('支援生徒が支援学級にいない') >= 0);
                    if (syncHit) {
                        const cands = candidateSupportPins(pin);
                        for (let i = 0; i < cands.length; i++) {
                            editRetryNote('支援学級の「' + cands[i].subject + '」も同じ時刻へ動かして再挑戦中…（' +
                                (i + 1) + '/' + cands.length + '）');
                            editUi.busy = false;
                            const ok = await runEditSolve({ pin, extra: [cands[i]], _quietFail: true, _syncRetry: true, _fast: true });
                            if (ok) return true;
                        }
                        syncNote = cands.length
                            ? '支援学級の授業（' + cands.map(c => c.subject).join('・') + '）を一緒に動かす再挑戦も全て試しましたが入りませんでした。'
                            : '';
                    }
                }
                const why = (awPin && awFail.length)
                    ? awFail.join(' ／ ')
                    : ((res && res.unplaced) || []).map(u => u.name + ': ' + u.reason).join(' ／ ');
                editUi.msg = '⚠ この指定では入りませんでした。盤面は元のままです。' + (why ? '【理由】' + why : '') + syncNote;
            } else {
                const changed = new Set();
                new Set([...Object.keys(baseCells), ...Object.keys(res.cells)]).forEach(k => {
                    const a = baseCells[k], b = res.cells[k];
                    if ((a && a.lessonId) !== (b && b.lessonId)) changed.add(k);
                });
                // A週の差分も色付けする（B週の変更は差し替えを介してA週にも波及する）
                const newACells = (res.aWeek && res.aWeek.cells) || {};
                const changedA = new Set();
                new Set([...Object.keys(baseACells), ...Object.keys(newACells)]).forEach(k => {
                    const a = baseACells[k], b = newACells[k];
                    if ((a && a.lessonId) !== (b && b.lessonId)) changedA.add(k);
                });
                // 「できれば」違反の増減と、新たに引っかかった項目（現場要望 2026-07-28）
                {
                    const oldSet = new Set();
                    let oldTotal = 0, newTotal = 0;
                    (lastResult.softBreakdown || []).forEach(b => {
                        oldTotal += Number(b.violations) || 0;
                        (b.details || []).forEach(dd => oldSet.add(b.id + '|' + dd));
                    });
                    const items = [];
                    (res.softBreakdown || []).forEach(b => {
                        newTotal += Number(b.violations) || 0;
                        (b.details || []).forEach(dd => {
                            if (!oldSet.has(b.id + '|' + dd)) items.push({ label: softLabel(b.id), text: dd });
                        });
                    });
                    editUi.softDelta = { oldTotal, newTotal, items: items.slice(0, 30) };
                }
                editUi.changed = changed;
                editUi.changedA = changedA;
                editUi.prev = { result: lastResult, lockedPin: pin ? pin.lessonId : null,
                                lockedExtra: extraPins.map(x => x.lessonId), awPins: prevAwPins };  // 1手戻す用
                if (pin) editUi.locks.add(pin.lessonId);   // 📌したコマは以後🔒として保持
                extraPins.forEach(x => editUi.locks.add(x.lessonId));   // 同伴した支援学級のコマも保持
                editUi.awPins = awPins;
                lastResult = res;
                activeAlt = 0;
                saveResultToStorage();
                if (viaOnbi) {
                    // 音美コマごと動かした → この充当コマのA週内指定は不要になったので破棄
                    editUi.awPins = editUi.awPins.filter(x => x.lessonId !== viaOnbi.awLessonId);
                }
                editUi.msg = (op && op._manualCommit)
                    ? '✓ 手動連鎖の形で確定しました（元の案から動いたマス: B週 ' + changed.size + '・A週 ' + changedA.size + ' ・紫の枠）'
                    : (awPin && op && op._viaRelocate && (pin || unseat.length || banTeacherSlots.length))
                    ? '✓ 同じ時刻にあった「' + op._viaRelocate.subject + '」を両週ごと別の時刻へ動かして席を空け、' +
                      'A週の授業を指定の位置に入れました（動いたマス: B週 ' + changed.size + '・A週 ' + changedA.size + ' ・紫の枠）'
                    : awPin
                    ? (isFallback
                        ? '✓ 音美コマごと両週を動かすことはできなかったため、A週の中だけで動かしました（動いたマス: A週 ' + changedA.size + '。B週はそのままです）'
                        : '✓ A週の中で動かしました（動いたマス: A週 ' + changedA.size + ' ・紫の枠。B週はそのままです）')
                    : (viaOnbi
                        ? '✓ 音美コマごと動かして、A週とB週の両方を調整しました（動いたマス: B週 ' + changed.size + '・A週 ' + changedA.size + ' ・紫の枠）'
                        : (op && op._pairJoint
                            ? '✓ ペアの「' + extraPins.map(x => x.subject || '').join('・') + '」（相手のクラス）も同じ時刻へまとめて動かしました' +
                              '（動いたマス: B週 ' + changed.size + '・A週 ' + changedA.size + ' ・紫の枠）。両方とも🔒になりました。'
                            : (extraPins.length
                                ? '✓ 支援学級の「' + extraPins.map(x => x.subject || '').join('・') + '」も同じ時刻へ動かして配置しました' +
                                  '（動いたマス: B週 ' + changed.size + '・A週 ' + changedA.size + ' ・紫の枠）。両方とも🔒になりました。'
                                : '✓ 反映しました（動いたマス: B週 ' + changed.size + '・A週 ' + changedA.size +
                                  ' ・紫の枠）。📌したコマは🔒になりました。' +
                                  (res.placedCount > basePlaced ? ' 未配置だった授業も入りました！' : '') +
                                  (op && op._pairSplit ? ' ※ペアの相手は一緒に動かせなかったため元の位置に残っています（隔週交代が別々の時刻になります。↩で戻せます）' : ''))));
                // できれば違反の増減をメッセージ末尾に添える
                if (editUi.softDelta) {
                    const sd = editUi.softDelta;
                    const diff = sd.newTotal - sd.oldTotal;
                    editUi.msg += ' できれば違反 ' + sd.oldTotal + ' → ' + sd.newTotal +
                        (diff > 0 ? '（+' + diff + '。下に新たに引っかかった条件を表示）' : diff < 0 ? '（' + diff + '）' : '（増減なし）');
                }
            }
        } catch (err) {
            // 例外で止まっても盤面（lastResult）は書き換えていないので元のまま。それを明記する
            console.error('[timetable-generator] 手直しの再計算でエラーが発生しました', err);
            editUi.msg = '⚠ 手直しの処理が途中で止まりました。時間割は元のままです。もう一度お試しください。' +
                '（技術的な内容: ' + ((err && err.message) ? err.message : String(err)) + '）';
        }
        editUi.sel = null;
        editUi.busy = false;
        rerenderEditSurface();
        return !editUi.msg.startsWith('⚠');
    }

    const SOLVER_DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
    const SOLVER_DAY_JP = { mon: '月', tue: '火', wed: '水', thu: '木', fri: '金' };

    function resTeacherNames(ids) {
        return (ids || []).map(id => (teacherById(id) || {}).name || '(無名)').join('・');
    }

    function cellHtml(cell) {
        if (!cell) return '<td class="tg-res-free">—</td>';
        const names = resTeacherNames(cell.teacherIds || []);
        // 音美はB週のみ実施（A週は学年職員の教科に充当）。位相 = B1/B2週にどちらの教科をやるか
        let note = '';
        if (cell.subject === '音美') {
            const hrSub = gradeStaffSubjectOf((cell.classIds || [])[0]);
            note = '<span class="tg-res-teacher">A週=' + esc(hrSub ? hrSub + '（学年職員）' : '学年職員の授業') + '</span>';
            // 位相の注記はB週が2種類ある3週サイクルの概念（2週以下では音美自体を許可していない）
            if (cell.phase != null && Number(state.skeleton.cycleWeeks) >= 3) {
                note += '<span class="tg-res-teacher">' + (cell.phase === 0 ? 'B1=音楽・B2=美術' : 'B1=美術・B2=音楽') + '</span>';
            }
        }
        return '<td><span class="tg-res-subject">' + esc(cell.subject) + '</span>' +
            (names ? '<span class="tg-res-teacher">' + esc(names) + '</span>' : '<span class="tg-res-teacher tg-sum-ng">未定</span>') +
            note + '</td>';
    }

    /* ---------- 一覧表（学級・支援学級・支援生徒・教員 × 曜日×時限） ---------- */

    function ovShort(s) {
        return BOARD_SHORTS[s] || (s && s.length > 2 ? s.slice(0, 2) : s);
    }

    // その学級の変動枠の週別内容（学年職員の教科は実教科に解決）。contents は週の並び順。
    // 色付けは呼び出し側で「A週とB週の内容が違うか」を見る（かつては「全週で同じか」の
    // rot フラグを返していたが、B1とB2の違いだけでA週とB週が同じマスに色が付いてしまった）
    function varCellInfo(cid) {
        const g = gradeOfClass(cid);
        if (!hasVarSlot() || !gradeUsesVar(g)) return null;
        const contents = weekLabels().map(w => {
            let sub = ((state.varContent[w] || {})[g]) || '学年職員の教科';
            if (sub === VAR_UNUSED) sub = '学年職員の教科';
            if (sub === '学年職員の教科') sub = gradeStaffSubjectOf(cid) || '学年職員の教科';
            return sub;
        });
        return { contents };
    }

    function ovCols() {
        const cols = [];
        SOLVER_DAY_KEYS.forEach(d => {
            const max = Number(state.skeleton.periods[d]) || 0;
            for (let p = 1; p <= max; p++) cols.push({ d, p });
        });
        return cols;
    }

    function ovHead(cols, countCols) {
        return '<thead><tr><th class="tg-ov-name"></th>' +
            SOLVER_DAY_KEYS.map(d => '<th colspan="' + (Number(state.skeleton.periods[d]) || 0) + '">' + SOLVER_DAY_JP[d] + '</th>').join('') +
            countCols.map(c => '<th rowspan="2">' + esc(c) + '</th>').join('') + '</tr>' +
            '<tr><th class="tg-ov-name"></th>' + cols.map(c => '<th>' + c.p + '</th>').join('') + '</tr></thead>';
    }

    // 同日重複の衝突教科: 隔週枠（音美・技家）はその構成教科と同日に置けない
    function dayConflictSubjects(s) {
        if (BIWEEKLY_PAIRS[s]) return [s].concat(BIWEEKLY_PAIRS[s]);
        for (const k of Object.keys(BIWEEKLY_PAIRS)) {
            if (BIWEEKLY_PAIRS[k].includes(s)) return [s, k];
        }
        return [s];
    }

    // 週別の「同日重複」セル集合（cid|day|subject）。絶対条件の安全網として赤く目立たせる
    // （原則ソルバが未配置に変換するため出ないはずだが、万一残った場合に見逃さないための表示）
    function buildDupSet(week) {
        const wc = weekCellsFor(week);
        const count = {};
        Object.entries(wc.cells).forEach(([key, cell]) => {
            const [cid, d] = key.split('|');
            const k = cid + '|' + d + '|' + cell.subject;
            count[k] = (count[k] || 0) + 1;
        });
        const dup = new Set();
        Object.entries(wc.cells).forEach(([key, cell]) => {
            const [cid, d] = key.split('|');
            const total = dayConflictSubjects(cell.subject).reduce((sum, s) =>
                sum + (count[cid + '|' + d + '|' + s] || 0), 0);
            if (total >= 2) dup.add(cid + '|' + d + '|' + cell.subject);
        });
        return dup;
    }

    // A週とB週で中身が違うマスか（緑の色付けの判定）。
    // 判定は必ずここ1か所に集約する: 以前は A週表＝ソルバの moved・B週表＝「音美かどうか」と
    // 別々に判定していたため、A週だけ入れ替わったコマがA週にしか色が付かず、
    // 「同じズレなのに色が付く週と付かない週がある」状態になっていた（実運用レビュー 2026-07-30）。
    function abDiffersAt(key) {
        const a = weekCellsFor('A');
        if (a.resolved) {
            // ソルバが組んだA週グリッド。moved = ベース週（B週）と中身が違う、そのもの
            const ca = a.cells[key];
            return !!(ca && ca.moved);
        }
        // A週が未構築（音美のない構成など）: B週の音美コマだけがA週で差し替わる
        const cb = weekCellsFor('B').cells[key];
        return !!(cb && cb.subject === '音美');
    }

    // 学級セル（week: 'A' | 'B'。A週とB週で中身が異なるコマは色付き。同日重複は赤）
    function ovClassCell(cid, col, week, dupSet) {
        const vs = state.skeleton.varSlot;
        const isVar = hasVarSlot() && col.d === vs.day && col.p === Number(vs.period);
        if (isVar && !cid.startsWith('sc:') && gradeUsesVar(gradeOfClass(cid))) {
            const info = varCellInfo(cid);
            const aContent = info.contents[0];
            const bContent = info.contents[1] != null ? info.contents[1] : aContent;
            const content = week === 'A' ? aContent : bContent;
            // 色は凡例どおり「A週とB週で中身が違うか」だけで判定する。
            // 以前は「全週で同じでないなら色」だったため、A週とB週（表に出るのはB1）が
            // 同じ内容でも B1 と B2 が違うだけで色が付いていた
            // （例: 総合がどちらの週も総合なのに緑。実運用レビュー 2026-07-30）。
            // B1とB2の違いは色ではなく、マウスを乗せたときの説明で伝える。
            const labels = weekLabels();
            const bVaries = info.contents.slice(1).some(c => c !== bContent);
            const title = bVaries
                ? ' title="' + esc(labels.map((w, i) => w + '週: ' + info.contents[i]).join(' / ')) + '"'
                : '';
            return '<td class="' + (aContent !== bContent ? 'tg-ov-rot' : '') + '"' + title + '>' +
                esc(ovShort(content)) + '</td>';
        }
        const wc = weekCellsFor(week);
        const key = cid + '|' + col.d + '|' + col.p;
        const cell = wc.cells[key];
        // 手直しモード（Step 10）: A週・B週の両方の表を編集面にする。
        // 同じ授業は両週でつながっているため、どちらで動かしても「両週共通の移動」になる。
        // A週にしか無い自動連動コマ（音美→充当の差し替え・lessonId が aw: で始まる）だけは
        // ここでは動かせないので、目印（data-eaw）を付けてクリック時に説明する。
        const editable = editUi.on && (week === 'B' || week === 'A');
        const editAttr = (c) => {
            if (!editable) return '';
            const fixed = c && EDIT_FIXED_SUBJECTS.has(c.subject);
            const aw = c && String(c.lessonId || '').indexOf('aw:') === 0;
            return ' data-ecid="' + esc(cid) + '" data-ed="' + col.d + '" data-ep="' + col.p + '" data-ew="' + week + '"' +
                (c && !fixed && !aw ? ' data-elid="' + esc(c.lessonId || '') + '"' : '') +
                (aw ? ' data-eaw="1" data-awlid="' + esc(c.lessonId) + '"' : '') +
                (c && c.pairKey ? ' data-epair="1"' : '');
        };
        const editCls = (c) => {
            if (!editable || !c) return '';
            let cls = '';
            if (editUi.sel && editUi.sel.lid === c.lessonId) cls += ' tg-ov-sel';
            if (editUi.locks.has(c.lessonId)) cls += ' tg-ov-lock';
            const chg = week === 'A' ? editUi.changedA : editUi.changed;
            if (chg.has(key)) cls += ' tg-ov-edited';
            return cls;
        };
        if (!cell) return '<td class="tg-ov-empty' + (editable ? ' tg-ov-target' : '') + '"' + editAttr(null) + '>－</td>';
        const isDup = dupSet && dupSet.has(cid + '|' + col.d + '|' + cell.subject);
        if (isDup) {
            return '<td class="tg-ov-dup' + editCls(cell) + '"' + editAttr(cell) + ' title="同じ教科が同日に2コマあります（絶対条件違反・要修正）">' + esc(ovShort(cell.subject)) + '</td>';
        }
        // 色は「A週とB週で中身が違うか」だけで決める（両週の同じマスに必ず同じ色が付く）
        const rotCls = abDiffersAt(key) ? 'tg-ov-rot' : '';
        if (wc.resolved) {
            // ソルバ構築のA週グリッド（音美の差し替え・ズレ許容モードの入れ替えを反映済み）
            return '<td class="' + rotCls + editCls(cell) + '"' + editAttr(cell) + '>' + esc(ovShort(cell.subject)) + '</td>';
        }
        if (cell.subject === '音美') {
            // 音美はB週のみ実施。A週は学年職員の教科（A週未構築のときのフォールバック表示）
            const content = week === 'A' ? (gradeStaffSubjectOf(cid) || '学年職員の教科') : '音美';
            return '<td class="' + rotCls + editCls(cell) + '"' + editAttr(cell) + '>' + esc(ovShort(content)) + '</td>';
        }
        return '<td class="' + (rotCls + editCls(cell)).trim() + '"' + editAttr(cell) + '>' + esc(ovShort(cell.subject)) + '</td>';
    }

    // 学級・支援学級・支援生徒の一覧表（週別）
    function ovClassesTable(week) {
        const cols = ovCols();
        const dupSet = buildDupSet(week);
        let html = '<table class="tg-ov-table">' + ovHead(cols, ['週コマ']) + '<tbody>';
        // 通常学級
        // 配付物では「誰の学級か」が分かるよう担任名を添える（画面では場所を取るので印刷のみ表示）
        const hrLabel = cid => {
            const hr = state.teachers.find(t => t.homeroom === cid);
            return hr && hr.name ? '<span class="tg-ov-hr">' + esc(hr.name) + '</span>' : '';
        };
        classIds().forEach(cid => {
            const base = Object.keys(activeCells()).filter(k => k.startsWith(cid + '|')).length;
            const count = base + ((hasVarSlot() && gradeUsesVar(gradeOfClass(cid))) ? 1 : 0);
            html += '<tr><th class="tg-ov-name">' + esc(cid) + hrLabel(cid) + '</th>' +
                cols.map(c => ovClassCell(cid, c, week, dupSet)).join('') +
                '<td class="tg-ov-count">' + count + '</td></tr>';
        });
        // 支援学級
        state.support.classes.forEach(sc => {
            const key = 'sc:' + sc.id;
            const count = Object.keys(activeCells()).filter(k => k.startsWith(key + '|')).length;
            html += '<tr><th class="tg-ov-name">' + esc(sc.name || '支援学級') + hrLabel(key) + '</th>' +
                cols.map(c => ovClassCell(key, c, week, dupSet)).join('') +
                '<td class="tg-ov-count">' + count + '</td></tr>';
        });
        // 支援生徒（一人ひとり）
        state.support.students.forEach(st => {
            let count = 0;
            const cells = cols.map(c => {
                const scKey = 'sc:' + st.supportClassId;
                const sc = activeCells()[scKey + '|' + c.d + '|' + c.p];
                const attendsSc = sc && (sc.subject === '自立活動' || sc.subject === '生活単元' ||
                    (st.subjects && st.subjects[sc.subject] === 'support'));
                if (attendsSc) { count++; return '<td class="tg-ov-sup">' + esc(ovShort(sc.subject)) + '</td>'; }
                const E = st.exchangeClass;
                if (E && classIds().includes(E)) {
                    const cellHtml2 = ovClassCell(E, c, week, dupSet);
                    if (!cellHtml2.includes('tg-ov-empty')) count++;
                    return cellHtml2;
                }
                return '<td class="tg-ov-empty">－</td>';
            }).join('');
            html += '<tr><th class="tg-ov-name">' + esc(st.label || '生徒') + '（' + esc(st.exchangeClass || '交流未定') + '）</th>' +
                cells + '<td class="tg-ov-count">' + count + '</td></tr>';
        });
        return html + '</tbody></table>';
    }

    // 学級ごと・週ごとの「実際に配置された週コマ数」（教科別）
    function classWeekActual(cid, week) {
        const v = {};
        SUBJECTS.forEach(s => { v[s] = 0; });
        const wc = weekCellsFor(week);
        Object.entries(wc.cells).forEach(([key, cell]) => {
            if (!key.startsWith(cid + '|')) return;
            v[cell.subject] = (v[cell.subject] || 0) + 1;
        });
        const sStar = gradeStaffSubjectOf(cid);
        if (!wc.resolved && week === 'A' && v['音美']) {
            if (sStar) v[sStar] = (v[sStar] || 0) + v['音美'];
            v['音美'] = 0;
        }
        const g = gradeOfClass(cid);
        if (hasVarSlot() && gradeUsesVar(g)) {
            const info = varCellInfo(cid);
            const content = week === 'A' ? info.contents[0] : (info.contents[1] != null ? info.contents[1] : info.contents[0]);
            if (content && content !== '学年職員の教科') v[content] = (v[content] || 0) + 1;
        }
        return v;
    }

    // 学級×教科の週コマ数チェック（Step 4 の目標との差を表示）
    function ovHoursCheckTable() {
        const labels = hasVarSlot() ? weekLabels() : ['毎週'];
        // 学年×週の目標（Step 4 の行列と同じ導出）
        const targetVec = (g, w) => {
            const v = {};
            SUBJECTS.forEach(s => { v[s] = fixedHoursOf(g, s); });
            if (hasVarSlot() && gradeUsesVar(g)) {
                let varSub = ((state.varContent[w] || {})[g]) || '学年職員の教科';
                if (varSub === VAR_UNUSED) varSub = '学年職員の教科';
                if (varSub !== '学年職員の教科') v[varSub] = (v[varSub] || 0) + 1;
            }
            if (w === 'A') v['音美'] = 0;
            return v;
        };
        let html = '<div class="tg-table-wrap"><table class="tg-ov-table"><thead><tr><th class="tg-ov-name">学級</th><th>週</th>' +
            SUBJECTS.map(s => '<th>' + esc(ovShort(s)) + '</th>').join('') + '<th>計</th></tr></thead><tbody>';
        classIds().forEach(cid => {
            const g = gradeOfClass(cid);
            const sStar = gradeStaffSubjectOf(cid);
            // A週とB週で実績が同じならまとめる
            const weeks = hasVarSlot() ? [['A', 'A週'], ['B', bWeekDisplay()]] : [['B', '毎週']];
            const rows = weeks.map(([wk, wl]) => ({ wk, wl, act: classWeekActual(cid, wk) }));
            const merged = rows.length === 2 && JSON.stringify(rows[0].act) === JSON.stringify(rows[1].act)
                ? [{ wk: 'B', wl: '毎週', act: rows[0].act }] : rows;
            merged.forEach(r => {
                const tv = targetVec(g, r.wk === 'A' ? 'A' : (weekLabels()[1] || weekLabels()[0]));
                // 学年職員の教科の充当先はターゲット側も学級の実教科で読む（tv は学年共通のため補正不要:
                // 充当教科の tv = 入力値そのまま = 実績と一致するはず）
                let total = 0;
                const cells = SUBJECTS.map(s => {
                    const a = r.act[s] || 0;
                    const t = tv[s] || 0;
                    total += a;
                    if (a === t) return '<td class="' + (a ? '' : 'tg-ov-empty') + '">' + a + '</td>';
                    const cls = a > t ? 'tg-sum-ng' : 'tg-sum-warn';
                    return '<td class="' + cls + '" title="目標' + t + '">' + a + '<span class="tg-ov-a">' + (a > t ? '+' : '') + (a - t) + '</span></td>';
                }).join('');
                html += '<tr><th class="tg-ov-name">' + esc(cid) + '</th><td>' + esc(r.wl) + '</td>' + cells +
                    '<td class="tg-ov-count">' + total + '</td></tr>';
            });
        });
        html += '</tbody></table></div>' +
            '<p class="hint">数字は実際に配置された週コマ数。色付きは Step 4 の目標との差（赤=多い・黄=少ない、下段±が差）。' +
            '学年職員の教科の充当（例: 1-1=' + esc((classIds()[0] && gradeStaffSubjectOf(classIds()[0])) || '—') + '）は実教科に含めて数えています。</p>';
        return html;
    }

    function teacherResultWeekCounts(tid) {
        const labels = weekLabels();
        const counts = {};
        labels.forEach(w => { counts[w] = 0; });
        const aw = activeAWeek();
        const seen = new Set();
        Object.values(activeCells()).forEach(cell => {
            if (!(cell.teacherIds || []).includes(tid) || seen.has(cell.lessonId)) return;
            seen.add(cell.lessonId);
            if (cell.subject === '音美') {
                const cid0 = (cell.classIds || [])[0];
                const asg = (((state.assignments || {})[cid0] || {})['音美'] || []).filter(Boolean);
                // 位相（ソルバ割当）: 0 = B1週に音楽（担当1人目）、1 = B1週に美術。
                // B1週に授業するのは asg[位相]、B2週はもう片方
                const ph = cell.phase != null ? cell.phase : 0;
                const idx = asg.indexOf(tid);
                if (tid === cell.aHomeroom) counts[labels[0]] += 1;
                else if (idx === ph && labels[1] != null) counts[labels[1]] += 1;
                else if (idx === 1 - ph && idx >= 0 && labels[2] != null) counts[labels[2]] += 1;
            } else if (BIWEEKLY_PAIRS[cell.subject]) {
                labels.forEach(w => { counts[w] += 0.5; });
            } else {
                labels.forEach(w => { counts[w] += 1; });
            }
        });
        varSlotDutiesOf(tid).forEach(d => {
            const w = d.split(':')[0];
            if (counts[w] != null) counts[w] += 1;
        });
        // ソルバ構築のA週グリッドがある場合はA週の実数で上書き（ズレ許容モードの入れ替えを反映）
        if (aw && counts['A'] != null) {
            const seenA = new Set();
            let n = 0;
            Object.values(aw.cells).forEach(cell => {
                if (!(cell.teacherIds || []).includes(tid) || seenA.has(cell.lessonId)) return;
                seenA.add(cell.lessonId);
                n += BIWEEKLY_PAIRS[cell.subject] ? 0.5 : 1;  // 技家は逆位相ペアで週0.5
            });
            varSlotDutiesOf(tid).forEach(d => { if (d.startsWith('A:')) n++; });
            counts['A'] = n;
        }
        return counts;
    }

    // 教員の一覧表
    // 教員の一覧表（週別。week: 'A' | 'B'）
    function ovTeachersTable(week) {
        const cols = ovCols();
        const labels = weekLabels();
        const vs = state.skeleton.varSlot;
        let html = '<table class="tg-ov-table">' + ovHead(cols, labels.map(w => w + '週コマ')) + '<tbody>';
        const wcT = weekCellsFor(week);
        sortedTeachers().forEach(t => {
            const duties = varSlotDutiesOf(t.id);
            const wkDuties = week === 'A' ? duties.filter(d => d.startsWith('A:')) : duties.filter(d => !d.startsWith('A:'));
            // 非常勤の「準備の時間」表示用: この週の日別担当時限（最初と最後の間の空きが準備）
            const occByDay = {};
            if (t.type === 'part') {
                Object.entries(wcT.cells).forEach(([key, cell]) => {
                    if (!(cell.teacherIds || []).includes(t.id)) return;
                    const [, d2, p2] = key.split('|');
                    (occByDay[d2] = occByDay[d2] || []).push(Number(p2));
                });
            }
            const isPrepSlot = c => {
                const ps = occByDay[c.d];
                if (!ps || ps.length < 2) return false;
                return c.p > Math.min(...ps) && c.p < Math.max(...ps);
            };
            const naSet = new Set(t.na || []);
            const cells = cols.map(c => {
                const isNa = naSet.has(c.d + '-' + c.p);   // この先生が出られない時間
                const isVar = hasVarSlot() && c.d === vs.day && c.p === Number(vs.period);
                if (isVar && wkDuties.length) {
                    const parts = wkDuties.map(d => d.replace(':', ' '));
                    return '<td class="tg-ov-rot" title="' + esc(parts.join(' / ')) + '">' +
                        wkDuties.map(d => '<span class="tg-ov-multi">' + esc(d.split(':')[1]) + '</span>').join('') + '</td>';
                }
                if (isVar) return '<td class="tg-ov-empty' + (isNa ? ' tg-ov-na' : '') + '"></td>';
                const wc = weekCellsFor(week);
                const hits = [];
                Object.entries(wc.cells).forEach(([key, cell]) => {
                    const [cid, d2, p2] = key.split('|');
                    if (d2 !== c.d || Number(p2) !== c.p || !(cell.teacherIds || []).includes(t.id)) return;
                    if (hits.some(h => h.lessonId === cell.lessonId)) return;
                    const name = cid.startsWith('sc:')
                        ? ((state.support.classes.find(x => 'sc:' + x.id === cid) || {}).name || '支援')
                        : cid;
                    hits.push({ lessonId: cell.lessonId, cid, name, subject: cell.subject,
                                aHomeroom: cell.aHomeroom, moved: !!cell.moved, pairKey: cell.pairKey || null });
                });
                // 手直しモード（Step 10）: 教員の一覧からも同じ操作で動かせるようにする。
                // 授業セル＝クラス表のセルと同じ選択対象（lessonId+クラス）、
                // 空きセル＝「この先生のこの時刻へ」という行き先（時刻へのピンに変換）。
                const tEdit = editUi.on;
                const tAttr = (h) => {
                    if (!tEdit) return '';
                    let a = ' data-etid="' + esc(t.id) + '" data-ed="' + c.d + '" data-ep="' + c.p + '" data-ew="' + week + '"';
                    if (h) {
                        const aw2 = String(h.lessonId || '').indexOf('aw:') === 0;
                        a += ' data-ecid="' + esc(h.cid) + '"' +
                            (aw2 ? ' data-eaw="1" data-awlid="' + esc(h.lessonId) + '"' : ' data-elid="' + esc(h.lessonId || '') + '"') +
                            (h.pairKey ? ' data-epair="1"' : '');
                    }
                    return a;
                };
                const tCls = (h) => {
                    if (!tEdit || !h) return '';
                    let cls = '';
                    if (editUi.sel && editUi.sel.lid === h.lessonId) cls += ' tg-ov-sel';
                    if (editUi.locks.has(h.lessonId)) cls += ' tg-ov-lock';
                    return cls;
                };
                if (wc.resolved) {
                    // ソルバ構築のA週グリッド: 音美の差し替え済み。ズレたコマは色付き。複数はすべて列挙
                    if (!hits.length) return isPrepSlot(c)
                        ? '<td class="tg-ov-prep"' + tAttr(null) + '>準備</td>'
                        : '<td class="tg-ov-empty' + (isNa ? ' tg-ov-na' : '') + (tEdit ? ' tg-ov-target' : '') + '"' + tAttr(null) + '></td>';
                    const moved = hits.some(h => h.moved);
                    const h0 = hits[0];
                    return '<td class="' + (moved ? 'tg-ov-rot' : '') + tCls(h0) + '"' + tAttr(h0) + '>' +
                        hits.map(h => '<span class="tg-ov-multi">' + esc(h.name) + esc(ovShort(h.subject)) + '</span>').join('') + '</td>';
                }
                // 音美は週で担当が入れ替わる: A週=学年職員（充当教科）、B週=音楽/美術担当
                const shown = hits.filter(h => {
                    if (h.subject !== '音美') return true;
                    return week === 'A' ? t.id === h.aHomeroom : t.id !== h.aHomeroom;
                });
                if (!shown.length) return isPrepSlot(c)
                    ? '<td class="tg-ov-prep"' + tAttr(null) + '>準備</td>'
                    : '<td class="tg-ov-empty' + (isNa ? ' tg-ov-na' : '') + (tEdit ? ' tg-ov-target' : '') + '"' + tAttr(null) + '></td>';
                // 複数はすべて列挙。音美はこの教員の実教科（音楽/美術）に解決して表示
                const rot = shown.some(h => h.subject === '音美');
                const sh0 = shown[0];
                const parts = shown.map(h => {
                    let label = h.subject;
                    if (h.subject === '音美') {
                        if (week === 'A') {
                            label = gradeStaffSubjectOf(h.cid) || '学年職員の教科';
                        } else {
                            const asg = (((state.assignments || {})[h.cid] || {})['音美'] || []).filter(Boolean);
                            label = BIWEEKLY_PAIRS['音美'][asg.indexOf(t.id)] || '音美';
                        }
                    }
                    return '<span class="tg-ov-multi">' + esc(h.name) + esc(ovShort(label)) + '</span>';
                });
                // ペア以外は教員表からも動かせる（solo音美含む。ペアはクラス表から＝相手と一緒に動く）
                const movableHit = (sh0 && !sh0.pairKey) ? sh0 : null;
                return '<td class="' + (rot ? 'tg-ov-rot' : '') + tCls(movableHit) + '"' + tAttr(movableHit) + '>' + parts.join('') + '</td>';
            }).join('');
            const wc = teacherResultWeekCounts(t.id);
            html += '<tr><th class="tg-ov-name">' + esc(t.name || '(無名)') +
                (t.type === 'part' ? '<span class="tg-ov-a">非常勤</span>' : '') + '</th>' + cells +
                labels.map(w => '<td class="tg-ov-count">' + (wc[w] % 1 === 0 ? wc[w] : wc[w].toFixed(1)) + '</td>').join('') + '</tr>';
        });
        return html + '</tbody></table>';
    }

    // 1学級（または支援学級）の週表
    function resultClassTable(cid, label) {
        const vs = state.skeleton.varSlot;
        const withVar = hasVarSlot();
        const maxP = Math.max(...SOLVER_DAY_KEYS.map(d => Number(state.skeleton.periods[d]) || 0));
        const isSc = cid.startsWith('sc:');
        const grade = isSc ? null : gradeOfClass(cid);
        let html = '<h4 class="tg-res-title">' + esc(label) + '</h4>' +
            '<div class="tg-table-wrap"><table class="tg-table tg-res-table"><thead><tr><th></th>' +
            SOLVER_DAY_KEYS.map(d => '<th>' + SOLVER_DAY_JP[d] + '</th>').join('') + '</tr></thead><tbody>';
        for (let p = 1; p <= maxP; p++) {
            html += '<tr><th>' + p + '限</th>';
            SOLVER_DAY_KEYS.forEach(d => {
                const dayMax = Number(state.skeleton.periods[d]) || 0;
                if (p > dayMax) { html += '<td class="na">—</td>'; return; }
                // 変動枠セルは「使う学年」だけ特別表示（使わない学年・支援学級は通常コマ）
                if (withVar && d === vs.day && p === Number(vs.period) && !isSc && gradeUsesVar(grade)) {
                    const hrSub = homeroomSubjectOf(cid);
                    const parts = weekLabels().map(w => {
                        let sub = (state.varContent[w] && state.varContent[w][grade]) || '—';
                        if (sub === '学年職員の教科' && hrSub) sub = hrSub + '（担任）';
                        return w + ':' + esc(sub);
                    });
                    html += '<td class="tg-res-var"><span class="tg-res-subject">変動枠</span><span class="tg-res-teacher">' + parts.join(' ') + '</span></td>';
                    return;
                }
                html += cellHtml(activeCells()[cid + '|' + d + '|' + p]);
            });
            html += '</tr>';
        }
        return html + '</tbody></table></div>';
    }

    // 教員1名が変動枠で担当するコマ（週別・checkVarSlot と同じ解決ロジック）
    function varSlotDutiesOf(tid) {
        if (!hasVarSlot()) return [];
        const duties = [];
        weekLabels().forEach(w => {
            classIds().forEach(cid => {
                const g = gradeOfClass(cid);
                if (!gradeUsesVar(g)) return;
                const subject = ((state.varContent[w] || {})[g]) || '学年職員の教科';
                if (subject === VAR_UNUSED) return;
                let tids;
                let label = subject;
                if (subject === '学年職員の教科') {
                    const rs = gradeStaffSubjectOf(cid);
                    const tt = rs ? gradeStaffTeacherOf(cid, rs) : null;
                    tids = tt ? [tt] : [];
                    label = rs || subject;
                } else if (subject === '総合' || HOMEROOM_SUBJECTS.includes(subject)) {
                    const hr = state.teachers.find(t => t.homeroom === cid);
                    tids = hr ? [hr.id] : [];
                } else {
                    tids = ((state.assignments[cid] || {})[subject] || []).filter(Boolean);
                }
                if (tids.includes(tid)) duties.push(w + ':' + cid + ' ' + label);
            });
        });
        return duties;
    }

    // 教員1名の週表
    function resultTeacherTable(tid, week) {
        week = week || 'B';
        const vs = state.skeleton.varSlot;
        const withVar = hasVarSlot();
        const maxP = Math.max(...SOLVER_DAY_KEYS.map(d => Number(state.skeleton.periods[d]) || 0));
        const varDuties = varSlotDutiesOf(tid);
        const weekInfo = weekCellsFor(week);
        const cells = weekInfo.cells || {};

        // 非常勤の「準備の時間」は、表示中の週の担当時限から判定する
        const tObj = state.teachers.find(x => x.id === tid);
        const occByDay = {};
        if (tObj && tObj.type === 'part') {
            Object.entries(cells).forEach(([key, cell]) => {
                if (!(cell.teacherIds || []).includes(tid)) return;
                const [, d2, p2] = key.split('|');
                (occByDay[d2] = occByDay[d2] || []).push(Number(p2));
            });
        }
        const isPrep = (d, p) => {
            const ps = occByDay[d];
            return !!ps && ps.length >= 2 && p > Math.min(...ps) && p < Math.max(...ps);
        };
        let html = '<div class="tg-table-wrap"><table class="tg-table tg-res-table"><thead><tr><th></th>' +
            SOLVER_DAY_KEYS.map(d => '<th>' + SOLVER_DAY_JP[d] + '</th>').join('') + '</tr></thead><tbody>';
        for (let p = 1; p <= maxP; p++) {
            html += '<tr><th>' + p + '限</th>';
            SOLVER_DAY_KEYS.forEach(d => {
                const dayMax = Number(state.skeleton.periods[d]) || 0;
                if (p > dayMax) { html += '<td class="na">—</td>'; return; }
                const isVarCell = withVar && d === vs.day && p === Number(vs.period);
                const hits = [];
                Object.keys(cells).forEach(key => {
                    const cell = cells[key];
                    const [cid, day, period] = key.split('|');
                    if (day === d && Number(period) === p && (cell.teacherIds || []).includes(tid)) {
                        const name = cid.startsWith('sc:')
                            ? ((state.support.classes.find(x => 'sc:' + x.id === cid) || {}).name || '支援')
                            : cid;
                        if (!hits.some(h => h.lessonId === cell.lessonId)) {
                            hits.push({ lessonId: cell.lessonId, name, subject: cell.subject });
                        }
                    }
                });
                if (isVarCell && varDuties.length) {
                    html += '<td class="tg-res-var"' + (hits.length ? ' style="background:#fdecea"' : '') + '>' +
                        '<span class="tg-res-subject">変動枠</span><span class="tg-res-teacher">' + esc(varDuties.join(' ')) + '</span>' +
                        hits.map(h => '<span class="tg-res-subject">' + esc(h.name) + ' ' + esc(h.subject) + '</span>').join('') + '</td>';
                    return;
                }
                if (!hits.length) {
                    html += isPrep(d, p) ? '<td class="tg-ov-prep">準備</td>' : '<td class="tg-res-free">空</td>';
                    return;
                }
                html += '<td' + (hits.length > 1 ? ' style="background:#fdecea"' : '') + '>' +
                    hits.map(h => '<span class="tg-res-subject">' + esc(h.name) + ' ' + esc(h.subject) + '</span>').join('') + '</td>';
            });
            html += '</tr>';
        }
        return html + '</tbody></table></div>';
    }

    function renderSolverResult() {
        const el = document.getElementById('solverResult');
        if (!el) return;
        if (!lastResult) { el.innerHTML = ''; return; }
        const r = lastResult;
        let html = '<h2 class="section-title" style="margin-top:28px">生成結果</h2>';
        r.errors.forEach(e => { html += '<div class="tg-error">' + esc(e) + '</div>'; });
        const hardViolationCount = (r.hardSummary || [])
            .filter(item => item.status === 'ng')
            .reduce((sum, item) => sum + (item.notes || []).length, 0);

        // --- 結論ファーストのヒーロー: 判定・数字・次の一手を最初のひと目に集約 ---
        {
            const softTotal = (r.softBreakdown || []).reduce((a, b) => a + (Number(b.violations) || 0), 0);
            const unpCount = r.totalCount - r.placedCount;
            let cls, mark, title, sub;
            if (r.ok && r.hardOk) {
                cls = 'ok'; mark = '○';
                title = '時間割ができました';
                sub = '全 ' + r.totalCount + ' コマを配置し、絶対条件をすべて満たしています（' +
                    fmtDuration(r.elapsedMs) + '・' + r.attempts.toLocaleString() + ' 回試行）';
            } else if (r.ok && !r.hardOk) {
                cls = 'warn'; mark = '△';
                title = '配置はできましたが、守れなかった絶対条件があります';
                sub = '全 ' + r.totalCount + ' コマを配置。残っている違反 ' + hardViolationCount +
                    ' 件の中身は下の「絶対条件の達成状況」の×印で確認できます';
            } else {
                cls = 'ng'; mark = '！';
                title = unpCount + ' コマが入りませんでした';
                sub = r.placedCount + '/' + r.totalCount + ' コマまで配置（' + fmtDuration(r.elapsedMs) +
                    '）。「もう一度組む」は前回詰まった授業を最優先で置き直します';
            }
            html += '<div class="tg-hero ' + cls + '">' +
                '<div class="tg-hero-mark">' + mark + '</div>' +
                '<div class="tg-hero-main"><p class="tg-hero-title">' + title + '</p>' +
                '<p class="tg-hero-sub">' + sub + '</p></div>' +
                '<div class="tg-hero-stats">' +
                '<div class="tg-stat ' + (unpCount ? 'ng' : 'ok') + '"><b>' + r.placedCount + '/' + r.totalCount + '</b><span>配置したコマ</span></div>' +
                '<div class="tg-stat ' + (hardViolationCount ? 'ng' : 'ok') + '"><b>' + hardViolationCount + '</b><span>絶対条件の違反</span></div>' +
                '<div class="tg-stat' + (softTotal ? '' : ' ok') + '"><b>' + softTotal + '</b><span>できれば違反</span></div>' +
                '</div>' +
                '<div class="tg-hero-actions">' +
                '<button type="button" class="btn btn-primary" id="tgGoEdit">手直しへ進む（Step 10）→</button>' +
                '<button type="button" class="btn btn-primary" id="tgResExcel">Excelで書き出す</button>' +
                '<button type="button" class="btn btn-secondary" id="tgResRetry">もう一度組む</button>' +
                // Step 10 の同じボタンと名前をそろえる。「バックアップ」と呼ばないのは、
                // このファイルを読み戻す口がツール側に無く、これだけでは元に戻せないため
                '<button type="button" class="btn btn-ghost" id="tgResBoard">時間割のデータをJSONで保存</button>' +
                '</div></div>';
        }
        // 書き出しボタンのすぐ下。押してから alert で断られる前に理由が読めるようにする
        {
            const exportLimit = exportLimitNote();
            // 深刻度は Step 1・Step 9 と同じ基準（隔週交代の残存＝完全なブロッカーは赤）。
            // 支援学級名（自由入力）を含む文字列なので、innerHTML に入れる直前でエスケープする
            if (exportLimit) html += '<div class="' + (biweeklyGradesUnderThreeWeeks().length ? 'tg-error' : 'tg-warn') + '">' + esc(exportLimit) + '</div>';
        }
        if (r.ok && r.provisional) {
            html += '<div class="tg-warn"><strong>暫定案:</strong> 担当未定の授業 ' + r.provisionalCount + ' コマは教員の重複チェックなしで置いています。Step 5 で担当を確定してから組み直してください。</div>';
        }
        r.unplaced.slice(0, 20).forEach(u => { html += '<div class="tg-warn">未配置: ' + esc(u.name) + ' — ' + esc(u.reason) + '</div>'; });
        if (r.unplaced.length > 20) html += '<div class="tg-warn">…ほか ' + (r.unplaced.length - 20) + ' 件</div>';

        // 未配置の授業がどこにも入らない理由（コマ別の阻害要因表）
        if (r.unplacedDetail && r.unplacedDetail.length) {
            const CODE_JP = { class: '学', teacher: '教', na: '不', room: '室', dayDup: '重', restrict: '制', exchange: '交', hard: '絶', part: '非', sync: '援' };
            html += '<details style="margin:8px 0" open><summary class="tg-res-title" style="cursor:pointer">未配置の授業が入らない理由（コマ別）</summary>';
            const maxP = Math.max(...SOLVER_DAY_KEYS.map(dd => Number(state.skeleton.periods[dd]) || 0));
            r.unplacedDetail.forEach(d => {
                html += '<h4 class="tg-res-title">' + esc(d.name) + '</h4>' +
                    '<div class="tg-table-wrap"><table class="tg-table tg-blockers"><thead><tr><th></th>' +
                    SOLVER_DAY_KEYS.map(dd => '<th>' + SOLVER_DAY_JP[dd] + '</th>').join('') + '</tr></thead><tbody>';
                for (let p = 1; p <= maxP; p++) {
                    html += '<tr><th>' + p + '限</th>';
                    SOLVER_DAY_KEYS.forEach(dd => {
                        const dayMax = Number(state.skeleton.periods[dd]) || 0;
                        if (p > dayMax) { html += '<td class="na">—</td>'; return; }
                        const codes = d.grid[dd + '-' + p];
                        if (codes == null) { html += '<td class="tg-ov-empty">変動</td>'; return; }
                        html += codes.length
                            ? '<td>' + codes.map(cd => CODE_JP[cd] || cd).join('・') + '</td>'
                            : '<td class="tg-sum-ok">空</td>';
                    });
                    html += '</tr>';
                }
                html += '</tbody></table></div>';
            });
            html += '<p class="hint">凡例: 学=学級に空きコマがない／教=担当教員が他の授業／不=担当教員が出られない時間／室=特別教室が満杯／' +
                '重=同じ教科が同日に既にある／制=支援学級の許可教科の制限／交=交流条件／絶=「絶対」条件に反する／非=非常勤の個別条件に反する／援=生徒が支援学級にいない時刻（支援で受ける教科を置けない）。空=そのコマ自体は置けた（探索の組み合わせ次第）。</p></details>';
        }

        // 警告・メモは1つにたたむ（⚠付きの重要なものだけ先頭で開いた状態にする）
        {
            const notes = r.warnings.concat(r.varSlotIssues.map(w => '変動枠: ' + w));
            const important = notes.filter(w => w.indexOf('⚠') >= 0);
            const info = notes.filter(w => w.indexOf('⚠') < 0);
            important.forEach(w => { html += '<div class="tg-warn">' + esc(w) + '</div>'; });
            if (info.length) {
                html += '<details class="tg-notes-fold"><summary>この結果についてのメモ（' + info.length + ' 件）</summary>' +
                    info.map(w => '<div class="tg-warn">' + esc(w) + '</div>').join('') + '</details>';
            }
        }

        // 自動緩和が効いた場合: その緩和をワンクリックで「無視して組む条件」に登録できるようにする
        // （登録すると次回の生成は最初から外して組むので、フェーズ2の遠回りが無くなり結果も安定する）
        const escalationPend = (() => {
            if (!(r.escalation && !r.escalation.phase1Solved && (r.escalation.relaxedIds || []).length && r.unplaced.length === 0)) return [];
            const already = new Set(ignoredIdList());
            return r.escalation.relaxedIds
                .map((id, i) => ({ id, label: (r.escalation.relaxedLabels || [])[i] || softLabel(id) }))
                .filter(x => !already.has(x.id));
        })();
        if (escalationPend.length) {
            html += '<div class="tg-suggest"><h3>自動で緩めた条件があります</h3>' +
                '<p>条件どおりでは組めなかったため、「' + escalationPend.map(x => esc(x.label)).join('」「') +
                '」を外して（絶対の場合は「できれば」扱いにして）この案を組みました。</p>' +
                '<button type="button" class="btn btn-small btn-secondary" id="tgAdoptRelax">この条件を「無視して組む」に登録する（次回から最初から外して組む）</button></div>';
        }

        // 提案: この条件を変えると組める見込み（静的分析＋短時間の再試行で確認できたもの）
        const sugg = (r.suggestions || []).concat(r.dynamicSuggestions || []);
        if (sugg.length) {
            html += '<div class="tg-suggest"><h3>提案: この条件を変えると組める見込みです</h3><ul>' +
                sugg.map(s => '<li>' + esc(s) + '</li>').join('') + '</ul></div>';
        }

        // 感度分析: 条件を1つ外すと時間割の質がどれだけ上がるか（ボタンで実行）
        if (r.relaxReport && r.relaxReport.length) {
            const baseKey = r.bestKey || [r.unplaced.length, 0, r.softTotal];
            const rows = r.relaxReport.map(x => {
                let effect;
                if (!x.bestKey) {
                    effect = '判定できず';
                } else if (x.unplacedCount === 0 && baseKey[0] > 0) {
                    effect = 'すべてのコマが配置できます';
                } else if (x.unplacedCount > 0) {
                    effect = '未配置 ' + x.unplacedCount + '（改善なし）';
                } else {
                    const d = r.softTotal - x.softTotal;
                    effect = d > 0 ? '「できれば」違反 ' + r.softTotal + '→' + x.softTotal + '（' + d + ' 改善）'
                        : '明確な改善なし（この条件は今の結果を圧迫していません）';
                }
                return { id: x.id || null, label: x.label, effect, gain: (x.unplacedCount === 0 ? (r.softTotal - x.softTotal) : -9999) + (x.unplacedCount === 0 && baseKey[0] > 0 ? 100000 : 0) };
            }).sort((a, b) => b.gain - a.gain);
            const applyBtn = x => {
                if (!x.id) return '';
                if (x.id === 'abMode:repair') return ' <button type="button" class="btn btn-small btn-secondary tg-relax-apply" data-rid="abMode:repair">この設定にしてもう一度組む</button>';
                if (ignoredIdList().includes(x.id)) return ' <span class="badge tg-badge-ignored">無視中</span>';
                return ' <button type="button" class="btn btn-small btn-secondary tg-relax-apply" data-rid="' + esc(x.id) + '" data-rlabel="' + esc(x.label) + '">この条件を無視してもう一度組む</button>';
            };
            html += '<div class="tg-suggest"><h3>条件を1つ緩めた場合の効果（効果の大きい順）</h3><ul>' +
                rows.map(x => '<li>' + esc(x.label) + ' → ' + esc(x.effect) + applyBtn(x) + '</li>').join('') +
                '</ul><p class="hint">各条件を外して短時間だけ組み直した実測です。「厳しい条件」ほど外したときの改善が大きく出ます。' +
                'ボタンを押すとその条件を無視してすぐ組み直します（設定そのものは変わらず、Step 9 上部の「無視して組む条件」×でいつでも戻せます）。</p></div>';
        } else {
            // 調査が途中で落ちた場合は、数分待たされた末に無反応に見えないよう理由を出す
            html += (relaxErrorMsg ? '<div class="tg-warn">' + esc(relaxErrorMsg) + '</div>' : '') +
                '<div class="action-bar no-print" style="margin:10px 0;justify-content:flex-start">' +
                '<button type="button" class="btn btn-secondary" id="tgRelaxCheck">条件を1つ緩めた場合の効果を調べる（数分かかります）</button>' +
                '</div>';
        }

        // ベスト3案の切り替えタブ
        const alts = r.alternatives || [];
        if (alts.length) {
            // タブの数字は内訳で正確に表示する（内部評価値 key[1] は「週替わりの重なり＋非常勤違反×3」の混合のため）
            const subOf = (o, extra) => {
                const parts = [];
                if (o.unp) parts.push('未配置' + o.unp);
                if (o.dup) parts.push('同日重複' + o.dup);   // 絶対条件のため通常は0
                if (o.rot) {
                    // 週替わり（音美コマ・変動枠と充当教科が同曜日）でA週に同日化し得る箇所。
                    // A週修復で解消済みなら「調整済み」と付ける
                    const fixed = o.aw && o.aw.violations && o.aw.violations.length === 0;
                    parts.push('週替わりの重なり' + o.rot + (fixed ? '（A週で調整済み）' : ''));
                }
                if (o.pmv) parts.push('非常勤の最低コマ違反' + o.pmv);
                parts.push('できれば違反' + o.soft);
                return parts.join('・') + (extra || '');
            };
            const tabBtn = (i, label, sub) =>
                '<button type="button" class="tg-alt-tab' + (activeAlt === i ? ' active' : '') + '" data-alt="' + i + '">' +
                esc(label) + '<span class="tg-alt-sub">' + esc(sub) + '</span></button>';
            html += '<div class="tg-alt-tabs no-print">' +
                tabBtn(0, '案1（最良）', subOf({ unp: r.unplaced.length, dup: r.dupCount || 0, rot: r.rotDupCount || 0,
                    pmv: r.partMinViolCount || 0, soft: r.softTotal, aw: r.aWeek })) +
                alts.map((a, i) => tabBtn(i + 1, '案' + (i + 2),
                    subOf({ unp: a.unplacedCount, dup: a.dupCount, rot: a.rotDupCount || 0,
                        pmv: a.partMinViolCount || 0, soft: a.softTotal, aw: a.aWeek },
                        '・案1と' + a.diffFromBest + 'コマ違い'))).join('') +
                '</div>';
            if (activeAlt > 0) {
                html += '<div class="tg-warn">案' + (activeAlt + 1) + ' を表示中です（一覧表・週コマ数チェック・書き出しは表示中の案）。上部の警告・生成プロセスは案1基準です。</div>';
            }
        }

        // 絶対条件の達成サマリー（○=クリア／△=最終手段で一部緩和／×=残ってしまった違反）
        const hardSum = (activeAlt > 0 && alts[activeAlt - 1]) ? alts[activeAlt - 1].hardSummary : r.hardSummary;
        if (hardSum && hardSum.length) {
            const MARK = { ok: '○', warn: '△', ng: '×' };
            html += '<div class="tg-block" style="margin-top:10px"><h3>絶対条件の達成状況' + (activeAlt > 0 ? '（案' + (activeAlt + 1) + '）' : '') + '</h3>' +
                '<ul class="tg-hard-list">' +
                hardSum.map(item =>
                    '<li class="tg-hard-' + esc(item.status) + '"><span class="tg-hard-mark">' + esc(MARK[item.status] || '') + '</span>' +
                    '<span class="tg-hard-label">' + esc(item.label) + '</span>' +
                    (item.notes.length ? '<ul class="tg-hard-notes">' + item.notes.map(n => '<li>' + esc(n) + '</li>').join('') + '</ul>' : '') +
                    '</li>').join('') +
                '</ul>' +
                '<p class="hint">○=すべて守られています／△=最終手段の緩和あり（内容は下の注記）／×=守れなかった項目が残っています。</p></div>';
        }

        // ソフト条件の達成状況（優先順位＝重み順。案タブで表示中の案のもの）
        const softBd = (activeAlt > 0 && alts[activeAlt - 1]) ? alts[activeAlt - 1].softBreakdown : r.softBreakdown;
        if (softBd && softBd.length) {
            const boundaryIndex = softBd.findIndex(b => Number(b.violations) > 0);
            html += '<div class="tg-block" style="margin-top:10px"><h3>優先順位の達成状況（できれば条件・上ほど優先）' + (activeAlt > 0 ? '（案' + (activeAlt + 1) + '）' : '') + '</h3>' +
                '<div class="tg-table-wrap"><table class="tg-table tg-soft-table"><thead><tr><th>優先</th><th>条件</th><th>違反数</th></tr></thead><tbody>' +
                softBd.map((b, i) => {
                    const det = b.details || [];
                    const detHtml = det.length
                        ? '<details class="tg-soft-det"><summary>内訳を見る（' + det.length + ' 件）</summary><ul>' +
                          det.map(d => '<li>' + esc(d) + '</li>').join('') + '</ul></details>'
                        : '';
                    const isBoundary = i === boundaryIndex;
                    return '<tr' + (isBoundary ? ' class="tg-boundary"' : '') + '><td>' + (i + 1) + '</td><td class="tg-left">' + esc(softLabel(b.id)) +
                        (isBoundary ? ' <span class="tg-boundary-badge">← ここから下は妥協した条件</span>' : '') +
                        (SOFT_DESC[b.id] ? '<br><span class="tg-soft-desc">数え方: ' + esc(SOFT_DESC[b.id]) + '</span>' : '') +
                        detHtml + '</td>' +
                        '<td class="' + (b.violations ? 'tg-sum-ng' : 'tg-sum-ok') + '">' + b.violations + '</td></tr>';
                }).join('') +
                '</tbody></table></div>' +
                (boundaryIndex === -1 ? '<p class="tg-all-soft-ok">すべての「できれば」条件を達成しました</p>' : '') +
                '<p class="hint">優先順位の高い条件から順に最小化した結果です（何を優先して何を諦めたかは「内訳を見る」で確認できます）。' +
                '0にできるとは限りません（コマ数の構造上、必ずいくらか残る条件もあります）。</p></div>';
        }

        // ボタン類は最上部のヒーローに集約済み。ここは使い方の案内だけ残す
        html += '<p class="hint">ボタンは上部のカードにあります: 「手直しへ進む（Step 10）」で個別のコマを動かせます。' +
            '仕上げ・印刷は「Excelで書き出す」。</p>' + autoSaveNote();

        // 一覧表（A週・B週を分けて表示。緑 = A週とB週で中身が異なるコマ）
        // 「毎週同じ」（1週）にはA週という概念がないので、表は1本だけ出す
        const sharedLegend = '<span style="background:#fdf6e3;padding:0 6px">黄</span>=支援学級で受けるコマ・<span style="background:#f8d7da;color:#b02a37;padding:0 6px">赤</span>=同日重複（絶対条件違反・要修正）';
        if (hasVarSlot()) {
            const legend = '（<span style="background:#d9ead3;padding:0 6px">緑</span>=A週とB週で異なるコマ・' + sharedLegend + '）';
            html += '<h4 class="tg-res-title">一覧表 A週 ' + legend + '</h4>' +
                '<div class="tg-table-wrap">' + ovClassesTable('A') + '</div>' +
                '<h4 class="tg-res-title">一覧表 ' + bWeekDisplay() + '</h4>' +
                '<div class="tg-table-wrap">' + ovClassesTable('B') + '</div>';
        } else {
            html += '<h4 class="tg-res-title">一覧表 （' + sharedLegend + '）</h4>' +
                '<div class="tg-table-wrap">' + ovClassesTable('B') + '</div>';
        }
        html += '<h4 class="tg-res-title">学級×教科の週コマ数チェック（Step 4 の目標との差）</h4>' +
            ovHoursCheckTable();
        if (hasVarSlot()) {
            html += '<h4 class="tg-res-title">教員別一覧 A週（右端は週別の授業数）</h4>' +
                '<div class="tg-table-wrap">' + ovTeachersTable('A') + '</div>' +
                '<h4 class="tg-res-title">教員別一覧 ' + bWeekDisplay() + '</h4>' +
                '<div class="tg-table-wrap">' + ovTeachersTable('B') + '</div>';
        } else {
            html += '<h4 class="tg-res-title">教員別一覧（右端は週の授業数）</h4>' +
                '<div class="tg-table-wrap">' + ovTeachersTable('B') + '</div>';
        }
        html += '<p class="hint">教員の並びは「その他 → 1年 → 2年 → 3年、常勤 → 非常勤」（Step 5a の▲▼で調整可）。' +
            (Number(state.skeleton.cycleWeeks) >= 3 ? '音美は各学級の実施週の割当に従って計上、技家は週交代のため各週0.5で数えています。' : '') +
            '非常勤の授業と授業の間の空きコマは「準備」（準備の時間）として表示します。</p>';

        // 学級ごとの週表（詳細・担当名入り）
        html += '<details style="margin-top:14px"><summary class="tg-res-title" style="cursor:pointer">学級ごとの週表（担当名入り・クリックで開閉）</summary>';
        html += '<div class="tg-res-grid">';
        classIds().forEach(cid => { html += '<div>' + resultClassTable(cid, cid) + '</div>'; });
        state.support.classes.forEach(sc => {
            html += '<div>' + resultClassTable('sc:' + sc.id, (sc.name || '支援学級') + '（支援学級）') + '</div>';
        });
        html += '</div></details>';

        // 教員別
        if (state.teachers.length) {
            html += '<h4 class="tg-res-title">教員別</h4><div class="tg-inline-fields" style="margin-bottom:8px">' +
                '<select id="tgResTeacherSel">' +
                sortedTeachers().map(t => '<option value="' + esc(t.id) + '">' + esc(t.name || '(無名)') + '</option>').join('') +
                '</select></div><div id="tgResTeacherTable"></div>';
        }

        // 生成プロセス（このツールがどう組んだか。手直しの参考用）
        if (r.process && r.process.length) {
            html += '<details style="margin-top:16px" open><summary class="tg-res-title" style="cursor:pointer">生成プロセス（このツールがどう組んだか）</summary>' +
                '<ol class="tg-process">' +
                r.process.map(p => '<li>' + esc(p) + '</li>').join('') +
                '</ol>' +
                '<p class="hint">用語: 「同日重複」= 同じ教科が同じ日に2コマ入ってしまうこと（原則禁止。他に置き場がない場合のみ残り、警告に出ます）。' +
                '「未配置」= どの時間にも置けなかった授業。どちらも0になるまで試行を繰り返します。</p></details>';
        }

        el.innerHTML = html;

        document.getElementById('tgResRetry').addEventListener('click', runSolver);
        document.getElementById('tgResBoard').addEventListener('click', exportBoardJson);
        document.getElementById('tgResExcel').addEventListener('click', exportBoardXlsx);
        preloadExcelLibrary();
        document.getElementById('tgGoEdit').addEventListener('click', () => showStep(10));
        el.querySelectorAll('.tg-alt-tab').forEach(b => b.addEventListener('click', () => {
            activeAlt = Number(b.dataset.alt) || 0;
            renderSolverResult();
        }));
        const adoptBtn = document.getElementById('tgAdoptRelax');
        if (adoptBtn) adoptBtn.addEventListener('click', () => {
            if (solverRunning || relaxRunning) return;   // 調べている最中に条件を変えると結果とかみ合わなくなる
            escalationPend.forEach(x => addIgnored(x.id, x.label));
            renderStep9();   // チップと結果画面を再描画（renderStep9 末尾で renderSolverResult も呼ばれる）
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
        document.querySelectorAll('#solverResult .tg-relax-apply').forEach(b => b.addEventListener('click', () => {
            if (solverRunning || relaxRunning) return;
            if (b.dataset.rid === 'abMode:repair') {
                state.solver = state.solver || {};
                state.solver.abMode = 'repair';   // これは無視ではなく設定変更（Step 9 のセレクトに反映される）
                save();
            } else {
                addIgnored(b.dataset.rid, b.dataset.rlabel);
            }
            renderStep9();
            runSolver();
        }));
        const relaxBtn = document.getElementById('tgRelaxCheck');
        if (relaxBtn) relaxBtn.addEventListener('click', async () => {
            // 調査は最長で数分かかる。実行中の再クリックは「中断」として扱う
            // （調査中は生成も手直しも待たされるため、抜け道を必ず用意しておく）
            if (relaxRunning) {
                relaxCancelFlag = true;
                relaxBtn.textContent = '中断しています…';
                return;
            }
            if (!window.TimetableSolver.analyzeRelaxations || !lastResult || solverRunning) return;
            relaxRunning = true;
            relaxCancelFlag = false;
            relaxErrorMsg = '';   // 前回の失敗表示をいったん消す
            const target = lastResult;   // 調査中に時間割が入れ替わっていないかを最後に確かめる
            const budgetMin = solverBudgetMin();
            const perTry = Math.min(30000, Math.max(15000, Math.round(budgetMin * 60000 / 10)));
            try {
                const report = await callSolver('analyzeRelaxations',
                    JSON.parse(JSON.stringify(state)), {
                        timeBudgetMs: perTry,
                        ignoredIds: ignoredIdList()
                    }, {
                        onProgress: p => { relaxBtn.textContent = '調査中（' + p.index + '/' + p.total + '）… ' + p.label + '（もう一度押すと中断）'; },
                        shouldCancel: () => relaxCancelFlag
                    });
                // 別の時間割に差し替わっていたら、この調査結果はその時間割のものではないので捨てる
                // （中断時は調べ終えた変種までの部分的な結果が返る）
                if (lastResult === target) lastResult.relaxReport = report;
            } catch (err) {
                console.error('[timetable-generator] 条件を1つ緩めた場合の効果の調査に失敗しました', err);
                relaxErrorMsg = '調査が途中で止まりました。時間割そのものは変わっていません。' +
                    'もう一度ボタンを押すとやり直せます。（技術的な内容: ' +
                    ((err && err.message) ? err.message : String(err)) + '）';
            } finally {
                relaxRunning = false;   // 成功・失敗のどちらでも必ず解除する（残ると以後の操作が全部止まる）
                renderSolverResult();
            }
        });
        const sel = document.getElementById('tgResTeacherSel');
        if (sel) {
            const renderT = () => {
                // 「毎週同じ」（1週）は表が1枚だけなので、A週セクションも週見出しも出さない
                document.getElementById('tgResTeacherTable').innerHTML =
                    '<div class="tg-res-teacher-weeks">' +
                    (hasVarSlot()
                        ? '<section><h5 class="tg-res-week-title">A週</h5>' +
                          resultTeacherTable(sel.value, 'A') +
                          '</section>' +
                          '<section><h5 class="tg-res-week-title">' + bWeekDisplay() + '</h5>' +
                          resultTeacherTable(sel.value, 'B') +
                          '</section>'
                        : '<section>' + resultTeacherTable(sel.value, 'B') + '</section>') +
                    '</div>';
            };
            sel.addEventListener('change', renderT);
            renderT();
        }
    }

    /* ---------- 手動ボード（board.html）形式への書き出し ---------- */

    const BOARD_COLORS = {
        '国語': '#e8b4bc', '社会': '#f5d0a9', '数学': '#a9c9f5', '理科': '#b8e0c9', '英語': '#d9c2ec',
        '音楽': '#f9e2ae', '美術': '#f5b8d0', '音美': '#f7cdb7', '保健体育': '#aee3e8', '技術': '#cdd9a3',
        '家庭': '#f2c6b4', '技家': '#dcd3a8', '道徳': '#d5d9e0', '学活': '#d5d9e0', '総合': '#d5d9e0',
        '自立活動': '#cfe3d8', '生活単元': '#dde8c5', '学年職員の教科': '#e3e3e3'
    };
    const BOARD_SHORTS = { '保健体育': '保体', '自立活動': '自立', '生活単元': '生単', '学年職員の教科': '学職' };

    function boardStateForExport() {
        if (!lastResult) return null;
        // 書き出せない構成は Step 1・Step 9 で先に警告済み。ここは最後の砦なので同じ文言を出す。
        // 時限数は Excel 側が Step 1 の設定どおりに列を組むため制限なし（7〜8限も書き出せる）。
        // 週サイクルだけは A/B1/B2 の3枠しか作れないので 3週までが上限。
        // 4週は Step 1 の選択肢から外したので UI からは到達しないが、
        // 古い保存データや読み込んだ設定ファイル経由で入ってくる場合の保険として残す。
        const limitNote = exportLimitNote();
        if (limitNote) {
            alert(limitNote);
            return null;
        }
        return buildBoardState(Object.assign({}, lastResult, {
            cells: activeCells(),
            aWeek: activeAWeek()
        }));
    }

    function exportBoardJson() {
        const board = boardStateForExport();
        if (!board) return;
        const blob = new Blob([JSON.stringify(board, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = '_時間割_ボード用.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
    }

    // Excel ライブラリ（約950KB）は初期ロードでは読み込まず、ここで初めて取りに行く。
    // 未読込だと押してから数秒かかることがあるので、その間ボタンの文言を変えて待ちを見せる。
    async function exportBoardXlsx(ev) {
        const btn = ev && ev.currentTarget;   // await をまたぐと null になるので先に控える
        const board = boardStateForExport();
        if (!board) return;
        if (!window.TimetableExcel) {
            alert('Excel書き出し機能を読み込めませんでした。ページを再読み込みしてください。');
            return;
        }
        const label = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = 'Excelを準備しています…'; }
        try {
            await window.TimetableExcel.exportXlsx(board);
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = label; }
        }
    }

    // 結果が出た画面を開いた時点で、裏で Excel ライブラリを先に取っておく。
    // 教員が結果を眺めている間に用意が終わるので、初回の書き出しも待たされない。
    function preloadExcelLibrary() {
        if (!window.TimetableExcel || !window.TimetableExcel.preload) return;
        const go = () => window.TimetableExcel.preload().catch(() => {});   // 失敗しても押した時に出し直すので黙って捨てる
        // 結果表の描画を邪魔しないよう、画面が落ち着いてから取りに行く
        if (window.requestIdleCallback) window.requestIdleCallback(go, { timeout: 3000 });
        else setTimeout(go, 1200);   // requestIdleCallback が無いブラウザ向け
    }

    function buildBoardState(result) {
        const gradeLabel = g => String(g);
        const classes = classIds().map(cid => ({ id: cid, grade: gradeLabel(gradeOfClass(cid)), name: cid }));
        state.support.classes.forEach(sc => {
            classes.push({ id: 'sc:' + sc.id, grade: '基', name: sc.name || '支援学級' });
        });
        const partNote = t => {
            if (t.type !== 'part') return undefined;
            const p = t.part || {};
            const parts = [];
            if (p.lunch === 'am_only') parts.push('午前のみ');
            if (Number(p.dayMin) > 0 || Number(p.dayMax) > 0) {
                const min = Number(p.dayMin) > 0 ? p.dayMin : '';
                const max = Number(p.dayMax) > 0 ? p.dayMax : '';
                parts.push('1日' + min + (min && max ? '〜' : '') + max + 'コマ');
            }
            if (p.prepWeek !== '' && p.prepWeek != null && !isNaN(Number(p.prepWeek))) {
                parts.push('準備(週の空き上限)' + p.prepWeek);
            }
            return '非常勤：' + (parts.length ? parts.join('／') : '条件未設定');
        };
        const teachers = state.teachers.map(t => {
            const na = (t.na || []).map(slot => {
                const [day, period] = String(slot).split('-');
                return (SOLVER_DAY_JP[day] || day) + '|' + period;
            });
            const teacher = { id: t.id, name: t.name || '(無名)', na };
            const note = partNote(t);
            if (note) teacher.note = note;
            return teacher;
        });

        // 「学年職員の教科」は学級ごとに実教科へ解決する（判定できない場合のみ「学年職員の教科」のまま）
        const resolvedHr = {};
        classIds().forEach(cid => { resolvedHr[cid] = homeroomSubjectOf(cid) || '学年職員の教科'; });

        // 使う教科を集める（未配置分も含む全授業 + 変動枠の中身 + 音美A週置換の担任教科）
        const usedSubjects = new Set();
        (result.lessonSpecs || []).forEach(sp => usedSubjects.add(sp.subject));
        Object.values(result.cells).forEach(c => {
            usedSubjects.add(c.subject);
            if (c.subject === '音美') usedSubjects.add(resolvedHr[(c.classIds || [])[0]] || '学年職員の教科');  // A週置換用
        });
        if (hasVarSlot()) {
            weekLabels().forEach(w => GRADES.forEach(g => {
                if (!gradeUsesVar(g)) return;
                const s = ((state.varContent[w] || {})[g]) || '学年職員の教科';
                if (s === '学年職員の教科' || s === VAR_UNUSED) {
                    classIds().filter(c => gradeOfClass(c) === g).forEach(c => usedSubjects.add(resolvedHr[c]));
                } else {
                    usedSubjects.add(s);
                }
            }));
        }
        const subjects = [...usedSubjects].map((name, i) => ({
            id: 'bs' + i, name,
            short: BOARD_SHORTS[name] || (name.length > 2 ? name.slice(0, 2) : name),
            color: BOARD_COLORS[name] || '#dfe3ea'
        }));
        const subjIdOf = name => (subjects.find(s => s.name === name) || {}).id;

        // 授業カード（教科×教員×学級の組で1枚に集約）
        const lessonMap = new Map();
        let lseq = 0;
        function lessonFor(subjectName, teacherIds, classIdsArr, isLessonSpec) {
            const key = subjectName + '|' + teacherIds.slice().sort().join(',') + '|' + classIdsArr.slice().sort().join(',');
            if (!lessonMap.has(key)) {
                lessonMap.set(key, { id: 'bl' + (lseq++), subjectId: subjIdOf(subjectName), teacherIds: teacherIds.slice(), classIds: classIdsArr.slice() });
            }
            const lesson = lessonMap.get(key);
            if (isLessonSpec) lesson.need = (lesson.need || 0) + 1;
            return lesson;
        }

        // 授業カードは未配置分も含めて先に全部作る（ボードで手作業の続きができるように）
        // ただし音美（隔週枠）のカードには need を付けない。音美はグリッド上では週ごとに
        // 実教科（B1=音楽 / B2=美術 / A週=充当教科）へ解決済みで、「音美」のまま置かれることが
        // ないため、need を付けると常に「配置 0/1 の置き忘れ」に見えてしまう。
        (result.lessonSpecs || []).forEach(sp =>
            lessonFor(sp.subject, sp.teacherIds || [], sp.classIds || [], sp.subject !== '音美'));

        // ベース週のグリッド（全週共通部分）
        const baseGrid = {};
        Object.keys(result.cells).forEach(key => {
            const cell = result.cells[key];
            const [cid, dayEn, period] = key.split('|');
            // 音美カードの担任は予約用なので、ボードのカードには入れない（B週の実担当は音楽/美術の2名）
            const tids = (cell.subject === '音美' && cell.aHomeroom)
                ? (cell.teacherIds || []).filter(t => t !== cell.aHomeroom)
                : (cell.teacherIds || []);
            const lesson = lessonFor(cell.subject, tids, cell.classIds || [cid]);
            baseGrid[cid + '|' + SOLVER_DAY_JP[dayEn] + '|' + period] = lesson.id;
        });

        // A週の最終グリッド。repair モードの入れ替え結果も含む aWeek.cells を優先する。
        const aWeekCells = result.aWeek && result.aWeek.cells;

        // 週ごとのグリッド = ベース + 変動枠（board は A/B1/B2 固定）
        const vs = state.skeleton.varSlot;
        const vsMax = Number(state.skeleton.periods[vs.day]) || 0;
        // 変動枠が骨格の範囲外なら書き込まない（solver 側でエラー済み）
        const withVar = hasVarSlot() && SOLVER_DAY_KEYS.includes(vs.day) &&
            Number(vs.period) >= 1 && Number(vs.period) <= vsMax;
        const wl = weekLabels();
        const grid = {};
        const onbiBySlot = {};
        ['A', 'B1', 'B2'].forEach((bw, i) => {
            grid[bw] = (bw === 'A' && aWeekCells) ? {} : Object.assign({}, baseGrid);
            // ボードは A/B1/B2 の3枠固定。サイクルが3週未満のときは最後の週で埋める。
            // 以前は i % wl.length だったため、2週サイクルで B2 に A週の変動枠が入っていた
            const w = wl[Math.min(i, wl.length - 1)];

            if (bw === 'A' && aWeekCells) {
                Object.entries(aWeekCells).forEach(([key, cell]) => {
                    const [cid, dayEn, period] = key.split('|');
                    const subjectName = cell.subject === '学年職員の教科'
                        ? (resolvedHr[cid] || '学年職員の教科')
                        : cell.subject;
                    const lesson = lessonFor(subjectName, cell.teacherIds || [], [cid]);
                    grid.A[cid + '|' + SOLVER_DAY_JP[dayEn] + '|' + period] = lesson.id;
                });
            }

            // 変動枠（使う学年のみ。使わない学年は baseGrid の通常授業がそのまま入る）
            if (withVar) {
                classIds().forEach(cid => {
                    const g = gradeOfClass(cid);
                    if (!gradeUsesVar(g)) return;
                    let subjectName = ((state.varContent[w] || {})[g]) || '学年職員の教科';
                    if (subjectName === VAR_UNUSED) subjectName = '学年職員の教科';
                    let tids;
                    if (subjectName === '総合' || subjectName === '学年職員の教科' || HOMEROOM_SUBJECTS.includes(subjectName)) {
                        const hr = state.teachers.find(t => t.homeroom === cid);
                        tids = hr ? [hr.id] : [];
                        if (subjectName === '学年職員の教科') subjectName = resolvedHr[cid];  // 実教科へ解決
                    } else {
                        tids = ((state.assignments[cid] || {})[subjectName] || []).filter(Boolean);
                    }
                    const lesson = lessonFor(subjectName, tids, [cid]);
                    grid[bw][cid + '|' + SOLVER_DAY_JP[vs.day] + '|' + vs.period] = lesson.id;
                });
            }
            // aWeek.cells がない場合だけ、従来方式でA週の音美を充当に置換する。
            // B1・B2週は位相（ソルバ割当）に従って音楽/美術の実教科・実担当に解決する
            Object.entries(result.cells).forEach(([key, cell]) => {
                if (cell.subject !== '音美' || key.startsWith('sc:') || (bw === 'A' && aWeekCells)) return;
                const [cid, dayEn, period] = key.split('|');
                let lesson;
                if (w === 'A') {
                    lesson = lessonFor(resolvedHr[cid] || '学年職員の教科', cell.aHomeroom ? [cell.aHomeroom] : [], [cid]);
                } else {
                    const pair = BIWEEKLY_PAIRS['音美'];
                    const asg = (cell.teacherIds || []).filter(t => t !== cell.aHomeroom);
                    const ph = cell.phase != null ? cell.phase : 0;
                    const subIdx = (w === wl[1]) ? ph : 1 - ph;  // B1週: pair[位相]、B2週: もう片方
                    lesson = lessonFor(pair[subIdx], asg[subIdx] ? [asg[subIdx]] : [], [cid]);
                }
                grid[bw][cid + '|' + SOLVER_DAY_JP[dayEn] + '|' + period] = lesson.id;
                if (bw === 'B1' || bw === 'B2') {
                    const rec = onbiBySlot[key] || {
                        classId: cid,
                        day: SOLVER_DAY_JP[dayEn],
                        period: Number(period),
                        b1LessonId: null,
                        b2LessonId: null
                    };
                    rec[bw === 'B1' ? 'b1LessonId' : 'b2LessonId'] = lesson.id;
                    onbiBySlot[key] = rec;
                }
            });
        });

        // 支援で受ける教科について、交流学級ごとに「その時刻の支援学級の行き場」を対応付ける。
        // 支援側は教科を問わず、授業カードが1枚あれば生徒の行き場になる。
        const syncGroups = [];
        (state.support.classes || []).forEach(sc => {
            const supportClassId = 'sc:' + sc.id;
            const students = (state.support.students || []).filter(st => st.supportClassId === sc.id);
            const subjectsByExchange = {};
            students.forEach(st => {
                if (!st.exchangeClass) return;
                Object.keys(st.subjects || {}).forEach(subject => {
                    if (st.subjects[subject] !== 'support') return;
                    (subjectsByExchange[st.exchangeClass] ||= new Set()).add(subject);
                });
            });
            Object.entries(subjectsByExchange).forEach(([mirrorClassId, subjects]) => {
                const supportSubjectIds = new Set([...subjects].map(subjIdOf));
                const mirrorLessonIds = [...lessonMap.values()]
                    .filter(l => l.classIds.includes(mirrorClassId) && supportSubjectIds.has(l.subjectId))
                    .map(l => l.id);
                if (!mirrorLessonIds.length) return;
                syncGroups.push({
                    label: (sc.name || '支援学級') + ' × ' + mirrorClassId,
                    supportClassId,
                    mirrorClassId,
                    mirrorLessonIds
                });
            });
        });

        const students = (state.support.students || []).map((st, index) => ({
            name: st.label || ('生徒' + (index + 1)),
            mirrorClassId: st.exchangeClass || '',
            supportClassId: st.supportClassId ? ('sc:' + st.supportClassId) : '',
            supportSubjects: Object.keys(st.subjects || {})
                .filter(subject => st.subjects[subject] === 'support')
        }));
        // 支援学級の担任も含める（Excelの学級名に担任を添えるため）。
        // 教員名の学年プレフィックスは「1-1」のような数字始まりの学級名だけに付くので、
        // 支援学級を入れてもそちらの表示は変わらない
        const homerooms = {};
        (state.teachers || []).forEach(t => {
            if (t.homeroom) homerooms[t.homeroom] = t.id;
        });

        return {
            version: 2,
            // ボード用JSONの互換のため「R8」形式のまま。Step 1 の年度から令和の年を出す（R1=2019）
            year: 'R' + Math.max(1, (Number(state.schoolYear) || defaultSchoolYear()) - 2018),
            classes, teachers, subjects,
            lessons: [...lessonMap.values()],
            grid,
            meta: {
                // 配付物の見出し・ファイル名に使う（Step 1）。学校名は任意入力なので空のことがある
                schoolName: (state.schoolName || '').trim(),
                schoolYear: Number(state.schoolYear) || 0,
                // Excel側がシート構成を週数に合わせるために使う（1週=1シート）
                cycleWeeks: Number(state.skeleton.cycleWeeks) || 1,
                // 書き出し時点の盤面を保存。ボード側で削除されたコマを復元可能にする。
                baselineGrid: JSON.parse(JSON.stringify(grid)),
                exportedAt: new Date().toISOString(),
                source: 'wizard',
                unplaced: result.unplaced || [],
                onbi: Object.values(onbiBySlot),
                syncGroups,
                students,
                homerooms,
                // 変動枠の位置。ボード側で「変動枠と隣接する同教科の連続2コマ」を
                // 同日同教科の違反から除外するために使う（例: 火5固定の総合＋火6変動枠の総合）
                varSlot: withVar ? { day: SOLVER_DAY_JP[vs.day], period: Number(vs.period) } : null,
                // 曜日ごとの時限数（Step 1）。Excelの列組みをこの学校の骨格に合わせるために渡す。
                // 以前は特定の曜日別時限数を前提に列が固定されていた
                dayPeriods: SOLVER_DAY_KEYS.map(d => Number(state.skeleton.periods[d]) || 0),
                expectedClassHours: [weeklyCapacity()]
            }
        };
    }

    // 不具合調査用のフック（画面からは使わない。コンソールから状態と生成結果を取り出すため）
    window.__tgDebug = {
        getState: () => state,
        getLastResult: () => lastResult,
        buildBoardState: () => (lastResult ? buildBoardState(lastResult) : null),
        runSolver
    };

    // ---------- boot ----------

    // ---------- Step 10: 手直し ----------
    // 「📌ここに入れたい・🔒これは確定・あとはツールにおまかせ」を1ページに独立させた画面。
    // A週・B週の両方の表を編集面にする。同じ授業は両週でつながっているため、
    // どちらの表で動かしても両方の週に反映される（B週が土台・A週は差し替えで追従）。
    function renderStep10() {
        const el = document.getElementById('step10Body');
        if (!lastResult) {
            editUi.on = false;
            document.body.classList.remove('tg-editing');
            el.innerHTML =
                '<div class="tg-hero warn"><div class="tg-hero-mark">！</div>' +
                '<div class="tg-hero-main"><p class="tg-hero-title">まだ時間割がありません</p>' +
                '<p class="tg-hero-sub">先に Step 9 で「時間割を組む」を実行してください。できた時間割をこのページで微調整できます。</p></div>' +
                '<div class="tg-hero-actions"><button type="button" class="btn btn-primary" id="tgEdBack9">Step 9 へ →</button></div></div>';
            document.getElementById('tgEdBack9').addEventListener('click', () => showStep(9));
            return;
        }
        editUi.on = true;
        document.body.classList.add('tg-editing');
        const r = lastResult;
        const hardViolationCount = (r.hardSummary || [])
            .filter(item => item.status === 'ng')
            .reduce((sum, item) => sum + (item.notes || []).length, 0);

        let html = '';

        // 現在の状態: 違反は1件ずつ表示し、「この違反は無視する」を選べる。
        // 無視は表示上の整理（次に組み直すときは再び条件として扱われる）。
        const ngNotes = [];
        (r.hardSummary || []).filter(it => it.status === 'ng').forEach(it => {
            // viol = ソルバが「本当の違反行だけ」を選別したもの（条件の列挙や注記は含まない）
            const lines = (it.viol && it.viol.length) ? it.viol : (it.notes || []);
            lines.forEach(n => {
                if (n.indexOf('分けて判定') >= 0) return;
                ngNotes.push(n);
            });
        });
        const activeNg = ngNotes.filter(n => !editUi.ignored.has(n));
        const ignoredNg = ngNotes.filter(n => editUi.ignored.has(n));
        if (!ngNotes.length) {
            html += '<div class="tg-edit-status ok">○ いまの時間割は絶対条件をすべて満たしています。手直ししても、ツールがルールを守ったまま調整します</div>';
        } else if (!activeNg.length) {
            html += '<div class="tg-edit-status ok">○ 残っていた違反 ' + ignoredNg.length + ' 件は、すべて「無視する」にしました（下から戻せます）</div>';
        } else {
            html += '<div class="tg-edit-status ng">× 気になる違反が ' + activeNg.length + ' 件あります（内容は下の一覧。承知のうえなら「無視する」で整理できます）</div>';
        }
        if (activeNg.length) {
            html += '<div class="tg-viol-list">' +
                activeNg.map((n, i) => '<div class="tg-viol-item"><span>' + esc(n) + '</span>' +
                    '<button type="button" class="btn btn-ghost btn-small" data-ignore="' + i + '">この違反は無視する</button></div>').join('') +
                '</div>';
        }
        // 直近の手直しで新たに引っかかった「できれば」条件（現場要望）
        if (editUi.softDelta && editUi.softDelta.items.length) {
            const sd = editUi.softDelta;
            html += '<details class="tg-notes-fold" open><summary>この手直しで新たに引っかかった「できれば」条件（' +
                sd.items.length + ' 件・合計 ' + sd.oldTotal + ' → ' + sd.newTotal + '）</summary>' +
                '<div style="padding:4px 12px 10px">' +
                sd.items.map(it => '<div class="tg-viol-item muted"><span><b>' + esc(it.label) + '</b>: ' + esc(it.text) + '</span></div>').join('') +
                '<p class="hint" style="margin:6px 0 0">「できれば」条件なので時間割としては成立しています。気になる場合は ↩1手戻す、または別の行き先を試してください。</p>' +
                '</div></details>';
        }
        if (ignoredNg.length) {
            html += '<details class="tg-notes-fold"><summary>無視した違反（' + ignoredNg.length + ' 件）</summary>' +
                ignoredNg.map((n, i) => '<div class="tg-viol-item muted"><span>' + esc(n) + '</span>' +
                    '<button type="button" class="btn btn-ghost btn-small" data-unignore="' + i + '">戻す</button></div>').join('') +
                '<p class="hint" style="margin:6px 12px">無視は表示上の整理です。Step 9 で組み直すと、これらは再び条件として扱われます。</p></details>';
        }

        // 使い方（常設の説明と凡例）
        html += '<div class="tg-block tg-edit-guide"><h3>つかい方（3ステップ）</h3>' +
            '<ol class="tg-guide-steps">' +
            '<li><b>動かしたい授業をクリック</b> — オレンジの枠が付きます（もう一度クリックで選び直し）</li>' +
            '<li><b>行き先のマスをクリック</b> — 同じ学級の行の中で選びます。空きマスでも、授業のあるマスでも構いません</li>' +
            '<li><b>あとはツールが自動調整</b> — 行き先にあった授業は他のマスへ「玉突き」で逃がします。' +
            '先生の重なり・同じ教科の同日2コマ・出られない時間などのルールは<b>すべて守ったまま</b>組み替え、' +
            '動いたマスを紫の枠でお見せします。どうしても入らないときは<b>何も変えずに理由をお伝えします</b></li>' +
            '</ol>' +
            // 隔週交代（技家・音美）は3週サイクル専用、緑コマ（週ごとの違い）は2週以上でだけ現れる。
            // 出ないものの説明を置くと「うちの画面に無い」と探させてしまうため、週数に合わせて文ごと消す
            (Number(state.skeleton.cycleWeeks) >= 3
                ? '<p class="hint" style="margin:6px 0 8px"><b>ペアのコマ（技家・音美）:</b> 行き先を選ぶと<b>相手のクラスのコマも同じ時刻へ一緒に動きます</b>' +
                  '（一緒に動かせないときは片方だけ動かし、その旨をお知らせします）。' +
                  '<b>緑のコマ（A週とB週で違うコマ）</b>も普通に動かせます（両方の週に反映されます）。</p>'
                : hasVarSlot()
                    ? '<p class="hint" style="margin:6px 0 8px"><b>緑のコマ（A週とB週で違うコマ）</b>は普通に動かせます（両方の週に反映されます）。</p>'
                    : '') +
            '<p class="hint" style="margin:6px 0 8px"><b>🔒 確定モード:</b> 動かしたくない授業をクリックすると固定できます（例: 非常勤の先生の時間割が決まっているとき）。' +
            '📌で動かした授業も自動で🔒になり、以後の調整で動きません。</p>' +
            '<p class="hint" style="margin:0 0 8px"><b>教員別の一覧からも動かせます:</b> 下の「教員別の時間割一覧」を開くと、' +
            '先生の行の授業をクリック→同じ行の空きマスをクリックで移動できます（例: 月1の英語を月2へ）。</p>' +
            (hasVarSlot()
                ? '<p class="hint" style="margin:0 0 8px"><b>A週とB週:</b> 同じ授業は両方の週でつながっています。' +
                  'どちらの表で動かしても<b>両方の週に反映されます</b>。' +
                  (Number(state.skeleton.cycleWeeks) >= 3
                      ? 'A週だけにある「音美から差し替わった授業」（うすい緑）も動かせます: クリックして選び、A週の行き先をクリックすると、' +
                        '<b>まず音美コマごと両方の週を調整</b>し、どうしても無理なときだけA週の中だけで動かします（どちらになったかはメッセージでお知らせ）。'
                      : '') + '</p>'
                : '') +
            '<div class="tg-legend-row">' +
            '<span class="tg-legend-chip"><i class="lg-sel"></i>選択中</span>' +
            '<span class="tg-legend-chip"><i class="lg-cand"></i>行き先の候補（選択中のみ）</span>' +
            '<span class="tg-legend-chip"><i class="lg-edited"></i>いま動いたマス</span>' +
            '<span class="tg-legend-chip"><i class="lg-lock"></i>🔒確定（動かない）</span>' +
            (hasVarSlot() ? '<span class="tg-legend-chip"><i class="lg-rot"></i>A週とB週で違うコマ</span>' : '') +
            '<span class="tg-legend-chip"><i class="lg-sup"></i>支援学級で受けるコマ</span>' +
            '<span class="tg-legend-chip"><i class="lg-dup"></i>同日重複（要修正）</span>' +
            '</div></div>';

        // まだ入っていない授業（未配置）: チップを選んで行き先をクリックすると、
        // そのマスの授業を詰将棋で押しのけて入れる。未配置の解消もこのページで完結させる。
        const unplacedList = (r.unplaced || []).filter(u => u.lessonId);
        if (unplacedList.length) {
            html += '<div class="tg-unplaced-bar no-print">' +
                '<span class="tg-edit-bar-label">⚠ まだ入っていない授業（クリックして選び、置きたいマスをクリック）:</span>' +
                unplacedList.map((u, i) =>
                    '<button type="button" class="tg-unplaced-chip' +
                    (editUi.sel && editUi.sel.lid === u.lessonId ? ' sel' : '') +
                    '" data-unplaced="' + i + '" title="' + esc(u.reason || '') + '">' +
                    esc(u.name) + ' を置く</button>').join('') +
                '</div>';
        }

        // 操作バー（sticky＝スクロールしても画面に追従・現場要望）。
        // 1段目=クリック操作のモード、2段目=先生単位のまとめ操作（確定と解除）
        const manualOn = !!(editUi.manual && editUi.manual.active);
        html += '<div class="tg-edit-bar no-print">' +
            '<span class="tg-edit-bar-label">マスをクリックしたとき:</span>' +
            '<label><input type="radio" name="tgEditMode" value="pin"' + (editUi.mode === 'pin' ? ' checked' : '') + '>📌 動かす（自動調整）</label>' +
            '<label><input type="radio" name="tgEditMode" value="manual"' + (editUi.mode === 'manual' ? ' checked' : '') + '>✋ 手動連鎖</label>' +
            '<label><input type="radio" name="tgEditMode" value="lock"' + (editUi.mode === 'lock' ? ' checked' : '') + '>🔒 確定にする</label>' +
            (editUi.prev ? '<button type="button" class="btn btn-ghost" id="tgEditUndo">↩ 1手戻す</button>' : '') +
            '<span class="hint" id="tgEditMsg">' + esc(editUi.busy ? '調整中…（最大1分ほどかかることがあります）／終わるまで下のボタンは操作できません。' +
                'やめるときは画面の右下にある「中断する」を押してください' : (editUi.msg ||
                (editUi.mode === 'pin'
                    ? (editUi.sel ? '「' + editUi.sel.subject + '」を移動先のマスへ（同じ学級の行内・A週B週どちらでも）' : '動かしたい授業をクリック → 行き先をクリック')
                    : '確定したい授業をクリックで🔒/解除'))) + '</span>' +
            '<span class="tg-edit-teacherrow">' +
            '<span class="tg-edit-bar-label">先生単位:</span>' +
            '<select id="tgEditTeacherSel">' +
            sortedTeachers().map(t => '<option value="' + esc(t.id) + '">' + esc(t.name || '(無名)') + '</option>').join('') +
            '</select>' +
            '<button type="button" class="btn btn-ghost" id="tgEditLockTeacher">🔒この先生を全部確定</button>' +
            '<button type="button" class="btn btn-ghost" id="tgEditUnlockTeacher">この先生の🔒を解除</button>' +
            (editUi.locks.size ? '<button type="button" class="btn btn-ghost" id="tgEditClear">すべて解除（' + editUi.locks.size + '件）</button>' : '') +
            '</span></div>';

        // 手動連鎖の作業パネル（浮き駒トレイ・ライブ違反・確定/破棄）
        if (manualOn) {
            const mv = checkManualViolations(editUi.manual.grid);
            const fl = editUi.manual.floating;
            html += '<div class="tg-manual-panel no-print">' +
                '<div class="tg-manual-row">' +
                (fl.length
                    ? '<span class="tg-edit-bar-label">浮いているコマ（置き場所をクリック）:</span>' +
                      fl.map((f, i) => '<button type="button" class="tg-unplaced-chip' +
                          (editUi.sel && editUi.sel.lid === f.lessonId ? ' sel' : '') +
                          '" data-floating="' + i + '">' + esc(((f.classIds || [])[0] || '') + ' ' + f.subject) + '</button>').join('')
                    : '<span class="tg-edit-bar-label">浮いているコマ: なし（すべて盤上にあります）</span>') +
                '<button type="button" class="btn btn-ghost" id="tgManualUndo"' + (editUi.manual.history.length ? '' : ' disabled') + '>↩ 1手戻す</button>' +
                '<button type="button" class="btn btn-primary" id="tgManualCommit"' + ((fl.length || mv.length) ? ' disabled' : '') + '>この形で確定する（A週も更新）</button>' +
                '<button type="button" class="btn btn-ghost" id="tgManualDiscard">連鎖を破棄して元に戻す</button>' +
                '</div>' +
                (mv.length
                    ? '<div class="tg-viol-list">' + mv.slice(0, 12).map(v => '<div class="tg-viol-item"><span>' + esc(v) + '</span></div>').join('') +
                      (mv.length > 12 ? '<p class="hint">…ほか ' + (mv.length - 12) + ' 件</p>' : '') + '</div>'
                    : '<p class="hint" style="margin:4px 0 0">○ いまの形に違反はありません' + (fl.length ? '（浮いているコマを置ききると確定できます）' : '。「確定する」で反映できます') + '</p>') +
                '</div>';
        }

        // A週・B週の表（手動連鎖中はB週の作業盤だけを表示。A週は確定時に自動更新）
        html += '<div id="tgEditTables">' +
            (manualOn || !hasVarSlot() ? '' :
            '<div class="tg-edit-week">' +
            '<h4 class="tg-res-title">A週</h4>' +
            '<div class="tg-table-wrap">' + ovClassesTable('A') + '</div>' +
            '</div>') +
            '<div class="tg-edit-week">' +
            '<h4 class="tg-res-title">' + bWeekDisplay() + (manualOn ? ' — 手動連鎖の作業盤' : '') + '</h4>' +
            '<div class="tg-table-wrap">' + ovClassesTable('B') + '</div>' +
            '</div>' +
            '</div>';

        // 教員の時間割を見ながら手直しできるように（現場要望 2026-07-28）。
        // 表は重いので「開いているときだけ」構築する（閉じたまま毎回作ると全操作が重くなる）
        html += '<details class="tg-notes-fold" id="tgEdTeachers"' + (editUi.teachersOpen ? ' open' : '') + '>' +
            '<summary>教員別の時間割一覧を見る（手直しのたびに自動で更新されます）</summary>' +
            (editUi.teachersOpen
                ? '<div id="tgEdTeachersBody" style="padding:0 12px 12px">' +
                  (hasVarSlot()
                      ? '<h4 class="tg-res-title">教員別 A週</h4>' +
                        '<div class="tg-table-wrap">' + ovTeachersTable('A') + '</div>' +
                        '<h4 class="tg-res-title">教員別 ' + bWeekDisplay() + '</h4>'
                      : '<h4 class="tg-res-title">教員別一覧</h4>') +
                  '<div class="tg-table-wrap">' + ovTeachersTable('B') + '</div>' +
                  '</div>'
                : '') +
            '</details>';

        // 仕上げ
        html += '<div class="tg-block" style="margin-top:16px"><h3>仕上げ</h3>' +
            '<div class="action-bar no-print" style="flex-wrap:wrap">' +
            '<button type="button" class="btn btn-primary" id="tgEdPrint">印刷・PDFにする</button>' +
            '<button type="button" class="btn btn-primary" id="tgEdExcel">Excelで書き出す</button>' +
            '<button type="button" class="btn btn-secondary" id="tgEdBack">← Step 9（結果の詳細）へ戻る</button>' +
            // Step 9 の同じボタンと名前をそろえる（「バックアップ」と呼ばない理由は Step 9 側のコメント参照）
            '<button type="button" class="btn btn-ghost" id="tgEdJson">時間割のデータをJSONで保存</button>' +
            '</div>' +
            '<p class="hint">配付物の見出し：<strong>' + esc(docTitle()) + '</strong>' +
            ((state.schoolName || '').trim() ? '' : '（学校名は Step 1 で入力できます）') + '</p>' +
            '<p class="hint">配付用は「印刷・PDFにする」（A4横。' +
            (hasVarSlot() ? 'A週・B週それぞれのページ' : '1ページ') + 'に「学級ごと」と「先生ごと」を載せます。' +
            '印刷画面で「PDFに保存」を選べばPDFになります）。' +
            'Excelに書き出すと、そのあと手作業でも直せます。</p>' + autoSaveNote('作業内容') + '</div>';

        el.innerHTML = html;

        // --- イベント ---
        // 以下のハンドラ冒頭にある editUi.busy / solverRunning のガードは、disabled との二重の備え。
        // disabled だけだと、描き直しの合間やキーボード操作で抜ける余地が残るため両方入れている。
        el.querySelectorAll('button[data-unplaced]').forEach(b => b.addEventListener('click', () => {
            if (editUi.busy || solverRunning) return;
            const u = unplacedList[Number(b.dataset.unplaced)];
            if (!u) return;
            if (editUi.sel && editUi.sel.lid === u.lessonId) {
                editUi.sel = null;
                highlightSel(null);
                setMsg('動かしたい授業をクリック → 行き先をクリック');
                return;
            }
            editUi.mode = 'pin';
            const pinRb = el.querySelector('input[name="tgEditMode"][value="pin"]');
            if (pinRb) pinRb.checked = true;
            editUi.sel = { lid: u.lessonId, cid: (u.classIds || [])[0], d: null, p: null,
                           subject: u.name, fromUnplaced: true };
            highlightSel(null);
            markCandidates(u.lessonId, [(u.classIds || [])[0]]);
            b.classList.add('sel');
            setMsg('「' + u.name + '」を置きたいマスをクリックしてください（' +
                ((u.classIds || [])[0] || '') + ' の行、または担当の先生の行の空きマス）。そのマスにある授業は玉突きで逃がします');
        }));
        el.querySelectorAll('button[data-ignore]').forEach(b => b.addEventListener('click', () => {
            if (editUi.busy || solverRunning) return;   // 無視の設定は調整の途中では反映できない
            editUi.ignored.add(activeNg[Number(b.dataset.ignore)]);
            renderStep10();
        }));
        el.querySelectorAll('button[data-unignore]').forEach(b => b.addEventListener('click', () => {
            if (editUi.busy || solverRunning) return;
            editUi.ignored.delete(ignoredNg[Number(b.dataset.unignore)]);
            renderStep10();
        }));
        const tFold = document.getElementById('tgEdTeachers');
        if (tFold) tFold.addEventListener('toggle', () => {
            const was = editUi.teachersOpen;
            editUi.teachersOpen = tFold.open;
            if (tFold.open && !was) renderStep10();   // 開いた瞬間だけ中身を構築
        });
        el.querySelectorAll('input[name="tgEditMode"]').forEach(rb => rb.addEventListener('change', e => {
            // 調整中に「手動連鎖」へ切り替えると、調整前の古い盤面を作業盤に取り込んでしまい、
            // それを確定した時点で手直しが巻き戻る
            if (editUi.busy || solverRunning) return;
            const to = e.target.value;
            // 手動連鎖モードへの出入りは盤の状態が変わるので全再描画
            if (to === 'manual') {
                editUi.mode = 'manual'; editUi.sel = null; editUi.msg = '';
                editUi.manual = { active: true, grid: { ...activeCells() }, floating: [], history: [] };
                renderStep10();
                return;
            }
            if (editUi.manual && editUi.manual.active) {
                editUi.manual = null;   // 未確定の連鎖は破棄（確定は専用ボタンから）
                editUi.mode = to; editUi.sel = null; editUi.msg = '手動連鎖を終了しました（未確定の変更は破棄）';
                renderStep10();
                return;
            }
            editUi.mode = to; editUi.sel = null; editUi.msg = '';
            highlightSel(null);
            setMsg(editUi.mode === 'pin' ? '動かしたい授業をクリック → 行き先をクリック' : '確定したい授業をクリックで🔒/解除');
        }));
        // 手動連鎖: 浮き駒チップ・戻す・確定・破棄
        el.querySelectorAll('button[data-floating]').forEach(b => b.addEventListener('click', () => {
            if (editUi.busy || solverRunning) return;
            const f = editUi.manual.floating[Number(b.dataset.floating)];
            if (!f) return;
            editUi.sel = { lid: f.lessonId, cid: (f.classIds || [])[0], subject: f.subject, fromFloating: true };
            highlightSel(f.lessonId);
            markCandidates(f.lessonId, [(f.classIds || [])[0]]);
            setMsg('「' + f.subject + '」の置き場所をクリックしてください（緑の点線=候補。授業のあるマスなら、そのコマが次に浮きます）');
        }));
        const mUndo = document.getElementById('tgManualUndo');
        if (mUndo) mUndo.addEventListener('click', () => {
            if (editUi.busy || solverRunning) return;
            const h = editUi.manual.history.pop();
            if (!h) return;
            editUi.manual.grid = h.grid;
            editUi.manual.floating = h.floating;
            editUi.sel = null;
            editUi.msg = '↩ 1手戻しました';
            renderStep10();
        });
        const mDiscard = document.getElementById('tgManualDiscard');
        if (mDiscard) mDiscard.addEventListener('click', () => {
            if (editUi.busy || solverRunning) return;
            editUi.manual = { active: true, grid: { ...activeCells() }, floating: [], history: [] };
            editUi.sel = null;
            editUi.msg = '連鎖を破棄して元の盤面に戻しました';
            renderStep10();
        });
        const mCommit = document.getElementById('tgManualCommit');
        if (mCommit) mCommit.addEventListener('click', async () => {
            if (editUi.busy || solverRunning) return;
            const grid = editUi.manual.grid;
            const prevManual = editUi.manual;   // 中断されたときに、作りかけの並べ替えを戻すため
            editUi.manual = null;
            editUi.mode = 'pin';
            let ok = false;
            try {
                ok = await runEditSolve({ placementsOverride: grid, _manualCommit: true });
            } catch (err) {
                // 例外で止まると「確定を押したのに無反応」に見えるうえ、busy が立ったままだと
                // 以後の手直しがすべて無言で効かなくなる。必ず戻して理由を出す
                console.error('[timetable-generator] 手動連鎖の確定でエラーが発生しました', err);
                editUi.busy = false;
                editUi.msg = '⚠ 確定の処理が途中で止まりました。時間割は元のままです。もう一度お試しください。' +
                    '（技術的な内容: ' + ((err && err.message) ? err.message : String(err)) + '）';
                rerenderEditSurface();
                return;
            }
            if (!ok) {
                if (editCancelFlag) {
                    // 中断したときは、自分で並べ替えた形まで消さない（また一から並べ直しになるため）
                    editUi.manual = prevManual;
                    editUi.mode = 'manual';
                    editUi.msg = '中断しました。時間割は元のままです。並べ替えた形はそのまま残しています。';
                } else {
                    editUi.msg += '（手動連鎖の形を確かめたところ、成り立たない組み合わせが見つかりました。盤面は元のままです）';
                }
                rerenderEditSurface();
            }
        });
        const lockTeacherBtn = document.getElementById('tgEditLockTeacher');
        if (lockTeacherBtn) lockTeacherBtn.addEventListener('click', () => {
            // 調整中に🔒を足しても、いま走っている探索には既に渡した分しか効かない。
            // 画面には🔒が付いて見えるのに実際は動いてしまう＝表示と中身が食い違う
            if (editUi.busy || solverRunning) return;
            const tid = document.getElementById('tgEditTeacherSel').value;
            let n = 0;
            Object.values(activeCells()).forEach(c => {
                if ((c.teacherIds || []).includes(tid) && c.lessonId && !editUi.locks.has(c.lessonId)) {
                    editUi.locks.add(c.lessonId); n++;
                }
            });
            editUi.msg = '🔒 ' + n + ' 授業を確定しました（この先生のコマは動きません）';
            renderStep10();
        });
        const undoBtn = document.getElementById('tgEditUndo');
        if (undoBtn) undoBtn.addEventListener('click', () => {
            // 調整中に戻すと、あとから終わった調整結果が lastResult を上書きし、
            // 「戻したはずが戻っていない」状態になる
            if (editUi.busy || solverRunning) return;
            if (!editUi.prev) return;
            lastResult = editUi.prev.result;
            saveResultToStorage();
            if (editUi.prev.lockedPin) editUi.locks.delete(editUi.prev.lockedPin);
            (editUi.prev.lockedExtra || []).forEach(id => editUi.locks.delete(id));
            if (editUi.prev.awPins) editUi.awPins = editUi.prev.awPins;
            editUi.prev = null;
            editUi.changed = new Set();
            editUi.changedA = new Set();
            editUi.softDelta = null;
            editUi.msg = '↩ 直前の手直しを取り消しました';
            activeAlt = 0;
            renderStep10();
        });
        const unlockTeacherBtn = document.getElementById('tgEditUnlockTeacher');
        if (unlockTeacherBtn) unlockTeacherBtn.addEventListener('click', () => {
            if (editUi.busy || solverRunning) return;
            const tid = document.getElementById('tgEditTeacherSel').value;
            let n = 0;
            const ownedBy = new Set();
            Object.values(activeCells()).forEach(c => {
                if ((c.teacherIds || []).includes(tid) && c.lessonId) ownedBy.add(c.lessonId);
            });
            (lastResult && lastResult.lessonSpecs || []).forEach(sp => {
                if ((sp.teacherIds || []).includes(tid)) ownedBy.add(sp.id);
            });
            [...editUi.locks].forEach(id => { if (ownedBy.has(id)) { editUi.locks.delete(id); n++; } });
            editUi.msg = n ? 'この先生の🔒を ' + n + ' 件解除しました（🔒 残り ' + editUi.locks.size + ' 件）'
                           : 'この先生に🔒はありませんでした';
            renderStep10();
        });
        const clearBtn = document.getElementById('tgEditClear');
        if (clearBtn) clearBtn.addEventListener('click', () => {
            if (editUi.busy || solverRunning) return;
            editUi.locks.clear(); editUi.msg = '🔒をすべて解除しました';
            renderStep10();
        });
        // --- 軽い操作はその場でDOMだけ更新する（全再描画は表2枚の作り直しで重い） ---
        const setMsg = txt => { const m = document.getElementById('tgEditMsg'); if (m) m.textContent = txt; };
        const highlightSel = lid => {
            el.querySelectorAll('.tg-ov-sel').forEach(x => x.classList.remove('tg-ov-sel'));
            el.querySelectorAll('.tg-unplaced-chip.sel').forEach(x => x.classList.remove('sel'));
            if (!lid) el.querySelectorAll('.tg-ov-cand').forEach(x => x.classList.remove('tg-ov-cand'));
            if (lid) el.querySelectorAll(
                'td[data-elid="' + CSS.escape(lid) + '"], td[data-awlid="' + CSS.escape(lid) + '"]'
            ).forEach(x => x.classList.add('tg-ov-sel'));
        };
        const teacherIdsOfLesson = lid => {
            for (const c of Object.values(activeCells())) if (c.lessonId === lid) return c.teacherIds || [];
            const spec = (r.lessonSpecs || []).find(sp => sp.id === lid);
            return spec ? (spec.teacherIds || []) : [];
        };
        // 選択した授業の「行き先候補」を緑の点線でハイライトする。
        // 除外するのは構造的に絶対に無理なマスだけ:
        //   担当教員の出講不可（na）／非常勤の午前のみの午後／固定コマ（学活・道徳・総合）の席。
        // 教員の重なり等は玉突きで解決できることが多いので候補に残す（実測: 技家28マス中、
        // この3条件で除外された18マス以外の10マスは全て移動成功だった）
        const markCandidates = (lid, cids) => {
            el.querySelectorAll('.tg-ov-cand').forEach(x => x.classList.remove('tg-ov-cand'));
            if (!lid || !cids || !cids.length) return 0;
            const tids = teacherIdsOfLesson(lid);
            const naSet = new Set();
            let amOnly = false;
            tids.forEach(tid => {
                const t = state.teachers.find(x => x.id === tid);
                if (!t) return;
                (t.na || []).forEach(x => naSet.add(typeof x === 'string' ? x : (x.day + '-' + x.period)));
                if (t.part && t.part.lunch === 'am_only') amOnly = true;
            });
            const cells = activeCells();
            let n = 0;
            el.querySelectorAll('td[data-ecid][data-ed]').forEach(td => {
                if (!cids.includes(td.dataset.ecid)) return;
                const d = td.dataset.ed, per = Number(td.dataset.ep);
                if (naSet.has(d + '-' + per)) return;
                if (amOnly && per >= 5) return;
                // どの対象学級でも固定コマの席はダメ
                for (const c2 of cids) {
                    const cc = cells[c2 + '|' + d + '|' + per];
                    if (cc && EDIT_FIXED_SUBJECTS.has(cc.subject)) return;
                }
                if (td.dataset.eaw) return;   // 充当の席は別ルート
                td.classList.add('tg-ov-cand');
                n++;
            });
            return n;
        };

        const selectLesson = (lid, cid, subject) => {
            editUi.sel = { lid, cid, subject };
            highlightSel(lid);
            const partner = pairPartnerOf(lid);
            const cids = partner ? [cid, partner.cid] : [cid];
            const n = markCandidates(lid, cids);
            setMsg('「' + subject + '」を移動先のマスへ（うすい緑の点線 ' + n + ' マス＝行き先の候補。' +
                'それ以外は先生の出講・固定コマなどで構造的に入りません）');
        };
        const clearSel = () => {
            editUi.sel = null;
            highlightSel(null);
            setMsg('動かしたい授業をクリック → 行き先をクリック');
        };
        // ピン実行（ペアのコマなら相手も同じ時刻へまとめて動かす二段構え）
        const goPin = (day, period) => {
            const partner = pairPartnerOf(editUi.sel.lid);
            if (partner) {
                runEditSolve({ pairSmart: {
                    pin: { lessonId: editUi.sel.lid, day, period },
                    partner: { lessonId: partner.lessonId, day, period, subject: partner.subject }
                } });
            } else {
                runEditSolve({ pin: { lessonId: editUi.sel.lid, day, period } });
            }
        };
        // 手動連鎖: 盤上の1手（ソルバなし・即時）。占有者は浮き駒トレイへ
        const manualMove = (td, cid, d, pNum, lid) => {
            const M = editUi.manual;
            const key = cid + '|' + d + '|' + pNum;
            const occ = M.grid[key] || null;
            if (occ && EDIT_FIXED_SUBJECTS.has(occ.subject)) { setMsg('固定コマ（' + occ.subject + '）の席には置けません'); return; }
            if (!editUi.sel) {
                if (!lid) { setMsg('動かしたい授業をクリックしてください'); return; }
                const c = Object.values(M.grid).find(x => x.lessonId === lid);
                editUi.sel = { lid, cid, subject: td.textContent.replace(/🔒/g, '').trim() };
                highlightSel(lid);
                markCandidates(lid, [cid]);
                setMsg('「' + editUi.sel.subject + '」の行き先をクリック（授業のあるマスなら、そのコマが次に浮きます）');
                return;
            }
            if (lid && editUi.sel.lid === lid) { editUi.sel = null; renderStep10(); return; }
            if (cid !== editUi.sel.cid) { setMsg('同じ学級（' + editUi.sel.cid + '）の行の中で行き先を選んでください'); return; }
            // 履歴を積んでから1手指す
            M.history.push({ grid: { ...M.grid }, floating: M.floating.slice() });
            // 選択中のコマを現在地（盤上 or 浮き駒トレイ）から取り出す
            let piece = null;
            for (const [k2, c2] of Object.entries(M.grid)) {
                if (c2.lessonId === editUi.sel.lid) { piece = c2; delete M.grid[k2]; break; }
            }
            if (!piece) {
                const idx = M.floating.findIndex(f => f.lessonId === editUi.sel.lid);
                if (idx >= 0) piece = M.floating.splice(idx, 1)[0];
            }
            if (!piece) { M.history.pop(); setMsg('コマを見つけられませんでした'); return; }
            if (occ) M.floating.push(occ);
            M.grid[key] = piece;
            editUi.sel = null;
            editUi.msg = occ
                ? '置きました。「' + ((occ.classIds || [])[0] || '') + ' ' + occ.subject + '」が浮きました — 続けて置き場所をクリック'
                : '置きました。浮いているコマはありません';
            renderStep10();
            // 浮き駒があれば自動で次の選択にする（手作業の流れそのまま）
            if (occ) {
                const chip = el.querySelector('button[data-floating="' + (editUi.manual.floating.length - 1) + '"]');
                if (chip) chip.click();
            }
        };

        // クラス表・教員表の両方から使う共通クリック処理
        const onEditSurfaceClick = e => {
            if (editUi.busy || solverRunning) return;
            const td = e.target.closest('td[data-ecid], td[data-etid]');
            if (!td) return;
            const cid = td.dataset.ecid || null, d = td.dataset.ed, pNum = Number(td.dataset.ep);
            const lid = td.dataset.elid || null;
            const rowTid = td.dataset.etid || null;
            const labelOf = () => td.textContent.replace(/🔒/g, '').trim();
            // ✋手動連鎖モード
            if (editUi.manual && editUi.manual.active) {
                if (!cid) { setMsg('手動連鎖では学級の行のマスをクリックしてください'); return; }
                manualMove(td, cid, d, pNum, lid);
                return;
            }
            // A週の自動連動コマ（音美→充当の差し替え）: A週の中でだけ動かせる
            if (td.dataset.eaw) {
                if (editUi.mode !== 'pin') {
                    setMsg('A週だけの授業（音美からの差し替え）は🔒できません。📌動かすモードでA週内の移動はできます');
                    return;
                }
                const awlid = td.dataset.awlid;
                if (editUi.sel && editUi.sel.lid === awlid) { clearSel(); return; }
                editUi.sel = { lid: awlid, cid: cid, aw: true, tid: rowTid || null, subject: labelOf() };
                highlightSel(awlid);
                setMsg('「' + labelOf() + '」は音美から差し替わった授業です。A週の表の行き先マスをクリックしてください' +
                    '（まず音美コマごとA週とB週の両方を動かします。無理なときだけA週の中だけで動かします）');
                return;
            }
            // A週専用コマを選択中: 行き先はA週の表に限る
            if (editUi.sel && editUi.sel.aw) {
                if (td.dataset.ew !== 'A') {
                    setMsg('A週だけの授業は、A週の表の中でだけ動かせます（B週には存在しないため）');
                    return;
                }
                if (cid && cid !== editUi.sel.cid) {
                    if (lid) { selectLesson(lid, cid, labelOf()); return; }
                    setMsg('同じ学級（' + editUi.sel.cid + '）の行の中で行き先を選んでください');
                    return;
                }
                if (!cid && rowTid && editUi.sel.tid && rowTid !== editUi.sel.tid) {
                    setMsg('同じ先生の行の中で行き先を選んでください');
                    return;
                }
                // 充当コマの元になっている音美コマ（B週）を特定する。
                // lessonId は 'aw:学級:元の曜日-限' 形式で、元の位置のB週セルが音美。
                // ペアの音美（逆位相連動）は両週移動の対象外なのでA週内のみ。
                let onbiLid = null;
                {
                    const m = String(editUi.sel.lid).match(/^aw:([^:]+):([a-z]+)-(\d+)$/);
                    if (m) {
                        const src = activeCells()[m[1] + '|' + m[2] + '|' + m[3]];
                        if (src && src.subject === '音美' && !src.pairKey) onbiLid = src.lessonId;
                    }
                }
                runEditSolve({ awSmart: { awLessonId: editUi.sel.lid, onbiLessonId: onbiLid, day: d, period: pNum } });
                return;
            }
            if (editUi.mode === 'lock') {
                if (!lid) return;
                const on = !editUi.locks.has(lid);
                if (on) editUi.locks.add(lid); else editUi.locks.delete(lid);
                el.querySelectorAll('td[data-elid="' + CSS.escape(lid) + '"]').forEach(x => x.classList.toggle('tg-ov-lock', on));
                setMsg(on ? '🔒 確定しました（🔒 ' + editUi.locks.size + ' 件）' : '🔒を外しました（🔒 ' + editUi.locks.size + ' 件）');
                return;
            }
            // 📌 動かすモード
            if (!editUi.sel) {
                if (!lid) { setMsg('先に動かしたい授業をクリックしてください'); return; }
                selectLesson(lid, cid, labelOf());
                if (td.dataset.epair) {
                    const pt = pairPartnerOf(lid);
                    const n2 = el.querySelectorAll('.tg-ov-cand').length / 2;   // 両クラス分で割る目安
                    if (pt) setMsg('「' + labelOf() + '」はペアのコマです。相手のクラスの「' + pt.subject +
                        '」も同じ時刻へ一緒に動きます。うすい緑の点線＝行き先の候補' +
                        '（それ以外は担当の先生の出講・固定コマで構造的に入りません）');
                }
                return;
            }
            if (lid && editUi.sel.lid === lid) { clearSel(); return; }
            // 教員別の行のマス: 「この先生のこの時刻へ」＝時刻へのピン。
            // 空きでも、その先生の別の授業が居ても行き先として扱う（例: 月1英語→月2。
            // 月2に同じ先生の別クラスの英語が居れば、それは玉突きで逃げる）。
            // ただし選んだ授業の担当の行に限る（他の先生の行では意味が取れないため、選び直しになる）
            if (rowTid) {
                if (teacherIdsOfLesson(editUi.sel.lid).includes(rowTid)) {
                    goPin(d, pNum);
                } else if (lid) {
                    selectLesson(lid, cid, labelOf());
                } else {
                    setMsg('その行の先生は「' + editUi.sel.subject + '」の担当ではありません。担当の行のマスか、学級の行のマスをクリックしてください');
                }
                return;
            }
            if (cid !== editUi.sel.cid) {
                if (lid) selectLesson(lid, cid, labelOf());
                else clearSel();
                return;
            }
            goPin(d, pNum);
        };
        const tables = document.getElementById('tgEditTables');
        tables.addEventListener('click', onEditSurfaceClick);
        const tBody = document.getElementById('tgEdTeachersBody');
        if (tBody) tBody.addEventListener('click', onEditSurfaceClick);
        document.getElementById('tgEdExcel').addEventListener('click', exportBoardXlsx);
        preloadExcelLibrary();   // Step 9 を通らず復元で直接ここに来る場合もあるため
        document.getElementById('tgEdJson').addEventListener('click', exportBoardJson);
        document.getElementById('tgEdBack').addEventListener('click', () => showStep(9));
        document.getElementById('tgEdPrint').addEventListener('click', printTimetable);
        // 調整中に描き直した場合（再挑戦のたびに通る）は、ここで操作を止め直す
        applyEditBusyUi();
    }

    // 配付用の印刷（A4横・1週=1ページ）。ブラウザの印刷画面から「PDFに保存」も選べる。
    // 画面の表をそのまま使わず専用のページを組み立てるのは、手直し用の選択枠やクリック領域を
    // 持ち込まないため（配付物に編集中の印が出ると読み手が混乱する）。
    function printTimetable() {
        if (!activeCells() || !Object.keys(activeCells()).length) {
            alert('先に時間割を作成してください。');
            return;
        }
        const old = document.getElementById('tgPrintArea');
        if (old) old.remove();

        const wasEditing = editUi.on;
        editUi.on = false;   // 選択枠・ロック印を出さない状態で表を作る

        const stamp = new Date().toLocaleDateString('ja-JP');
        // 色の意味は配る相手にも分かるよう毎ページに添える
        const legend =
            '<div class="tg-print-legend">' +
            // 「毎週同じ」（1週）には比べる相手の週がないので、この凡例行ごと出さない
            (hasVarSlot() ? '<span><i class="lg-rot"></i>もう一方の週と中身が違うコマ</span>' : '') +
            '<span><i class="lg-na"></i>その先生が出られない時間</span>' +
            '<span><i class="lg-dup"></i>同じ教科が同じ日に2回（要修正）</span>' +
            '</div>';
        // 1週=1ページ。同じページに「学級ごと」と「先生ごと」を続けて載せる
        const page = (title, body) =>
            '<section class="tg-print-page">' +
            '<header class="tg-print-head"><h2>' + esc(title) + '</h2>' +
            '<span>' + esc(docTitle()) + '（' + esc(stamp) + ' 時点）</span></header>' +
            body + legend + '</section>';
        const weekBody = w =>
            '<h3 class="tg-print-sub">学級ごと</h3>' + ovClassesTable(w) +
            '<h3 class="tg-print-sub">先生ごと</h3>' + ovTeachersTable(w);

        // 「毎週同じ」（1週）ではA週の概念がないため1ページだけ出す
        const html = hasVarSlot()
            ? page('A週', weekBody('A')) + page(bWeekDisplay(), weekBody('B'))
            : page(bWeekDisplay(), weekBody('B'));
        editUi.on = wasEditing;

        const area = document.createElement('div');
        area.id = 'tgPrintArea';
        area.innerHTML = html;
        document.body.appendChild(area);

        const cleanup = () => {
            const a = document.getElementById('tgPrintArea');
            if (a) a.remove();
            window.removeEventListener('afterprint', cleanup);
        };
        window.addEventListener('afterprint', cleanup);
        window.print();
        // afterprint が来ないブラウザ向けの保険
        setTimeout(cleanup, 60000);
    }

    const RENDERERS = {
        1: renderStep1, 2: renderStep2, 3: renderStep3, 4: renderStep4,
        5: renderStep5, 6: renderStep6, 7: renderStep7, 8: renderStep8, 9: renderStep9,
        10: renderStep10
    };

    document.getElementById('prevBtn').addEventListener('click', () => showStep(state.step - 1));
    document.getElementById('nextBtn').addEventListener('click', () => showStep(state.step + 1));

    // 「使い方」の開閉を記憶（2回目以降は畳んだままにできる）
    {
        const howto = document.getElementById('tgHowto');
        if (howto) {
            try { howto.open = localStorage.getItem(STORAGE_KEY + '/howto') !== 'closed'; } catch (e) {}
            howto.addEventListener('toggle', () => {
                try { localStorage.setItem(STORAGE_KEY + '/howto', howto.open ? 'open' : 'closed'); } catch (e) {}
            });
        }
    }

    renderStorageWarn();          // 起動時点ですでに保存できない環境なら、最初の画面から警告を出す
    restoreResultFromStorage();   // 前回の生成結果があれば復元（Step 9 の表示・Step 10 の手直しが続きから）
    showStep(state.step || 1);

    // 保存データが、いまのルールで釣り合っているとは限らない。
    // 旧版は音美の有無に関係なく1年へ「学年職員の教科」を入れていたため、
    // 音美のない学年でA週だけコマ数が合わない状態のまま保存されている場合がある。
    // 画面を出したあとに一度ならして、変えた内容を知らせる（黙って書き換えない）
    {
        const fix = normalizeVarRotation();
        if (varRotationChanged(fix)) {
            save();
            showStep(state.step);   // 直した結果を今の画面へ反映する
            showVarFixNotice(varRotationNotice(fix));
        }
    }
})();
