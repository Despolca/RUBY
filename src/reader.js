import { ctx, log } from './env.js';

const BOOKMARK_NS = 'RubyAnalyzer';
export const MAX_READ_FLOORS = 20;
export const MAX_INPUT_CHARS = 200000;

export function capText(text, limit = MAX_INPUT_CHARS) {
    const s = String(text || '');
    if (s.length <= limit) return { text: s, truncated: 0 };
    return { text: s.slice(0, limit), truncated: s.length - limit };
}

export function isSystemHiddenMsg(m) {
    if (!m) return false;
    if (!m.is_system) return false;
    if (m.is_user) return false;
    return !!(m.name && m.mes && String(m.mes).trim().length > 0);
}

export function isAiReplyMsg(m) {
    if (!m) return false;
    if (m.is_user) return false;
    if (!m.is_system) return true;
    return isSystemHiddenMsg(m);
}

export function isUserMsg(m) {
    if (!m) return false;
    return !!m.is_user;
}

export function isReadableMsg(m) {
    return isAiReplyMsg(m) || isUserMsg(m);
}

export function countAiReplies(chatArr) {
    let n = 0;
    for (const m of chatArr || []) {
        if (isAiReplyMsg(m)) n++;
    }
    return n;
}

export function findAiReplyIndexByOrdinal(chatArr, ord) {
    let n = 0;
    for (let i = 0; i < (chatArr || []).length; i++) {
        if (isAiReplyMsg(chatArr[i])) {
            if (++n === ord) return i;
        }
    }
    return -1;
}

export function extractContent(mes, customTags = []) {
    if (!mes) return '';
    const defaultTags = ['content', 'maintext', 'text', 'body', 'message'];
    const contentTags = [...customTags, ...defaultTags];
    for (const tag of contentTags) {
        const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
        const match = String(mes).match(regex);
        if (match) return match[1].trim();
    }
    return mes;
}

export function cleanText(text) {
    if (!text) return '';
    let s = String(text);
    const blockTags = ['statusblock', 'options', 'other', 'thinking'];
    for (const tag of blockTags) {
        const re = new RegExp(`<\\s*${tag}\\b[\\s\\S]*?<\\s*\\/\\s*${tag}\\s*>`, 'ig');
        s = s.replace(re, '');
    }
    s = s.replace(/<!--[\s\S]*?-->/g, '');
    return s.trim();
}

function bookmarkStore() {
    const c = ctx();
    const meta = c?.chatMetadata;
    if (!meta) return null;
    meta.extensions ||= {};
    meta.extensions[BOOKMARK_NS] ||= {};
    meta.extensions[BOOKMARK_NS].lastReadFloor ||= {};
    return meta.extensions[BOOKMARK_NS].lastReadFloor;
}

export function getBookmark(taskKey) {
    const store = bookmarkStore();
    if (!store) return 0;
    const v = Number(store[taskKey]);
    return Number.isFinite(v) && v > 0 ? v : 0;
}

export function saveBookmark(taskKey, ordinal) {
    const store = bookmarkStore();
    if (!store || !Number.isFinite(ordinal) || ordinal <= 0) return;
    store[taskKey] = ordinal;
    const c = ctx();
    if (typeof c?.saveMetadataDebounced === 'function') {
        c.saveMetadataDebounced();
    }
}

export function resetBookmark(taskKey) {
    const store = bookmarkStore();
    if (store) delete store[taskKey];
}

/**
 * Đồng bộ lại bookmark sau khi xóa tin nhắn: deletedOldOrdinals là số thứ tự tầng AI của các tin nhắn bị xóa trước khi xóa.
 * Việc xóa làm cho số thứ tự các tầng tiếp theo dịch lên toàn bộ, bookmark phải trừ đi số tầng bị xóa nằm trước (bao gồm cả) vị trí bookmark,
 * nếu không, nội dung chưa đọc sau bookmark sẽ vượt qua bookmark và bị bỏ qua vĩnh viễn, khi xóa quá nhiều bookmark sẽ vượt giới hạn, nhiệm vụ kẹt vĩnh viễn.
 * Trả về danh sách mô tả bookmark có thay đổi (dùng cho nhật ký).
 */
export function resyncBookmarksAfterDeletion(deletedOldOrdinals, currentAiCount) {
    const store = bookmarkStore();
    if (!store || deletedOldOrdinals.length === 0) return [];
    const changed = [];
    for (const [taskKey, raw] of Object.entries(store)) {
        const b = Number(raw);
        if (!Number.isFinite(b) || b <= 0) continue;
        let next = b - deletedOldOrdinals.filter((d) => d <= b).length;
        let note = '';
        if (next > currentAiCount) {
            next = 0;
            note = ' (out of range, reset to rescan)';
        }
        if (next !== b) {
            store[taskKey] = next;
            changed.push(`${taskKey} ${b}→${next}${note}`);
        }
    }
    if (changed.length > 0) {
        const c = ctx();
        if (typeof c?.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
    }
    return changed;
}

export function incrementalRead(taskKey, customTags = [], options = {}) {
    const c = ctx();
    const liveChat = c?.chat || [];
    const charName = c?.name2 || c?.characters?.[c?.characterId]?.name || 'Nhân vật';
    const currentOrd = countAiReplies(liveChat);
    if (currentOrd <= 0) return { text: '', startFloor: 0, endFloor: 0, count: 0 };

    const bookmark = getBookmark(taskKey);
    // Khi giao diện tóm tắt được bật, hủy bỏ giới hạn cửa sổ 20 tầng: các tầng phía trước trong cửa sổ sẽ được thay thế bằng bản tóm tắt, chi phí token thực tế rất nhỏ
    const startFloor = (options.noWindowLimit && bookmark > 0)
        ? bookmark + 1
        : Math.max(
            bookmark > 0 ? bookmark + 1 : 1,
            currentOrd - MAX_READ_FLOORS + 1,
        );
    if (startFloor > currentOrd) {
        return { text: '', startFloor, endFloor: currentOrd, count: 0 };
    }

    const startIdx = startFloor > 1
        ? findAiReplyIndexByOrdinal(liveChat, startFloor - 1) + 1
        : 0;

    const lines = [];
    for (let i = startIdx; i < liveChat.length; i++) {
        const m = liveChat[i];
        if (!isReadableMsg(m)) continue;
        const role = isUserMsg(m) ? '{{user}}' : (m.name || charName);
        let text = extractContent(m.mes || '', customTags);
        text = cleanText(text);
        if (text) lines.push(`[${role}] ${text}`);
    }
    return {
        text: lines.join('\n\n'),
        startFloor,
        endFloor: currentOrd,
        count: currentOrd - startFloor + 1,
    };
}

/** Đọc văn bản gốc của một khoảng số thứ tự tầng [fromOrdinal, toOrdinal] (cùng định dạng với đọc tăng dần) */
export function readFloorsRange(fromOrdinal, toOrdinal, customTags = []) {
    const c = ctx();
    const liveChat = c?.chat || [];
    const charName = c?.name2 || c?.characters?.[c?.characterId]?.name || 'Nhân vật';
    if (!Number.isFinite(fromOrdinal) || !Number.isFinite(toOrdinal) || fromOrdinal > toOrdinal || fromOrdinal < 1) {
        return { text: '', count: 0 };
    }
    const startIdx = fromOrdinal > 1
        ? findAiReplyIndexByOrdinal(liveChat, fromOrdinal - 1) + 1
        : 0;
    const lines = [];
    let ord = fromOrdinal - 1;
    for (let i = startIdx; i < liveChat.length; i++) {
        const m = liveChat[i];
        if (isAiReplyMsg(m)) ord++;
        if (ord > toOrdinal) break;
        if (!isReadableMsg(m)) continue;
        const role = isUserMsg(m) ? '{{user}}' : (m.name || charName);
        let text = extractContent(m.mes || '', customTags);
        text = cleanText(text);
        if (text) lines.push(`[${role}] ${text}`);
    }
    return { text: lines.join('\n\n'), count: toOrdinal - fromOrdinal + 1 };
}

/** Chỉ số mảng tin nhắn → Số thứ tự tầng phản hồi của AI (dùng cho chuyển đổi ranh giới Tiểu Bạch x) */
export function ordinalForIndex(chatArr, idx) {
    if (!Number.isFinite(idx) || idx < 0) return 0;
    let n = 0;
    for (let i = 0; i <= Math.min(idx, (chatArr || []).length - 1); i++) {
        if (isAiReplyMsg(chatArr[i])) n++;
    }
    return n;
}

// ---------- Giao diện tóm tắt Tiểu Bạch x (LittleWhiteBox) ----------
// Chỉ đọc chat_metadata.extensions.LittleWhiteBox.storySummary, không import module Tiểu Bạch x, khớp nối bằng không.

export function getLittleWhiteBoxSummary() {
    const c = ctx();
    const store = c?.chatMetadata?.extensions?.LittleWhiteBox?.storySummary;
    if (!store || !store.json) return null;
    const boundary = Number(store.lastSummarizedMesId);
    if (!Number.isFinite(boundary) || boundary < 0) return null;
    const json = store.json;
    const facts = (Array.isArray(json.facts) ? json.facts : []).filter((f) => f && !f.retracted);
    const events = Array.isArray(json.events) ? json.events : [];
    if (facts.length === 0 && events.length === 0) return null;
    const chars = (json.characters?.main || []).map((m) => (typeof m === 'string' ? m : m?.name)).filter(Boolean);
    const arcs = Array.isArray(json.arcs) ? json.arcs : [];
    return { boundary, facts, events, characters: chars, arcs };
}

/** Render tóm tắt có cấu trúc của Tiểu Bạch x thành văn bản nhỏ gọn có thể phân tích */
export function renderLittleWhiteBoxSummary(s) {
    if (!s) return '';
    const lines = [];

    if (s.characters.length > 0) {
        lines.push(`Nhân vật chính: ${s.characters.join(', ')}`);
    }

    if (s.arcs.length > 0) {
        lines.push('Giai đoạn cốt truyện:');
        for (const arc of s.arcs.slice(0, 12)) {
            const name = arc?.name || arc?.title || arc?.label || '';
            const desc = arc?.description || arc?.summary || arc?.progress || '';
            if (name || desc) lines.push(`  - ${name}${desc ? `: ${desc}` : ''}`);
        }
    }

    if (s.events.length > 0) {
        lines.push('Sự kiện quan trọng:');
        for (const ev of s.events.slice(0, 40)) {
            const people = Array.isArray(ev?.participants) && ev.participants.length > 0 ? `[${ev.participants.join('/')}]` : '';
            const summary = String(ev?.summary || '').trim();
            const moments = Array.isArray(ev?.moments) ? ev.moments.map((m) => String(m?.text || '').trim()).filter(Boolean) : [];
            if (!summary && moments.length === 0) continue;
            if (summary) lines.push(`  - ${people}${summary}`);
            for (const mo of moments.slice(0, 4)) lines.push(`    · Động thái: ${mo}`);
        }
    }

    if (s.facts.length > 0) {
        // Phân nhóm theo s (chủ thể): Tên nhân vật → Vị ngữ: Tân ngữ
        const bySubject = new Map();
        for (const f of s.facts) {
            const subj = String(f?.s || '').trim() || 'Không rõ';
            if (!bySubject.has(subj)) bySubject.set(subj, []);
            const p = String(f?.p || '').trim();
            const o = String(f?.o || '').trim();
            if (p || o) bySubject.get(subj).push(`${p ? `${p}: ` : ''}${o}`);
        }
        lines.push('Sự thật trạng thái nhân vật:');
        for (const [subj, items] of bySubject) {
            lines.push(`  ${subj}:`);
            for (const item of items.slice(0, 15)) lines.push(`    - ${item}`);
        }
    }

    return lines.join('\n');
}

// ---------- Giao diện tóm tắt SP·Cơ sở dữ liệu (shujuku) ----------
// Plugin cơ sở dữ liệu gắn snapshot bảng vào tin nhắn chat (trường TavernDB_ACU_*), và đưa bản tóm tắt có thể đọc được
// ghi vào mục worldbook (Mục tóm tắt N / Mục nhân vật quan trọng N / TavernDB-ACU-OutlineTable).
// Chỉ khớp các mục mặc định (không có tiền tố cách ly ACU-[code]-): nhóm cách ly thuộc tính năng nâng cao của plugin,
// RUBY không thể biết mã cách ly hiện đang kích hoạt, việc trộn lẫn sẽ gây ra dữ liệu chuỗi nhóm. RUBY chỉ đọc, khớp nối bằng không.

const SHUJUKU_SUMMARY_RE = /^Mục tóm tắt(\d+)$/;
const SHUJUKU_PERSON_RE = /^Mục nhân vật quan trọng(\d+)$/;
const SHUJUKU_OUTLINE_RE = /^TavernDB-ACU-OutlineTable$/;

/** Chỉ số tin nhắn cuối cùng mà cơ sở dữ liệu đã xử lý đến (trên tin nhắn xuất hiện trường TavernDB_ACU_* tức là đã được xử lý) */
export function getShujukuBoundary() {
    const c = ctx();
    const chat = c?.chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && typeof m === 'object' && Object.keys(m).some((k) => k.startsWith('TavernDB_ACU_'))) {
            return i;
        }
    }
    return -1;
}

/**
 * Đọc các mục worldbook có thể đọc được của SP·Cơ sở dữ liệu và lắp ráp văn bản tóm tắt.
 * @param {string[]} books Danh sách tên worldbook (worldbook nhân vật + worldbook chat)
 * @returns {Promise<{boundary: number, text: string}|null>} Trả về null khi không có tin nhắn đã xử lý hoặc không có mục nào
 */
export async function getShujukuSummary(books) {
    const boundary = getShujukuBoundary();
    if (boundary < 0) return null;

    const c = ctx();
    const booksToScan = (Array.isArray(books) ? books : []).filter(Boolean);
    const summaryRows = [];
    const personRows = [];
    let outline = '';

    for (const bookName of booksToScan) {
        let data = null;
        try {
            data = await c?.loadWorldInfo?.(bookName);
        } catch { /* book unreadable */ }
        if (!data?.entries) continue;
        for (const e of Object.values(data.entries)) {
            const comment = String(e?.comment || '');
            let m = comment.match(SHUJUKU_SUMMARY_RE);
            if (m) {
                summaryRows.push({ idx: parseInt(m[1], 10), content: String(e.content || '').trim() });
                continue;
            }
            m = comment.match(SHUJUKU_PERSON_RE);
            if (m) {
                personRows.push({ idx: parseInt(m[1], 10), content: String(e.content || '').trim() });
                continue;
            }
            if (SHUJUKU_OUTLINE_RE.test(comment)) {
                outline = String(e.content || '').trim();
            }
        }
    }

    if (summaryRows.length === 0 && personRows.length === 0 && !outline) return null;

    const sections = [];
    if (summaryRows.length > 0) {
        summaryRows.sort((a, b) => a.idx - b.idx);
        sections.push(`[SP·Cơ sở dữ liệu·Bảng tóm tắt]\n${summaryRows.map((r) => r.content).join('\n')}`);
    }
    if (personRows.length > 0) {
        personRows.sort((a, b) => a.idx - b.idx);
        sections.push(`[SP·Cơ sở dữ liệu·Nhân vật quan trọng]\n${personRows.map((r) => r.content).join('\n')}`);
    }
    if (outline) {
        sections.push(`[SP·Cơ sở dữ liệu·Đại cương cốt truyện]\n${outline}`);
    }
    return { boundary, text: sections.join('\n\n') };
}

// ---------- Giao diện tóm tắt Bảng ký ức Yuzuki (yuzuki-Memory) ----------
// Chỉ đọc bảng memory_summary (tóm tắt ký ức) của chat_metadata.yuzukiMemory, không import module Yuzuki, khớp nối bằng không.
// Ghi chép tóm tắt bao phủ khoảng chỉ số tin nhắn chat (cơ số 0, bao gồm tầng người dùng): máy đọc meta.yzmMemoryTask.range (end là khoảng mở),
// Số tầng văn bản là khoảng đóng 'start-end' (phân tách bằng nhiều dòng, ký tự nối - ~ － — đến tới).
// Ranh giới = điểm cuối chuỗi liên tục của hợp tất cả các khoảng ghi chép tính từ tầng bao phủ nhỏ nhất (bao gồm chỉ số tin nhắn cuối),
// Cùng ngữ nghĩa với lastSummarizedMesId của Tiểu Bạch x, đưa trực tiếp vào ordinalForIndex của engine để chuyển đổi.

const YUZUKI_SUMMARY_TABLE_ID = 'memory_summary';
const YUZUKI_PLOT_TABLE_ID = 'plot_summary';
const YUZUKI_MAX_RECORD_CHARS = 600;
const YUZUKI_MAX_TOTAL_CHARS = 30000;
const YUZUKI_MAX_PLOT_LINES = 60;

function yuzukiState() {
    const c = ctx();
    const state = c?.chatMetadata?.yuzukiMemory;
    return (state && typeof state === 'object') ? state : null;
}

function yuzukiRecords(state, tableId) {
    const list = state?.records?.[tableId];
    return Array.isArray(list) ? list : [];
}

/** Danh sách khoảng đóng chỉ số tin nhắn được bao phủ bởi một ghi chép tóm tắt đơn; ưu tiên meta.yzmMemoryTask.range, dự phòng bằng văn bản số tầng */
function yuzukiRecordIntervals(record) {
    const metaRange = record?.meta?.yzmMemoryTask?.range;
    if (metaRange && Number.isFinite(Number(metaRange.start)) && Number.isFinite(Number(metaRange.end))) {
        const start = Math.max(0, Math.round(Number(metaRange.start)));
        const end = Math.max(start, Math.round(Number(metaRange.end)) - 1);
        return start <= end ? [[start, end]] : [];
    }
    const raw = String(record?.values?.['Số tầng'] || record?.values?.range || record?.values?.['Phạm vi tầng'] || record?.values?.['Tầng'] || '');
    const intervals = [];
    for (const m of raw.matchAll(/(\d+)\s*(?:-|~|－|—|đến|tới)\s*(\d+)/g)) {
        let start = Math.max(0, Math.round(Number(m[1])));
        let end = Math.max(0, Math.round(Number(m[2])));
        if (start > end) [start, end] = [end, start];
        intervals.push([start, end]);
    }
    return intervals;
}

/** Ranh giới đã tóm tắt: điểm cuối chuỗi liên tục của hợp các khoảng tính từ tầng bao phủ nhỏ nhất (bao gồm chỉ số tin nhắn cuối); trả về -1 nếu không có ghi chép hoặc không thể phân tích khoảng */
function yuzukiBoundary(records) {
    const intervals = [];
    for (const record of records) intervals.push(...yuzukiRecordIntervals(record));
    if (intervals.length === 0) return -1;
    intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let end = intervals[0][1];
    for (let i = 1; i < intervals.length; i++) {
        const [s, e] = intervals[i];
        // Dừng khi bao phủ xuất hiện lỗ hổng: khoảng cô lập chỉ tham gia render, không đẩy ranh giới lên, tránh việc thay thế nhầm các tầng chưa tóm tắt
        if (s > end + 1) break;
        if (e > end) end = e;
    }
    return end;
}

const yuzukiCut = (s, max) => (s.length > max ? `${s.slice(0, max)}… (đã cắt ngắn)` : s);

function yuzukiRenderRecord(record, index) {
    const v = record?.values || {};
    const title = String(v['Tiêu đề tóm tắt'] || '').trim();
    const floors = String(v['Số tầng'] || '').trim();
    const chars = String(v['Nhân vật cốt lõi'] || '').trim();
    const content = String(v['Nội dung tóm tắt'] || '').trim();
    const unresolved = String(v['Vấn đề chưa giải quyết'] || '').trim();
    const note = String(v['Ghi chú'] || '').trim();
    if (!title && !content && !floors) return '';
    const label = title || `Tóm tắt#${index + 1}`;
    const head = floors ? `[${label} (Bao phủ tầng ${floors.split(/\n+/).join(', ')})]` : `[${label}]`;
    const lines = [head];
    if (chars) lines.push(`Nhân vật cốt lõi: ${chars}`);
    if (content) lines.push(`Nội dung: ${yuzukiCut(content, YUZUKI_MAX_RECORD_CHARS)}`);
    if (unresolved) lines.push(`Vấn đề chưa giải quyết: ${unresolved}`);
    if (note) lines.push(`Ghi chú: ${note}`);
    return lines.join('\n');
}

function yuzukiPlotLines(state) {
    const lines = [];
    for (const record of yuzukiRecords(state, YUZUKI_PLOT_TABLE_ID)) {
        for (const col of ['Tuyến chính', 'Tuyến phụ']) {
            for (const line of String(record?.values?.[col] || '').split(/\n+/)) {
                const t = line.trim();
                if (t) lines.push(t);
            }
        }
    }
    return lines;
}

/**
 * Đọc tóm tắt Bảng ký ức Yuzuki và lắp ráp thành văn bản nhỏ gọn có thể phân tích.
 * @returns {{boundary: number, text: string}|null} Trả về null khi không có dữ liệu plugin/không có ghi chép tóm tắt/khoảng không thể phân tích (hồi lui về văn bản gốc thuần túy)
 */
export function getYuzukiSummary(includePlot = true) {
    const state = yuzukiState();
    if (!state) return null;
    const records = yuzukiRecords(state, YUZUKI_SUMMARY_TABLE_ID);
    const boundary = yuzukiBoundary(records);
    if (boundary < 0) return null;

    const sections = records.map(yuzukiRenderRecord).filter(Boolean);
    // Chống phình to: Khi tổng văn bản vượt quá giới hạn, bắt đầu vứt bỏ từ cái cũ nhất, giữ lại tóm tắt mới nhất
    let total = sections.reduce((sum, s) => sum + s.length, 0);
    while (sections.length > 0 && total > YUZUKI_MAX_TOTAL_CHARS) {
        total -= sections[0].length;
        sections.shift();
    }

    const parts = [...sections];
    if (includePlot) {
        const plotLines = yuzukiPlotLines(state);
        if (plotLines.length > 0) {
            const kept = plotLines.slice(-YUZUKI_MAX_PLOT_LINES);
            parts.push(`[Timeline tóm tắt cốt truyện (${kept.length} mục gần nhất)]\n${kept.join('\n')}`);
        }
    }
    if (parts.length === 0) return null;
    return { boundary, text: parts.join('\n\n') };
}

/** Thăm dò trạng thái bảng điều khiển: Trả về { records, boundary } khi có dữ liệu có thể tóm tắt, ngược lại trả về null */
export function getYuzukiStatus() {
    const state = yuzukiState();
    if (!state) return null;
    const records = yuzukiRecords(state, YUZUKI_SUMMARY_TABLE_ID);
    const boundary = yuzukiBoundary(records);
    if (boundary < 0) return null;
    return { records: records.length, boundary };
}

// ---------- Giao diện snapshot ký ức Bách Bảo Thư (BaiBaiBook) ----------
// Chỉ đọc globalThis.STBaiBaiBook.getSnapshot(), không import module Bách Bảo Thư, khớp nối bằng không.
// point.floor (mesid cơ số 0) của snapshot có cùng ngữ nghĩa với lastSummarizedMesId của Tiểu Bạch x,
// đưa trực tiếp vào ordinalForIndex của engine để chuyển đổi thành số thứ tự tầng AI.

const BAIBAIBOOK_MAX_TOTAL_CHARS = 40000;

const AFFINITY_INNER_LABELS = {
    '-2': 'Phản cảm mãnh liệt', '-1': 'Không thích', '0': 'Không rõ thích ghét', '1': 'Có thiện cảm', '2': 'Tình cảm sâu đậm',
};
const AFFINITY_OUTER_LABELS = {
    '-2': 'Rõ ràng thù địch', '-1': 'Lạnh nhạt xa cách', '0': 'Không rõ thân cận hay bài xích', '1': 'Thân thiện gần gũi', '2': 'Rõ ràng thân cận, tích cực bày tỏ',
};

function baibaibookAffinityLabel(value, labels) {
    if (value === null || value === undefined) return '';
    const key = String(value);
    return labels[key] || key;
}

/** Đọc an toàn snapshot API toàn cục của Bách Bảo Thư, trả về null khi không khả dụng */
function baibaibookSnapshot() {
    const api = globalThis.STBaiBaiBook;
    if (!api || typeof api.getSnapshot !== 'function') return null;
    try {
        return api.getSnapshot();
    } catch {
        return null;
    }
}

/** Render snapshot Bách Bảo Thư thành văn bản nhỏ gọn có thể phân tích (toàn bộ các mảng) */
function renderBaibaibookSummary(s) {
    if (!s) return '';
    const lines = [];

    // Tính toàn vẹn của độ bao phủ
    if (s.coverage && s.coverage.complete === false) {
        const missing = Array.isArray(s.coverage.missingAiFloors) ? s.coverage.missingAiFloors : [];
        if (missing.length > 0) {
            lines.push(`⚠️ Ký ức không hoàn chỉnh: Thiếu tầng AI ${missing.join(', ')}`);
        }
    }

    // Trạng thái hiện tại
    if (s.state) {
        const parts = [];
        if (s.state.time) parts.push(`Thời gian: ${s.state.time}`);
        if (s.state.location) parts.push(`Địa điểm: ${s.state.location}`);
        if (Array.isArray(s.state.locationPath) && s.state.locationPath.length > 0) {
            parts.push(`Vị trí: ${s.state.locationPath.join(' > ')}`);
        }
        if (parts.length > 0) lines.push(`[Trạng thái hiện tại]\n${parts.join('; ')}`);
    }

    // Nhân vật chính
    if (s.protagonist) {
        const p = s.protagonist;
        const parts = [];
        if (p.gender) parts.push(`Giới tính: ${p.gender}`);
        if (p.identity) parts.push(`Thân phận: ${p.identity}`);
        if (p.appearance) parts.push(`Ngoại hình: ${p.appearance}`);
        if (p.outfit) parts.push(`Trang phục: ${p.outfit}`);
        if (p.condition) parts.push(`Trạng thái: ${p.condition}`);
        if (parts.length > 0) lines.push(`[Nhân vật chính]\n${parts.join('; ')}`);
    }

    // NPC (Bao gồm thiện cảm và thái độ bề ngoài)
    if (Array.isArray(s.npcs) && s.npcs.length > 0) {
        lines.push('[Nhân vật xuất hiện]');
        for (const npc of s.npcs) {
            const parts = [];
            if (npc.name) parts.push(npc.name);
            if (npc.identity) parts.push(`Thân phận: ${npc.identity}`);
            if (npc.appearance) parts.push(`Ngoại hình: ${npc.appearance}`);
            if (npc.outfit) parts.push(`Trang phục: ${npc.outfit}`);
            if (npc.condition) parts.push(`Trạng thái: ${npc.condition}`);
            if (npc.personality) parts.push(`Tính cách: ${npc.personality}`);
            if (npc.tier) parts.push(`Phân cấp: ${npc.tier}`);
            const inner = baibaibookAffinityLabel(npc.affinityInner, AFFINITY_INNER_LABELS);
            const outer = baibaibookAffinityLabel(npc.affinityOuter, AFFINITY_OUTER_LABELS);
            if (inner) parts.push(`Thiện cảm nội tâm: ${inner}`);
            if (outer) parts.push(`Thái độ bề ngoài: ${outer}`);
            if (npc.affinityNote) parts.push(`Giải thích thiện cảm: ${npc.affinityNote}`);
            if (parts.length > 1) lines.push(`  - ${parts.join('; ')}`);
        }
    }

    // Danh sách vật phẩm
    if (Array.isArray(s.items) && s.items.length > 0) {
        lines.push('[Danh sách vật phẩm]');
        for (const item of s.items) {
            const parts = [];
            if (item.name) parts.push(item.name);
            if (item.description) parts.push(`Mô tả: ${item.description}`);
            if (item.location) parts.push(`Vị trí: ${item.location}`);
            if (item.quantity !== undefined && item.quantity !== null) parts.push(`Số lượng: ${item.quantity}`);
            if (item.status) parts.push(`Trạng thái: ${item.status}`);
            if (parts.length > 1) lines.push(`  - ${parts.join('; ')}`);
        }
    }

    // Nhật ký biến động vật phẩm (lấy 20 mục gần nhất)
    if (Array.isArray(s.itemLog) && s.itemLog.length > 0) {
        lines.push('[Nhật ký biến động vật phẩm]');
        for (const log of s.itemLog.slice(-20)) {
            const parts = [];
            if (log.action) parts.push(log.action);
            if (log.item) parts.push(log.item);
            if (log.detail) parts.push(log.detail);
            if (log.floor !== undefined && log.floor !== null) parts.push(`Tầng: ${log.floor}`);
            if (parts.length > 0) lines.push(`  - ${parts.join('; ')}`);
        }
    }

    // Kế hoạch và bí ẩn
    if (Array.isArray(s.plans) && s.plans.length > 0) {
        lines.push('[Kế hoạch và bí ẩn]');
        for (const plan of s.plans) {
            const parts = [];
            if (plan.title) parts.push(plan.title);
            if (plan.description) parts.push(plan.description);
            if (plan.status) parts.push(`Trạng thái: ${plan.status}`);
            if (parts.length > 0) lines.push(`  - ${parts.join('; ')}`);
        }
    }

    // Bối cảnh
    if (Array.isArray(s.scenes) && s.scenes.length > 0) {
        lines.push('[Bối cảnh]');
        for (const scene of s.scenes) {
            const parts = [];
            if (scene.name) parts.push(scene.name);
            if (scene.path) parts.push(`Đường dẫn: ${scene.path}`);
            if (scene.description) parts.push(scene.description);
            if (parts.length > 0) lines.push(`  - ${parts.join('; ')}`);
        }
    }

    // Hồ sơ sinh hoạt
    if (Array.isArray(s.lifeDetails) && s.lifeDetails.length > 0) {
        lines.push('[Hồ sơ sinh hoạt]');
        for (const detail of s.lifeDetails) {
            const parts = [];
            if (detail.subject) parts.push(detail.subject);
            if (detail.text) parts.push(detail.text);
            if (Array.isArray(detail.topics) && detail.topics.length > 0) parts.push(`Chủ đề: ${detail.topics.join(', ')}`);
            if (detail.tier) parts.push(`Cấp độ: ${detail.tier}`);
            if (parts.length > 0) lines.push(`  - ${parts.join('; ')}`);
        }
    }

    // Biến tùy chỉnh
    if (s.vars && typeof s.vars === 'object' && Object.keys(s.vars).length > 0) {
        lines.push('[Biến tùy chỉnh]');
        for (const [key, value] of Object.entries(s.vars)) {
            const v = typeof value === 'object' ? JSON.stringify(value) : String(value);
            lines.push(`  ${key}: ${v}`);
        }
    }

    let text = lines.join('\n');
    // Chống phình to: Cắt ngắn khi vượt quá giới hạn (giữ lại phần phía trước)
    if (text.length > BAIBAIBOOK_MAX_TOTAL_CHARS) {
        text = text.slice(0, BAIBAIBOOK_MAX_TOTAL_CHARS) + '… (đã cắt ngắn)';
    }
    return text;
}

/**
 * Đọc snapshot ký ức Bách Bảo Thư và lắp ráp thành văn bản nhỏ gọn có thể phân tích (toàn bộ các mảng).
 * @returns {{boundary: number, text: string}|null} Trả về null khi không có plugin/không có snapshot/không có tầng bao phủ (hồi lui về văn bản gốc thuần túy)
 */
export function getBaibaibookSummary() {
    const snapshot = baibaibookSnapshot();
    if (!snapshot) return null;
    const floor = Number(snapshot.point?.floor);
    if (!Number.isFinite(floor) || floor < 0) return null;
    // Khi at: "before", trạng thái không bao gồm tầng mục tiêu, ranh giới lùi một bước; at: "after" (mặc định) bao gồm tầng mục tiêu
    const at = String(snapshot.point?.at || 'after');
    const boundary = at === 'before' ? Math.max(0, floor - 1) : floor;
    if (boundary < 0) return null;
    const text = renderBaibaibookSummary(snapshot);
    if (!text) return null;
    return { boundary, text };
}

/** Thăm dò trạng thái bảng điều khiển: Trả về { revision, boundary } khi có dữ liệu snapshot, ngược lại trả về null */
export function getBaibaibookStatus() {
    const snapshot = baibaibookSnapshot();
    if (!snapshot) return null;
    const floor = Number(snapshot.point?.floor);
    if (!Number.isFinite(floor) || floor < 0) return null;
    const at = String(snapshot.point?.at || 'after');
    const boundary = at === 'before' ? Math.max(0, floor - 1) : floor;
    if (boundary < 0) return null;
    return { revision: Number(snapshot.revision) || 0, boundary };
}