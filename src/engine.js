import { ctx, log, warn } from './env.js';
import * as config from './config.js';
import * as scheduler from './scheduler.js';
import * as reader from './reader.js';
import * as worldbook from './worldbook.js';
import * as ai from './ai.js';
import * as director from './director.js';
import { BUILTIN_REFERENCES } from './builtin-refs.js';
import { buildMessages } from './jailbreak.js';

const state = {
    armed: false,
    running: false,
    needTick: false,
    layer: 'unavailable',
    identity: null,
    cycleLength: 0,
    baseline: 0,
    triggered: new Set(),
    aiSnapshot: [],
    lastError: null,
    lastRunAt: null,
    lastRunSummary: '',
};

const listeners = new Set();
let initialized = false;
let tickTimer = null;
const TICK_DELAY_MS = 1200;

export function onStateChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function emitState() {
    for (const fn of listeners) {
        try { fn(getEngineState()); } catch { /* ignore listener errors */ }
    }
}

/** Ảnh chụp trạng thái chế độ đạo diễn (dùng cho bảng điều khiển/lệnh trạng thái): Vòng, vị trí, kế hoạch sẵn sàng và số lượng ghi đè, kết quả chạy lần trước */
function directorStateSnapshot() {
    try {
        const c = ctx();
        if (!c) return { enabled: false };
        const { data, layer } = config.resolveConfig();
        if (layer !== 'character') return { enabled: false };
        const dirCfg = config.getActivePreset(data).director;
        if (!dirCfg?.enabled) return { enabled: false };
        const aiCount = reader.countAiReplies(c.chat);
        const meta = readDirectorMeta();
        const anchored = Number.isFinite(meta?.anchor);
        const plan = (meta?.plan && Number.isFinite(meta.plan.runFloor)) ? meta.plan : null;
        const dirApiCfg = config.getDirectorApiConfig();
        return {
            enabled: true,
            cycleLength: dirCfg.cycleLength,
            aggressive: !!dirCfg.aggressive,
            minSpacing: dirCfg.minSpacing,
            apiOverride: dirApiCfg.enabled ? { model: dirApiCfg.model || '', urlSet: !!dirApiCfg.url, keySet: !!dirApiCfg.key } : null,
            anchor: anchored ? meta.anchor : 0,
            runSeq: (meta?.history?.length || 0) + 1,
            offset: anchored ? aiCount - meta.anchor : 0,
            planReady: !!plan,
            planCount: plan?.assignments?.length || 0,
            planAssignments: (plan?.assignments || []).map((a) => ({ floor: a.floor, taskId: a.taskId })),
            nextDirectorFloor: meta?.nextDirectorFloor || 0,
            wokenCount: meta?.woken?.length || 0,
            manualRuns: meta?.manualRuns || 0,
            lastRunOk: meta?.lastDirectorRun ? !!meta.lastDirectorRun.ok : null,
            lastRunReason: meta?.lastDirectorRun?.reason || '',
        };
    } catch {
        return { enabled: false };
    }
}

export function getEngineState() {
    const c = ctx();
    const aiCount = c ? reader.countAiReplies(c.chat) : 0;
    return {
        armed: state.armed,
        running: state.running,
        layer: state.layer,
        cycleLength: state.cycleLength,
        aiCount,
        position: scheduler.positionFor(aiCount, state.cycleLength),
        charName: state.identity?.name || '',
        hasCharacter: !!state.identity,
        lastError: state.lastError,
        lastRunAt: state.lastRunAt,
        lastRunSummary: state.lastRunSummary,
        director: directorStateSnapshot(),
    };
}

function notify(kind, message, options = {}) {
    if (!config.getUi().notify) return;
    const fn = window.toastr?.[kind];
    if (typeof fn === 'function') fn(message, '', { timeOut: 4000, ...options });
}

export function initEngine() {
    if (initialized) return;
    initialized = true;

    const c = ctx();
    if (!c?.eventSource || !c?.eventTypes) {
        warn('event system unavailable, engine not started');
        return;
    }

    c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => {
        setTimeout(reinit, 300);
    });
    c.eventSource.on(c.eventTypes.GENERATION_ENDED, () => {
        scheduleTick();
    });
    c.eventSource.on(c.eventTypes.MESSAGE_RECEIVED, (_messageId, type) => {
        if (type === 'first_message') scheduleTick();
    });
    c.eventSource.on(c.eventTypes.MESSAGE_DELETED, () => {
        setTimeout(() => {
            const cc = ctx();
            if (!cc) return;
            handleMessagesDeleted(cc);
        }, 300);
    });

    setTimeout(reinit, 1500);
    log('engine initialized, listening to chat events');
}

export function reinit() {
    const c = ctx();
    if (!c) return;
    state.aiSnapshot = (c.chat || []).filter(reader.isAiReplyMsg);
    state.triggered.clear();
    state.lastError = null;

    state.identity = config.getCharacterIdentity();
    if (!state.identity) {
        state.armed = false;
        state.layer = 'unavailable';
        state.cycleLength = 0;
        log('no active character (or group chat), engine standby');
        emitState();
        return;
    }

    const { data, layer } = config.resolveConfig();
    state.layer = layer;
    if (layer !== 'character') {
        state.armed = false;
        state.cycleLength = 0;
        log(`engine standby: config not bound to a character card (layer=${layer}); bind via panel to arm`);
        emitState();
        return;
    }
    const preset = config.getActivePreset(data);
    const dirCfg = preset.director;
    const dirActive = !!(dirCfg?.enabled && (preset.tasks || []).some((t) => t.enabled));
    const len = scheduler.cycleLength(preset.startupTask, preset.tasks);

    // Khi tắt chế độ đạo diễn sẽ xóa siêu dữ liệu đạo diễn còn sót lại (bật lại sẽ neo lại, khớp với "chạy lần đầu sau 1~2 phản hồi")
    if (dirCfg?.enabled !== true) {
        const ns = c.chatMetadata?.extensions?.RubyAnalyzer;
        if (ns?.director) {
            delete ns.director;
            saveDirectorMeta();
        }
    }

    if (!dirActive && len <= 0) {
        state.armed = false;
        state.cycleLength = 0;
        log(`engine standby: no enabled tasks for "${state.identity.name}" (layer=${layer})`);
        emitState();
        return;
    }

    state.cycleLength = dirActive ? dirCfg.cycleLength : len;
    state.armed = true;
    state.baseline = reader.countAiReplies(c.chat);
    log(`engine armed | character=${state.identity.name} | layer=${layer} | preset=${preset.name} | ${dirActive ? `director cycle=${dirCfg.cycleLength} minSpacing=${dirCfg.minSpacing} retry=${dirCfg.retryLimit}` : `cycle=${len}`} | AI replies=${state.baseline} | position=${scheduler.positionFor(state.baseline, state.cycleLength)}/${state.cycleLength}`);
    emitState();
    sanitizeLegacyOutputFilters(preset);
}

/**
 * Tự động dọn dẹp lỗi tồn đọng từ lịch sử: Các phiên bản trước đó sẽ ghi nhầm từ khóa lọc "nsfw" (keysecondary) vào các mục đầu ra đèn xanh.
 * Chỉ thực thi khi sách trò chuyện đã được liên kết (không chủ động tạo sách); Các nhiệm vụ có tick chọn "Sử dụng từ khóa lọc tùy chọn" và đã điền nội dung trong bảng nhiệm vụ sẽ không bị ảnh hưởng.
 */
async function sanitizeLegacyOutputFilters(preset) {
    if (state.running) return;
    try {
        const chatBook = await worldbook.getExistingChatBookName();
        if (!chatBook) return;
        const tasks = [preset?.startupTask, ...(preset?.tasks || [])].filter(Boolean);
        const cleaned = await worldbook.sanitizeOutputFilters(chatBook, tasks);
        if (cleaned > 0) {
            notify('info', `🧹 Đã tự động dọn dẹp ${cleaned} từ khóa lọc bị lưu nhầm trên các mục đầu ra phân tích`, { timeOut: 6000 });
        }
    } catch (e) {
        warn(`output filter sanitize failed: ${e?.message || e}`);
    }
}

/**
 * Tái đồng bộ sau khi xóa tin nhắn: Xóa tin nhắn khiến số thứ tự tầng AI phía sau bị đẩy lên trước,
 * dấu trang của từng nhiệm vụ (số thứ tự tầng) và khóa lũy đẳng (idempotent key) đã kích hoạt phải lùi lại theo, nếu không:
 * - Các tầng chưa đọc sau dấu trang sẽ bị bỏ qua vĩnh viễn, nếu xóa quá nhiều dấu trang sẽ vượt giới hạn, nhiệm vụ kẹt cứng vĩnh viễn;
 * - Tầng được tạo lại sau khi xóa nằm trước dấu trang cũ và khóa lũy đẳng vẫn còn, sẽ vĩnh viễn không lọt vào tư liệu phân tích.
 * Các tầng bị xóa được nhận diện qua đối chiếu danh tính bằng ảnh chụp đối tượng tin nhắn AI trước khi xóa (swipe là sửa tại chỗ, sẽ không bị phán đoán nhầm).
 */
function handleMessagesDeleted(cc) {
    const aiCount = reader.countAiReplies(cc.chat);
    const snapshot = state.aiSnapshot;
    const present = new Set(cc.chat.filter((m) => m && typeof m === 'object'));
    const deletedOrdinals = [];
    snapshot.forEach((m, i) => {
        if (!present.has(m)) deletedOrdinals.push(i + 1);
    });
    if (deletedOrdinals.length > snapshot.length) {
        warn('deletion diff inconsistent, skip resync');
        state.aiSnapshot = (cc.chat || []).filter(reader.isAiReplyMsg);
        return;
    }
    state.aiSnapshot = (cc.chat || []).filter(reader.isAiReplyMsg);

    if (aiCount < state.baseline) {
        state.baseline = aiCount;
        log(`baseline resynced down to ${aiCount} after message deletion`);
    }
    if (deletedOrdinals.length === 0) return;

    // Chế độ đạo diễn (v2 điều phối tầng tuyệt đối): Xóa làm tầng tiến lên, kế hoạch/đạo diễn lần tới/neo đồng bộ tiến lên,
    // làm trống khóa lũy đẳng đạo diễn và bản ghi đã kích hoạt (tầng kế hoạch sau khi tiến lên có thể rơi vào khoảng đã chạy, kích hoạt lại một lần là có thể chấp nhận được)
    const dirMeta = cc.chatMetadata?.extensions?.RubyAnalyzer?.director;
    if (dirMeta?.v === 2) {
        // Quy tắc dịch chuyển: Chỉ những lần xóa "thực sự thay đổi số thứ tự tầng phía sau" mới tiến lên —— tầng bị xóa phải nhỏ hơn tầng mục tiêu
        // VÀ nhỏ hơn tổng số tầng sau khi xóa. Tạo lại (regenerate) tầng này (regenerate của ST sẽ xóa tầng cuối trước rồi mới xây lại, xem
        // ST Generate(): chat.length -= 1 + MESSAGE_DELETED) thuộc về xóa tầng cuối: Xóa xong lập tức xây lại
        // tầng cùng số thứ tự, số thứ tự phía sau không đổi —— nếu cũng tiến lên, mỗi lần tạo lại sẽ khiến tầng đạo diễn/kế hoạch lần tới
        // tiến gần về tầng 1, tích lũy lại sẽ khiến chu kỳ bị đẩy nhanh một cách bất thường. swipe là sửa tại chỗ, không kích hoạt sự kiện xóa.
        // Quy tắc dịch chuyển xem director.floorShift: Tạo lại (xóa tầng cuối xây lại) không tiến lên, để tránh chu kỳ bị đẩy nhanh bất thường
        const shiftFor = (floor) => director.floorShift(deletedOrdinals, floor, aiCount);
        if (dirMeta.plan?.runFloor !== undefined) {
            for (const a of dirMeta.plan.assignments || []) a.floor -= shiftFor(a.floor);
            dirMeta.plan.runFloor -= shiftFor(dirMeta.plan.runFloor);
        }
        if (Number.isFinite(dirMeta.nextDirectorFloor)) dirMeta.nextDirectorFloor -= shiftFor(dirMeta.nextDirectorFloor);
        if (Number.isFinite(dirMeta.anchor)) dirMeta.anchor -= shiftFor(dirMeta.anchor);
        for (const key of [...state.triggered]) {
            if (String(key).startsWith('dir_')) state.triggered.delete(key);
        }
        dirMeta.woken = [];
        saveDirectorMeta();
        log(`director resync: plan/next-director floors shifted for ${deletedOrdinals.length} deletion(s), dir idempotent keys cleared`);
    }

    const len = state.cycleLength > 0 ? state.cycleLength : 1;
    const fromRound = Math.ceil(deletedOrdinals[0] / len);
    let clearedKeys = 0;
    for (const key of [...state.triggered]) {
        const round = parseInt(key.split('_')[0], 10);
        if (Number.isFinite(round) && round >= fromRound) {
            state.triggered.delete(key);
            clearedKeys++;
        }
    }
    const changed = reader.resyncBookmarksAfterDeletion(deletedOrdinals, aiCount);
    log(`deletion resync: ${deletedOrdinals.length} AI floor(s) removed (first at ordinal ${deletedOrdinals[0]}), triggered keys cleared from round ${fromRound} (${clearedKeys}), bookmarks: ${changed.length > 0 ? changed.join(', ') : 'unchanged'}`);
}

function scheduleTick() {
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = setTimeout(tick, TICK_DELAY_MS);
}

// ---------- Chế độ đạo diễn: Trạng thái siêu dữ liệu trò chuyện (Neo/Kế hoạch/Lịch sử/Đã kích hoạt) ----------

function readDirectorMeta() {
    const c = ctx();
    const ns = c?.chatMetadata?.extensions?.RubyAnalyzer;
    const d = ns?.director;
    return (d && typeof d === 'object') ? d : null;
}

function saveDirectorMeta() {
    const c = ctx();
    if (typeof c?.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
}

/**
 * Lấy siêu dữ liệu đạo diễn (v2: Điều phối tầng tuyệt đối).
 * - anchor: Số tầng AI lúc đạo diễn chạy lần trước (hoặc neo lúc bật)
 * - nextDirectorFloor: Tầng tuyệt đối mà đạo diễn chạy lần tới (Chế độ thường = runFloor + độ dài chu kỳ; Chế độ quyết liệt = Đạo diễn tự quyết)
 * - plan: { runFloor, assignments:[{floor,taskId}] } (Vị trí quy đổi thành tầng tuyệt đối: runFloor + vị trí - 1)
 * - history: 5 chu kỳ gần nhất {runFloor, taskIds, planned, woken, manual} (Thống kê học lặp)
 * - manualRuns: Số lần phân tích do người chơi chạy thủ công trong chu kỳ này
 * Khi không có neo sẽ lấy số phản hồi AI hiện tại làm neo —— phản hồi AI tiếp theo sau khi bật chính là lần đạo diễn chạy đầu tiên (bắt đầu sau 1~2 phản hồi).
 * Định dạng cũ (v1 hệ thống vị trí chu kỳ) tự động làm mới, đạo diễn chạy lại một lần là được.
 */
function ensureDirectorMeta(aiCount) {
    const c = ctx();
    const ns = c?.chatMetadata?.extensions;
    if (!ns) return null;
    ns.RubyAnalyzer ||= {};
    let d = ns.RubyAnalyzer.director;
    if (!d || typeof d !== 'object' || d.v !== 2 || !Number.isFinite(d.anchor)) {
        d = ns.RubyAnalyzer.director = {
            v: 2,
            anchor: aiCount,
            nextDirectorFloor: aiCount + 1,
            plan: null,
            history: [],
            woken: [],
            manualRuns: 0,
        };
        log(`director anchored at AI reply ${aiCount}: first run right after the next reply (floor ${aiCount + 1})`);
        saveDirectorMeta();
    }
    d.history ||= [];
    d.woken ||= [];
    d.manualRuns ||= 0;
    return d;
}

/** Thống kê lâu chưa kích hoạt (Tính theo "số lần đạo diễn"): Kế hoạch đang hiệu lực = lần đạo diễn trước, lịch sử lần lượt lùi lại */
function computeOverdue(dmeta, taskList, runSeq) {
    const lastSeenSeq = new Map();
    const see = (taskId, seq) => {
        const prev = lastSeenSeq.get(taskId);
        if (prev === undefined || seq > prev) lastSeenSeq.set(taskId, seq);
    };
    if (dmeta?.plan?.assignments) {
        for (const a of dmeta.plan.assignments) see(a.taskId, runSeq - 1);
    }
    (dmeta?.history || []).forEach((h, idx) => {
        for (const taskId of h.taskIds || []) see(taskId, runSeq - 2 - idx);
    });
    return taskList
        .map((t) => ({ id: t.id, name: t.name, cyclesAgo: lastSeenSeq.has(t.id) ? runSeq - lastSeenSeq.get(t.id) : runSeq }))
        .filter((t) => t.cyclesAgo >= 1)
        .sort((a, b) => b.cyclesAgo - a.cyclesAgo)
        .slice(0, 6);
}

/** Thay thế bằng tóm tắt (Dùng chung cho nhiệm vụ thường và đạo diễn): Các tầng nằm giữa dấu trang -> ranh giới tóm tắt được đổi thành văn bản tóm tắt, sau ranh giới giữ nguyên bản gốc.
 *  Chỉ đổi inc.text (tư liệu phân tích), quét từ khóa, đếm tầng và dấu trang đều không bị ảnh hưởng */
function applySummaryReplacement(c, inc, providerSummary, customTags = []) {
    if (!providerSummary) return;
    const boundaryOrdinal = reader.ordinalForIndex(c.chat, providerSummary.boundary);
    if (boundaryOrdinal >= inc.startFloor) {
        const summarizedUpTo = Math.min(boundaryOrdinal, inc.endFloor);
        const sections = [];
        sections.push(`[${providerSummary.label} (Bản thay thế cô đọng của nội dung đã tóm tắt từ tầng ${inc.startFloor} đến ${summarizedUpTo}, dùng làm tư liệu phân tích)]\n${providerSummary.text}`);
        if (boundaryOrdinal < inc.endFloor) {
            const rawPart = reader.readFloorsRange(boundaryOrdinal + 1, inc.endFloor, customTags);
            if (rawPart.text) {
                sections.push(`[Chính văn lần này (Tăng dần, tầng ${boundaryOrdinal + 1} đến tầng ${inc.endFloor}, tổng cộng ${rawPart.count} tầng)]\n${rawPart.text}`);
            }
        } else {
            sections.push(`(Chính văn từ tầng ${inc.endFloor} trở về trước đã được thay thế hoàn toàn bởi ${providerSummary.label} ở trên, lần này không có chính văn mới nào chưa được tóm tắt)`);
        }
        inc.text = sections.join('\n\n');
        inc.summaryApplied = true;
        log(`${providerSummary.label} applied: floors ${inc.startFloor}-${summarizedUpTo} replaced by summary (boundary mesId=${providerSummary.boundary}, ${providerSummary.text.length} chars)`);
    } else {
        log(`summary boundary (ordinal ${boundaryOrdinal}) before read window start ${inc.startFloor}, no replacement`);
    }
}

async function tick() {
    if (!state.armed) return;
    if (state.running) {
        state.needTick = true;
        return;
    }
    const c = ctx();
    if (!c) return;

    const aiCount = reader.countAiReplies(c.chat);
    state.aiSnapshot = (c.chat || []).filter(reader.isAiReplyMsg);
    if (aiCount <= state.baseline) return;

    const { data, layer } = config.resolveConfig();
    if (layer !== 'character') {
        state.armed = false;
        state.cycleLength = 0;
        emitState();
        return;
    }
    const preset = config.getActivePreset(data);
    const dirCfg = preset.director;
    const dirActive = !!(dirCfg?.enabled && (preset.tasks || []).some((t) => t.enabled));

    // —— Chế độ đạo diễn: Điều phối tầng tuyệt đối —— Đạo diễn chạy ở nextDirectorFloor, nhiệm vụ được đánh thức theo tầng kế hoạch (vị trí tĩnh bị tiếp quản) ——
    if (dirActive) {
        const dmeta = ensureDirectorMeta(aiCount);
        if (!dmeta) return;
        state.baseline = aiCount;
        state.cycleLength = dirCfg.cycleLength;

        const batch = [];
        if (aiCount === dmeta.nextDirectorFloor) {
            const idemKey = `dir_${aiCount}_director`;
            if (!state.triggered.has(idemKey)) {
                state.triggered.add(idemKey);
                batch.push({ type: 'director', config: dirCfg, displayName: dirCfg.displayName || 'Chế độ đạo diễn', triggeredAt: 1, sourceFloor: aiCount, source: 'auto' });
            }
        } else if (dmeta.plan) {
            for (const a of dmeta.plan.assignments.filter((x) => x.floor === aiCount)) {
                const task = preset.tasks.find((t) => t.id === a.taskId && t.enabled);
                if (!task) continue;
                const type = `task_${task.id}`;
                const idemKey = `dir_${aiCount}_${type}`;
                if (state.triggered.has(idemKey)) {
                    log(`idempotent skip: ${task.displayName} (floor ${aiCount})`);
                    continue;
                }
                state.triggered.add(idemKey);
                batch.push({ type, config: task, displayName: task.displayName || `Nhiệm vụ #${task.id}`, triggeredAt: aiCount - dmeta.plan.runFloor + 1, sourceFloor: aiCount, source: 'director' });
                dmeta.woken.push({ floor: aiCount, taskId: task.id });
                saveDirectorMeta();
            }
        }
        emitState();
        if (batch.length === 0) return;
        log(`director trigger at AI reply ${aiCount}: ${batch.map((t) => t.displayName).join(', ')}`);
        await runPipeline(batch);
        if (state.needTick) {
            state.needTick = false;
            scheduleTick();
        }
        return;
    }

    // —— Điều phối chu kỳ tĩnh (Logic gốc) ——
    const startupTask = preset.startupTask;
    const tasks = preset.tasks;
    const len = scheduler.cycleLength(startupTask, tasks);
    if (len !== state.cycleLength) {
        state.cycleLength = len;
        log(`cycle length updated to ${len} (config changed)`);
    }
    if (len <= 0) {
        state.armed = false;
        emitState();
        return;
    }
    const from = state.baseline + 1;

    const batch = [];
    for (let cnt = from; cnt <= aiCount; cnt++) {
        const position = scheduler.positionFor(cnt, len);
        const tasksAtPos = scheduler.collectTasksAtPosition(startupTask, tasks, position, state.identity);
        for (const t of tasksAtPos) {
            const cycleRound = Math.ceil(cnt / len);
            const idemKey = `${cycleRound}_${position}_${t.type}`;
            if (state.triggered.has(idemKey)) {
                log(`idempotent skip: ${t.displayName} (round ${cycleRound} position ${position})`);
                continue;
            }
            state.triggered.add(idemKey);
            batch.push({ ...t, sourceFloor: cnt, source: 'auto' });
        }
    }
    state.baseline = aiCount;

    if (batch.length === 0) {
        log(`floor ${aiCount}: no task due (position ${scheduler.positionFor(aiCount, len)}/${len})`);
        return;
    }

    log(`auto trigger at AI reply ${aiCount}: ${batch.map((t) => t.displayName).join(', ')}`);
    await runPipeline(batch);

    if (state.needTick) {
        state.needTick = false;
        scheduleTick();
    }
}

export async function forceRun(kind, taskId) {
    const c = ctx();
    if (!c) throw new Error('SillyTavern context unavailable');
    if (state.running) throw new Error('Đã có nhiệm vụ phân tích đang thực thi, vui lòng đợi');

    state.identity = config.getCharacterIdentity();
    if (!state.identity) throw new Error('Vui lòng mở một cuộc trò chuyện nhân vật trước');

    const { data, layer } = config.resolveConfig();
    if (layer !== 'character') throw new Error('Cấu hình hiện tại chưa liên kết thẻ nhân vật: Vui lòng liên kết thẻ nhân vật hiện tại trong bảng điều khiển trước');
    const preset = config.getActivePreset(data);
    const aiCount = reader.countAiReplies(c.chat);
    const len = scheduler.cycleLength(preset.startupTask, preset.tasks) || 1;

    let batch = [];
    if (kind === 'startup') {
        if (!preset.startupTask?.enabled) throw new Error('Nhiệm vụ mở màn chưa bật');
        batch = [{
            type: 'startup',
            config: preset.startupTask,
            displayName: preset.startupTask.displayName || 'Phân tích mở màn',
            triggeredAt: scheduler.positionFor(aiCount, len),
            sourceFloor: aiCount,
            source: 'force',
        }];
    } else if (kind === 'task') {
        const task = preset.tasks.find((t) => t.id === taskId && t.enabled);
        if (!task) throw new Error(`Không tìm thấy nhiệm vụ #${taskId} đã bật`);
        batch = [{
            type: `task_${task.id}`,
            config: task,
            displayName: task.displayName || `Nhiệm vụ #${task.id}`,
            triggeredAt: scheduler.positionFor(aiCount, len),
            sourceFloor: aiCount,
            source: 'force',
        }];
    } else if (kind === 'all') {
        batch = scheduler.allEnabledTasks(preset.startupTask, preset.tasks, state.identity)
            .map((t) => ({ ...t, triggeredAt: scheduler.positionFor(aiCount, len), sourceFloor: aiCount, source: 'force' }));
        if (batch.length === 0) throw new Error('Không có nhiệm vụ nào được bật');
    } else if (kind === 'director') {
        const dirCfg = preset.director;
        if (!dirCfg?.enabled) throw new Error('Chế độ đạo diễn chưa bật: Vui lòng bật chu kỳ đạo diễn trong bảng đạo diễn trước');
        if (!(preset.tasks || []).some((t) => t.enabled)) throw new Error('Không có nhiệm vụ nào được bật, đạo diễn không có gì để điều phối');
        batch = [{ type: 'director', config: dirCfg, displayName: dirCfg.displayName || 'Chế độ đạo diễn', triggeredAt: 1, sourceFloor: aiCount, source: 'force' }];
    } else {
        throw new Error(`unknown forceRun kind: ${kind}`);
    }

    // Thực thi thủ công được tính vào thống kê học lặp đạo diễn (Số lần người chơi phân tích thủ công trong chu kỳ này)
    if (kind !== 'director') {
        const dm = readDirectorMeta();
        if (dm) {
            dm.manualRuns = (dm.manualRuns || 0) + batch.length;
            saveDirectorMeta();
        }
    }

    await runPipeline(batch);
    return `${batch.map((t) => t.displayName).join(', ')} đã thực thi xong`;
}

/**
 * Thực thi nhiệm vụ đạo diễn: Lắp ráp prompt có cấu trúc cao (Danh sách nhiệm vụ/Quy tắc xếp lịch/Tham khảo điều phối/Chính văn/Mục tham khảo/Định dạng đầu ra),
 * gọi API đạo diễn, phân tích lịch trình một cách nghiêm ngặt —— chỉ khi định dạng lộn xộn/nội dung không hoàn chỉnh mới tự động thử lại theo số lần creator thiết lập;
 * Sau khi thành công sẽ ghi kế hoạch vào siêu dữ liệu trò chuyện (tick tra bảng đánh thức) + mục kế hoạch Worldbook trò chuyện (giữ trạng thái đóng), và luân chuyển lịch sử 5 chu kỳ gần nhất.
 */
async function runDirectorTask(d, ctxObj) {
    const { cfgData, preset, charBook, chatBook, referencePool, referenceValues, providerSummary, customTags, apiCfg, genParams, chatIdAtStart, characterIdAtStart } = ctxObj;
    const c = ctx();
    const dirCfg = d.config;
    const L = dirCfg.cycleLength;
    const dmeta = ensureDirectorMeta(c ? reader.countAiReplies(c.chat) : 0);
    if (!dmeta) throw new Error('Siêu dữ liệu trò chuyện không khả dụng');
    const runSeq = dmeta.history.length + 1;

    // API đạo diễn độc lập (Người chơi tick chọn trên bảng, cài đặt toàn cục): Chỉ ghi đè url/key/model, các trường trống đi theo API phân tích RUBY;
    // Phương thức truyền như stream hoàn toàn theo cài đặt API cơ sở RUBY, không có thiết kế truyền tải độc lập
    const dirApi = config.getDirectorApiConfig();
    const effApiCfg = dirApi.enabled
        ? { ...apiCfg, url: dirApi.url || apiCfg.url, key: dirApi.key || apiCfg.key, model: dirApi.model || apiCfg.model }
        : apiCfg;
    log(`director api: ${dirApi.enabled
        ? `Độc lập (model=${effApiCfg.model || 'Chưa thiết lập'} | url=${dirApi.url ? 'Đã ghi đè' : 'Đi theo'} | key=${dirApi.key ? 'Đã ghi đè' : 'Đi theo'})`
        : 'Chưa bật — Đi theo API cơ sở RUBY'}`);

    // Chính văn tăng dần (Dấu trang độc lập của đạo diễn); Khi thực thi thủ công nếu dấu trang đã tiến lên sẽ dẫn đến đọc rỗng, cần reset đọc lại
    let inc = reader.incrementalRead('director', customTags, { noWindowLimit: !!providerSummary });
    if (inc.count === 0 || !inc.text) {
        if (d.source === 'force') {
            reader.resetBookmark('director');
            inc = reader.incrementalRead('director', customTags, { noWindowLimit: !!providerSummary });
            log(`director force run: bookmark reset, re-reading ${inc.count} floors`);
        } else {
            log('director: no new floors since last run (bookmark at current), scheduling with empty context');
        }
    }
    applySummaryReplacement(c, inc, providerSummary, customTags);
    const contextText = reader.capText(inc.text).text;

    // Danh sách nhiệm vụ: id+tên bắt buộc gửi; Giới thiệu tự viết ưu tiên trước, nếu không sẽ tự động trích xuất khoảng 200 chữ cắt lớp từ mục prompt
    const enabledTasks = (preset.tasks || []).filter((t) => t.enabled);
    const taskList = [];
    for (const t of enabledTasks) {
        let brief = String(t.directorSummary || '').trim();
        if (!brief && t.promptKey) {
            try {
                const content = await worldbook.readEntry(charBook, chatBook, t.promptKey, true);
                brief = director.extractTaskBrief(content);
            } catch { /* Trích xuất giới thiệu thất bại cũng không chặn luồng */ }
        }
        taskList.push({ id: t.id, name: t.displayName || `Nhiệm vụ #${t.id}`, priority: t.directorPriority || 0, brief });
    }

    // Các mục tham khảo do đạo diễn tick chọn (Nội dung Worldbook mà creator cho là quan trọng đối với đạo diễn)
    const refSections = [];
    for (const varName of dirCfg.useReferences || []) {
        const content = referenceValues[varName];
        if (content && content !== '(Chưa thiết lập)') {
            const refConfig = referencePool.find((r) => r.varName === varName);
            refSections.push(`[${refConfig?.label || refConfig?.entryKey || varName}]\n${content}`);
        }
    }

    const round = runSeq;
    const prevPlan = dmeta.plan;
    const nameOf = (taskId) => taskList.find((t) => t.id === taskId)?.name || `Nhiệm vụ #${taskId}`;
    const lastCycle = (prevPlan?.assignments || []).map((a) => ({
        position: a.floor - prevPlan.runFloor + 1,
        taskId: a.taskId,
        name: nameOf(a.taskId),
    }));
    const woken = (dmeta.woken || []).map((a) => ({
        position: prevPlan ? a.floor - prevPlan.runFloor + 1 : a.floor,
        taskId: a.taskId,
        name: nameOf(a.taskId),
    }));
    const overdue = computeOverdue(dmeta, taskList, round);
    const lastStats = prevPlan ? {
        planned: prevPlan.assignments.length,
        woken: dmeta.woken.length,
        manual: dmeta.manualRuns || 0,
    } : null;

    const prompt = director.buildDirectorPrompt({
        tasks: taskList,
        cycleLength: L,
        minSpacing: dirCfg.minSpacing,
        aggressive: !!dirCfg.aggressive,
        round,
        lastCycle,
        woken,
        overdue,
        lastStats,
        contextText,
        refSections,
    });
    const messages = buildMessages('Chế độ đạo diễn', prompt, cfgData);

    // gemini 3.5 trở lên (gồm pro/flash) đã hủy hỗ trợ điền trước (prefill) assistant: Tin nhắn điền trước phá giới hạn tự động hạ xuống user
    const effModel = String(effApiCfg.model || '');
    if (director.isGeminiPostPrefillDrop(effModel)) {
        let converted = 0;
        for (const m of messages) {
            if (m.role === 'assistant') { m.role = 'user'; converted++; }
        }
        if (converted > 0) log(`gemini 3.5+ model detected (${effModel}): ${converted} prefill assistant message(s) -> user`);
    }

    // Đạo diễn chính là nhiệm vụ phân tích: genParams/messages hoàn toàn giống với vòng lặp nhiệm vụ; apiCfg chỉ ghi đè url/key/model theo thao tác copy/paste ở trang đạo diễn
    notify('info', '🎬 Đạo diễn đang lên lịch...', { timeOut: 4000 });
    const maxAttempts = 1 + Math.max(0, Math.round(dirCfg.retryLimit || 0));
    let parsed = null;
    let lastReason = '';
    let attempts = 0;
    while (attempts < maxAttempts) {
        attempts++;
        const result = await ai.callModel({
            apiCfg: effApiCfg,
            genParams,
            messages,
            taskLabel: `Chế độ đạo diễn${attempts > 1 ? `(Thử lại ${attempts - 1})` : ''}`,
        });
        parsed = director.parseDirectorSchedule(result, taskList);
        if (!parsed.retryable) break;
        lastReason = parsed.reason;
        warn(`director schedule parse failed (attempt ${attempts}/${maxAttempts}): ${lastReason}`);
    }
    if (!parsed || parsed.retryable) {
        state.lastError = `Chế độ đạo diễn thất bại: ${lastReason}`;
        dmeta.lastDirectorRun = { round, at: Date.now(), ok: false, reason: lastReason };
        saveDirectorMeta();
        emitState();
        notify('error', `🔴 Chế độ đạo diễn thất bại: ${lastReason} (Đã thử lại ${attempts - 1} lần). Chu kỳ này không có kế hoạch điều phối, có thể thực thi lại thủ công trong bảng đạo diễn`, { timeOut: 10000 });
        return;
    }

    // Đổi cuộc trò chuyện/nhân vật giữa chừng sẽ bỏ kết quả
    if (c.getCurrentChatId?.() !== chatIdAtStart || c.characterId !== characterIdAtStart) {
        warn('director: chat changed during generation, plan discarded');
        return;
    }

    // Khoảng cách đạo diễn lần tới: Chế độ quyết liệt do đạo diễn tự quyết (trường "Khoảng cách đạo diễn lần tới"), Chế độ thường = Độ dài chu kỳ
    const runFloor = inc.endFloor || dmeta.anchor + 1;
    const gap = dirCfg.aggressive && Number.isFinite(parsed.directorGap) && parsed.directorGap >= 2
        ? Math.min(parsed.directorGap, 60)
        : L;
    const validated = director.validateSchedule(parsed.assignments, { maxPosition: gap - 1, minSpacing: dirCfg.minSpacing, taskList });
    for (const w of validated.warnings) warn(`director schedule: ${w}`);

    // Luân chuyển lịch sử: Kế hoạch chu kỳ trước cùng với biểu hiện thực tế (số kế hoạch/số kích hoạt/số thủ công) đi vào lịch sử để học lặp (Tối đa 5 mục)
    if (prevPlan && Number.isFinite(prevPlan.runFloor)) {
        dmeta.history.unshift({
            runFloor: prevPlan.runFloor,
            taskIds: prevPlan.assignments.map((a) => a.taskId),
            planned: prevPlan.assignments.length,
            woken: dmeta.woken.length,
            manual: dmeta.manualRuns || 0,
        });
        dmeta.history = dmeta.history.slice(0, 5);
    }
    dmeta.plan = {
        runFloor,
        assignments: validated.assignments.map((a) => ({ floor: runFloor + a.position - 1, taskId: a.taskId })),
        createdAt: Date.now(),
    };
    dmeta.nextDirectorFloor = runFloor + gap;
    dmeta.anchor = runFloor;
    dmeta.woken = [];
    dmeta.manualRuns = 0;
    dmeta.lastDirectorRun = { floor: runFloor, at: Date.now(), ok: true, gap, aggressive: !!dirCfg.aggressive };
    saveDirectorMeta();
    reader.saveBookmark('director', inc.endFloor);

    // Ghi mục kế hoạch vào Worldbook trò chuyện (Giữ trạng thái đóng, chỉ dành cho engine đọc/kiểm tra)
    if (chatBook && dirCfg.planKey) {
        try {
            const content = [
                `[Kế hoạch đạo diễn RUBY - Lần đạo diễn thứ ${round}] (Tạo tự động, vui lòng giữ mục đóng, chỉ dành cho engine đạo diễn đọc)`,
                `Tầng đạo diễn chạy: ${runFloor} | Đạo diễn lần tới: Tầng ${dmeta.nextDirectorFloor}${dirCfg.aggressive ? ' (Chế độ quyết liệt, khoảng cách do đạo diễn tự quyết)' : ` (Chu kỳ ${L})`}`,
                ...validated.assignments.map((a) => `Tầng ${a.floor}: task${a.taskId} ${nameOf(a.taskId)}`),
            ].join('\n');
            await worldbook.writeOutputEntry(chatBook, { key: dirCfg.planKey, content, disable: true });
            await worldbook.persistBook(chatBook);
        } catch (e) {
            warn(`director plan entry write failed: ${e?.message || e}`);
        }
    }

    state.lastRunAt = Date.now();
    state.lastRunSummary = validated.assignments.length > 0
        ? `Kế hoạch đạo diễn: ${validated.assignments.length} nhiệm vụ (Lần đạo diễn thứ ${round}, đạo diễn lần tới ở tầng ${dmeta.nextDirectorFloor})`
        : `Kế hoạch đạo diễn: Chu kỳ này không xếp nhiệm vụ (Lần đạo diễn thứ ${round})`;
    notify('success', `🎬 Đã tạo kế hoạch đạo diễn (Lần đạo diễn thứ ${round}): ${validated.assignments.map((a) => `Tầng ${a.floor}->task${a.taskId}`).join(', ') || 'Chu kỳ này không có nhiệm vụ'} | Đạo diễn lần tới ở tầng ${dmeta.nextDirectorFloor}`, { timeOut: 8000 });
    log(`director plan ready: ${JSON.stringify(dmeta.plan.assignments)} | nextDirectorFloor=${dmeta.nextDirectorFloor}`);
    emitState();
}

export async function runPipeline(taskBatch) {
    if (!taskBatch || taskBatch.length === 0) return;

    const c = ctx();
    const chatIdAtStart = c.getCurrentChatId?.();
    const characterIdAtStart = c.characterId;

    const { data: cfgData } = config.resolveConfig();
    const preset = config.getActivePreset(cfgData);
    const startupTask = preset.startupTask;
    const tasks = preset.tasks;
    const referencePool = preset.referencePool;
    // Tham số tạo mặc định không bật: Khi chưa bật sẽ truyền đối tượng rỗng, API chính dùng theo preset lấy mẫu của SillyTavern, endpoint tùy chỉnh dùng theo mặc định của nhà cung cấp
    const genParams = cfgData.gen?.enabled === true ? cfgData.gen : {};
    const customTags = cfgData.customContentTags || [];
    const charName = cfgData.charName || c.name2 || c.characters?.[c.characterId]?.name || 'Nhân vật';
    const apiCfg = config.getApiConfig();

    state.running = true;
    emitState();

    let completedCount = 0;
    let failedCount = 0;
    let wroteToChatBook = false;

    try {
        const charBook = await worldbook.getCharBookName();
        const chatBook = await worldbook.getChatBookName();
        if (!charBook) {
            warn('character world book not found');
            notify('warning', 'RUBY: Không tìm thấy Worldbook nhân vật, không thể thực thi phân tích');
            return;
        }
        log(`pipeline start | char book=${charBook} | chat book=${chatBook || 'Không'} | tasks=${taskBatch.length}`);

        const referenceValues = {};
        for (const ref of referencePool) {
            if (!ref.entryKey || !ref.varName) continue;
            const content = await worldbook.readEntry(charBook, chatBook, ref.entryKey, true);
            referenceValues[ref.varName] = content;
            if (content) log(`reference loaded: ${ref.varName}`);
        }

        // Tham khảo tích hợp sẵn (Thư viện ràng buộc): Ưu tiên mục cùng tên trong Worldbook —— creator tự tạo mục có cùng từ khóa sẽ tự động tiếp quản (bất kể có thêm vào bể tham khảo hay không), đọc không được mới dùng nội dung tích hợp sẵn
        for (const b of BUILTIN_REFERENCES) {
            if (referenceValues[b.varName] !== undefined) continue;
            const fromWorld = await worldbook.readEntry(charBook, chatBook, b.entryKey, true);
            referenceValues[b.varName] = fromWorld || b.content;
            log(`builtin reference '${b.entryKey}': ${fromWorld ? 'using worldbook entry (user overrides builtin)' : 'using builtin content'}`);
        }

        const outputValues = {};
        if (startupTask?.outputKey) {
            outputValues.startupOutput = await worldbook.readEntry(charBook, chatBook, startupTask.outputKey, true);
        }
        for (const task of tasks) {
            if (task.outputKey) {
                const varName = task.outputVarName || `task_${task.id}_Output`;
                outputValues[varName] = await worldbook.readEntry(charBook, chatBook, task.outputKey, true);
            }
        }

        // Giao diện tóm tắt (Tiểu Bạch x / SP Database): Tầng đã tóm tắt sẽ dùng tóm tắt thay thế chính văn.
        // Chỉ thay đổi "tư liệu phân tích", việc đếm tầng/chu kỳ/dấu trang đều giữ nguyên (countAiReplies và việc tiến dấu trang không bị ảnh hưởng).
        const provider = cfgData.summaryProvider || '';
        let providerSummary = null; // { boundary(chỉ mục tin nhắn), text, label }
        if (provider === 'littlewhitebox') {
            const lwb = reader.getLittleWhiteBoxSummary();
            if (lwb) {
                providerSummary = {
                    boundary: lwb.boundary,
                    text: reader.renderLittleWhiteBoxSummary(lwb),
                    label: 'Tóm tắt cốt truyện Tiểu Bạch x',
                };
            } else {
                warn('LittleWhiteBox summary unavailable (not installed or no data), falling back to raw text');
            }
        } else if (provider === 'shujuku') {
            try {
                const shu = await reader.getShujukuSummary([charBook, chatBook]);
                if (shu) {
                    providerSummary = { boundary: shu.boundary, text: shu.text, label: 'Tóm tắt cốt truyện SP Database' };
                } else {
                    warn('shujuku summary unavailable (no processed floors or readable entries), falling back to raw text');
                }
            } catch (e) {
                warn(`shujuku summary read failed: ${e?.message || e}`);
            }
        } else if (provider === 'yuzuki') {
            try {
                const yz = reader.getYuzukiSummary(cfgData.yuzukiIncludePlot !== false);
                if (yz) {
                    providerSummary = { boundary: yz.boundary, text: yz.text, label: 'Bảng ký ức Yuzuki - Tóm tắt cốt truyện' };
                } else {
                    warn('yuzuki-Memory summary unavailable (not installed or no summary records), falling back to raw text');
                }
            } catch (e) {
                warn(`yuzuki-Memory summary read failed: ${e?.message || e}`);
            }
        } else if (provider === 'baibaibook') {
            try {
                const bbb = reader.getBaibaibookSummary();
                if (bbb) {
                    providerSummary = { boundary: bbb.boundary, text: bbb.text, label: 'Sách bách bảo - Ảnh chụp ký ức' };
                } else {
                    warn('baibaibook summary unavailable (not installed or no snapshot), falling back to raw text');
                }
            } catch (e) {
                warn(`baibaibook summary read failed: ${e?.message || e}`);
            }
        }

        // —— Nhiệm vụ đạo diễn: Trình thực thi độc lập, không vào vòng lặp nhiệm vụ thông thường ——
        if (taskBatch.length === 1 && taskBatch[0].type === 'director') {
            await runDirectorTask(taskBatch[0], {
                cfgData, preset, charBook, chatBook, referencePool, referenceValues,
                providerSummary, customTags, apiCfg, genParams, chatIdAtStart, characterIdAtStart,
            });
            return; // finally reset lại running
        }

        for (let taskIndex = 0; taskIndex < taskBatch.length; taskIndex++) {
            const current = taskBatch[taskIndex];
            const taskConfig = current.config;
            const taskKey = current.type;
            const taskDisplayName = current.displayName;

            try {
                if (c.getCurrentChatId?.() !== chatIdAtStart || c.characterId !== characterIdAtStart) {
                    warn('chat or character changed during pipeline, aborting remaining tasks');
                    return;
                }

                log(`task ${taskIndex + 1}/${taskBatch.length}: ${taskDisplayName} (${current.source})`);

                let inc = reader.incrementalRead(taskKey, customTags, { noWindowLimit: !!providerSummary });
                log(`incremental read: floors ${inc.startFloor}-${inc.endFloor} (${inc.count} floors, ${(inc.text || '').length} chars)`);

                if (inc.count === 0 || !inc.text) {
                    // force hoặc kế hoạch đạo diễn kích hoạt lại (Nội dung tầng tạo lại bị thay đổi): Reset dấu trang đọc lại tầng đó
                    if (current.source === 'force' || current.source === 'director') {
                        reader.resetBookmark(taskKey);
                        inc = reader.incrementalRead(taskKey, customTags, { noWindowLimit: !!providerSummary });
                        log(`bookmark reset, re-reading ${inc.count} floors (${current.source})`);
                        if (inc.count === 0 || !inc.text) {
                            warn(`skip ${taskDisplayName}: no readable text in chat`);
                            continue;
                        }
                    } else {
                        log(`skip ${taskDisplayName}: no new floors (bookmark at ${inc.endFloor})`);
                        continue;
                    }
                }

                // Quét từ khóa tác động lên toàn bộ chính văn tăng dần gốc trước khi thay thế/cắt cụt: Tách rời với cơ chế tóm tắt
                // (Quét tầng gốc thay vì văn bản cô đọng của tóm tắt, tránh việc từ khóa trong các tầng đã tóm tắt bị bỏ sót vĩnh viễn),
                // đồng thời ngăn cơ chế cắt cụt nuốt mất từ khóa kích hoạt trong tầng mới nhất.
                // Nhiệm vụ do chế độ đạo diễn xếp sẽ không quét —— đạo diễn đã xếp là chạy, quyền điều phối hoàn toàn thuộc về đạo diễn
                const keywordScan = (current.source === 'force' || current.source === 'director')
                    ? { run: true, keywords: [], matched: [] }
                    : scheduler.shouldRunByKeywordScan(taskConfig, inc.text);
                if (!keywordScan.run) {
                    log(`skip ${taskDisplayName}: keywords not matched in floors ${inc.startFloor}-${inc.endFloor} (${keywordScan.keywords.join(', ')}), bookmark held for rescan`);
                    continue;
                }
                if (taskConfig?.keywordScanEnabled && keywordScan.matched.length > 0) {
                    log(`keyword scan hit: ${keywordScan.matched.join(', ')}`);
                }

                applySummaryReplacement(c, inc, providerSummary, customTags);

                // Giới hạn 200,000 ký tự: Chỉ cắt cụt chính văn hội thoại (giữ lại phần đầu, vứt bỏ phần chính văn thừa phía sau).
                // Bể mục tham khảo và đầu ra phân tích lịch sử sẽ được thêm vào ở giai đoạn lắp ráp bên dưới, không bao giờ tính vào giới hạn này, tuyệt đối không bị mất do cắt cụt.
                const capped = reader.capText(inc.text);
                if (capped.truncated > 0) {
                    warn(`body exceeds ${reader.MAX_INPUT_CHARS} chars: ${inc.text.length} chars, discarding last ${capped.truncated} chars of chat text (references unaffected)`);
                    inc.text = capped.text;
                    inc.truncatedChars = capped.truncated;
                    notify('warning', `RUBY: Chính văn ${taskDisplayName} vượt quá giới hạn 200,000 ký tự, khoảng ${capped.truncated} ký tự ở cuối đã bị cắt cụt và vứt bỏ`);
                }

                const promptKey = taskConfig.promptKey;
                if (!promptKey) {
                    warn(`task ${taskDisplayName}: no prompt entry configured`);
                    failedCount++;
                    continue;
                }
                let promptTemplate = await worldbook.readEntry(charBook, chatBook, promptKey, false);
                if (!promptTemplate) {
                    warn(`prompt entry not found: ${promptKey}`);
                    notify('error', `RUBY: Không tìm thấy mục prompt ${promptKey}`);
                    failedCount++;
                    continue;
                }

                const variables = {
                    CHAR_NAME: charName,
                    recentMessages: inc.text,
                };
                const useRefs = Array.isArray(taskConfig.useReferences) ? taskConfig.useReferences : [];
                for (const varName of useRefs) {
                    if (referenceValues[varName] !== undefined) variables[varName] = referenceValues[varName];
                }
                const useOutputs = Array.isArray(taskConfig.useOutputs) ? taskConfig.useOutputs : [];
                for (const varName of useOutputs) {
                    if (outputValues[varName] !== undefined) variables[varName] = outputValues[varName];
                }

                const hasRecentMessagesPlaceholder = promptTemplate.includes('{{recentMessages}}');
                const bodySections = [];
                const refSections = [];

                if (!hasRecentMessagesPlaceholder && inc.text) {
                    const truncNote = inc.truncatedChars
                        ? `\n\n(⚠️ Chính văn lần này vượt quá giới hạn 200,000 ký tự, khoảng ${inc.truncatedChars} ký tự ở cuối đã bị cắt cụt và vứt bỏ, chỉ phần được giữ lại ở trên mới là tư liệu phân tích hợp lệ)`
                        : '';
                    if (inc.summaryApplied) {
                        // Giao diện tóm tắt đã tạo tư liệu có tiêu đề phân đoạn (Tóm tắt Tiểu Bạch x + Chính văn mới chưa tóm tắt), sử dụng trực tiếp
                        bodySections.push(`${inc.text}${truncNote}\n\n(Ràng buộc cứng: Đầu ra phân tích phải lấy chất liệu từ cốt truyện thực tế của Tóm tắt Tiểu Bạch x và chính văn ở trên; "Mẫu/Ví dụ" trong chỉ thị nhiệm vụ phía sau chỉ dùng để giải thích định dạng và độ chi tiết, CẤM lấy các bộ phận, dự án, tình tiết, chỉ số cụ thể trong ví dụ làm kết quả phân tích đầu ra)`);
                    } else {
                        bodySections.push(`[Chính văn lần này (Tăng dần, tầng ${inc.startFloor} đến tầng ${inc.endFloor}, tổng cộng ${inc.count} tầng${inc.truncatedChars ? ', đã cắt cụt' : ''})]\n${inc.text}${truncNote}\n\n(Ràng buộc cứng: Đầu ra phân tích phải lấy chất liệu từ cốt truyện thực tế của chính văn ở trên; "Mẫu/Ví dụ" trong chỉ thị nhiệm vụ phía sau chỉ dùng để giải thích định dạng và độ chi tiết, CẤM lấy các bộ phận, dự án, tình tiết, chỉ số cụ thể trong ví dụ làm kết quả phân tích đầu ra)`);
                    }
                }

                for (const varName of useRefs) {
                    const content = variables[varName];
                    if (content && content !== '(Chưa thiết lập)') {
                        const refConfig = referencePool.find((r) => r.varName === varName);
                        const builtinDef = BUILTIN_REFERENCES.find((b) => b.varName === varName);
                        const displayLabel = refConfig?.label || refConfig?.entryKey || builtinDef?.label || varName;
                        refSections.push(`[${displayLabel}]\n${content}`);
                    }
                }

                for (const varName of useOutputs) {
                    const content = variables[varName];
                    if (content && content !== '(Chưa thiết lập)') {
                        let displayLabel = varName;
                        if (varName === 'startupOutput') {
                            displayLabel = startupTask.displayName || 'Kết quả phân tích mở màn';
                        } else {
                            const taskMatch = varName.match(/^task_(\d+)_Output$/);
                            if (taskMatch) {
                                const taskDef = tasks.find((t) => t.id === parseInt(taskMatch[1], 10));
                                displayLabel = taskDef?.displayName || `Kết quả nhiệm vụ #${taskMatch[1]}`;
                            }
                        }
                        refSections.push(`[${displayLabel}]\n${content}`);
                    }
                }

                const assembledParts = [];
                if (bodySections.length > 0) assembledParts.push(bodySections.join('\n\n'));
                if (refSections.length > 0) {
                    assembledParts.push(`[Tham khảo phân tích lịch sử (Cần cập nhật dựa theo chính văn ở trên, đừng bê nguyên xi)]\n${refSections.join('\n\n')}`);
                }
                if (assembledParts.length > 0) {
                    promptTemplate = `${assembledParts.join('\n\n')}\n\n[Chỉ thị nhiệm vụ]\n${promptTemplate}`;
                    log(`prompt assembled: body(${inc.count} floors, ${(inc.text || '').length} chars) + refs(${refSections.length})`);
                }

                for (const [key, value] of Object.entries(variables)) {
                    const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
                    promptTemplate = promptTemplate.replace(regex, value || '(Chưa thiết lập)');
                }

                notify('info', `🔄 ${taskDisplayName} đang phân tích... (${taskIndex + 1}/${taskBatch.length})`, { timeOut: 3000 });
                const messages = buildMessages(taskDisplayName, promptTemplate, cfgData);
                const result = await ai.callModel({ apiCfg, genParams, messages, taskLabel: taskDisplayName });

                if (!result || result.trim().length < 2) {
                    warn(`${taskDisplayName}: result empty or too short`);
                    notify('error', `${taskDisplayName} phân tích thất bại: Nội dung quá ngắn`);
                    failedCount++;
                    continue;
                }
                log(`generation done: ${result.length} chars`);

                if (c.getCurrentChatId?.() !== chatIdAtStart || c.characterId !== characterIdAtStart) {
                    warn(`${taskDisplayName}: chat changed during generation, result discarded`);
                    return;
                }

                const outputKey = taskConfig.outputKey;
                const outputVarName = taskConfig.outputVarName || (taskKey === 'startup' ? 'startupOutput' : `task_${taskConfig.id}_Output`);

                if (!outputKey) {
                    log(`${taskDisplayName}: no output entry configured, result kept in memory only`);
                    outputValues[outputVarName] = result.trim();
                    reader.saveBookmark(taskKey, inc.endFloor);
                    completedCount++;
                    continue;
                }

                if (!chatBook) {
                    warn('chat world book not found');
                    failedCount++;
                    continue;
                }

                await worldbook.writeOutputEntry(chatBook, {
                    key: outputKey,
                    extraKeys: taskConfig.extraKeys,
                    content: result,
                    constant: !!taskConfig.outputConstant,
                    disable: !!taskConfig.outputDisable,
                    noRecursion: !!taskConfig.noRecursion,
                    position: taskConfig.position ?? 0,
                    depth: taskConfig.depth ?? 4,
                    order: taskConfig.order ?? 100,
                    selective: !!taskConfig.selective,
                    // Từ khóa lọc chỉ có hiệu lực khi nhiệm vụ tick chọn "Sử dụng từ khóa lọc tùy chọn" và có điền nội dung, nếu không tick thì luôn truyền rỗng (xóa tàn dư)
                    selectiveKeys: (taskConfig.selectiveKeysEnabled && Array.isArray(taskConfig.selectiveKeys)) ? taskConfig.selectiveKeys : [],
                });
                wroteToChatBook = true;

                await worldbook.disableCharEntry(charBook, outputKey);
                outputValues[outputVarName] = result.trim();
                reader.saveBookmark(taskKey, inc.endFloor);
                completedCount++;
                log(`✅ ${taskDisplayName} done (bookmark at floor ${inc.endFloor})`);

            } catch (taskErr) {
                warn(`task ${taskDisplayName} failed: ${taskErr.message}`);
                notify('error', `${taskDisplayName} thất bại: ${taskErr.message}`, { timeOut: 6000 });
                failedCount++;
            }
        }

        if (completedCount > 0 && chatBook) {
            await worldbook.persistBook(chatBook);
        }

        // Gắn tag cho "Worldbook trò chuyện" vừa được ghi đầu ra phân tích lần này (Đăng ký vào sổ đăng ký toàn cục):
        // Chỉ ghi lại tên sách + nhân vật sở hữu ở cấp độ sách, không đụng đến mục, không nhận diện dựa vào UID
        if (wroteToChatBook) {
            try {
                const identity = config.getCharacterIdentity();
                config.registerGeneratedChatBook({
                    chatId: chatIdAtStart || '',
                    chatBookName: chatBook,
                    characterAvatar: identity?.avatar || '',
                    characterName: identity?.name || charName || '',
                });
                window.dispatchEvent(new CustomEvent('ruby:chatbooks-changed'));
                log(`generated chat book registered: ${chatBook} (${identity?.name || charName})`);
            } catch (e) {
                warn(`register generated chat book failed: ${e?.message || e}`);
            }
        }

        state.lastRunAt = Date.now();
        state.lastRunSummary = `${completedCount}/${taskBatch.length} thành công${failedCount > 0 ? `, ${failedCount} thất bại` : ''}`;

        if (taskBatch.length > 1) {
            if (failedCount === 0) notify('success', `✅ Toàn bộ ${completedCount} nhiệm vụ đã hoàn thành`);
            else notify('warning', `⚠️ ${completedCount} thành công, ${failedCount} thất bại`);
        } else if (completedCount > 0) {
            notify('success', `✅ ${taskBatch[0]?.displayName || 'Nhiệm vụ'} hoàn thành`);
        }
        log(`pipeline finished: ${state.lastRunSummary}`);
    } catch (err) {
        state.lastError = err?.message || String(err);
        warn(`pipeline error: ${state.lastError}`, err?.stack);
        notify('error', `RUBY phân tích thất bại: ${state.lastError}`, { timeOut: 8000 });
    } finally {
        state.running = false;
        emitState();
    }
}