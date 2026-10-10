// Chế độ Đạo diễn RUBY: Nhiệm vụ điều phối chu kỳ có cấu trúc cao.
// AI đạo diễn chạy một lần ở vị trí 1 mỗi chu kỳ, dựa theo chính văn/lịch sử/mức độ ưu tiên để xếp ra lịch trình "vị trí -> nhiệm vụ" cho chu kỳ này;
// Engine sẽ đánh thức các nhiệm vụ thông thường ở vị trí tương ứng theo kế hoạch (kế thừa toàn bộ luồng phân tích của nó), đạo diễn xếp trúng là chạy (bỏ qua quét từ khóa).
import { log, warn } from './env.js';

// ---------- Tính toán vị trí chu kỳ (Hàm thuần túy) ----------

/** Số lượt phản hồi tương đối sau khi bật mỏ neo (1 = phản hồi AI đầu tiên sau khi bật = vị trí chu kỳ 1) */
export function directorRel(aiCount, anchor) {
    return aiCount - anchor;
}

/** Vị trí chu kỳ tương ứng với số lượt phản hồi AI (1..cycleLength); chưa qua mỏ neo trả về 0 */
export function directorPosition(aiCount, anchor, cycleLength) {
    const rel = directorRel(aiCount, anchor);
    if (rel <= 0 || !cycleLength || cycleLength <= 0) return 0;
    return ((rel - 1) % cycleLength) + 1;
}

/** Vòng chu kỳ tương ứng với số lượt phản hồi AI (Bắt đầu từ 1) */
export function directorRound(aiCount, anchor, cycleLength) {
    const rel = directorRel(aiCount, anchor);
    if (rel <= 0 || !cycleLength || cycleLength <= 0) return 0;
    return Math.floor((rel - 1) / cycleLength) + 1;
}

// ---------- Tự động trích xuất giới thiệu nhiệm vụ ----------
// Khi creator không tự viết giới thiệu, sẽ chụp khoảng 200 chữ gần các từ đánh dấu trong nội dung mục prompt nhiệm vụ để làm giới thiệu mặt cắt nhiệm vụ.

const BRIEF_MARKERS = ['Nhiệm vụ này để', 'Giải thích nhiệm vụ', 'Giới thiệu nhiệm vụ', 'Mục tiêu nhiệm vụ', 'Nội dung nhiệm vụ', 'Nhiệm vụ này'];
const BRIEF_MAX_CHARS = 200;

export function extractTaskBrief(content, maxChars = BRIEF_MAX_CHARS) {
    const text = String(content || '')
        .replace(/```[a-zA-Z]*\n?/g, '')
        .replace(/<\/?[a-zA-Z][^>]*>/g, '')
        .trim();
    if (!text) return '';
    for (const marker of BRIEF_MARKERS) {
        const i = text.indexOf(marker);
        if (i >= 0) {
            const start = Math.max(0, i - 40);
            const slice = text.slice(start, start + maxChars + 40).trim();
            return slice.length > maxChars ? `${slice.slice(0, maxChars)}…` : slice;
        }
    }
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

// ---------- Khớp tên nhân vật tương tự (Lùi về khớp id khi đạo diễn xuất ra dùng tên nhiệm vụ) ----------

function normName(s) {
    return String(s || '').toLowerCase().replace(/[\s_-]+/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

function namesSimilar(a, b) {
    const na = normName(a);
    const nb = normName(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (na.length >= 2 && nb.length >= 2) return na.includes(nb) || nb.includes(na);
    return false;
}

// ---------- Lắp ráp prompt ----------

/** gemini 3.5 trở lên (Bao gồm pro/flash): Google đã hủy hỗ trợ điền trước (prefill) cho assistant, cần hạ tin nhắn điền trước xuống thành user.
 *  Phán đoán theo số phiên bản (gemini-3-flash không tính, gemini-2.5-pro không tính, gemini-3.5-flash/gemini-4-pro thì tính) */
export function isGeminiPostPrefillDrop(model) {
    const m = String(model || '');
    if (!/gemini/i.test(m)) return false;
    const v = m.match(/gemini[^0-9]*(\d+)(?:\.(\d+))?/i);
    if (!v) return false;
    const major = parseInt(v[1], 10);
    const minor = v[2] ? parseInt(v[2], 10) : 0;
    return major > 3 || (major === 3 && minor >= 5);
}

/**
 * Dịch chuyển tầng lầu sau khi xóa tin nhắn: Chỉ tiến lên khi tầng bị xóa < tầng mục tiêu VÀ <= tổng số tầng sau khi xóa (thực sự làm thay đổi số thứ tự phía sau).
 * Tạo lại (regenerate) tầng hiện tại (regenerate của ST sẽ xóa tầng cuối trước rồi mới xây lại tầng cùng số thứ tự) không thỏa mãn điều kiện --
 * Nếu không, mỗi lần tạo lại sẽ khiến tầng đạo diễn/kế hoạch lần tới tiến gần về tầng 1, tích lũy lại sẽ khiến chu kỳ bị đẩy nhanh một cách bất thường.
 * swipe (quét) là viết lại tại chỗ không kích hoạt sự kiện xóa, tự nhiên không bị ảnh hưởng.
 */
export function floorShift(deletedOrdinals, floor, aiCountAfter) {
    return (deletedOrdinals || []).filter((d) => d < floor && d <= aiCountAfter).length;
}

// ---------- Lắp ráp prompt ----------

/**
 * Lắp ráp prompt đạo diễn (Gửi đi như một tin nhắn user đơn lẻ sau khi qua buildMessages để tiêm phá giới hạn (jailbreak)).
 * @param {object} p
 * @param {{id:number,name:string,priority:number,brief:string}[]} p.tasks Danh sách nhiệm vụ được bật
 * @param {number} p.cycleLength Độ dài chu kỳ
 * @param {number} p.minSpacing Khoảng cách tối thiểu (0=AI toàn quyền)
 * @param {boolean} p.aggressive Chế độ quyết liệt: Đạo diễn tự quyết định thời gian xuất hiện lần tới
 * @param {number} p.round Vòng chu kỳ hiện tại
 * @param {{position:number,taskId:number,name:string}[]} p.lastCycle Nhiệm vụ chu kỳ trước
 * @param {{position:number,taskId:number,name:string}[]} p.woken Đã kích hoạt trong chu kỳ này
 * @param {{id:number,name:string,cyclesAgo:number}[]} p.overdue Nhiệm vụ lâu rồi chưa kích hoạt
 * @param {{planned:number,woken:number,manual:number}|null} p.lastStats Biểu hiện thực tế chu kỳ trước (Học lặp)
 * @param {string} p.contextText Ngữ cảnh chính văn
 * @param {string[]} p.refSections Đoạn mục tham khảo
 */
export function buildDirectorPrompt(p) {
    const L = p.cycleLength;
    const lines = [];

    lines.push('[Nhiệm vụ đạo diễn] Bạn là đạo diễn cốt truyện của thẻ này. Trách nhiệm chỉ có một: Lên lịch kích hoạt các nhiệm vụ phân tích cho chu kỳ này. Bản thân nhiệm vụ phân tích do hệ thống thực thi, bạn chỉ quyết định "nhiệm vụ nào xếp sau lần phản hồi AI thứ mấy của chu kỳ".');

    lines.push('[Danh sách nhiệm vụ] (id | Tên | Mức độ ưu tiên | Giới thiệu; Số ưu tiên càng lớn càng ưu tiên, 0 là bình thường)');
    if (p.tasks.length === 0) {
        lines.push('(Hiện tại không có nhiệm vụ nào có thể điều phối)');
    }
    for (const t of p.tasks) {
        lines.push(`task${t.id} | ${t.name} | Ưu tiên ${t.priority}${t.brief ? ` | ${t.brief}` : ' | (Không có giới thiệu)'}`);
    }

    lines.push('[Quy tắc xếp lịch]');
    lines.push(`1. Độ dài chu kỳ là ${L} lần AI phản hồi, vị trí 1 là chính bạn (đạo diễn), nhiệm vụ chỉ có thể xếp ở vị trí 2~${p.aggressive ? 'Trước khoảng cách đạo diễn lần tới' : L}.`);
    lines.push('2. Mỗi loại nhiệm vụ xuất hiện tối đa một lần trong chu kỳ này.');
    lines.push(p.minSpacing > 0
        ? `3. Mật độ nhiệm vụ (Quan trọng): Khoảng cách tối thiểu mà creator thiết lập là ${p.minSpacing} lần AI phản hồi, số lượng nhiệm vụ nên bám sát khoảng cách này - khoảng ${Math.max(1, Math.floor((L - 1) / p.minSpacing))} nhiệm vụ (${L} lầu ÷ ${p.minSpacing}). Có thể ít hơn một chút do nhu cầu cốt truyện, nhưng nếu ít hơn hẳn (ví dụ chỉ xếp một nửa trở xuống) thì thuộc về việc xếp lịch quá bảo thủ. Khoảng cách giữa các lần kích hoạt liền kề (bao gồm cả vị trí 1 của bạn) không được thấp hơn ${p.minSpacing}.`
        : `3. Mật độ nhiệm vụ (Quan trọng): ${L} lầu là một chu kỳ khá dài, ước tính trung bình 2~3 lầu một nhiệm vụ, thông thường nên phân bổ ${Math.max(2, Math.round(L / 3))}~${Math.max(3, Math.round(L / 2))} nhiệm vụ. Tự do tăng giảm theo nhịp điệu cốt truyện, nhưng đừng quá bảo thủ.`);
    lines.push('4. Phân bổ các bước phải đồng đều và có khoảng cách, đừng dồn đống nhiệm vụ ở đầu hoặc cuối chu kỳ.');
    lines.push('5. Ưu tiên sắp xếp các nhiệm vụ liên quan đến diễn biến chính văn lần này; khi chính văn nhắc đến một nhân vật nhiều lần, mà nhiệm vụ của nhân vật đó đã lâu chưa kích hoạt, hãy ưu tiên sắp xếp nhiệm vụ đó.');
    lines.push('6. Nhiệm vụ có số ưu tiên lớn hơn sẽ được cân nhắc trước trong cùng điều kiện.');
    lines.push('7. Cho phép tinh chỉnh số lượng vì nhu cầu cốt truyện, nhưng mật độ không nên sai lệch rõ rệt so với hướng dẫn trên - chu kỳ dài mà xếp quá thưa thớt sẽ làm đứt gãy việc phân tích.');

    lines.push('[Tham khảo điều phối]');
    lines.push(`Hiện tại là chu kỳ thứ ${p.round}.`);
    lines.push(`Nhiệm vụ chu kỳ trước: ${p.lastCycle.length > 0 ? p.lastCycle.map((a) => `Vị trí ${a.position} -> ${a.name}`).join('; ') : 'Không có ghi chép'}`);
    lines.push(`Đã kích hoạt trong chu kỳ này: ${p.woken.length > 0 ? p.woken.map((a) => `Vị trí ${a.position} -> ${a.name}`).join('; ') : 'Không có (Bạn nằm ở vị trí 1, là hành động đầu tiên của chu kỳ này)'}`);
    lines.push(`Lâu rồi chưa kích hoạt: ${p.overdue.length > 0 ? p.overdue.map((t) => `${t.name} (Đã ${t.cyclesAgo} chu kỳ chưa kích hoạt)`).join('; ') : 'Không có'}`);
    lines.push(p.lastStats
        ? `[Biểu hiện thực tế chu kỳ trước - Tham khảo học lặp] Chu kỳ trước lên kế hoạch ${p.lastStats.planned} nhiệm vụ, thực tế tự động kích hoạt ${p.lastStats.woken} nhiệm vụ, người chơi đã thực thi thủ công ${p.lastStats.manual} lần phân tích. Số lượng kích hoạt thực tế ít hơn hẳn so với kế hoạch cho thấy mật độ không khớp với nhịp điệu cốt truyện, lần xếp lịch này có thể điều chỉnh tương ứng; Thực thi thủ công nhiều cho thấy nhu cầu đối với phân tích đó cao, có thể tăng trọng số phù hợp.`
        : '[Biểu hiện thực tế chu kỳ trước] Không có lịch sử ghi chép (Chạy lần đầu).');

    if (p.contextText) {
        lines.push('[Ngữ cảnh chính văn] (Cơ sở để phán đoán tính liên quan giữa nhiệm vụ và cốt truyện)');
        lines.push(p.contextText);
    }
    if (p.refSections.length > 0) {
        lines.push('[Mục tham khảo] (Nội dung Worldbook mà creator cho là quan trọng đối với đạo diễn)');
        lines.push(p.refSections.join('\n\n'));
    }

    lines.push('[Định dạng đầu ra]');
    lines.push('Chỉ xuất ra một khối mã yaml, CẤM xuất ra bất kỳ chữ nào ngoài yaml:');
    lines.push('```yaml');
    lines.push('Sắp xếp chu kỳ:');
    lines.push('- Vị trí: 3');
    lines.push('  Nhiệm vụ: task1');
    lines.push('- Vị trí: 7');
    lines.push('  Nhiệm vụ: task2');
    if (p.aggressive) {
        lines.push('Khoảng cách đạo diễn lần tới: 12');
    }
    lines.push('```');
    lines.push(`Yêu cầu: Vị trí là số nguyên từ 2~${p.aggressive ? 'Khoảng cách đạo diễn lần tới trừ đi 1' : L}; Nhiệm vụ viết task id trong danh sách nhiệm vụ; Xếp theo vị trí từ nhỏ đến lớn; Mỗi nhiệm vụ xuất hiện tối đa một lần. ${p.aggressive ? '"Khoảng cách đạo diễn lần tới" do bạn quyết định: Một số nguyên K (2~60), đại diện cho việc sau K lần AI phản hồi bạn sẽ xuất hiện lại - tự định đoạt theo nhịp điệu cốt truyện, chỗ cốt truyện dày đặc thì có thể ngắn, thời kỳ trải thảm thì có thể dài.' : ''}`);

    return lines.join('\n\n');
}

// ---------- Phân tích đầu ra (Hai cấp độ Nghiêm ngặt -> Khoan dung) ----------

function yamlFences(text) {
    return [...String(text || '').matchAll(/```yaml[ \t]*\r?\n([\s\S]*?)```/g)].map((m) => m[1]).filter(Boolean);
}

/**
 * Phân tích đầu ra điều phối của đạo diễn.
 * @returns {{assignments:{position:number,taskId:number}[], directorGap:number|null, retryable:boolean, reason:string}}
 *   directorGap: "Khoảng cách đạo diễn lần tới" do đạo diễn tự quyết trong chế độ quyết liệt (thiếu thì là null);
 *   retryable=true biểu thị định dạng bị lộn xộn/nội dung không hoàn chỉnh (có thể tự động thử lại); assignments có thể là mảng rỗng nhưng phân tích thành công.
 */
export function parseDirectorSchedule(text, taskList) {
    const blocks = yamlFences(text);
    if (blocks.length === 0) {
        return { assignments: [], directorGap: null, retryable: true, reason: 'Không tìm thấy khối mã yaml trong đầu ra' };
    }
    let directorGap = null;
    for (const block of blocks) {
        const gm = block.match(/Khoảng cách đạo diễn lần tới\s*[:：]\s*(\d+)/);
        if (gm) directorGap = parseInt(gm[1], 10);
    }
    const idByName = new Map(taskList.map((t) => [t.id, t.name]));
    const resolveTaskId = (raw) => {
        const s = String(raw || '').trim();
        let m = s.match(/^task\s*(\d+)$/i) || s.match(/task\s*(\d+)/i);
        if (m) return parseInt(m[1], 10);
        // Lùi về khớp tên nhiệm vụ (bao gồm bóc tách tiền tố id)
        const bare = s.replace(/^task\d+\s*[:：]?\s*/i, '').trim();
        for (const [id, name] of idByName) {
            if (namesSimilar(bare || s, name)) return id;
        }
        return NaN;
    };

    // Cấp độ nghiêm ngặt: Theo cặp "Vị trí: N" / "Nhiệm vụ: taskM" (Hoặc tên nhiệm vụ)
    const assignments = [];
    let curPos = NaN;
    for (const block of blocks) {
        for (const line of block.split('\n')) {
            const pm = line.match(/Vị trí\s*[:：]?\s*(\d+)/);
            if (pm) {
                if (Number.isFinite(curPos)) continue; // Vị trí trước đó chưa khớp được nhiệm vụ, chờ dòng nhiệm vụ
                curPos = parseInt(pm[1], 10);
                continue;
            }
            const tm = line.match(/Nhiệm vụ\s*[:：]\s*(.+)/);
            if (tm && Number.isFinite(curPos)) {
                const taskId = resolveTaskId(tm[1]);
                if (Number.isFinite(taskId)) assignments.push({ position: curPos, taskId });
                curPos = NaN;
            }
        }
    }
    if (assignments.length > 0) {
        return { assignments, directorGap, retryable: false, reason: '' };
    }

    // Cấp độ khoan dung: Dạng một dòng "Vị trí 3: task1, task5" / "3: task1" / "- Vị trí 3 task1"
    for (const block of blocks) {
        for (const line of block.split('\n')) {
            const m = line.match(/^\s*-?\s*(?:Vị trí\s*)?(\d+)\s*[:：]\s*(.+)/);
            if (!m) continue;
            const pos = parseInt(m[1], 10);
            for (const part of m[2].split(/[,，、\s]+/)) {
                const taskId = resolveTaskId(part);
                if (Number.isFinite(taskId) && Number.isFinite(pos)) assignments.push({ position: pos, taskId });
            }
        }
    }
    if (assignments.length > 0) {
        log(`[director] schedule parsed in lenient mode (${assignments.length} entries, gap=${directorGap})`);
        return { assignments, directorGap, retryable: false, reason: '' };
    }

    // Kế hoạch rỗng hiển ngôn: Sắp xếp chu kỳ: [] / Không có
    const explicitEmpty = blocks.some((b) => /Sắp xếp chu kỳ\s*[:：]\s*(\[\s*\]|Không có|Trống)/.test(b));
    if (explicitEmpty) {
        return { assignments: [], directorGap, retryable: false, reason: '' };
    }
    return { assignments: [], directorGap, retryable: true, reason: 'Không phân tích ra được bất kỳ cặp Vị trí/Nhiệm vụ nào trong yaml' };
}

/**
 * Kiểm tra và chuẩn hóa điều phối: Loại bỏ vị trí vượt quá giới hạn/nhiệm vụ chưa bật, lọc trùng cùng nhiệm vụ (giữ lại vị trí đứng trước nhất), vi phạm khoảng cách chỉ cảnh báo.
 * @param {number} opts.maxPosition Giới hạn trên hợp lệ của vị trí (Chế độ thường = độ dài chu kỳ; Chế độ quyết liệt = Khoảng cách đạo diễn lần tới - 1)
 * @returns {{assignments:{position:number,taskId:number}[], warnings:string[], retryable:boolean, reason:string}}
 */
export function validateSchedule(assignments, { maxPosition, minSpacing, taskList }) {
    const enabled = new Map(taskList.map((t) => [t.id, t]));
    const warnings = [];
    const byTask = new Map();
    for (const a of [...assignments].sort((x, y) => x.position - y.position)) {
        const pos = Math.round(Number(a.position));
        const taskId = Math.round(Number(a.taskId));
        if (!Number.isFinite(pos) || pos < 2 || pos > maxPosition) {
            warnings.push(`Vị trí ${a.position} vượt quá giới hạn (phạm vi hợp lệ 2~${maxPosition}), đã loại bỏ`);
            continue;
        }
        if (!enabled.has(taskId)) {
            warnings.push(`task${a.taskId} không nằm trong danh sách nhiệm vụ được bật, đã loại bỏ`);
            continue;
        }
        if (byTask.has(taskId)) {
            warnings.push(`task${taskId} xuất hiện nhiều lần, chỉ giữ lại vị trí sớm nhất`);
            continue;
        }
        byTask.set(taskId, pos);
    }
    const final = [...byTask.entries()]
        .map(([taskId, position]) => ({ position, taskId }))
        .sort((x, y) => x.position - y.position);

    if (minSpacing > 0 && final.length > 0) {
        const positions = [1, ...final.map((a) => a.position)]; // Vị trí 1 là bản thân đạo diễn
        for (let i = 1; i < positions.length; i++) {
            const gap = positions[i] - positions[i - 1];
            if (gap < minSpacing) {
                warnings.push(`Vị trí ${positions[i]} và lần kích hoạt trước đó có khoảng cách là ${gap}, thấp hơn khoảng cách tối thiểu ${minSpacing} (Thực thi theo đầu ra của đạo diễn)`);
            }
        }
    }
    return { assignments: final, warnings, retryable: false, reason: '' };
}