/* 時間割 Excel 書き出し */
"use strict";

window.TimetableExcel = (() => {
  const DAYS = ["月", "火", "水", "木", "金"];
  // 曜日ごとの時限数は学校によって違う（Step 1 の設定）。既定は「月5・火〜金6」。
  // 以前はこの3つを定数で固定していたため、時限数を変えると列がずれた（実運用レビュー 2026-07-30）。
  const DEFAULT_DAY_PERIODS = [5, 6, 6, 6, 6];
  let DAY_PERIODS = DEFAULT_DAY_PERIODS.slice();
  let DAY_STARTS = [];      // 各曜日の開始列（1列目=コマ数・2列目=名前なので C 列から）
  let LAST_COL = 31;        // 最終コマの列
  let AF_COL = 32;          // 右端の見出し列

  function setupColumns(board) {
    const given = (board.meta || {}).dayPeriods;
    DAY_PERIODS = (Array.isArray(given) && given.length === DAYS.length && given.every((n) => n > 0))
      ? given.map(Number)
      : DEFAULT_DAY_PERIODS.slice();
    DAY_STARTS = [];
    let col = 3;
    DAY_PERIODS.forEach((n) => { DAY_STARTS.push(col); col += n; });
    LAST_COL = col - 1;
    AF_COL = col;
  }

  const thin = { style: "thin", color: { argb: "FF000000" } };
  const medium = { style: "medium", color: { argb: "FF000000" } };
  const center = { horizontal: "center", vertical: "center" };

  // 書き出したあと Excel で手作業を続ける前提の体裁:
  // 見出しに色を敷き、名前と曜日は常に見えるように固定する。
  const FONT = "ＭＳ ゴシック";
  const solid = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
  const headerFill = solid("FFD9D9D9");   // 曜日・限の見出し
  const nameFill = solid("FFF2F2F2");     // 学級名・教員名の列
  const studentFill = solid("FFFDF6E3");  // 支援学級の生徒（画面の黄と同じ）
  // 最終行より下に余白を残す（手作業で行を足せるように）。空行まで高さを触ると重くなる
  const FORMAT_ROWS = 80;

  function subjectName(board, lessonId) {
    const lesson = (board.lessons || []).find((x) => x.id === lessonId);
    const subject = lesson && (board.subjects || []).find((x) => x.id === lesson.subjectId);
    return subject ? subject.name : "";
  }

  function shortSubject(name) {
    const shortNames = {
      "保健体育": "保体",
      "生活単元": "生単",
      "自立活動": "自立",
      "学年職員の教科": "学職"
    };
    return shortNames[name] || name;
  }

  function lessonAt(board, week, classId, day, period) {
    const id = (((board.grid || {})[week] || {})[classId + "|" + day + "|" + period]);
    if (!id) return null;
    const lesson = (board.lessons || []).find((x) => x.id === id);
    if (!lesson) return null;
    return {
      id: lesson.id,
      subject: subjectName(board, id),
      teacherIds: lesson.teacherIds || [],
      classIds: lesson.classIds || [classId]
    };
  }

  function sameLesson(a, b) {
    return !!a && !!b && a.id === b.id;
  }

  function displayLesson(board, weekKind, classId, day, period) {
    if (weekKind === "A") {
      const a = lessonAt(board, "A", classId, day, period);
      return a ? shortSubject(a.subject) : "";
    }
    const b1 = lessonAt(board, "B1", classId, day, period);
    const b2 = lessonAt(board, "B2", classId, day, period);
    if (!b1 && !b2) return "";
    if (sameLesson(b1, b2)) return shortSubject(b1.subject);
    if (b1 && b2 &&
        ((b1.subject === "音楽" && b2.subject === "美術") ||
         (b1.subject === "美術" && b2.subject === "音楽"))) return "音美";
    return [b1 && shortSubject(b1.subject), b2 && shortSubject(b2.subject)]
      .filter(Boolean).join("/");
  }

  function lessonsForTeacher(board, weekKind, teacherId, day, period) {
    const weeks = weekKind === "A" ? ["A"] : ["B1", "B2"];
    const found = new Map();

    (board.classes || []).forEach((cls) => {
      weeks.forEach((week) => {
        const lesson = lessonAt(board, week, cls.id, day, period);
        if (lesson && lesson.teacherIds.includes(teacherId)) found.set(lesson.id, lesson);
      });
    });
    return [...found.values()];
  }

  function className(board, classId) {
    const cls = (board.classes || []).find((item) => item.id === classId);
    return cls ? cls.name : classId;
  }

  function compactClassNames(names) {
    const unique = [...new Set(names)];
    if (!unique.length) return "";

    return unique.reduce((out, name, index) => {
      if (index === 0) return name;
      const previous = unique[index - 1];
      const m = /^(\d+)-(.+)$/.exec(name);
      const pm = /^(\d+)-(.+)$/.exec(previous);
      if (m && pm && m[1] === pm[1]) return out + "・" + m[2];
      return out + "・" + name;
    }, "");
  }

  function teacherCellValue(board, weekKind, teacherId, day, period) {
    const lessons = lessonsForTeacher(board, weekKind, teacherId, day, period);
    if (!lessons.length) return "";

    const grouped = new Map();
    lessons.forEach((lesson) => {
      const key = lesson.subject;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(...lesson.classIds);
    });

    return [...grouped.entries()].map(([subject, classIds]) =>
      compactClassNames(classIds.map((classId) => className(board, classId))) +
      shortSubject(subject)
    ).join("／");
  }

  function slotColumn(dayIndex, period) {
    return DAY_STARTS[dayIndex] + period - 1;
  }

  function allSlots(callback) {
    DAYS.forEach((day, dayIndex) => {
      for (let period = 1; period <= DAY_PERIODS[dayIndex]; period += 1) {
        callback(day, dayIndex, period, slotColumn(dayIndex, period));
      }
    });
  }

  function studentRows(board, supportClassId) {
    const students = ((board.meta || {}).students || [])
      .filter((student) => student.supportClassId === supportClassId);

    return students.map((student, index) => ({
      name: student.name || ("生徒" + (index + 1)),
      mirrorClassId: student.mirrorClassId || "",
      supportClassId: student.supportClassId,
      supportSubjects: student.supportSubjects || []
    }));
  }

  function studentValue(board, weekKind, student, day, period) {
    const mirror = displayLesson(board, weekKind, student.mirrorClassId, day, period);
    const support = displayLesson(board, weekKind, student.supportClassId, day, period);
    const mirrorRaw = weekKind === "A"
      ? lessonAt(board, "A", student.mirrorClassId, day, period)
      : lessonAt(board, "B1", student.mirrorClassId, day, period) ||
        lessonAt(board, "B2", student.mirrorClassId, day, period);

    const mirrorSubject = mirrorRaw ? mirrorRaw.subject : "";
    return student.supportSubjects.includes(mirrorSubject) ? (support || mirror) : mirror;
  }

  function classRows(board) {
    const normal = (board.classes || []).filter((c) => c.grade !== "基");
    const support = (board.classes || []).filter((c) => c.grade === "基");
    const rows = normal.map((cls) => ({ kind: "class", cls }));

    support.forEach((cls) => {
      rows.push({ kind: "class", cls });
      studentRows(board, cls.id).forEach((student) => rows.push({ kind: "student", student, cls }));
    });
    return rows;
  }

  function applyBorders(ws, lastRow, teacherStartRow) {
    // 曜日の切れ目の太線。列番号は Step 1 の時限数から毎回計算する。
    // 以前は「月5・火〜金6」前提の列番号（7/13/19/25）を直書きしていたため、
    // 時限数を変えると線が曜日の途中に出た（7〜8限対応 2026-08-03）
    const dayEndCols = DAY_STARTS.slice(0, -1).map((start, i) => start + DAY_PERIODS[i] - 1);
    const dayStartCols = DAY_STARTS.slice(1);
    for (let row = 1; row <= lastRow; row += 1) {
      for (let col = 1; col <= AF_COL; col += 1) {
        const cell = ws.getCell(row, col);
        cell.border = { top: thin, left: thin, bottom: thin, right: thin };

        if (dayEndCols.includes(col)) cell.border.right = medium;
        if (dayStartCols.includes(col)) cell.border.left = medium;
        if (col === 1) cell.border.left = medium;
        if (col === AF_COL) cell.border.right = medium;
        if (row === 1) cell.border.top = medium;
        if (row === lastRow) cell.border.bottom = medium;
      }
    }

    [4, teacherStartRow - 1, teacherStartRow + 1].forEach((row) => {
      if (row < 1 || row > lastRow) return;
      for (let col = 1; col <= AF_COL; col += 1) {
        ws.getCell(row, col).border.bottom = medium;
      }
    });
  }

  function addHeaders(ws, row) {
    DAYS.forEach((day, dayIndex) => {
      const start = DAY_STARTS[dayIndex];
      const end = start + DAY_PERIODS[dayIndex] - 1;
      ws.mergeCells(row, start, row, end);
      ws.getCell(row, start).value = day;
      for (let period = 1; period <= DAY_PERIODS[dayIndex]; period += 1) {
        ws.getCell(row + 1, start + period - 1).value = period;
      }
      // 結合していても塗りはセルごとに要る
      for (let col = start; col <= end; col += 1) {
        ws.getCell(row, col).fill = headerFill;
        ws.getCell(row, col).font = { name: FONT, size: 12, bold: true };
        ws.getCell(row + 1, col).fill = headerFill;
        ws.getCell(row + 1, col).font = { name: FONT, size: 11, bold: true };
      }
    });
    // 見出しの左端（コマ数・名前の列）も同じ帯にする
    [1, 2].forEach((col) => {
      ws.getCell(row, col).fill = headerFill;
      ws.getCell(row + 1, col).fill = headerFill;
    });
    ws.getCell(row + 1, 1).value = "コマ";
    ws.getCell(row + 1, 1).font = { name: FONT, size: 9, bold: true };
  }

  function addConditionalFormats(ws, board, classStartRow, classEndRow, weekKind, expectedCounts,
                                 teacherStartRow, teacherEndRow) {
    if (classEndRow < classStartRow) return;

    DAY_STARTS.forEach((start, dayIndex) => {
      const end = start + DAY_PERIODS[dayIndex] - 1;
      const first = ws.getCell(classStartRow, start).address;
      const range = ws.getCell(classStartRow, start).address + ":" +
        ws.getCell(classEndRow, end).address;

      ws.addConditionalFormatting({
        ref: range,
        rules: [{
          type: "expression",
          formulae: [`COUNTIF($${ws.getColumn(start).letter}${classStartRow}:$${ws.getColumn(end).letter}${classStartRow},${first})<>1`],
          style: { fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFF0000" } } }
        }]
      });
    });

    // A週とB週で中身が違うマスを緑にする。式なので、Excel で手直ししたあとも
    // その場で色が付いたり消えたりする（もう一方のシートの同じ位置と見比べている）。
    // 学級の表だけでなく先生の表にも掛ける（PDFと同じ見え方にするため・実運用レビュー指示 2026-07-30）
    // 「毎週同じ」（1週）はシートが1枚だけで比較相手が存在しないため、この書式は付けない
    // （付けると存在しないシートへの INDIRECT 参照が配付ファイルに残る）
    if (!singleWeekBoard(board)) {
      const otherSheet = weekKind === "A" ? "B週" : "A週";
      const weekDiffRule = (startRow) => ({
        type: "expression",
        formulae: [`C${startRow}<>INDIRECT("'${otherSheet}'!"&ADDRESS(ROW(),COLUMN()))`],
        style: { fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFB6D7A8" } } }
      });
      const lastLetter = ws.getColumn(LAST_COL).letter;
      ws.addConditionalFormatting({
        ref: `C${classStartRow}:${lastLetter}${classEndRow}`,
        rules: [weekDiffRule(classStartRow)]
      });
      if (teacherStartRow && teacherEndRow >= teacherStartRow) {
        ws.addConditionalFormatting({
          ref: `C${teacherStartRow}:${lastLetter}${teacherEndRow}`,
          rules: [weekDiffRule(teacherStartRow)]
        });
      }
    }

    [...new Set(expectedCounts)].forEach((count) => {
      ws.addConditionalFormatting({
        ref: `A${classStartRow}:A${classEndRow}`,
        rules: [{
          type: "expression",
          formulae: [`A${classStartRow}=${count}`],
          style: { fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } } }
        }]
      });
    });
  }

  // 配付物の見出し。学校名は任意入力（Step 1）なので、未入力なら年度と「時間割」だけにする。
  // 埋まっていない見出しを配付物に載せないための決まり（画面の印刷ヘッダと同じ文言）
  function docTitle(board) {
    const meta = board.meta || {};
    const parts = [];
    if (Number(meta.schoolYear)) parts.push(meta.schoolYear + "年度");
    const name = String(meta.schoolName || "").trim();
    if (name) parts.push(name);
    parts.push("時間割");
    return parts.join(" ");
  }

  // Excel のヘッダー・フッターでは & が書式コードの開始記号なので、文字としての & は && にする。
  // 山かっこは xlsx の XML にそのまま載る値なので、念のため落としておく
  function headerText(text) {
    return String(text).replace(/[<>]/g, "").replace(/&/g, "&&");
  }

  // 学校名は自由入力なので、ファイル名に使えない文字を落としてから使う
  function sanitizeFilename(value) {
    return String(value).replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 30);
  }

  // 「毎週同じ」（1週）ではA週の概念がないため、シートは1枚だけ作る
  function singleWeekBoard(board) {
    return (Number((board.meta || {}).cycleWeeks) || 3) < 2;
  }

  function buildSheet(workbook, board, weekKind) {
    const sheetName = weekKind === "A" ? "A週" : (singleWeekBoard(board) ? "時間割" : "B週");
    const ws = workbook.addWorksheet(sheetName, {
      // 学級名（A・B列）と曜日・限（1〜4行目）を固定して、
      // 右や下へスクロールしても「どの学級のいつのコマか」を見失わないようにする
      views: [{ showGridLines: false, state: "frozen", xSplit: 2, ySplit: 4 }]
    });
    const classes = classRows(board);
    const teachers = board.teachers || [];
    const homerooms = (board.meta || {}).homerooms || {};
    const expectedCounts = (board.meta || {}).expectedClassHours || [29];

    ws.getColumn(1).width = 5.4;
    ws.getColumn(2).width = 10.1;
    for (let col = 3; col <= LAST_COL; col += 1) ws.getColumn(col).width = 7.6;
    ws.getColumn(AF_COL).width = 10;

    for (let row = 1; row <= FORMAT_ROWS; row += 1) {
      ws.getRow(row).height = 21;
      for (let col = 1; col <= AF_COL; col += 1) {
        ws.getCell(row, col).font = { name: FONT, size: 12 };
        ws.getCell(row, col).alignment = center;
      }
    }

    ws.getCell("B1").value = "体育";
    for (let col = 3; col <= LAST_COL; col += 1) {
      const letter = ws.getColumn(col).letter;
      ws.getCell(1, col).value = { formula: `COUNTIF(${letter}5:${letter}13,"保体")` };
    }
    ws.getCell("B2").value = singleWeekBoard(board) ? "" : (weekKind === "A" ? "A" : "B");
    ws.getCell("C2").value = { formula: "TODAY()" };
    ws.getCell("C2").numFmt = "m/d";

    addHeaders(ws, 3);

    const classStartRow = 5;
    let row = classStartRow;

    classes.forEach((item) => {
      if (item.kind === "class") {
        ws.getCell(row, 1).value = { formula: `COUNTA(C${row}:${ws.getColumn(LAST_COL).letter}${row})` };
        // 「誰の学級か」が分かるよう担任名を添える（PDFと同じ・実運用レビュー指示 2026-07-30）
        const hrTeacher = (board.teachers || []).find((t) => t.id === homerooms[item.cls.id]);
        ws.getCell(row, 2).value = (item.cls.name || "支援") +
          (hrTeacher && hrTeacher.name ? " " + hrTeacher.name : "");
        ws.getCell(row, 2).fill = nameFill;
        ws.getCell(row, 2).font = { name: FONT, size: 12, bold: true };
        ws.getCell(row, AF_COL).value = item.cls.name || "支援";
        ws.getCell(row, AF_COL).fill = nameFill;

        allSlots((day, dayIndex, period, col) => {
          ws.getCell(row, col).value = displayLesson(board, weekKind, item.cls.id, day, period);
        });
      } else {
        const mirror = (board.classes || []).find((c) => c.id === item.student.mirrorClassId);
        ws.getCell(row, 2).value = item.student.name + (mirror ? `（${mirror.name}）` : "");
        ws.getCell(row, 2).fill = studentFill;   // 支援学級の生徒は学級と区別する
        allSlots((day, dayIndex, period, col) => {
          ws.getCell(row, col).value = studentValue(board, weekKind, item.student, day, period);
        });
      }
      row += 1;
    });

    const classEndRow = row - 1;
    row += 1; // 空白行
    const teacherHeaderRow = row;
    addHeaders(ws, teacherHeaderRow);
    row += 2;
    const teacherStartRow = row;

    teachers.forEach((teacher) => {
      ws.getCell(row, 1).value = { formula: `COUNTA(C${row}:${ws.getColumn(LAST_COL).letter}${row})` };

      const homeroomClassId = Object.keys(homerooms).find((classId) => homerooms[classId] === teacher.id);
      const homeroomClass = (board.classes || []).find((c) => c.id === homeroomClassId);
      const prefix = homeroomClass && /^(\d+)-/.exec(homeroomClass.name);
      const fullWidthPrefix = prefix
        ? prefix[1].replace(/[1-9]/g, (digit) => "０１２３４５６７８９"[Number(digit)])
        : "";
      ws.getCell(row, 2).value = prefix ? `${fullWidthPrefix} ${teacher.name}` : teacher.name;
      ws.getCell(row, 2).fill = nameFill;
      ws.getCell(row, 2).font = { name: FONT, size: 12, bold: true };

      allSlots((day, dayIndex, period, col) => {
        ws.getCell(row, col).value = teacherCellValue(board, weekKind, teacher.id, day, period);
        if ((teacher.na || []).includes(day + "|" + period)) {
          ws.getCell(row, col).fill = {
            type: "pattern", pattern: "solid", fgColor: { argb: "FFD9D9D9" }
          };
        }
      });
      row += 1;
    });

    const lastRow = Math.max(row - 1, teacherStartRow);
    applyBorders(ws, lastRow, teacherStartRow);
    addConditionalFormats(ws, board, classStartRow, classEndRow, weekKind, expectedCounts,
                          teacherStartRow, lastRow);

    // 手作業で直すときの手がかりを最終行の下に置く（印刷範囲からは外す）
    const noteRow = lastRow + 2;
    ws.getCell(noteRow, 2).value = "色の意味";
    ws.getCell(noteRow, 2).font = { name: FONT, size: 11, bold: true };
    [
      ["緑", "FFB6D7A8", "もう一方の週と中身が違うコマ"],
      ["赤", "FFFF0000", "同じ教科が同じ日に2回（直してください）"],
      ["黄", "FFFFFF00", "1日のコマ数が想定どおり"],
      ["灰", "FFD9D9D9", "その教員が出られない時間"]
    ].forEach((item, i) => {
      const r = noteRow + i;
      ws.getCell(r, 3).fill = solid(item[1]);
      ws.getCell(r, 3).border = { top: thin, left: thin, bottom: thin, right: thin };
      ws.getCell(r, 4).value = item[2];
      ws.getCell(r, 4).alignment = { horizontal: "left", vertical: "center" };
      ws.getCell(r, 4).font = { name: FONT, size: 10 };
    });

    ws.pageSetup = {
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      paperSize: 9,
      margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
      // 2ページ目以降にも曜日と限の見出しを出す
      printTitlesRow: "3:4",
      // 凡例は配付物に載せない
      printArea: `A1:${ws.getColumn(AF_COL).letter}${lastRow}`
    };
    ws.headerFooter = {
      // 学校名と年度は各ページの上に出す。セルに置くと5行目始まりの行番号がずれて、
      // COUNTIF・印刷タイトル・条件付き書式がまとめて狂うのでページヘッダーに載せる
      oddHeader: `&C${headerText(docTitle(board))}`,
      oddFooter: `&L時間割${singleWeekBoard(board) ? "" : `（${weekKind === "A" ? "A週" : "B週"}）`}&R&P / &N`
    };
  }

  /* ---------- ExcelJS の遅延読み込み ---------- */
  // exceljs は約950KBあり、読むだけでも学校のPCでは数百ms持っていかれる。
  // 「Excelで書き出す」を押すまで一切使わないので、初期ロードでは読まずにここで取りに行く。
  // vendor は差し替えない前提なのでキャッシュバスターは付けない（版を上げる時は
  // ファイル名を変えるか、この定数に版を足して excel-export.js の ?v= も上げること）。
  const EXCELJS_SRC = "js/vendor/exceljs.min.js";
  let excelJsLoading = null;   // 読み込み中の待ち（同じ待ちに相乗りさせて二重読み込みを防ぐ）

  function loadExcelJs() {
    if (window.ExcelJS) return Promise.resolve();   // 読み込み済みなら即座に使える
    if (excelJsLoading) return excelJsLoading;
    const loading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = EXCELJS_SRC;
      s.onload = () => (window.ExcelJS
        ? resolve()
        : reject(new Error("ExcelJS が初期化されませんでした")));
      s.onerror = () => reject(new Error("ExcelJS の読み込みに失敗しました"));
      document.head.appendChild(s);
    });
    // 失敗した時は待ちを捨てる。そうしないと「もう一度押す」で永遠に同じ失敗を返してしまう
    loading.catch(() => { if (excelJsLoading === loading) excelJsLoading = null; });
    excelJsLoading = loading;
    return loading;
  }

  async function exportXlsx(boardState) {
    if (!boardState || !boardState.grid) {
      alert("書き出す時間割データがありません。");
      return;
    }

    try {
      await loadExcelJs();   // 未読込ならここで数秒かかる（呼び出し側がボタンで待ちを見せる）
    } catch (error) {
      console.error(error);
      alert("Excel書き出し機能を読み込めませんでした。\n通信状況を確認して、もう一度「Excelで書き出す」を押してください。");
      return;
    }

    try {
      setupColumns(boardState);   // この学校の時限数に合わせて列を組み直す
      const workbook = new ExcelJS.Workbook();
      workbook.creator = "NOBATASU 時間割作成ツール";
      workbook.created = new Date();
      buildSheet(workbook, boardState, "B");
      if (!singleWeekBoard(boardState)) buildSheet(workbook, boardState, "A");

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob(
        [buffer],
        { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
      );
      // 複数校・複数年度のファイルが手元に溜まっても見分けが付くよう、
      // 学校名と年度をファイル名に入れる（どちらも未入力なら「時間割.xlsx」のまま）
      const meta = boardState.meta || {};
      const namePart = sanitizeFilename(meta.schoolName || "");
      const yearPart = Number(meta.schoolYear) ? meta.schoolYear + "年度" : "";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = [yearPart, namePart, "時間割"].filter(Boolean).join("_") + ".xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch (error) {
      console.error(error);
      alert("Excel の書き出しに失敗しました: " + error.message);
    }
  }

  // preload: 結果画面を開いた時点で裏で先に取っておくための入口（読み込み済みなら何もしない）
  return { exportXlsx, preload: loadExcelJs };
})();
