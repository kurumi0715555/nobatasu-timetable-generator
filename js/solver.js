/* ============================================
   solver.js — 時間割生成エンジン（v2）
   入力: timetable-generator.js の state と同じ形式
   出力: TimetableSolver.solve(state, opts) → result

   方式:
     ベース週（変動枠を除いた1週間）を1枚だけ解く。
     A/B1/B2 週の違いは変動枠の中身だけなので、変動枠は
     配置対象から外し、週ごとの整合（教員・教室・同日重複）を
     checkVarSlot で別途検証する。

     配置順（支援ファースト）:
       (1) 固定コマ（通常→支援の順・すべて検証付き）
       (2) 支援学級の授業。出席生徒の交流学級に
           「そのコマは生徒が支援で受ける教科のみ（または空き）」
           という許可教科の制限を課す
       (3) 通常学級の残りを、制限を守りながら
           「制約が強い授業から」乱択貪欲で配置
     多スタートで繰り返し、(未配置数, 緩和数, ソフト違反点) の
     辞書順で最良解を選ぶ。完全解が出てもソフト改善を続ける。

   ハード制約:
     - 学級は1コマ1授業
     - 教員は同時刻に1授業まで・出講不可コマに置かない
     - 特別教室のキャパ（教科に紐づく教室の 数×同時クラス数）。
       隔週交代教科（技家・音美）は構成教科（技術・家庭／音楽・美術）
       両方の教室を同時に消費する
     - 同じ教科は1日1コマまで（固定コマ同士＝総合の連続2コマは例外。
       どうしても置けない場合のみ緩和して警告）
     - 男女別体育のペアは同時刻・事前検証（不正ペアはエラー）
     - 支援学級: 交流条件 + 自立活動は全生徒同時
     - 固定コマも上記をすべて検証し、違反は未配置＋エラー
   配置ルール:
     - 変動枠を「（使わない）」にした学年は、変動枠の時間も通常コマとして使う
     - 変動枠を使う学年の担当（担任等）は、ベース週でも変動枠の時間を空けておく
     - 音美はB週のみ実施（A週は学年職員の授業）。担任もそのコマに予約する
     - 技家・音美は「同じ教科・同じ担当ペア」なら2クラスまで同時刻に置ける
       （逆位相: 片方が技術の週はもう片方が家庭。教員・教室を互い違いに使う）
   ソフト制約:
     Step 8 で選択された条件のみ。優先順位が上のものほど重み大。
     配置時スコアと完成解の評価（softBreakdown）の両方に使う。
     教員系条件の完成解評価は A・B1・B2 の週別。A週 repair も拡張 cellIssues で再検証する。
   ============================================ */
(function () {
    'use strict';

    const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
    const DAY_JP = { mon: '月', tue: '火', wed: '水', thu: '木', fri: '金' };
    const HOMEROOM_SUBJECTS = ['学活', '道徳', '総合'];
    const BIWEEKLY_PAIRS = { '技家': ['技術', '家庭'], '音美': ['音楽', '美術'] };

    // 同日重複の衝突教科: 隔週枠（音美・技家）はその構成教科と同日に置けない
    // （例: 音楽と音美が同日 → 音美が音楽の週はその日に音楽2コマになる）
    function dayConflictSubjects(s) {
        if (BIWEEKLY_PAIRS[s]) return [s].concat(BIWEEKLY_PAIRS[s]);
        for (const k of Object.keys(BIWEEKLY_PAIRS)) {
            if (BIWEEKLY_PAIRS[k].includes(s)) return [s, k];
        }
        return [s];
    }

    const MAIN_SUBJECTS = ['国語', '社会', '数学', '理科', '英語'];

    /* ---------- 乱数（シード付き・再現可能） ---------- */
    function mulberry32(a) {
        return function () {
            a |= 0; a = a + 0x6D2B79F5 | 0;
            let t = Math.imul(a ^ a >>> 15, 1 | a);
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
    }

    /* ---------- state ヘルパ ---------- */

    function classIdsOf(state) {
        const ids = [];
        [1, 2, 3].forEach(g => {
            const n = Number(state.classes[g]) || 0;
            for (let i = 1; i <= n; i++) ids.push(g + '-' + i);
        });
        return ids;
    }

    function gradeOf(cid) { return Number(cid.split('-')[0]); }
    function sKey(day, period) { return day + '-' + period; }  // 教員の na と同じ形式

    function fixedSlotOf(state, key, grade) {
        const f = state.fixed;
        if (!f.same && f.perGrade[key] && f.perGrade[key][grade]) return f.perGrade[key][grade];
        return f.items[key] || null;
    }

    function teacherAsg(state, cid, subject) {
        return (((state.assignments || {})[cid] || {})[subject] || []).filter(Boolean);
    }

    function supportHomeroom(state, scId) {
        return state.teachers.find(t => t.homeroom === 'sc:' + scId) || null;
    }

    // 教室資源として消費する教科（隔週交代は構成教科両方を安全側で消費）
    function roomComponents(subject) {
        return BIWEEKLY_PAIRS[subject] ? BIWEEKLY_PAIRS[subject].slice() : [subject];
    }

    function weekLabels(state) {
        const n = state.skeleton.cycleWeeks;
        if (n <= 1) return ['毎週'];
        if (n === 2) return ['A', 'B'];
        return ['A'].concat(Array.from({ length: n - 1 }, (_, i) => 'B' + (i + 1)));
    }

    const VAR_UNUSED = '（使わない）';

    // その学年が変動枠を使うか（全週「（使わない）」なら不使用 = 変動枠の時間も通常コマとして使う）
    function gradeUsesVar(state, g) {
        if (state.skeleton.cycleWeeks <= 1) return false;
        return weekLabels(state).some(w => ((((state.varContent || {})[w]) || {})[g] || '学年職員の教科') !== VAR_UNUSED);
    }

    // 教員の所属学年（'1'|'2'|'3'|'other'）。未設定なら担任クラスから導出
    function gradeGroupOfT(t) {
        if (t.gradeGroup) return t.gradeGroup;
        if (t.homeroom && /^[123]-/.test(t.homeroom)) return t.homeroom[0];
        return 'other';
    }

    // 「学年職員の教科」の学年単位の割り当て計画: cid -> { subject, teacherId } | null
    // 制約・優先順:
    //  1. 同学年の学級間で担当教員が重複しない（変動枠は全クラス同時刻のため必須）
    //  2. その学級を交流学級とする支援生徒が「支援で受ける」教科は避ける
    //     （その教科を充当で減らすと、支援の授業を重ねる時間が足りなくなるため）
    //  3. 担任の担当教科を優先、次に週コマ数が多い教科
    function gradeStaffPlan(state) {
        const plan = {};
        const cids = classIdsOf(state);
        const vs = state.skeleton && state.skeleton.varSlot;
        const varSlotKey = state.skeleton && state.skeleton.cycleWeeks > 1 && vs
            ? sKey(vs.day, Number(vs.period))
            : null;
        [1, 2, 3].forEach(g => {
            const classes = cids.filter(c => gradeOf(c) === g);
            if (!classes.length) return;
            const staffIds = new Set(state.teachers.filter(t => gradeGroupOfT(t) === String(g)).map(t => t.id));
            const hours = state.hours[g] || {};
            const candidates = {};
            classes.forEach(cid => {
                const hr = state.teachers.find(t => t.homeroom === cid);
                // この学級を交流学級とする支援生徒の「支援で受ける」教科は避ける
                const avoid = new Set();
                (state.support.students || []).forEach(st => {
                    if (st.exchangeClass !== cid) return;
                    Object.keys(st.subjects || {}).forEach(s => { if (st.subjects[s] === 'support') avoid.add(s); });
                });
                const list = [];
                Object.keys(hours).forEach(s => {
                    if (HOMEROOM_SUBJECTS.includes(s) || BIWEEKLY_PAIRS[s]) return;
                    if ((Number(hours[s]) || 0) <= 0) return;
                    const asg = teacherAsg(state, cid, s);
                    asg.forEach(tid => {
                        const t = state.teachers.find(x => x.id === tid);
                        if (!t) return;
                        if (!(gradeGroupOfT(t) === String(g) || t.homeroom === cid)) return;
                        if (varSlotKey && (t.na || []).includes(varSlotKey)) return;
                        list.push({
                            subject: s, teacherId: tid, avoid: avoid.has(s),
                            pri: (avoid.has(s) ? 10 : 0) + (hr && tid === hr.id ? 0 : 1),
                            hours: Number(hours[s]) || 0
                        });
                    });
                });
                list.sort((a, b) => a.pri - b.pri || b.hours - a.hours);
                candidates[cid] = list;
            });
            // バックトラックで「教員が重ならない」割り当てを探す（学級数は高々数個）
            const used = new Set();
            const chosen = {};
            function bt(i) {
                if (i >= classes.length) return true;
                const cid = classes[i];
                for (const cand of candidates[cid]) {
                    if (used.has(cand.teacherId)) continue;
                    used.add(cand.teacherId);
                    chosen[cid] = cand;
                    if (bt(i + 1)) return true;
                    used.delete(cand.teacherId);
                    delete chosen[cid];
                }
                chosen[cid] = null;  // 候補が尽きた学級は未割当（後で警告）
                if (bt(i + 1)) return true;
                delete chosen[cid];
                return false;
            }
            bt(0);
            classes.forEach(cid => { plan[cid] = chosen[cid] || null; });
        });
        return plan;
    }

    // 互換ヘルパ（計画から引く）
    function gradeStaffSubjectOfClass(state, cid, plan) {
        const p = (plan || gradeStaffPlan(state))[cid];
        return p ? p.subject : null;
    }
    function gradeStaffTeacherOfClass(state, cid, subject, plan) {
        const p = (plan || gradeStaffPlan(state))[cid];
        if (p && (!subject || p.subject === subject)) return p.teacherId;
        if (!subject) return null;
        const asg = ((((state.assignments || {})[cid]) || {})[subject] || []).filter(Boolean);
        return asg[0] || null;
    }

    // 非常勤の個別条件（Step 5a）を正規化する。設定が1つもなければ null。
    //   amOnly:   午前のみ（給食を食べずに帰る）= 5限以降に授業を置かない
    //   prepWeek: 準備の時間 = 週の空きコマ（授業と授業の間）をこの数まで許容
    //   dayMin:   出講日の最低コマ数（1日1〜2コマだけの出勤を避ける）
    //   dayMax:   出講日の最高コマ数
    // ※給食（4限と5限の間）は空きコマに数えない（4限→5限は連続扱い。3限→5限は4限の空き1コマ）
    function partConfOf(t) {
        if (!t || t.type !== 'part') return null;
        const p = t.part || {};
        const prepRaw = p.prepWeek;
        const conf = {
            amOnly: p.lunch === 'am_only',
            prepWeek: (prepRaw !== '' && prepRaw != null && !isNaN(Number(prepRaw))) ? Math.max(0, Number(prepRaw)) : null,
            dayMin: Math.max(0, Number(p.dayMin) || 0),
            dayMax: Math.max(0, Number(p.dayMax) || 0)
        };
        return (conf.amOnly || conf.prepWeek != null || conf.dayMin > 1 || conf.dayMax > 0) ? conf : null;
    }

    /* ---------- 統一優先順位リスト ----------
       すべての「方針条件」（できれば条件＋非常勤の個別条件）を1つの順位リストで扱う。
       id はソフト条件ID（'subject_pm' 等）または 'part:<教員id>:<amOnly|prepWeek|dayMin|dayMax>'。
       state.priorities = { order: [id...], hard: [id...] } が無ければ
       既存の soft.selected / soft.hard / 非常勤の個別条件（すべて絶対）から導出する（挙動互換） */
    function partItemIds(state) {
        const ids = [];
        (state.teachers || []).forEach(t => {
            const pc = partConfOf(t);
            if (!pc) return;
            if (pc.amOnly) ids.push('part:' + t.id + ':amOnly');
            if (pc.prepWeek != null) ids.push('part:' + t.id + ':prepWeek');
            if (pc.dayMin > 1) ids.push('part:' + t.id + ':dayMin');
            if (pc.dayMax > 0) ids.push('part:' + t.id + ':dayMax');
        });
        return ids;
    }
    function prioritiesOf(state) {
        const partIds = partItemIds(state);
        const p = state.priorities;
        if (p && Array.isArray(p.order) && p.order.length) {
            const partSet = new Set(partIds);
            // 5d で消された条件は除去、新しく設定された条件は末尾に「絶対」で追加（従来どおりの既定）
            const order = p.order.filter(id => !id.startsWith('part:') || partSet.has(id));
            const missing = partIds.filter(id => !order.includes(id));
            const hard = new Set((p.hard || []).filter(id => order.includes(id)));
            missing.forEach(id => hard.add(id));
            return { order: order.concat(missing), hard };
        }
        // 移行既定: 非常勤の条件を最優先（絶対）＋既存の選択済み条件（絶対格上げも維持）
        const selected = ((state.soft && state.soft.selected) || []).slice();
        const softHard = ((state.soft && state.soft.hard) || []).filter(id => selected.includes(id));
        return { order: partIds.concat(selected), hard: new Set(partIds.concat(softHard)) };
    }
    // 非常勤条件アイテムの表示名
    function partItemLabel(state, id) {
        const seg = id.split(':');
        const t = (state.teachers || []).find(x => x.id === seg[1]);
        const pc = t ? partConfOf(t) : null;
        const name = (t && t.name) || '非常勤';
        if (seg[2] === 'amOnly') return name + ': 午前のみ（給食なしで退勤）';
        if (seg[2] === 'prepWeek') return name + ': 週の空きコマは準備の時間（' + (pc ? pc.prepWeek : '?') + '）まで';
        if (seg[2] === 'dayMin') return name + ': 出講日は最低 ' + (pc ? pc.dayMin : '?') + ' コマ';
        if (seg[2] === 'dayMax') return name + ': 1日最高 ' + (pc ? pc.dayMax : '?') + ' コマ';
        return id;
    }

    // A週とB週のズレ許容モード（Step 9）:
    //   exact  = 完全一致（音美コマに学年職員の空き予約を入れる。従来どおり）
    //   repair = 少しずらしてもよい（予約なしでB週を解き、A週は差分最小の入れ替えで直す）
    //   free   = バラバラでもよい（repair と同じ仕組みで、ズレの量を抑えずに直す）
    function abModeOf(state) {
        const m = state.solver && state.solver.abMode;
        return (m === 'repair' || m === 'free') ? m : 'exact';
    }

    // UIへ制御を返すための yield。setTimeout はバックグラウンドタブで最大毎分1回に
    // 抑制される（Chromeのタイマー抑制）ため、ブラウザでは MessageChannel を使う。
    // 注意: 使い捨てチャネル（毎回 new MessageChannel）は postMessage 直後に両ポートが
    // GC されるとメッセージが配送されず、solve の await が永久に返らない
    // （実測: ソフト最適化中のGCで再現・ブラウザのみ）。チャネルはモジュールで
    // 1本だけ保持して使い回す。Node ではタイマー抑制が無く、開いたポートが
    // プロセスの終了を妨げるため setTimeout を使う。
    const IS_NODE = typeof process !== 'undefined' && process.versions && process.versions.node;
    let uiTickChannel = null;
    const uiTickQueue = [];
    function uiTick() {
        if (IS_NODE || typeof MessageChannel === 'undefined') return new Promise(r => setTimeout(r, 0));
        if (!uiTickChannel) {
            uiTickChannel = new MessageChannel();
            uiTickChannel.port1.onmessage = () => { const f = uiTickQueue.shift(); if (f) f(); };
        }
        return new Promise(r => { uiTickQueue.push(r); uiTickChannel.port2.postMessage(0); });
    }

    // 「この条件を無視して組む」（Step 9）: 無視リストの条件を優先順位から外した状態を作る。
    // 絶対の条件は「できれば」へ格下げ（順位は保ち、守れるなら守る）、できれば条件はリストから除外
    // （フェーズ2の自動緩和と同じ操作。part: の id を order から消すと prioritiesOf が
    //   「新設された条件」とみなして絶対で復活させるため、格下げに留めるのが正しい）
    function stateWithIgnored(state, ids) {
        if (!ids || !ids.length) return state;
        const prio = prioritiesOf(state);
        const drop = new Set(ids);
        const s2 = JSON.parse(JSON.stringify(state));
        s2.priorities = {
            order: prio.order.filter(id => prio.hard.has(id) || !drop.has(id)),
            hard: prio.order.filter(id => prio.hard.has(id) && !drop.has(id))
        };
        return s2;
    }

    // 変動枠に「毎週同じ実教科」が入る学年はその教科名（入力=B週込み → 固定分へ変換するために使う）
    function constantVarSubject(state, g) {
        if (state.skeleton.cycleWeeks <= 1 || !gradeUsesVar(state, g)) return null;
        const subs = weekLabels(state).map(w => ((((state.varContent || {})[w]) || {})[g]) || '学年職員の教科');
        const first = subs[0];
        if (first === '学年職員の教科' || first === VAR_UNUSED) return null;
        return subs.every(s => s === first) ? first : null;
    }

    // 学年の「学年職員の授業」回転コマ数（週平均）
    // = 音美コマのA週分 + 変動枠が「学年職員の教科」の週数（サイクルで按分）
    function homeroomRotationPerWeek(state, g) {
        const labels = weekLabels(state);
        if (labels.length <= 1) return 0;
        let perCycle = Number((state.hours[g] || {})['音美']) || 0;  // 音美はA週のみ学年職員の授業
        if (gradeUsesVar(state, g)) {
            labels.forEach(w => {
                if (((((state.varContent || {})[w]) || {})[g] || '学年職員の教科') === '学年職員の教科') perCycle++;
            });
        }
        return perCycle / labels.length;
    }

    // 変動枠の時間に予約する教員の集合。
    // 学年（1〜3年）に所属し、その時間が出講可能な教員は、自学年の総合・学年職員の授業に参加する前提。
    // 加えて、変動枠の中身に実教科を置いた場合はその担当も予約する
    function varDutyTeacherIds(state, staffPlan) {
        const set = new Set();
        const vs = state.skeleton.varSlot;
        if (state.skeleton.cycleWeeks <= 1 || !vs) return set;
        const key = sKey(vs.day, Number(vs.period));
        state.teachers.forEach(t => {
            const gg = gradeGroupOfT(t);
            if ((gg === '1' || gg === '2' || gg === '3') && !(t.na || []).includes(key)) set.add(t.id);
        });
        classIdsOf(state).forEach(cid => {
            const g = gradeOf(cid);
            if (!gradeUsesVar(state, g)) return;
            weekLabels(state).forEach(w => {
                const subject = ((((state.varContent || {})[w]) || {})[g]) || '学年職員の教科';
                if (subject === VAR_UNUSED) return;
                if (subject === '学年職員の教科') {
                    const tid = gradeStaffTeacherOfClass(state, cid, null, staffPlan);
                    if (tid) set.add(tid);
                } else if (subject === '総合' || HOMEROOM_SUBJECTS.includes(subject)) {
                    const hr = state.teachers.find(t => t.homeroom === cid);
                    if (hr) set.add(hr.id);
                } else {
                    teacherAsg(state, cid, subject).forEach(t => set.add(t));
                }
            });
        });
        return set;
    }

    /* ---------- 体育ペアの事前検証 ---------- */
    /* 戻り値: 有効なペアのみの配列。不正なペアは report.errors に積み、
       該当クラスは「単独（男女一緒扱い）」として時数を保全する */
    function validatePePairs(state, cids, report) {
        if (!state.pe.separate) return [];
        const seen = {};
        const valid = [];
        (state.pe.pairs || []).forEach(p => {
            const [a, b] = p;
            if (!a && !b) return;
            if (!a || !b || a === b) {
                report.errors.push('体育ペアの指定が不正です（' + (a || '未選択') + ' & ' + (b || '未選択') + '）。このペアは無効にして単独扱いで配置します（Step 4）。');
                return;
            }
            if (!cids.includes(a) || !cids.includes(b)) {
                report.errors.push('体育ペア ' + a + '&' + b + ' に存在しないクラスが含まれています。単独扱いで配置します（Step 4）。');
                return;
            }
            if (seen[a] || seen[b]) {
                report.errors.push('クラス ' + (seen[a] ? a : b) + ' が複数の体育ペアに入っています。後のペアは無効にします（Step 4）。');
                return;
            }
            const ha = Number((state.hours[gradeOf(a)] || {})['保健体育']) || 0;
            const hb = Number((state.hours[gradeOf(b)] || {})['保健体育']) || 0;
            if (ha !== hb) {
                report.errors.push('体育ペア ' + a + '&' + b + ' の週コマ数が一致しません（' + ha + 'と' + hb + '）。ペアを無効にして各クラス単独で配置します（Step 4）。');
                return;
            }
            const ta = [...new Set(teacherAsg(state, a, '保健体育'))];
            const tb = [...new Set(teacherAsg(state, b, '保健体育'))];
            if (ta.slice().sort().join(',') !== tb.slice().sort().join(',')) {
                report.warnings.push('体育ペア ' + a + '&' + b + ' の担当設定が両クラスで一致していません。' + a + ' 側の設定を使います（Step 5b）。');
            }
            if (ta.length < 2) {
                report.warnings.push('体育ペア ' + a + '&' + b + ' の担当が実質2名未満です（同一教員の重複指定は1名と数えます）。男女別には男子担当・女子担当の異なる2名が必要です（Step 5b）。');
            }
            seen[a] = true; seen[b] = true;
            valid.push([a, b]);
        });
        return valid;
    }

    /* ---------- 授業リクエストの構築 ---------- */
    /* lesson: { id, classIds:[cid], subject, teachers:[tid], grade,
                fixedSlot:{day,period}|null, support:bool, attendees:[student]|null,
                weeklyHours:n } */
    function buildLessons(state, pePairs, report, absorbInfo, staffPlan) {
        const lessons = [];
        let seq = 0;
        // 同一教員の重複指定（TT欄に同じ人など）は1名に正規化する
        const mk = o => { o.id = 'L' + (seq++); o.teachers = [...new Set(o.teachers || [])]; lessons.push(o); return o; };
        const cids = classIdsOf(state);
        const pairOf = cid => pePairs.find(p => p[0] === cid || p[1] === cid) || null;
        const fracWarned = new Set();

        cids.forEach(cid => {
            const g = gradeOf(cid);
            const hours = state.hours[g] || {};

            // 固定コマ計画（学活・道徳・総合・総合2コマ目）
            const fixedPlan = [];
            HOMEROOM_SUBJECTS.forEach(s => {
                if ((Number(hours[s]) || 0) >= 1) {
                    const slot = fixedSlotOf(state, s, g);
                    if (slot) fixedPlan.push({ subject: s, slot });
                }
            });
            if ((Number(hours['総合']) || 0) >= 2) {
                const slot = fixedSlotOf(state, '総合2', g);
                if (slot) fixedPlan.push({ subject: '総合', slot });
            }
            const fixedCount = {};
            fixedPlan.forEach(fp => { fixedCount[fp.subject] = (fixedCount[fp.subject] || 0) + 1; });

            fixedPlan.forEach(fp => {
                mk({ classIds: [cid], subject: fp.subject, teachers: teacherAsg(state, cid, fp.subject),
                     grade: g, fixedSlot: fp.slot, support: false, attendees: null,
                     weeklyHours: Number(hours[fp.subject]) || 0 });
            });

            // 学年職員の授業の充当: 回転枠（音美のA週・変動枠の「学年職員の教科」）が週1コマ相当あるなら、
            // その学級の「学年職員の教科」をベース週から差し引く（実施は回転枠で行われるため）
            const rot = homeroomRotationPerWeek(state, g);
            let absorb = Math.floor(rot + 1e-9);
            let sStar = null;
            if (absorb > 0) {
                sStar = gradeStaffSubjectOfClass(state, cid, staffPlan);
                if (!sStar) {
                    report.warnings.push(cid + ': 学年職員の授業（音美A週・変動枠）の充当先が判定できません。この学年に所属する教員（Step 5a の所属学年）が担当する教科を Step 5b で設定してください。Step 4 の時数どおりに配置します（コマ数超過の可能性）。');
                    absorb = 0;
                }
            }
            if (rot - Math.floor(rot + 1e-9) > 1e-6 && !fracWarned.has(g)) {
                fracWarned.add(g);
                report.warnings.push(g + '年: 学年職員の授業の回転が週' + rot.toFixed(2) + 'コマ相当で、週1コマちょうどになっていません（Step 3 の「学年職員の教科」の週数と音美の設定を確認）。');
            }
            if (absorb > 0 && absorbInfo) absorbInfo.push({ cid, subject: sStar, count: absorb });

            Object.keys(hours).forEach(s => {
                const n = Number(hours[s]) || 0;
                if (!n) return;
                let remaining = n - (fixedCount[s] || 0);
                if (s === sStar && absorb > 0) {
                    const ded = Math.min(Math.max(remaining, 0), absorb);
                    remaining -= ded;
                    if (ded < absorb) {
                        report.warnings.push(cid + ': 学年職員の教科「' + s + '」の週コマ数が充当分（' + absorb + '）より少ないため、' + ded + 'コマのみ差し引きました（Step 4）。');
                    }
                }
                if (remaining <= 0) return;

                if (state.pe.separate && s === '保健体育') {
                    const pair = pairOf(cid);
                    if (pair) {
                        if (pair[1] === cid) return;  // 相方側で生成済み
                        for (let i = 0; i < remaining; i++) {
                            mk({ classIds: [pair[0], pair[1]], subject: s, teachers: teacherAsg(state, cid, s),
                                 grade: g, fixedSlot: null, support: false, attendees: null, weeklyHours: remaining });
                        }
                        return;
                    }
                    // ペアなし（または無効ペア）→ 単独扱いで通常どおり生成
                }

                // 隔週交代教科（技家・音美）: 同じ担当ペアなら2クラスが同時刻に逆位相で入れる（pairKey）。
                // 音美はB週のみ実施でA週は学年職員の授業になるため、その担当（充当先教科の学年職員）も予約する
                const biT = BIWEEKLY_PAIRS[s] ? [...new Set(teacherAsg(state, cid, s))] : null;
                const pairKey = biT ? s + '|' + biT.slice().sort().join(',') : null;
                let teachers = teacherAsg(state, cid, s);
                let aHomeroom = null;
                if (s === '音美') {
                    const staffT = gradeStaffTeacherOfClass(state, cid, sStar, staffPlan) ||
                        (state.teachers.find(t => t.homeroom === cid) || {}).id || null;
                    if (staffT) {
                        aHomeroom = staffT;
                        // 完全一致モードのみ学年職員の空きを予約（ズレ許容モードではA週修復で整合を取る）
                        if (abModeOf(state) === 'exact') teachers = teachers.concat(staffT);
                    } else {
                        report.warnings.push(cid + ': 音美コマのA週は学年職員の授業になりますが、担当する学年職員を判定できません（Step 5a・5b）。空き予約なしで配置します。');
                    }
                }
                for (let i = 0; i < remaining; i++) {
                    mk({ classIds: [cid], subject: s, teachers,
                         grade: g, fixedSlot: null, support: false, attendees: null, weeklyHours: n,
                         biTeachers: biT, pairKey, aHomeroom });
                }
            });
        });

        // 支援学級
        (state.support.classes || []).forEach(sc => {
            const key = 'sc:' + sc.id;
            const students = (state.support.students || []).filter(st => st.supportClassId === sc.id);
            const hr = supportHomeroom(state, sc.id);

            // 固定コマ（複式前提: 全学年共通スロット items を使用）。担任担当。
            if (!state.fixed.same && students.length) {
                report.warnings.push('固定コマが学年別設定のため、支援学級「' + (sc.name || '支援学級') + '」の学活・道徳・総合は全学年共通欄（Step 2 の切替前の値）を使います。交流条件との食い違いに注意してください。');
            }
            HOMEROOM_SUBJECTS.forEach(s => {
                const slot = state.fixed.items[s];
                if (!slot) return;
                mk({ classIds: [key], subject: s, teachers: hr ? [hr.id] : [],
                     grade: null, fixedSlot: slot, support: true,
                     attendees: students.filter(st => st.subjects && st.subjects[s] === 'support'),
                     weeklyHours: 1 });
            });

            // 自立活動の充当: Step 6 の「時数を削る教科」を支援時数から自動控除（1指定=−1コマ）
            const jh = Number((state.support.jiritsu || {}).hours) || 0;
            const dedCount = {};
            const dedList = ((state.support.jiritsu || {}).deductions || []).filter(Boolean);
            dedList.forEach(d => { dedCount[d] = (dedCount[d] || 0) + 1; });

            // 教科（Step 5c の週コマ数から充当分を控除して配置）
            const scHours = (state.support.hours || {})[sc.id] || {};
            const applied = [];
            let appliedTotal = 0;
            Object.keys(scHours).forEach(s => {
                const raw = Number(scHours[s]) || 0;
                if (!raw || HOMEROOM_SUBJECTS.includes(s)) return;
                const ded = Math.min(raw, jh > 0 ? (dedCount[s] || 0) : 0);
                const n = raw - ded;
                if (ded > 0) { applied.push(s + '−' + ded); appliedTotal += ded; }
                if (!n) return;
                const attendees = students.filter(st => st.subjects && st.subjects[s] === 'support');
                for (let i = 0; i < n; i++) {
                    mk({ classIds: [key], subject: s, teachers: teacherAsg(state, key, s),
                         grade: null, fixedSlot: null, support: true, attendees, weeklyHours: n });
                }
            });
            if (applied.length) {
                report.warnings.push('「' + (sc.name || '支援学級') + '」: 自立活動の充当により支援の時数を控除しました（' + applied.join('、') + '）。Step 5c には控除前の週コマ数を入力してください。');
            }
            // 実際に控除できたコマ数と自立の時数が合っているか（指定件数ではなく実効値で判定）
            if (jh > 0 && appliedTotal !== jh) {
                const scName = '「' + (sc.name || '支援学級') + '」';
                if (dedList.length === 0) {
                    report.warnings.push(scName + ': 自立活動 週' + jh + 'コマは、教科の時数を削らずそのまま追加で配置します。' +
                        '自立活動をどれかの教科の時数に充てる場合は、Step 6 の「時数を削る教科」を指定してください。');
                } else if (appliedTotal < jh) {
                    report.warnings.push(scName + ': 自立活動 週' + jh + 'コマに対して、支援時数から控除できたのは ' + appliedTotal + ' コマです' +
                        '（充当指定 ' + dedList.length + ' 件のうち、指定教科の週コマ数が足りない・Step 5c に未入力の分は控除できません。Step 5c・6 を確認）。');
                } else {
                    report.warnings.push(scName + ': 自立活動 週' + jh + 'コマに対して、充当指定が ' + dedList.length + ' 件あり ' + appliedTotal + ' コマ控除しました。' +
                        '自立の時数より多く削っています（Step 6 の指定を減らしてください）。');
                }
            }

            // 自立活動（全生徒同時）
            for (let i = 0; i < jh; i++) {
                mk({ classIds: [key], subject: '自立活動', teachers: teacherAsg(state, key, '自立活動'),
                     grade: null, fixedSlot: null, support: true, attendees: students, weeklyHours: jh });
            }

            // 生活単元学習（全生徒同時・担任担当が既定）
            const sh = Number((state.support.seitan || {}).hours) || 0;
            for (let i = 0; i < sh; i++) {
                mk({ classIds: [key], subject: '生活単元', teachers: teacherAsg(state, key, '生活単元'),
                     grade: null, fixedSlot: null, support: true, attendees: students, weeklyHours: sh });
            }
        });

        return lessons;
    }

    /* ----- 音美の位相割当（0 = B1週に担当1人目の教科=音楽、1 = B1週に美術） -----
       同時刻ペアのクラスは互い違い（B1週に片方が音楽・もう片方が美術）。
       単独配置のクラスは、担当（非常勤）の B1/B2 週のコマ数が最も均等になる位相を選ぶ。
       solve 内の状態には依存しないため、週別評価と表示の双方から共用する。 */
    function assignOnbiPhases(sol) {
        const phases = {};
        const entries = [];
        const seen = new Set();
        Object.keys(sol.occCls).forEach(cid => {
            Object.keys(sol.occCls[cid]).forEach(k => {
                const l = sol.occCls[cid][k];
                if (l.subject !== '音美' || seen.has(l.id)) return;
                seen.add(l.id);
                entries.push({ l, key: k });
            });
        });
        if (!entries.length) return phases;
        const cnt = {};  // tid -> [B1コマ数, B2コマ数]
        const add = (tid, w) => { if (tid) (cnt[tid] = cnt[tid] || [0, 0])[w]++; };
        const teachersOf = l => (l.biTeachers || l.teachers || []).filter(t => t !== l.aHomeroom);
        // 同時刻ペア → 互い違いに割当（学級名順で決定的に）
        const byKey = {};
        entries.forEach(e => {
            const gk = (e.l.pairKey || e.l.id) + '|' + e.key;
            (byKey[gk] = byKey[gk] || []).push(e);
        });
        const singles = [];
        Object.values(byKey).forEach(group => {
            if (group.length === 2) {
                group.sort((a, b) => (a.l.classIds[0] < b.l.classIds[0] ? -1 : 1));
                group.forEach((e, i) => {
                    phases[e.l.id] = i;
                    const asg = teachersOf(e.l);
                    add(asg[i], 0);       // B1週: pair[i] の担当
                    add(asg[1 - i], 1);   // B2週: もう片方
                });
            } else {
                group.forEach(e => singles.push(e));
            }
        });
        // 単独クラス: B1/B2 の偏りが最小になる位相を貪欲に選ぶ
        singles.forEach(e => {
            const asg = teachersOf(e.l);
            const imbalance = ph => {
                let s = 0;
                [[asg[ph], 0], [asg[1 - ph], 1]].forEach(([tid, w]) => {
                    if (!tid) return;
                    const c = cnt[tid] || [0, 0];
                    s += Math.abs((c[0] + (w === 0 ? 1 : 0)) - (c[1] + (w === 1 ? 1 : 0)));
                });
                return s;
            };
            const ph = imbalance(0) <= imbalance(1) ? 0 : 1;
            phases[e.l.id] = ph;
            add(asg[ph], 0);
            add(asg[1 - ph], 1);
        });
        return phases;
    }

    // 教員ごとの条件の濃淡（現場要望 2026-07-28）。
    // 教員に紐づく条件（同じ学年を連続に・空きコマゼロの日・空きの平準化）は、
    // 先生によって必要度が違う。先生ごとに 不要(off)=数えない／ふつう＝×1／
    // 特に重視(strong)=×3、絶対に(hard)=×3＋配置段階で禁止 を選べる。
    //   state.teacherCondWeights = { <条件ID>: { tid: 'off' | 'strong' | 'hard' } }（未設定=ふつう）
    // grade_block は旧形式 state.gradeBlockByTeacher も後方互換で読む。
    function teacherCondValueOf(state, condId, tid) {
        const maps = (state && state.teacherCondWeights) || {};
        let v = (maps[condId] || {})[tid];
        if (v == null && condId === 'grade_block') {
            v = ((state && state.gradeBlockByTeacher) || {})[tid];
        }
        return v;
    }
    function teacherCondWeightOf(state, condId, tid) {
        const v = teacherCondValueOf(state, condId, tid);
        if (v === 'off') return 0;
        if (v === 'strong' || v === 'hard') return 3;
        return 1;
    }
    // 教員単位の「絶対に」: 条件全体は「できれば」のままでも、この先生に限っては配置段階で守る
    function teacherCondHardOf(state, condId, tid) {
        return teacherCondValueOf(state, condId, tid) === 'hard';
    }
    function gradeBlockWeightOf(state, tid) { return teacherCondWeightOf(state, 'grade_block', tid); }

    const TEACHER_WEEK_CONDITIONS = new Set([
        'teacher_gap', 'no_gap_zero_day', 'part_time_gap', 'part_time_days'
    ]);
    function isTeacherWeekCondition(id) {
        return TEACHER_WEEK_CONDITIONS.has(id) || id.startsWith('part:');
    }
    function dailyGap(periods) {
        if (periods.length <= 1) return 0;
        const s = periods.slice().sort((a, b) => a - b);
        return (s[s.length - 1] - s[0] + 1) - s.length;
    }

    // 教員×週×曜日の実授業時限を、配置済みの一意な授業から1走査で構築する。
    function buildTeacherWeekDays(state, sol, opts) {
        opts = opts || {};
        const labels = weekLabels(state);
        const tDaySets = {};
        labels.forEach(w => { tDaySets[w] = {}; });
        const add = (w, tid, day, period) => {
            if (!tid || !tDaySets[w]) return;
            const byDay = tDaySets[w][tid] = tDaySets[w][tid] || {};
            (byDay[day] = byDay[day] || new Set()).add(period);
        };
        // solve() から渡された事前位相を正本にする。単体利用時だけ従来ロジックへフォールバックする。
        const phases = labels.length > 1 ? (opts.onbiPhases || assignOnbiPhases(sol)) : {};
        // 修復済みのA週の実盤面（buildAWeekResult の cells）。
        // repair/free モードではA週修復がコマを動かすため、ベース週から机上で
        // A週を再構成すると実際と食い違う（修復で直した dayMin 違反が「まだある」
        // ように見える等）。実盤面が渡されたら、A週はそこから直接数える（2026-07-28）。
        const aCells = labels.length > 1 ? (opts.aCells || null) : null;
        const addBase = (w, tid, day, period) => {
            if (aCells && w === 'A') return;   // A週は後段で実盤面から登録する
            add(w, tid, day, period);
        };
        const seen = new Set();
        let hasOnbi = false;
        Object.keys(sol.occCls || {}).forEach(cid => {
            Object.keys(sol.occCls[cid]).forEach(key => {
                const l = sol.occCls[cid][key];
                const uniqueKey = l.id + '@' + key;
                if (seen.has(uniqueKey)) return;
                seen.add(uniqueKey);
                const day = key.split('-')[0];
                const period = Number(key.split('-')[1]);

                if (labels.length <= 1) {
                    (l.teachers || []).forEach(tid => add(labels[0], tid, day, period));
                    return;
                }
                if (l.subject === '音美') {
                    hasOnbi = true;
                    const asg = (l.biTeachers || []).filter(Boolean);  // [音楽担当, 美術担当]
                    const ph = phases[l.id] != null ? phases[l.id] : 0;
                    if (l.aHomeroom) {
                        // exact はベース週で全週分を予約する従来の意味論、repair/free は実施するA週だけ。
                        const homeWeeks = abModeOf(state) === 'exact' ? labels : labels.filter(w => w === 'A');
                        homeWeeks.forEach(w => addBase(w, l.aHomeroom, day, period));
                    }
                    const bWeeks = labels.filter(w => w !== 'A');
                    bWeeks.forEach((w, i) => {
                        // B1/B2 を位相どおり交互に割り当てる（2週構成の B も先頭側として扱う）
                        add(w, asg[i % 2 === 0 ? ph : 1 - ph], day, period);
                    });
                    return;
                }

                // 技家は年間のどの週にどちらを担当するか不定なので、安全側で全担当を全週に登録する。
                // 通常授業も同じ担当を全週に登録する。
                const tids = BIWEEKLY_PAIRS[l.subject]
                    ? (l.biTeachers || l.teachers || [])
                    : (l.teachers || []);
                labels.forEach(w => tids.forEach(tid => addBase(w, tid, day, period)));
            });
        });

        // A週の実盤面からの登録（修復で動いたコマも正しく反映される）
        if (aCells) {
            const seenA = new Set();
            Object.keys(aCells).forEach(ck => {
                const cell = aCells[ck];
                const seg = ck.split('|');
                const day = seg[1], period = Number(seg[2]);
                const uk = (cell.lessonId || ck) + '@' + day + '-' + period;
                if (seenA.has(uk)) return;
                seenA.add(uk);
                (cell.teacherIds || []).forEach(tid => add('A', tid, day, period));
            });
        }

        // 学年所属教員の変動枠拘束は、内容にかかわらず全週で「授業あり」とみなす。
        if (opts.varDutyTids && opts.varSlotKey) {
            const seg = opts.varSlotKey.split('-');
            const day = seg[0], period = Number(seg[1]);
            opts.varDutyTids.forEach(tid => {
                labels.forEach(w => add(w, tid, day, period));
            });
        }

        const tDayW = {};
        labels.forEach(w => {
            tDayW[w] = {};
            Object.keys(tDaySets[w]).forEach(tid => {
                tDayW[w][tid] = {};
                Object.keys(tDaySets[w][tid]).forEach(day => {
                    tDayW[w][tid][day] = [...tDaySets[w][tid][day]];
                });
            });
        });
        return { labels, tDayW, hasOnbi };
    }

    // 教員系条件の判定をソフト評価と hardSummary で共用する。
    function evaluateTeacherWeekConditions(state, sol, teacherById, conditionIds, collect, opts) {
        const wanted = new Set((conditionIds || []).filter(isTeacherWeekCondition));
        const counters = {};
        const details = {};
        if (!wanted.size) return { counters, details };

        const built = buildTeacherWeekDays(state, sol, opts);
        // 音美がなければ週ごとの教員予定は同一なので1回だけ評価し、従来の数値を保つ。
        const labels = built.hasOnbi ? built.labels : built.labels.slice(0, 1);
        const multiWeek = labels.length > 1;
        const gapLimitRaw = Number(state.soft && state.soft.gapMax);
        const gapLimit = isNaN(gapLimitRaw) ? 1 : gapLimitRaw;
        const tName = tid => (teacherById[tid] && teacherById[tid].name) || '担当未定';
        const weekPrefix = w => multiWeek ? w + '週 ' : '';
        const add = (id, n, detail) => {
            counters[id] = (counters[id] || 0) + n;
            if (collect && detail && n > 0) {
                (details[id] = details[id] || []).push(detail);
            }
        };

        const partKindsByTid = {};
        wanted.forEach(id => {
            if (!id.startsWith('part:')) return;
            const seg = id.split(':');
            (partKindsByTid[seg[1]] = partKindsByTid[seg[1]] || []).push({
                id,
                kind: seg[2]
            });
        });
        const tids = new Set();
        labels.forEach(w => {
            Object.keys(built.tDayW[w] || {}).forEach(tid => tids.add(tid));
        });

        tids.forEach(tid => {
            const t = teacherById[tid];
            const isPart = t && t.type === 'part';
            const dayCounts = [];

            labels.forEach(w => {
                const tDay = (built.tDayW[w] && built.tDayW[w][tid]) || {};
                const days = Object.keys(tDay);
                const wp = weekPrefix(w);

                // 空きコマの平準化・空きゼロの日は常勤のみ対象。
                if (!isPart && wanted.has('teacher_gap')) {
                    const tgw = teacherCondWeightOf(state, 'teacher_gap', tid);
                    const gaps = days.map(d => dailyGap(tDay[d]));
                    if (tgw && gaps.length > 1) {
                        const v = (Math.max(...gaps) - Math.min(...gaps)) * tgw;
                        add('teacher_gap', v, collect && v > 0 &&
                            tName(tid) + ': ' + wp + '空きコマが日によって偏り（' +
                            days.map((d, i) => DAY_JP[d] + gaps[i]).join('・') + '）' +
                            (tgw > 1 ? '（特に重視 ×' + tgw + '）' : ''));
                    }
                }
                if (!isPart && wanted.has('no_gap_zero_day')) {
                    const ngw = teacherCondWeightOf(state, 'no_gap_zero_day', tid);
                    if (ngw) days.forEach(d => {
                        const max = Number(state.skeleton.periods[d]) || 0;
                        if (tDay[d].length >= max && max > 0) {
                            add('no_gap_zero_day', ngw, collect &&
                                tName(tid) + ': ' + wp + DAY_JP[d] + '曜が空きコマゼロ' +
                                (ngw > 1 ? '（特に重視 ×' + ngw + '）' : ''));
                        }
                    });
                }
                if (isPart && wanted.has('part_time_gap')) {
                    days.forEach(d => {
                        const gaps = dailyGap(tDay[d]);
                        const v = Math.max(0, gaps - gapLimit);
                        add('part_time_gap', v, collect && v > 0 &&
                            tName(tid) + ': ' + wp + DAY_JP[d] + '曜の空きが' + gaps +
                            'コマ（上限' + gapLimit + '）');
                    });
                }
                if (isPart && wanted.has('part_time_days')) {
                    dayCounts.push({ w, n: days.length });
                }

                (partKindsByTid[tid] || []).forEach(({ id, kind }) => {
                    const pc = t ? partConfOf(t) : null;
                    if (!pc) return;
                    const label = (t && t.name) || '非常勤';
                    if (kind === 'amOnly' && pc.amOnly) {
                        let v = 0;
                        const list = [];
                        days.forEach(d => {
                            tDay[d].forEach(per => {
                                if (per >= 5) {
                                    v++;
                                    list.push(DAY_JP[d] + per + '限');
                                }
                            });
                        });
                        add(id, v, collect && v > 0 &&
                            label + ': ' + wp + '午後に' + v + 'コマ（' + list.join('・') + '）');
                    } else if (kind === 'prepWeek' && pc.prepWeek != null) {
                        let gaps = 0;
                        days.forEach(d => {
                            gaps += dailyGap(tDay[d]);
                        });
                        const v = Math.max(0, gaps - pc.prepWeek);
                        const gapLabel = multiWeek ? w + '週の空きが' : '週の空きが';
                        add(id, v, collect && v > 0 &&
                            label + ': ' + gapLabel + gaps + 'コマ（準備の時間 ' +
                            pc.prepWeek + ' を ' + v + ' 超過）');
                    } else if (kind === 'dayMin' && pc.dayMin > 1) {
                        const bad = days.filter(d =>
                            tDay[d].length > 0 && tDay[d].length < pc.dayMin
                        );
                        add(id, bad.length, collect && bad.length > 0 &&
                            label + ': ' + wp +
                            bad.map(d => DAY_JP[d] + '曜が' + tDay[d].length + 'コマ').join('・') +
                            '（最低 ' + pc.dayMin + ' コマの希望）');
                    } else if (kind === 'dayMax' && pc.dayMax > 0) {
                        let v = 0;
                        const list = [];
                        days.forEach(d => {
                            const over = tDay[d].length - pc.dayMax;
                            if (over > 0) {
                                v += over;
                                list.push(DAY_JP[d] + '曜' + tDay[d].length + 'コマ');
                            }
                        });
                        add(id, v, collect && v > 0 &&
                            label + ': ' + wp + list.join('・') +
                            '（最高 ' + pc.dayMax + ' コマの希望）');
                    }
                });
            });

            // 出講日は各週の合計ではなく、その教員の週別最大日数を違反数にする。
            if (isPart && wanted.has('part_time_days') && dayCounts.length) {
                const maxDays = Math.max(...dayCounts.map(x => x.n));
                const maxWeek = dayCounts.find(x => x.n === maxDays);
                add('part_time_days', maxDays, collect && maxDays > 0 &&
                    tName(tid) + ': ' + weekPrefix(maxWeek.w) + '出講' + maxDays + '日');
            }
        });
        return { counters, details };
    }

    /* ---------- ソフト制約の評価 ----------
       sol: { occCls, occTeacher } を受け取り、選択された条件ごとの
       違反数と重み付き合計を返す。重み = 優先順位が上ほど大 */
    function evaluateSoft(state, slots, sol, teacherById, collect, opts) {
        // 「絶対」に格上げされた条件はハード制約側で守られるため、ソフト評価から外す
        // collect=true のときは違反の内訳（誰が・どこで）も文字列で集める（最良案の表示用。
        // 探索中は毎試行呼ばれるため collect なしで数値のみ数える）
        opts = opts || {};
        const prio = prioritiesOf(state);
        const selected = prio.order.filter(id => !prio.hard.has(id));
        if (!selected.length) return { total: 0, breakdown: [] };
        const weightOf = id => selected.length - selected.indexOf(id);
        const tName = tid => (teacherById[tid] && teacherById[tid].name) || '担当未定';
        const clsName = l => l.classIds.map(c => c.startsWith('sc:') ? '支援' : c).join('・');

        // 一意な授業（合同は1回だけ数える）
        const seen = new Set();
        const placedLessons = [];  // {lesson, day, period}
        Object.keys(sol.occCls).forEach(cid => {
            Object.keys(sol.occCls[cid]).forEach(key => {
                const l = sol.occCls[cid][key];
                const id = l.id + '@' + key;
                if (seen.has(id)) return;
                seen.add(id);
                placedLessons.push({ lesson: l, day: key.split('-')[0], period: Number(key.split('-')[1]) });
            });
        });

        const counters = {};
        const details = {};
        const add = (id, n, detail) => {
            counters[id] = (counters[id] || 0) + n;
            if (collect && detail && n > 0) (details[id] = details[id] || []).push(detail);
        };

        // 体育の同時刻重なり（体育館・グラウンドの取り合い・合同の詰まり回避）
        if (selected.includes('pe_overlap')) {
            const peBySlot = {};
            placedLessons.forEach(({ lesson, day, period }) => {
                if (lesson.subject !== '保健体育') return;
                const k = day + '-' + period;
                (peBySlot[k] = peBySlot[k] || []).push(lesson);
            });
            Object.keys(peBySlot).forEach(k => {
                const n = peBySlot[k].length;
                if (n > 1) {
                    const [d, per] = k.split('-');
                    add('pe_overlap', n - 1, collect &&
                        DAY_JP[d] + per + '限に保健体育が' + n + '件（' +
                        peBySlot[k].map(l => l.classIds.join('・')).join(' と ') + '）');
                }
            });
        }

        placedLessons.forEach(({ lesson, day, period }) => {
            if (selected.includes('pe_am') && lesson.subject === '保健体育' && period >= 5) {
                add('pe_am', 1, collect && clsName(lesson) + ': 保健体育が' + DAY_JP[day] + period + '限（午後）');
            }
            if (selected.includes('no_hard_monday1') && day === 'mon' && period === 1 && MAIN_SUBJECTS.includes(lesson.subject)) {
                add('no_hard_monday1', 1, collect && clsName(lesson) + ': 月曜1限に' + lesson.subject);
            }
            if (selected.includes('week1_safe') && lesson.weeklyHours === 1 && !lesson.fixedSlot &&
                (day === 'mon' || period === (Number(state.skeleton.periods[day]) || 0))) {
                add('week1_safe', 1, collect && clsName(lesson) + ': 週1コマの' + lesson.subject + 'が' + DAY_JP[day] + period + '限');
            }
        });

        // 同じ学年をなるべく連続に: 教員ごとに1日の授業の学年並びを見て、
        // 「学年のかたまり数 − 学年の種類数」を違反として数える（例: 1年→2年→1年 = 1違反）
        if (selected.includes('grade_block')) {
            const tGrade = {};  // tid -> day -> { period: 学年（支援学級は 'S'） }
            placedLessons.forEach(({ lesson, day, period }) => {
                lesson.teachers.forEach(tid => {
                    ((tGrade[tid] = tGrade[tid] || {})[day] = tGrade[tid][day] || {})[period] =
                        (lesson.grade != null ? lesson.grade : 'S');
                });
            });
            Object.keys(tGrade).forEach(tid => {
                const gbw = gradeBlockWeightOf(state, tid);
                if (!gbw) return;   // この先生は「不要」設定 → 数えない
                Object.keys(tGrade[tid]).forEach(d => {
                    const seq = Object.keys(tGrade[tid][d]).map(Number).sort((a, b) => a - b).map(p => tGrade[tid][d][p]);
                    let runs = 0, prev = null;
                    const kinds = new Set();
                    seq.forEach(g2 => { if (g2 !== prev) { runs++; prev = g2; } kinds.add(g2); });
                    const v = Math.max(0, runs - kinds.size) * gbw;
                    add('grade_block', v, collect && v > 0 &&
                        tName(tid) + ': ' + DAY_JP[d] + '曜の学年並びが ' + seq.map(g2 => g2 === 'S' ? '支' : g2).join('→') + ' と行き来' +
                        (gbw > 1
                            ? (teacherCondHardOf(state, 'grade_block', tid) ? '（絶対に ×' + gbw + '）' : '（特に重視 ×' + gbw + '）')
                            : ''));
                });
            });
        }

        // 同じ教科が午後（5・6限）に固まらない: 教科ごとに「午後コマ数 − 午前コマ数」の超過分を違反に
        if (selected.includes('subject_pm')) {
            Object.keys(sol.occCls).forEach(cid => {
                if (cid.startsWith('sc:')) return;
                const cnt = {};
                Object.keys(sol.occCls[cid]).forEach(key => {
                    const cell = sol.occCls[cid][key];
                    if (cell.fixedSlot) return;  // 固定コマ（学活・道徳・総合など）は動かせないため対象外
                    const s = cell.subject;
                    const p = Number(key.split('-')[1]);
                    cnt[s] = cnt[s] || { am: 0, pm: 0 };
                    if (p >= 5) cnt[s].pm++; else cnt[s].am++;
                });
                Object.keys(cnt).forEach(s => {
                    const c = cnt[s];
                    const v = Math.max(0, c.pm - c.am);
                    // 午前≧午後はOK。超過1〜2は表示レベル、超過3以上（例: 午前0午後3）は強い違反として重み付け
                    const weighted = v + (v >= 3 ? (v - 2) * 2 : 0);
                    add('subject_pm', weighted, collect && v > 0 &&
                        (v >= 3 ? '【要修正】' : '') + cid + ': ' + s + 'が午後に' + c.pm + 'コマ・午前' + c.am + 'コマ（午後が' + v + 'コマ超過）');
                });
            });
        }

        if (selected.includes('subject_spread') || selected.includes('no_special_seq') || selected.includes('am_pm_balance')) {
            Object.keys(sol.occCls).forEach(cid => {
                const grid = sol.occCls[cid];
                // 縦並び（同じ時限に同じ教科が複数曜日）
                if (selected.includes('subject_spread')) {
                    const byPeriod = {};
                    Object.keys(grid).forEach(key => {
                        const p = key.split('-')[1];
                        const s = grid[key].subject;
                        const k = s + '|' + p;
                        byPeriod[k] = (byPeriod[k] || 0) + 1;
                    });
                    Object.keys(byPeriod).forEach(k => {
                        const n = byPeriod[k];
                        if (n > 1) {
                            const [s, p] = k.split('|');
                            add('subject_spread', n - 1, collect &&
                                (cid.startsWith('sc:') ? '支援' : cid) + ': ' + s + 'が' + p + '限に' + n + 'コマ（縦並び）');
                        }
                    });
                }
                // 特別教室教科の連続
                if (selected.includes('no_special_seq')) {
                    DAYS.forEach(d => {
                        const max = Number(state.skeleton.periods[d]) || 0;
                        for (let p = 1; p + 2 <= max; p++) {
                            const a = grid[sKey(d, p)], b = grid[sKey(d, p + 1)], c3 = grid[sKey(d, p + 2)];
                            if (a && b && c3 && a.roomLimited && b.roomLimited && c3.roomLimited) {
                                add('no_special_seq', 1, collect &&
                                    (cid.startsWith('sc:') ? '支援' : cid) + ': ' + DAY_JP[d] + p + '〜' + (p + 2) + '限が ' +
                                    a.subject + '→' + b.subject + '→' + c3.subject + '（移動教室が3連続）');
                            }
                        }
                    });
                }
                // 主要教科の午前・午後バランス:
                // 週のコマ枠に占める午後（5限以降）の割合を目安に、教科ごとの午後コマ数が
                // 目安から外れた分（両方向）を違反として数える
                if (selected.includes('am_pm_balance') && !cid.startsWith('sc:')) {
                    let pmSlots = 0, allSlots = 0;
                    DAYS.forEach(d => {
                        const m = Number(state.skeleton.periods[d]) || 0;
                        allSlots += m;
                        pmSlots += Math.max(0, m - 4);
                    });
                    const pmRatio = allSlots ? pmSlots / allSlots : 0;
                    const cnt = {};
                    Object.keys(grid).forEach(key => {
                        const s = grid[key].subject;
                        if (!MAIN_SUBJECTS.includes(s)) return;
                        const p = Number(key.split('-')[1]);
                        cnt[s] = cnt[s] || { total: 0, pm: 0 };
                        cnt[s].total++;
                        if (p >= 5) cnt[s].pm++;
                    });
                    Object.keys(cnt).forEach(s => {
                        const c = cnt[s];
                        const ideal = Math.round(c.total * pmRatio);
                        const v = Math.abs(c.pm - ideal);
                        add('am_pm_balance', v, collect && v > 0 &&
                            cid + ': ' + s + 'の午後が' + c.pm + 'コマ（目安' + ideal + 'コマ）');
                    });
                }
            });
        }

        const teacherEval = evaluateTeacherWeekConditions(
            state, sol, teacherById, selected.filter(isTeacherWeekCondition), collect, opts
        );
        Object.keys(teacherEval.counters).forEach(id => {
            counters[id] = (counters[id] || 0) + teacherEval.counters[id];
        });
        if (collect) {
            Object.keys(teacherEval.details).forEach(id => {
                (details[id] = details[id] || []).push(...teacherEval.details[id]);
            });
        }

        // 自立活動の同期: 全支援学級の自立が同時刻に揃っていない分
        if (selected.includes('jiritsu_sync')) {
            const slotsByClass = [];
            Object.keys(sol.occCls).filter(c => c.startsWith('sc:')).forEach(c => {
                const s = new Set();
                Object.keys(sol.occCls[c]).forEach(key => { if (sol.occCls[c][key].subject === '自立活動') s.add(key); });
                if (s.size) slotsByClass.push(s);
            });
            if (slotsByClass.length > 1) {
                const union = new Set(); slotsByClass.forEach(s => s.forEach(x => union.add(x)));
                const maxOne = Math.max(...slotsByClass.map(s => s.size));
                const v = union.size - maxOne;
                add('jiritsu_sync', v, collect && v > 0 && '支援学級の自立活動が' + union.size + '通りの時刻に分かれています');
            }
        }

        const breakdown = selected.map(id => ({ id, violations: counters[id] || 0, weight: weightOf(id),
                                                details: collect ? (details[id] || []) : undefined }));
        const total = breakdown.reduce((a, b) => a + b.violations * b.weight, 0);
        return { total, breakdown };
    }

    /* ---------- ソルバ本体 ---------- */

    async function solve(state, opts) {
        opts = opts || {};
        state = stateWithIgnored(state, opts.ignoredIds);   // 無視リストの条件を外して組む（未指定なら素通し）
        // 既定3分・システム上限20分（ユーザー指定はUI側の「探索時間の上限」から渡る）
        const budgetMs = Math.min(opts.timeBudgetMs || 180000, 1200000);
        let maxAttempts = Math.min(opts.maxAttempts || 100000, 800000);
        // この solve 呼び出し全体の締切。終盤パス（詰将棋）は1コマ最大 endgameMs（既定20秒）を
        // 未配置コマ数ぶん繰り返すため、放っておくとユーザーが選んだ「探索時間の上限」を
        // 何倍も超え、その間ブラウザが止まり続ける。attempt からこの締切を見て頭打ちにする。
        const solveDeadline = Date.now() + budgetMs;
        const originalBaseSeed = opts.seed != null ? opts.seed : (Date.now() & 0x7fffffff);
        let baseSeed = originalBaseSeed;
        const STAGNATION_LIMIT = opts.stagnationAttempts || 4000;
        const MIN_ROUND_MS = 60000;

        const report = { errors: [], warnings: [], varSlotIssues: [], suggestions: [] };

        // 入力を破壊しないようにクローンし、Step 4 の「B週・変動枠込み」入力を内部用の固定分へ変換する
        // （変動枠に毎週同じ実教科が入る学年は、その教科を1コマ差し引く。例: 2・3年の総合2→固定1＋変動1）
        state = JSON.parse(JSON.stringify(state));
        const convNotes = [];  // 生成プロセスの説明用
        [1, 2, 3].forEach(g => {
            const cv = constantVarSubject(state, g);
            if (!cv) return;
            const raw = Number((state.hours[g] || {})[cv]) || 0;
            if (raw < 1) {
                report.warnings.push(g + '年: 変動枠に毎週「' + cv + '」が入りますが、Step 4 の「' + cv + '」が0です。変動枠込みの週コマ数（例: 総合2）を入力してください。');
            } else {
                state.hours[g][cv] = raw - 1;
                convNotes.push(g + '年の' + cv + raw + 'コマ → 固定' + (raw - 1) + '＋変動枠1');
            }
        });

        const cids = classIdsOf(state);
        if (!cids.length) {
            report.errors.push('クラスがありません（Step 1）。');
            return failResult(report, baseSeed);
        }

        // 配置可能なコマ（変動枠を除く）
        const hasVar = state.skeleton.cycleWeeks > 1;
        const weekList = hasVar ? weekLabels(state) : [];
        const bWeekLabels = weekList.filter(w => w !== 'A');
        const vs = state.skeleton.varSlot;
        // 変動枠の位置が骨格の範囲内か（範囲外なら週別チェック・ボード書き出しの前提が崩れる）
        const varSlotValid = !hasVar ||
            (DAYS.includes(vs.day) && Number(vs.period) >= 1 && Number(vs.period) <= (Number(state.skeleton.periods[vs.day]) || 0));
        if (hasVar && !varSlotValid) {
            report.errors.push('変動枠（' + (DAY_JP[vs.day] || vs.day) + vs.period + '限）が週の骨格の範囲外です。Step 1 で位置を直してください。');
        }
        const slots = [];
        const slotSet = new Set();
        DAYS.forEach(day => {
            const max = Number(state.skeleton.periods[day]) || 0;
            for (let p = 1; p <= max; p++) {
                if (hasVar && day === vs.day && p === Number(vs.period)) continue;
                slots.push({ day, period: p, key: sKey(day, p) });
                slotSet.add(sKey(day, p));
            }
        });

        // 教室キャパ: 教科 → 同時に置けるクラス数（教室なし = Infinity）
        const roomCap = {};
        (state.rooms || []).forEach(r => {
            if (!r.subject || !r.name) return;
            roomCap[r.subject] = (roomCap[r.subject] || 0) + (Number(r.count) || 0) * (Number(r.capacity) || 1);
        });
        const capOf = s => (roomCap[s] != null ? roomCap[s] : Infinity);
        const isRoomLimited = subject => roomComponents(subject).some(c => capOf(c) !== Infinity);

        // 教員情報
        const teacherById = {};
        state.teachers.forEach(t => { teacherById[t.id] = t; });
        const naOf = {};
        state.teachers.forEach(t => { naOf[t.id] = new Set(t.na || []); });
        // 非常勤の個別条件: 絶対扱い（partConfById・slotValidで強制）と
        // できれば扱い（partSoftById・評価とスコア誘導）に分けて後段で構築する
        const partConfById = {};
        const partSoftById = {};

        const pePairs = validatePePairs(state, cids, report);
        // 学年職員の教科の計画（同学年で教員が重複しない・支援教科を避ける）
        const staffPlan = gradeStaffPlan(state);
        Object.keys(staffPlan).forEach(cid => {
            const p = staffPlan[cid];
            if (p && p.avoid) {
                report.warnings.push(cid + ': 学年職員の教科に「' + p.subject + '」を使いますが、この学級を交流学級とする支援生徒が支援で受ける教科のため、支援の授業を重ねられる時間が減ります（Step 5 の担当か Step 6 の設定の見直しを推奨）。');
            }
        });
        const absorbInfo = [];   // 学年職員の授業の充当: [{cid, subject, count}]
        const lessons = buildLessons(state, pePairs, report, absorbInfo, staffPlan);
        lessons.forEach(l => { l.roomLimited = isRoomLimited(l.subject); });

        // 「前回の続きから」: opts.lockedCells で渡された配置を固定コマとして扱い、
        // 残りだけを探索する。既存の固定コマ（学活・道徳・総合）と同じ仕組みに乗せるので
        // 制約チェック（教員の重なり・同日重複・支援同期・教室）はそのまま効く。
        //   lockedCells: { 'cid|英語曜日|限': subject }  ※ result.cells をそのまま渡せる形
        if (opts.lockedCells && Object.keys(opts.lockedCells).length) {
            // 授業id で対応付ける。buildLessons は同じ state なら同じ順序で id を振るため、
            // 前回結果の cells[].lessonId がそのまま使える。
            // （教科名で照合すると、音美の週替わりや合同授業でずれる）
            const byLessonId = {};
            Object.keys(opts.lockedCells).forEach(k => {
                const cell = opts.lockedCells[k];
                if (!cell || !cell.lessonId) return;
                const [, day, period] = k.split('|');
                byLessonId[cell.lessonId] = { day, period: Number(period) };
            });
            let lockedCount = 0;
            lessons.forEach(l => {
                if (l.fixedSlot) return;                       // 元から固定のコマは触らない
                if (byLessonId[l.id]) {
                    l.fixedSlot = byLessonId[l.id];
                    lockedCount++;
                }
            });
            if (lockedCount) {
                report.warnings.push('前回の配置 ' + lockedCount + ' コマを固定したまま、残りだけを組み直しました。');
            }
        }

        // 「手直しモード」（📌ここに入れたい／🔒これは確定／あとは詰将棋）:
        //   opts.editSeed = {
        //     placements: result.cells,            // 前回の全配置（初期位置。動かしてよい）
        //     pins:      [{lessonId, day, period}], // 📌 指定位置に固定
        //     lockedIds: [lessonId, ...]            // 🔒 現在位置に固定
        //   }
        // ピンとロックだけを固定コマ化し、残りは初期位置に据え置く。
        // ピンに押し出されて置けなくなったコマは、詰将棋（連鎖）で最小限の玉突きをして逃がす。
        // ピン・ロックは固定コマ（fixedSlot）にはしない。固定コマは配置の最初に
        // 検証されるため、支援授業や同僚のコマがまだ盤面に無い段階で
        // 「支援同期が合わない」「準備時間を超える」等と誤って弾かれてしまう。
        // 代わりに種まきフェーズで優先配置し（多パスの再試行が順序依存を解く）、
        // 置けた後は editImmovable として押しのけ・修復の対象から外す。
        let editSeedPos = null;
        let editPinIds = new Set();
        let editImmovable = new Set();
        let editBanned = null;   // lessonId -> 'day-period'（unseatで外したコマの立入禁止席）
        let editTeacherBan = null;   // tid -> Set('day-period')（この先生をこの時刻で空ける）
        if (opts.editSeed) {
            const es = opts.editSeed;
            editSeedPos = {};   // lessonId -> {day, period}
            Object.keys(es.placements || {}).forEach(k => {
                const cell = es.placements[k];
                if (!cell || !cell.lessonId) return;
                const seg = k.split('|');
                editSeedPos[cell.lessonId] = { day: seg[1], period: Number(seg[2]) };
            });
            (es.pins || []).forEach(pin => {
                if (!pin || !pin.lessonId) return;
                editSeedPos[pin.lessonId] = { day: pin.day, period: Number(pin.period) };
                editPinIds.add(pin.lessonId);
                editImmovable.add(pin.lessonId);
            });
            (es.lockedIds || []).forEach(id => editImmovable.add(id));
            // unseat: 指定コマを初期位置から外す（行き先はソルバ任せ＝深い詰将棋で再配置）。
            // banDay/banPeriod を指定すると「元の席（や特定の席）には戻らない」制約になる。
            // 「この先生をこの時刻から外したいが、代わりの席は任せる」型の手直しに使う
            (es.unseat || []).forEach(u => {
                const id = typeof u === 'string' ? u : u.lessonId;
                delete editSeedPos[id];
                if (u && u.banDay != null) {
                    (editBanned = editBanned || new Map()).set(id, u.banDay + '-' + u.banPeriod);
                }
            });
            // banTeacherSlots: 「この先生をこの時刻で空ける」。その先生の全授業がその席に
            // 置けなくなるため、元居た授業は種まきに失敗して深い詰将棋で別の席へ移り、
            // 玉突きの連鎖が同じ先生の別の授業をそこへ入れることも防げる
            (es.banTeacherSlots || []).forEach(b => {
                if (!b || !b.tid) return;
                editTeacherBan = editTeacherBan || new Map();
                if (!editTeacherBan.has(b.tid)) editTeacherBan.set(b.tid, new Set());
                editTeacherBan.get(b.tid).add(b.day + '-' + b.period);
            });
            report.warnings.push('手直しモード: 指定 ' + editPinIds.size + ' コマ・ロック ' +
                (editImmovable.size - editPinIds.size) +
                ' コマを動かさずに、残りは前回の位置を保ったまま必要な分だけ調整しました。');
        }

        // 音美の位相は配置前に固定する。学年ごとに学級番号順で 0,1,0,1... と交互にし、
        // 探索中・完成評価・表示のすべてが同じ lessonId -> phase を参照する。
        const onbiPhases = {};
        const onbiByGrade = {};
        lessons.filter(l => l.subject === '音美').forEach(l => {
            const cid = l.classIds[0] || '';
            const g = gradeOf(cid);
            (onbiByGrade[g] = onbiByGrade[g] || []).push(l);
        });
        Object.keys(onbiByGrade).forEach(g => {
            onbiByGrade[g].sort((a, b) => {
                const ca = Number((a.classIds[0] || '').split('-')[1]) || 0;
                const cb = Number((b.classIds[0] || '').split('-')[1]) || 0;
                return ca - cb || Number(a.id.slice(1)) - Number(b.id.slice(1));
            });
            onbiByGrade[g].forEach((l, i) => { onbiPhases[l.id] = i % 2; });
        });
        const absorbMap = {};    // cid -> 充当された学年職員の教科
        absorbInfo.forEach(a => { absorbMap[a.cid] = a.subject; });
        if (absorbInfo.length) {
            report.warnings.push('学年職員の授業の充当: ' + absorbInfo.map(a => a.cid + '=' + a.subject).join('、') +
                '（各学級の学年職員の教科をベース週から1コマ差し引き、音美のA週・変動枠の担任授業として実施します）');
        }
        const fixedNormal = lessons.filter(l => l.fixedSlot && !l.support);
        const fixedSupport = lessons.filter(l => l.fixedSlot && l.support);
        const freeNormal = lessons.filter(l => !l.fixedSlot && !l.support);
        const freeSupport = lessons.filter(l => !l.fixedSlot && l.support);

        // 変動枠を「使わない」学年は、変動枠の時間も通常コマとして使える
        const varSlotObj = (hasVar && varSlotValid)
            ? { day: vs.day, period: Number(vs.period), key: sKey(vs.day, Number(vs.period)) }
            : null;
        const gradeVar = { 1: gradeUsesVar(state, 1), 2: gradeUsesVar(state, 2), 3: gradeUsesVar(state, 3) };
        const slotsPlusVar = varSlotObj ? slots.concat([varSlotObj]) : slots;
        // 授業ごとの候補コマ（支援学級は変動枠を使わない＝除外のまま）
        function lessonSlots(l) {
            if (!varSlotObj || l.support) return slots;
            const usesVar = l.classIds.some(c => gradeVar[gradeOf(c)]);
            return usesVar ? slots : slotsPlusVar;
        }
        const classCapacity = cid => slots.length + ((varSlotObj && !gradeVar[gradeOf(cid)]) ? 1 : 0);
        const varDutyTids = varSlotObj ? varDutyTeacherIds(state, staffPlan) : new Set();
        const excludedVarDutyTeachers = varSlotObj
            ? state.teachers.filter(t => {
                const gg = gradeGroupOfT(t);
                return (gg === '1' || gg === '2' || gg === '3') && (t.na || []).includes(varSlotObj.key);
            })
            : [];
        if (excludedVarDutyTeachers.length) {
            const names = excludedVarDutyTeachers.map(t => t.name || '教員').join('・');
            const grades = [...new Set(excludedVarDutyTeachers.map(t => gradeGroupOfT(t)))];
            report.warnings.push(
                names + 'は学年所属（' + grades.map(g => g + '年').join('・') + '）ですが、' +
                '変動枠の時間は出講不可のため、学年の活動には参加しない前提で組みました。'
            );
        }
        const teacherEvalOpts = {
            varDutyTids,
            varSlotKey: varSlotObj ? varSlotObj.key : null,
            onbiPhases
        };

        // 学級固有の同日衝突。音美のA週・変動枠のいずれかで学年職員の教科を
        // 実施する学級では、充当教科を回転枠と同じ曜日に置かない。
        const classHasStaffVar = {};
        absorbInfo.forEach(info => {
            const g = gradeOf(info.cid);
            classHasStaffVar[info.cid] = !!(info.subject && varSlotObj && gradeVar[g] &&
                weekList.some(w =>
                    ((((state.varContent || {})[w]) || {})[g] || '学年職員の教科') === '学年職員の教科'));
        });
        const classDayConflictCache = {};
        function classDayConflictSubjects(cid, subject) {
            const ck = cid + '|' + subject;
            if (classDayConflictCache[ck]) return classDayConflictCache[ck];
            const out = dayConflictSubjects(subject).slice();
            const aSub = absorbMap[cid];
            if (aSub && subject === '音美' && !out.includes(aSub)) out.push(aSub);
            if (aSub && subject === aSub && !out.includes('音美')) out.push('音美');
            return (classDayConflictCache[ck] = out);
        }
        function classDayConflict(cid, s1, s2) {
            return classDayConflictSubjects(cid, s1).includes(s2) ||
                classDayConflictSubjects(cid, s2).includes(s1);
        }
        function classVarDayConflict(cid, subject, day) {
            return !!(classHasStaffVar[cid] && varSlotObj && day === varSlotObj.day &&
                subject === absorbMap[cid]);
        }

        // 事前チェック: クラスあたりのコマ数超過（体育ペア検証後なので消失なしで数えられる）
        cids.forEach(cid => {
            const n = lessons.filter(l => !l.support && l.classIds.includes(cid)).length;
            const capC = classCapacity(cid);
            if (n > capC) {
                report.errors.push(cid + ' の週コマ数合計（' + n + '）が配置可能なコマ数（' + capC + '）を超えています（Step 4）。超過分は未配置になります。');
            }
        });
        // 充当教科は1日1コマに加え、音美コマと「学年職員の教科」の変動枠の曜日も使えない。
        // 音美と変動枠を同じ曜日に寄せた最善ケースでも必要日数が足りない場合だけ事前警告する。
        absorbInfo.forEach(info => {
            if (!info.subject) return;
            const g = gradeOf(info.cid);
            const usableDays = DAYS.filter(day =>
                slots.some(s => s.day === day) ||
                (varSlotObj && !gradeVar[g] && varSlotObj.day === day));
            const need = lessons.filter(l => !l.support && l.classIds.includes(info.cid) &&
                l.subject === info.subject).length;
            const onbiDays = lessons.filter(l => !l.support && l.classIds.includes(info.cid) &&
                l.subject === '音美').length;
            const varConsumesDay = classHasStaffVar[info.cid] && usableDays.includes(varSlotObj.day);
            const forbiddenDays = onbiDays + ((varConsumesDay && onbiDays === 0) ? 1 : 0);
            const placeableDays = Math.max(0, usableDays.length - forbiddenDays);
            if (need > placeableDays) {
                report.warnings.push(info.cid + ': 学年職員の教科「' + info.subject +
                    '」は音美コマ・変動枠と同じ曜日に置けないため、置ける曜日が ' +
                    placeableDays + ' 日しかありません（必要 ' + need + ' 日）。');
            }
        });
        // 事前チェック: 固定コマの位置不正（範囲外・変動枠との重複）は毎試行同じ結果なので先にエラー化する
        const fixedErrSeen = new Set();
        lessons.filter(l => l.fixedSlot).forEach(l => {
            const day = l.fixedSlot.day;
            const period = Number(l.fixedSlot.period);
            let msg = null;
            if (!DAYS.includes(day) || period < 1 || period > (Number(state.skeleton.periods[day]) || 0)) {
                msg = '固定コマ「' + l.subject + '」（' + (DAY_JP[day] || day) + period + '限）が週の骨格の範囲外です（Step 1・2）。';
            } else if (hasVar && day === vs.day && period === Number(vs.period) &&
                       (l.support || l.classIds.some(c => gradeVar[gradeOf(c)]))) {
                msg = '固定コマ「' + l.subject + '」が変動枠（' + DAY_JP[day] + period + '限）と同じ位置です（Step 2）。';
            }
            if (msg && !fixedErrSeen.has(msg)) { fixedErrSeen.add(msg); report.errors.push(msg); }
        });
        // 明白な解なし・入力不正があるときは探索を短縮する
        if (report.errors.length) maxAttempts = Math.min(maxAttempts, 200);

        const noTeacherLessons = lessons.filter(l => !l.teachers.length);
        if (noTeacherLessons.length) {
            report.warnings.push('担当未定のまま配置する授業が ' + noTeacherLessons.length + ' コマあります（Step 5）。教員の重複チェックが効かないため、担当を決めてから組み直すことを推奨します。');
        }

        // 現場流の配置順のための教員メタ: 複数の学年にまたがる教員 → 持ちコマの多い教員 を先に置く
        const tGradeSpan = {};   // tid -> 担当する学年の種類数
        const tLoadAll = {};     // tid -> 担当コマ数
        {
            const spanSets = {};
            lessons.forEach(l => l.teachers.forEach(tid => {
                tLoadAll[tid] = (tLoadAll[tid] || 0) + 1;
                (spanSets[tid] = spanSets[tid] || new Set()).add(l.grade != null ? l.grade : 'S');
            }));
            Object.keys(spanSets).forEach(tid => { tGradeSpan[tid] = spanSets[tid].size; });
        }

        // 統一優先順位リスト: hard = 絶対（slotValidで強制）、softOrder = できれば（優先順・辞書順評価）
        const prio = prioritiesOf(state);
        const hardSet = prio.hard;
        const softOrder = prio.order.filter(id => !hardSet.has(id));
        const selectedSoft = new Set(softOrder);
        const softWeight = id => (softOrder.includes(id) ? softOrder.length - softOrder.indexOf(id) : 0);
        const gapMaxRaw = Number(state.soft && state.soft.gapMax);
        const gapLimit = isNaN(gapMaxRaw) ? 1 : gapMaxRaw;

        // 非常勤の個別条件を「絶対」と「できれば」に振り分ける
        state.teachers.forEach(t => {
            const c = partConfOf(t);
            if (!c) return;
            const hd = id => hardSet.has('part:' + t.id + ':' + id);
            const hardC = {
                amOnly: c.amOnly && hd('amOnly'),
                prepWeek: (c.prepWeek != null && hd('prepWeek')) ? c.prepWeek : null,
                dayMin: (c.dayMin > 1 && hd('dayMin')) ? c.dayMin : 0,
                dayMax: (c.dayMax > 0 && hd('dayMax')) ? c.dayMax : 0
            };
            if (hardC.amOnly || hardC.prepWeek != null || hardC.dayMin > 1 || hardC.dayMax > 0) partConfById[t.id] = hardC;
            const softC = {
                amOnly: c.amOnly && !hardC.amOnly,
                prepWeek: (c.prepWeek != null && hardC.prepWeek == null) ? c.prepWeek : null,
                dayMin: (c.dayMin > 1 && !hardC.dayMin) ? c.dayMin : 0,
                dayMax: (c.dayMax > 0 && !hardC.dayMax) ? c.dayMax : 0
            };
            if (softC.amOnly || softC.prepWeek != null || softC.dayMin > 1 || softC.dayMax > 0) partSoftById[t.id] = softC;
        });

        // A週とB週のズレ許容モード（Step 9）: exact=完全一致 / repair=少しずらす / free=バラバラ可
        const abMode = abModeOf(state);

        // 教員単位の需給チェック ＋ 空きが極端に少ない教員（タイト教員）の検出。
        // タイト教員（自由に置けるコマ − 置くべき授業 ≤ 3）の授業は、
        // 支援学級の許可教科制限が入る前に先へ確保する。
        // 「空きコマゼロの日を作らない」が絶対のときは日毎の実効容量も計算し、
        // 数学的に不可能な教員は最終手段としてその条件の適用対象から外す（noGapExempt）
        const tightTids = new Set();
        const noGapExempt = new Set();
        {
            // 全クラス共通で通常授業を置けないスロット（全クラス共通の固定コマ。変動枠は slots から除外済み）
            const blocked = new Set();
            if (state.fixed.same) {
                Object.values(state.fixed.items || {}).forEach(it => {
                    if (it && it.day && slotSet.has(sKey(it.day, Number(it.period)))) blocked.add(sKey(it.day, Number(it.period)));
                });
            }
            // 置くべき授業数: 固定コマを除く担当授業。技家・音美の逆位相ペアが組める担当は 0.5、
            // 音美コマの学年職員予約（aHomeroom・完全一致モードのみ）は丸ごと 1 スロット分
            const tLoad = {};
            lessons.forEach(l => {
                if (l.fixedSlot) return;
                l.teachers.forEach(tid => {
                    const half = l.pairKey && l.biTeachers && l.biTeachers.includes(tid);
                    tLoad[tid] = (tLoad[tid] || 0) + (half ? 0.5 : 1);
                });
            });
            // 固定コマの担当数（日別）: 空きゼロ禁止の実効容量計算で「その日すでに埋まっているコマ」になる
            const fixedByDay = {};
            lessons.forEach(l => {
                if (!l.fixedSlot) return;
                l.teachers.forEach(tid => {
                    const m = fixedByDay[tid] = fixedByDay[tid] || {};
                    m[l.fixedSlot.day] = (m[l.fixedSlot.day] || 0) + 1;
                });
            });
            const noGapHard = hardSet.has('no_gap_zero_day');
            const fmtLoad = x => (Math.round(x * 10) / 10);
            state.teachers.forEach(t => {
                const load = tLoad[t.id] || 0;
                if (!load) return;
                const na = naOf[t.id];
                const pc = partConfById[t.id] || null;
                let rawAvail = 0;
                const usableByDay = {};
                slots.forEach(s => {
                    if (blocked.has(s.key) || na.has(s.key)) return;
                    if (pc && pc.amOnly && s.period >= 5) return;  // 午前のみ（給食なしで帰る）
                    rawAvail++;
                    usableByDay[s.day] = (usableByDay[s.day] || 0) + 1;
                });
                // 非常勤の1日の最高コマ数も容量に反映
                if (pc && pc.dayMax > 0) {
                    rawAvail = 0;
                    DAYS.forEach(d => {
                        usableByDay[d] = Math.min(usableByDay[d] || 0, pc.dayMax);
                        rawAvail += usableByDay[d];
                    });
                }
                // 空きゼロ禁止（絶対）の実効容量: 日毎に min(置ける数, その日のコマ数 − 1 − 固定/変動枠の占有)。
                // 非常勤は対象外（空きは「準備の時間」の個別条件で管理）
                let effCap = rawAvail;
                if (noGapHard && t.type !== 'part' && teacherCondWeightOf(state, 'no_gap_zero_day', t.id) > 0) {
                    effCap = 0;
                    DAYS.forEach(d => {
                        const P = Number(state.skeleton.periods[d]) || 0;
                        const usable = usableByDay[d] || 0;
                        let occ = (fixedByDay[t.id] && fixedByDay[t.id][d]) || 0;
                        if (varSlotObj && varSlotObj.day === d && varDutyTids.has(t.id)) occ += 1;
                        effCap += Math.min(usable, Math.max(0, P - 1 - occ));
                    });
                }
                const hasOnbiReserve = lessons.some(l => !l.fixedSlot && l.aHomeroom === t.id && l.teachers.includes(t.id));
                if (load > rawAvail + 1e-9) {
                    report.warnings.push('⚠ ' + t.name + ': 置くべき授業が週 ' + fmtLoad(load) +
                        ' コマ分ありますが、置けるコマは ' + rawAvail + ' しかありません' +
                        '（全体のコマ数から、出られない時間・固定コマ・変動枠を除いた数' +
                        (pc ? '。非常勤の個別条件（午前のみ・1日の最高コマ数）も織り込んでいます' : '') +
                        (hasOnbiReserve ? '。音美コマのA週予約も授業1コマ分として数えています' : '') + '）。' +
                        'このままでは必ず未配置か重なりが出ます。');
                    report.suggestions.push(t.name + ' の担当を週 ' + Math.ceil(load - rawAvail) +
                        ' コマ分ほかの教員へ移すか、出られない時間を減らすと解ける可能性があります。' +
                        (pc ? t.name + ' の非常勤の個別条件（Step 5a）を緩めるのも有効です。' : '') +
                        (hasOnbiReserve ? '音美コマのA週予約（1コマ分）は、「A週とB週のズレ」を「少しずらしてもよい」にすると不要になります（Step 9）。' : ''));
                } else if (noGapHard && load >= effCap - 1e-9) {
                    // 空きゼロ禁止（絶対）で余裕がなくなる教員 → 最終手段としてこの教員のみ適用除外して生成する。
                    // 以前は「不足したときだけ（load > effCap）」だったが、**ちょうど同数＝余裕ゼロ**の場合も
                    // 素通りしていた。余裕ゼロは「置ける枠を1つ残らず埋める」以外に解が無い状態で、
                    // 他学級の都合と少しでもぶつかれば破綻する（実データの森がこれで1コマ入らなかった）。
                    // 設計方針「上限に引っかかる先生は1日空きゼロでも仕方ない。どうしても入らないなら
                    // 空きコマゼロは諦めてよい」に従い、余裕ゼロの時点で適用除外する（2026-07-28）。
                    noGapExempt.add(t.id);
                    const short = load - effCap;
                    report.warnings.push('⚠ ' + t.name + ': 「教員の授業のない日・空きコマゼロの日を作らない」を絶対にすると、' +
                        '置けるコマが ' + effCap + ' に減り（通常 ' + rawAvail + '）、置くべき週 ' + fmtLoad(load) + ' コマ分に対して' +
                        (short > 1e-9 ? ' ' + fmtLoad(short) + ' コマ足りません。' : '余裕がまったくありません（置ける枠を1つ残らず埋めないと成立しません）。') +
                        '【最終手段】この教員に限りこの条件を適用せずに生成しました。結果では空きコマゼロの日ができることがあります。');
                    report.suggestions.push('「空きコマゼロの日を作らない」の絶対指定は ' + t.name + ' にはコマ数の兼ね合いで守れません。' +
                        '守りたい場合は、担当を週 ' + Math.max(1, Math.ceil(short + 1)) + ' コマ分減らす・出られない時間を減らす' +
                        (hasOnbiReserve ? '・「A週とB週のズレ」を「少しずらしてもよい」にする（Step 9）' : '') + '、のいずれかが必要です。');
                }
                const capForTight = (noGapHard && !noGapExempt.has(t.id)) ? effCap : rawAvail;
                if (capForTight - load <= 3) tightTids.add(t.id);
            });
        }

        // 生徒ごとの「支援で受ける教科」セット
        const supportSetOf = st => new Set(
            Object.keys(st.subjects || {}).filter(s => st.subjects[s] === 'support')
        );
        // 交流学級 -> その学級を交流先とする支援生徒（支援同期チェック用）
        const supStudentsByClass = {};
        (state.support.students || []).forEach(st => {
            if (!st.supportClassId || !st.exchangeClass) return;
            (supStudentsByClass[st.exchangeClass] = supStudentsByClass[st.exchangeClass] || []).push(st);
        });

        // 生徒ごとの実現可能性チェック
        (state.support.students || []).forEach(st => {
            const E = st.exchangeClass;
            const label = st.label || '生徒';
            if (!st.supportClassId) return;
            if (!E || !cids.includes(E)) {
                report.warnings.push(label + ' の交流学級が未設定です（Step 6）。交流条件のチェックなしで配置します。');
                return;
            }
            const need = freeSupport.filter(l => l.attendees && l.attendees.includes(st)).length;
            const gE = gradeOf(E);
            const sSet = supportSetOf(st);
            let supply = 0;
            sSet.forEach(s => { supply += Number((state.hours[gE] || {})[s]) || 0; });
            // 学年職員の教科の充当でその教科が減る場合は供給からも差し引く
            const abE = absorbInfo.find(a => a.cid === E);
            if (abE && sSet.has(abE.subject)) supply -= abE.count;
            const normalCount = lessons.filter(l => !l.support && l.classIds.includes(E)).length;
            const slack = Math.max(0, classCapacity(E) - normalCount);
            if (need > supply + slack) {
                report.warnings.push(label + '（交流 ' + E + '）: 支援・自立の授業が週 ' + need + ' コマ必要ですが、' +
                    E + ' 側で重ねられるのは「支援で受ける教科」週 ' + supply + ' コマ＋空き ' + slack + ' コマです。' +
                    '超過分は未配置になります。自立活動の充当教科を増やす（Step 6）か、支援の週コマ数・交流の設定を見直してください（Step 5c・6）。');
            }
        });

        function lessonName(l) {
            const cls = l.classIds.map(c => c.startsWith('sc:') ? supportName(c) : c).join('・');
            return cls + ' ' + l.subject;
        }
        function supportName(key) {
            const sc = (state.support.classes || []).find(x => 'sc:' + x.id === key);
            return sc ? (sc.name || '支援学級') : key;
        }

        // 週別担当は全試行で不変なのでキャッシュし、週別化による候補判定の負荷を抑える。
        const weeklyTidsCache = {};
        const candidateTidsCache = {};
        const hardPartTidsCache = {};
        const teacherWeeksCache = {};
        // repair/free の aHomeroom はA週だけの占有。該当教員だけ週別の第2段判定を行う。
        const weekLimitedTids = new Set();
        if (hasVar && abMode !== 'exact') {
            lessons.forEach(l => { if (l.subject === '音美' && l.aHomeroom) weekLimitedTids.add(l.aHomeroom); });
        }

        /* ----- 1回の試行 -----
           終盤パス（詰将棋）でUIに制御を返すため async。await するのは終盤だけなので、
           配置本体（placeLesson 系）は同期のままで、試行回数への影響はほぼない。
           onEndgame は「終盤の詰将棋 3/8 コマ」を進捗表示へ流すコールバック（省略可） */
        async function attempt(rng, boostIds, supportFirst, onEndgame) {
            const occCls = {};      // cid -> { slotKey -> lesson }
            const occTeacher = {};  // tid -> Set(slotKey)（全週の和集合。衝突判定用）
            // 週別ハード判定用の占有は「全週共通＋週差分」の2層にする。
            // 通常授業を A/B1/B2 の3セットへ毎回書く負荷を避け、音美だけ週差分へ書く。
            // 性能計測: state4 seed22・60秒の attempts を適用前後で比較する（ここでは未実行）。
            const occTCommon = hasVar ? {} : null;  // tid -> Set(slotKey)
            const occT3 = hasVar ? {} : null;       // week -> tid -> Set(slotKey)（週差分のみ）
            if (occT3) weekList.forEach(w => { occT3[w] = {}; });
            const roomUse = {};     // 構成教科 -> { slotKey -> クラス数 }
            const dayCount = {};    // cid|subject|day -> n
            const restrict = {};    // 交流学級 cid -> { slotKey -> Set(許可教科) } 空Set = 空きコマ必須
            const stuSlots = {};    // 支援生徒 st.id -> Set(slotKey) 生徒が支援学級で授業を受けている時刻
            const unplaced = [];
            const relaxedLessons = [];  // 同日重複を許して置いた授業（後で入れ替え修復を試みる）
            // 生成プロセスの説明用の統計
            const stats = {
                fixed: 0, onbiFirst: 0, support: 0, restrictCells: 0,
                normal: 0, relaxedBefore: 0, dupFixed: 0, pushFixed: 0,
                boosted: !!boostIds, ejections: 0
            };

            lessons.forEach(l => l.classIds.forEach(c => { occCls[c] = occCls[c] || {}; }));
            cids.forEach(c => { occCls[c] = occCls[c] || {}; });

            // lesson が週 w に実際に占有する教員。音美だけ事前位相でB週の担当を分ける。
            // 技家は年間位相が未確定なので全担当を全週に置く安全側の近似を維持する。
            function weeklyTidsOf(l, w, complement) {
                const ck = l.id + '|' + String(w) + '|' + (complement ? '1' : '0');
                if (weeklyTidsCache[ck]) return weeklyTidsCache[ck];
                const out = new Set();
                const save = () => (weeklyTidsCache[ck] = [...out]);
                if (!occT3) {
                    (l.teachers || []).forEach(tid => {
                        if (complement && l.biTeachers && l.biTeachers.includes(tid)) return;
                        out.add(tid);
                    });
                    return save();
                }
                if (l.subject === '音美') {
                    const ph = onbiPhases[l.id] != null ? onbiPhases[l.id] : 0;
                    if (w !== 'A') {
                        const i = Math.max(0, bWeekLabels.indexOf(w));
                        const asg = (l.biTeachers || []).filter(Boolean);
                        const tid = asg[i % 2 === 0 ? ph : 1 - ph];
                        if (tid) out.add(tid);
                    }
                    if (l.aHomeroom && (abMode === 'exact' || w === 'A')) out.add(l.aHomeroom);
                    return save();
                }
                (l.teachers || []).forEach(tid => {
                    if (complement && BIWEEKLY_PAIRS[l.subject] &&
                        l.biTeachers && l.biTeachers.includes(tid)) return;
                    out.add(tid);
                });
                return save();
            }
            function candidateTidsOf(l, complement) {
                const ck = l.id + '|' + (complement ? '1' : '0');
                if (candidateTidsCache[ck]) return candidateTidsCache[ck];
                if (!occT3) return (candidateTidsCache[ck] = weeklyTidsOf(l, null, complement));
                const out = new Set();
                weekList.forEach(w => weeklyTidsOf(l, w, complement).forEach(tid => out.add(tid)));
                return (candidateTidsCache[ck] = [...out]);
            }
            // 絶対指定の非常勤条件がない授業は、slotValid の個別条件判定を即座に抜ける。
            function hardPartTidsOf(l, complement) {
                const ck = l.id + '|' + (complement ? '1' : '0');
                if (hardPartTidsCache[ck]) return hardPartTidsCache[ck];
                return (hardPartTidsCache[ck] =
                    candidateTidsOf(l, complement).filter(tid => !!partConfById[tid]));
            }
            function teacherWeeksFor(l, tid, complement) {
                const ck = l.id + '|' + tid + '|' + (complement ? '1' : '0');
                if (teacherWeeksCache[ck]) return teacherWeeksCache[ck];
                if (!occT3) {
                    return (teacherWeeksCache[ck] =
                        weeklyTidsOf(l, null, complement).includes(tid) ? [null] : []);
                }
                return (teacherWeeksCache[ck] =
                    weekList.filter(w => weeklyTidsOf(l, w, complement).includes(tid)));
            }
            // ホットパスの参照は Set を合成せず、共通→週差分の順に直接調べる。
            function teacherOccHas(tid, w, key) {
                if (!occT3) return !!(occTeacher[tid] && occTeacher[tid].has(key));
                return !!((occTCommon[tid] && occTCommon[tid].has(key)) ||
                    (occT3[w] && occT3[w][tid] && occT3[w][tid].has(key)));
            }
            // 配置後修復だけが使う列挙用ヘルパ。共通と週差分の重複は除く。
            function teacherOccKeys(tid, w) {
                if (!occT3) return occTeacher[tid] ? [...occTeacher[tid]] : [];
                const common = occTCommon[tid];
                const weekly = occT3[w] && occT3[w][tid];
                if (!common || !common.size) return weekly ? [...weekly] : [];
                if (!weekly || !weekly.size) return [...common];
                const out = [...common];
                weekly.forEach(key => { if (!common.has(key)) out.push(key); });
                return out;
            }

            // 隔週交代教科の同時刻ペア。音美は pairKey 一致に加えて逆位相だけを相方と認める。
            function pairLessonsAt(l, key) {
                if (!l.pairKey) return [];
                const out = [], seen = new Set();
                for (const c of Object.keys(occCls)) {
                    if (l.classIds.includes(c)) continue;
                    const other = occCls[c][key];
                    if (!other || other.id === l.id || other.pairKey !== l.pairKey || seen.has(other.id)) continue;
                    seen.add(other.id);
                    out.push(other);
                }
                return out;
            }
            function isValidPairMate(l, other) {
                if (!other || !l.pairKey || other.pairKey !== l.pairKey) return false;
                if (l.subject !== '音美' && other.subject !== '音美') return true;
                return l.subject === '音美' && other.subject === '音美' &&
                    onbiPhases[l.id] != null && onbiPhases[other.id] != null &&
                    onbiPhases[l.id] !== onbiPhases[other.id];
            }
            function pairMates(l, key) {
                return pairLessonsAt(l, key).filter(other => isValidPairMate(l, other)).length;
            }
            function hasInvalidPairMate(l, key) {
                return pairLessonsAt(l, key).some(other => !isValidPairMate(l, other));
            }

            // 連鎖の巻き戻し用の移動ログ（詳細は ejRewind の定義箇所を参照）。
            // doPlace より前に宣言しておく必要がある。
            let ejLog = null;

            function doPlace(l, slot) {
                const key = slot.key;
                if (ejLog) ejLog.push({ op: 'place', l, key });
                // 逆位相ペアの2クラス目: ペア担当の教員・教室は1クラス目が確保済みなので追加しない
                const complement = !!l.pairKey && pairMates(l, key) >= 1;
                l.classIds.forEach(c => { occCls[c][key] = l; });
                l.teachers.forEach(tid => {
                    if (complement && l.biTeachers && l.biTeachers.includes(tid)) return;
                    (occTeacher[tid] = occTeacher[tid] || new Set()).add(key);
                });
                if (occT3) {
                    if (l.subject === '音美') {
                        weekList.forEach(w => {
                            weeklyTidsOf(l, w, complement).forEach(tid => {
                                (occT3[w][tid] = occT3[w][tid] || new Set()).add(key);
                            });
                        });
                    } else {
                        // 音美以外は担当が全週共通。1セットだけ更新する。
                        weeklyTidsOf(l, weekList[0], complement).forEach(tid => {
                            (occTCommon[tid] = occTCommon[tid] || new Set()).add(key);
                        });
                    }
                }
                if (!complement) roomComponents(l.subject).forEach(comp => {
                    if (capOf(comp) === Infinity) return;
                    roomUse[comp] = roomUse[comp] || {};
                    roomUse[comp][key] = (roomUse[comp][key] || 0) + l.classIds.length;
                });
                l.classIds.forEach(c => {
                    const k = c + '|' + l.subject + '|' + slot.day;
                    dayCount[k] = (dayCount[k] || 0) + 1;
                });
                // 支援学級の授業: 出席生徒の交流学級に許可教科の制限を課す
                if (l.support && l.attendees) {
                    l.attendees.forEach(st => {
                        // 生徒が支援で授業を受けている時刻を記録（交流学級の支援教科の同期チェック用）
                        (stuSlots[st.id] = stuSlots[st.id] || new Set()).add(key);
                        const E = st.exchangeClass;
                        if (!E || !occCls[E] || occCls[E][key]) return;  // 既に授業確定なら制限不要
                        const mySet = supportSetOf(st);
                        restrict[E] = restrict[E] || {};
                        const cur = restrict[E][key];
                        // 空集合になっても保存する（= 交流学級はそのコマを空きにする必要がある）
                        restrict[E][key] = cur ? new Set([...cur].filter(x => mySet.has(x))) : mySet;
                    });
                }
            }

            /* allowFixedDayDup: 固定コマは同日重複を許す（総合の連続2コマ等） */
            function slotValid(l, slot, mode, reasons) {
                // mode: 'strict' | 'relaxed'(同日重複を許す) | 'fixed'(同日重複を許す・固定用)
                const key = slot.key;
                // 手直しの unseat で「この席には戻らない」指定があるコマ
                if (editBanned && editBanned.get(l.id) === key) {
                    if (reasons) reasons.classBusy++;
                    return false;
                }
                // 手直しの「この先生をこの時刻で空ける」指定
                if (editTeacherBan) {
                    for (const tid of l.teachers) {
                        const bs = editTeacherBan.get(tid);
                        if (bs && bs.has(key)) {
                            if (reasons) reasons.teacherBusy++;
                            return false;
                        }
                    }
                }
                for (const c of l.classIds) {
                    if (occCls[c][key]) { if (reasons) reasons.classBusy++; return false; }
                }
                // 技家は pairKey 一致、音美は pairKey 一致かつ逆位相の2クラスだけ同時刻可。
                if (l.pairKey && hasInvalidPairMate(l, key)) { if (reasons) reasons.room++; return false; }
                const mates = pairMates(l, key);
                if (l.pairKey && mates >= 2) { if (reasons) reasons.room++; return false; }
                const complement = !!l.pairKey && mates === 1;
                for (const tid of l.teachers) {
                    if (complement && l.biTeachers && l.biTeachers.includes(tid)) continue;  // ペア担当は1クラス目が確保済み
                    if (naOf[tid] && naOf[tid].has(key)) { if (reasons) reasons.teacherNA++; return false; }
                    if (occTeacher[tid] && occTeacher[tid].has(key)) { if (reasons) reasons.teacherBusy++; return false; }
                }
                // 音美コマのA週はこの席が充当教員（学年職員）の授業になる。教員の重なりはA週修復で
                // 解決できるが、出講不可（na）は本人が学校にいないため修復では解決できない。
                // ズレ許容モードでは teachers に充当教員が入らないので、ここでモード不問の禁止をかける
                if (l.aHomeroom && naOf[l.aHomeroom] && naOf[l.aHomeroom].has(key)) {
                    if (reasons) reasons.teacherNA++;
                    return false;
                }
                // 高速な和集合判定を通った後、A週限定の aHomeroom が関係する教員だけ
                // 実担当週どうしの占有を照合する。候補が音美側でも通常授業側でも対称に効く。
                if (occT3) {
                    for (const tid of candidateTidsOf(l, complement)) {
                        if (!weekLimitedTids.has(tid)) continue;
                        if (teacherWeeksFor(l, tid, complement).some(w => teacherOccHas(tid, w, key))) {
                            if (reasons) reasons.teacherBusy++;
                            return false;
                        }
                    }
                }
                if (!complement) for (const comp of roomComponents(l.subject)) {
                    const cap = capOf(comp);
                    if (cap === Infinity) continue;
                    const used = (roomUse[comp] && roomUse[comp][key]) || 0;
                    if (used + l.classIds.length > cap) { if (reasons) reasons.room++; return false; }
                }
                if (mode === 'strict') {
                    for (const c of l.classIds) {
                        if (classDayConflictSubjects(c, l.subject).some(s =>
                            (dayCount[c + '|' + s + '|' + slot.day] || 0) >= 1) ||
                            classVarDayConflict(c, l.subject, slot.day)) {
                            if (reasons) reasons.dayDup++;
                            return false;
                        }
                    }
                }
                // 通常学級: 支援学級の授業が課した許可教科の制限を守る
                if (!l.support) {
                    for (const c of l.classIds) {
                        const r = restrict[c] && restrict[c][key];
                        if (r && !r.has(l.subject)) { if (reasons) reasons.restrict++; return false; }
                        // 支援同期（双方向）: この学級を交流先とする生徒が「支援で受ける教科」は、
                        // その生徒が支援学級で授業を受けている時刻にしか置けない
                        // （置いてしまうと、生徒はその教科を交流でも支援でも受けられなくなる）
                        const stus = supStudentsByClass[c];
                        if (stus) for (const st of stus) {
                            if (st.subjects && st.subjects[l.subject] === 'support' &&
                                !(stuSlots[st.id] && stuSlots[st.id].has(key))) {
                                if (reasons) reasons.syncCond++;
                                return false;
                            }
                        }
                    }
                }
                // 支援学級: 交流条件
                if (l.support && l.attendees) {
                    for (const st of l.attendees) {
                        const E = st.exchangeClass;
                        if (!E || !occCls[E]) continue;
                        const other = occCls[E][key];
                        if (other && st.subjects && st.subjects[other.subject] === 'exchange') {
                            if (reasons) reasons.exchange++;
                            return false;
                        }
                        // 未確定コマへの制限は空集合でも許可（= 交流学級を空きにする解を残す）
                    }
                }
                // 非常勤の個別条件（Step 5a・絶対条件）を、実際に担当する各週で判定する。
                for (const tid of hardPartTidsOf(l, complement)) {
                    const pc = partConfById[tid];
                    if (!pc) continue;
                    if (pc.amOnly && slot.period >= 5) { if (reasons) reasons.partCond++; return false; }
                    if (pc.dayMax > 0 && teacherWeeksFor(l, tid, complement).some(w =>
                        dayCountAfter(tid, slot, w) > pc.dayMax)) {
                        if (reasons) reasons.partCond++;
                        return false;
                    }
                    if (pc.prepWeek != null && partWeekGapsAfter(l, tid, slot, complement) > pc.prepWeek) {
                        if (reasons) reasons.partCond++;
                        return false;
                    }
                }
                // 「絶対」に格上げされた条件（Step 8）
                if (hardSet.size && violatesHard(l, slot, key, complement)) {
                    if (reasons) reasons.hardCond++;
                    return false;
                }
                return true;
            }

            function dayCountAfter(tid, slot, w) {
                const max = Number(state.skeleton.periods[slot.day]) || 0;
                let n = 1;
                for (let p = 1; p <= max; p++) {
                    if (p !== slot.period && teacherOccHas(tid, w, sKey(slot.day, p))) n++;
                }
                return n;
            }
            function worksOnDay(tid, day, w) {
                const max = Number(state.skeleton.periods[day]) || 0;
                for (let p = 1; p <= max; p++) {
                    if (teacherOccHas(tid, w, sKey(day, p))) return true;
                }
                return false;
            }
            // slot を追加した後の週の空き合計。候補を担当する週のうち最悪値を返す。
            function partWeekGapsAfter(l, tid, slot, complement) {
                const vals = teacherWeeksFor(l, tid, complement).map(w => {
                    let total = 0;
                    for (const d of DAYS) {
                        const max = Number(state.skeleton.periods[d]) || 0;
                        let first = -1, last = -1, count = 0;
                        for (let p = 1; p <= max; p++) {
                            const occ = (slot.day === d && slot.period === p) ||
                                teacherOccHas(tid, w, sKey(d, p));
                            if (occ) { if (first < 0) first = p; last = p; count++; }
                        }
                        if (count > 1) total += (last - first + 1) - count;
                    }
                    return total;
                });
                return vals.length ? Math.max(...vals) : 0;
            }
            // slot を追加した後の当日の空き。候補を担当する週のうち最悪値を返す。
            function partGapAfter(l, tid, slot, complement) {
                const vals = teacherWeeksFor(l, tid, complement).map(w => {
                    const periods = [];
                    const max = Number(state.skeleton.periods[slot.day]) || 0;
                    for (let p = 1; p <= max; p++) {
                        if (p === slot.period || teacherOccHas(tid, w, sKey(slot.day, p))) periods.push(p);
                    }
                    if (periods.length <= 1) return 0;
                    return (periods[periods.length - 1] - periods[0] + 1) - periods.length;
                });
                return vals.length ? Math.max(...vals) : 0;
            }

            // 「絶対」に格上げされた条件のハード判定
            function violatesHard(l, slot, key, complement) {
                if (hardSet.has('pe_am') && l.subject === '保健体育' && slot.period >= 5) return true;
                if (hardSet.has('pe_overlap') && l.subject === '保健体育') {
                    // 同時刻に別の体育の授業があれば置かない
                    for (const c of Object.keys(occCls)) {
                        const o = occCls[c][key];
                        if (o && o.subject === '保健体育' && o.id !== l.id) return true;
                    }
                }
                if (hardSet.has('no_hard_monday1') && slot.day === 'mon' && slot.period === 1 && MAIN_SUBJECTS.includes(l.subject)) return true;
                if (hardSet.has('week1_safe') && !l.support && l.weeklyHours === 1 &&
                    (slot.day === 'mon' || slot.period === (Number(state.skeleton.periods[slot.day]) || 0))) return true;
                if (hardSet.has('subject_spread') && !l.support) {
                    // 同じ教科を同じ時限に2回置かない（縦並び禁止）
                    for (const c of l.classIds) {
                        for (const d of DAYS) {
                            if (d === slot.day) continue;
                            const o = occCls[c][sKey(d, slot.period)];
                            if (o && o.subject === l.subject) return true;
                        }
                    }
                }
                if (hardSet.has('subject_pm') && slot.period >= 5 && !l.support) {
                    for (const c of l.classIds) {
                        for (const k2 of Object.keys(occCls[c])) {
                            if (Number(k2.split('-')[1]) >= 5 && occCls[c][k2].subject === l.subject) return true;
                        }
                    }
                }
                if (hardSet.has('no_special_seq') && l.roomLimited) {
                    // この配置で移動教室が3連続になるならNG
                    const dayMax = Number(state.skeleton.periods[slot.day]) || 0;
                    for (const c of l.classIds) {
                        for (let s0 = slot.period - 2; s0 <= slot.period; s0++) {
                            if (s0 < 1 || s0 + 2 > dayMax) continue;
                            let all = true;
                            for (let pp = s0; pp < s0 + 3; pp++) {
                                if (pp === slot.period) continue;
                                const o = occCls[c][sKey(slot.day, pp)];
                                if (!o || !o.roomLimited) { all = false; break; }
                            }
                            if (all) return true;
                        }
                    }
                }
                if (hardSet.has('part_time_gap')) {
                    for (const tid of candidateTidsOf(l, complement)) {
                        const t = teacherById[tid];
                        if (t && t.type === 'part' && partGapAfter(l, tid, slot, complement) > gapLimit) return true;
                    }
                }
                if (!l.support && l.grade != null) {
                    // 「同じ学年を連続に」の絶対扱い:
                    //   条件全体を「絶対」に格上げした場合は（「不要」以外の）全員、
                    //   そうでなくても Step 8 で「絶対に」を選んだ先生は個別に、配置段階で守る。
                    // 判定は「できれば」評価と同じ物差し＝行き来（学年のかたまり数 − 種類数）が
                    // この配置で増えるなら置けない。空きコマ挟みや単純な学年の切り替わりは許す
                    // （以前の「隣が別学年なら常に不可」は 1→1→2→2 まで弾く過剰制約だった）。
                    const gbAll = hardSet.has('grade_block');
                    for (const tid of l.teachers) {
                        const gbHard = gbAll ? gradeBlockWeightOf(state, tid) > 0
                                             : teacherCondHardOf(state, 'grade_block', tid);
                        if (!gbHard) continue;
                        // この先生のこの日の学年列（時限順・空きはスキップ）を作る
                        const gradeAt = {};
                        const maxP = Number(state.skeleton.periods[slot.day]) || 0;
                        for (let pp = 1; pp <= maxP; pp++) {
                            const k2 = sKey(slot.day, pp);
                            if (!(occTeacher[tid] && occTeacher[tid].has(k2))) continue;
                            for (const c of Object.keys(occCls)) {
                                const cell = occCls[c][k2];
                                if (cell && cell.teachers && cell.teachers.includes(tid)) {
                                    gradeAt[pp] = (cell.grade != null ? cell.grade : 'S');
                                    break;
                                }
                            }
                        }
                        const runsMinusKinds = seq => {
                            let runs = 0, prev = null;
                            const kinds = new Set();
                            seq.forEach(g2 => { if (g2 !== prev) { runs++; prev = g2; } kinds.add(g2); });
                            return runs - kinds.size;
                        };
                        const before = runsMinusKinds(Object.keys(gradeAt).map(Number).sort((a, b) => a - b).map(p => gradeAt[p]));
                        gradeAt[slot.period] = l.grade;
                        const after = runsMinusKinds(Object.keys(gradeAt).map(Number).sort((a, b) => a - b).map(p => gradeAt[p]));
                        if (after > before) return true;
                    }
                }
                if (hardSet.has('no_gap_zero_day')) {
                    for (const tid of candidateTidsOf(l, complement)) {
                        if (noGapExempt.has(tid)) continue;  // 最終手段の適用除外（需給チェックで検出済み）
                        if (!teacherCondWeightOf(state, 'no_gap_zero_day', tid)) continue;  // 「不要」の先生は対象外
                        const tt = teacherById[tid];
                        if (tt && tt.type === 'part') continue;  // 非常勤は対象外（個別条件で管理）
                        const max = Number(state.skeleton.periods[slot.day]) || 0;
                        if (max > 0 && teacherWeeksFor(l, tid, complement).some(w =>
                            dayCountAfter(tid, slot, w) >= max)) return true;
                    }
                }
                if (hardSet.has('jiritsu_sync') && l.subject === '自立活動') {
                    // 他の支援学級に自立活動が既に置かれているなら、同時刻にしか置けない
                    let anyOther = false, sameHere = false;
                    for (const c of Object.keys(occCls)) {
                        if (!c.startsWith('sc:') || l.classIds.includes(c)) continue;
                        for (const k2 of Object.keys(occCls[c])) {
                            if (occCls[c][k2].subject === '自立活動') {
                                anyOther = true;
                                if (k2 === key) sameHere = true;
                            }
                        }
                    }
                    if (anyOther && !sameHere) return true;
                }
                return false;
            }

            function score(l, slot) {
                let p = rng() * 0.01;
                // 隔週交代教科（音美・技家）: 同じ担当ペアの相方クラスと同時刻に重ねると
                // B1/B2週で担当が互い違いになり、非常勤の週間コマ数が自動で均等になる → 優先
                if (l.pairKey && pairMates(l, slot.key) === 1) p -= 6;
                // 交流制限コマは許可教科で優先的に埋める
                if (!l.support) {
                    l.classIds.forEach(c => {
                        const r = restrict[c] && restrict[c][slot.key];
                        if (r && r.has(l.subject)) p -= 10;
                    });
                    // 学年職員の教科の充当がある学級: 回転枠（変動枠・音美コマ）と同じ曜日に
                    // 学年職員の教科を置くと、その週に同日2コマ化するため避ける
                    const aSub = absorbMap[l.classIds[0]];
                    if (aSub) {
                        if (l.subject === aSub) {
                            if (varSlotObj && slot.day === varSlotObj.day) p += 3.5;
                            for (const k of Object.keys(occCls[l.classIds[0]])) {
                                if (k.split('-')[0] === slot.day && occCls[l.classIds[0]][k].subject === '音美') { p += 3.5; break; }
                            }
                        } else if (l.subject === '音美') {
                            for (const k of Object.keys(occCls[l.classIds[0]])) {
                                if (k.split('-')[0] === slot.day && occCls[l.classIds[0]][k].subject === aSub) { p += 3.5; break; }
                            }
                        }
                    }
                }
                if (l.support && l.attendees) {
                    // 交流学級ごとにまとめて評価（同じ学級の複数生徒は累積で交差を取る）。
                    // 実在しない交流学級ID（クラス数変更で消えた等）は無視する
                    const byE = {};
                    l.attendees.forEach(st => {
                        const E = st.exchangeClass;
                        if (E && occCls[E]) (byE[E] = byE[E] || []).push(st);
                    });
                    Object.keys(byE).forEach(E => {
                        // 制限が同じ曜日に偏らないよう分散
                        if (restrict[E]) {
                            let n = 0;
                            Object.keys(restrict[E]).forEach(k => { if (k.split('-')[0] === slot.day) n++; });
                            p += n * 1.5;
                        }
                        // この授業を置いた後の許可教科集合（既存の制限＋全出席生徒の累積交差）。
                        // 空になる = 交流学級をそのコマ空きにするしかない → ペナルティ
                        if (!occCls[E][slot.key]) {
                            let acc = (restrict[E] && restrict[E][slot.key]) ? new Set(restrict[E][slot.key]) : null;
                            byE[E].forEach(st => {
                                const mySet = supportSetOf(st);
                                acc = acc ? new Set([...acc].filter(x => mySet.has(x))) : mySet;
                            });
                            if (acc && acc.size === 0) p += 4;
                        }
                    });
                }
                const w = softWeight;
                if (selectedSoft.has('pe_overlap') && l.subject === '保健体育') {
                    let peN = 0;
                    for (const c of Object.keys(occCls)) {
                        const o = occCls[c][slot.key];
                        if (o && o.subject === '保健体育' && o.id !== l.id) peN++;
                    }
                    if (peN > 0) p += 2 * w('pe_overlap') * peN;
                }
                if (selectedSoft.has('pe_am') && l.subject === '保健体育' && slot.period >= 5) p += 2 * w('pe_am');
                if (selectedSoft.has('no_hard_monday1') && slot.day === 'mon' && slot.period === 1 && MAIN_SUBJECTS.includes(l.subject)) p += 2 * w('no_hard_monday1');
                if (selectedSoft.has('week1_safe') && l.weeklyHours === 1 &&
                    (slot.day === 'mon' || slot.period === (Number(state.skeleton.periods[slot.day]) || 0))) p += 1 * w('week1_safe');
                if (selectedSoft.has('am_pm_balance') && MAIN_SUBJECTS.includes(l.subject) && slot.period >= 5) p += 0.5 * w('am_pm_balance');
                if (selectedSoft.has('subject_pm') && slot.period >= 5) {
                    // すでに午後にある同教科の数だけペナルティ（同じ教科の午後への集中を避ける）
                    l.classIds.forEach(c => {
                        let pm = 0;
                        for (const k of Object.keys(occCls[c])) {
                            if (Number(k.split('-')[1]) >= 5 && occCls[c][k].subject === l.subject) pm++;
                        }
                        if (pm > 0) p += pm * 1.2 * w('subject_pm');
                    });
                }
                if (selectedSoft.has('subject_spread')) {
                    l.classIds.forEach(c => {
                        DAYS.forEach(d => {
                            if (d === slot.day) return;
                            const other = occCls[c][sKey(d, slot.period)];
                            if (other && other.subject === l.subject) p += 0.5 * w('subject_spread');
                        });
                    });
                }
                if (selectedSoft.has('no_special_seq') && l.roomLimited) {
                    // この配置で移動教室が3連続になる場合だけ避ける
                    const dayMax2 = Number(state.skeleton.periods[slot.day]) || 0;
                    l.classIds.forEach(c => {
                        for (let s0 = slot.period - 2; s0 <= slot.period; s0++) {
                            if (s0 < 1 || s0 + 2 > dayMax2) continue;
                            let all = true;
                            for (let pp = s0; pp < s0 + 3; pp++) {
                                if (pp === slot.period) continue;
                                const o = occCls[c][sKey(slot.day, pp)];
                                if (!o || !o.roomLimited) { all = false; break; }
                            }
                            if (all) { p += 2 * w('no_special_seq'); break; }
                        }
                    });
                }
                // 同じ学年をなるべく連続に: 隣の時限にこの教員の別学年の授業があると減点、同学年なら加点
                if (selectedSoft.has('grade_block') && !l.support && l.grade != null) {
                    for (const tid of l.teachers) {
                        const gbw = gradeBlockWeightOf(state, tid);
                        if (!gbw) continue;   // この先生は「不要」設定
                        for (const pp of [slot.period - 1, slot.period + 1]) {
                            const k2 = sKey(slot.day, pp);
                            if (!(occTeacher[tid] && occTeacher[tid].has(k2))) continue;
                            for (const c of Object.keys(occCls)) {
                                const cell = occCls[c][k2];
                                if (cell && cell.teachers && cell.teachers.includes(tid)) {
                                    const g2 = cell.grade != null ? cell.grade : 'S';
                                    if (g2 !== l.grade) p += gbw * w('grade_block');
                                    else p -= 0.5 * gbw * w('grade_block');
                                    break;
                                }
                            }
                        }
                    }
                }
                const scoreComplement = !!l.pairKey && pairMates(l, slot.key) === 1;
                candidateTidsOf(l, scoreComplement).forEach(tid => {
                    const t = teacherById[tid];
                    if (!t) return;
                    const tWeeks = teacherWeeksFor(l, tid, scoreComplement);
                    const opensNewDay = tWeeks.some(wk => !worksOnDay(tid, slot.day, wk));
                    if (t.type === 'part') {
                        // 最悪週で新しい出講日になる候補を避け、週別の最低コマ修復も減らす。
                        const pc0 = partConfById[tid];
                        if (pc0 && pc0.dayMin > 1 && opensNewDay) p += 3;
                        // 「できれば」扱いの非常勤条件も週別の最悪値で誘導する。
                        const psc = partSoftById[tid];
                        if (psc) {
                            if (psc.amOnly && slot.period >= 5) p += 2 * w('part:' + tid + ':amOnly');
                            if (psc.prepWeek != null && partWeekGapsAfter(l, tid, slot, scoreComplement) > psc.prepWeek) {
                                p += 1.5 * w('part:' + tid + ':prepWeek');
                            }
                            if (psc.dayMax > 0 && tWeeks.some(wk => dayCountAfter(tid, slot, wk) > psc.dayMax)) {
                                p += 2 * w('part:' + tid + ':dayMax');
                            }
                            if (psc.dayMin > 1 && opensNewDay) p += 1 * w('part:' + tid + ':dayMin');
                        }
                        if (selectedSoft.has('part_time_gap') &&
                            partGapAfter(l, tid, slot, scoreComplement) > gapLimit) p += 5 * w('part_time_gap');
                        if (selectedSoft.has('part_time_days') && opensNewDay) p += 1.5 * w('part_time_days');
                    }
                    if (t.type !== 'part' && selectedSoft.has('teacher_gap')) {
                        p += 0.5 * teacherCondWeightOf(state, 'teacher_gap', tid) *
                            w('teacher_gap') * partGapAfter(l, tid, slot, scoreComplement);
                    }
                    if (t.type !== 'part' && selectedSoft.has('no_gap_zero_day')) {
                        const ngw = teacherCondWeightOf(state, 'no_gap_zero_day', tid);
                        const max = Number(state.skeleton.periods[slot.day]) || 0;
                        if (ngw && max > 0 && tWeeks.some(wk => dayCountAfter(tid, slot, wk) >= max)) {
                            p += 2 * ngw * w('no_gap_zero_day');
                        }
                    }
                });
                if (selectedSoft.has('jiritsu_sync') && l.subject === '自立活動') {
                    // 他の支援学級の自立活動と同時刻なら加点（= スコアを下げる）
                    Object.keys(occCls).forEach(c => {
                        if (!c.startsWith('sc:') || l.classIds.includes(c)) return;
                        const other = occCls[c][slot.key];
                        if (other && other.subject === '自立活動') p -= 2 * w('jiritsu_sync');
                    });
                }
                return p;
            }

            function bestSlot(l, reasons) {
                const cslots = lessonSlots(l);
                let cands = [];
                for (const s of cslots) if (slotValid(l, s, 'strict', null)) cands.push(s);
                let relaxed = false;
                if (!cands.length) {
                    for (const s of cslots) if (slotValid(l, s, 'relaxed', reasons)) cands.push(s);
                    relaxed = true;
                }
                if (!cands.length) return null;
                let best = null, bestScore = Infinity;
                for (const s of cands) {
                    const sc = score(l, s);
                    if (sc < bestScore) { bestScore = sc; best = s; }
                }
                return { slot: best, relaxed };
            }

            // --- 固定コマ（支援→通常の順。すべて検証付きで、違反は未配置） ---
            function placeFixed(l) {
                const day = l.fixedSlot.day;
                const period = Number(l.fixedSlot.period);
                const key = sKey(day, period);
                if (!DAYS.includes(day) || period < 1 || period > (Number(state.skeleton.periods[day]) || 0)) {
                    unplaced.push({ lesson: l, reason: '固定コマ（' + (DAY_JP[day] || day) + period + '限）が週の骨格の範囲外です（Step 1・2）' });
                    return;
                }
                // 変動枠と同じ位置は、変動枠を使う学年（と支援学級）のみ不可
                if (hasVar && day === vs.day && period === Number(vs.period) &&
                    (l.support || l.classIds.some(c => gradeVar[gradeOf(c)]))) {
                    unplaced.push({ lesson: l, reason: '固定コマが変動枠と同じ位置です（Step 2 の警告を確認）' });
                    return;
                }
                const slot = { day, period, key };
                const reasons = { classBusy: 0, teacherBusy: 0, teacherNA: 0, room: 0, dayDup: 0, exchange: 0, restrict: 0, hardCond: 0, partCond: 0, syncCond: 0 };
                if (!slotValid(l, slot, 'fixed', reasons)) {
                    unplaced.push({ lesson: l, reason: '固定コマ（' + DAY_JP[day] + period + '限）に置けません（' + failReasonShort(reasons) + '）（Step 2・5）' });
                    return;
                }
                doPlace(l, slot);
                stats.fixed++;
            }
            // 変動枠を使う学年の担当（担任・教科担当）は、ベース週でも変動枠の時間を空けておく
            // （A週などにそのコマで変動枠の授業を行うため。固定コマより先に予約して衝突を防ぐ）
            if (varSlotObj) {
                varDutyTids.forEach(tid => {
                    (occTeacher[tid] = occTeacher[tid] || new Set()).add(varSlotObj.key);
                    if (occTCommon) {
                        (occTCommon[tid] = occTCommon[tid] || new Set()).add(varSlotObj.key);
                    }
                });
            }
            // 支援学級の固定コマを先に置く（学活・道徳・総合を「支援で受ける」生徒がいる場合、
            // 生徒が支援にいる時刻の登録が先でないと、交流学級側の同時刻の固定コマが
            // 双方向同期チェック（syncCond）に弾かれてしまうため）
            fixedSupport.forEach(placeFixed);
            fixedNormal.forEach(placeFixed);


            // --- エジェクションチェーン ---
            // 詰まったときは「試行回数が減ってもいいから深く読む」方針（実運用レビュー指示 2026-07-27）。
            // 配置中（序盤〜中盤）は軽く。盤面がまだ空いているので浅い連鎖で足りる。
            let ejectionMaxDepth = Math.max(0, Number(opts.ejectionDepth ?? 6));
            let ejectionMaxBlockers = Math.max(1, Number(opts.ejectionBlockers ?? 2));
            let ejectionMaxMs = Math.max(1, Number(opts.ejectionMs ?? 500));
            let ejectionAttemptMaxMs = Math.max(1, Number(opts.ejectionAttemptMs ?? 3000));

            // 終盤（＝盤面が埋まりきってから残りを押し込む「詰将棋」の局面）は、
            // 試行回数が減ってもいいから深く読む（実運用レビュー指示 2026-07-27）。
            const endgameDepth = Math.max(0, Number(opts.endgameDepth ?? 40));
            const endgameBlockers = Math.max(1, Number(opts.endgameBlockers ?? 4));
            const endgameMs = Math.max(1, Number(opts.endgameMs ?? 20000));
            // 1コマぶんの読みを区切る長さ（＝ブラウザが連続で固まる時間の上限）。
            // endgameMs をそのまま1回で読ませると最大20秒メインスレッドが止まり、
            // 教員には「固まった」ようにしか見えない（リロードされて生成結果を失う）。
            const endgameMoveMs = Math.max(1, Number(opts.endgameMoveMs ?? 4000));
            // 終盤パス全体の持ち時間。「solve の残り時間」と「endgameMs の3倍」の小さい方で
            // 頭打ちにする（最低2秒は残す。0にすると詰将棋が全く効かず配置の質が落ちるため）。
            const endgameTotalMs = Math.max(1, Number(opts.endgameTotalMs ?? endgameMs * 3));
            const endgamePassMs = () =>
                Math.max(2000, Math.min(endgameTotalMs, solveDeadline - Date.now()));
            // 連鎖を深くするほど1手が重くなるので、押しのけ先も連鎖させるのは終盤だけにする。
            let ejectionDeepChain = false;
            // 終盤パスは「同日重複を取り除く後処理」より後ろで動くため、
            // ここで緩和配置（同日重複を許す置き方）を使うと掃除されずに残ってしまう。
            // 終盤では緩和を禁止し、条件どおりに置けるときだけ採用する。
            let ejectionNoRelax = false;

            const ejectionStartedAt = Date.now();
            let ejectionAttemptStartedAt = null;

            // --- 連鎖の巻き戻し（移動ログ）---
            // 連鎖に失敗したときは盤面を完全に元へ戻さなければならない。
            // 以前は「その階層で動かした分」しか戻しておらず、再帰の奥で動いた授業が
            // 取り残されて盤面が壊れ、条件違反や取りこぼしの原因になっていた。
            // doPlace/undoPlace をすべて記録し、逆順に再生して確実に復元する。
            function ejRewind(mark) {
                const log = ejLog;
                ejLog = null;                       // 巻き戻し自体は記録しない
                for (let i = log.length - 1; i >= mark; i--) {
                    const e = log[i];
                    if (e.op === 'place') undoPlace(e.l, e.key);
                    else doPlace(e.l, slotObjOf(e.key));
                }
                log.length = mark;
                ejLog = log;
            }

            function ejectionTimedOut(startedAt) {
                return Date.now() - startedAt >= ejectionMaxMs ||
                    Date.now() - ejectionAttemptStartedAt >= ejectionAttemptMaxMs;
            }

            function movableBlocker(l, slot) {
                // そのスロットに l を置けなくしている授業を集める。
                // 自クラスの同時刻だけでなく、(a) 同じ教員が別クラスで持っている授業、
                // (b) 同じ日に入っている同教科の授業（同日重複の原因）も対象にする。
                // ここを自クラスだけに限っていたため、
                // 「森が火2に3-1を教えているので1-2理科を置けない」型の詰まりを解消できなかった。
                const found = new Map();   // id -> lesson

                // (1) 自クラスの同時刻
                for (const c of l.classIds) {
                    const x = occCls[c][slot.key];
                    if (x && x.id !== l.id) found.set(x.id, x);
                }

                // (2) 同時刻に同じ教員が持っている授業（別クラスを含む）
                for (const c of Object.keys(occCls)) {
                    const x = occCls[c][slot.key];
                    if (!x || x.id === l.id || found.has(x.id)) continue;
                    if ((x.teachers || []).some(t => l.teachers.includes(t))) found.set(x.id, x);
                }

                // (3) 同じ日・同じクラスにある同教科（同日重複の原因）
                for (const c of l.classIds) {
                    const grid = occCls[c] || {};
                    for (const k of Object.keys(grid)) {
                        if (k.slice(0, k.indexOf('-')) !== slot.day) continue;
                        const x = grid[k];
                        if (x && x.id !== l.id && x.subject === l.subject) found.set(x.id, x);
                    }
                }

                // 固定コマ（学活・道徳・総合）と、手直しモードのピン・ロックは動かせないので押しのけ対象外
                const list = [...found.values()].filter(x => !x.fixedSlot && !editImmovable.has(x.id));
                if (list.length !== found.size) return null;   // 固定コマが混じるスロットは諦める
                // 押しのける数の上限（既定4）。多いほど解ける可能性は上がるが探索は重くなる。
                if (list.length === 0 || list.length > ejectionMaxBlockers) return null;
                return list;
            }

            function mobilityCount(l, forbiddenId) {
                let count = 0;
                for (const s of lessonSlots(l)) {
                    if (s.key === forbiddenId) continue;
                    if (slotValid(l, s, 'strict', null)) count++;
                }
                return count;
            }

            // --- 千日手（循環）の防ぎ方 ---
            // 以前は「同じ授業を2度動かさない」で循環を止めていたが、これは乱暴すぎた。
            // 実際の手直しでは、一度ずらした授業をもう一度ずらすことがある（実運用レビュー）。
            // 将棋と同じで、禁じるべきは「同じ駒を二度動かすこと」ではなく「同じ局面に戻ること」。
            //   (1) 禁じ手リスト（ejTabu）: 連鎖の間、授業を「一度離れたマス」へ戻さない。
            //       授業単位ではなく「授業×マス」で覚えるので、別のマスへ動かすのは自由。
            //   (2) 処理中の授業（inFlight）: 再帰の途中で自分自身を押しのけない（無限再帰の防止）。
            //   (3) 総手数の上限（ejectionMoveBudget）: 読みが発散しても必ず有限で終わる。
            let ejTabu = null;
            let ejMoves = 0;
            const ejectionMoveBudget = Math.max(1, Number(opts.ejectionMoves ?? 400));
            // 押しのけた相手ひとりにつき試す「置き場」の数（兄弟間のやり直し用）
            const ejectionSiblingTries = Math.max(1, Number(opts.ejectionSiblingTries ?? 4));

            function ejTabuKey(x, key) { return x.id + '@' + key; }

            // 連鎖の中で授業を置く。禁じ手リストと手数を更新する。
            function placeMove(x, slot) {
                ejTabu.add(ejTabuKey(x, slot.key));
                ejMoves++;
                doPlace(x, slot);
            }

            // その授業を「普通に」置けるマス（空きかつ全条件を満たす。禁じ手は除く）
            function ordinaryOptions(x) {
                const out = [];
                for (const s of lessonSlots(x)) {
                    if (ejTabu.has(ejTabuKey(x, s.key))) continue;
                    if (slotValid(x, s, 'strict', null)) out.push(s);
                }
                return out;
            }

            // 連鎖の入口。ここでログ・禁じ手・手数を初期化し、抜けるときに閉じる。
            function tryEjection(l, startedAt) {
                const owner = ejLog === null;
                if (owner) { ejLog = []; ejTabu = new Set(); ejMoves = 0; }
                try {
                    return placeWithEjection(l, 0, new Set(), startedAt);
                } finally {
                    if (owner) { ejLog = null; ejTabu = null; }
                }
            }

            function placeWithEjection(l, depth, inFlight, startedAt) {
                if (ejectionTimedOut(startedAt)) return false;
                if (ejMoves >= ejectionMoveBudget) return false;
                if (inFlight.has(l.id)) return false;

                const ordinary = bestSlot(l, newReasons());
                if (ordinary && !(ejectionNoRelax && ordinary.relaxed)
                    && !ejTabu.has(ejTabuKey(l, ordinary.slot.key))) {
                    if (ordinary.relaxed) relaxedLessons.push(l);
                    placeMove(l, ordinary.slot);
                    return true;
                }
                // bestSlot の選んだマスが禁じ手なら、他の置けるマスを探す
                if (!ordinary || ejTabu.has(ejTabuKey(l, ordinary.slot.key))) {
                    const alt = ordinaryOptions(l);
                    if (alt.length) { placeMove(l, alt[0]); return true; }
                }

                if (depth >= ejectionMaxDepth) return false;

                const candidates = [];
                for (const s of lessonSlots(l)) {
                    if (ejectionTimedOut(startedAt)) return false;

                    const blockers = movableBlocker(l, s);
                    // 押しのけてよいのは「いま処理中でない」授業。動かし終わったものは再び動かせる。
                    if (!blockers || blockers.some(x => inFlight.has(x.id))) continue;

                    const removed = [];
                    let bad = false;
                    for (const x of blockers) {
                        const k = findSlotKeyOf(x);
                        if (!k) { bad = true; break; }
                        removed.push({ x, key: k });
                    }
                    if (bad) continue;

                    // 障害を全部外した状態で、L が他のハード制約を満たすか確認する。
                    const probe = ejLog.length;
                    removed.forEach(({ x, key }) => undoPlace(x, key));
                    const canPlace = slotValid(l, s, 'strict', null);
                    let mobility = 0;
                    if (canPlace) mobility = removed.reduce((m, { x }) => m + mobilityCount(x, x.id), 0);
                    ejRewind(probe);

                    if (canPlace) candidates.push({ slot: s, removed, mobility, count: removed.length });
                }

                // 1つだけ押しのければ済むものを優先し、その中で動かしやすい順に試す。
                candidates.sort((a, b) =>
                    a.count - b.count || b.mobility - a.mobility || (rng() < 0.5 ? -1 : 1));

                for (const candidate of candidates) {
                    if (ejectionTimedOut(startedAt)) return false;

                    const { slot, removed } = candidate;
                    const mark = ejLog.length;
                    // 押しのける。離れたマスは禁じ手にして、戻ってこないようにする。
                    removed.forEach(({ x, key }) => { undoPlace(x, key); ejTabu.add(ejTabuKey(x, key)); });
                    placeMove(l, slot);
                    stats.ejections++;

                    const nextInFlight = new Set(inFlight);
                    nextInFlight.add(l.id);

                    // 押しのけた授業をすべて置き直せたら成功。配置は毎回 slotValid を通るため、
                    // 教員の重なり・出講不可・同日重複・支援同期・教室容量は1手ごとに検査される。
                    //
                    // **兄弟間のやり直し**（2026-07-28）: 以前は押しのけた相手を順に1通りずつ置き、
                    // 後の相手が詰んだら初手ごと捨てていた。1人目が2人目の置き場を塞いでいるだけの
                    // ことがあるので、1人目の置き場を変えて試し直す。将棋でいう2手目以降の読み分け。
                    const chase = ejectionDeepChain || removed.length === 1;
                    const placeRemoved = (idx) => {
                        if (idx >= removed.length) return true;
                        if (ejectionTimedOut(startedAt) || ejMoves >= ejectionMoveBudget) return false;
                        const x = removed[idx].x;
                        const markX = ejLog.length;

                        // (a) 普通に置けるマスを複数試す（ここが従来は決め打ちだった）
                        for (const s of ordinaryOptions(x).slice(0, ejectionSiblingTries)) {
                            placeMove(x, s);
                            if (placeRemoved(idx + 1)) return true;
                            ejRewind(markX);
                        }
                        // (b) 空きが無ければ、この相手もさらに押しのけて置く（連鎖）
                        if (chase && placeWithEjection(x, depth + 1, nextInFlight, startedAt)) {
                            if (placeRemoved(idx + 1)) return true;
                            ejRewind(markX);
                        }
                        return false;
                    };
                    if (placeRemoved(0)) return true;

                    // 失敗。この候補で動かしたものを、連鎖の奥の分まで含めて完全に戻す。
                    ejRewind(mark);
                }

                return false;
            }

            // --- 終盤パス（詰将棋）の共通ドライバ（2026-08-03）---
            // 詰将棋は「1コマにつき最大 endgameMs（既定20秒）」を同期で読むうえ、コマとコマの
            // 合間でUIへ制御を返していなかった。未配置が N コマあると N 回ぶんの読みが丸ごと
            // ひとかたまりのブロックになり（実測: 12コマで6.2秒）、その間ブラウザは完全に停止する。
            // 中断ボタンのクリックすら配送されず、教員は「固まった」と判断してリロードし、
            // せっかくの生成結果を失っていた。読みの中身は変えずに、次の3点だけを足す。
            //   ・コマの合間に uiTick() でUIへ制御を返す（中断ボタン・進捗表示・スピナーが動く）
            //   ・同じところで opts.shouldCancel() を見て、押されていたら即座に抜ける
            //   ・1コマの読みを endgameMoveMs（既定4秒）で区切り、パス全体にも持ち時間（passMs）を
            //     設ける。「1コマ20秒×コマ数」で探索時間の上限を食い破らせないため
            // 戻り値: 置けた授業の id の Set（unplaced から外すのは呼び出し側の仕事）
            async function runEndgame(lessons, passMs, notify) {
                const placed = new Set();
                const deadline = Date.now() + Math.max(1, passMs);
                const total = lessons.length;
                let done = 0;
                let lastTickAt = 0;
                for (const l of lessons) {
                    const now = Date.now();
                    if (now >= deadline) break;
                    if (opts.shouldCancel && opts.shouldCancel()) break;
                    // ejectionTimedOut がこの長さで打ち切る。1手ごとの上限とパスの残り時間の
                    // 小さい方＝ブラウザが連続で固まる時間の上限になる。
                    ejectionMaxMs = Math.min(endgameMoveMs, endgameMs, Math.max(1, deadline - now));
                    if (tryEjection(l, Date.now())) placed.add(l.id);
                    done++;
                    // 進捗は「置けた数」ではなく「読み終えた数」を出す。押し込めないコマが
                    // 続くと置けた数は0のまま止まって見え、固まったと誤解されるため。
                    if (notify) notify(done, total);
                    // 毎コマ返すと postMessage の往復が積もるので80msに1回へ間引く
                    if (Date.now() - lastTickAt >= 80) {
                        lastTickAt = Date.now();
                        await uiTick();
                    }
                }
                return placed;
            }

            function placeLesson(l, reasons) {
                const ordinary = bestSlot(l, reasons);
                if (ordinary) {
                    if (ordinary.relaxed) relaxedLessons.push(l);
                    doPlace(l, ordinary.slot);
                    return true;
                }

                if (ejectionAttemptStartedAt == null) {
                    ejectionAttemptStartedAt = Date.now();
                }
                const startedAt = Date.now();
                const ok = tryEjection(l, startedAt);
                if (ok) return true;

                return false;
            }

            const newReasons = () => ({ classBusy: 0, teacherBusy: 0, teacherNA: 0, room: 0, dayDup: 0, exchange: 0, restrict: 0, hardCond: 0, partCond: 0, syncCond: 0 });
            const isOnbiFirstLesson = l =>
                l.subject === '音美' && !!absorbMap[l.classIds[0]];

            // 充当対象学級の音美は、非常勤2名・A週の充当教員・学級の空きが重なる
            // 極小枠にしか置けないため、固定コマ直後にMRVで配置する。
            function placeOnbiPhase() {
                const pool = freeNormal.filter(isOnbiFirstLesson);
                while (pool.length) {
                    let bestIdx = 0, bestCount = Infinity;
                    for (let i = 0; i < pool.length; i++) {
                        let cnt = 0;
                        for (const s of lessonSlots(pool[i])) if (slotValid(pool[i], s, 'strict', null)) cnt++;
                        if (cnt < bestCount) { bestCount = cnt; bestIdx = i; }
                    }
                    const l = pool.splice(bestIdx, 1)[0];
                    const reasons = newReasons();
                    const r = placeLesson(l, reasons);
                    if (!r) { unplaced.push({ lesson: l, reason: failReason(reasons) }); continue; }
                    stats.normal++;
                    stats.onbiFirst++;
                }
            }
            if (!editSeedPos) placeOnbiPhase();

            // 通常学級の配置（リスト単位。制約が強い順 + 乱択）
            function placeNormalBatch(list) {
                const baseScore = new Map();
                list.forEach(l => {
                    let s = 0;
                    // 現場流: まず複数の学年にまたがる教員、次に持ちコマの多い教員（衝突が出やすい順）
                    let span = 0, tl = 0;
                    l.teachers.forEach(tid => {
                        span = Math.max(span, tGradeSpan[tid] || 0);
                        tl = Math.max(tl, tLoadAll[tid] || 0);
                    });
                    if (span > 1) s += (span - 1) * 50;
                    s += tl * 2;
                    roomComponents(l.subject).forEach(comp => {
                        const cap = capOf(comp);
                        if (cap !== Infinity) s += Math.max(0, 60 - cap * 10);
                    });
                    if (BIWEEKLY_PAIRS[l.subject]) s += 15;
                    s += l.classIds.length * 20;
                    s += l.teachers.length * 5;
                    s += l.weeklyHours * 8;   // 週4コマ教科は5日中4日が必要で最も窮屈 → 先に置く
                    if (boostIds && boostIds.has(l.id)) s += 300;  // 前回の最良で詰まった授業は最優先で置く
                    l.classIds.forEach(c => {
                        if (restrict[c]) {
                            Object.values(restrict[c]).forEach(set => { if (set.has(l.subject)) s += 25; });
                        }
                    });
                    l.teachers.forEach(tid => {
                        const t = teacherById[tid];
                        if (t && t.type === 'part') s += 30;
                        s += (naOf[tid] ? naOf[tid].size : 0);
                    });
                    baseScore.set(l.id, s + (rng() - 0.5) * 4);
                });
                const order = list.slice().sort((a, b) => baseScore.get(b.id) - baseScore.get(a.id));
                for (const l of order) {
                    const reasons = newReasons();
                    const r = placeLesson(l, reasons);
                    if (!r) { unplaced.push({ lesson: l, reason: failReason(reasons) }); continue; }
                    stats.normal++;
                }
            }

            // --- タイト教員フェーズと支援学級フェーズ ---
            // どちらを先に置くべきかはその年の教員・支援学級の状況次第で変わるため、
            // 試行ごとに両方の順序を交互に試し、良い結果が出た方を多スタートの最良案として採用する。
            //   タイト先行: 空きが極端に少ない教員（例: 金曜全休）の枠が支援の制限で潰されるのを防ぐ
            //   支援先行:   支援学級と交流の同期に最大の自由度を与える
            // 交流学級の「支援で受ける教科」（国数英など）は支援の配置後でないと置けない。
            // 音美先行対象は固定コマ直後に配置済みなので、後続フェーズから除外する。
            const isSyncLesson = l => !l.support && l.classIds.some(c => {
                const stus = supStudentsByClass[c];
                return stus && stus.some(st => st.subjects && st.subjects[l.subject] === 'support');
            });
            const isSyncPhaseLesson = l => isSyncLesson(l) && !isOnbiFirstLesson(l);
            function placeTightPhase() {
                const before = stats.normal;
                placeNormalBatch(freeNormal.filter(l =>
                    !isOnbiFirstLesson(l) &&
                    !isSyncPhaseLesson(l) &&
                    l.teachers.some(tid => tightTids.has(tid))));
                stats.tight = stats.normal - before;
            }
            function placeSupportPhase() {
                const pool = freeSupport.slice();
                while (pool.length) {
                    let bestIdx = 0, bestCount = Infinity;
                    for (let i = 0; i < pool.length; i++) {
                        let cnt = 0;
                        for (const s of lessonSlots(pool[i])) if (slotValid(pool[i], s, 'strict', null)) cnt++;
                        if (cnt < bestCount) { bestCount = cnt; bestIdx = i; }
                    }
                    const l = pool.splice(bestIdx, 1)[0];
                    const reasons = newReasons();
                    const r = placeLesson(l, reasons);
                    if (!r) { unplaced.push({ lesson: l, reason: failReason(reasons) }); continue; }
                    stats.support++;
                }
            }
            // 支援同期の対象教科は、支援の時間帯に合わせる必要があるため、
            // 「置ける候補が最も少ない授業から」専用フェーズで配置する。
            function placeSyncPhase() {
                const pool = freeNormal.filter(isSyncPhaseLesson);
                stats.sync = 0;
                while (pool.length) {
                    let bestIdx = 0, bestCount = Infinity;
                    for (let i = 0; i < pool.length; i++) {
                        let cnt = 0;
                        for (const s of lessonSlots(pool[i])) if (slotValid(pool[i], s, 'strict', null)) cnt++;
                        if (cnt < bestCount) { bestCount = cnt; bestIdx = i; }
                    }
                    const l = pool.splice(bestIdx, 1)[0];
                    const reasons = newReasons();
                    const r = placeLesson(l, reasons);
                    if (!r) { unplaced.push({ lesson: l, reason: failReason(reasons) }); continue; }
                    stats.normal++;
                    stats.sync++;
                }
            }
            // 手直しモード: 通常の配置フェーズの代わりに「前回の位置へ据え置く」。
            // 多パスにするのは順序依存（交流学級の教科は支援が置かれた後でないと置けない等)
            // を再試行で自然に解くため。据え置けなかったコマ＝ピンに押し出されたコマだけが
            // placeLesson（＝普通に置ける場所を探し、無ければ詰将棋）に回る。
            async function placeSeedPhase() {
                // ピン・ロックを先頭に並べ、各パスで優先して席へ着かせる。
                // 多パスにするのは順序依存（支援→交流、非常勤の準備時間の途中計算など）を
                // 再試行で自然に解くため。
                const isPri = l => editImmovable.has(l.id);
                // 優先（ピン・ロック）を先頭に、残りは乱数順。
                // 押し出されたコマの解決は順序の巡り合わせに左右されるため、
                // 編集は複数試行（UI側 maxAttempts>1）で順序を変えて再挑戦する。
                let pool = freeSupport.concat(freeNormal)
                    .map(l => ({ l, r: rng() }))
                    .sort((a, b) => (isPri(b.l) ? 1 : 0) - (isPri(a.l) ? 1 : 0) || a.r - b.r)
                    .map(x => x.l);
                // ピンの却下理由は「ほぼ空の盤面」の1パス目で取る。満杯になった後で調べると
                // どんな理由でも「学級の空きコマがない」に化けてしまい、役に立たない。
                const priReason = new Map();
                for (let pass = 0; pass < 6 && pool.length; pass++) {
                    const rest = [];
                    for (const l of pool) {
                        const pos = editSeedPos[l.id];
                        const slot = pos ? slotObjOf(pos.day + '-' + pos.period) : null;
                        const reasons = (pass === 0 && isPri(l)) ? newReasons() : null;
                        if (slot && slotValid(l, slot, 'strict', reasons)) {
                            doPlace(l, slot);
                            if (l.support) stats.support++; else stats.normal++;
                        } else {
                            if (reasons) priReason.set(l.id, failReasonShort(reasons));
                            rest.push(l);
                        }
                    }
                    if (rest.length === pool.length) { pool = rest; break; }
                    pool = rest;
                }
                stats.editMoved = pool.filter(l => !isPri(l)).length;
                stats.editPinFailed = 0;
                for (const l of pool) {
                    // ピン・ロックは指定位置以外に置かない（勝手に別の場所へ動いたら意味がない）。
                    // 1つでも座れなければ、指定どうしが両立しない＝編集自体が不成立。
                    // 理由を添えて未配置として報告し、UI側は結果を破棄して前の状態を保つ。
                    if (isPri(l)) {
                        const pos = editSeedPos[l.id];
                        stats.editPinFailed++;
                        unplaced.push({ lesson: l, reason: '指定/ロックした位置（' +
                            (pos ? (DAY_JP[pos.day] || pos.day) + pos.period + '限' : '不明') +
                            '）に置けません（' + (priReason.get(l.id) || '他のコマと両立しない') + '）' });
                    }
                }
                // 押し出されたコマの解決は、多スタートが無い1回勝負なので
                // 最初から深い詰将棋（終盤と同じ設定）＋緩和禁止で読む。
                const savedDepth = ejectionMaxDepth, savedBlockers = ejectionMaxBlockers;
                const savedMs = ejectionMaxMs, savedAttemptMs = ejectionAttemptMaxMs;
                ejectionMaxDepth = endgameDepth;
                ejectionMaxBlockers = endgameBlockers;
                ejectionMaxMs = endgameMs;
                ejectionAttemptMaxMs = Infinity;   // 1手ごとの上限は runEndgame がスライスで与える
                ejectionDeepChain = true;
                ejectionNoRelax = true;
                ejectionAttemptStartedAt = Date.now();
                // 詰将棋は1コマに数秒かかる。同期でまとめて回すとブラウザが固まり、
                // 手直しが「効かない」ように見えるため、共通ドライバで区切りながら読む。
                const seedPool = pool.filter(l => !isPri(l));
                const seedPlaced = await runEndgame(seedPool, endgamePassMs(), null);
                for (const l of seedPool) {
                    if (seedPlaced.has(l.id)) {
                        if (l.support) stats.support++; else stats.normal++;
                        continue;
                    }
                    // 却下理由は「最終盤面でなぜ置けないか」を集計して出す。
                    // 時間切れで詰将棋まで回らなかったコマでも、素直に置ける場所があるなら置く。
                    const reasons = newReasons();
                    const r0 = bestSlot(l, reasons);
                    if (r0 && !r0.relaxed) {
                        doPlace(l, r0.slot);
                        if (l.support) stats.support++; else stats.normal++;
                        continue;
                    }
                    unplaced.push({ lesson: l, reason: failReason(reasons) });
                }
                ejectionDeepChain = false;
                ejectionNoRelax = false;
                ejectionMaxDepth = savedDepth; ejectionMaxBlockers = savedBlockers;
                ejectionMaxMs = savedMs; ejectionAttemptMaxMs = savedAttemptMs;
            }

            stats.supportFirst = !!supportFirst;
            if (editSeedPos) {
                await placeSeedPhase();
            } else {
                if (supportFirst) { placeSupportPhase(); placeSyncPhase(); placeTightPhase(); }
                else { placeTightPhase(); placeSupportPhase(); placeSyncPhase(); }
            }

            // 支援配置で交流学級に課した許可教科制限の数（プロセス説明用）
            stats.restrictCells = Object.values(restrict).reduce((a, m) => a + Object.keys(m).length, 0);

            // --- 残りの通常学級（音美先行・同期専用・タイト教員分は配置済み） ---
            if (!editSeedPos) placeNormalBatch(freeNormal.filter(l =>
                !isOnbiFirstLesson(l) &&
                !isSyncPhaseLesson(l) &&
                !l.teachers.some(tid => tightTids.has(tid))));

            stats.relaxedBefore = relaxedLessons.length;

            // --- 修復: 同日重複（緩和配置）を、同学級内のコマ入れ替えで解消を試みる ---
            function slotObjOf(key) {
                const i = key.indexOf('-');
                return { day: key.slice(0, i), period: Number(key.slice(i + 1)), key };
            }
            function findSlotKeyOf(l) {
                const grid = occCls[l.classIds[0]];
                for (const k of Object.keys(grid)) if (grid[k].id === l.id) return k;
                return null;
            }
            function undoPlace(l, key) {
                if (ejLog) ejLog.push({ op: 'unplace', l, key });
                const complement = !!l.pairKey && pairMates(l, key) >= 1;
                if (l.support && l.attendees) l.attendees.forEach(st => { if (stuSlots[st.id]) stuSlots[st.id].delete(key); });
                l.classIds.forEach(c => { delete occCls[c][key]; });
                l.teachers.forEach(tid => {
                    if (complement && l.biTeachers && l.biTeachers.includes(tid)) return;
                    if (occTeacher[tid]) occTeacher[tid].delete(key);
                });
                if (occT3) {
                    if (l.subject === '音美') {
                        weekList.forEach(w => {
                            weeklyTidsOf(l, w, complement).forEach(tid => {
                                if (occT3[w][tid]) occT3[w][tid].delete(key);
                            });
                        });
                    } else {
                        weeklyTidsOf(l, weekList[0], complement).forEach(tid => {
                            if (occTCommon[tid]) occTCommon[tid].delete(key);
                        });
                    }
                }
                if (!complement) roomComponents(l.subject).forEach(comp => {
                    if (capOf(comp) === Infinity) return;
                    if (roomUse[comp] && roomUse[comp][key]) roomUse[comp][key] -= l.classIds.length;
                });
                l.classIds.forEach(c => {
                    const k = c + '|' + l.subject + '|' + key.split('-')[0];
                    if (dayCount[k]) dayCount[k]--;
                });
            }
            // 資源計上が単純な授業だけ入れ替え対象にする（固定・支援・合同・隔週交代は除外）
            const swappable = l => l && !l.support && !l.fixedSlot && !l.pairKey &&
                !editImmovable.has(l.id) && l.classIds.length === 1;
            for (let pass = 0; pass < 3 && relaxedLessons.length; pass++) {
                for (let i = relaxedLessons.length - 1; i >= 0; i--) {
                    const l = relaxedLessons[i];
                    if (!swappable(l)) continue;
                    const k1 = findSlotKeyOf(l);
                    if (!k1) continue;
                    const cid = l.classIds[0];
                    const keys = Object.keys(occCls[cid]);
                    let done = false;
                    // 2コマ入れ替え（l↔M）
                    for (const k2 of keys) {
                        if (k2 === k1) continue;
                        const M = occCls[cid][k2];
                        if (!swappable(M)) continue;
                        undoPlace(l, k1); undoPlace(M, k2);
                        const s1 = slotObjOf(k1), s2 = slotObjOf(k2);
                        if (slotValid(l, s2, 'strict', null)) {
                            doPlace(l, s2);
                            if (slotValid(M, s1, 'strict', null)) {
                                doPlace(M, s1);
                                done = true;
                                break;
                            }
                            undoPlace(l, k2);
                        }
                        doPlace(l, s1); doPlace(M, s2);  // 元に戻す
                    }
                    // 3コマ巡回（l→k2, M→k3, N→k1）
                    if (!done) {
                        outer:
                        for (const k2 of keys) {
                            if (k2 === k1) continue;
                            const M = occCls[cid][k2];
                            if (!swappable(M)) continue;
                            for (const k3 of keys) {
                                if (k3 === k1 || k3 === k2) continue;
                                const N = occCls[cid][k3];
                                if (!swappable(N)) continue;
                                const s1 = slotObjOf(k1), s2 = slotObjOf(k2), s3 = slotObjOf(k3);
                                undoPlace(l, k1); undoPlace(M, k2); undoPlace(N, k3);
                                if (slotValid(l, s2, 'strict', null)) {
                                    doPlace(l, s2);
                                    if (slotValid(M, s3, 'strict', null)) {
                                        doPlace(M, s3);
                                        if (slotValid(N, s1, 'strict', null)) {
                                            doPlace(N, s1);
                                            done = true;
                                            break outer;
                                        }
                                        undoPlace(M, k3);
                                    }
                                    undoPlace(l, k2);
                                }
                                doPlace(l, s1); doPlace(M, s2); doPlace(N, s3);  // 元に戻す
                            }
                        }
                    }
                }
                // まだ同日重複が残っている授業だけをリストに残す
                for (let i = relaxedLessons.length - 1; i >= 0; i--) {
                    const l = relaxedLessons[i];
                    const k = findSlotKeyOf(l);
                    const dup = k && (classDayConflictSubjects(l.classIds[0], l.subject).reduce((sum, s) =>
                        sum + (dayCount[l.classIds[0] + '|' + s + '|' + k.split('-')[0]] || 0), 0) > 1 ||
                        classVarDayConflict(l.classIds[0], l.subject, k.split('-')[0]));
                    if (!dup) relaxedLessons.splice(i, 1);
                }
            }
            // --- 同日重複は絶対に残さない: 修復で解消できなかった授業は配置から外して未配置に戻す ---
            // （外した授業は続く玉突き修復で正しい置き場を探し、それでも無理なら「未配置」として表示される。
            //   固定コマの意図的な連続（総合の2コマ連続など）は対象外）
            stats.dupRemoved = 0;
            for (let i = relaxedLessons.length - 1; i >= 0; i--) {
                const l = relaxedLessons[i];
                const k = findSlotKeyOf(l);
                if (k) {
                    undoPlace(l, k);
                    unplaced.push({ lesson: l, reason: '同じ教科が同日に重なるため配置から外しました（同日重複は絶対に残しません）' });
                    stats.dupRemoved++;
                }
                relaxedLessons.splice(i, 1);
            }

            // --- 修復: 未配置の授業を、既存コマの押し出し（玉突き）で配置を試みる ---
            for (let pass = 0; pass < 2; pass++) {
                for (let i = unplaced.length - 1; i >= 0; i--) {
                    const l = unplaced[i].lesson;
                    if (!swappable(l)) continue;
                    const cid = l.classIds[0];
                    const empties = lessonSlots(l).filter(s2 => !occCls[cid][s2.key]);
                    let done = false;
                    for (const ke of empties) {
                        // 修復で状況が変わっていれば直接置けることもある
                        if (slotValid(l, ke, 'strict', null)) { doPlace(l, ke); done = true; break; }
                        // 既存のコマ M を空きへ動かし、空いた場所に l を置く
                        for (const k2 of Object.keys(occCls[cid])) {
                            const M = occCls[cid][k2];
                            if (!swappable(M)) continue;
                            const s2o = slotObjOf(k2);
                            undoPlace(M, k2);
                            if (slotValid(M, ke, 'strict', null)) {
                                doPlace(M, ke);
                                if (slotValid(l, s2o, 'strict', null)) { doPlace(l, s2o); done = true; break; }
                                undoPlace(M, ke.key);
                            }
                            doPlace(M, s2o);  // 元に戻す
                        }
                        if (done) break;
                    }
                    if (done) { unplaced.splice(i, 1); stats.pushFixed++; }
                }
            }

            // --- 終盤の詰将棋: 盤面が埋まりきった状態で、残った未配置を深い連鎖で押し込む ---
            // ここまでの配置中は「置けなければ未配置に回して先へ進む」ため、一度あきらめた授業は
            // 二度と挑戦されなかった。しかし盤面が完成した最終形は配置中とは別の局面であり、
            // ここでこそ時間をかけて深く読む価値がある（実運用レビュー指示 2026-07-27）。
            // 既定オン（2026-07-28に変更）。兄弟間のやり直しを直した後のA/B比較（同条件・4シード）で
            // あり=完全解3/4・なし=2/4、両方成功したシードでも「あり」は5〜20分の1の試行で到達した。
            // さらにブラウザ既定経路（solveEscalating）では、これが無いとフェーズ2が不必要に
            // 条件を緩めてしまう（詰将棋で入るコマを「条件を外して」入れてしまう）。
            // opts.endgame: false で無効化できる。
            stats.endgameFixed = 0;
            if (unplaced.length && (opts.endgame ?? true)) {
                const savedDepth = ejectionMaxDepth, savedBlockers = ejectionMaxBlockers;
                const savedMs = ejectionMaxMs, savedAttemptMs = ejectionAttemptMaxMs;
                ejectionMaxDepth = endgameDepth;
                ejectionMaxBlockers = endgameBlockers;
                ejectionMaxMs = endgameMs;
                ejectionAttemptMaxMs = Infinity;   // 1手ごとの上限は runEndgame がスライスで与える
                ejectionDeepChain = true;
                ejectionNoRelax = true;
                ejectionAttemptStartedAt = Date.now();

                // 未配置を後ろから順に読む（従来と同じ順序）。1コマずつ持ち時間を区切り、
                // コマの合間にUIへ制御を返すので、中断ボタンと進捗表示が生きたまま詰将棋できる。
                const egLessons = [];
                for (let i = unplaced.length - 1; i >= 0; i--) {
                    if (swappable(unplaced[i].lesson)) egLessons.push(unplaced[i].lesson);
                }
                const egPlaced = await runEndgame(egLessons, endgamePassMs(), onEndgame || null);
                for (let i = unplaced.length - 1; i >= 0; i--) {
                    if (!egPlaced.has(unplaced[i].lesson.id)) continue;
                    unplaced.splice(i, 1);
                    stats.endgameFixed++;
                }

                // 保険: 終盤で同日重複が生まれていたら必ず取り除く（重複は絶対に残さない）
                for (let i = relaxedLessons.length - 1; i >= 0; i--) {
                    const l = relaxedLessons[i];
                    const k = findSlotKeyOf(l);
                    if (k) {
                        undoPlace(l, k);
                        unplaced.push({ lesson: l, reason: '同じ教科が同日に重なるため配置から外しました（同日重複は絶対に残しません）' });
                        stats.endgameFixed--;
                    }
                    relaxedLessons.splice(i, 1);
                }

                ejectionDeepChain = false;
                ejectionNoRelax = false;
                ejectionMaxDepth = savedDepth; ejectionMaxBlockers = savedBlockers;
                ejectionMaxMs = savedMs; ejectionAttemptMaxMs = savedAttemptMs;
            }

            // --- 非常勤の「1日の最低コマ数」検証と修復 ---
            // 配置中は判定できない（後からコマが増えるかもしれない）ため、配置後に
            // コマ数が下限未満の日を検出し、その日の授業を別の稼働日へ移して日を空にする
            function lessonAt(tid, key, w) {
                const seen = new Set();
                for (const c of Object.keys(occCls)) {
                    const l = occCls[c][key];
                    if (!l || seen.has(l.id)) continue;
                    seen.add(l.id);
                    const complement = !!l.pairKey && pairMates(l, key) >= 1;
                    if (weeklyTidsOf(l, w, complement).includes(tid)) return l;
                }
                return null;
            }
            let partMinViol = [];
            {
                const minIds = Object.keys(partConfById).filter(tid => partConfById[tid].dayMin > 1);
                const repairWeeks = occT3 ? weekList : [null];

                // 全教員×全週×全曜日の dayMin 違反の総数。
                // ベース週の授業を動かすと全週が同時に動くため、B2週を直す移動が
                // B1週を壊す「もぐら叩き」が起こり得る。移動の採否はこの総数が
                // 確実に減ったかどうかで判定する（2026-07-28）。
                const countAllMinViol = () => {
                    let n = 0;
                    for (const tid of minIds) {
                        const pc = partConfById[tid];
                        for (const w of repairWeeks) {
                            for (const d of DAYS) {
                                const c = teacherOccKeys(tid, w).filter(k => k.split('-')[0] === d).length;
                                if (c > 0 && c < pc.dayMin) n++;
                            }
                        }
                    }
                    return n;
                };

                for (let pass = 0; pass < 3 && minIds.length; pass++) {
                    let progressed = false;
                    for (const tid of minIds) {
                        const pc = partConfById[tid];
                        for (const w of repairWeeks) {
                            for (const d of DAYS) {
                                const dayKeys = teacherOccKeys(tid, w).filter(k => k.split('-')[0] === d);
                                if (!dayKeys.length || dayKeys.length >= pc.dayMin) continue;

                                // --- 手段1: 畳み込み（この週の不足日の授業を別の稼働日へ移して日を空にする）---
                                for (const k of dayKeys) {
                                    const l = lessonAt(tid, k, w);
                                    if (!l || !swappable(l)) continue;
                                    const cid0 = l.classIds[0];
                                    const workDays = new Set(teacherOccKeys(tid, w).map(x => x.split('-')[0]));
                                    const cands = lessonSlots(l).filter(s2 => s2.day !== d)
                                        .sort((a, b) => (workDays.has(b.day) ? 1 : 0) - (workDays.has(a.day) ? 1 : 0));
                                    const before = countAllMinViol();
                                    let moved = false;
                                    undoPlace(l, k);
                                    // まず空きスロットへの移動（全週の違反総数が減ったときだけ採用）
                                    for (const s2 of cands) {
                                        if (!slotValid(l, s2, 'strict', null)) continue;
                                        doPlace(l, s2);
                                        if (countAllMinViol() < before) { moved = true; break; }
                                        undoPlace(l, s2.key);
                                    }
                                    // 置けなければ移動先の授業（この教員が関わらないもの）との入れ替えを試す
                                    if (!moved) {
                                        for (const s2 of cands) {
                                            const M = occCls[cid0][s2.key];
                                            if (!M || !swappable(M) || M.teachers.includes(tid)) continue;
                                            undoPlace(M, s2.key);
                                            if (slotValid(l, s2, 'strict', null)) {
                                                doPlace(l, s2);
                                                if (slotValid(M, slotObjOf(k), 'strict', null)) {
                                                    doPlace(M, slotObjOf(k));
                                                    if (countAllMinViol() < before) { moved = true; break; }
                                                    undoPlace(M, k);
                                                }
                                                undoPlace(l, s2.key);
                                            }
                                            doPlace(M, s2);
                                        }
                                    }
                                    if (!moved) doPlace(l, slotObjOf(k));
                                    else progressed = true;
                                }

                                // --- 手段2: 埋め合わせ（余裕のある日から1コマ、この不足日へ移す）---
                                // 畳み込めない典型は「不足日の授業が動かせない・他の日が受け入れられない」。
                                // その場合は逆に、他の日の授業を不足日へ持ってくる（2026-07-28追加）。
                                const still = teacherOccKeys(tid, w).filter(k2 => k2.split('-')[0] === d).length;
                                if (still > 0 && still < pc.dayMin) {
                                    const donorKeys = teacherOccKeys(tid, w).filter(k2 => {
                                        const d2 = k2.split('-')[0];
                                        if (d2 === d) return false;
                                        return teacherOccKeys(tid, w).filter(k3 => k3.split('-')[0] === d2).length > pc.dayMin;
                                    });
                                    for (const kd of donorKeys) {
                                        const l = lessonAt(tid, kd, w);
                                        if (!l || !swappable(l)) continue;
                                        const cid0 = l.classIds[0];
                                        const before = countAllMinViol();
                                        const targets = lessonSlots(l).filter(s2 => s2.day === d);
                                        let moved = false;
                                        undoPlace(l, kd);
                                        for (const s2 of targets) {
                                            if (!slotValid(l, s2, 'strict', null)) continue;
                                            doPlace(l, s2);
                                            if (countAllMinViol() < before) { moved = true; break; }
                                            undoPlace(l, s2.key);
                                        }
                                        if (!moved) {
                                            // 不足日の授業（この教員が関わらないもの）との入れ替え
                                            for (const s2 of targets) {
                                                const M = occCls[cid0][s2.key];
                                                if (!M || !swappable(M) || M.teachers.includes(tid)) continue;
                                                undoPlace(M, s2.key);
                                                if (slotValid(l, s2, 'strict', null)) {
                                                    doPlace(l, s2);
                                                    if (slotValid(M, slotObjOf(kd), 'strict', null)) {
                                                        doPlace(M, slotObjOf(kd));
                                                        if (countAllMinViol() < before) { moved = true; break; }
                                                        undoPlace(M, kd);
                                                    }
                                                    undoPlace(l, s2.key);
                                                }
                                                doPlace(M, s2);
                                            }
                                        }
                                        if (!moved) { doPlace(l, slotObjOf(kd)); continue; }
                                        progressed = true;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    if (!countAllMinViol() || !progressed) break;
                }

                // 残った違反を表示用に集計
                partMinViol = [];
                for (const tid of minIds) {
                    const pc = partConfById[tid];
                    for (const w of repairWeeks) {
                        for (const d of DAYS) {
                            const left = teacherOccKeys(tid, w).filter(k => k.split('-')[0] === d).length;
                            if (left > 0 && left < pc.dayMin) {
                                const t = teacherById[tid];
                                const wp = w == null ? '' : w + '週 ';
                                partMinViol.push((t ? t.name : tid) + ': ' + wp + (DAY_JP[d] || d) + '曜が ' + left +
                                    ' コマだけです（最低 ' + pc.dayMin + ' コマの設定）');
                            }
                        }
                    }
                }
            }
            stats.partMinViol = partMinViol.length;

            stats.dupFixed = stats.relaxedBefore - relaxedLessons.length;
            const relaxedDups = relaxedLessons.map(lessonName);
            const stuckIds = relaxedLessons.map(l => l.id).concat(unplaced.map(u => u.lesson.id));

            const soft = evaluateSoft(
                state, slots, { occCls, occTeacher }, teacherById, false, teacherEvalOpts
            );

            // 回転枠（変動枠・音美コマ）と学年職員の教科の同曜日重なりを数える（少ない解を優先するため）
            let rotDup = 0;
            absorbInfo.forEach(info => {
                if (!info.subject) return;
                const grid = occCls[info.cid] || {};
                const sDays = new Set(Object.keys(grid).filter(k => grid[k].subject === info.subject).map(k => k.split('-')[0]));
                if (varSlotObj && sDays.has(varSlotObj.day)) rotDup++;
                Object.keys(grid).forEach(k => {
                    if (grid[k].subject === '音美' && sDays.has(k.split('-')[0])) rotDup++;
                });
            });

            // 未配置授業の候補コマ別の阻害要因（最良解の診断用。呼ばれたときだけ計算する）
            function slotBlockers(l, slot) {
                const key = slot.key;
                const out = new Set();
                for (const c of l.classIds) if (occCls[c][key]) out.add('class');
                const mates = pairMates(l, key);
                const complement = !!l.pairKey && mates === 1;
                if (l.pairKey && (mates >= 2 || hasInvalidPairMate(l, key))) out.add('room');
                for (const tid of l.teachers) {
                    if (complement && l.biTeachers && l.biTeachers.includes(tid)) continue;
                    if (naOf[tid] && naOf[tid].has(key)) out.add('na');
                    if (occTeacher[tid] && occTeacher[tid].has(key)) out.add('teacher');
                }
                if (occT3 && !out.has('teacher')) {
                    for (const tid of candidateTidsOf(l, complement)) {
                        if (!weekLimitedTids.has(tid)) continue;
                        if (teacherWeeksFor(l, tid, complement).some(w => teacherOccHas(tid, w, key))) {
                            out.add('teacher');
                            break;
                        }
                    }
                }
                if (!complement) for (const comp of roomComponents(l.subject)) {
                    const cap = capOf(comp);
                    if (cap !== Infinity && ((roomUse[comp] && roomUse[comp][key]) || 0) + l.classIds.length > cap) out.add('room');
                }
                for (const c of l.classIds) {
                    if (classDayConflictSubjects(c, l.subject).some(s =>
                        (dayCount[c + '|' + s + '|' + slot.day] || 0) >= 1) ||
                        classVarDayConflict(c, l.subject, slot.day)) out.add('dayDup');
                }
                if (!l.support) for (const c of l.classIds) {
                    const r = restrict[c] && restrict[c][key];
                    if (r && !r.has(l.subject)) out.add('restrict');
                }
                if (l.support && l.attendees) for (const st of l.attendees) {
                    const E = st.exchangeClass;
                    if (E && occCls[E] && occCls[E][key] && st.subjects && st.subjects[occCls[E][key].subject] === 'exchange') out.add('exchange');
                }
                if (!l.support) for (const c of l.classIds) {
                    const stus = supStudentsByClass[c];
                    if (stus && stus.some(st => st.subjects && st.subjects[l.subject] === 'support' &&
                        !(stuSlots[st.id] && stuSlots[st.id].has(key)))) out.add('sync');
                }
                for (const tid of candidateTidsOf(l, complement)) {
                    const pc = partConfById[tid];
                    if (!pc) continue;
                    if (pc.amOnly && slot.period >= 5) out.add('part');
                    else if (pc.prepWeek != null && partWeekGapsAfter(l, tid, slot, complement) > pc.prepWeek) out.add('part');
                    else if (pc.dayMax > 0 && teacherWeeksFor(l, tid, complement).some(w =>
                        dayCountAfter(tid, slot, w) > pc.dayMax)) out.add('part');
                }
                if (hardSet.size && violatesHard(l, slot, key, complement)) out.add('hard');
                return [...out];
            }
            function analyzeUnplaced() {
                return unplaced.slice(0, 3).map(u => {
                    const grid = {};
                    lessonSlots(u.lesson).forEach(s => { grid[s.key] = slotBlockers(u.lesson, s); });
                    return { name: lessonName(u.lesson), grid };
                });
            }

            return { occCls, occTeacher, restrict, stuSlots, unplaced, relaxedDups, rotDup, partMinViol, soft, stuckIds, stats, analyzeUnplaced };
        }

        const REASON_JP = { exchange: '交流学級の授業と重なる', teacherBusy: '担当教員が他の授業と重なる',
                            teacherNA: '担当教員の出講不可', classBusy: '学級の空きコマがない',
                            room: '特別教室の空きがない', dayDup: '同じ教科が同日に重なる',
                            restrict: '支援学級との交流条件（許可教科の制限）に合わない',
                            hardCond: '「絶対」に格上げした条件に合わない',
                            partCond: '非常勤の個別条件（午前のみ・準備時間・1日のコマ数）に合わない',
                            syncCond: '支援生徒が支援学級にいない時刻のため、支援で受ける教科を置けない' };
        function failReason(reasons) {
            const top = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0];
            return '配置できるコマがありません（主な要因: ' + (top && top[1] > 0 ? REASON_JP[top[0]] : '不明') + '）';
        }
        function failReasonShort(reasons) {
            const top = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0];
            return top && top[1] > 0 ? REASON_JP[top[0]] : '不明';
        }

        /* ----- 多スタート: (未配置, 緩和+回転重複, ソフト違反) の辞書順で最良を選ぶ -----
           未配置・重複が残る限り時間予算いっぱいまで試行を繰り返す。
           ハード的に完全な解（未配置0・重複0）が見つかったら、その後 softExtraMs だけ
           ソフト条件の改善を続けて打ち切る。onProgress で試行回数を通知し、
           shouldCancel が true を返したら中断して最良解を返す */
        const t0 = Date.now();
        let round = 1;
        let roundStartedAt = t0;
        let roundHardBest = null;
        let lastHardImproveAttempt = 0;
        const softExtraMs = opts.softExtraMs != null ? opts.softExtraMs : 6000;
        const batch = opts.batchSize || 25;
        const tick = uiTick;
        function lexLess(a, b) {
            for (let i = 0; i < a.length; i++) {
                if (a[i] !== b[i]) return a[i] < b[i];
            }
            return false;
        }
        const sortBests = arr => arr.sort((x, y) => (lexLess(x.key, y.key) ? -1 : lexLess(y.key, x.key) ? 1 : 0));
        // 配置の違い（授業の入っているセルの差の数）: ベスト3案の「毛色の違う案」判定に使う
        function solDiffCount(a, b) {
            let d = 0, tot = 0;
            for (const cid of Object.keys(a.occCls)) {
                const ga = a.occCls[cid], gb = b.occCls[cid] || {};
                const keys = new Set(Object.keys(ga).concat(Object.keys(gb)));
                keys.forEach(k => {
                    tot++;
                    const x = ga[k], y = gb[k];
                    if (!x || !y || x.id !== y.id) d++;
                });
            }
            return { d, tot };
        }
        const bests = [];  // ベスト3案（key 昇順。互いに配置が12%以上異なるものだけ保持）
        let attempts = 0, hardPerfectAt = null;
        let previewAt = 0;  // ライブプレビュー構築も300msに1回だけ
        let lastMainTickAt = t0;  // 最後にUIへ制御を返した時刻（大規模校で1試行が重い場合の保険）
        // 直近の最良解で詰まった授業 → 次の試行で最優先配置。
        // opts.initialBoostIds で前回の実行の詰まりを引き継げる（「もう一度組む」の学習）
        let boostIds = new Set(opts.initialBoostIds || []);
        function considerBest(res, key, seedVal, attemptIndex) {
            if (bests.length >= 3 && lexLess(bests[bests.length - 1].key, key)) return;
            const cand = { ...res, key, seed: seedVal, attemptIndex };
            for (let i = 0; i < bests.length; i++) {
                const { d, tot } = solDiffCount(cand, bests[i]);
                if (d / Math.max(1, tot) < 0.12) {
                    // ほぼ同じ配置 → より良ければ置き換えるだけ（別案としては数えない）
                    if (lexLess(key, bests[i].key)) { bests[i] = cand; sortBests(bests); }
                    return;
                }
            }
            bests.push(cand);
            sortBests(bests);
            if (bests.length > 3) bests.length = 3;
        }
        // 終盤の詰将棋（1コマに数秒かかる）からの進捗通知。多スタートの通知と同じ形にそろえ、
        // 「終盤の詰将棋 3/8 コマ」を足す。動いていることが伝わればリロードされない。
        const reportEndgame = (done, total) => {
            if (!opts.onProgress) return;
            opts.onProgress({
                attempts, elapsedMs: Date.now() - t0,
                bestKey: bests.length ? bests[0].key.slice() : null,
                maxAttempts, budgetMs, round,
                stagnantAttempts: attempts - lastHardImproveAttempt,
                stagnationLimit: STAGNATION_LIMIT,
                endgame: { done, total }
            });
        };
        while (attempts < maxAttempts) {
            const now = Date.now();
            if (now - t0 >= budgetMs) break;
            if (hardPerfectAt != null && now - hardPerfectAt >= softExtraMs) break;
            if (opts.shouldCancel && opts.shouldCancel()) break;
            const seed = baseSeed + attempts * 7919;
            const rng = mulberry32(seed);
            // ブーストは半分の試行だけ使う（探索の多様性も残す）。
            // フェーズ順（支援先行/タイト教員先行）は2試行ごとに交互に試す
            const res = await attempt(rng, (attempts % 2 === 0 && boostIds.size) ? boostIds : null,
                                      ((attempts >> 1) & 1) === 1, reportEndgame);
            attempts++;
            if (res.stuckIds.length) boostIds = new Set(res.stuckIds);
            // 辞書順ベクトル: [未配置, 物理残（同日重複+週替わり重なり+絶対の非常勤最低コマ違反×3）,
            //                  条件1の違反数, 条件2の違反数, ...]（統一優先順位の順）
            // 上位の違反を1件減らすことが、下位の違反を何件増やしても優先される
            const key = [res.unplaced.length, res.relaxedDups.length + res.rotDup + res.partMinViol.length * 3]
                .concat(res.soft.breakdown.map(b => b.violations));
            considerBest(res, key, seed, attempts);
            const bk = bests[0].key;
            const hardKey = [bk[0], bk[1]];
            if (roundHardBest === null ||
                hardKey[0] < roundHardBest[0] ||
                (hardKey[0] === roundHardBest[0] && hardKey[1] < roundHardBest[1])) {
                roundHardBest = hardKey;
                lastHardImproveAttempt = attempts;
            }
            const afterAttemptNow = Date.now();
            if ((bk[0] > 0 || bk[1] > 0) &&
                attempts - lastHardImproveAttempt >= STAGNATION_LIMIT &&
                afterAttemptNow - roundStartedAt >= MIN_ROUND_MS &&
                budgetMs - (afterAttemptNow - t0) > MIN_ROUND_MS) {
                round++;
                baseSeed = originalBaseSeed + (round - 1) * 104729;
                boostIds = new Set((bests[0] && bests[0].stuckIds) || []);
                roundStartedAt = afterAttemptNow;
                roundHardBest = null;
                lastHardImproveAttempt = attempts;
            }
            // 全成分0＋3案そろったらこれ以上良くならない
            if (bests.length >= 3 && bk.every(x => x === 0)) break;
            if (bk[0] === 0 && bk[1] === 0 && hardPerfectAt == null) hardPerfectAt = Date.now();
            // 大規模校では1試行が重く、batch（25試行）ぶんまとめて回ると数秒固まる。
            // 試行回数と経過時間の両方で区切り、少なくとも120msに1回はUIへ制御を返す。
            if (attempts % batch === 0 || Date.now() - lastMainTickAt >= 120) {
                lastMainTickAt = Date.now();
                if (opts.onProgress) {
                    const progress = { attempts, elapsedMs: Date.now() - t0, bestKey: bests[0].key.slice(), maxAttempts, budgetMs,
                                       round, stagnantAttempts: attempts - lastHardImproveAttempt,
                                       stagnationLimit: STAGNATION_LIMIT, previewKey: key.slice(),
                                       ejections: res.stats.ejections || 0 };

                    // B/A盤面の構築は300ms間引き内だけで行う。探索の各試行では作らない。
                    if (Date.now() - previewAt >= 300) {
                        previewAt = Date.now();

                        // B週はベース盤面に変動枠を加える。A週はB週を複製後、音美と変動枠を差し替える。
                        const previewB = {};
                        Object.keys(res.occCls).forEach(cid => {
                            Object.keys(res.occCls[cid]).forEach(k => {
                                previewB[cid + '|' + k] = res.occCls[cid][k].subject;
                            });
                        });
                        const previewA = { ...previewB };
                        const subjectOfGradeStaff = cid =>
                            absorbMap[cid] || gradeStaffSubjectOfClass(state, cid, staffPlan) || '学職';
                        const subjectOfVar = (cid, week) => {
                            const grade = gradeOf(cid);
                            let subject = (((state.varContent || {})[week] || {})[grade]) || '学年職員の教科';
                            if (subject === VAR_UNUSED || subject === '学年職員の教科') {
                                subject = subjectOfGradeStaff(cid);
                            }
                            return subject;
                        };

                        if (varSlotObj) {
                            Object.keys(res.occCls).forEach(cid => {
                                const grade = gradeOf(cid);
                                if (!gradeVar[grade]) return;
                                const key = cid + '|' + varSlotObj.key;
                                // varContent のキーは 'A' / 'B1' / 'B2'。'B' というキーは存在しないため、
                                // B週側は実際のラベル（既定 'B1'）で引く。'B' を渡すと値が取れず
                                // 「学年職員の教科」にフォールバックし、2・3年の総合まで担任の授業に化ける。
                                previewB[key] = subjectOfVar(cid, bWeekLabels[0] || 'B1');
                                previewA[key] = subjectOfVar(cid, 'A');
                            });
                        }

                        Object.keys(res.occCls).forEach(cid => {
                            Object.keys(res.occCls[cid]).forEach(k => {
                                if (res.occCls[cid][k].subject === '音美') {
                                    previewA[cid + '|' + k] = subjectOfGradeStaff(cid);
                                }
                            });
                        });

                        progress.preview = { B: previewB, A: previewA };
                    }
                    opts.onProgress(progress);
                }
                await tick();  // UIを固めない（アニメーション・キャンセル操作のため）
            }
        }
        const best = bests[0];

        if (best.relaxedDups.length) {
            report.warnings.push('同じ教科が同日に2コマ入った授業があります（他に空きがなかったため）: ' + [...new Set(best.relaxedDups)].join('、'));
        }
        if (best.partMinViol && best.partMinViol.length) {
            best.partMinViol.forEach(v => {
                report.warnings.push('⚠ 非常勤の最低コマ数: ' + v + '。移し替えでも解消できませんでした。');
            });
            report.suggestions.push('非常勤の「1日の最低コマ数」を下げる（Step 5a）か、その教員の担当コマを増やす・出講不可を減らすと解消できる可能性があります。');
        }

        // 変動枠の週ごとの整合チェック（教員・教室・同日重複・体育）。範囲外の位置ならスキップ（エラー済み）
        const varUnassigned = (hasVar && varSlotValid) ? checkVarSlot(state, best, report, { capOf, staffPlan }) : 0;

        // 学年職員の教科の充当がある学級: 回転枠と同じ曜日に学年職員の教科が入っていないか（週によって同日2コマ化）
        absorbInfo.forEach(info => {
            if (!info.subject) return;
            const grid = best.occCls[info.cid] || {};
            const daysOf = sub => new Set(Object.keys(grid).filter(k => grid[k].subject === sub).map(k => k.split('-')[0]));
            const sDays = daysOf(info.subject);
            if (varSlotObj && gradeUsesVar(state, gradeOf(info.cid)) && sDays.has(varSlotObj.day)) {
                const hasHrWeeks = weekLabels(state).some(w => ((((state.varContent || {})[w]) || {})[gradeOf(info.cid)] || '学年職員の教科') === '学年職員の教科');
                if (hasHrWeeks) report.warnings.push(info.cid + ': ' + DAY_JP[varSlotObj.day] + '曜に「' + info.subject + '」があるため、変動枠が学年職員の教科になる週は同日2コマになります。');
            }
            daysOf('音美').forEach(d => {
                if (sDays.has(d)) report.warnings.push(info.cid + ': ' + DAY_JP[d] + '曜に「' + info.subject + '」と音美が同日のため、A週は「' + info.subject + '」が同日2コマになります。');
            });
        });

        // グリッド化（案ごとに使うので関数化）
        function gridCellsOf(sol) {
            const out = {};
            Object.keys(sol.occCls).forEach(cid => {
                Object.keys(sol.occCls[cid]).forEach(key => {
                    const l = sol.occCls[cid][key];
                    const [day, period] = [key.split('-')[0], Number(key.split('-')[1])];
                    out[cid + '|' + day + '|' + period] = {
                        subject: l.subject, teacherIds: l.teachers, support: !!l.support,
                        lessonId: l.id, classIds: l.classIds,
                        pairKey: l.pairKey || null,       // 隔週交代教科の逆位相ペア判定用
                        aHomeroom: l.aHomeroom || null,   // 音美: A週にこのコマを担当する担任
                        // 音美の位相: 0 = B1週に音楽（担当1人目）、1 = B1週に美術
                        phase: (l.subject === '音美' && onbiPhases[l.id] != null) ? onbiPhases[l.id] : null
                    };
                });
            });
            return out;
        }
        const cells = gridCellsOf(best);

        /* ----- A週の構築（音美コマ→学年職員の教科）と、ズレ許容モードでの差分最小修復 ----- */
        function buildAWeekResult(sol) {
            if (!hasVar || !varSlotValid) return null;
            // B週グリッドの複製
            const grid = {};   // cid -> slotKey -> セル
            Object.keys(sol.occCls).forEach(cid => {
                grid[cid] = {};
                Object.keys(sol.occCls[cid]).forEach(k => {
                    const l = sol.occCls[cid][k];
                    grid[cid][k] = { subject: l.subject, teachers: l.teachers.slice(), support: !!l.support,
                                     roomLimited: !!l.roomLimited, pairKey: l.pairKey || null,
                                     biTeachers: l.biTeachers || null,
                                     fixed: !!l.fixedSlot || editImmovable.has(l.id),
                                     lessonId: l.id, fromOnbi: false };
                });
            });
            // 音美コマ → 学年職員の教科（充当）へ差し替え。
            // 完全一致モードでは学年職員の空きを予約済みなので教員の重なりは起きない
            let replacedCount = 0;
            Object.keys(grid).forEach(cid => {
                Object.keys(grid[cid]).forEach(k => {
                    if (grid[cid][k].subject !== '音美') return;
                    const base = sol.occCls[cid][k];
                    const aSub = absorbMap[cid] || gradeStaffSubjectOfClass(state, cid, staffPlan);
                    const aTid = base.aHomeroom || gradeStaffTeacherOfClass(state, cid, aSub, staffPlan);
                    grid[cid][k] = { subject: aSub || '学年職員の教科', teachers: aTid ? [aTid] : [], support: false,
                                     roomLimited: aSub ? isRoomLimited(aSub) : false, pairKey: null, biTeachers: null,
                                     fixed: false, lessonId: 'aw:' + cid + ':' + k, fromOnbi: true };
                    replacedCount++;
                });
            });
            if (!replacedCount) return null;   // 音美がない → A週はB週と同じ（変動枠を除く）

            // A週の整合チェック（教員の重なり・出講不可・教室・同日重複・支援制限）
            function teacherConflict(tid, k) {
                let count = 0;
                const seenPair = new Set();
                for (const cid of Object.keys(grid)) {
                    const cell = grid[cid][k];
                    if (!cell || !cell.teachers.includes(tid)) continue;
                    if (cell.pairKey && cell.biTeachers && cell.biTeachers.includes(tid)) {
                        if (seenPair.has(cell.pairKey)) continue;  // 逆位相ペアは1コマ分
                        seenPair.add(cell.pairKey);
                    }
                    count++;
                }
                return count;
            }
            function roomOverAt(k) {
                const use = {};
                const seenPair = new Set();
                for (const cid of Object.keys(grid)) {
                    const cell = grid[cid][k];
                    if (!cell) continue;
                    if (cell.pairKey) { if (seenPair.has(cell.pairKey)) continue; seenPair.add(cell.pairKey); }
                    roomComponents(cell.subject).forEach(comp => {
                        if (capOf(comp) === Infinity) return;
                        use[comp] = (use[comp] || 0) + 1;
                    });
                }
                return Object.keys(use).some(comp => use[comp] > capOf(comp));
            }
            // 修復中の A週グリッドから、指定教員の日別時限を必要な教員だけ導出する。
            // 同一授業が複数学級セルに見えても Set で1コマにまとめ、変動枠担当は varSlot も加える。
            function teacherDaysOf(tid, cache) {
                if (cache && cache.has(tid)) return cache.get(tid);
                const byDay = {};
                const add = (day, period) => {
                    (byDay[day] = byDay[day] || new Set()).add(Number(period));
                };
                Object.keys(grid).forEach(cid => {
                    Object.keys(grid[cid]).forEach(k => {
                        const cell = grid[cid][k];
                        if (!cell || !cell.teachers.includes(tid)) return;
                        const seg = k.split('-');
                        add(seg[0], seg[1]);
                    });
                });
                if (varSlotObj && varDutyTids.has(tid)) add(varSlotObj.day, varSlotObj.period);
                if (cache) cache.set(tid, byDay);
                return byDay;
            }
            function teacherHardIssuesAt(tid, k, cache) {
                const t = teacherById[tid];
                const pc = partConfById[tid];
                const checkNoGap = hardSet.has('no_gap_zero_day') &&
                    (!t || t.type !== 'part') && !noGapExempt.has(tid) &&
                    teacherCondWeightOf(state, 'no_gap_zero_day', tid) > 0;
                if (!checkNoGap && !pc) return [];
                const seg = k.split('-');
                const day = seg[0], period = Number(seg[1]);
                const byDay = teacherDaysOf(tid, cache);
                const today = byDay[day] || new Set();
                const out = [];
                if (checkNoGap) {
                    const max = Number(state.skeleton.periods[day]) || 0;
                    if (max > 0 && today.size >= max) out.push('空きコマゼロ');
                }
                if (pc) {
                    if (pc.amOnly && period >= 5) out.push('非常勤の午後配置');
                    if (pc.dayMax > 0 && today.size > pc.dayMax) out.push('非常勤の1日上限');
                    if (pc.prepWeek != null) {
                        let gaps = 0;
                        Object.keys(byDay).forEach(d => { gaps += dailyGap([...byDay[d]]); });
                        if (gaps > pc.prepWeek) out.push('非常勤の準備時間');
                    }
                }
                return out;
            }
            function cellIssues(cid, k, teacherCache) {
                const cell = grid[cid][k];
                if (!cell) return [];
                const out = [];
                for (const tid of cell.teachers) {
                    if (naOf[tid] && naOf[tid].has(k)) out.push('出講不可');
                    if (teacherConflict(tid, k) > 1) out.push('教員の重なり');
                    out.push(...teacherHardIssuesAt(tid, k, teacherCache));
                }
                const day = k.split('-')[0];
                const hasDayConflict = Object.keys(grid[cid]).some(k2 =>
                    k2 !== k && k2.split('-')[0] === day &&
                    classDayConflict(cid, cell.subject, grid[cid][k2].subject));
                if (hasDayConflict || classVarDayConflict(cid, cell.subject, day)) out.push('同日重複');
                if (cell.roomLimited && roomOverAt(k)) out.push('教室不足');
                const r = sol.restrict && sol.restrict[cid] && sol.restrict[cid][k];
                if (r && !cell.support && !r.has(cell.subject)) out.push('支援制限');
                if (!cell.support) {
                    const stus = supStudentsByClass[cid];
                    if (stus && stus.some(st => st.subjects && st.subjects[cell.subject] === 'support' &&
                        !(sol.stuSlots && sol.stuSlots[st.id] && sol.stuSlots[st.id].has(k)))) out.push('支援同期');
                }
                return [...new Set(out)];
            }
            function allViolations() {
                const v = [];
                const teacherCache = new Map();
                Object.keys(grid).forEach(cid => Object.keys(grid[cid]).forEach(k => {
                    const iss = cellIssues(cid, k, teacherCache);
                    if (iss.length) v.push({ cid, k, subject: grid[cid][k].subject, issues: iss });
                }));
                return v;
            }

            // ズレ許容モード: 違反セルを同学級内の移動・交換で修復（repair=そのまま列挙順 / free も同じ仕組み）
            let repairMoves = 0;
            // 合同授業を学級ごとに分断しないよう、複数学級で共有する lessonId は動かさない。
            const lessonCellCount = {};
            Object.keys(grid).forEach(cid => Object.keys(grid[cid]).forEach(k => {
                const id = grid[cid][k].lessonId;
                lessonCellCount[id] = (lessonCellCount[id] || 0) + 1;
            }));
            const movable = (cid, k) => {
                const cell = grid[cid][k];
                return cell && !cell.fixed && !cell.support && !cell.pairKey &&
                    lessonCellCount[cell.lessonId] === 1;
            };
            function trySwap(cid, k1, k2) {
                const g = grid[cid];
                const a = g[k1], b = g[k2];
                if (b) { g[k1] = b; g[k2] = a; } else { delete g[k1]; g[k2] = a; }
                const teacherCache = new Map();
                const bad = cellIssues(cid, k2, teacherCache).length +
                    (b ? cellIssues(cid, k1, teacherCache).length : 0);
                if (bad === 0) return true;
                if (b) { g[k1] = a; g[k2] = b; } else { g[k1] = a; delete g[k2]; }
                return false;
            }
            // 3コマ巡回（a→k2, b→k3, c→k1）。2コマ交換で直らない違反の受け皿
            function tryRotate(cid, k1, k2, k3) {
                const g = grid[cid];
                const a = g[k1], b = g[k2], c = g[k3];
                if (!b || !c) return false;
                g[k2] = a; g[k3] = b; g[k1] = c;
                const teacherCache = new Map();
                const bad = cellIssues(cid, k1, teacherCache).length +
                    cellIssues(cid, k2, teacherCache).length +
                    cellIssues(cid, k3, teacherCache).length;
                if (bad === 0) return true;
                g[k1] = a; g[k2] = b; g[k3] = c;
                return false;
            }
            if (abMode !== 'exact') {
                for (let pass = 0; pass < 4; pass++) {
                    const viols = allViolations();
                    if (!viols.length) break;
                    let progressed = false;
                    for (const v of viols) {
                        if (!movable(v.cid, v.k)) continue;
                        if (!cellIssues(v.cid, v.k).length) continue;  // 先の修復で直っている
                        let done = false;
                        for (const s of slots) {
                            const k2 = s.key;
                            if (k2 === v.k) continue;
                            const other = grid[v.cid][k2];
                            if (other && !movable(v.cid, k2)) continue;
                            if (trySwap(v.cid, v.k, k2)) { done = true; repairMoves++; break; }
                        }
                        if (!done) {
                            outer:
                            for (const s2 of slots) {
                                if (s2.key === v.k || !movable(v.cid, s2.key)) continue;
                                for (const s3 of slots) {
                                    if (s3.key === v.k || s3.key === s2.key || !movable(v.cid, s3.key)) continue;
                                    if (tryRotate(v.cid, v.k, s2.key, s3.key)) { done = true; repairMoves += 2; break outer; }
                                }
                            }
                        }
                        if (done) progressed = true;
                    }
                    if (!progressed) break;
                }
            }

            // A週の非常勤 dayMin は、配置が確定してから不足日を別の稼働日へ畳み込む。
            // 交換相手を含む受け入れ可否は、上の拡張済み cellIssues で再検証する。
            const minPartTids = Object.keys(partConfById)
                .filter(tid => partConfById[tid].dayMin > 1);
            function collectDayMinViolations() {
                const out = [];
                const cache = new Map();
                minPartTids.forEach(tid => {
                    const pc = partConfById[tid];
                    const byDay = teacherDaysOf(tid, cache);
                    DAYS.forEach(d => {
                        const n = byDay[d] ? byDay[d].size : 0;
                        if (n <= 0 || n >= pc.dayMin) return;
                        const t = teacherById[tid];
                        out.push(((t && t.name) || tid) + ': A週 ' + (DAY_JP[d] || d) +
                            '曜が' + n + 'コマだけ（最低' + pc.dayMin + 'コマ）');
                    });
                });
                return out;
            }
            if (abMode !== 'exact' && minPartTids.length) {
                // trySwap の検証（cellIssues）は dayMin を見ないため、修復の玉突きで
                // 別の非常勤に新しい「1コマだけの日」を作っても気づかない。
                // dayMin 違反の総数が確実に減った場合だけ採用し、減らなければ元へ戻す（2026-07-28）。
                function guardedSwap(cid, k1, k2) {
                    const before = collectDayMinViolations().length;
                    const g = grid[cid];
                    const a = g[k1], b = g[k2];
                    if (!trySwap(cid, k1, k2)) return false;
                    if (collectDayMinViolations().length < before) return true;
                    if (b) { g[k1] = a; g[k2] = b; } else { g[k1] = a; delete g[k2]; }
                    return false;
                }
                const periodsOf = d => Number(state.skeleton.periods[d]) || 0;
                for (let pass = 0; pass < 3; pass++) {
                    let progressed = false;
                    for (const tid of minPartTids) {
                        const pc = partConfById[tid];
                        for (const d of DAYS) {
                            const byDay = teacherDaysOf(tid);
                            const n = byDay[d] ? byDay[d].size : 0;
                            if (n <= 0 || n >= pc.dayMin) continue;

                            // --- 手段1: 畳み込み（不足日の授業をよそへ動かして日を空にする）---
                            const sources = [];
                            Object.keys(grid).forEach(cid => {
                                Object.keys(grid[cid]).forEach(k => {
                                    const cell = grid[cid][k];
                                    if (k.split('-')[0] === d && movable(cid, k) &&
                                        cell.teachers.includes(tid)) sources.push({ cid, k });
                                });
                            });
                            // 固定・支援・合同授業や変動枠が残る日は、途中まで動かして悪化させない。
                            const movablePeriods = new Set(
                                sources.map(src => Number(src.k.split('-')[1]))
                            );
                            let fixed = false;
                            if (movablePeriods.size >= n) {
                                let movedAll = true;
                                for (const src of sources) {
                                    const cell = grid[src.cid][src.k];
                                    if (!cell || !cell.teachers.includes(tid)) continue;
                                    const current = teacherDaysOf(tid);
                                    // 受け入れ先: 稼働中の別の日のうち、まだ空き時限が残る日だけ。
                                    // （満杯の日は教員の重なりで必ず失敗するので最初から除く）
                                    const targetDays = new Set(Object.keys(current).filter(d2 =>
                                        d2 !== d && current[d2].size > 0 &&
                                        current[d2].size < periodsOf(d2)));
                                    if (!targetDays.size) { movedAll = false; break; }
                                    const cands = slots.filter(s => targetDays.has(s.day))
                                        .sort((a, b) => {
                                            const an = current[a.day] ? current[a.day].size : 0;
                                            const bn = current[b.day] ? current[b.day].size : 0;
                                            return bn - an || a.period - b.period;
                                        });
                                    let moved = false;
                                    for (const s2 of cands) {
                                        const other = grid[src.cid][s2.key];
                                        if (other && (!movable(src.cid, s2.key) ||
                                            other.teachers.includes(tid))) continue;
                                        if (guardedSwap(src.cid, src.k, s2.key)) {
                                            moved = true;
                                            progressed = true;
                                            repairMoves++;
                                            break;
                                        }
                                    }
                                    if (!moved) movedAll = false;
                                }
                                fixed = movedAll && (() => {
                                    const now = teacherDaysOf(tid);
                                    const m = now[d] ? now[d].size : 0;
                                    return m === 0 || m >= pc.dayMin;
                                })();
                            }

                            // --- 手段2: 埋め合わせ（多い日から1コマ持ってきて最低数まで増やす）---
                            // 畳み込みが失敗する典型は「他の稼働日が全部ぎっしりで受け入れられない」。
                            // その場合は逆に、余裕のある日から不足日へ授業を移す（2026-07-28追加）。
                            if (!fixed) {
                                const current = teacherDaysOf(tid);
                                // 提供元: dayMin を超えて持っている日（1コマ渡しても違反にならない日）
                                const donorDays = Object.keys(current)
                                    .filter(d2 => d2 !== d && current[d2].size > pc.dayMin)
                                    .sort((a, b) => current[b].size - current[a].size);
                                let need = pc.dayMin - n;
                                for (const d2 of donorDays) {
                                    if (need <= 0) break;
                                    const donors = [];
                                    Object.keys(grid).forEach(cid => {
                                        Object.keys(grid[cid]).forEach(k => {
                                            const cell = grid[cid][k];
                                            if (k.split('-')[0] === d2 && movable(cid, k) &&
                                                cell.teachers.includes(tid)) donors.push({ cid, k });
                                        });
                                    });
                                    for (const donor of donors) {
                                        if (need <= 0) break;
                                        const targets = slots.filter(s => s.day === d);
                                        let moved = false;
                                        for (const s2 of targets) {
                                            const other = grid[donor.cid][s2.key];
                                            if (other && (!movable(donor.cid, s2.key) ||
                                                other.teachers.includes(tid))) continue;
                                            if (guardedSwap(donor.cid, donor.k, s2.key)) {
                                                moved = true;
                                                progressed = true;
                                                repairMoves++;
                                                need--;
                                                break;
                                            }
                                        }
                                        if (moved && (teacherDaysOf(tid)[d2] || new Set()).size <= pc.dayMin) break;
                                    }
                                }
                            }
                        }
                    }
                    if (!collectDayMinViolations().length || !progressed) break;
                }
            }
            // --- 手直し: A週専用コマ（充当など）の指定位置への移動 ---
            // 充当コマはB週に存在しないため「両週共通の移動」ができない。
            // A週の中だけの移動（設計方針「どうしてもダメなら片方だけ動かす」）として、
            // 同学級内の入れ替え（trySwap＝全条件を再検証）で指定位置へ動かす。
            const awPinFailed = [];
            const awPins = (opts.editSeed && opts.editSeed.awPins) || [];
            if (abMode !== 'exact') awPins.forEach(pin => {
                let cur = null, ccid = null;
                Object.keys(grid).forEach(cid => Object.keys(grid[cid]).forEach(k => {
                    if (grid[cid][k].lessonId === pin.lessonId) { cur = k; ccid = cid; }
                }));
                if (!cur) { awPinFailed.push('対象のコマが見つかりません'); return; }
                const tk = pin.day + '-' + pin.period;
                if (cur === tk) return;
                if (!movable(ccid, cur)) { awPinFailed.push('このコマは動かせません（固定・ペア等）'); return; }
                const occ = grid[ccid][tk];
                if (occ && !movable(ccid, tk)) {
                    awPinFailed.push((DAY_JP[pin.day] || pin.day) + pin.period + '限のコマ（' + occ.subject + '）が動かせない種類（固定・支援・ペア）のため入れ替えできません');
                    return;
                }
                // ①まず直接の入れ替え
                if (trySwap(ccid, cur, tk)) return;
                // ②玉突き: 行き先の授業を先に別のマスへ逃がしてから入れる（2手・全通り試す）
                let tried = 1;
                let done = false;
                if (occ) {
                    for (const s2 of slots) {
                        const k2 = s2.key;
                        if (k2 === tk || k2 === cur) continue;
                        const there = grid[ccid][k2];
                        if (there && !movable(ccid, k2)) continue;
                        if (!trySwap(ccid, tk, k2)) continue;   // 逃がす（全条件を再検証）
                        tried++;
                        if (trySwap(ccid, cur, tk)) { done = true; break; }
                        trySwap(ccid, k2, tk);                  // 逃がした分を戻す（元は正当な配置なので必ず通る）
                    }
                }
                if (done) return;
                // ③クラス横断の押しのけ: 行き先の時刻に「同じ先生の他クラスの授業」が居て
                //   入れないケース（例: 森の充当理科を火1へ→森が火1に3年を教えている）。
                //   その衝突コマを自分のクラス内でよそへ逃がしてから、あらためて入れる。
                //   （本体の詰将棋はクラス横断で押しのけるのに、A週内だけ出来ないのは不公平だった）
                const moverTeachers = ((grid[ccid] || {})[cur] || {}).teachers || [];
                for (const cid2 of Object.keys(grid)) {
                    if (done) break;
                    if (cid2 === ccid) continue;
                    const cell2 = grid[cid2][tk];
                    if (!cell2 || !movable(cid2, tk)) continue;
                    if (!(cell2.teachers || []).some(t2 => moverTeachers.includes(t2))) continue;
                    for (const s3 of slots) {
                        const k3 = s3.key;
                        if (k3 === tk) continue;
                        const there3 = grid[cid2][k3];
                        if (there3 && !movable(cid2, k3)) continue;
                        if (!trySwap(cid2, tk, k3)) continue;   // 衝突コマを逃がす（全条件を再検証）
                        tried++;
                        if (trySwap(ccid, cur, tk)) { done = true; break; }
                        // 主役側の行き先がまだ埋まっていれば、同クラスの玉突きも重ねて試す
                        const occNow = grid[ccid][tk];
                        if (occNow) {
                            let inner = false;
                            for (const s4 of slots) {
                                const k4 = s4.key;
                                if (k4 === tk || k4 === cur) continue;
                                const th4 = grid[ccid][k4];
                                if (th4 && !movable(ccid, k4)) continue;
                                if (!trySwap(ccid, tk, k4)) continue;
                                if (trySwap(ccid, cur, tk)) { inner = true; break; }
                                trySwap(ccid, k4, tk);
                            }
                            if (inner) { done = true; break; }
                        }
                        trySwap(cid2, k3, tk);   // 逃がした分を戻す（元は正当な配置なので必ず通る）
                    }
                }
                if (done) return;
                // ④ダメだった理由を具体的に診断（仮に置いてみて、何に引っかかるかを集める）
                const g = grid[ccid];
                const a0 = g[cur], b0 = g[tk];
                if (b0) { g[cur] = b0; g[tk] = a0; } else { delete g[cur]; g[tk] = a0; }
                const tc = new Map();
                const issues = new Set(cellIssues(ccid, tk, tc).concat(b0 ? cellIssues(ccid, cur, tc) : []));
                if (b0) { g[cur] = a0; g[tk] = b0; } else { g[cur] = a0; delete g[tk]; }
                awPinFailed.push((DAY_JP[pin.day] || pin.day) + pin.period + '限には置けません' +
                    '（引っかかった条件: ' + ([...issues].join('・') || '不明') + '）。' +
                    '行き先の授業を逃がす玉突き・同じ先生の他クラスのコマを逃がす押しのけも ' + tried +
                    ' 通り試しましたが、すべて条件に合いませんでした');
            });

            const dayMinViolations = collectDayMinViolations();

            // 差分の集計と出力セル
            const aCells = {};
            let totalDiff = 0;
            Object.keys(grid).forEach(cid => {
                const keys = new Set(Object.keys(grid[cid]).concat(Object.keys(sol.occCls[cid] || {})));
                keys.forEach(k => {
                    const cell = grid[cid][k];
                    const baseCell = (sol.occCls[cid] || {})[k];
                    const differs = !cell || !baseCell || cell.lessonId !== baseCell.id;
                    if (differs) totalDiff++;
                    if (!cell) return;
                    const [day, period] = [k.split('-')[0], Number(k.split('-')[1])];
                    aCells[cid + '|' + day + '|' + period] = {
                        subject: cell.subject, teacherIds: cell.teachers, support: cell.support,
                        lessonId: cell.lessonId, moved: differs
                    };
                });
            });
            const violations = allViolations().map(v =>
                v.cid + ' ' + (DAY_JP[v.k.split('-')[0]] || '') + v.k.split('-')[1] + '限「' + v.subject + '」: ' + v.issues.join('・'));
            dayMinViolations.forEach(v => violations.push(v));
            return { cells: aCells, mode: abMode, replacedCount, totalDiff,
                     extraDiff: Math.max(0, totalDiff - replacedCount), repairMoves, violations,
                     awPinFailed };
        }

        const aWeek = buildAWeekResult(best);
        if (aWeek) {
            if (aWeek.violations.length) {
                if (abMode === 'exact') {
                    report.warnings.push('A週（音美コマ→学年職員の授業）にそのままでは成立しないコマがあります: ' + aWeek.violations.join(' ／ ') +
                        '。「A週とB週のズレ」を「少しずらしてもよい」にすると自動で調整します（Step 9）。');
                    report.suggestions.push('「A週とB週のズレ」を「少しずらしてもよい」にすると、A週の重なりを数コマの入れ替えで自動調整できます（Step 9）。');
                } else {
                    report.warnings.push('A週の調整でも解消できなかったコマがあります: ' + aWeek.violations.join(' ／ ') + '。手動ボードでの微調整を推奨します。');
                }
            }
            if (abMode !== 'exact' && aWeek.extraDiff > 0) {
                report.warnings.push('A週はB週から音美コマの差し替え（' + aWeek.replacedCount + 'コマ）に加えて ' + aWeek.extraDiff +
                    'コマ入れ替えて調整しました（一覧表のA週で確認できます）。');
            }
        }

        // 未配置も含めた全授業の定義（board 書き出し用）
        const lessonSpecs = lessons.map(l => ({
            id: l.id, subject: l.subject, teacherIds: l.teachers.slice(),
            classIds: l.classIds.slice(), support: !!l.support
        }));

        // 生成プロセスの説明（採用された試行の実測値つき）
        const st = best.stats || {};
        const dayJp = DAY_JP[vs.day] || '';
        const process = [];
        if (convNotes.length) {
            process.push('【条件の変換】Step 4 の入力（B週・変動枠込み）を内部用に変換: ' + convNotes.join('、') + '。総合の2コマ目は変動枠として毎週配置します。');
        }
        if (absorbInfo.length) {
            process.push('【学年職員の教科の充当】' + absorbInfo.map(a => a.cid + '=' + a.subject).join('、') +
                ' をベース週から各1コマ差し引きました。この1コマは音美コマのA週と変動枠のB週（学年職員の授業）で実施されます。');
        }
        if (varSlotObj && varDutyTids.size) {
            process.push('【予約】変動枠（' + dayJp + vs.period + '限）は学年の活動（総合・学年職員の授業）に使うため、学年所属の教員 ' + varDutyTids.size + ' 名の予定を先に押さえました。');
        }
        if (aWeek && abMode !== 'exact') {
            process.push('【A週の調整】ズレ許容モードのため、音美コマの学年職員予約なしでB週を解き、A週は音美コマの差し替え' + aWeek.replacedCount +
                'コマ＋入れ替え' + aWeek.extraDiff + 'コマで調整しました（ズレたコマは一覧表A週で色付き）。');
        } else if (aWeek) {
            process.push('【A週】B週の音美コマ（' + aWeek.replacedCount + 'コマ）を学年職員の教科に差し替えたものがA週です。差し替えが成立するよう、音美コマでは学年職員の空きを予約して組んでいます。');
        }
        process.push('【固定コマ】学活・道徳・総合など、時間が決まっている ' + (st.fixed || 0) + ' コマを先に置きました。');
        if (st.onbiFirst) {
            process.push('【音美コマを最初に】充当のある学級の音美 ' + st.onbiFirst + ' コマは、非常勤2名と学年職員の空きが同時に必要な最も窮屈なコマのため、固定コマの直後に配置しました。');
        }
        process.push('【配置順の自動選択】「支援学級を先に置く」「余裕のない教員を先に置く」の両方の順序を交互に試し、良い結果が出た方を採用しています。' +
            'この案は「' + (st.supportFirst ? '支援学級を先に' : '余裕のない教員を先に') + '」の試行です。');
        if (st.tight) {
            process.push('【余裕のない教員】空きコマがほとんどない教員の授業 ' + st.tight + ' コマを' +
                (st.supportFirst ? '支援学級の後に' : '支援学級の制限が入る前に') + '確保しました。');
        }
        if (st.sync) {
            process.push('【支援同期の教科】交流学級の「支援で受ける教科」' + st.sync + ' コマは、支援の配置直後に「置ける候補が最も少ない授業から」専用の順番で配置しました（支援の時間帯と同期させる必要があるため）。');
        }
        if (st.support) {
            let supMsg = '【支援学級を先に】支援学級の授業 ' + st.support + ' コマを先に配置しました';
            if (st.restrictCells > 0) {
                supMsg += '。出席する生徒の交流学級に「そのコマは生徒が支援で受ける教科しか置けない」という制限を ' + st.restrictCells + ' コマ分課しました（交流条件を守るため）';
            } else {
                supMsg += '（Step 6 で在籍生徒を登録すると、交流学級への許可教科の制限もここで課されます）';
            }
            process.push(supMsg + '。');
        }
        process.push('【通常学級】残り ' + ((st.normal || 0) - (st.onbiFirst || 0) - (st.tight || 0) - (st.sync || 0)) + ' コマを「置きにくい授業から」順に配置しました（複数の学年にまたがる教員 → 持ちコマの多い教員 → 教室が限られる教科 → 合同・TT → 週4コマの教科 → その他。同じ教科は1日1コマまで）。');
        const repairs = [];
        if (st.dupFixed) repairs.push('同じ教科が同日に2コマになった授業をコマの入れ替えで ' + st.dupFixed + ' 件解消');
        if (st.dupRemoved) repairs.push('入れ替えでも解消できなかった同日重複 ' + st.dupRemoved + ' 件は配置から外して玉突きへ回');
        if (st.pushFixed) repairs.push('置けなかった授業を玉突き（他のコマを空きへ移動）で ' + st.pushFixed + ' 件配置');
        if (repairs.length) process.push('【修復】' + repairs.join('、') + 'しました。');
        process.push('【多スタート】以上を条件の合う配置が見つかるまで乱数を変えて繰り返し' +
            (round > 1 ? '（改善が止まるたびに乱数を引き直して ' + round + ' ラウンド実行）' : '') +
            '（' + attempts + ' 回試行' +
            (st.boosted ? '・前回詰まった授業を最優先にするブーストあり' : '') + '）、第 ' + (best.attemptIndex || 1) + ' 試行の案を採用しました' +
            '（未配置 ' + best.unplaced.length + '・同日重複 ' + best.relaxedDups.length + '）。');
        if (softOrder.length) {
            process.push('【できれば条件】採用案は選択された条件（' + softOrder.join('、') + '）の違反が最も少ないものです（内訳は「できれば条件の達成状況」参照）。');
        }
        process.push('【手直しのヒント】固定コマ・変動枠・音美コマは動かさないのが安全です。授業を移すときは「同じ学級の別のコマと交換」すると成立しやすく、' +
            '教員の空きは教員別一覧で確認できます。支援学級のコマを動かす場合は、生徒の交流学級がその時間に「支援で受ける教科」をやっているかに注意してください。');

        const totalCount = lessons.length;
        // 担当未定はベース週の授業＋変動枠の未定コマの合計
        const provisionalCount = noTeacherLessons.length + varUnassigned;

        // 絶対条件（ハード）の達成サマリー: 何がクリアでき、何を妥協したかの一覧
        function buildHardSummary(sol, aw) {
            const items = [];
            // viol = 本当の違反行だけ（説明・条件の列挙・想定どおりの注記を含まない）。
            // 手直しページの「この違反は無視する」一覧はこれを使う。
            const push = (label, status, notes, viol) => items.push({
                label,
                status,
                notes: notes || [],
                viol: viol || (status === 'ng' ? (notes || []) : [])
            });
            const hardWeekIds = [...hardSet].filter(isTeacherWeekCondition);
            const hardWeekEval = evaluateTeacherWeekConditions(
                state, sol, teacherById, hardWeekIds, true,
                { ...teacherEvalOpts, aCells: aw ? aw.cells : null }
            );
            const violationDetails = ids => {
                const out = [];
                ids.forEach(id => {
                    const n = hardWeekEval.counters[id] || 0;
                    if (!n) return;
                    const list = hardWeekEval.details[id] || [];
                    if (list.length) {
                        out.push(...list);
                    } else {
                        out.push(
                            (id.startsWith('part:')
                                ? partItemLabel(state, id)
                                : (SOFT_LABELS_JP[id] || id)) +
                            ': ' + n + '件'
                        );
                    }
                });
                return out;
            };
            const weeklyCaveat =
                (weekList.length ? weekList.join('・') + '週' : '単週') +
                'の実担当スケジュールを分けて判定した結果です';

            // 完成した cells を直接検査する。探索中には呼ばず、結果構築時だけ実測する。
            const dayDupNotes = [];
            Object.keys(sol.occCls || {}).forEach(cid => {
                const byDay = {};
                Object.keys(sol.occCls[cid] || {}).forEach(key => {
                    const day = key.split('-')[0];
                    (byDay[day] = byDay[day] || []).push({
                        period: Number(key.split('-')[1]),
                        lesson: sol.occCls[cid][key]
                    });
                });
                Object.keys(byDay).forEach(day => {
                    const cellsOnDay = byDay[day].sort((a, b) => a.period - b.period);
                    cellsOnDay.forEach((cell, i) => {
                        const conflicts = cellsOnDay.slice(0, i).filter(prev => {
                            // 総合など、固定コマ同士の意図的な連続は違反にしない。
                            if (cell.lesson.fixedSlot && prev.lesson.fixedSlot) return false;
                            return classDayConflict(cid, cell.lesson.subject, prev.lesson.subject);
                        });
                        if (!conflicts.length) return;
                        const subjects = [...new Set(
                            conflicts.map(x => x.lesson.subject).concat(cell.lesson.subject)
                        )];
                        const cls = cid.startsWith('sc:') ? supportName(cid) : cid;
                        dayDupNotes.push(
                            cls + ': ' + (DAY_JP[day] || day) + '曜「' +
                            subjects.join('・') + '」が同日に重複'
                        );
                    });
                    if (classHasStaffVar[cid] && varSlotObj && day === varSlotObj.day &&
                        cellsOnDay.some(cell => cell.lesson.subject === absorbMap[cid])) {
                        const cls = cid.startsWith('sc:') ? supportName(cid) : cid;
                        dayDupNotes.push(
                            cls + ': ' + (DAY_JP[day] || day) + '曜「' + absorbMap[cid] +
                            '」が学年職員の教科の変動枠と同日に重複'
                        );
                    }
                });
            });

            // 同じスロットにある一意なレッスンを集め、教員の重複と出講不可を実測する。
            const lessonsBySlot = {};
            Object.keys(sol.occCls || {}).forEach(cid => {
                Object.keys(sol.occCls[cid] || {}).forEach(key => {
                    const l = sol.occCls[cid][key];
                    (lessonsBySlot[key] = lessonsBySlot[key] || {})[l.id] = l;
                });
            });
            const teacherNotes = [];
            Object.keys(lessonsBySlot).forEach(key => {
                const byTeacher = {};
                Object.keys(lessonsBySlot[key]).forEach(lid => {
                    const l = lessonsBySlot[key][lid];
                    (l.teachers || []).forEach(tid => {
                        (byTeacher[tid] = byTeacher[tid] || []).push(l);
                    });
                });
                Object.keys(byTeacher).forEach(tid => {
                    // 同じ pairKey の隔週交代教科2件は逆位相の complement なので1授業分と数える。
                    const logicalUses = [];
                    byTeacher[tid].forEach(l => {
                        const canComplement = !!l.pairKey &&
                            (l.biTeachers || []).includes(tid);
                        if (canComplement) {
                            const mate = logicalUses.find(x =>
                                x.pairKey === l.pairKey && !x.complete
                            );
                            if (mate) {
                                mate.lessons.push(l);
                                mate.complete = true;
                                return;
                            }
                        }
                        logicalUses.push({
                            pairKey: canComplement ? l.pairKey : null,
                            complete: false,
                            lessons: [l]
                        });
                    });
                    const t = teacherById[tid];
                    const name = (t && t.name) || tid || '教員';
                    const day = key.split('-')[0];
                    const period = key.split('-')[1];
                    const where = (DAY_JP[day] || day) + period + '限';
                    if (logicalUses.length > 1) {
                        const lessonNames = [];
                        logicalUses.forEach(use => {
                            use.lessons.forEach(l => lessonNames.push(lessonName(l)));
                        });
                        teacherNotes.push(
                            name + ': ' + where + 'に「' +
                            [...new Set(lessonNames)].join('・') + '」が重複'
                        );
                    }
                    if (naOf[tid] && naOf[tid].has(key)) {
                        teacherNotes.push(name + ': ' + where + 'が出講不可');
                    }
                });
            });

            // 交流学級の「支援で受ける」教科が、本人の支援授業スロットと同期しているか実測する。
            const supportSlotsByStudent = {};
            const seenSupportLessons = new Set();
            Object.keys(sol.occCls || {}).forEach(cid => {
                Object.keys(sol.occCls[cid] || {}).forEach(key => {
                    const l = sol.occCls[cid][key];
                    const unique = l.id + '@' + key;
                    if (seenSupportLessons.has(unique)) return;
                    seenSupportLessons.add(unique);
                    if (!l.support) return;
                    (l.attendees || []).forEach(st => {
                        (supportSlotsByStudent[st.id] =
                            supportSlotsByStudent[st.id] || new Set()).add(key);
                    });
                });
            });
            const supportSyncNotes = [];
            (state.support.students || []).forEach(st => {
                const grid = (sol.occCls || {})[st.exchangeClass] || {};
                Object.keys(grid).forEach(key => {
                    const l = grid[key];
                    if (!st.subjects || st.subjects[l.subject] !== 'support') return;
                    const supportSlots = supportSlotsByStudent[st.id];
                    if (supportSlots && supportSlots.has(key)) return;
                    const day = key.split('-')[0];
                    const period = key.split('-')[1];
                    supportSyncNotes.push(
                        (st.label || st.id || '支援生徒') + ': 交流学級 ' +
                        st.exchangeClass + ' の ' + (DAY_JP[day] || day) + period +
                        '限「' + l.subject + '」が支援授業と同期していません'
                    );
                });
            });

            push('全授業の配置', sol.unplaced.length === 0 ? 'ok' : 'ng',
                sol.unplaced.length
                    ? [sol.unplaced.length + ' コマが未配置']
                    : ['全 ' + totalCount + ' コマを配置'],
                sol.unplaced.map(u => '未配置: ' + lessonName(u.lesson || u)));
            push(
                '同じ教科の同日重複なし',
                dayDupNotes.length ? 'ng' : 'ok',
                dayDupNotes.length ? dayDupNotes : ['配置結果を実測し、違反はありません']
            );
            push(
                '教員の重なりなし・出講不可の回避',
                teacherNotes.length ? 'ng' : 'ok',
                teacherNotes.length ? teacherNotes : ['配置結果を実測し、違反はありません']
            );
            if ((state.support.students || []).length) {
                push(
                    '支援学級と交流学級の同期',
                    supportSyncNotes.length ? 'ng' : 'ok',
                    supportSyncNotes.length
                        ? supportSyncNotes
                        : ['配置結果を実測し、違反はありません']
                );
            }
            if (Object.keys(partConfById).length) {
                const hardPartIds = hardWeekIds.filter(id => id.startsWith('part:'));
                const violations = violationDetails(hardPartIds);
                push(
                    '非常勤の個別条件（午前のみ・準備時間・1日のコマ数）',
                    violations.length ? 'ng' : 'ok',
                    violations.length
                        ? violations.concat(weeklyCaveat)
                        : ['設定されている条件はすべて守られています'],
                    violations
                );
            }
            if (hardSet.size) {
                const notes = [...hardSet].map(id =>
                    id.startsWith('part:')
                        ? partItemLabel(state, id)
                        : (SOFT_LABELS_JP[id] || id)
                );
                if (noGapExempt.size) {
                    notes.push(
                        '【最終手段】' +
                        [...noGapExempt]
                            .map(tid => (teacherById[tid] || {}).name || tid)
                            .join('・') +
                        ' にはコマ数の兼ね合いで「空きコマゼロの日」を適用できませんでした'
                    );
                }
                const upgradedIds = hardWeekIds.filter(id =>
                    id === 'no_gap_zero_day' || id === 'part_time_gap'
                );
                const allViolations = violationDetails(upgradedIds);
                // 適用除外した教員の「空きコマゼロ」は、除外した以上むしろ想定どおりに起きる結果。
                // これを「予期しない違反（ng）」として赤く出すと、本当に見るべき違反が埋もれる。
                // 承知のうえの譲歩（warn）と、それ以外の違反（ng）を分けて表示する（2026-07-28）。
                const exemptNames = [...noGapExempt].map(tid => (teacherById[tid] || {}).name || tid);
                const isExpectedExemption = v =>
                    exemptNames.some(n => v.indexOf(n + ':') === 0) && v.indexOf('空きコマゼロ') >= 0;
                const violations = allViolations.filter(v => !isExpectedExemption(v));
                const expected = allViolations.filter(isExpectedExemption);
                if (expected.length) {
                    notes.push(...expected.map(v => v + '（適用除外した教員なので想定どおりです）'));
                }
                if (violations.length) {
                    notes.push(...violations);
                }
                if (allViolations.length) notes.push(weeklyCaveat);
                push(
                    '「絶対」に格上げした条件',
                    violations.length ? 'ng' : ((noGapExempt.size || expected.length) ? 'warn' : 'ok'),
                    notes,
                    violations
                );
            }
            // 教員単位の「絶対に」（Step 8 の先生ごとの重みで hard を選んだ先生の「同じ学年を連続に」）。
            // 配置段階で守られるため通常は違反0だが、緩和・手直し経由で残った場合に見逃さないための行
            {
                const gbHardTids = (state.teachers || [])
                    .map(t => t.id)
                    .filter(tid => teacherCondHardOf(state, 'grade_block', tid));
                if (gbHardTids.length) {
                    const nameOf = tid => (teacherById[tid] || {}).name || tid;
                    const viol = [];
                    gbHardTids.forEach(tid => {
                        const byDay = {};   // day -> { period: 学年（支援学級は 'S'） }
                        Object.keys(sol.occCls).forEach(cid => {
                            Object.keys(sol.occCls[cid]).forEach(key => {
                                const cell = sol.occCls[cid][key];
                                if (!cell.teachers || !cell.teachers.includes(tid)) return;
                                const seg = key.split('-');
                                (byDay[seg[0]] = byDay[seg[0]] || {})[Number(seg[1])] =
                                    (cell.grade != null ? cell.grade : 'S');
                            });
                        });
                        Object.keys(byDay).forEach(d => {
                            const seq = Object.keys(byDay[d]).map(Number).sort((a, b) => a - b).map(p => byDay[d][p]);
                            let runs = 0, prev = null;
                            const kinds = new Set();
                            seq.forEach(g2 => { if (g2 !== prev) { runs++; prev = g2; } kinds.add(g2); });
                            if (runs - kinds.size > 0) {
                                viol.push(nameOf(tid) + ': ' + DAY_JP[d] + '曜の学年並びが ' +
                                    seq.map(g2 => g2 === 'S' ? '支' : g2).join('→') + ' と行き来');
                            }
                        });
                    });
                    push(
                        '同じ学年を連続に（「絶対に」: ' + gbHardTids.map(nameOf).join('・') + '）',
                        viol.length ? 'ng' : 'ok',
                        viol.length ? viol : ['学年の行き来はありません'],
                        viol
                    );
                }
            }
            if (aw) {
                push(
                    'A週とB週の整合（音美コマの差し替え）',
                    aw.violations.length === 0 ? 'ok' : 'ng',
                    aw.violations.length
                        ? aw.violations
                        : (aw.extraDiff > 0
                            ? ['A週で ' + aw.extraDiff + ' コマ入れ替えて調整しました']
                            : ['差し替えのみで成立'])
                );
            }
            return items;
        }

        // 表示用: ソフト違反は最良案・別案とも内訳つきで再評価する
        const softWithDetails = sol => evaluateSoft(
            state, slots, sol, teacherById, true, teacherEvalOpts
        );

        // ベスト3案: 2位以下は参考案として同じ形のグリッドを添える
        const alternatives = bests.slice(1).map(b => {
            const altAw = buildAWeekResult(b);
            return {
                key: b.key.slice(),
                unplacedCount: b.unplaced.length,
                unplaced: b.unplaced.map(u => ({ name: lessonName(u.lesson), reason: u.reason })),
                dupCount: b.relaxedDups.length,
                rotDupCount: b.rotDup,
                partMinViolCount: (b.partMinViol || []).length,
                softTotal: b.soft.total,
                softBreakdown: softWithDetails(b).breakdown,
                hardSummary: buildHardSummary(b, altAw),
                cells: gridCellsOf(b),
                aWeek: altAw,
                diffFromBest: solDiffCount(b, best).d
            };
        });

        // 未配置の阻害要因（最良案について）
        const unplacedDetail = (best.unplaced.length && best.analyzeUnplaced) ? best.analyzeUnplaced() : [];
        const hardSummary = buildHardSummary(best, aWeek);

        return {
            ok: best.unplaced.length === 0 && report.errors.length === 0,
            hardOk: !hardSummary.some(item => item.status === 'ng'),
            provisional: provisionalCount > 0,
            provisionalCount,
            attempts,
            elapsedMs: Date.now() - t0,
            seed: best.seed,
            totalCount,
            placedCount: totalCount - best.unplaced.length,
            unplaced: best.unplaced.map(u => ({ name: lessonName(u.lesson), subject: u.lesson.subject, classIds: u.lesson.classIds, lessonId: u.lesson.id, reason: u.reason })),
            unplacedDetail,
            dupCount: best.relaxedDups.length,        // ベース週の同日重複（絶対条件のため常に0のはず）
            rotDupCount: best.rotDup,                  // 週替わりで同日になり得る箇所（A週修復の対象）
            partMinViolCount: (best.partMinViol || []).length,
            carryBoostIds: (best.stuckIds || []).slice(),   // 次回実行への引き継ぎ用（詰まった授業ID）,
            bestKey: best.key.slice(),   // [未配置, 同日重複+週替わりの同日重なり, できれば違反点]
            cells,
            aWeek,
            abMode,
            alternatives,
            lessonSpecs,
            stats: best.stats,
            slots,
            softBreakdown: softWithDetails(best).breakdown,
            softTotal: best.soft.total,
            hardSummary,
            process,
            errors: report.errors,
            warnings: report.warnings,
            suggestions: report.suggestions,
            varSlotIssues: report.varSlotIssues
        };
    }

    function failResult(report, seed) {
        return { ok: false, hardOk: false, provisional: false, provisionalCount: 0, attempts: 0, elapsedMs: 0, seed,
                 totalCount: 0, placedCount: 0, unplaced: [], unplacedDetail: [], cells: {}, lessonSpecs: [], slots: [],
                 aWeek: null, abMode: 'exact', alternatives: [], hardSummary: [],
                 softBreakdown: [], softTotal: 0, process: [],
                 errors: report.errors, warnings: report.warnings, suggestions: report.suggestions || [], varSlotIssues: [] };
    }

    /* ---------- 「この条件をなくせば組める」動的提案（アブレーション） ----------
       未配置が残ったとき、絶対条件を1つずつ外す／A週のズレを許す変種で短時間だけ再探索し、
       完全配置できた変更を提案として返す */
    const SOFT_LABELS_JP = {
        pe_am: '保健体育を午後に置かない',
        no_hard_monday1: '月曜1限に主要教科を置かない',
        week1_safe: '週1コマの教科を月曜・最終限に置かない',
        subject_spread: '同じ教科を同じ時限に縦並びさせない',
        subject_pm: '同じ教科を午後に固めない',
        no_special_seq: '移動教室の授業を3連続にしない',
        part_time_gap: '非常勤の空きコマ制限',
        grade_block: '教科担当の同じ学年を連続に',
        no_gap_zero_day: '教員の空きコマゼロの日を作らない',
        jiritsu_sync: '自立活動を同じ時間に揃える',
        teacher_gap: '教員の空きコマの平準化',
        am_pm_balance: '主要教科の午前午後バランス',
        part_time_days: '非常勤の出講日をまとめる',
        pe_overlap: '体育を同じ時間に重ねない'
    };
    // 緩和の変種を列挙（非常勤の個別条件 → 絶対条件 → A/Bズレの順）
    function relaxationVariants(state) {
        const variants = [];
        (state.teachers || []).forEach(t => {
            const pc = partConfOf(t);
            if (!pc) return;
            const name = (t.name || '非常勤') + ' 先生';
            // id は統一優先順位リストの id と同じ形式（UI の「この条件を無視して組み直す」で使う）
            const mkVariant = (id, label, mutate) => {
                const s2 = JSON.parse(JSON.stringify(state));
                const t2 = s2.teachers.find(x => x.id === t.id);
                t2.part = t2.part || {};
                mutate(t2.part);
                variants.push({ id, label, state: s2 });
            };
            if (pc.amOnly) mkVariant('part:' + t.id + ':amOnly', name + 'の「午前のみ」を外す', p => { p.lunch = 'any'; });
            if (pc.prepWeek != null) mkVariant('part:' + t.id + ':prepWeek', name + 'の「準備の時間（週の空き上限 ' + pc.prepWeek + '）」を外す', p => { p.prepWeek = ''; });
            if (pc.dayMin > 1) mkVariant('part:' + t.id + ':dayMin', name + 'の「1日の最低 ' + pc.dayMin + ' コマ」を外す', p => { p.dayMin = 0; });
            if (pc.dayMax > 0) mkVariant('part:' + t.id + ':dayMax', name + 'の「1日の最高 ' + pc.dayMax + ' コマ」を外す', p => { p.dayMax = 0; });
        });
        const hard = ((state.soft && state.soft.hard) || []).filter(id => ((state.soft && state.soft.selected) || []).includes(id));
        hard.forEach(id => {
            const s2 = JSON.parse(JSON.stringify(state));
            s2.soft.hard = hard.filter(x => x !== id);
            variants.push({ id, label: '「' + (SOFT_LABELS_JP[id] || id) + '」の絶対指定を「できれば」に戻す', state: s2 });
        });
        if (abModeOf(state) === 'exact') {
            const s2 = JSON.parse(JSON.stringify(state));
            s2.solver = s2.solver || {};
            s2.solver.abMode = 'repair';
            variants.push({ id: 'abMode:repair', label: '「A週とB週のズレ」を「少しずらしてもよい」にする', state: s2 });
        }
        return variants;
    }

    /*
     * 段階的緩和探索:
     * 1. 現条件
     * 2. 優先順位の低い条件から無効化・格下げ
     * 3. 優先順位の高い順に復活を試す
     */
    async function solveEscalating(state, opts) {
        opts = opts || {};
        state = stateWithIgnored(state, opts.ignoredIds);   // 無視リストは最初から外す（各段階のsolveでも冪等に適用される）
        const startedAt = Date.now();
        const totalBudget = Math.min(opts.timeBudgetMs || 180000, 1200000);
        const deadline = startedAt + totalBudget;
        const initialState = JSON.parse(JSON.stringify(state));
        const originalPrio = prioritiesOf(initialState);
        const originalOrder = originalPrio.order.slice();
        const originalHard = new Set(originalPrio.hard);

        const phase1Budget = Math.floor(totalBudget * 0.30);
        const phase2Budget = Math.floor(totalBudget * 0.40);
        const phase3Budget = totalBudget - phase1Budget - phase2Budget;

        const relaxedIds = [];
        const restoredIds = [];
        const phaseProcess = [];
        let triedCount = 0;
        let phase1Solved = false;
        let bestResult = null;
        let currentState = JSON.parse(JSON.stringify(initialState));

        const labelOf = id => {
            if (id.indexOf('part:') === 0) return partItemLabel(initialState, id);
            return SOFT_LABELS_JP[id] || id;
        };
        const keyOf = result => [
            (result.unplaced || []).length,
            (result.bestKey && result.bestKey[1]) || 0,
            (result.softTotal == null ? Infinity : result.softTotal)
        ];
        const better = (a, b) => {
            if (!b) return true;
            const ka = keyOf(a);
            const kb = keyOf(b);
            for (let i = 0; i < ka.length; i++) {
                if (ka[i] !== kb[i]) return ka[i] < kb[i];
            }
            return false;
        };
        const remainingMs = () => Math.max(0, deadline - Date.now());
        const runOne = async (phase, phaseLabel, phaseRemaining, stateForRun, stageCount) => {
            const left = remainingMs();
            if (left <= 0 || (opts.shouldCancel && opts.shouldCancel())) return null;

            const perStage = Math.max(1000, Math.min(left, Math.floor(phaseRemaining / Math.max(1, stageCount))));
            const result = await solve(stateForRun, {
                ...opts,
                // 無視リストは solveEscalating 冒頭で適用済み。二重適用は非冪等
                // （格下げ済みの part: id が order から消え、prioritiesOf の
                //   missing 復活ルールで「絶対」に戻ってしまう）ため渡さない
                ignoredIds: null,
                timeBudgetMs: perStage,
                onProgress: p => {
                    if (opts.onProgress) {
                        opts.onProgress({
                            ...p,
                            phase,
                            relaxation: phaseLabel,
                            // 段階ごとの budgetMs だけだと「3分を選んだのに上限1分」に見える。
                            // 全体の経過と上限も渡し、UI 側で両方表示できるようにする（2026-07-28）
                            totalElapsedMs: Date.now() - startedAt,
                            totalBudgetMs: totalBudget
                        });
                    }
                }
            });
            triedCount++;
            return result;
        };

        // フェーズ1
        const p1 = await runOne(1, '条件どおり', phase1Budget, currentState, 1);
        if (p1) {
            bestResult = p1;
            phase1Solved = p1.unplaced.length === 0 && p1.hardOk;
        }
        phaseProcess.push(
            '【フェーズ1】条件どおりで探索しました（未配置 ' +
            (bestResult ? bestResult.unplaced.length : '不明') + '）。'
        );

        // フェーズ2候補: 低優先度の「できれば」→低優先度の「絶対」
        if (!phase1Solved && remainingMs() > 0 && !(opts.shouldCancel && opts.shouldCancel())) {
            const softCandidates = originalOrder.filter(id => !originalHard.has(id)).reverse();
            const hardCandidates = originalOrder.filter(id => originalHard.has(id)).reverse();
            const candidates = softCandidates.concat(hardCandidates);

            for (let i = 0; i < candidates.length; i++) {
                if (remainingMs() <= 0 || (opts.shouldCancel && opts.shouldCancel())) break;

                const id = candidates[i];
                const next = JSON.parse(JSON.stringify(currentState));
                next.priorities = next.priorities || {};
                next.priorities.order = originalOrder.slice();
                next.priorities.hard = originalOrder.filter(x => originalHard.has(x));

                if (originalHard.has(id)) {
                    next.priorities.hard = next.priorities.hard.filter(x => x !== id);
                } else {
                    next.priorities.order = next.priorities.order.filter(x => x !== id);
                    next.priorities.hard = next.priorities.hard.filter(x => x !== id);
                }

                const label = labelOf(id);
                const phaseLeft = Math.min(
                    phase2Budget,
                    Math.max(0, deadline - startedAt - phase1Budget)
                );
                const r = await runOne(
                    2,
                    '「' + label + '」を' + (originalHard.has(id) ? 'できればへ格下げ' : '外して') + '探索中',
                    phaseLeft,
                    next,
                    candidates.length - i
                );
                if (!r) break;

                if (better(r, bestResult)) bestResult = r;
                currentState = next;
                relaxedIds.push(id);

                if (r.unplaced.length === 0 && r.hardOk) {
                    phaseProcess.push(
                        '【フェーズ2】低優先度の条件から緩和し、「' +
                        label + '」までで全コマを配置しました。'
                    );
                    break;
                }
            }

            if (!phase1Solved && (!bestResult || bestResult.unplaced.length > 0)) {
                phaseProcess.push(
                    '【フェーズ2】条件をすべて緩和しても未配置 ' +
                    (bestResult ? bestResult.unplaced.length : '不明') + ' コマが残りました。'
                );
            }
        }

        const phase2Solved = bestResult &&
            bestResult.unplaced.length === 0 && bestResult.hardOk;

        // フェーズ3: 緩和した条件を優先度の高い順に復活
        if (phase2Solved && remainingMs() > 0 && !(opts.shouldCancel && opts.shouldCancel())) {
            const restoreOrder = relaxedIds
                .slice()
                .sort((a, b) => originalOrder.indexOf(a) - originalOrder.indexOf(b));

            for (let i = 0; i < restoreOrder.length; i++) {
                if (remainingMs() <= 0 || (opts.shouldCancel && opts.shouldCancel())) break;

                const id = restoreOrder[i];
                const next = JSON.parse(JSON.stringify(currentState));
                next.priorities = next.priorities || {};
                next.priorities.order = originalOrder.slice();
                next.priorities.hard = originalOrder.filter(x => originalHard.has(x));

                // それまでに復活できなかった条件は、現在の状態から引き継ぐ
                relaxedIds.forEach(relaxedId => {
                    if (relaxedId === id || restoredIds.includes(relaxedId)) return;
                    if (originalHard.has(relaxedId)) {
                        next.priorities.hard = next.priorities.hard.filter(x => x !== relaxedId);
                    } else {
                        next.priorities.order = next.priorities.order.filter(x => x !== relaxedId);
                        next.priorities.hard = next.priorities.hard.filter(x => x !== relaxedId);
                    }
                });

                const r = await runOne(
                    3,
                    '「' + labelOf(id) + '」を戻して探索中',
                    phase3Budget,
                    next,
                    restoreOrder.length - i
                );
                if (!r) break;

                if (r.unplaced.length === 0 && r.hardOk) {
                    currentState = next;
                    restoredIds.push(id);
                    if (better(r, bestResult) || bestResult.unplaced.length > 0) {
                        bestResult = r;
                    }
                    phaseProcess.push('【フェーズ3】「' + labelOf(id) + '」を復活できました。');
                } else {
                    phaseProcess.push('【フェーズ3】「' + labelOf(id) + '」は復活できず、緩和したままにしました。');
                }
            }
        }

        if (!bestResult) {
            bestResult = await solve(initialState, {
                ...opts,
                ignoredIds: null,   // initialState は適用済み（runOne と同じ理由）
                timeBudgetMs: Math.max(1, remainingMs())
            });
        }

        const finalRelaxedIds = relaxedIds.filter(id => !restoredIds.includes(id));
        const finalLabels = finalRelaxedIds.map(labelOf);
        const restoredLabels = restoredIds.map(labelOf);

        if (phase1Solved) {
            bestResult.escalation = {
                phase1Solved: true,
                relaxedIds: [],
                relaxedLabels: [],
                restoredIds: [],
                triedCount,
                note: '条件どおりで全コマを配置できました。'
            };
        } else if (bestResult.unplaced.length === 0) {
            bestResult.escalation = {
                phase1Solved: false,
                relaxedIds: finalRelaxedIds,
                relaxedLabels: finalLabels,
                restoredIds,
                triedCount,
                note: (p1 && p1.unplaced.length === 0
                        ? '条件どおりでも全コマ配置できましたが、週別判定の絶対条件に違反が残ったため、'
                        : '条件どおりでは未配置が残ったため、') +
                    (finalLabels.length ? '「' + finalLabels.join('」「') + '」を緩和して' : '') +
                    '解決を試みました。'
            };
            // 緩和のきっかけは2通りある: ①未配置が残った ②全コマ入ったが週別の絶対条件
            // （非常勤のdayMin等）に違反が残った。②なのに「0コマ入らなかった」と表示して
            // いた文言バグを修正（2026-07-28・ブラウザ実機検証で発見）
            const p1Unplaced = p1 ? p1.unplaced.length : null;
            bestResult.warnings = (bestResult.warnings || []).concat(
                (p1Unplaced === 0
                    ? '条件どおりでも全コマ配置できましたが、絶対条件（週別の判定を含む）に違反が残ったため、'
                    : '条件どおりでは' + (p1Unplaced == null ? '複数' : p1Unplaced) + 'コマ入らなかったため、') +
                (finalLabels.length ? '「' + finalLabels.join('」「') + '」を外して' : '') +
                '解決を試みました。' +
                (finalLabels.length ? 'この条件を戻すと違反が戻る可能性があります。残った違反は「絶対条件の達成状況」で確認できます。' : '')
            );
        } else {
            bestResult.escalation = {
                phase1Solved: false,
                relaxedIds: finalRelaxedIds,
                relaxedLabels: finalLabels,
                restoredIds,
                triedCount,
                note: '条件をすべて緩めても' + bestResult.unplaced.length +
                    'コマ入りませんでした。物理的に不可能な可能性があります。'
            };
            bestResult.warnings = (bestResult.warnings || []).concat(
                '条件をすべて緩めても' + bestResult.unplaced.length +
                'コマ入りませんでした。教員の持ちコマ数や出講可能時間の見直しが必要です。'
            );
        }

        bestResult.process = (bestResult.process || []).concat(phaseProcess);
        return bestResult;
    }

    /* 条件を1つずつ外して短時間再探索し、比較データ付きで返す。
       未配置が残るときの「これを外せば組める」に加え、完全解のときも
       「この条件が厳しい。外すと時間割の質がこれだけ上がる」の感度分析に使う */
    async function analyzeRelaxations(state, opts) {
        opts = opts || {};
        const per = Math.min(opts.timeBudgetMs || 8000, 30000);
        const variants = relaxationVariants(state);
        const maxVariants = opts.maxVariants || 12;
        if (variants.length > maxVariants) variants.length = maxVariants;
        const out = [];
        for (let i = 0; i < variants.length; i++) {
            const v = variants[i];
            if (opts.shouldCancel && opts.shouldCancel()) break;
            if (opts.onProgress) opts.onProgress({ index: i + 1, total: variants.length, label: v.label });
            const r = await solve(v.state, { timeBudgetMs: per, maxAttempts: 60000, softExtraMs: 0, seed: opts.seed, shouldCancel: opts.shouldCancel, ignoredIds: opts.ignoredIds });
            out.push({
                id: v.id || null,
                label: v.label,
                unplacedCount: r.unplaced.length,
                placed: r.placedCount,
                total: r.totalCount,
                bestKey: r.bestKey ? r.bestKey.slice() : null,
                softTotal: r.softTotal,
                hadErrors: r.errors.length > 0
            });
        }
        return out;
    }

    // 互換ラッパー: 完全配置できた変種だけを文字列で返す（未配置時の自動提案用）
    async function suggestRelaxations(state, opts) {
        const res = await analyzeRelaxations(state, opts);
        return res.filter(x => x.unplacedCount === 0 && !x.hadErrors)
            .map(x => x.label + ' → すべてのコマが配置できました（' + x.placed + '/' + x.total + '）。');
    }

    /* ---------- 変動枠の週別チェック ---------- */
    /* 各週の変動枠は全クラス同時刻。クラスごとに教科と担当を割り出し、
       教員の重複・出講不可・教室容量・同日同教科・男女別体育を検証する。
       戻り値: 担当が決まらないコマの数（provisional 判定に使う） */
    function checkVarSlot(state, best, report, env) {
        const vs = state.skeleton.varSlot;
        const key = sKey(vs.day, Number(vs.period));
        const cidsAll = classIdsOf(state);
        let unassigned = 0;

        const dutyTeacherIds = varDutyTeacherIds(state, env.staffPlan);

        weekLabels(state).forEach(w => {
            const useMap = {};   // tid -> [クラス名]
            const roomNeed = {}; // 構成教科 -> クラス数
            cidsAll.forEach(cid => {
                const g = gradeOf(cid);
                if (!gradeUsesVar(state, g)) return;  // 変動枠を使わない学年は通常コマとして扱う
                let subject = ((state.varContent[w] || {})[g]) || '学年職員の教科';
                if (subject === VAR_UNUSED) {
                    // 一部の週だけ「（使わない）」は不可（コマ数が週によって変わってしまう）
                    report.varSlotIssues.push(w + '週: ' + g + '年の変動枠が「（使わない）」ですが、他の週では使っています。「（使わない）」は全週で選ぶか、学年職員の教科に変えてください（Step 3）');
                    subject = '学年職員の教科';
                }
                let tids;
                if (subject === '学年職員の教科') {
                    const tid = gradeStaffTeacherOfClass(state, cid, null, env.staffPlan);
                    tids = tid ? [tid] : [];
                    if (!tid) {
                        unassigned++;
                        report.varSlotIssues.push(w + '週: ' + cid + ' の学年職員の教科の担当が決まりません（Step 5a の所属学年と Step 5b の担当を確認）');
                    }
                } else if (subject === '総合' || HOMEROOM_SUBJECTS.includes(subject)) {
                    const hr = state.teachers.find(t => t.homeroom === cid);
                    tids = hr ? [hr.id] : [];
                    if (!hr) {
                        unassigned++;
                        report.varSlotIssues.push(w + '週: ' + cid + ' の担任が未設定のため変動枠（' + subject + '）の担当が決まりません（Step 5a）');
                    }
                } else {
                    tids = teacherAsg(state, cid, subject);
                    if (!tids.length) {
                        unassigned++;
                        report.varSlotIssues.push(w + '週: ' + cid + ' の変動枠「' + subject + '」の担当が未定です（Step 5b）');
                    }
                    // 教室資源（担任系の教科は教室に紐づかない前提）
                    roomComponents(subject).forEach(comp => {
                        if (env.capOf(comp) !== Infinity) roomNeed[comp] = (roomNeed[comp] || 0) + 1;
                    });
                    // 男女別体育は変動枠では未対応
                    if (state.pe.separate && subject === '保健体育') {
                        report.varSlotIssues.push(w + '週: ' + cid + ' の変動枠に保健体育（男女別）は未対応です。別の教科にしてください（Step 3）');
                    }
                }
                // 同日同教科（ベース週の同曜日と重なるか）。総合・学活・道徳も対象。
                // 「学年職員の教科」は特定の教科ではないため対象外。
                // 変動枠の前後に隣接する同教科（例: 火5固定総合＋火6変動枠総合の連続2コマ）は意図的な連続として許可
                if (subject !== '学年職員の教科') {
                    const grid = best.occCls[cid] || {};
                    const dupKeys = Object.keys(grid).filter(k => k.split('-')[0] === vs.day && grid[k].subject === subject);
                    const adjacent = k => Math.abs(Number(k.split('-')[1]) - Number(vs.period)) === 1;
                    if (dupKeys.length && !dupKeys.every(adjacent)) {
                        report.varSlotIssues.push(w + '週: ' + cid + ' は' + DAY_JP[vs.day] + '曜に「' + subject + '」が既にあり、変動枠と同日2コマになります（連続でない位置）');
                    }
                }
                tids.forEach(tid => { (useMap[tid] = useMap[tid] || []).push(cid); });
            });
            Object.keys(roomNeed).forEach(comp => {
                if (roomNeed[comp] > env.capOf(comp)) {
                    report.varSlotIssues.push(w + '週の変動枠: 「' + comp + '」の教室が足りません（必要' + roomNeed[comp] + '＞容量' + env.capOf(comp) + '）');
                }
            });
            Object.keys(useMap).forEach(tid => {
                const t = state.teachers.find(x => x.id === tid);
                if (useMap[tid].length > 1) {
                    report.varSlotIssues.push(w + '週の変動枠: ' + ((t && t.name) || '教員') + ' が ' + useMap[tid].join('・') + ' で同時に必要です');
                }
                if (t && !dutyTeacherIds.has(tid) && (t.na || []).includes(key)) {
                    report.varSlotIssues.push(w + '週の変動枠: ' + (t.name || '教員') + ' は ' + DAY_JP[vs.day] + vs.period + '限が出講不可です');
                }
            });
        });
        return unassigned;
    }

    // ワーカースレッドでも読み込めるよう self へ公開する（通常のページでは self === window）
    (typeof self !== 'undefined' ? self : window).TimetableSolver = { solve, solveEscalating, suggestRelaxations, analyzeRelaxations, prioritiesOf, partItemLabel, DAYS, DAY_JP, BIWEEKLY_PAIRS, weekLabels, gradeStaffPlan };
})();
