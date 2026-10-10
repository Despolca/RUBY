// Chế độ viết thẻ RUBY: Lắng nghe kênh hội thoại nguyên bản, tự động quản lý việc tiêm mục Worldbook và ghi bản nháp theo từng bước.
// Hoàn toàn không can thiệp vào quá trình tạo - Creator sử dụng preset/API trò chuyện của riêng mình, RUBY chỉ lắng nghe và thao tác với Worldbook.
import { ctx, st, q, log, warn } from './env.js';
import * as config from './config.js';
import { CARDWRITER_DATA } from './cardwriter-data.js';

const DRAFT_BOOK = CARDWRITER_DATA.draftBook;
const DEEP_DEPTH = 0;
const DEEP_ORDER = 999;
const GUIDE_ORDER = 500;

const RULES_KEY = 'Quy tắc viết thẻ RUBY';
const PERSONA_KEY = 'Trợ lý viết thẻ Ruby';
const APPENDIX_KEY = 'Phụ lục nguyên lý RUBY Analyzer';
const STEP_PREFIX = 'Viết thẻ RUBY';

const state = {
    enabled: false,
    active: false,          // Trò chuyện hiện tại có đang trong phiên viết thẻ hay không
    stepId: null,           // Bước hiện tại (Step0..Step8 / StepX)
    lastStepId: null,       // Bước được tiêm lần trước (phát hiện chuyển đổi)
    lastHandledMessage: -1, // Tầng tin nhắn AI đã xử lý, chống lặp lại
    busy: false,
    lastError: null,
    lastAction: '',
    draftCount: 0,
    startedAt: null,
};

const listeners = new Set();
let initialized = false;

export function onStateChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function emitState() {
    for (const fn of listeners) {
        try { fn(getState()); } catch { /* ignore */ }
    }
}

export function getState() {
    return { ...state, stepName: getStep(state.stepId)?.name || '' };
}

export function getStep(stepId) {
    return CARDWRITER_DATA.steps.find((s) => s.id === stepId) || null;
}

export function getSteps() {
    return CARDWRITER_DATA.steps.map(({ id, name, optional, tool }) => ({ id, name, optional, tool }));
}

function notify(kind, message) {
    if (!config.getUi().notify) return;
    const fn = window.toastr?.[kind];
    if (typeof fn === 'function') fn(message, '', { timeOut: 4500 });
}

// ---------- Cấu hình (Công tắc viết thẻ lưu trong tùy chọn UI, tiến độ bước lưu theo metadata trò chuyện) ----------

function uiKey() {
    return 'cardwriter';
}

export function getSettings() {
    const ui = config.getUi() || {};
    return {
        enabled: !!ui[uiKey()]?.enabled,
        mode: ui[uiKey()]?.mode === 'dialogue' ? 'dialogue' : 'fast',
        draftToBook: ui[uiKey()]?.draftToBook !== false,
        showGuide: ui[uiKey()]?.showGuide !== false,
    };
}

export function saveSettings(patch) {
    const ui = config.getUi() || {};
    const cur = { enabled: false, draftToBook: true, showGuide: true, ...(ui[uiKey()] || {}) };
    const next = { ...cur, ...patch };
    config.saveUi({ [uiKey()]: next });
    window.dispatchEvent(new CustomEvent('ruby:cardwriter-changed'));
    return next;
}

// Metadata trò chuyện lưu tiến độ (độc lập mỗi trò chuyện)
function chatMetaKey() { return 'ruby_cardwriter'; }

function readProgress() {
    const c = ctx();
    const meta = c?.chatMetadata;
    const raw = meta?.[chatMetaKey()];
    return (raw && typeof raw === 'object') ? raw : null;
}

async function writeProgress(patch) {
    const c = ctx();
    if (!c?.chatMetadata) return;
    const cur = readProgress() || {};
    c.chatMetadata[chatMetaKey()] = { ...cur, ...patch, updatedAt: Date.now() };
    try {
        if (typeof c.saveMetadata === 'function') await c.saveMetadata();
    } catch (e) {
        warn(`saveMetadata failed: ${e.message}`);
    }
}

function clearProgress() {
    const c = ctx();
    if (!c?.chatMetadata) return;
    delete c.chatMetadata[chatMetaKey()];
    try { if (typeof c.saveMetadata === 'function') c.saveMetadata(); } catch { /* ignore */ }
}

// ---------- Thao tác mục Worldbook (API trực tiếp, bỏ qua trình phân tích lệnh gạch chéo) ----------
// Văn bản lệnh chứa {{user}}/{{recentMessages}}/``` v.v., đi qua luồng /setvar sẽ kích hoạt thay thế macro hoặc phân tích closure;
// Do đó thống nhất dùng loadWorldInfo -> Sửa đối tượng -> saveWorldInfo ghi trực tiếp, văn bản không bị hao hụt.
// role/position/depth/order đều là trường number (role: 0=system 1=user 2=assistant).

const ROLE_SYSTEM = 0;
const POS_AT_DEPTH = 4;

function stepKey(step) {
    return `${STEP_PREFIX}_${step.id.replace('.', '_')}`;
}

async function ensureDraftBook() {
    // Ưu tiên tạo Worldbook đính kèm trò chuyện với tên cố định "ruby viết thẻ bản nháp"; khi tên bị trò chuyện khác chiếm dụng thì lùi về tự động đặt tên
    try {
        const named = String(await st(`/getchatbook create=true name=${q(DRAFT_BOOK)}`)).trim();
        if (named) return named;
    } catch (e) {
        warn(`[cardwriter] named chat book unavailable (${e.message}), falling back to auto name`);
    }
    return String(await st('/getchatbook create=true')).trim();
}

function findEntryIn(entries, key) {
    for (const e of Object.values(entries)) {
        if (Array.isArray(e?.key) && e.key.includes(key)) return e;
    }
    return null;
}

/** Tìm mục trong các entries đã tải; không tồn tại thì dùng /createentry tạo (key là định danh ngắn an toàn) */
async function ensureEntryIn(book, entries, key) {
    const found = findEntryIn(entries, key);
    if (found) return found;
    const uidRaw = await st(`/createentry file=${q(book)} key=${q(key)} ""`);
    const uid = parseInt(uidRaw, 10);
    if (isNaN(uid)) throw new Error(`create entry failed: ${key}`);
    const c = ctx();
    const fresh = await c.loadWorldInfo(book);
    const e = fresh?.entries?.[uid];
    if (!e) throw new Error(`entry missing after create: ${key}`);
    if (!entries[uid]) entries[uid] = e;
    return e;
}

async function saveBook(book, data) {
    const c = ctx();
    await c.saveWorldInfo(book, data, true);
}

async function setupBaseEntries(book) {
    const c = ctx();
    const data = await c.loadWorldInfo(book);
    if (!data?.entries) throw new Error(`world book not found: ${book}`);
    const entries = data.entries;

    // Quy tắc + Thiết lập nhân vật: d0/999 nhấn mạnh thường trực độ sâu
    const rules = await ensureEntryIn(book, entries, RULES_KEY);
    Object.assign(rules, {
        content: CARDWRITER_DATA.rules,
        comment: 'Viết thẻ RUBY·Quy tắc bước (Thường trực)',
        position: POS_AT_DEPTH, depth: DEEP_DEPTH, order: DEEP_ORDER,
        role: ROLE_SYSTEM, constant: true, disable: false,
    });

    const persona = await ensureEntryIn(book, entries, PERSONA_KEY);
    Object.assign(persona, {
        content: CARDWRITER_DATA.persona,
        comment: 'Viết thẻ RUBY·Thiết lập nhân vật (Thường trực)',
        position: POS_AT_DEPTH, depth: DEEP_DEPTH, order: DEEP_ORDER - 1,
        role: ROLE_SYSTEM, constant: true, disable: false,
    });

    // Phụ lục mặc định tắt (có thể bật thủ công)
    const appendix = await ensureEntryIn(book, entries, APPENDIX_KEY);
    Object.assign(appendix, {
        content: CARDWRITER_DATA.appendix,
        comment: 'Viết thẻ RUBY·Phụ lục nguyên lý Analyzer (Theo yêu cầu)',
        position: POS_AT_DEPTH, depth: 4, order: 100,
        role: ROLE_SYSTEM, constant: true, disable: true,
    });

    await saveBook(book, data);
    log('[cardwriter] base entries ready (rules/persona @ depth0 order999, appendix disabled)');
}

const HOLD_KEY = 'Viết thẻ RUBY_Tiếp tục trò chuyện';
const ROADMAP_KEY = 'Viết thẻ RUBY_Bản đồ tuyến đường';
const LEGACY_STEP_IDS = ['Step6.5'];

/** Các bước lịch sử cần xóa (mục+hướng dẫn+bản nháp) khi vào một bước nào đó, tránh Worldbook bị dư thừa */
const CLEANUP_ON_ENTER = {
    Step4: ['Step1', 'Step2'], // Step3 đã được tích hợp vào thẻ nhân vật chính, bản nháp linh hồn/người sống hóa bị hủy bỏ
    Step8: ['Step7'],          // Kế hoạch phân tích đã bị thay thế bởi prompt
};

/** Khóa mục bản nháp của các bước */
function draftKeyOf(stepId) {
    return stepId === 'Step6' ? 'ruby bản nháp_Tổng quan nhân vật' : `ruby bản nháp_${stepId}`;
}

/** Xóa một nhóm mục từ dữ liệu Worldbook đã tải (khớp chính xác theo key) */
function deleteEntriesByKeys(entries, keys) {
    const keySet = new Set(keys);
    let removed = 0;
    for (const [uid, e] of Object.entries(entries)) {
        if (Array.isArray(e?.key) && e.key.some((k) => keySet.has(k))) {
            delete entries[uid];
            removed++;
        }
    }
    return removed;
}

/** Thu thập toàn bộ khóa liên kết của một bước: mục được tiêm, mục giải thích, mục bản nháp */
function stepArtifactKeys(stepId) {
    const sk = `Viết thẻ RUBY_${stepId.replace('.', '_')}`;
    return [sk, `${sk}_Giải thích`, draftKeyOf(stepId)];
}

/**
 * Bản đồ tuyến đường viết thẻ tích hợp (Tiêm thường trực, khoảng 300 token): Bảng tóm tắt quy trình hoàn chỉnh + Vị trí hiện tại + Hướng dẫn một câu.
 * Để AI mỗi vòng đều rõ ràng quy trình tổng thể, hiện đang ở bước nào, tiếp theo làm gì.
 */
function buildRoadmapContent(stepId) {
    const mainSteps = CARDWRITER_DATA.steps.filter((s) => s.id !== 'Overview' && s.id !== 'StepX');
    const overview = CARDWRITER_DATA.steps.find((s) => s.id === 'Overview');
    const lines = ['[Viết thẻ RUBY·Bản đồ tuyến đường quy trình] (Mục này do RUBY tự động bảo trì, cấm lặp lại toàn bộ bản đồ tuyến đường trong câu trả lời)', 'Quy trình viết thẻ hoàn chỉnh:'];
    mainSteps.forEach((s, i) => {
        lines.push(`${i + 1}. ${s.id} ${s.name}——${s.brief}`);
    });
    lines.push(`Cuối. ${overview.id} ${overview.name}——${overview.brief} (Chỉ có thể kích hoạt sau khi Creator thủ công tiến vào)`, '');
    const cur = getStep(stepId);
    if (!cur) {
        lines.push('Hiện tại: Không có bước nào đang hoạt động.');
    } else {
        const idx = mainSteps.findIndex((s) => s.id === stepId);
        const total = mainSteps.length;
        if (cur.id === 'Overview') {
            lines.push(`Hiện tại: Giai đoạn thu dọn (${overview.name}). ${overview.brief}.`);
        } else if (idx >= 0) {
            const next = mainSteps[idx + 1];
            lines.push(`Hiện tại: Bước ${idx + 1}/${total}——${cur.id} ${cur.name}, ${cur.brief}.`);
            if (next) {
                lines.push(`Tiếp theo: ${next.id} ${next.name} (${next.brief}). Bước này hoàn thành và xuất ra đánh dấu hoàn thành sẽ do RUBY tự động chuyển đổi, bây giờ bạn chỉ cần tập trung vào bước hiện tại.`);
            } else {
                lines.push('Bước này là bước cuối cùng của quy trình chính, sau khi hoàn thành Creator sẽ thủ công tiến vào tổng quan thu dọn.');
            }
        } else {
            lines.push(`Hiện tại: ${cur.id} ${cur.name}——${cur.brief} (Bước công cụ, không nằm trong trình tự quy trình chính).`);
        }
    }
    return lines.join('\n');
}

async function refreshRoadmapEntry(book, entries, stepId) {
    const entry = await ensureEntryIn(book, entries, ROADMAP_KEY);
    Object.assign(entry, {
        content: buildRoadmapContent(stepId),
        comment: 'Viết thẻ RUBY·Bản đồ tuyến đường quy trình (Tự động bảo trì)',
        position: POS_AT_DEPTH, depth: 1, order: 450,
        role: ROLE_SYSTEM, constant: true, disable: false,
    });
}

/** Khi trình chỉnh sửa Worldbook đang hiển thị cuốn sách này, render lại thành trạng thái lưu ổ đĩa mới nhất.
 *  /createentry của ST sẽ dùng bộ đệm trạng thái trung gian "tiện ích mở rộng chưa lưu trạng thái vô hiệu hóa" để làm mới trình chỉnh sửa,
 *  và trình chỉnh sửa sẽ không tự động làm mới theo saveWorldInfo của tiện ích mở rộng——không bù đắp cái này, người dùng sẽ thấy
 *  ảo giác là bước cũ vẫn đang bật, tiện tay chỉnh sửa sẽ ghi ảo giác đó trở lại đĩa */
function reloadEditorIfShowing(book) {
    try {
        const sel = $('#world_editor_select');
        if (!sel?.length) return;
        const selected = sel.find('option:selected')?.[0];
        if (!selected || selected.textContent !== book) return;
        sel.trigger('change');
    } catch { /* trình chỉnh sửa chưa mở hoặc không khả dụng */ }
}

async function setStepEntries(book, stepId) {
    const c = ctx();
    const data = await c.loadWorldInfo(book);
    if (!data?.entries) throw new Error(`world book not found: ${book}`);
    const entries = data.entries;

    // Chuyển đổi sẽ xóa tiêm tạm thời "tiếp tục trò chuyện" (xóa khi chuyển đổi giai đoạn tiếp theo)
    const holdRemoved = deleteEntriesByKeys(entries, [HOLD_KEY]);

    // Dọn dẹp các mục và bản nháp còn sót lại của bước bị loại bỏ (Step6.5 đã bị xóa khỏi quy trình)
    const legacyKeys = LEGACY_STEP_IDS.flatMap(stepArtifactKeys);
    const legacyRemoved = deleteEntriesByKeys(entries, legacyKeys);

    // Khi vào bước mục tiêu sẽ xóa các tàn tích của bước lịch sử (mục+hướng dẫn+bản nháp), tránh Worldbook bị dư thừa
    let cleanupRemoved = 0;
    if (stepId && CLEANUP_ON_ENTER[stepId]) {
        const keys = CLEANUP_ON_ENTER[stepId].flatMap(stepArtifactKeys);
        cleanupRemoved = deleteEntriesByKeys(entries, keys);
    }

    // Tắt toàn bộ mục bước (bao gồm cả mục hướng dẫn)
    for (const s of CARDWRITER_DATA.steps) {
        const key = stepKey(s);
        for (const k of [key, `${key}_Giải thích`]) {
            const e = findEntryIn(entries, k);
            if (e) e.disable = true;
        }
    }

    // ★ Đóng gói nguyên tử đoạn đầu: Lưu đĩa trạng thái cơ sở "toàn bộ bước đã tắt" trước.
    //   Sau đó bộ đệm trạng thái trung gian và việc làm mới trình chỉnh sửa do /createentry kích hoạt đều dựa trên dữ liệu các bước cũ đã tắt,
    //   Trong Worldbook bất kỳ lúc nào cũng sẽ không xuất hiện trạng thái bước trước và bước mới cùng bật
    await saveBook(book, data);

    if (stepId) {
        const step = getStep(stepId);
        if (step) {
            const key = stepKey(step);
            const entry = await ensureEntryIn(book, entries, key);
            Object.assign(entry, {
                content: step.instruction,
                comment: `Viết thẻ RUBY·${step.id} ${step.name}`,
                position: POS_AT_DEPTH, depth: 1, order: 600,
                role: ROLE_SYSTEM, constant: true, disable: false,
            });

            // Hướng dẫn bước (có thể bật/tắt): Theo sát sau lệnh
            if (getSettings().showGuide && step.guide) {
                const gEntry = await ensureEntryIn(book, entries, `${key}_Giải thích`);
                Object.assign(gEntry, {
                    content: step.guide,
                    comment: `Viết thẻ RUBY·${step.id} Hướng dẫn (Bong bóng đồng bộ)`,
                    position: POS_AT_DEPTH, depth: 1, order: GUIDE_ORDER,
                    role: ROLE_SYSTEM, constant: true, disable: false,
                });
            }
        }
    }

    // Bản đồ tuyến đường quy trình: Tiêm thường trực, làm mới theo bước hiện tại (đặt sau khi lưu đĩa trạng thái cơ sở, tránh quá trình tạo của nó mang lại trạng thái cũ)
    await refreshRoadmapEntry(book, entries, stepId);

    // ★ Đóng gói nguyên tử đoạn hai: Bật trạng thái cuối cùng của bước mục tiêu
    await saveBook(book, data);
    reloadEditorIfShowing(book);

    if (holdRemoved || legacyRemoved || cleanupRemoved) {
        log(`[cardwriter] cleanup on switch -> ${stepId || 'none'}: hold=${holdRemoved} legacy=${legacyRemoved} stepArtifacts=${cleanupRemoved}`);
    }

    // Nhật ký xác minh: Kiểm tra trạng thái tiêm trên console (constant+enabled+atDepth tức là sẽ tiêm mỗi vòng)
    const verify = [];
    for (const e of Object.values(data.entries)) {
        if (Array.isArray(e?.key) && e.key.some((k) => String(k).startsWith(STEP_PREFIX) || k === RULES_KEY || k === PERSONA_KEY)) {
            if (!e.disable) verify.push(`${e.key[0]}(constant=${e.constant},pos=${e.position},depth=${e.depth},role=${e.role},order=${e.order},${String(e.content || '').length}ch)`);
        }
    }
    log(`[cardwriter] step entries active: ${stepId || 'none'} | injecting: ${verify.join(' | ') || 'nothing'}`);
}

// ---------- Phát hiện đánh dấu hoàn thành ----------

// Kiểm tra kép Thẻ XML + Trường mỏ neo: Thẻ xác định phạm vi sản phẩm hoàn thành, trường mỏ neo chống phán đoán nhầm bản nháp.
// Các bước lenient: true (Sản phẩm Step5/6 bắt đầu bằng tên người hoặc khóa bất kỳ, không có từ mỏ neo ổn định) trong
// nhánh hạ cấp được nới lỏng thành "chấp nhận bất kỳ khối yaml không rỗng nào".
const FINISH_MARKERS = {
    Step0: { tag: 'step0_aesthetic_summary', matchKey: 'Khôi phục câu chuyện' },
    Step1: { tag: 'step1_soul_exploration', matchKey: 'Kinh nghiệm nhân sinh' },
    Step2: { tag: 'step2_living_character', matchKey: 'Cốt lõi nhân vật' },
    Step3: { tag: 'character', matchKey: 'character:' },
    Step4: { tag: 'Hồ sơ NSFW', matchKey: 'nsfw_profile' },
    Step5: { tag: 'step5_npc_design', matchKey: '', lenient: true },
    Step6: { tag: 'step6_quickview', matchKey: 'Mối quan hệ', lenient: true },
    Step7: { tag: 'step7_analysis_plan', matchKey: 'Nhiệm vụ' },
    Step8: { tag: 'step8_analysis_prompts', matchKey: 'Nhiệm vụ' },
};

// Đánh dấu thu dọn tổng quan: yaml có chứa "Người chơi đã hoàn thành"
const OVERVIEW_MARKER = /<ruby_overview>[\s\S]*?<\/ruby_overview>/;

function yamlBlocks(text) {
    return [...String(text || '').matchAll(/```yaml[ \t]*\r?\n([\s\S]*?)```/g)]
        .map((m) => m[1])
        .filter(Boolean);
}

/** Trích xuất sản phẩm hoàn thành của bước này, trả về '' biểu thị chưa hoàn thành (hoặc chỉ là hiển thị bản nháp).
 *  Nhận diện phân cấp (Vào lỏng ra chặt):
 *  A. Định dạng chuẩn: Thẻ XML + khối yaml + trường mỏ neo → Trực tiếp chấp nhận
 *  B. Định dạng hạ cấp: AI quên thẻ XML (Step4-6 thường gặp) → khối yaml + trúng mỏ neo cũng chấp nhận,
 *     khi lưu trữ tự động bổ sung thẻ quy chuẩn, giữ định dạng mục bản nháp thống nhất
 */
export function extractCompletion(stepId, text) {
    const s = String(text || '');

    if (stepId === 'Overview') {
        const m = s.match(OVERVIEW_MARKER);
        if (!m) return '';
        return /Người chơi đã hoàn thành/.test(m[0]) ? m[0].trim() : '';
    }

    const marker = FINISH_MARKERS[stepId];
    if (!marker) return '';

    // A. Định dạng chuẩn: Bọc trong thẻ XML (Phải đóng mở theo cặp mới có hiệu lực, đề phòng nhắc đến tên thẻ riêng lẻ trong bản nháp)
    const re = new RegExp(`<${marker.tag}>[\\s\\S]*?<\\/${marker.tag}>`);
    const m = s.match(re);
    if (m) {
        if (marker.matchKey && !m[0].includes(marker.matchKey) && !marker.lenient) {
            log(`[cardwriter] ${stepId} completion missing anchor key "${marker.matchKey}", treating as draft`);
            return '';
        }
        return m[0].trim();
    }

    // B. Định dạng hạ cấp: AI quên thẻ XML (Step4-6 thường gặp).
    //    Khi trong nội dung xuất hiện thẻ hoàn thành của bước khác, điều đó cho thấy đây là bản chốt/hiển thị lại của bước khác, không xử lý hạ cấp;
    //    Chỉ khi không có bất kỳ thẻ hoàn thành nào mới chấp nhận yaml trần.
    if (/<\/(step\d[\w]*|character|Hồ sơ NSFW|ruby_overview)>/.test(s)) {
        log(`[cardwriter] ${stepId} other step's completion tag present, skipping lenient match`);
        return '';
    }
    const blocks = yamlBlocks(s);
    if (blocks.length === 0) return '';
    let anchored = marker.matchKey
        ? blocks.filter((b) => b.includes(marker.matchKey))
        : blocks; // Bước không có mỏ neo: Khối không rỗng bất kỳ
    if (anchored.length === 0) {
        // Bước lenient (Step5/6): Không trúng mỏ neo cũng chấp nhận toàn bộ khối (sản phẩm thường bắt đầu bằng tên người, không có từ cố định)
        if (!marker.lenient) {
            log(`[cardwriter] ${stepId} bare yaml blocks found but none contains anchor "${marker.matchKey}", ignoring`);
            return '';
        }
        anchored = blocks;
        log(`[cardwriter] ${stepId} lenient step: anchor "${marker.matchKey}" not found, accepting all bare yaml blocks`);
    }
    const body = anchored.map((b) => '```yaml\n' + b + '\n```').join('\n');
    log(`[cardwriter] ${stepId} completion accepted without XML tag (lenient mode), wrapping with <${marker.tag}>`);
    return `<${marker.tag}>\n${body}\n</${marker.tag}>`;
}

// ---------- Ghi bản nháp: ruby viết thẻ bản nháp ----------

const ORDERED_STEPS = ['Step0', 'Step1', 'Step2', 'Step3', 'Step4', 'Step5', 'Step6', 'Step6.5', 'Step7', 'Step8'];

function draftOrderIndex(stepId) {
    return ORDERED_STEPS.indexOf(stepId);
}

/** Trích xuất tên character từ văn bản yaml (Step3/Step4) */
function extractCharacterName(yamlText) {
    const m = String(yamlText || '').match(/^\s*character:\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    return '';
}

/** Trích xuất khóa cấp cao nhất của yaml (Tên NPC v.v.); sau dấu hai chấm có thể là giá trị trên cùng dòng hoặc xuống dòng trực tiếp */
const STRUCTURAL_KEYS = new Set(['Mối quan hệ', 'Bí danh', 'Cơ bản', 'Ngoại hình', 'Ví dụ thoại', 'Giai thoại', 'Hành vi cụ thể', 'nsfw_profile', 'Đặc điểm', 'Kinh nghiệm', 'Hình thể', 'Ngữ liệu', 'Giới hạn cuối cùng', 'Tiêu chuẩn', 'Hướng dẫn sử dụng', 'Hướng dẫn', 'character', 'nickname']);

function extractTopLevelKeys(yamlText) {
    const keys = [];
    for (const line of String(yamlText || '').split('\n')) {
        const m = line.match(/^([^\s#:'"][^:]{0,30}?):(?:[ \t]|$)/);
        if (m) {
            const k = m[1].trim();
            if (!STRUCTURAL_KEYS.has(k)) keys.push(k);
        }
    }
    return [...new Set(keys)];
}

/** Đặc điểm đặt tên của prompt Step8: Thẻ xuất XML <TênNhânVật_LoạiPhânTích> */
function extractPromptNames(yamlText) {
    const names = [];
    for (const m of String(yamlText || '').matchAll(/<([^<>\s]{1,24})_[^<>\s]{1,24}>/g)) {
        names.push(m[1]);
    }
    return [...new Set(names)];
}

// ---------- Độ tương đồng danh tính nhân vật (Nhân vật cùng tên → cập nhật mục gốc, Nhân vật khác tên → lưu thành mục mới) ----------

function normName(s) {
    return String(s || '').toLowerCase().replace(/[\s_-]+/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

export function namesSimilar(a, b) {
    const na = normName(a);
    const nb = normName(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (na.length >= 2 && nb.length >= 2) return na.includes(nb) || nb.includes(na);
    return false;
}

/** Dựa vào khóa cấp cao nhất yaml (Dòng key: ở đầu cột) chia một khối yaml thành từng phần cho mỗi nhân vật */
function splitTopLevelSections(yaml) {
    const lines = String(yaml || '').split('\n');
    const sections = [];
    let cur = null;
    let prelude = [];
    for (const line of lines) {
        const m = line.match(/^([^\s#:'"][^:]{0,30}?):(?:[ \t]|$)/);
        if (m) {
            if (cur) sections.push(cur);
            cur = { name: m[1].trim(), lines: [line] };
        } else if (cur) {
            cur.lines.push(line);
        } else if (line.trim()) {
            prelude.push(line);
        }
    }
    if (cur) sections.push(cur);
    if (sections.length > 0 && prelude.length > 0) {
        sections[0].lines = [...prelude, ...sections[0].lines];
    }
    return sections;
}

/**
 * Khối hoàn thành Step5 → Mỗi nhân vật một phần. Quy ước định dạng (xem Lệnh Step5 "mỗi NPC hoặc nhóm độc lập một yaml"):
 * Trong khối hoàn thành có nhiều khối rào ```yaml, khóa cấp cao nhất của khối = Tên NPC/Tên nhóm; AI thỉnh thoảng nhét nhiều NPC vào một khối,
 * sẽ chia tách lần hai theo khóa cấp cao nhất. Các đoạn cấp cao nhất mang tính cấu trúc (trường xuyên nhân vật như mối quan hệ) được gộp vào phần đầu tiên.
 * Trả về [{ name, text }] (text là yaml có rào), khi không thể chia tách sẽ trả về toàn văn một phần.
 */
export function splitStep5Sections(completion) {
    const blocks = yamlBlocks(completion);
    const source = blocks.length > 0
        ? blocks
        : [String(completion || '').replace(/<\/?step5_npc_design>/g, '').trim()];
    let sections = [];
    for (const block of source) {
        const parts = splitTopLevelSections(block);
        if (parts.length === 0) continue;
        if (parts.length === 1) {
            sections.push({ name: parts[0].name, lines: parts[0].lines });
            continue;
        }
        const named = parts.filter((p) => !STRUCTURAL_KEYS.has(p.name));
        const shared = parts.filter((p) => STRUCTURAL_KEYS.has(p.name));
        const target = named.length > 0 ? named : parts;
        if (shared.length > 0 && target.length > 0) {
            target[0].lines = [...shared.flatMap((p) => p.lines), ...target[0].lines];
        }
        sections.push(...target);
    }
    sections = sections.filter((s) => s.name && s.lines.some((l) => l.trim()));
    if (sections.length === 0) {
        const fallback = source.join('\n\n').trim();
        return fallback ? [{ name: '', text: fallback }] : [];
    }
    return sections.map((s) => ({ name: s.name, text: '```yaml\n' + s.lines.join('\n').trim() + '\n```' }));
}

/**
 * Quy hoạch mục bản nháp các bước (Một khối hoàn thành → một hoặc nhiều mục bản nháp).
 * Các bước dạng nhân vật (Step3/4/5/8) chia mục theo danh tính nhân vật: Nhân vật cùng tên chạy lại → cập nhật mục gốc,
 * Nhân vật khác tên (độ tương đồng thấp) → lưu thành mục mới, hỗ trợ lặp lại thêm nhân vật mới.
 * Mỗi spec: { key, comment, position, order, constant, disable, names, keys, content, multi }
 *   names: Danh sách danh tính nhân vật (Dùng để khớp độ tương đồng với mục hiện có, khi cập nhật sẽ gộp vào từ khóa);
 *   keys:  Từ khóa hoàn chỉnh của mục mới; multi: Bước tích lũy nhiều vòng (không tự động đẩy tiếp)
 */
export function draftEntrySpecs(stepId, yamlText) {
    const idx = draftOrderIndex(stepId);
    const seq = idx >= 0 ? idx : 90;
    switch (stepId) {
        case 'Step0':
        case 'Step1':
        case 'Step2':
            return [{ key: `ruby bản nháp_${stepId}`, comment: `Bản nháp viết thẻ RUBY·${stepId}`, position: 0, order: 100 + seq, constant: false, disable: false, names: [], keys: [], content: yamlText, multi: false }];
        case 'Step3': {
            const name = extractCharacterName(yamlText) || 'Nhân vật chính';
            return [{ key: `ruby bản nháp_Step3_${name}`, comment: `Bản nháp viết thẻ RUBY·Step3 Thẻ nhân vật ${name}`, position: 0, order: 100 + seq, constant: false, disable: false, names: [name], keys: [name], content: yamlText, multi: false }];
        }
        case 'Step4': {
            const name = extractCharacterName(yamlText) || 'Nhân vật chính';
            return [{ key: `ruby bản nháp_Step4_${name}`, comment: `Bản nháp viết thẻ RUBY·Step4 Hồ sơ NSFW ${name}`, position: 0, order: 100 + seq, constant: false, disable: false, names: [name], keys: [name], content: yamlText, multi: false }];
        }
        case 'Step5': {
            // Thiết lập NPC: Trước nhân vật; mỗi NPC/nhóm là một mục độc lập (từ khóa = tên NPC đó), cùng tên cập nhật khác tên tạo mới
            const sections = splitStep5Sections(yamlText);
            return sections.map((s) => ({
                key: `ruby bản nháp_Step5_${s.name || 'NPC'}`,
                comment: `Bản nháp viết thẻ RUBY·Step5 NPC ${s.name || 'NPC'}`,
                position: 0, order: 50, constant: false, disable: false,
                names: [s.name], keys: [s.name || 'NPC'], content: s.text, multi: true,
            }));
        }
        case 'Step6': {
            // Tổng quan nhân vật: Mạng lưới quan hệ xuyên nhân vật, giữ cập nhật tổng thể mục đơn; từ khóa = Tổng quan nhân vật + tên nhân vật
            const names = extractTopLevelKeys(yamlText);
            return [{ key: 'ruby bản nháp_Tổng quan nhân vật', comment: 'Bản nháp viết thẻ RUBY·Step6 Tổng quan nhân vật', position: 0, order: 40, constant: true, disable: false, names: [], keys: ['Tổng quan nhân vật', ...names], content: yamlText, multi: false }];
        }
        case 'Step6.5':
            return [{ key: `ruby bản nháp_${stepId}`, comment: 'Bản nháp viết thẻ RUBY·Step6.5 Bàn giao sáng tác', position: 0, order: 30, constant: false, disable: false, names: [], keys: [], content: yamlText, multi: false }];
        case 'Step7':
            return [{ key: `ruby bản nháp_${stepId}`, comment: `Bản nháp viết thẻ RUBY·Step7 Kế hoạch phân tích`, position: 0, order: 100 + seq, constant: false, disable: false, names: [], keys: [], content: yamlText, multi: false }];
        case 'Step8': {
            // Prompt phân tích: Mục đóng; khớp theo tập hợp tên nhân vật prompt——Giao nhau thì cập nhật (hợp của từ khóa), nhân vật hoàn toàn mới thì lưu mới
            const names = extractPromptNames(yamlText);
            return [{
                key: names.length > 0 ? `ruby bản nháp_Step8_${names[0]}` : 'ruby bản nháp_Step8',
                comment: `Bản nháp viết thẻ RUBY·Step8 Prompt phân tích (Mục đóng)`,
                position: 0, order: 200 + seq, constant: false, disable: true,
                names, keys: names, content: yamlText, multi: true,
            }];
        }
        default:
            return [{ key: `ruby bản nháp_${stepId}`, comment: `Bản nháp viết thẻ RUBY·${stepId}`, position: 0, order: 90, constant: false, disable: false, names: [], keys: [], content: yamlText, multi: false }];
    }
}

/** Phán đoán giữ lại bản nháp (dùng cho thu dọn tổng quan): Các bước dạng nhân vật giữ lại toàn bộ mục được chia theo tiền tố */
export function isKeptDraftKey(key) {
    const k = String(key || '');
    return ['ruby bản nháp_Step0', 'ruby bản nháp_Step3', 'ruby bản nháp_Step4', 'ruby bản nháp_Step5', 'ruby bản nháp_Step8']
        .some((p) => k.startsWith(p)) || k === 'ruby bản nháp_Tổng quan nhân vật';
}

/**
 * Phân tích mục tiêu của mục bản nháp: Đầu tiên tìm mục hiện có trong các mục được chia cùng loại theo độ tương đồng danh tính nhân vật (Trúng → Cập nhật),
 * Không trúng thì tìm chính xác theo key, đều không có mới tạo (khi trùng tên key thì thêm số thứ tự).
 */
async function resolveDraftEntry(book, entries, spec) {
    if (spec.names.length > 0) {
        const prefix = spec.key.includes('_') ? spec.key.slice(0, spec.key.lastIndexOf('_') + 1) : `${spec.key}_`;
        for (const e of Object.values(entries)) {
            const keys = Array.isArray(e?.key) ? e.key : [];
            const primary = String(keys[0] || '');
            if (!primary.startsWith(prefix)) continue;
            const storedNames = keys.slice(1);
            if (storedNames.some((s) => spec.names.some((n) => namesSimilar(s, n)))) {
                log(`[cardwriter] draft upsert: matching existing entry ${primary} by character identity`);
                return e;
            }
        }
    }
    if (findEntryIn(entries, spec.key)) return await ensureEntryIn(book, entries, spec.key);
    let key = spec.key;
    let n = 2;
    while (findEntryIn(entries, key)) key = `${spec.key}_${n++}`;
    return await ensureEntryIn(book, entries, key);
}

export async function writeDraft(yamlText, stepId) {
    if (!getSettings().draftToBook) return null;
    const book = await ensureDraftBook();
    const specs = draftEntrySpecs(stepId, yamlText);
    if (specs.length === 0) return null;

    const c = ctx();
    const data = await c.loadWorldInfo(book);
    if (!data?.entries) throw new Error(`world book not found: ${book}`);
    const entries = data.entries;

    const writtenKeys = [];
    for (const spec of specs) {
        const entry = await resolveDraftEntry(book, entries, spec);
        const primary = String(entry.key?.[0] || spec.key);
        // Hợp của từ khóa: Khi cập nhật mục nhân vật hiện có thì giữ lại từ khóa cũ (Tên nhân vật không bị rơi mất), mục mới dùng spec.keys
        const oldExtras = Array.isArray(entry.key) ? entry.key.slice(1) : [];
        entry.key = [...new Set([primary, ...oldExtras, ...spec.keys])];
        entry.comment = spec.comment;
        entry.content = spec.content;
        entry.constant = !!spec.constant;
        entry.disable = !!spec.disable;
        entry.position = spec.position;
        entry.order = spec.order;
        entry.excludeRecursion = true;
        entry.preventRecursion = true;
        writtenKeys.push(primary);
        log(`[cardwriter] draft written: ${primary} -> ${book} (keys: ${entry.key.join(', ')})`);
    }

    await saveBook(book, data);
    state.draftCount += specs.length;
    const keyLabel = writtenKeys[0] + (writtenKeys.length > 1 ? ` cùng ${writtenKeys.length} mục khác` : '');
    return { key: keyLabel, multi: specs.some((s) => s.multi), count: specs.length };
}

// ---------- Chuyển đổi bước ----------

function nextStepOf(stepId) {
    const i = CARDWRITER_DATA.steps.findIndex((s) => s.id === stepId);
    if (i < 0 || i === CARDWRITER_DATA.steps.length - 1) return null;
    const next = CARDWRITER_DATA.steps[i + 1];
    // StepX là bước công cụ, không nằm trên chuỗi đẩy tự động
    if (next.tool) return null;
    return next.id;
}

export async function switchStep(stepId, { manual = false } = {}) {
    if (state.busy) return false;
    if (!state.active) {
        state.lastError = 'Phiên viết thẻ chưa kích hoạt';
        emitState();
        return false;
    }
    const step = getStep(stepId);
    if (stepId && !step) {
        state.lastError = `Bước không xác định: ${stepId}`;
        emitState();
        return false;
    }
    state.busy = true;
    try {
        const book = await ensureDraftBook();
        await setStepEntries(book, stepId);
        state.stepId = stepId;
        state.lastStepId = stepId;
        state.lastAction = `Chuyển đổi ${manual ? 'thủ công' : 'tự động'} → ${stepId || 'Kết thúc'}`;
        await writeProgress({ stepId, stepName: step?.name || '' });
        emitState();
        notify('info', `Viết thẻ RUBY: Đã chuyển sang ${stepId ? `${stepId} ${step?.name}` : 'Nhàn rỗi'}`);
        return true;
    } catch (e) {
        state.lastError = e.message;
        warn(`[cardwriter] switchStep failed: ${e.message}`);
        emitState();
        return false;
    } finally {
        state.busy = false;
    }
}

// ---------- Quản lý phiên ----------

export async function startSession(stepId = 'Step0') {
    if (state.busy) return false;
    if (!ctx()?.chat) {
        state.lastError = 'Vui lòng mở một trò chuyện trước';
        emitState();
        return false;
    }
    state.busy = true;
    try {
        const book = await ensureDraftBook();
        await setupBaseEntries(book);
        await setStepEntries(book, stepId);
        Object.assign(state, {
            active: true,
            stepId,
            lastStepId: stepId,
            lastHandledMessage: -1,
            lastError: null,
            lastAction: `Bắt đầu phiên → ${stepId}`,
            draftCount: 0,
            startedAt: Date.now(),
        });
        await writeProgress({ stepId, stepName: getStep(stepId)?.name || '', finished: [], book });
        emitState();
        notify('success', `Phiên viết thẻ RUBY đã bắt đầu (${stepId}), quy tắc và thiết lập nhân vật đã được tiêm vào Worldbook trò chuyện`);
        return true;
    } catch (e) {
        state.lastError = e.message;
        warn(`[cardwriter] startSession failed: ${e.message}`);
        emitState();
        return false;
    } finally {
        state.busy = false;
    }
}

export async function endSession({ keepDrafts = true } = {}) {
    if (state.busy) return false;
    state.busy = true;
    try {
        const book = await ensureDraftBook();
        const c = ctx();
        const data = await c.loadWorldInfo(book);
        if (data?.entries) {
            if (!keepDrafts) {
                // Xóa toàn bộ các mục do RUBY tạo ra trong sách bản nháp (bước/hướng dẫn/thường trực/bản nháp/tiêm tạm thời/còn sót lại)
                for (const [uid, e] of Object.entries(data.entries)) {
                    const k = Array.isArray(e?.key) ? e.key[0] : '';
                    if (k === RULES_KEY || k === PERSONA_KEY || k === APPENDIX_KEY || k === HOLD_KEY ||
                        k.startsWith(STEP_PREFIX) || k.startsWith('ruby bản nháp_')) {
                        delete data.entries[uid];
                    }
                }
            } else {
                // Chỉ tắt các mục bước/quy tắc/thiết lập nhân vật/bản đồ tuyến đường, giữ lại bản nháp
                const offKeys = new Set([RULES_KEY, PERSONA_KEY, ROADMAP_KEY]);
                for (const s of CARDWRITER_DATA.steps) {
                    offKeys.add(stepKey(s));
                    offKeys.add(`${stepKey(s)}_Giải thích`);
                }
                for (const e of Object.values(data.entries)) {
                    if (Array.isArray(e?.key) && e.key.some((k) => offKeys.has(k))) e.disable = true;
                }
            }
            await saveBook(book, data);
            reloadEditorIfShowing(book);
        }
        Object.assign(state, {
            active: false,
            stepId: null,
            lastStepId: null,
            lastHandledMessage: -1,
            lastAction: keepDrafts ? 'Kết thúc phiên (Giữ lại bản nháp)' : 'Kết thúc phiên (Xóa sạch mục)',
        });
        clearProgress();
        emitState();
        notify('info', keepDrafts ? 'Phiên viết thẻ RUBY đã kết thúc, bản nháp được giữ lại trong Worldbook trò chuyện' : 'Phiên viết thẻ RUBY đã kết thúc, các mục viết thẻ đã bị xóa sạch');
        return true;
    } catch (e) {
        state.lastError = e.message;
        warn(`[cardwriter] endSession failed: ${e.message}`);
        emitState();
        return false;
    } finally {
        state.busy = false;
    }
}

// ---------- Lắng nghe tin nhắn ----------

function lastAiMessage() {
    const c = ctx();
    const chat = c?.chat;
    if (!Array.isArray(chat) || chat.length === 0) return null;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i]?.is_user === false && String(chat[i]?.mes || '').trim()) {
            return { index: i, message: chat[i] };
        }
    }
    return null;
}

// ---------- Chế độ trò chuyện: Popup xác nhận và tiêm tạm thời "Tiếp tục trò chuyện" ----------

/** Tiêm mục tạm thời "Tiếp tục trò chuyện": Báo cho Ruby biết Creator chưa hài lòng, tiếp tục thảo luận cho đến khi hài lòng mới xuất ra yaml hoàn chỉnh */
async function injectHoldEntry(book, stepId) {
    const c = ctx();
    const data = await c.loadWorldInfo(book);
    if (!data?.entries) throw new Error(`world book not found: ${book}`);
    const entries = data.entries;
    const step = getStep(stepId);
    const entry = await ensureEntryIn(book, entries, HOLD_KEY);
    Object.assign(entry, {
        content: [
            `【Phản hồi của Creator】 Creator chưa hoàn toàn hài lòng với sản phẩm của bước hiện tại 【${stepId} ${step?.name || ''}】。`,
            'Yêu cầu:',
            '- Đừng tùy tiện kết luận, đừng vội xuất ra tóm tắt yaml cuối cùng',
            '- Tiếp tục thảo luận, sửa đổi, hoàn thiện bước hiện tại với Creator',
            '- Cho đến khi Creator thể hiện sự hài lòng một cách rõ ràng, thì mới có thể xuất ra tóm tắt yaml hoàn chỉnh',
        ].join('\n'),
        comment: 'Viết thẻ RUBY·Tiếp tục trò chuyện (Tiêm tạm thời)',
        position: POS_AT_DEPTH, depth: 1, order: 550,
        role: ROLE_SYSTEM, constant: true, disable: false,
    });
    await saveBook(book, data);
    log('[cardwriter] hold entry injected (creator wants to keep chatting)');
}

/** Popup xác nhận chế độ trò chuyện: Chuyển bước tiếp theo / Tôi vẫn muốn trò chuyện thêm. Trả về Promise<'switch'|'chat'> */
function showStepConfirm(stepId) {
    return new Promise((resolve) => {
        const step = getStep(stepId);
        const next = nextStepOf(stepId);
        const overlay = document.createElement('div');
        overlay.id = 'ruby_cw_confirm';
        overlay.innerHTML = `
            <div class="cw-confirm-card">
                <div class="cw-confirm-title">✋ ${stepId} ${step?.name || ''} Phát hiện đánh dấu hoàn thành</div>
                <div class="cw-confirm-body">
                    Ruby đã xuất ra tóm tắt yaml hoàn chỉnh。${next ? `Sau khi xác nhận sẽ ghi vào bản nháp và chuyển sang <b>${next} ${getStep(next)?.name || ''}</b>。` : 'Sau khi xác nhận sẽ ghi vào bản nháp。'}
                    Nếu muốn tiếp tục sửa đổi/đánh bóng bước này, hãy chọn "Tôi vẫn muốn trò chuyện thêm"。
                </div>
                <div class="cw-confirm-actions">
                    <button class="cw-btn cw-btn-green" data-choice="switch">✅ Xác nhận${next ? `，chuyển sang ${next}` : ''}</button>
                    <button class="cw-btn cw-btn-outline" data-choice="chat">💬 Tôi vẫn muốn trò chuyện thêm</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        const done = (choice) => {
            overlay.remove();
            document.removeEventListener('keydown', onKey);
            resolve(choice);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') done('chat');
        };
        document.addEventListener('keydown', onKey);
        overlay.querySelector('[data-choice="switch"]')?.addEventListener('click', () => done('switch'));
        overlay.querySelector('[data-choice="chat"]')?.addEventListener('click', () => done('chat'));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) done('chat');
        });
    });
}

// ---------- Tổng quan thu dọn: Dọn dẹp cuối cùng ----------

/** Tổng quan hoàn thành: Chỉ giữ lại bản nháp Thẩm mỹ/Nhân vật/NSFW/Prompt phân tích, xóa sạch toàn bộ các mục RUBY còn lại */
async function finalCleanup() {
    const book = await ensureDraftBook();
    const c = ctx();
    const data = await c.loadWorldInfo(book);
    if (!data?.entries) throw new Error(`world book not found: ${book}`);
    const entries = data.entries;

    // Các bản nháp đầu ra được giữ lại: Thiết lập thẩm mỹ, thẻ nhân vật (bao gồm các mục chia theo nhân vật), Hồ sơ NSFW, thiết lập NPC, Tổng quan nhân vật, Prompt phân tích
    const removedKeys = new Set();
    let keptCount = 0;
    for (const [uid, e] of Object.entries(entries)) {
        if (!Array.isArray(e?.key)) continue;
        const k = e.key[0];
        const isRuby =
            k === RULES_KEY || k === PERSONA_KEY || k === APPENDIX_KEY || k === HOLD_KEY ||
            k.startsWith(STEP_PREFIX) || k.startsWith('ruby bản nháp_');
        if (isRuby && !isKeptDraftKey(k)) {
            delete entries[uid];
            removedKeys.add(k);
        } else if (isRuby) {
            keptCount++;
        }
    }
    await saveBook(book, data);
    reloadEditorIfShowing(book);
    const keptNames = Object.values(entries)
        .filter((e) => Array.isArray(e?.key) && isKeptDraftKey(e.key[0]))
        .map((e) => e.key[0]);
    log(`[cardwriter] final cleanup: removed ${removedKeys.size} entries (${[...removedKeys].join(', ')}), kept: ${keptNames.join(', ')}`);
    return { removed: removedKeys.size, kept: keptNames, keptCount };
}

async function handleGenerationEnded() {
    if (!state.active || state.busy) return;
    const last = lastAiMessage();
    if (!last) return;
    if (last.index <= state.lastHandledMessage) return; // Chống lặp lại (Sự kiện có thể kích hoạt nhiều lần trong quá trình truyền luồng)
    state.lastHandledMessage = last.index;

    const text = String(last.message.mes || '');
    const stepId = state.stepId;
    if (!stepId) return;

    const completion = extractCompletion(stepId, text);
    if (!completion) {
        state.lastAction = `Nhận được phản hồi (${stepId} Chưa phát hiện đánh dấu hoàn thành)`;
        emitState();
        return;
    }

    // Tổng quan thu dọn: Phát hiện yaml "Người chơi đã hoàn thành" → Dọn dẹp cuối cùng và kết thúc phiên
    if (stepId === 'Overview') {
        state.busy = true;
        try {
            const result = await finalCleanup();
            Object.assign(state, {
                active: false,
                stepId: null,
                lastStepId: null,
                lastHandledMessage: -1,
                lastAction: `Tổng quan hoàn thành → Đã dọn dẹp ${result.removed} mục dư thừa, giữ lại: ${result.kept.join(', ')}`,
            });
            clearProgress();
            notify('success', `Viết thẻ RUBY: Thu dọn hoàn tất! Đã dọn dẹp ${result.removed} mục quá trình, giữ lại thiết lập Thẩm mỹ/Nhân vật/NSFW và prompt phân tích`, { timeOut: 8000 });
        } catch (e) {
            state.lastError = e.message;
            warn(`[cardwriter] finalCleanup failed: ${e.message}`);
            notify('error', `Viết thẻ RUBY: Dọn dẹp thu dọn thất bại (${e.message})`);
        } finally {
            state.busy = false;
            emitState();
        }
        return;
    }

    // Chế độ trò chuyện: Khi bước không tích lũy phát hiện đánh dấu hoàn thành, sẽ bật popup xác nhận trước (Cơ hội để sửa đổi Ruby lâu dài;
    // Các bước dạng tích lũy Step5/Step8 dựa vào việc chuyển đổi thủ công, nên tự nhiên đã có cơ hội sửa đổi, không bật popup)
    const settings = getSettings();
    const APPEND_STEPS = new Set(['Step5', 'Step8']);
    if (settings.mode === 'dialogue' && !APPEND_STEPS.has(stepId)) {
        const choice = await showStepConfirm(stepId);
        if (choice === 'chat') {
            try {
                const book = await ensureDraftBook();
                await injectHoldEntry(book, stepId);
                state.lastAction = `Đã phát hiện đánh dấu hoàn thành ${stepId} → Creator chọn tiếp tục trò chuyện (Đã tiêm mục tiếp tục trò chuyện)`;
            } catch (e) {
                state.lastError = e.message;
                warn(`[cardwriter] injectHoldEntry failed: ${e.message}`);
            }
            emitState();
            return;
        }
    }

    state.busy = true;
    try {
        const spec = await writeDraft(completion, stepId);

        // Bước tích lũy nhiều vòng (Step5 NPC / Step8 Prompt): Có thể liên tục xuất ra nhân vật mới, chỉ tích lũy chứ không tự động đẩy tiếp
        if (spec?.multi) {
            state.lastAction = `Sản phẩm ${stepId} đã được tích lũy → ${spec.key} (Sau khi hoàn thành có thể thủ công chuyển sang bước tiếp theo)`;
            await writeProgress({ stepId, stepName: getStep(stepId)?.name || '' });
            notify('info', `Viết thẻ RUBY: Sản phẩm ${stepId} đã được ghi vào 《${DRAFT_BOOK}》 (${spec.key}). Bước này có thể xuất ra nhiều lần, sau khi hoàn thành vui lòng thủ công chuyển sang bước tiếp theo`);
        } else {
            const next = nextStepOf(stepId);
            if (next) {
                const book = await ensureDraftBook();
                await setStepEntries(book, next);
                state.stepId = next;
                state.lastStepId = next;
                state.lastAction = `${stepId} Hoàn thành → Đã lưu bản nháp → Chuyển sang ${next}`;
                await writeProgress({ stepId: next, stepName: getStep(next)?.name || '' });
                notify('success', `Viết thẻ RUBY: ${stepId} Hoàn thành, bản nháp đã được ghi vào 《${DRAFT_BOOK}》, đã chuyển sang ${next}`);
            } else {
                // Kết thúc chuỗi: Giữ lại bản nháp, dừng tiêm bước
                const book = await ensureDraftBook();
                await setStepEntries(book, null);
                state.stepId = null;
                state.lastAction = `${stepId} Hoàn thành → Đã lưu bản nháp → Quy trình viết thẻ hoàn tất (Có thể thủ công vào tổng quan thu dọn)`;
                await writeProgress({ stepId: null, done: true });
                notify('success', `Viết thẻ RUBY: ${stepId} Hoàn thành, toàn bộ bản nháp đã được ghi vào 《${DRAFT_BOOK}》. Quy trình viết thẻ hoàn tất, có thể thủ công vào "Tổng quan" trên trang viết thẻ để thu dọn`, { timeOut: 7000 });
            }
        }
        if (spec) {
            window.dispatchEvent(new CustomEvent('ruby:cardwriter-draft', { detail: { stepId, key: spec.key } }));
        }
    } catch (e) {
        state.lastError = e.message;
        warn(`[cardwriter] handleGenerationEnded failed: ${e.message}`);
        notify('error', `Viết thẻ RUBY: Xử lý đánh dấu hoàn thành thất bại (${e.message})`);
    } finally {
        state.busy = false;
        emitState();
    }
}

// ---------- Khởi tạo ----------

export function initCardWriter() {
    if (initialized) return;
    initialized = true;

    const c = ctx();
    if (!c?.eventSource || !c?.eventTypes) {
        warn('[cardwriter] event system unavailable');
        return;
    }

    c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => {
        setTimeout(async () => {
            state.active = false;
            state.stepId = null;
            state.lastStepId = null;
            state.lastHandledMessage = -1;
            state.lastError = null;
            state.draftCount = 0;
            // Khôi phục tiến độ từ metadata trò chuyện (Nếu trò chuyện này từng mở phiên viết thẻ thì khôi phục; bước không xác định được coi là tàn tích và không khôi phục)
            const progress = readProgress();
            if (progress?.stepId && getStep(progress.stepId)) {
                state.active = true;
                state.stepId = progress.stepId;
                state.lastStepId = progress.stepId;
                state.lastAction = `Khôi phục từ tiến độ trò chuyện (${progress.stepId})`;
                notify('info', `Viết thẻ RUBY: Đã phát hiện tiến độ viết thẻ của trò chuyện này (${progress.stepId}), đã khôi phục`);
            }
            emitState();
        }, 400);
    });

    c.eventSource.on(c.eventTypes.GENERATION_ENDED, () => {
        setTimeout(() => { handleGenerationEnded().catch((e) => warn(`[cardwriter] ${e.message}`)); }, 800);
    });

    log('[cardwriter] initialized, listening to generation events');
}

export function openDraftBook() {
    try {
        // Cùng cách thức với việc Tavern nhập sách nhúng: Mở ngăn kéo Worldbook và chọn sách bản nháp (không thay đổi bất kỳ trạng thái kích hoạt nào)
        $('#WIDrawerIcon')?.trigger?.('click');
        const sel = $('#world_editor_select');
        if (sel?.length) {
            // value của mục thả xuống là chỉ mục, text mới là tên sách: Khớp theo text rồi dùng value tương ứng để chọn
            const opt = sel.find('option').toArray().find((o) => o.textContent === DRAFT_BOOK);
            if (opt) {
                sel.val(opt.value).trigger('change');
                return true;
            }
            warn('[cardwriter] draft book not found in world list (is a chat open?)');
            return false;
        }
        warn('[cardwriter] world editor select not found');
        return false;
    } catch (e) {
        warn(`[cardwriter] open draft book failed: ${e.message}`);
        return false;
    }
}